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
        TOTAL: 25000, // 25s
        WARNING: 10000, // At 10s elapsed (15s left) - Yellow
        DANGER: 20000,  // At 20s elapsed (5s left) - Red
    },
    COMPETITIVE: { // Warrior+ (1750+)
        TOTAL: 19000, // 19s
        WARNING: 7000, // At 7s elapsed (12s left) - Yellow
        DANGER: 14000,  // At 14s elapsed (5s left) - Red
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

// --- CENTRAL TICKER ENGINE ---
// Replaces per-match setTimeouts. Checks all active matches every 300ms.
setInterval(() => {
    for (const [gameId, entry] of activeWhotGames.entries()) {
        const state = entry.state;

        // 1. Skip if already ended
        if (state.status === 'COMPLETED') continue;

        // 2. Skip if currently executing a move (lock is pending)
        if (entry.isLocked) continue;

        // 3. Check for timeout
        const now = Date.now();
        if (now >= state.turnStartTime + state.turnDuration) {
            // Trigger timeout
            whotGameLoop.handleTurnTimeout(gameId, state.turnPlayer);
        }
    }
}, 300);

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
            lock: Promise.resolve(),
            isLocked: false // Tracks atomic execution state for the central ticker
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
                    lock: Promise.resolve(),
                    isLocked: false
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

        const elapsed = Date.now() - state.turnStartTime;
        const remaining = state.turnDuration - elapsed;

        // If a player reconnects EXACTLY as a timeout should occur, force it locally immediately
        if (remaining <= 0 && state.status !== 'COMPLETED') {
            await whotGameLoop.handleTurnTimeout(gameId, state.turnPlayer);
            // Fetch the updated state after the automatic timeout
            const updatedState = await whotGameLoop.getMatchState(gameId);
            const scrubbed = whotGameEngine.scrubStateForClient(updatedState, playerId);
            return {
                ...scrubbed,
                remainingTime: updatedState.turnDuration, // Restarted after timeout
                serverTime: Date.now()
            };
        }

        const scrubbed = whotGameEngine.scrubStateForClient(state, playerId);

        return {
            ...scrubbed,
            remainingTime: Math.max(0, remaining),
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
            entry.isLocked = true;
            try {
                const state = entry.state;

                // Anti-Desync Protection: Reject late moves
                if (Date.now() > state.turnStartTime + state.turnDuration) {
                    throw new Error("Move rejected: Time limit exceeded (Desync protection)");
                }

                // Validation
                const validation = whotGameEngine.validateMove(state, playerId, move);
                if (!validation.valid) throw new Error(validation.reason);

                // Apply
                const nextState = whotGameEngine.applyMove(state, playerId, move);

                // ATOMIC TIMER RESET INSIDE LOCK
                // This guarantees the ticker doesn't accidentally trigger a timeout between the move executing and the timer restarting.
                nextState.turnStartTime = Date.now();
                nextState.warningYellowAt = nextState.turnStartTime + (nextState.rankType === 'warrior' ? 7000 : 10000);
                nextState.warningRedAt = nextState.turnStartTime + (nextState.rankType === 'warrior' ? 14000 : 20000);

                // Update Memory + Redis
                entry.state = nextState;

                const minimalState = { ...nextState };
                delete minimalState.processedMoves;
                await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

                // Success Broadcast
                broadcastGameState(gameId, 'moveConfirmed', { moveId: move.moveId, playerId });

                // 🚀 BROADCAST OPPONENT MOVE (For Animations via SocketService)
                let actionType = 'UNKNOWN';
                if (move.type === 'PLAY_CARD') actionType = 'CARD_PLAYED';
                else if (move.type === 'DRAW') actionType = 'PICK_CARD';

                // Include full card data for CARD_PLAYED — once played, the card is public
                const playedCard = move.type === 'PLAY_CARD'
                    ? nextState.discardPile[nextState.discardPile.length - 1]
                    : null;

                const movePayload = {
                    type: actionType,
                    cardId: move.cardId,
                    card: playedCard, // Full card data for rendering on opponent's screen
                    suitChoice: move.calledSuit,
                    timestamp: Date.now()
                };

                broadcastOpponentMove(gameId, playerId, movePayload);

                // Sync State (Scrubbed) - still needed for consistency / verification
                broadcastScrubbedState(gameId, nextState);

                // Check Game End
                if (nextState.status === 'COMPLETED') {
                    await whotGameLoop.handleWin(gameId, nextState.winnerId, nextState);
                } else {
                    whotGameLoop.startTurnTimer(gameId, nextState.turnPlayer);
                }

                return nextState;
            } catch (err) {
                console.error(`[WhotLoop] Move error: ${err.message}`);
                throw err;
            } finally {
                entry.isLocked = false;
            }
        });

        return entry.lock;
    },

    /**
     * Start or reset the turn timer for a Whot game
     */
    startTurnTimer: async (gameId, currentPlayerId) => {
        // StartTurnTimer is now purely responsble for emitting the visual clock values to clients.
        // It does NOT govern the actual timeout interval.
        const entry = activeWhotGames.get(gameId);
        if (!entry) return;

        const state = entry.state;

        broadcastGameState(gameId, 'turnStarted', {
            whoseTurn: currentPlayerId,
            timeLimit: state.turnDuration,
            serverTime: Date.now()
        });
    },

    clearTurnTimer: (gameId) => {
        // Obsolete function kept for legacy. The central ticker manages execution now.
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
                    lock: Promise.resolve(),
                    isLocked: false
                };
                activeWhotGames.set(gameId, entry);

                // Restart timer if still in progress
                if (state.status === 'IN_PROGRESS') {
                    const elapsed = Date.now() - state.turnStartTime;
                    const remaining = state.turnDuration - elapsed;

                    if (remaining > 0) {
                        whotGameLoop.startTurnTimer(gameId, state.turnPlayer);
                    } else {
                        // EXPLICIT REQUIREMENT 4: Handle instant timeout if they were gone too long
                        // We do not wait for the next 300ms tick
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
            entry.isLocked = true;
            try {
                let state = entry.state;

                // Make sure the state matches the intended player to avoid race condition timeouts
                if (state.turnPlayer !== playerId || state.status === 'COMPLETED') return;

                // Calculate timeout limits based on tier
                const maxTimeouts = state.rankType === 'warrior' ? 3 : 5;

                // 1. Increment timeout ONLY ONCE (before any auto-play execution)
                state.timeoutCount[playerId] = (state.timeoutCount[playerId] || 0) + 1;

                // 2. Resolution Loop for chained effects
                let safetyCounter = 0;
                const MAX_CHAIN = 20;

                while (!state.gameCompleted && state.turnPlayer === playerId && state.status !== 'COMPLETED') {
                    const result = whotGameEngine.handleTurnTimeout(state);

                    if (!result || !result.state) break;

                    state = result.state;
                    entry.state = state;

                    // broadcast auto move immediately for each step in the chain
                    broadcastOpponentMove(gameId, playerId, {
                        ...result.move,
                        timestamp: Date.now()
                    });

                    // safety guard
                    if (++safetyCounter > MAX_CHAIN) {
                        console.error("[WhotLoop] Auto-play chain exceeded safe limit");
                        break;
                    }
                }

                // EXPLICIT REQUIREMENT 2: Time execution must reset timer safely inside atomic lock.
                state.turnStartTime = Date.now();
                state.warningYellowAt = state.turnStartTime + (state.rankType === 'warrior' ? 7000 : 10000);
                state.warningRedAt = state.turnStartTime + (state.rankType === 'warrior' ? 14000 : 20000);

                // Update Memory + Redis
                entry.state = state;
                const minimalState = { ...state };
                delete minimalState.processedMoves;
                await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

                // Success Broadcast (for Auto-Play)
                broadcastGameState(gameId, 'moveConfirmed', { moveId: 'auto', playerId });

                broadcastScrubbedState(gameId, state);

                // Check Forfeit
                // The counter is checked here after the loop
                if (state.timeoutCount[playerId] >= maxTimeouts) {
                    await whotGameLoop.handleForfeit(gameId, playerId);
                    return;
                }

                // If game ended
                if (state.status === 'COMPLETED') {
                    await whotGameLoop.handleWin(gameId, state.winnerId, state);
                } else {
                    whotGameLoop.startTurnTimer(gameId, state.turnPlayer);
                }
            } catch (err) {
                console.error(`[WhotLoop] Timeout error: ${err.message}`);
            } finally {
                entry.isLocked = false;
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
