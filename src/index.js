import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import userRoutes from './routes/user.route.js';
import gameRoutes from './routes/game.route.js';
import matchmakingRoutes from './routes/matchmaking.route.js';
import { swaggerUi, specs } from './utils/swagger.js';
import { PrismaClient } from './generated/prisma/index.js';
import {
  playCard, pickCard, callSuit, executeForcedDraw,
  getReshuffledState, finalizeMarketExhaustion
} from './engine/gameEngine.js';

// Load environment variables
dotenv.config();

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// =========================================================
// CONSTANTS
// =========================================================
const CHECKSUM_INTERVAL_MS = 5000;      // O4: Reduced from 10s to 5s
const TURN_TIMEOUT_MS = 30000;          // M2: 30-second turn timer
const ROOM_CLEANUP_DELAY_MS = 60000;    // 60s before cleaning empty rooms
const RATE_LIMIT_WINDOW_MS = 1000;      // C5: Rate limit window
const RATE_LIMIT_MAX_MOVES = 3;         // C5: Max moves per window
const RECONNECT_GRACE_MS = 60000;       // M3: 60s to reconnect before forfeit

// =========================================================
// IN-MEMORY AUTHORITATIVE GAME STATE
// =========================================================
const gameRooms = new Map();
const roomCleanupTimers = new Map();

/**
 * C5: Per-socket rate limiter.
 * Returns true if the move should be REJECTED (rate exceeded).
 */
const rateLimiters = new Map(); // socketId -> { count, windowStart }

const isRateLimited = (socketId) => {
  const now = Date.now();
  let limiter = rateLimiters.get(socketId);

  if (!limiter || now - limiter.windowStart > RATE_LIMIT_WINDOW_MS) {
    limiter = { count: 1, windowStart: now };
    rateLimiters.set(socketId, limiter);
    return false;
  }

  limiter.count++;
  if (limiter.count > RATE_LIMIT_MAX_MOVES) {
    return true; // Rate exceeded
  }
  return false;
};

/**
 * Build a lightweight checksum from room state.
 * Sent every 5s — ~80 bytes per packet.
 */
const buildChecksum = (room) => ({
  lastMoveId: room.lastMoveId,
  deckCount: room.market?.length || 0,
  currentTurn: room.currentPlayer,
  topCardId: room.pile?.[room.pile.length - 1]?.id,
  handCounts: room.players?.map(p => p.hand?.length || 0),
});

/**
 * O1: Build per-player sync payload.
 * Hides opponent's actual hand — sends only card count.
 * Sends full state for the requesting player.
 */
const buildSyncPayload = (room, requestingUserId) => {
  const { checksumInterval, turnTimer, disconnectTimers, ...state } = room;

  if (!requestingUserId) return state;

  const playerIndex = room.players?.findIndex(p => p.id === requestingUserId);
  if (playerIndex === -1 || playerIndex === undefined) return state;

  // Clone players — hide opponent hand, show only count
  const filteredPlayers = state.players.map((p, idx) => {
    if (idx === playerIndex) return p; // Full hand for requesting player
    return {
      ...p,
      hand: p.hand.map(c => ({ id: c.id })), // Only IDs for opponent (needed for animation)
      handCount: p.hand.length,
    };
  });

  return { ...state, players: filteredPlayers };
};

/**
 * Build the full state payload for state-update broadcast.
 * C1: Sent after EVERY move to all players.
 */
const buildStateUpdatePayload = (room, move, targetUserId) => {
  const { checksumInterval, turnTimer, disconnectTimers, ...state } = room;

  const playerIndex = room.players?.findIndex(p => p.id === targetUserId);

  // For opponent: hide their hand details, send full state for animation
  const filteredPlayers = state.players.map((p, idx) => {
    if (idx === playerIndex) return p;
    return {
      ...p,
      hand: p.hand.map(c => ({ id: c.id })),
      handCount: p.hand.length,
    };
  });

  return {
    moveId: room.lastMoveId,
    move,                                     // For animation hints
    state: { ...state, players: filteredPlayers },
  };
};

