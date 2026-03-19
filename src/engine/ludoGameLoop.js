
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

            if (cached) {
                gameState = JSON.parse(cached);
            } else {
                // Fallback to Prisma if not in Redis
                const game = await prisma.game.findUnique({ where: { id: gameId } });
                if (!game) return;
                gameState = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;
                // Save to Redis
                await redis.set(`match:ludo:${gameId}`, JSON.stringify(gameState));
            }

            entry = {
                state: gameState,
                lock: Promise.resolve(),
                isLocked: false,
                autoRolled: false,
                timeoutId: null
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

        // MUST sync new timestamps to Redis immediately
        await redis.set(`match:ludo:${gameId}`, JSON.stringify(board));

        // Broadcast to clients using unified event
        await broadcastGameEvent(gameId, 'TURN_STARTED', {
            whoseTurn: board.players[board.currentPlayerIndex].id,
            timeLimit: limits.TOTAL,
            turnStartTime: board.turnStartTime,
            redAt: board.redAt
        }, { isStateChange: true }); // Atomic stateVersion increment
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

        // Queue timeout processing on the action lock to prevent collisions with player moves
        entry.lock = entry.lock.then(async () => {
            entry.isLocked = true;
            try {
                const board = entry.state;
                if (!board || board.winner || board.status === 'COMPLETED') return;

                console.log(`[LudoLoop] Turn timeout triggered for game ${gameId}, player ${board.currentPlayerIndex}`);

                // 1. Authoritative Auto-Play via Engine
                const nextBoard = ludoGameEngine.handleTurnTimeout(board);

                // 2. Check Forfeit
                const timedOutPlayerIndex = board.currentPlayerIndex;
                const timedOutPlayer = nextBoard.players[timedOutPlayerIndex];
                const limits = board.level >= 3 ? TIME_LIMITS.RULE_ONE : TIME_LIMITS.RULE_TWO;

                if (timedOutPlayer.timeouts >= limits.FORFEIT) {
                    await ludoGameLoop.handleForfeit(gameId, timedOutPlayer.id);
                    return;
                }

                // 3. Save & Broadcast
                entry.state = nextBoard;
                await redis.set(`match:ludo:${gameId}`, JSON.stringify(nextBoard));

                // Unified Event
                await broadcastGameEvent(gameId, 'GAME_STATE_UPDATE', 
                    ludoGameEngine.scrubStateForClient(nextBoard), 
                    { isStateChange: true }
                );

                // Refresh timer for next phase
                await ludoGameLoop.startTurnTimer(gameId, null);

            } catch (err) {
                console.error(`[LudoLoop] Timeout handler error: ${err.message}`);
            } finally {
                entry.isLocked = false;
            }
        }).catch((err) => {
            console.error(`[LudoLoop] Critical Lock Error in handleTurnTimeout for ${gameId}:`, err);
            entry.isLocked = false; // Emergency unlock
        });
    },

    handleForfeit: async (gameId, losingLogicalId) => {
        console.log(`[LudoLoop] Forfeit ${losingLogicalId} in game ${gameId}`);
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

        await broadcastGameEvent(gameId, 'GAME_ENDED', { winnerId, reason: 'forfeit' }, { isStateChange: true });

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
                const isPlayer1 = userId === null ? true : await (async () => { // Handle auto-actions
                    if (userId === 'p1') return true;
                    if (userId === 'p2') return false;
                    const game = await prisma.game.findUnique({ where: { id: gameId } });
                    return game.player1Id === userId;
                })();
                const logicalPlayerId = isPlayer1 ? 'p1' : 'p2';

                // Turn Authentication
                const actualLogicalPlayerId = board.players[board.currentPlayerIndex].id;
                if (logicalPlayerId !== actualLogicalPlayerId && userId !== null) {
                    console.log(`[LudoLoop] Turn violation: User ${userId} tried to play but it is ${actualLogicalPlayerId}'s turn.`);
                    return;
                }

                // ... (Engine execution logic here ...)
                let updatedBoard = { ...board };
                if (action.type === 'ROLL_DICE') {
                    if (!board.waitingForRoll) {
                        console.log(`[LudoLoop] Ignored ROLL_DICE: Not waiting for roll.`);
                        return;
                    }

                    // Compute result FIRST (sync) so both events go out in the same tick
                    updatedBoard = ludoGameEngine.rollDice(updatedBoard);

                    // Fire DICE_ROLLING_STARTED without awaiting — opponent gets the visual cue
                    // and the result arrives almost simultaneously (<1 event-loop gap)
                    broadcastGameEvent(gameId, 'DICE_ROLLING_STARTED', {
                        rollingPlayerIndex: isPlayer1 ? 0 : 1
                    }); // intentional: no await
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
                if (action.moveId) updatedBoard.players[isPlayer1 ? 0 : 1].lastProcessedMoveId = action.moveId;
                updatedBoard.stateVersion = (updatedBoard.stateVersion || 0) + 1;

                // --- CHECK FOR WINNER ---
                const game = await prisma.game.findUnique({ where: { id: gameId } });
                if (updatedBoard.winner && game) {
                    const winnerLogicalId = updatedBoard.winner; // already a string: 'p1' or 'p2'
                    const winnerId = winnerLogicalId === 'p1' ? game.player1Id : game.player2Id;
                    const loserId = winnerLogicalId === 'p1' ? game.player2Id : game.player1Id;

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

                    await broadcastGameEvent(gameId, 'GAME_ENDED', { winnerId }, { isStateChange: true });

                    // --- ARCHIVE CHAT ---
                    chatRepository.persistMatchChat(gameId);

                    ludoGameLoop.clearTurnTimer(gameId);
                    activeLudoGames.delete(gameId);
                    await redis.del(`match:ludo:${gameId}`);
                    return;
                }

                entry.state = updatedBoard;
                await redis.set(`match:ludo:${gameId}`, JSON.stringify(updatedBoard));

                // Unified Event for Action Update (Roll/Move)
                await broadcastGameEvent(gameId, 'LUDO_ACTION_UPDATE', {
                    move: action.type === 'MOVE_PIECE' ? action.move : undefined,
                    dice: action.type === 'ROLL_DICE' ? updatedBoard.dice : undefined,
                    currentPlayerIndex: updatedBoard.currentPlayerIndex,
                    waitingForRoll: updatedBoard.waitingForRoll,
                    diceUsed: updatedBoard.diceUsed,
                    lastProcessedMoveId: action.moveId,
                    actionPlayerIndex: isPlayer1 ? 0 : 1
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

            if (cached) {
                gameState = JSON.parse(cached);
            } else {
                // Fallback to Prisma
                const game = await prisma.game.findUnique({ where: { id: gameId } });
                if (!game || game.status !== 'IN_PROGRESS') return null;
                gameState = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;
                // Save to Redis
                await redis.set(`match:ludo:${gameId}`, JSON.stringify(gameState));
            }

            entry = {
                state: gameState,
                lock: Promise.resolve(),
                isLocked: false,
                autoRolled: false
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


};

