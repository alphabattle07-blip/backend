import { getIO } from '../socket/socketManager.js';
import { chatRedis } from './chatRedis.js';

// Simple in-memory rate limiting (Map: userId -> { count, lastReset })
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 10000; // 10 seconds
const MAX_MESSAGES_PER_WINDOW = 5;

const checkRateLimit = (userId) => {
    const now = Date.now();
    let userData = rateLimits.get(userId);

    if (!userData || now - userData.lastReset > RATE_LIMIT_WINDOW_MS) {
        // Reset or initialize
        userData = { count: 1, lastReset: now };
        rateLimits.set(userId, userData);
        return true;
    }

    if (userData.count >= MAX_MESSAGES_PER_WINDOW) {
        return false; // Rate limited
    }

    userData.count++;
    return true;
};

const sanitizeMessage = (message) => {
    if (typeof message !== 'string') return '';
    // Basic sanitization: remove HTML/script tags
    return message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .trim();
};

export const initializeChatSocket = (socket, socketUser) => {
    // Client joins the specific match chat room
    socket.on('join_match_chat', async (matchId) => {
        const userId = socketUser.get(socket.id);
        if (!userId) return;

        const roomName = `chat:${matchId}`;
        socket.join(roomName);
        console.log(`[Chat Socket] User ${userId} (socket ${socket.id}) joined chat room: ${roomName}`);

        // Let the client know they successfully connected (optional)
        socket.emit('chat_status', { status: 'connected', matchId });

        // Retrieve missed/historical messages and send them just to this connecting user
        try {
            const history = await chatRedis.getRecentMessages(matchId);
            socket.emit('chat_history', { matchId, messages: history });
        } catch (error) {
            console.error(`[Chat Socket] Failed to send history to ${userId}`, error);
        }
    });

    // Client sends a message
    socket.on('send_match_message', async (payload) => {
        const userId = socketUser.get(socket.id);
        if (!userId) return;

        const { matchId, message } = payload;

        // 1. Validate presence
        if (!matchId || !message) return;

        // 2. Format & Sanitize
        const cleanMessage = sanitizeMessage(message);

        // 3. Prevent empty messages
        if (cleanMessage.length === 0) return;

        // 4. Validate length constraints (max 300)
        if (cleanMessage.length > 300) {
            socket.emit('chat_error', { message: 'Message exceeds maximum length of 300 characters.' });
            return;
        }

        // 5. Rate Limiting Check
        if (!checkRateLimit(userId)) {
            socket.emit('chat_error', { message: 'You are sending messages too fast. Please wait.' });
            return;
        }

        // 6. Broadcast to the room (isolated from game rooms)
        // We use the `chat:matchId` room to ensure game updates don't overlap with chat
        const roomName = `chat:${matchId}`;

        const chatPayload = {
            senderId: userId,
            message: cleanMessage,
            timestamp: new Date().toISOString()
        };

        // 7. Fire & Forget to Redis (Ephemeral Match Storage)
        chatRedis.saveMessage(matchId, chatPayload);

        const io = getIO();
        io.to(roomName).emit('receive_match_message', chatPayload);

        console.log(`[Chat Socket] Message broadcasted in ${roomName} from ${userId}`);
    });

    // Optional: Leave chat explicitly (usually handled by socket disconnect, but good for cleanup)
    socket.on('leave_match_chat', (matchId) => {
        const roomName = `chat:${matchId}`;
        socket.leave(roomName);
        console.log(`[Chat Socket] Socket ${socket.id} left chat room: ${roomName}`);
    });
};