/**
 * Schedule room cleanup after 60s of emptiness.
 */
const scheduleRoomCleanup = (gameId) => {
  if (roomCleanupTimers.has(gameId)) return;

  const timer = setTimeout(() => {
    const room = gameRooms.get(gameId);
    if (room?.checksumInterval) clearInterval(room.checksumInterval);
    if (room?.turnTimer) clearTimeout(room.turnTimer);
    if (room?.disconnectTimers) {
      for (const t of Object.values(room.disconnectTimers)) clearTimeout(t);
    }
    gameRooms.delete(gameId);
    roomCleanupTimers.delete(gameId);
  }, ROOM_CLEANUP_DELAY_MS);
  roomCleanupTimers.set(gameId, timer);
};

const cancelRoomCleanup = (gameId) => {
  if (roomCleanupTimers.has(gameId)) {
    clearTimeout(roomCleanupTimers.get(gameId));
    roomCleanupTimers.delete(gameId);
  }
};

/**
 * Start periodic checksum emission for a room.
 * O4: Every 5 seconds.
 */
const startChecksumInterval = (io, gameId) => {
  const room = gameRooms.get(gameId);
  if (!room || room.checksumInterval) return;

  room.checksumInterval = setInterval(() => {
    const currentRoom = gameRooms.get(gameId);
    if (!currentRoom) return;
    io.to(gameId).emit('state-checksum', buildChecksum(currentRoom));
  }, CHECKSUM_INTERVAL_MS);
};

/**
 * M2: Start/reset the turn timer for the current player.
 * After TURN_TIMEOUT_MS, auto-draw from market.
 */
const startTurnTimer = (io, gameId) => {
  const room = gameRooms.get(gameId);
  if (!room) return;

  // Clear existing timer
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  // Don't start timer if game is over or waiting for suit call
  if (room.winner || room.pendingAction?.type === 'call_suit') return;

  room.turnTimer = setTimeout(() => {
    const currentRoom = gameRooms.get(gameId);
    if (!currentRoom || currentRoom.winner) return;

    const playerIndex = currentRoom.currentPlayer;
    if (playerIndex < 0 || playerIndex >= currentRoom.players.length) return;

    try {
      // Auto-draw from market on timeout
      let stateForPick = currentRoom;
      if (stateForPick.market.length === 0 && stateForPick.pile.length > 1) {
        stateForPick = getReshuffledState(stateForPick);
      }

      let newState;
      const pending = stateForPick.pendingAction;

      if (pending?.type === 'defend' && pending.playerIndex === playerIndex) {
        // Convert defend to draw, then execute draws
        let tempState = { ...stateForPick, pendingAction: { ...pending, type: 'draw' } };
        while (tempState.pendingAction?.type === 'draw' && tempState.pendingAction.playerIndex === playerIndex) {
          if (tempState.market.length === 0 && tempState.pile.length > 1) {
            tempState = getReshuffledState(tempState);
          }
          const { newState: nextS, drawnCard } = executeForcedDraw(tempState);
          tempState = nextS;
          if (!drawnCard) break;
        }
        newState = tempState;
      } else if (pending?.type === 'draw' && pending.playerIndex === playerIndex) {
        // Execute forced draws
        let tempState = stateForPick;
        while (tempState.pendingAction?.type === 'draw' && tempState.pendingAction.playerIndex === playerIndex) {
          if (tempState.market.length === 0 && tempState.pile.length > 1) {
            tempState = getReshuffledState(tempState);
          }
          const { newState: nextS, drawnCard } = executeForcedDraw(tempState);
          tempState = nextS;
          if (!drawnCard) break;
        }
        newState = tempState;
      } else {
        // Normal timeout: draw from market
        const pickResult = pickCard(stateForPick, playerIndex);
        newState = pickResult.newState;
      }

      // Commit state
      const checksumInterval = currentRoom.checksumInterval;
      const disconnectTimers = currentRoom.disconnectTimers;
      const newMoveId = currentRoom.lastMoveId + 1;

      const updatedRoom = {
        ...newState,
        lastMoveId: newMoveId,
        checksumInterval,
        turnTimer: null,
        disconnectTimers,
      };
      gameRooms.set(gameId, updatedRoom);

      // Broadcast timeout move to all players
      const timeoutMove = { type: 'TURN_TIMEOUT', playerIndex };
      for (const player of updatedRoom.players) {
        const socketsInRoom = io.sockets.adapter.rooms.get(gameId);
        if (socketsInRoom) {
          for (const sid of socketsInRoom) {
            const s = io.sockets.sockets.get(sid);
            if (s?.userId === player.id) {
              s.emit('state-update', buildStateUpdatePayload(updatedRoom, timeoutMove, player.id));
            }
          }
        }
      }

      // Persist
      persistGameState(gameId, updatedRoom);

      // Restart timer for next player
      startTurnTimer(io, gameId);
    } catch (err) {
      console.error('[TurnTimer] Auto-move failed:', err.message);
    }
  }, TURN_TIMEOUT_MS);
};

