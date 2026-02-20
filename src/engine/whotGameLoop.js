import redis from '../utils/redis.js';
import { broadcastGameState, broadcastScrubbedState, broadcastOpponentMove } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { whotGameEngine } from './whotGameEngine.js';

const prisma = new PrismaClient();

// In-memory storage for active game states + timers
// Key: gameId, Value: { state: matchState, timers: { turnTimeout, etc. }, lock: Promise }
const activeWhotGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

const TIME_LIMITS = {
    CASUAL: { // Below 1750
        TOTAL: 50000, // 50s
        WARNING: 20000, // At 20s elapsed (30s left) - Yellow
        DANGER: 40000,  // At 40s elapsed (10s left) - Red
    },
    COMPETITIVE: { // Warrior+ (1750+)
        TOTAL: 30000, // 30s
        WARNING: 15000, // At 15s elapsed (15s left) - Red Warning starts
        DANGER: 25000,  // At 25s elapsed (5s left) - Final Danger
    }
};

const MAX_TIMEOUTS = {
    CASUAL: 5,
    COMPETITIVE: 3
};

// Helper to get time limits based on player rating
const getWhotTimeLimits = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? TIME_LIMITS.COMPETITIVE : TIME_LIMITS.CASUAL;
};

const getWhotMaxTimeouts = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? MAX_TIMEOUTS.COMPETITIVE : MAX_TIMEOUTS.CASUAL;
};

// Helper: Check if card matches pile card
const isValidMove = (card, pileCard, calledSuit) => {
    // Whot (20) matches anything
    if (card.number === 20) return true;

    // If there's a called suit, must match that suit
    if (calledSuit) {
        return card.suit === calledSuit;
    }

    // Match suit or number
    return card.suit === pileCard.suit || card.number === pileCard.number;
};

