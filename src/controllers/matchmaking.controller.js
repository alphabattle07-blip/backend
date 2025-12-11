import { PrismaClient } from '../generated/prisma/index.js';

const prisma = new PrismaClient();

// Store for matchmaking queue
const matchmakingQueue = new Map(); // userId -> { rating, timestamp, gameType }

/**
 * Calculate rating difference between two players
 */
const getRatingDifference = (rating1, rating2) => {
    return Math.abs(rating1 - rating2);
};

/**
 * Find the best match for a player based on rating proximity
 */
const findBestMatch = (playerRating, gameType, excludeUserId) => {
    let bestMatch = null;
    let smallestDifference = Infinity;

    for (const [userId, data] of matchmakingQueue.entries()) {
        if (userId === excludeUserId || data.gameType !== gameType) {
            continue;
        }

        const difference = getRatingDifference(playerRating, data.rating);

        if (difference < smallestDifference) {
            smallestDifference = difference;
            bestMatch = { userId, ...data };
        }
    }

    return bestMatch;
};

/**
 * Start matchmaking - join queue and find match
 */
export const startMatchmaking = async (req, res) => {
    try {
        const { gameType } = req.body;
        const userId = req.user.id;

        // Get user's current rating
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, rating: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }


        // Check if user is already in queue
        if (matchmakingQueue.has(userId)) {
            // Remove old entry and continue (handles component remounts)
            console.log(`User ${userId} already in queue, removing old entry`);
            matchmakingQueue.delete(userId);
        }


        // Try to find an existing match
        const bestMatch = findBestMatch(user.rating, gameType, userId);

        if (bestMatch) {
            // Found a match! Remove from queue and create game
            matchmakingQueue.delete(bestMatch.userId);

            // Get opponent details
            const opponent = await prisma.user.findUnique({
                where: { id: bestMatch.userId },
                select: { id: true, name: true, rating: true }
            });

            // Create game with both players
            const game = await prisma.game.create({
                data: {
                    gameType,
                    player1Id: bestMatch.userId, // The player who was waiting
                    player2Id: userId, // The player who just joined
                    status: 'IN_PROGRESS',
                    currentTurn: bestMatch.userId, // Player 1 starts
                    startedAt: new Date()
                },
                include: {
                    player1: { select: { id: true, name: true, rating: true } },
                    player2: { select: { id: true, name: true, rating: true } }
                }
            });

            return res.json({
                success: true,
                matched: true,
                game,
                message: 'Match found!'
            });
        } else {
            // No match found, add to queue
            matchmakingQueue.set(userId, {
                rating: user.rating,
                timestamp: Date.now(),
                gameType
            });

            return res.json({
                success: true,
                matched: false,
                message: 'Searching for opponent...',
                queuePosition: matchmakingQueue.size
            });
        }
    } catch (error) {
        console.error('Matchmaking error:', error);
        res.status(500).json({
            success: false,
            message: 'Matchmaking failed'
        });
    }
};

/**
 * Cancel matchmaking - remove from queue
 */
export const cancelMatchmaking = async (req, res) => {
    try {
        const userId = req.user.id;

        if (matchmakingQueue.has(userId)) {
            matchmakingQueue.delete(userId);
            return res.json({
                success: true,
                message: 'Matchmaking cancelled'
            });
        }

        return res.status(400).json({
            success: false,
            message: 'Not in matchmaking queue'
        });
    } catch (error) {
        console.error('Cancel matchmaking error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel matchmaking'
        });
    }
};

/**
 * Check matchmaking status - poll for match
 */
export const checkMatchmakingStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const { gameType } = req.query;

        // Check if user is still in queue
        if (!matchmakingQueue.has(userId)) {
            // Check if a game was created for this user
            const recentGame = await prisma.game.findFirst({
                where: {
                    OR: [
                        { player1Id: userId },
                        { player2Id: userId }
                    ],
                    gameType,
                    status: 'IN_PROGRESS',
                    startedAt: {
                        gte: new Date(Date.now() - 30000) // Within last 30 seconds
                    }
                },
                include: {
                    player1: { select: { id: true, name: true, rating: true } },
                    player2: { select: { id: true, name: true, rating: true } }
                },
                orderBy: { startedAt: 'desc' }
            });

            if (recentGame) {
                return res.json({
                    success: true,
                    matched: true,
                    game: recentGame,
                    message: 'Match found!'
                });
            }

            return res.json({
                success: true,
                matched: false,
                inQueue: false,
                message: 'Not in queue'
            });
        }

        // Still in queue, try to find match again
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, rating: true }
        });

        const bestMatch = findBestMatch(user.rating, gameType, userId);

        if (bestMatch) {
            // Found a match! Remove both from queue and create game
            matchmakingQueue.delete(userId);
            matchmakingQueue.delete(bestMatch.userId);

            const game = await prisma.game.create({
                data: {
                    gameType,
                    player1Id: userId,
                    player2Id: bestMatch.userId,
                    status: 'IN_PROGRESS',
                    currentTurn: userId, // Player 1 starts
                    startedAt: new Date()
                },
                include: {
                    player1: { select: { id: true, name: true, rating: true } },
                    player2: { select: { id: true, name: true, rating: true } }
                }
            });

            return res.json({
                success: true,
                matched: true,
                game,
                message: 'Match found!'
            });
        }

        // Still searching
        return res.json({
            success: true,
            matched: false,
            inQueue: true,
            queuePosition: matchmakingQueue.size,
            message: 'Searching for opponent...'
        });
    } catch (error) {
        console.error('Check matchmaking status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check matchmaking status'
        });
    }
};

// Clean up old queue entries (older than 5 minutes)
setInterval(() => {
    const now = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5 minutes

    for (const [userId, data] of matchmakingQueue.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            matchmakingQueue.delete(userId);
            console.log(`Removed user ${userId} from matchmaking queue due to timeout`);
        }
    }
}, 60000); // Run every minute
