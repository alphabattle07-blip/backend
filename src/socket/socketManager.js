import { ludoGameLoop } from '../engine/ludoGameLoop.js';
import { ludoGameEngine, LOGIC_VERSION } from '../engine/ludoGameEngine.js';
import { whotGameEngine } from '../engine/whotGameEngine.js';
import { whotGameLoop } from '../engine/whotGameLoop.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { initializeChatSocket } from '../chat/chatSocket.js';
import redis from '../utils/redis.js';

const prisma = new PrismaClient();

let io;
// Map to track userId -> Set of socketIds (to handle multiple sessions/tabs)
const userSockets = new Map();
// Reverse map socketId -> userId
const socketUser = new Map();

// NOTE: Socket.IO configuration (pingTimeout, pingInterval) should be set 
// where the Server/IO instance is instantiated (e.g. server.js or index.js).
// Here we just use the initialized instance.

export const initializeSocket = (socketIo) => {
    io = socketIo;

    io.on('connection', (socket) => {
        // Initialize chat handlers once per connection (instead of inside register)
        // to prevent listener accumulation on match join.
        initializeChatSocket(socket, socketUser);

        // In a real app, verify token and get userId
        // For now, we expect 'register' event after connection
        socket.on('register', (userId) => {
            console.log(`[Socket] Received register event for user: ${userId} on socket: ${socket.id}`);
            if (!userSockets.has(userId)) userSockets.set(userId, new Set());
            userSockets.get(userId).add(socket.id);
            socketUser.set(socket.id, userId);
            console.log(`[Socket] Successfully registered user ${userId} to socket ${socket.id}`);
        });

        socket.on('LOGIC_VERSION_CHECK', (clientVersion) => {
            if (clientVersion !== LOGIC_VERSION) {
                console.error(`[Socket] Logic version mismatch. Client: ${clientVersion}, Server: ${LOGIC_VERSION}. Disconnecting.`);
                socket.emit('LOGIC_VERSION_MISMATCH');
                socket.disconnect(true);
            }
        });

        socket.on('joinGame', (gameId) => {
            console.log(`[Socket] Socket ${socket.id} joining game: ${gameId}`);
            socket.join(gameId);
            const room = io.sockets.adapter.rooms.get(gameId);
            console.log(`[Socket] Socket ${socket.id} joined ${gameId}. Room size: ${room?.size}`);
        });

        socket.on('leaveGame', (gameId) => {
            socket.leave(gameId);
        });

        socket.on('recoverLudoGame', async (gameId) => {
            const userId = socketUser.get(socket.id);
            if (userId && gameId) {
                try {
                    console.log(`[Socket] Recovering Ludo game ${gameId} for user ${userId}`);
                    const state = await ludoGameLoop.getFullStateSnapshot(gameId, userId);
                    if (state) {
                        const scrubbedState = ludoGameEngine.scrubStateForClient(state);
                        // getFullStateSnapshot returns { ...board, remainingTime, serverTime }
                        // scrubStateForClient might remove remainingTime if not careful, 
                        // so we manually ensure it's there.
                        socket.emit('gameStateUpdate', {
                            ...scrubbedState,
                            remainingTime: state.remainingTime,
                            serverTime: state.serverTime
                        });
                    }
                } catch (err) {
                    console.error(`[Socket] Ludo Recovery Error: ${err.message}`);
                }
            }
        });


        socket.on('gameAction', async (payload) => {
            const { gameId, state, data, gameType } = payload;

            if (gameType === 'whot') {
                const userId = socketUser.get(socket.id);
                if (userId && gameId && data) {
                    try {
                        console.log(`[Socket] Processing Whot move for user ${userId} in game ${gameId}`);
                        await whotGameLoop.executeMove(gameId, userId, data);
                    } catch (err) {
                        console.error(`[Socket] Whot Move Error: ${err.message}`);
                        socket.emit('error', { message: err.message });
                    }
                }
                return;
            }

            if (gameType === 'ludo') {
                const userId = socketUser.get(socket.id);
                if (userId && gameId && data) {
                    try {
                        console.log(`[Socket] Processing Ludo move for user ${userId} in game ${gameId}`);
                        await ludoGameLoop.executeAction(gameId, userId, data);
                    } catch (err) {
                        console.error(`[Socket] Ludo Move Error: ${err.message}`);
                        socket.emit('error', { message: err.message });
                    }
                }
                return;
            }

            const updateData = data || state;
            if (gameId && updateData) {
                const scrubbedData = gameType === 'ludo' ? ludoGameEngine.scrubStateForClient(updateData) : updateData;
                socket.to(gameId).emit('gameStateUpdate', scrubbedData);
            }
        });

        // --- VOLUNTARY FORFEIT ---
        socket.on('forfeitGame', async ({ gameId }) => {
            const userId = socketUser.get(socket.id);
            if (!userId || !gameId) return;

            try {
                console.log(`[Socket] Player ${userId} forfeiting game ${gameId}`);
                const game = await prisma.game.findUnique({ where: { id: gameId } });
                if (!game || game.status !== 'IN_PROGRESS') return;

                // Verify the user is a participant
                if (game.player1Id !== userId && game.player2Id !== userId) return;

                if (game.gameType === 'ludo') {
                    const logicalId = game.player1Id === userId ? 'p1' : 'p2';
                    await ludoGameLoop.handleForfeit(gameId, logicalId);
                } else if (game.gameType === 'whot') {
                    await whotGameLoop.handleForfeit(gameId, userId);
                }
            } catch (err) {
                console.error(`[Socket] Forfeit Error: ${err.message}`);
                socket.emit('error', { message: 'Failed to forfeit game' });
            }
        });

        socket.on('disconnect', () => {
            const userId = socketUser.get(socket.id);
            if (userId) {
                userSockets.get(userId)?.delete(socket.id);
                if (userSockets.get(userId)?.size === 0) userSockets.delete(userId);
                socketUser.delete(socket.id);
            }
        });
    });
};

