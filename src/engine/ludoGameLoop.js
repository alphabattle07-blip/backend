
import { broadcastGameEvent } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { ludoGameEngine } from './ludoGameEngine.js';
import { processMatchRewards } from '../utils/gameUtils.js';
import redis from '../utils/redis.js';
import { chatRepository } from '../chat/chatRepository.js';

const prisma = new PrismaClient();

// In-memory storage for active game loops/timers
// Key: gameId, Value: { timer: NodeJS.Timeout, startTime: number, warningTimer: NodeJS.Timeout, etc. }
const activeLudoGames = new Map();
const saveTimeouts = new Map();

function scheduleDebouncedSave(gameId, gameState, force = false) {
    if (saveTimeouts.has(gameId)) {
        clearTimeout(saveTimeouts.get(gameId));
        saveTimeouts.delete(gameId);
    }

    const saveAction = async () => {
        try {
            await prisma.game.update({
                where: { id: gameId },
                data: { board: gameState },
            });
        } catch (err) {
            console.error(`[LudoLoop] Failed to save state for ${gameId}:`, err.message);
        } finally {
            saveTimeouts.delete(gameId);
        }
    };

    if (force) {
        // Run immediately without timeout
        saveAction();
    } else {
        const timeout = setTimeout(saveAction, 2000); // 2 seconds of inactivity
        saveTimeouts.set(gameId, timeout);
    }
}

const TIME_LIMITS = {
    RULE_ONE: { // Competitive level
        TOTAL: 15000, // 15s total per phase (Roll phase / Move phase)
        RED: 10000, // Warning state starts at 5s remaining (10s elapsed)
        FORFEIT: 3 // Game over after 3 timeouts
    },
    RULE_TWO: { // Standard level
        TOTAL: 15000,
        RED: 10000,
        FORFEIT: 5 // Game over after 5 timeouts
    }
};

// Central Ticker - REMOVED for event-driven architecture
// No more global loop iterating over all games.

