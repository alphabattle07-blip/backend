import { PrismaClient } from '../generated/prisma/index.js';
import { initializeGameData } from '../utils/gameUtils.js';
import { whotGameLoop } from '../engine/whotGameLoop.js';
import { whotGameEngine } from '../engine/whotGameEngine.js';
import { ludoGameLoop } from '../engine/ludoGameLoop.js';

const prisma = new PrismaClient();

// Store for matchmaking queue
const matchmakingQueue = new Map(); // userId -> { rating, timestamp, gameType, tier? }

// Store for found matches to avoid DB polling leaks
const matchedGames = new Map(); // userId -> { game, timestamp }

// Warrior+ tier threshold for Ludo
const LUDO_WARRIOR_RATING = 1750;

/**
 * Resolve a user's Ludo tier from their game-specific rating.
 * Uses GameStats.rating for 'ludo', falls back to global User.rating.
 */
const getLudoTier = (user) => {
    const ludoStats = (user.gameStats || []).find(s => s.gameId === 'ludo');
    const ludoRating = ludoStats?.rating ?? user.rating ?? 1000;
    return ludoRating >= LUDO_WARRIOR_RATING ? 'warrior' : 'standard';
};

/**
 * Calculate rating difference between two players
 */
const getRatingDifference = (rating1, rating2) => {
    return Math.abs(rating1 - rating2);
};

/**
 * Find the best match for a player based on rating proximity.
 * For Ludo, enforces tier separation (Warrior+ only matches Warrior+).
 */
