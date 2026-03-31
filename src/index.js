
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import gameRoutes from './routes/game.route.js';
import userRoutes from './routes/user.route.js';
import matchmakingRoutes from './routes/matchmaking.route.js';
import { initializeSocket } from './socket/socketManager.js';
import { swaggerUi, specs } from './utils/swagger.js';
import { whotGameLoop } from './engine/whotGameLoop.js';
import { ludoGameLoop } from './engine/ludoGameLoop.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration
const corsOptions = {
    origin: '*', // Allow all origins for development
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json());

// Initialize Socket.IO
const io = new Server(httpServer, {
    cors: corsOptions,
    // Heartbeat every 10s — keeps Render's 60s idle-disconnect from ever firing.
    // Mobile players (Nigeria, Canada) on 4G/LTE have unpredictable packet loss;
    // a fast ping catches dead connections in 15s instead of the old 115s (25+90).
    pingInterval: 10000,
    pingTimeout: 5000,
    // Give the initial TLS + WebSocket handshake 45s to complete (matches client)
    connectTimeout: 45000,
});

// Initialize Socket Manager
initializeSocket(io);

// Initialize Match Recovery
whotGameLoop.recoverMatches();
ludoGameLoop.recoverMatches();

// Routes
app.use('/api/games', gameRoutes);
app.use('/api/auth', userRoutes);
app.use('/api/matchmaking', matchmakingRoutes);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Basic health check
app.get('/', (req, res) => {
    res.send('Ludo Game Server is running');
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