export const ludoGameLoop = {
    /**
     * Start/Reset turn timer
     * @param {string} gameId
     * @param {string|null} currentPlayerUserId 
     * @param {object} options Optional settings e.g. { initialBuffer: Number }
     */
    startTurnTimer: async (gameId, currentPlayerUserId, options = {}) => {
        // Fetch or create entry
        let entry = activeLudoGames.get(gameId);
        if (!entry) {
            // First check Redis for active state
            const cached = await redis.get(`match:ludo:${gameId}`);
            let gameState = null;
            let p1Id = null;
            let p2Id = null;

            const game = await prisma.game.findUnique({ where: { id: gameId } });
            if (!game) return;
            p1Id = game.player1Id;
            p2Id = game.player2Id;

            if (cached) {
                gameState = JSON.parse(cached);
            } else {
                gameState = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;
                // Save to Redis asynchronously
                redis.set(`match:ludo:${gameId}`, JSON.stringify(gameState)).catch(err => console.error("❌ Redis save failed", err));
            }

            entry = {
                state: gameState,
                lock: Promise.resolve(),
                isLocked: false,
                autoRolled: false,
                timeoutId: null,
                player1Id: p1Id,
                player2Id: p2Id,
                eventTracker: []
            };
            activeLudoGames.set(gameId, entry);
        }

        const board = entry.state;
        const limits = board.level >= 3 ? TIME_LIMITS.RULE_ONE : TIME_LIMITS.RULE_TWO;
        const startBuffer = options.initialBuffer || 0;

        board.turnStartTime = Date.now() + startBuffer;
        board.turnDuration = limits.TOTAL;
        board.redAt = board.turnStartTime + limits.RED;
        entry.autoRolled = false;

        // Reset any existing timer
        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = null;
        }

        // Schedule next timeout (only if game is not over)
        if (!board.winner && board.status !== 'COMPLETED') {
            const timeToTimeout = board.turnDuration + startBuffer;
            console.log(`[LudoLoop] Scheduling timeout for ${gameId} in ${timeToTimeout}ms`);
            entry.timeoutId = setTimeout(() => {
                ludoGameLoop.handleTurnTimeout(gameId, board.players[board.currentPlayerIndex].id);
            }, timeToTimeout);
        }

        // MUST sync new timestamps to Redis async
        redis.set(`match:ludo:${gameId}`, JSON.stringify(board)).catch(err => console.error("❌ Redis save failed", err));

        // Broadcast to clients using unified event
        await broadcastGameEvent(gameId, 'TURN_STARTED', {
            whoseTurn: board.players[board.currentPlayerIndex].id,
            timeLimit: limits.TOTAL,
            turnStartTime: board.turnStartTime,
            redAt: board.redAt,
            stateVersion: board.stateVersion,
            eventId: board.eventId
        }, { isStateChange: true }); // Pass engine versions
    },

    clearTurnTimer: (gameId) => {
        const entry = activeLudoGames.get(gameId);
        if (entry?.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = null;
        }
    },

    handleTurnTimeout: async (gameId, playerId) => {
        const entry = activeLudoGames.get(gameId);
        if (!entry) return;

        const board = entry.state;
        if (!board || board.winner || board.status === 'COMPLETED') return;

        console.log(`[LudoLoop] Turn timeout triggered for game ${gameId}, player ${board.currentPlayerIndex}`);

        try {
            let actionType;
            let bestMove = undefined;

            if (board.waitingForRoll) {
                actionType = 'ROLL_DICE';
            } else {
                const validMoves = ludoGameEngine.getValidMoves(board);
                if (validMoves.length > 0) {
                    actionType = 'MOVE_PIECE';
                    bestMove = validMoves[0];
                } else {
                    actionType = 'PASS_TURN';
                }
            }

            // Simulate the action cleanly through the pipeline
            await ludoGameLoop.executeAction(gameId, null, {
                type: actionType,
                move: bestMove,
                expectedStateVersion: board.stateVersion,
                isTimeoutAutoPlay: true
            });
        } catch (err) {
            console.error(`[LudoLoop] Timeout handler error for ${gameId}:`, err);
        }
    },

    handleForfeit: async (gameId, losingLogicalId, reason = 'forfeit') => {
        console.log(`[LudoLoop] Forfeit ${losingLogicalId} in game ${gameId} (reason: ${reason})`);
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!game) return;

        const winnerId = losingLogicalId === 'p1' ? game.player2Id : game.player1Id;
        const loserId = losingLogicalId === 'p1' ? game.player1Id : game.player2Id;

        // --- PROCESS REWARDS ---
        await processMatchRewards(winnerId, loserId, gameId, 'ludo');

        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'COMPLETED',
                winnerId: winnerId,
                endedAt: new Date()
            }
        });

        await broadcastGameEvent(gameId, 'GAME_ENDED', { winnerId, reason });

        // --- ARCHIVE CHAT ---
        chatRepository.persistMatchChat(gameId);

        ludoGameLoop.clearTurnTimer(gameId);
        activeLudoGames.delete(gameId);
        await redis.del(`match:ludo:${gameId}`);
    },

    /**
     * Executes a player action (intent) securely on the server
     */
    executeAction: async (gameId, userId, action) => {
        const entry = activeLudoGames.get(gameId);
        if (!entry) throw new Error("Game not found in memory");

        return entry.lock = entry.lock.then(async () => {
            entry.isLocked = true;
            try {
                const board = entry.state;
                // 🌊 Flood Detection
                const now = Date.now();
                if (!entry.eventTracker) entry.eventTracker = [];
                entry.eventTracker = entry.eventTracker.filter(t => now - t < 1000);
                entry.eventTracker.push(now);
                if (entry.eventTracker.length > 10) {
                    console.warn(`🌊 Event flood detected from ${userId} in ${gameId}`);
                }

                // 🧠 Memory Authority replacing Prisma I/O
                const isPlayer1 = userId === null ? (action.isTimeoutAutoPlay ? board.currentPlayerIndex === 0 : true) : (() => {
                    if (userId === entry.player1Id || userId === 'p1') return true;
                    if (userId === entry.player2Id || userId === 'p2') return false;
                    return null;
                })();

                if (isPlayer1 === null && userId !== null) {
                    console.log(`[LudoLoop] Rejected action: Socket session ${userId} not a participant in ${gameId}`);
                    return;
                }
                const logicalPlayerId = isPlayer1 ? 'p1' : 'p2';

                // Turn Authentication
                const actualLogicalPlayerId = board.players[board.currentPlayerIndex].id;
                
                // Inactivity Tracker / Rage Quit Protocol
                let shouldForfeit = false;
                if (userId !== null) {
                    // Reset timeouts on real player input
                    if (board.players[board.currentPlayerIndex]) {
                        board.players[board.currentPlayerIndex].timeouts = 0;
                    }
                } else if (action.isTimeoutAutoPlay) {
                    const currentP = board.players[board.currentPlayerIndex];
                    currentP.timeouts = (currentP.timeouts || 0) + 1;
                    
                    // Warrior+ (level >= 3) = 6 turns (12 timeouts). Below = 8 turns (16 timeouts).
                    const threshold = (board.level || 1) >= 3 ? 12 : 16;
                    if (currentP.timeouts >= threshold) {
                        shouldForfeit = true;
                    }
                }

                if (shouldForfeit) {
                    console.log(`[LudoLoop] Player ${actualLogicalPlayerId} exceeded timeouts. Auto-forfeiting.`);
                    await ludoGameLoop.handleForfeit(gameId, actualLogicalPlayerId, 'rage_quit');
                    return;
                }

                if (logicalPlayerId !== actualLogicalPlayerId && userId !== null) {
                    console.log(`[LudoLoop] Turn violation: User ${userId} tried to play but it is ${actualLogicalPlayerId}'s turn.`);
                    return;
                }

                // Server-Side Version Validation (Stop Spam/Desyncs)
                if (action.expectedStateVersion !== undefined && board.stateVersion !== undefined) {
                    if (action.expectedStateVersion !== board.stateVersion) {
                        console.log(`[LudoLoop] Rejected action due to version mismatch: expected ${action.expectedStateVersion}, actual ${board.stateVersion}`);
                        return;
                    }
                }

                // Increase timeout only physically during the autoPlay routine
                if (action.isTimeoutAutoPlay) {
                    board.players[board.currentPlayerIndex].timeouts = (board.players[board.currentPlayerIndex].timeouts || 0) + 1;
                }

                // ... (Engine execution logic here ...)
                let updatedBoard = { ...board };
                if (action.type === 'ROLL_DICE') {
                    if (!board.waitingForRoll) {
                        console.log(`[LudoLoop] Ignored ROLL_DICE: Not waiting for roll.`);
                        return;
                    }

                    // Step 1: Tell everyone the player STARTED rolling (visual cue for opponent)
                    // We broadcast this immediately, but we no longer wait 400ms.
                    // The client will still show a brief animation while the 'ROLL_DICE' event 
                    // travels back, but the user gets the result as fast as their ping permits.
                    broadcastGameEvent(gameId, 'DICE_ROLLING_STARTED', {
                        rollingPlayerIndex: isPlayer1 ? 0 : 1,
                        eventId: board.eventId // Inherit last known engine eventId for cosmetic event
                    });

                    // Step 2: COMPUTE authoritative result instantly via Pre-Generated roll
                    updatedBoard = ludoGameEngine.rollDice(updatedBoard);
                } else if (action.type === 'MOVE_PIECE') {
                    if (board.waitingForRoll) {
                        console.log(`[LudoLoop] Ignored MOVE_PIECE: Must roll first.`);
                        return;
                    }

                    const validMoves = ludoGameEngine.getValidMoves(board);
                    const isValid = validMoves.some(m =>
                        m.seedIndex === action.move.seedIndex &&
                        m.targetPos === action.move.targetPos
                    );
                    if (!isValid) {
                        console.log(`[LudoLoop] Ignored MOVE_PIECE: Invalid or duplicate move used.`);
                        return;
                    }

                    updatedBoard = ludoGameEngine.applyMove(updatedBoard, action.move);
                } else if (action.type === 'PASS_TURN') {
                    const validMoves = ludoGameEngine.getValidMoves(board);
                    if (validMoves.length > 0) {
                        console.log(`[LudoLoop] Ignored PASS_TURN: Player has valid moves available.`);
                        return;
                    }
                    updatedBoard = ludoGameEngine.passTurn(updatedBoard);
                }

                // Update state
                // NOTE: DO NOT manually increment stateVersion here — the engine (rollDice/applyMove/passTurn)
                // already bumps it. The Redis atomic counter in broadcastGameEvent tracks the broadcast
                // sequence (eventId) separately. Double-incrementing caused the client's version check to fail.
                if (action.moveId) updatedBoard.players[isPlayer1 ? 0 : 1].lastProcessedMoveId = action.moveId;

                // --- CHECK FOR WINNER ---
                if (updatedBoard.winner) {
                    const winnerLogicalId = updatedBoard.winner; 
                    const winnerId = winnerLogicalId === 'p1' ? entry.player1Id : entry.player2Id;
                    const loserId = winnerLogicalId === 'p1' ? entry.player2Id : entry.player1Id;

                    await processMatchRewards(winnerId, loserId, gameId, 'ludo');

                    await prisma.game.update({
                        where: { id: gameId },
                        data: {
                            status: 'COMPLETED',
                            winnerId: winnerId,
                            endedAt: new Date(),
                            board: updatedBoard
                        }
                    });

                    await broadcastGameEvent(gameId, 'GAME_ENDED', { winnerId });

                    // --- ARCHIVE CHAT ---
                    chatRepository.persistMatchChat(gameId);

                    ludoGameLoop.clearTurnTimer(gameId);
                    activeLudoGames.delete(gameId);
                    redis.del(`match:ludo:${gameId}`).catch(err => console.error("❌ Redis del failed", err));
                    return;
                }

                // ⚡ Rapid Memory Commit & Broadcast (DB Decoupled)
                entry.state = updatedBoard;
                redis.set(`match:ludo:${gameId}`, JSON.stringify(updatedBoard)).catch(err => console.error("❌ Redis save failed", err));
                scheduleDebouncedSave(gameId, updatedBoard);

                // Unified Event for Action Update (Roll/Move)
                // Sending EXACT structured prediction keys to aid front-end mapping.
                await broadcastGameEvent(gameId, 'LUDO_ACTION_UPDATE', {
                    type: action.type,                              
                    
                    // Unified safe payload metrics
                    playerId: isPlayer1 ? entry.player1Id : entry.player2Id,
                    pieceId: action.type === 'MOVE_PIECE' && action.move ? action.move.seedIndex : undefined,
                    fromTile: action.type === 'MOVE_PIECE' && action.move ? board.players[board.currentPlayerIndex].seeds[action.move.seedIndex]?.tileIndex : undefined,
                    toTile: action.type === 'MOVE_PIECE' && action.move ? action.move.targetPos : undefined,
                    diceValue: action.type === 'ROLL_DICE' ? updatedBoard.dice : (action.type === 'MOVE_PIECE' ? action.move.diceIndices.map(h => board.dice[h]) : undefined),
                    stateVersion: updatedBoard.stateVersion,        

                    // Classic structured parameters preserving frontend expectations
                    move: action.type === 'MOVE_PIECE' ? action.move : undefined,
                    dice: action.type === 'ROLL_DICE' ? updatedBoard.dice : undefined,
                    diceUsed: updatedBoard.diceUsed, // Always send — client overwrites unconditionally
                    currentPlayerIndex: updatedBoard.currentPlayerIndex,
                    waitingForRoll: updatedBoard.waitingForRoll,
                    lastProcessedMoveId: action.moveId,
                    actionPlayerIndex: isPlayer1 ? 0 : 1,
                    actionSeedIndex: action.type === 'MOVE_PIECE' && action.move ? action.move.seedIndex : undefined,
                }, { isStateChange: true });

                // Restart timer if:
                // 1. The turn explicitly passed to another player
                // 2. The player earned a bonus roll (isBonusTurn)
                // 3. The player completed the ROLL_DICE action and is now transitioning to the move phase
                const turnChanged = board.currentPlayerIndex !== updatedBoard.currentPlayerIndex;
                const isBonusTurn = !board.waitingForRoll && updatedBoard.waitingForRoll && !turnChanged;
                const phaseChangedToMove = board.waitingForRoll && !updatedBoard.waitingForRoll;

                if (turnChanged || isBonusTurn || phaseChangedToMove) {
                    await ludoGameLoop.startTurnTimer(gameId, null);
                }

            } catch (err) {
                console.error(`[LudoLoop] Action error: ${err.message}`);
                throw err;
            } finally {
                entry.isLocked = false;
            }
        }).catch((err) => {
            console.error(`[LudoLoop] Critical Lock Error in executeAction for ${gameId}:`, err);
            entry.isLocked = false; // Emergency unlock
            throw err;
        });
    },

    /**
     * Reconnect support: returns the full state plus remaining time
     */
    getFullStateSnapshot: async (gameId, userId) => {
        let entry = activeLudoGames.get(gameId);
        if (!entry) {
            // Check Redis first
            const cached = await redis.get(`match:ludo:${gameId}`);
            let gameState = null;
            let p1Id = null;
            let p2Id = null;

            const game = await prisma.game.findUnique({ where: { id: gameId } });
            if (!game || game.status !== 'IN_PROGRESS') return null;
            p1Id = game.player1Id;
            p2Id = game.player2Id;

            if (cached) {
                gameState = JSON.parse(cached);
            } else {
                gameState = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;
                // Save to Redis async
                redis.set(`match:ludo:${gameId}`, JSON.stringify(gameState)).catch(err => console.error("❌ Redis save failed", err));
            }

            entry = {
                state: gameState,
                lock: Promise.resolve(),
                isLocked: false,
                autoRolled: false,
                timeoutId: null,
                player1Id: p1Id,
                player2Id: p2Id,
                eventTracker: []
            };
            activeLudoGames.set(gameId, entry);
        }

        const board = entry.state;
        const elapsed = Date.now() - board.turnStartTime;
        const remaining = Math.max(0, board.turnDuration - elapsed);

        return {
            ...board,
            remainingTime: remaining,
            serverTime: Date.now()
        };
    },

    /**
     * Server Restart Recovery: Re-load active Ludo matches into memory
     */
    recoverMatches: async () => {
        try {
            console.log('[LudoLoop] Searching for active Ludo matches to recover...');
            const activeMatches = await prisma.game.findMany({
                where: {
                    gameType: 'ludo',
                    status: 'IN_PROGRESS'
                }
            });

            console.log(`[LudoLoop] Found ${activeMatches.length} Ludo matches to recover.`);

            for (const match of activeMatches) {
                try {
                    const board = typeof match.board === 'string' ? JSON.parse(match.board) : match.board;
                    if (!board) continue;

                    activeLudoGames.set(match.id, {
                        state: board,
                        lock: Promise.resolve(),
                        isLocked: false,
                        autoRolled: false,
                        timeoutId: null,
                        player1Id: match.player1Id,
                        player2Id: match.player2Id,
                        eventTracker: []
                    });

                    // Resume timer
                    await ludoGameLoop.startTurnTimer(match.id, null);
                    console.log(`[LudoLoop] Recovered match: ${match.id}`);
                } catch (err) {
                    console.error(`[LudoLoop] Failed to recover individual match ${match.id}: ${err.message}`);
                }
            }
        } catch (error) {
            console.error('[LudoLoop] Ludo match recovery error:', error);
        }
    }
};

