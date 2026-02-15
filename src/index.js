import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
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
// IN-MEMORY AUTHORITATIVE GAME STATE
// Stores FULL GameState per room (~2KB each, 100k rooms = 200MB)
// =========================================================
const gameRooms = new Map();
const roomCleanupTimers = new Map();

/**
 * Build a lightweight checksum from room state.
 * Sent every 10s — ~80 bytes per packet.
 */
const buildChecksum = (room) => ({
  lastMoveId: room.lastMoveId,
  deckCount: room.market?.length || 0,
  currentTurn: room.currentPlayer,
  topCardId: room.pile?.[room.pile.length - 1]?.id,
  handCounts: room.players?.map(p => p.hand?.length || 0),
});

/**
 * Build the full state payload for sync.
 * Sent ONLY on reconnect/desync — ~2KB.
 * Excludes allCards to save bandwidth (client already has the deck).
 */
const buildSyncPayload = (room) => {
  const { checksumInterval, ...state } = room;
  return state;
};

/**
 * Schedule room cleanup after 60s of emptiness.
 * O(1) — uses socket.data.gameId instead of iterating all rooms.
 */
const scheduleRoomCleanup = (gameId) => {
  if (roomCleanupTimers.has(gameId)) return; // Already scheduled

  const timer = setTimeout(() => {
    const room = gameRooms.get(gameId);
    if (room?.checksumInterval) clearInterval(room.checksumInterval);
    gameRooms.delete(gameId);
    roomCleanupTimers.delete(gameId);
  }, 60000);
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
 */
const startChecksumInterval = (io, gameId) => {
  const room = gameRooms.get(gameId);
  if (!room || room.checksumInterval) return;

  room.checksumInterval = setInterval(() => {
    const currentRoom = gameRooms.get(gameId);
    if (!currentRoom) return;
    io.to(gameId).emit('state-checksum', buildChecksum(currentRoom));
  }, 10000);
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
  // Scale: tune for mobile networks
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
// Runs once per connection handshake. Zero per-message cost.
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
          // Store FULL authoritative state
          room = { ...boardData, lastMoveId: 0, checksumInterval: null };
          gameRooms.set(gameId, room);
          startChecksumInterval(io, gameId);
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
    }

    socket.join(gameId);
    socket.data.gameId = gameId; // O(1) disconnect cleanup

    // Always send full state on join/reconnect
    if (room) {
      socket.emit('full-state-sync', buildSyncPayload(room));
    }
  });

  // ----- REQUEST SYNC -----
  socket.on('request-sync', (gameId) => {
    const room = gameRooms.get(gameId);
    if (room) {
      socket.emit('full-state-sync', buildSyncPayload(room));
    }
  });

  // ----- GAME MOVE — VALIDATE → APPLY → BROADCAST -----
  socket.on('game-move', (data) => {
    const { gameId, move } = data;
    const room = gameRooms.get(gameId);

    if (!room) {
      return socket.emit('move-rejected', { reason: 'Game room not found' });
    }

    // C5: Verify player identity from JWT
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

          // C1: Server validates + applies via game engine
          newState = playCard(room, playerIndex, card);

          // Handle WHOT suit selection if included
          if (move.suitChoice && newState.pendingAction?.type === 'call_suit') {
            newState = callSuit(newState, playerIndex, move.suitChoice);
          }

          // Handle auto-draw after General Market (card 14 draws for opponent)
          if (card.number === 14 && newState.pendingAction?.type === 'draw') {
            // Execute the forced draw(s) server-side
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

          // Handle market reshuffle if needed
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
          // Player surrendered defense — execute all forced draws
          let tempState = room;

          // Convert defend → draw if needed
          if (tempState.pendingAction?.type === 'defend' && tempState.pendingAction.playerIndex === playerIndex) {
            tempState = { ...tempState, pendingAction: { ...tempState.pendingAction, type: 'draw' } };
          }

          // Execute all draws
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

      // Commit authoritative state
      room.lastMoveId++;
      const checksumInterval = room.checksumInterval; // Preserve interval ref
      Object.assign(room, newState, { lastMoveId: room.lastMoveId, checksumInterval });
      gameRooms.set(gameId, room);

      // Broadcast LIGHTWEIGHT event to opponent (not full state)
      socket.to(gameId).emit('opponent-move', {
        ...move,
        moveId: room.lastMoveId,
      });

      // Confirm to sender
      socket.emit('move-accepted', { moveId: room.lastMoveId });

      // C3: Server-side winner check
      if (newState.winner) {
        io.to(gameId).emit('game-over', {
          winnerId: newState.winner.id,
          winnerName: newState.winner.name,
        });

        // Persist final state to DB (async, non-blocking)
        const { checksumInterval: _, ...stateForDb } = room;
        prisma.game.update({
          where: { id: gameId },
          data: {
            board: JSON.stringify(stateForDb),
            winnerId: newState.winner.id,
            status: 'COMPLETED',
            endedAt: new Date(),
          }
        }).catch(err => console.error('[Socket] Failed to save game result:', err.message));
      }

      // Rule 2: market exhaustion → finalize
      if (newState.marketExhausted) {
        const finalState = finalizeMarketExhaustion(newState);
        Object.assign(room, finalState, { checksumInterval });
        gameRooms.set(gameId, room);

        if (finalState.winner) {
          io.to(gameId).emit('game-over', {
            winnerId: finalState.winner.id,
            winnerName: finalState.winner.name,
          });

          const { checksumInterval: _, ...stateForDb } = room;
          prisma.game.update({
            where: { id: gameId },
            data: {
              board: JSON.stringify(stateForDb),
              winnerId: finalState.winner.id,
              status: 'COMPLETED',
              endedAt: new Date(),
            }
          }).catch(() => { });
        }
      }

      // Periodic DB backup (async, non-blocking, every 5 moves)
      if (room.lastMoveId % 5 === 0 && !newState.winner) {
        const { checksumInterval: _, ...stateForDb } = room;
        prisma.game.update({
          where: { id: gameId },
          data: { board: JSON.stringify(stateForDb) }
        }).catch(() => { });
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

  // ----- DISCONNECT — O(1) cleanup -----
  socket.on('disconnect', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;

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