const findBestMatch = (playerRating, gameType, excludeUserId, tier = null) => {
    let bestMatch = null;
    let smallestDifference = Infinity;

    for (const [userId, data] of matchmakingQueue.entries()) {
        if (userId === excludeUserId || data.gameType !== gameType) {
            continue;
        }

        // Ludo tier separation: Warrior+ only matches Warrior+, Standard only matches Standard
        if (gameType === 'ludo' && tier && data.tier !== tier) {
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
            select: { id: true, name: true, avatar: true, rating: true, gameStats: true }
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

        // Check if user has a stale matched game
        if (matchedGames.has(userId)) {
            console.log(`User ${userId} has a stale matched game in memory, removing it`);
            matchedGames.delete(userId);
        }


        // Resolve Ludo tier for tier-separated matchmaking
        const ludoTier = gameType === 'ludo' ? getLudoTier(user) : null;

        // Try to find an existing match (Ludo: tier-filtered)
        const bestMatch = findBestMatch(user.rating, gameType, userId, ludoTier);

        if (bestMatch) {
            // Get opponent details
            const opponent = await prisma.user.findUnique({
                where: { id: bestMatch.userId },
                select: { id: true, name: true, avatar: true, rating: true, gameStats: true }
            });

            // Create game with both players
            let game;
            if (gameType === 'whot') {
                game = await prisma.game.create({
                    data: {
                        gameType,
                        player1Id: bestMatch.userId, // The player who was waiting
                        player2Id: userId, // The player who just joined
                        status: 'IN_PROGRESS',
                        startedAt: new Date()
                    },
                    include: {
                        player1: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } },
                        player2: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } }
                    }
                });
                const highestRating = Math.max(opponent.rating || 0, user.rating || 0);
                const config = {
                    gameRankType: highestRating >= 1750 ? 'competitive' : 'casual',
                    // Force rule1 for all tiers to prevent confusion with missing special card effects
                    ruleVersion: 'rule1'
                };
                const matchState = await whotGameLoop.initializeMatch(game.id, game.player1, game.player2, config);
                game = await prisma.game.update({
                    where: { id: game.id },
                    data: { board: matchState, currentTurn: matchState.turnPlayer },
                    include: {
                        player1: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } },
                        player2: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } }
                    }
                });
                whotGameLoop.startTurnTimer(game.id, matchState.turnPlayer);

            } else {
                // Ludo: Warrior+ tier (both players ≥1750) gets level 3 rules (2 dice, no safe tiles, capture boost)
                const ludoConfig = gameType === 'ludo' ? { level: ludoTier === 'warrior' ? 3 : 2 } : {};
                const gameData = initializeGameData(gameType, opponent, user, ludoConfig);
                game = await prisma.game.create({
                    data: {
                        gameType,
                        player1Id: bestMatch.userId, // The player who was waiting
                        player2Id: userId, // The player who just joined
                        status: 'IN_PROGRESS',
                        ...gameData,
                        startedAt: new Date()
                    },
                    include: {
                        player1: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } },
                        player2: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } }
                    }
                });

                // Instantly start the turn timer with a buffer to safely bypass MATCH_READY handshake issues
                await ludoGameLoop.startTurnTimer(game.id, null, { initialBuffer: 3500 });
            }

            // --- RACE CONDITION SAFETY ---
            // Only delete from queue AFTER game is created. If we delete before Prisma is done, 
            // the other player's polling interval might hit during that 50ms window and crash out.
            matchmakingQueue.delete(bestMatch.userId);

            // For the pending opponent who is polling, we MUST store an unscrubbed generic state 
            // so their poll request can scrub it for their specific userId later
            matchedGames.set(bestMatch.userId, { game: JSON.parse(JSON.stringify(game)), timestamp: Date.now() });

            // Create response object for the first player (User 2 - the one who triggered startMatchmaking)
            let responseGame = JSON.parse(JSON.stringify(game));
            if (gameType === 'whot') {
                // Now safely scrub state for the player who triggered startMatchmaking
                const matchState = (typeof game.board === 'string') ? JSON.parse(game.board) : game.board;
                responseGame.board = whotGameEngine.scrubStateForClient(matchState, userId);
            }

            return res.json({
                success: true,
                matched: true,
                game: responseGame,
                message: 'Match found!'
            });
        } else {
            // No match found, add to queue (Ludo includes tier for separation)
            matchmakingQueue.set(userId, {
                rating: user.rating,
                timestamp: Date.now(),
                gameType,
                ...(gameType === 'ludo' ? { tier: ludoTier } : {})
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

        // 1. Check if a match was already found for this user in memory
        console.log(`[Matchmaking Polling] User ${userId} checking status for ${gameType}`);
        if (matchedGames.has(userId)) {
            console.log(`[Matchmaking Polling] Match found in memory for User ${userId}! extracted game`);
            try {
                const { game } = matchedGames.get(userId);
                // Deep clone to prevent mutating the stored version for other polling attempts
                let clientGame = JSON.parse(JSON.stringify(game));

                if (clientGame.gameType === 'whot' && clientGame.board) {
                    clientGame.board = whotGameEngine.scrubStateForClient(clientGame.board, userId);
                }

                // Optional: delete from matchedGames so it doesn't linger forever, 
                // but the client might poll a few extra times before unmounting. 
                // The cleanup interval will catch it later.
                return res.json({
                    success: true,
                    matched: true,
                    game: clientGame,
                    message: 'Match found!'
                });
            } catch (innerError) {
                console.error(`[Matchmaking Error] Inner memory map extraction failed for user ${userId}:`, innerError);
                throw innerError; // let outer catch grab it to 500
            }
        }

        // 2. Check if user is still in queue
        if (!matchmakingQueue.has(userId)) {
            console.log(`[Matchmaking Polling] User ${userId} not in queue and no match in memory. Returning matched: false, inQueue: false`);
            return res.json({
                success: true,
                matched: false,
                inQueue: false,
                message: 'Not in queue'
            });
        }

        // 3. User is still in queue, try to find a match using in-memory rating
        const queueData = matchmakingQueue.get(userId);
        const bestMatch = findBestMatch(queueData.rating, gameType, userId, queueData.tier || null);

        if (bestMatch) {
            // Get both players' full details to initialize the game
            const [user, opponent] = await Promise.all([
                prisma.user.findUnique({
                    where: { id: userId },
                    select: { id: true, name: true, avatar: true, rating: true, gameStats: true }
                }),
                prisma.user.findUnique({
                    where: { id: bestMatch.userId },
                    select: { id: true, name: true, avatar: true, rating: true, gameStats: true }
                })
            ]);

            let game;
            if (gameType === 'whot') {
                game = await prisma.game.create({
                    data: {
                        gameType,
                        player1Id: userId,
                        player2Id: bestMatch.userId,
                        status: 'IN_PROGRESS',
                        startedAt: new Date()
                    },
                    include: {
                        player1: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } },
                        player2: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } }
                    }
                });
                const highestRating = Math.max(user.rating || 0, opponent.rating || 0);
                const config = {
                    gameRankType: highestRating >= 1750 ? 'competitive' : 'casual',
                    // Force rule1 for all tiers to prevent confusion with missing special card effects
                    ruleVersion: 'rule1'
                };
                const matchState = await whotGameLoop.initializeMatch(game.id, game.player1, game.player2, config);
                game = await prisma.game.update({
                    where: { id: game.id },
                    data: { board: matchState, currentTurn: matchState.turnPlayer },
                    include: {
                        player1: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } },
                        player2: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } }
                    }
                });
                whotGameLoop.startTurnTimer(game.id, matchState.turnPlayer);

            } else {
                // Ludo: Use tier from the queue entry to determine level
                const ludoConfig = gameType === 'ludo' ? { level: queueData.tier === 'warrior' ? 3 : 2 } : {};
                const gameData = initializeGameData(gameType, user, opponent, ludoConfig);
                game = await prisma.game.create({
                    data: {
                        gameType,
                        player1Id: userId,
                        player2Id: bestMatch.userId,
                        status: 'IN_PROGRESS',
                        ...gameData,
                        startedAt: new Date()
                    },
                    include: {
                        player1: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } },
                        player2: { select: { id: true, name: true, avatar: true, rating: true, gameStats: true } }
                    }
                });

                // Instantly start the turn timer to bypass MATCH_READY handshake
                await ludoGameLoop.startTurnTimer(game.id, null);
            }

            // --- RACE CONDITION SAFETY ---
            // Only delete from queue AFTER game is created. If we delete before Prisma is done,
            // the other player's polling interval might hit during that 50ms window and crash out.
            matchmakingQueue.delete(userId);
            matchmakingQueue.delete(bestMatch.userId);

            // Save matched game to memory for the other player who is polling (User 2 in this case)
            matchedGames.set(bestMatch.userId, { game: JSON.parse(JSON.stringify(game)), timestamp: Date.now() });

            // Create response object for User 1 polling (the user who was waiting)
            let responseGame = JSON.parse(JSON.stringify(game));
            if (gameType === 'whot') {
                const matchState = (typeof game.board === 'string') ? JSON.parse(game.board) : game.board;
                // SCRUB FOR THE POLLING USER (the one who initiated checkMatchmakingStatus), not bestMatch (userId)
                responseGame.board = whotGameEngine.scrubStateForClient(matchState, userId);
            }

            return res.json({
                success: true,
                matched: true,
                game: responseGame,
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

// Clean up old queue entries and matched games (older than 5 minutes)
setInterval(() => {
    const now = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5 minutes

    for (const [userId, data] of matchmakingQueue.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            matchmakingQueue.delete(userId);
            console.log(`[Queue] Removed user ${userId} from queue due to timeout`);
        }
    }

    for (const [userId, data] of matchedGames.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            matchedGames.delete(userId);
            console.log(`[Queue] Cleaned up matched game state for user ${userId}`);
        }
    }
}, 60000); // Run every minute