export const whotGameLoop = {
    /**
     * Start/Reset match in memory
     */
    initializeMatch: async (gameId, player1, player2, config) => {
        const state = whotGameEngine.initializeGame(gameId, player1, player2, config);

        const gameEntry = {
            state,
            timers: {},
            lock: Promise.resolve()
        };

        activeWhotGames.set(gameId, gameEntry);

        // Minimal state for Redis (Skip full market for performance if large, but here we keep it but could strip processedMoves)
        const minimalState = { ...state };
        delete minimalState.processedMoves; // Strip history from Redis

        await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

        // Broadcast Initial Deal (Scrubbed)
        broadcastScrubbedState(gameId, state);

        return state;
    },

    /**
     * Get Match State (Authoritative)
     */
    getMatchState: async (gameId) => {
        let entry = activeWhotGames.get(gameId);
        if (!entry) {
            // Reconstruct from Redis
            const cached = await redis.get(`match:${gameId}`);
            if (cached) {
                entry = {
                    state: JSON.parse(cached),
                    timers: {},
                    lock: Promise.resolve()
                };
                activeWhotGames.set(gameId, entry);
            }
        }
        return entry ? entry.state : null;
    },

    /**
     * Reconnect-Ready State Snapshot: Packages EVERYTHING a player needs to resume.
     */
    getFullStateSnapshot: async (gameId, playerId) => {
        const state = await whotGameLoop.getMatchState(gameId);
        if (!state) return null;

        const scrubbed = whotGameEngine.scrubState(state, playerId);
        const limits = state.gameRankType === 'competitive' ? TIME_LIMITS.COMPETITIVE : TIME_LIMITS.CASUAL;
        const elapsed = Date.now() - (state.timerStart || Date.now());

        return {
            ...scrubbed,
            remainingTime: Math.max(0, limits.TOTAL - elapsed),
            serverTime: Date.now()
        };
    },

    /**
     * Atomic Move Execution
     */
    executeMove: async (gameId, playerId, move) => {
        const entry = activeWhotGames.get(gameId);
        if (!entry) throw new Error("Match not found in memory");

        // Wait for previous operations (Locking)
        entry.lock = entry.lock.then(async () => {
            try {
                const state = entry.state;

                // Validation
                const validation = whotGameEngine.validateMove(state, playerId, move);
                if (!validation.valid) throw new Error(validation.reason);

                // Apply
                const nextState = whotGameEngine.applyMove(state, playerId, move);

                // Update Memory + Redis
                entry.state = nextState;

                const minimalState = { ...nextState };
                delete minimalState.processedMoves;
                await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

                // Clear/Restart Timers
                whotGameLoop.startTurnTimer(gameId, nextState.turnPlayer);

                // Success Broadcast
                broadcastGameState(gameId, 'moveConfirmed', { moveId: move.moveId, playerId });

                // 🚀 BROADCAST OPPONENT MOVE (For Animations via SocketService)
                // Construct the WhotGameAction payload expected by frontend
                let actionType = 'UNKNOWN';
                if (move.type === 'PLAY_CARD') actionType = 'CARD_PLAYED';
                else if (move.type === 'DRAW') actionType = 'PICK_CARD';
                // Note: Frontend 'PICK_CARD' covers DRAW. 'FORCED_DRAW' is usually local logic triggering draws, 
                // but if backend sees 'DRAW' from penalty it's still a pick.

                const movePayload = {
                    type: actionType,
                    cardId: move.cardId,
                    suitChoice: move.calledSuit,
                    timestamp: Date.now()
                };

                // Special handling for forced draw or specific 'PICK_CARD' if meaningful differences exist
                // but standard 'DRAW' maps to 'PICK_CARD' visual.

                broadcastOpponentMove(gameId, playerId, movePayload);

                // Sync State (Scrubbed) - still needed for consistency / verification
                broadcastScrubbedState(gameId, nextState);

                // Check Game End
                if (nextState.status === 'COMPLETED') {
                    await whotGameLoop.handleWin(gameId, nextState.winnerId, nextState);
                }

                return nextState;
            } catch (err) {
                console.error(`[WhotLoop] Move error: ${err.message}`);
                throw err;
            }
        });

        return entry.lock;
    },

    /**
     * Start or reset the turn timer for a Whot game
     */
    startTurnTimer: async (gameId, currentPlayerId) => {
        whotGameLoop.clearTurnTimer(gameId);

        const entry = activeWhotGames.get(gameId);
        if (!entry) return;

        const state = entry.state;
        // In a real app, we'd fetch player ratings once at start and keep in state
        // For now, let's assume casual/standard timing from state.gameRankType
        const limits = state.gameRankType === 'competitive' ? TIME_LIMITS.COMPETITIVE : TIME_LIMITS.CASUAL;

        entry.timers.startTime = Date.now();
        entry.state.timerStart = entry.timers.startTime;

        broadcastGameState(gameId, 'turnStarted', {
            whoseTurn: currentPlayerId,
            timeLimit: limits.TOTAL,
            serverTime: Date.now(),
            // Keeping these for UI details if needed, but primary values are above
            warningTime: limits.WARNING,
            dangerTime: limits.DANGER,
            remainingTime: limits.TOTAL - (Date.now() - entry.timers.startTime)
        });

        entry.timers.warningTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerWarning', {
                timeLeft: limits.TOTAL - limits.WARNING,
                type: 'warning'
            });
        }, limits.WARNING);

        entry.timers.dangerTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerDanger', {
                timeLeft: limits.TOTAL - limits.DANGER,
                type: 'danger'
            });
        }, limits.DANGER);

        entry.timers.turnTimeout = setTimeout(async () => {
            await whotGameLoop.handleTurnTimeout(gameId, currentPlayerId);
        }, limits.TOTAL);
    },

    clearTurnTimer: (gameId) => {
        const entry = activeWhotGames.get(gameId);
        if (entry && entry.timers) {
            if (entry.timers.warningTimeout) clearTimeout(entry.timers.warningTimeout);
            if (entry.timers.dangerTimeout) clearTimeout(entry.timers.dangerTimeout);
            if (entry.timers.turnTimeout) clearTimeout(entry.timers.turnTimeout);
        }
    },

    /**
     * Recovery logic for server restarts
     */
    recoverMatches: async () => {
        console.log('[WhotLoop] Recovering matches from Redis...');
        const keys = await redis.keys('match:*');
        for (const key of keys) {
            const gameId = key.split(':')[1];
            const cached = await redis.get(key);
            if (cached) {
                const state = JSON.parse(cached);
                const entry = {
                    state,
                    timers: {},
                    lock: Promise.resolve()
                };
                activeWhotGames.set(gameId, entry);

                // Restart timer if still in progress
                if (state.status === 'IN_PROGRESS') {
                    const limits = getWhotTimeLimits(1750); // Fallback rating
                    const elapsed = Date.now() - (state.timerStart || Date.now());
                    const remaining = limits.TOTAL - elapsed;

                    if (remaining > 0) {
                        whotGameLoop.startTurnTimer(gameId, state.turnPlayer);
                    } else {
                        // Handle instant timeout if they were gone too long
                        whotGameLoop.handleTurnTimeout(gameId, state.turnPlayer);
                    }
                }
            }
        }
        console.log(`[WhotLoop] Recovered ${keys.length} matches.`);
    },

    handleTurnTimeout: async (gameId, playerId) => {
        console.log(`[WhotEngine] Turn timeout for ${playerId} in game ${gameId}`);

        const entry = activeWhotGames.get(gameId);
        if (!entry) return;

        entry.lock = entry.lock.then(async () => {
            const state = entry.state;

            // 1. Increment Timeout Count
            state.timeoutCount[playerId] = (state.timeoutCount[playerId] || 0) + 1;
            const currentTimeouts = state.timeoutCount[playerId];

            // In a real app we'd determine maxTimeouts from rating stored in state
            const maxTimeouts = state.gameRankType === 'competitive' ? 3 : 5;

            // 2. Check Forfeit
            if (currentTimeouts >= maxTimeouts) {
                await whotGameLoop.handleForfeit(gameId, playerId);
                return;
            }

            // 3. Authoritative Auto-Play via Engine
            const nextState = whotGameEngine.handleTimeout(state, playerId);

            // Update Memory + Redis
            entry.state = nextState;
            await redis.set(`match:${gameId}`, JSON.stringify(nextState));

            // Success Broadcast (for Auto-Play)
            broadcastGameState(gameId, 'moveConfirmed', { moveId: 'auto', playerId });
            broadcastScrubbedState(gameId, nextState);

            // If game ended
            if (nextState.status === 'COMPLETED') {
                await whotGameLoop.handleWin(gameId, nextState.winnerId, nextState);
            } else {
                whotGameLoop.startTurnTimer(gameId, nextState.turnPlayer);
            }
        });
    },

    handleWin: async (gameId, winnerId, board) => {
        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'COMPLETED',
                winnerId: winnerId,
                endedAt: new Date(),
                board: board
            }
        });
        broadcastGameState(gameId, 'gameEnded', { winnerId });
        whotGameLoop.clearTurnTimer(gameId);
        activeWhotGames.delete(gameId);
        await redis.del(`match:${gameId}`);
    },

    handleForfeit: async (gameId, losingPlayerId) => {
        console.log(`[WhotEngine] Forfeit ${losingPlayerId} in game ${gameId}`);

        const entry = activeWhotGames.get(gameId);
        const state = entry ? entry.state : null;
        const winnerId = state ? state.players.find(id => id !== losingPlayerId) : null;

        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'COMPLETED',
                winnerId: winnerId,
                endedAt: new Date()
            }
        });

        broadcastGameState(gameId, 'gameForfeit', {
            winnerId,
            loserId: losingPlayerId,
            message: "Opponent timed out too many times."
        });

        whotGameLoop.clearTurnTimer(gameId);
        activeWhotGames.delete(gameId);
        await redis.del(`match:${gameId}`);
    }
};
