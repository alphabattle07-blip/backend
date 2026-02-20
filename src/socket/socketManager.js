import { ludoGameLoop } from '../engine/ludoGameLoop.js';
import { whotGameEngine } from '../engine/whotGameEngine.js';

let io;
// Map to track userId -> Set of socketIds (to handle multiple sessions/tabs)
const userSockets = new Map();
// Reverse map socketId -> userId
const socketUser = new Map();

export const initializeSocket = (socketIo) => {
    io = socketIo;

    io.on('connection', (socket) => {
        console.log(`[Socket] New connection: ${socket.id}`);

        // In a real app, verify token and get userId
        // For now, we expect 'register' event after connection
        socket.on('register', (userId) => {
            console.log(`[Socket] Received register event for user: ${userId} on socket: ${socket.id}`);
            if (!userSockets.has(userId)) userSockets.set(userId, new Set());
            userSockets.get(userId).add(socket.id);
            socketUser.set(socket.id, userId);
            console.log(`[Socket] Successfully registered user ${userId} to socket ${socket.id}`);
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

        socket.on('gameAction', (payload) => {
            const { gameId, state, data, gameType } = payload;
            if (gameType === 'whot') return;
            const updateData = data || state;
            if (gameId && updateData) {
                socket.to(gameId).emit('gameStateUpdate', updateData);
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

// Generic broadcast
export const broadcastGameState = (gameId, event, data) => {
    if (io) io.to(gameId).emit(event, data);
};


/**
 * Whot Specific Broadcast: Ensures Fog-of-War by scrubbing state for each player individually
 */
export const broadcastScrubbedState = async (gameId, state) => {
    if (!io) return;

    const room = io.sockets.adapter.rooms.get(gameId);
    if (!room) return;

    // For each socket in the room, find its user and send uniquely scrubbed state
    for (const socketId of room) {
        const userId = socketUser.get(socketId);
        if (userId) {
            const scrubbed = whotGameEngine.scrubState(state, userId);
            io.to(socketId).emit('gameStateUpdate', { board: scrubbed });
        }
    }
};

/**
 * Broadcast Opponent Move: Sends the move action to everyone EXCEPT the player who made it.
 * This triggers the animation on the opponent's screen.
 */
export const broadcastOpponentMove = (gameId, excludePlayerId, moveData) => {
    if (!io) return;

    const room = io.sockets.adapter.rooms.get(gameId);
    if (!room) return;

    for (const socketId of room) {
        const userId = socketUser.get(socketId);
        // Send to everyone EXCEPT the excluded player (the mover)
        if (userId && userId !== excludePlayerId) {
            io.to(socketId).emit('opponent-move', moveData);
        }
    }
};