/**
 * M5: Persist game state to DB after every move (async, non-blocking).
 * O5: Log failures instead of silently swallowing.
 */
const persistGameState = (gameId, room, extraData = {}) => {
  const { checksumInterval, turnTimer, disconnectTimers, ...stateForDb } = room;
  prisma.game.update({
    where: { id: gameId },
    data: {
      board: JSON.stringify(stateForDb),
      ...extraData,
    }
  }).catch(err => {
    console.error(`[DB] Failed to persist game ${gameId}:`, err.message);
  });
};

// =========================================================
// EXPRESS SERVER
// =========================================================

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, specify your frontend URL
    methods: ["GET", "POST"]
  },
  // Tuned for mobile networks
  pingInterval: 25000,
  pingTimeout: 20000,
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', userRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/matchmaking', matchmakingRoutes);

// Swagger API documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeRooms: gameRooms.size,
  });
});

// =========================================================
// SOCKET.IO — JWT AUTH MIDDLEWARE
// =========================================================

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
});

// =========================================================
// SOCKET.IO — CONNECTION HANDLER
// =========================================================

io.on('connection', (socket) => {

  // ----- JOIN GAME -----
  socket.on('join-game', async (gameId) => {
    cancelRoomCleanup(gameId);

    // Load from DB if room not in memory
    let room = gameRooms.get(gameId);
    if (!room) {
      try {
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (game && game.board) {
          const boardData = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;
          room = {
            ...boardData,
            lastMoveId: boardData.lastMoveId || 0,
            checksumInterval: null,
            turnTimer: null,
            disconnectTimers: {},
          };
          gameRooms.set(gameId, room);
          startChecksumInterval(io, gameId);
          startTurnTimer(io, gameId);
        }
      } catch (err) {
        console.error('[Socket] Failed to init room state:', err.message);
      }
    }

    // Verify player belongs to this game
    if (room) {
      const isPlayer = room.players?.some(p => p.id === socket.userId);
      if (!isPlayer) {
        return socket.emit('error', { message: 'Not a participant in this game' });
      }

      // M3: Clear disconnect timer if reconnecting
      if (room.disconnectTimers?.[socket.userId]) {
        clearTimeout(room.disconnectTimers[socket.userId]);
        delete room.disconnectTimers[socket.userId];
        // Notify opponent of reconnection
        socket.to(gameId).emit('opponent-reconnected', { userId: socket.userId });
      }
    }

    socket.join(gameId);
    socket.data.gameId = gameId;

    // Always send full state on join/reconnect (O1: per-player filtered)
    if (room) {
      socket.emit('full-state-sync', buildSyncPayload(room, socket.userId));
    }
  });

  // ----- REQUEST SYNC -----
  socket.on('request-sync', (gameId) => {
    const room = gameRooms.get(gameId);
    if (room) {
      socket.emit('full-state-sync', buildSyncPayload(room, socket.userId));
    }
  });

  // ----- GAME MOVE — VALIDATE → APPLY → BROADCAST (C1: STATE-BASED) -----
  socket.on('game-move', (data) => {
    const { gameId, move } = data;

    // C5: Rate limiting
    if (isRateLimited(socket.id)) {
      return socket.emit('move-rejected', { reason: 'Too many moves — slow down' });
    }

    const room = gameRooms.get(gameId);

    if (!room) {
      return socket.emit('move-rejected', { reason: 'Game room not found' });
    }

    // Verify player identity from JWT
    const playerIndex = room.players.findIndex(p => p.id === socket.userId);
    if (playerIndex === -1) {
      return socket.emit('move-rejected', { reason: 'Not a participant' });
    }

    try {
      let newState;

      switch (move.type) {
        case 'CARD_PLAYED': {
          // Validate turn
          if (room.currentPlayer !== playerIndex) {
            return socket.emit('move-rejected', { reason: 'Not your turn' });
          }

          // Verify the card is in the player's hand
          const card = room.players[playerIndex].hand.find(c => c.id === move.cardId);
          if (!card) {
            return socket.emit('move-rejected', { reason: 'Card not in hand' });
          }

          // Server validates + applies via game engine
          newState = playCard(room, playerIndex, card);

          // Handle WHOT suit selection if included
          if (move.suitChoice && newState.pendingAction?.type === 'call_suit') {
            newState = callSuit(newState, playerIndex, move.suitChoice);
          }

          // Handle auto-draw after General Market (card 14)
          if (card.number === 14 && newState.pendingAction?.type === 'draw') {
            let tempState = newState;
            while (tempState.pendingAction?.type === 'draw') {
              if (tempState.market.length === 0 && tempState.pile.length > 1) {
                tempState = getReshuffledState(tempState);
              }
              const { newState: nextS, drawnCard } = executeForcedDraw(tempState);
              tempState = nextS;
              if (!drawnCard) break;
            }
            newState = tempState;
          }
          break;
        }

        case 'PICK_CARD': {
          if (room.currentPlayer !== playerIndex) {
            return socket.emit('move-rejected', { reason: 'Not your turn' });
          }

          let stateForPick = room;
          if (stateForPick.market.length === 0 && stateForPick.pile.length > 1) {
            stateForPick = getReshuffledState(stateForPick);
          }

          const pickResult = pickCard(stateForPick, playerIndex);
          newState = pickResult.newState;
          break;
        }

        case 'CALL_SUIT': {
          newState = callSuit(room, playerIndex, move.suit);
          break;
        }

        case 'FORCED_DRAW': {
          let tempState = room;

          if (tempState.pendingAction?.type === 'defend' && tempState.pendingAction.playerIndex === playerIndex) {
            tempState = { ...tempState, pendingAction: { ...tempState.pendingAction, type: 'draw' } };
          }

          while (tempState.pendingAction?.type === 'draw' && tempState.pendingAction.playerIndex === playerIndex) {
            if (tempState.market.length === 0 && tempState.pile.length > 1) {
              tempState = getReshuffledState(tempState);
            }
            const { newState: nextS, drawnCard } = executeForcedDraw(tempState);
            tempState = nextS;
            if (!drawnCard) break;
          }
          newState = tempState;
          break;
        }

        default:
          return socket.emit('move-rejected', { reason: 'Unknown move type' });
      }

      // C6: Clean state replacement (no Object.assign mutation)
      const newMoveId = room.lastMoveId + 1;
      const checksumInterval = room.checksumInterval;
      const disconnectTimers = room.disconnectTimers;

      const updatedRoom = {
        ...newState,
        lastMoveId: newMoveId,
        checksumInterval,
        turnTimer: null,
        disconnectTimers,
      };
      gameRooms.set(gameId, updatedRoom);

      // C1: Broadcast AUTHORITATIVE STATE to each player (per-player filtered)
      const socketsInRoom = io.sockets.adapter.rooms.get(gameId);
      if (socketsInRoom) {
        for (const sid of socketsInRoom) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.emit('state-update', buildStateUpdatePayload(updatedRoom, move, s.userId));
          }
        }
      }

      // Confirm to sender with moveId
      socket.emit('move-accepted', { moveId: newMoveId });

      // Server-side winner check
      if (newState.winner) {
        io.to(gameId).emit('game-over', {
          winnerId: newState.winner.id,
          winnerName: newState.winner.name,
        });

        // Clear turn timer
        if (updatedRoom.turnTimer) clearTimeout(updatedRoom.turnTimer);

        // Persist final state
        persistGameState(gameId, updatedRoom, {
          winnerId: newState.winner.id,
          status: 'COMPLETED',
          endedAt: new Date(),
        });
      }

      // Rule 2: market exhaustion → finalize
      if (newState.marketExhausted) {
        const finalState = finalizeMarketExhaustion(newState);
        const finalRoom = {
          ...finalState,
          lastMoveId: newMoveId,
          checksumInterval,
          turnTimer: null,
          disconnectTimers,
        };
        gameRooms.set(gameId, finalRoom);

        if (finalState.winner) {
          io.to(gameId).emit('game-over', {
            winnerId: finalState.winner.id,
            winnerName: finalState.winner.name,
          });

          persistGameState(gameId, finalRoom, {
            winnerId: finalState.winner.id,
            status: 'COMPLETED',
            endedAt: new Date(),
          });
        }
      }

      // M5: Persist after EVERY move (O5: with proper error logging)
      if (!newState.winner && !newState.marketExhausted) {
        persistGameState(gameId, updatedRoom);
      }

      // M2: Reset turn timer for next player
      if (!newState.winner) {
        startTurnTimer(io, gameId);
      }

    } catch (err) {
      socket.emit('move-rejected', { reason: err.message || 'Invalid move' });
    }
  });

  // ----- LEAVE GAME -----
  socket.on('leave-game', (gameId) => {
    socket.leave(gameId);
    socket.data.gameId = null;

    const clients = io.sockets.adapter.rooms.get(gameId);
    if (!clients || clients.size === 0) {
      scheduleRoomCleanup(gameId);
    }
  });

  // ----- DISCONNECT — M3: notify opponent + grace period -----
  socket.on('disconnect', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;

    // Clean up rate limiter
    rateLimiters.delete(socket.id);

    const room = gameRooms.get(gameId);

    // M3: Notify remaining players
    socket.to(gameId).emit('opponent-disconnected', { userId: socket.userId });

    // Start reconnection grace timer
    if (room) {
      if (!room.disconnectTimers) room.disconnectTimers = {};

      room.disconnectTimers[socket.userId] = setTimeout(() => {
        // Player didn't reconnect in time — they forfeit
        const currentRoom = gameRooms.get(gameId);
        if (!currentRoom || currentRoom.winner) return;

        const disconnectedIndex = currentRoom.players.findIndex(p => p.id === socket.userId);
        if (disconnectedIndex === -1) return;

        const winnerIndex = disconnectedIndex === 0 ? 1 : 0;
        const winner = currentRoom.players[winnerIndex];

        const finalRoom = {
          ...currentRoom,
          winner,
          checksumInterval: currentRoom.checksumInterval,
          turnTimer: null,
          disconnectTimers: {},
        };
        gameRooms.set(gameId, finalRoom);

        io.to(gameId).emit('game-over', {
          winnerId: winner.id,
          winnerName: winner.name,
          reason: 'opponent_disconnected',
        });

        if (finalRoom.turnTimer) clearTimeout(finalRoom.turnTimer);

        persistGameState(gameId, finalRoom, {
          winnerId: winner.id,
          status: 'COMPLETED',
          endedAt: new Date(),
        });
      }, RECONNECT_GRACE_MS);
    }

    const clients = io.sockets.adapter.rooms.get(gameId);
    if (!clients || clients.size === 0) {
      scheduleRoomCleanup(gameId);
    }
  });
});

// =========================================================
// ERROR HANDLING
// =========================================================

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// =========================================================
// START SERVER
// =========================================================

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`API docs available at: http://localhost:${PORT}/api-docs`);
  console.log(`Health check available at: http://localhost:${PORT}/health`);
  console.log(`Socket.IO server ready`);
});

export default app;
