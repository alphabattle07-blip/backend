import redis from '../utils/redis.js';
import { broadcastGameEvent, broadcastScrubbedEvent, broadcastGameEventExcluding } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { whotGameEngine } from './whotGameEngine.js';
import { processMatchRewards } from '../utils/gameUtils.js';
import { chatRepository } from '../chat/chatRepository.js';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

// In-memory storage for active game states + timers
const activeWhotGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

const TIME_LIMITS = {
    CASUAL: { // Below 1750
        TOTAL: 30000,   // 30s
        WARNING: null,  // No yellow state
        DANGER: 25000,  // At 25s elapsed (5s left) - Red
    },
    COMPETITIVE: { // Warrior+ (1750+)
        TOTAL: 30000,   // 30s (same — user-specified)
        WARNING: null,  // No yellow state
        DANGER: 25000,  // At 25s elapsed (5s left) - Red
    }
};

const MAX_TIMEOUTS = {
    CASUAL: 4,
    COMPETITIVE: 3
};

export const whotGameLoop = {
    /**
     * Start/Reset match in memory
     */
    initializeMatch: async (gameId, player1, player2, config) => {
        const state = whotGameEngine.initializeGame(gameId, player1, player2, config);
        
        state.status = 'WAITING_FOR_PLAYERS';
        state.turnStartTime = null;
        state.timerStart = null;
        state.warningYellowAt = null;
        state.warningRedAt = null;

        const gameEntry = {
            state,
            timers: {},
            lock: Promise.resolve(),
            isLocked: false,
            timeoutId: null,
            readyStatus: { [player1.id]: false, [player2.id]: false },
            isStarted: false,
            startTimeoutId: setTimeout(() => whotGameLoop.cancelMatchIfUnready(gameId), 15000)
        };

        activeWhotGames.set(gameId, gameEntry);

        const minimalState = { ...state };
        delete minimalState.processedMoves;

        await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

        // Initial Event Sequence Reset (Atomic)
        await redis.set(`game:${gameId}:eventId`, 0);
        await redis.set(`game:${gameId}:stateVersion`, 0);

        // Broadcast Initial Deal (Unified + Scrubbed)
        await broadcastScrubbedEvent(gameId, 'GAME_STATE_UPDATE', state);

        return state;
    },

    /**
     * Get Match State (Authoritative)
     */
    getMatchState: async (gameId) => {
        let entry = activeWhotGames.get(gameId);
        if (!entry) {
            const cached = await redis.get(`match:${gameId}`);
            if (cached) {
                const parsed = JSON.parse(cached);
                parsed.processedMoves = parsed.processedMoves || [];
                entry = {
                    state: parsed,
                    timers: {},
                    lock: Promise.resolve(),
                    isLocked: false,
                    timeoutId: null,
                    readyStatus: {},
                    isStarted: parsed.status === 'IN_PROGRESS'
                };
                activeWhotGames.set(gameId, entry);
            }
        }
        return entry ? entry.state : null;
    },

    /**
     * Reconnect-Ready State Snapshot
     */
    getFullStateSnapshot: async (gameId, playerId) => {
        const state = await whotGameLoop.getMatchState(gameId);
        if (!state) return null;

        let remaining = 0;
        if (state.status === 'IN_PROGRESS' && state.turnStartTime) {
            remaining = Math.max(0, state.turnDuration - (Date.now() - state.turnStartTime));
        } else if (state.status === 'WAITING_FOR_PLAYERS') {
            remaining = state.turnDuration; // Return full duration if waiting
        }

        // If a player reconnects late, trigger timeout logic
        if (remaining === 0 && state.status === 'IN_PROGRESS') {
            await whotGameLoop.handleTurnTimeout(gameId, state.turnPlayer);
            const updatedState = await whotGameLoop.getMatchState(gameId);
            const scrubbed = whotGameEngine.scrubStateForClient(updatedState, playerId);
            return {
                ...scrubbed,
                remainingTime: updatedState.turnDuration,
                serverTime: Date.now()
            };
        }

        const scrubbed = whotGameEngine.scrubStateForClient(state, playerId);
        return {
            ...scrubbed,
            remainingTime: remaining,
            serverTime: Date.now()
        };
    },

    setPlayerReady: async (gameId, playerId) => {
        const entry = activeWhotGames.get(gameId);
        if (!entry || entry.isStarted) return;

        entry.readyStatus[playerId] = true;

        const allReady = Object.values(entry.readyStatus).every(v => v);
        if (allReady) {
            if (entry.startTimeoutId) clearTimeout(entry.startTimeoutId);
            entry.isStarted = true;
            
            const state = entry.state;
            state.status = 'IN_PROGRESS';
            
            // Start game buffer: 2 seconds delay
            const bufferMs = 2000;
            const startTime = Date.now() + bufferMs;
            
            state.turnStartTime = startTime;
            state.turnEndTime = startTime + state.turnDuration;
            state.timerStart = startTime;
            state.warningYellowAt = null;
            state.warningRedAt = state.turnEndTime - 5000; // Red at 5s remaining

            const minimalState = { ...state };
            delete minimalState.processedMoves;
            await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

            await broadcastScrubbedEvent(gameId, 'GAME_STATE_UPDATE', state);
            
            await broadcastGameEvent(gameId, 'GAME_START', {
                startTime,
                turnEndTime: state.turnEndTime,
                warningRedAt: state.warningRedAt,
                turnDuration: state.turnDuration
            }, { isStateChange: false });

            // Start backend timer with buffer
            entry.timeoutId = setTimeout(() => {
                whotGameLoop.handleTurnTimeout(gameId, state.turnPlayer);
            }, state.turnDuration + bufferMs);
        }
    },

    cancelMatchIfUnready: async (gameId) => {
        const entry = activeWhotGames.get(gameId);
        if (!entry || entry.isStarted) return;

        console.log(`[WhotLoop] Match ${gameId} cancelled because players weren't ready in time`);
        
        entry.state.status = 'CANCELLED';
        await redis.set(`match:${gameId}`, JSON.stringify(entry.state));
        
        await broadcastGameEvent(gameId, 'MATCH_CANCELLED', {
            reason: 'Players did not connect in time'
        }, { isStateChange: false });

        // Update Prisma DB to mark game as cancelled
        try {
            await prisma.game.update({
                where: { id: gameId },
                data: { status: 'CANCELLED' }
            });
        } catch(e) {
            console.error(`[WhotLoop] Failed to cancel game in DB: ${e.message}`);
        }

        activeWhotGames.delete(gameId);
    },

    /**
     * Atomic Move Execution
     */
    executeMove: async (gameId, playerId, move) => {
        const entry = activeWhotGames.get(gameId);
        if (!entry) throw new Error("Match not found in memory");

        const currentExecution = entry.lock.then(async () => {
            entry.isLocked = true;
            try {
                const state = entry.state;

                if (Date.now() > state.turnStartTime + state.turnDuration) {
                    throw new Error("Move rejected: Time limit exceeded");
                }

                const validation = whotGameEngine.validateMove(state, playerId, move);
                if (!validation.valid) throw new Error(validation.reason);

                // Prevent executing the exact same move multiple times from clients
                const actionKey = `${playerId}:${move.timestamp}`;
                if (state.lastProcessedActionId === actionKey) {
                    console.log(`[WhotLoop] Ignored duplicate move action ${actionKey}`);
                    return state;
                }

                const nextState = whotGameEngine.applyMove(state, playerId, move);
                
                // Track backend sequence
                nextState.lastProcessedActionId = actionKey;
                nextState.stateVersion = (state.stateVersion || 0) + 1;
                nextState.eventId = randomUUID(); // ID for state update broadcast

                // ATOMIC TIMER RESET — absolute timestamps for perfect sync
                nextState.turnStartTime = Date.now();
                nextState.turnEndTime = nextState.turnStartTime + nextState.turnDuration;
                nextState.warningYellowAt = null; // No yellow state
                nextState.warningRedAt = nextState.turnEndTime - 5000; // Red at 5s remaining

                // Determine action type and played card for broadcasts
                let actionType = 'UNKNOWN';
                if (move.type === 'PLAY_CARD') actionType = 'CARD_PLAYED';
                else if (move.type === 'DRAW') actionType = 'PICK_CARD';
                else if (move.type === 'CALL_SUIT') actionType = 'CALL_SUIT';

                const playedCard = move.type === 'PLAY_CARD'
                    ? nextState.discardPile[nextState.discardPile.length - 1]
                    : null;

                nextState.lastAction = {
                    type: actionType,
                    playerId,
                    cardId: move.cardId,
                    card: playedCard,
                    suitChoice: move.calledSuit || move.suit
                };

                entry.state = nextState;
                const minimalState = { ...nextState };
                delete minimalState.processedMoves;
                await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

                // 1. Success Broadcast (Unified) — with proper eventId for dedup
                await broadcastGameEvent(gameId, 'MOVE_CONFIRMED', { 
                    eventId: randomUUID(),
                    moveId: move.moveId, 
                    playerId 
                }, { isStateChange: false });

                // 2. Opponent Move — targeted to opponent only (skip sender socket)
                await broadcastGameEventExcluding(gameId, 'OPPONENT_MOVE', {
                    eventId: randomUUID(),
                    type: actionType,
                    cardId: move.cardId,
                    card: playedCard,
                    suitChoice: move.calledSuit || move.suit
                }, playerId);

                // 3. Sync Scrubbed State
                await broadcastScrubbedEvent(gameId, 'GAME_STATE_UPDATE', nextState);

                if (nextState.status === 'COMPLETED') {
                    await whotGameLoop.handleWin(gameId, nextState.winnerId, nextState);
                } else {
                    whotGameLoop.startTurnTimer(gameId, nextState.turnPlayer);
                }

                return nextState;
            } catch (err) {
                console.error(`[WhotLoop] Move error: ${err.message}`);
                // Emit rejection to the specific player so their UI can reset and show a toast
                await broadcastGameEvent(gameId, 'MOVE_REJECTED', {
                    playerId,
                    reason: err.message
                }, { isStateChange: false });
                throw err;
            } finally {
                entry.isLocked = false;
            }
        });

        entry.lock = currentExecution.catch((err) => {
            console.error(`[WhotLoop] Critical Lock Error in executeMove for ${gameId}:`, err);
            entry.isLocked = false;
        });
        return currentExecution;
    },

    startTurnTimer: async (gameId, currentPlayerId) => {
        const entry = activeWhotGames.get(gameId);
        if (!entry) return;

        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = null;
        }

        if (entry.state.status !== 'COMPLETED') {
            entry.timeoutId = setTimeout(() => {
                whotGameLoop.handleTurnTimeout(gameId, currentPlayerId);
            }, entry.state.turnDuration);
        }

        await broadcastGameEvent(gameId, 'TURN_STARTED', {
            eventId: randomUUID(),
            whoseTurn: currentPlayerId,
            timeLimit: entry.state.turnDuration,
            turnEndTime: entry.state.turnEndTime,
            warningRedAt: entry.state.warningRedAt
        }, { isStateChange: false });
    },

    clearTurnTimer: (gameId) => {
        const entry = activeWhotGames.get(gameId);
        if (entry?.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = null;
        }
    },

    handleTurnTimeout: async (gameId, playerId) => {
        const entry = activeWhotGames.get(gameId);
        if (!entry) return;

        const currentExecution = entry.lock.then(async () => {
            entry.isLocked = true;
            try {
                const state = entry.state;
                if (state.turnPlayer !== playerId || state.status === 'COMPLETED') return;

                const nextState = whotGameEngine.handleTurnTimeout(state);
                const now = Date.now();
                const duration = nextState.turnDuration || state.turnDuration || 30000;
                nextState.turnStartTime = now;
                nextState.turnEndTime = now + duration;
                nextState.warningYellowAt = null;
                nextState.warningRedAt = nextState.turnEndTime - 5000;
                nextState.stateVersion = (state.stateVersion || 0) + 1;
                nextState.eventId = randomUUID();

                // BUG FIX: End game if max timeouts exceeded
                const timeoutLimit = nextState.rankType === 'warrior' ? 3 : 5;
                if (nextState.timeoutCount[playerId] >= timeoutLimit) {
                    await whotGameLoop.handleForfeit(gameId, playerId);
                    // Critical: Resolve the lock and exit, don't broadcast the auto-play move
                    return;
                }

                const actionTypeTimeout = nextState.discardPile.length > state.discardPile.length ? 'CARD_PLAYED' : 'PICK_CARD';
                const playedCardTimeout = actionTypeTimeout === 'CARD_PLAYED' ? nextState.discardPile[nextState.discardPile.length - 1] : null;

                nextState.lastAction = {
                    type: actionTypeTimeout,
                    playerId,
                    cardId: playedCardTimeout ? playedCardTimeout.id : null,
                    card: playedCardTimeout,
                    suitChoice: playedCardTimeout && playedCardTimeout.number === 20 ? 'circle' : undefined
                };

                entry.state = nextState;
                const minimalState = { ...nextState };
                delete minimalState.processedMoves;
                await redis.set(`match:${gameId}`, JSON.stringify(minimalState));

                // 1. Success Broadcast
                await broadcastGameEvent(gameId, 'MOVE_CONFIRMED', { 
                    eventId: randomUUID(),
                    moveId: 'auto', 
                    playerId 
                }, { isStateChange: false });

                // 2. Opponent Move Logic
                const newPileLen = nextState.discardPile.length;
                const oldPileLen = state.discardPile.length;

                if (newPileLen > oldPileLen) {
                    const playedCard = nextState.discardPile[newPileLen - 1];
                    await broadcastGameEventExcluding(gameId, 'OPPONENT_MOVE', {
                        eventId: randomUUID(),
                        type: 'CARD_PLAYED',
                        cardId: playedCard.id,
                        suitChoice: playedCard.number === 20 ? 'circle' : undefined
                    }, playerId);
                } else {
                    await broadcastGameEventExcluding(gameId, 'OPPONENT_MOVE', {
                        eventId: randomUUID(),
                        type: 'PICK_CARD'
                    }, playerId);
                }

                // 3. Sync State
                await broadcastScrubbedEvent(gameId, 'GAME_STATE_UPDATE', nextState);

                if (nextState.status === 'COMPLETED') {
                    await whotGameLoop.handleWin(gameId, nextState.winnerId, nextState);
                } else {
                    const maxTimeouts = state.rankType === 'warrior' ? 3 : 4;
                    if (nextState.timeoutCount[playerId] >= maxTimeouts) {
                        await whotGameLoop.handleForfeit(gameId, playerId, 'TIMEOUT');
                    } else {
                        whotGameLoop.startTurnTimer(gameId, nextState.turnPlayer);
                    }
                }
            } catch (err) {
                console.error(`[WhotLoop] Timeout error: ${err.message}`);
            } finally {
                entry.isLocked = false;
            }
        });

        entry.lock = currentExecution.catch((err) => {
            console.error(`[WhotLoop] Critical Lock Error in handleTurnTimeout for ${gameId}:`, err);
            entry.isLocked = false;
        });
    },

    handleWin: async (gameId, winnerId, board) => {
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (game && winnerId) {
            const loserId = game.player1Id === winnerId ? game.player2Id : game.player1Id;
            await processMatchRewards(winnerId, loserId, gameId, 'whot');
        }

        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'COMPLETED',
                winnerId: winnerId,
                endedAt: new Date(),
                board: board
            }
        });

        await broadcastGameEvent(gameId, 'GAME_ENDED', { winnerId }, { isStateChange: false });

        chatRepository.persistMatchChat(gameId);
        whotGameLoop.clearTurnTimer(gameId);
        activeWhotGames.delete(gameId);
        await redis.del(`match:${gameId}`);
    },

    handleForfeit: async (gameId, losingPlayerId, reasonCode = 'TIMEOUT') => {
        const entry = activeWhotGames.get(gameId);
        const state = entry ? entry.state : null;
        let winnerId = state ? state.players.find(id => id !== losingPlayerId) : null;

        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!winnerId && game) {
            winnerId = game.player1Id === losingPlayerId ? game.player2Id : game.player1Id;
        }

        if (winnerId && game) {
            await processMatchRewards(winnerId, losingPlayerId, gameId, 'whot');
        }

        await prisma.game.update({
            where: { id: gameId },
            data: { status: 'COMPLETED', winnerId, endedAt: new Date() }
        });

        await broadcastGameEvent(gameId, 'GAME_FORFEIT', {
            winnerId,
            loserId: losingPlayerId,
            reasonCode: reasonCode,
            message: reasonCode === 'TIMEOUT' ? "Opponent timed out too many times." : "Player forfeited the match."
        }, { isStateChange: false });

        chatRepository.persistMatchChat(gameId);
        whotGameLoop.clearTurnTimer(gameId);
        activeWhotGames.delete(gameId);
        await redis.del(`match:${gameId}`);
    },

    /**
     * Server Restart Recovery: Re-load active matches into memory
     */
    recoverMatches: async () => {
        try {
            console.log('[WhotLoop] Searching for active Whot matches to recover...');
            const activeMatches = await prisma.game.findMany({
                where: {
                    gameType: 'whot',
                    status: 'IN_PROGRESS'
                }
            });

            console.log(`[WhotLoop] Found ${activeMatches.length} matches to recover.`);

            for (const match of activeMatches) {
                try {
                    const state = typeof match.board === 'string' ? JSON.parse(match.board) : match.board;
                    if (!state) continue;

                    activeWhotGames.set(match.id, {
                        state,
                        timers: {},
                        lock: Promise.resolve(),
                        isLocked: false,
                        timeoutId: null
                    });

                    // Resume timer
                    whotGameLoop.startTurnTimer(match.id, state.turnPlayer);
                    console.log(`[WhotLoop] Recovered match: ${match.id}`);
                } catch (err) {
                    console.error(`[WhotLoop] Failed to recover individual match ${match.id}: ${err.message}`);
                }
            }
        } catch (error) {
            console.error('[WhotLoop] Match recovery error:', error);
        }
    }
};