export const getIO = () => {
    if (!io) throw new Error('Socket.IO not initialized!');
    return io;
};

/**
 * Unified Production-Ready Broadcast
 * Uses atomic Redis counters for guaranteed ordering.
 */
export const broadcastGameEvent = async (gameId, type, payload, options = {}) => {
    if (!io) return;

    // Engine acts as the single source of truth for versioning and sequencing
    let stateVersion = undefined;
    let eventId = undefined;

    // Extract stateVersion
    if (payload && payload.stateVersion !== undefined) {
        stateVersion = payload.stateVersion;
    } else if (payload && payload.board && payload.board.stateVersion !== undefined) {
        stateVersion = payload.board.stateVersion;
    }

    // Extract eventId
    if (payload && payload.eventId !== undefined) {
        eventId = payload.eventId;
    } else if (payload && payload.board && payload.board.eventId !== undefined) {
        eventId = payload.board.eventId;
    }

    // Strict validation
    if (options.isStateChange && stateVersion === undefined) {
        console.error(`[SocketManager] CRITICAL: Missing stateVersion for state-changing event ${type} in game ${gameId}! payload keys:`, Object.keys(payload || {}));
        throw new Error(`Missing stateVersion for state-changing event`);
    }

    const gameEvent = {
        eventId: eventId !== undefined ? eventId : 0,
        stateVersion: stateVersion !== undefined ? stateVersion : 0,
        type,
        payload,
        serverTime: Date.now()
    };

    // 2. Broadcast
    io.to(gameId).emit('gameEvent', gameEvent);
    return gameEvent;
};

/**
 * Fog-of-War version of the unified broadcast (for Whot)
 */
export const broadcastScrubbedEvent = async (gameId, type, fullState, options = {}) => {
    if (!io) return;

    const eventId = fullState?.eventId || 0;
    const stateVersion = fullState?.stateVersion || 0;

    const room = io.sockets.adapter.rooms.get(gameId);
    if (!room) return;

    for (const socketId of room) {
        const userId = socketUser.get(socketId);
        if (userId) {
            const scrubbed = whotGameEngine.scrubStateForClient(fullState, userId);
            const gameEvent = {
                eventId,
                stateVersion,
                type,
                payload: { board: scrubbed },
                serverTime: Date.now()
            };
            io.to(socketId).emit('gameEvent', gameEvent);
        }
    }
};
