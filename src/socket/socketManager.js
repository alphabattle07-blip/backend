
import { ludoGameLoop } from '../engine/ludoGameLoop.js';

let io;

export const initializeSocket = (socketIo) => {
    io = socketIo;

    io.on('connection', (socket) => {
        //console.log('User connected:', socket.id);

        socket.on('joinGame', (gameId) => {
            socket.join(gameId);
            //console.log(`User ${socket.id} joined game ${gameId}`);
        });

        socket.on('leaveGame', (gameId) => {
            socket.leave(gameId);
            //console.log(`User ${socket.id} left game ${gameId}`);
        });

        socket.on('gameAction', (payload) => {
            const { gameId, state, data } = payload;
            const updateData = data || state;
            if (gameId && updateData) {
                // Broadcast the core board or action object directly
                socket.to(gameId).emit('gameStateUpdate', updateData);
            }
        });

        // In a real app, you'd want more robust auth here to map socket ID to user ID
        // For now, we rely on the client sending the correct state interactions

        // Pass socket events to the game loop handler if needed, 
        // but primarily the game loop drives the state based on API calls + timer events.
        // However, for real-time responsiveness, we might listen to 'rollDice' here too.

        socket.on('disconnect', () => {
            //console.log('User disconnected:', socket.id);
        });
    });
};

export const getIO = () => {
    if (!io) {
        throw new Error('Socket.IO not initialized!');
    }
    return io;
};

// Function to broadcast updates to a specific game room
export const broadcastGameState = (gameId, event, data) => {
    if (io) {
        io.to(gameId).emit(event, data);
    }
};
