
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
    pingInterval: 25000,   // Heartbeat every 25s
    pingTimeout: 90000,    // 90s grace period for aggressive Android battery/Doze backgrounding
    connectTimeout: 20000, // How long to wait for initial handshake
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
