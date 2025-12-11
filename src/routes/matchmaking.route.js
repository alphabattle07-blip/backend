import express from 'express';
import {
    startMatchmaking,
    cancelMatchmaking,
    checkMatchmakingStatus
} from '../controllers/matchmaking.controller.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All matchmaking routes require authentication
router.use(authenticateToken);

/**
 * @swagger
 * /api/matchmaking/start:
 *   post:
 *     summary: Start automatic matchmaking
 *     tags: [Matchmaking]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - gameType
 *             properties:
 *               gameType:
 *                 type: string
 *                 description: Type of game to matchmake for
 *                 example: "ayo"
 *     responses:
 *       200:
 *         description: Matchmaking started or match found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 matched:
 *                   type: boolean
 *                   description: Whether a match was found immediately
 *                 game:
 *                   $ref: '#/components/schemas/Game'
 *                   description: Game object if matched is true
 *                 message:
 *                   type: string
 *                 queuePosition:
 *                   type: number
 *                   description: Position in queue if not matched
 */
router.post('/start', startMatchmaking);

/**
 * @swagger
 * /api/matchmaking/cancel:
 *   post:
 *     summary: Cancel matchmaking
 *     tags: [Matchmaking]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Matchmaking cancelled
 */
router.post('/cancel', cancelMatchmaking);

/**
 * @swagger
 * /api/matchmaking/status:
 *   get:
 *     summary: Check matchmaking status
 *     tags: [Matchmaking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: gameType
 *         required: true
 *         schema:
 *           type: string
 *         description: Type of game
 *     responses:
 *       200:
 *         description: Matchmaking status
 */
router.get('/status', checkMatchmakingStatus);

export default router;
