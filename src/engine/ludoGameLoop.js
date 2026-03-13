
import { broadcastGameState } from '../socket/socketManager.js';
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
        TOTAL: 30000,
        YELLOW: 20000, // Align with red to skip yellow
        AUTO_ROLL: 10000, // Auto-roll if dice not thrown within 10s
        RED: 20000, // Warning state starts at 20s
        FORFEIT: 3 // Game over after 3 timeouts
    },
    RULE_TWO: { // Standard level
        TOTAL: 30000,
        YELLOW: 20000, // Align with red to skip yellow
        AUTO_ROLL: 10000, // Auto-roll if dice not thrown within 10s
        RED: 20000, // Warning state starts at 20s
        FORFEIT: 5 // Game over after 5 timeouts
    }
};

// Central Ticker
setInterval(async () => {
    for (const [gameId, entry] of activeLudoGames.entries()) {
        const board = entry.state;
        if (!board || board.winner || entry.isLocked) continue;



        const now = Date.now();
        const elapsed = now - board.turnStartTime;
        const limits = board.level >= 3 ? TIME_LIMITS.RULE_ONE : TIME_LIMITS.RULE_TWO;

        // 1. Check Auto-Roll (Only if waiting for roll and hasn't auto-rolled yet this turn)
        if (board.waitingForRoll && elapsed >= limits.AUTO_ROLL && !entry.autoRolled) {
            entry.autoRolled = true; // Mark to prevent repeated auto-rolls in the same turn
            console.log(`[LudoLoop] Auto-rolling for ${board.currentPlayerIndex} in game ${gameId}`);
            await ludoGameLoop.executeAction(gameId, board.players[board.currentPlayerIndex].id, { type: 'ROLL_DICE', auto: true });
        }

        // 2. Check Total Timeout (Auto-play)
        if (elapsed >= limits.TOTAL) {
            console.log(`[LudoLoop] Turn timeout for ${board.currentPlayerIndex} in game ${gameId}`);
            await ludoGameLoop.handleTurnTimeout(gameId, board.players[board.currentPlayerIndex].id);
        }
    }
}, 300);

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
                autoRolled: false
            };
            activeLudoGames.set(gameId, entry);
        }

        const board = entry.state;
        const limits = board.level >= 3 ? TIME_LIMITS.RULE_ONE : TIME_LIMITS.RULE_TWO;
        const startBuffer = options.initialBuffer || 0;

        board.turnStartTime = Date.now() + startBuffer;
        board.turnDuration = limits.TOTAL;
        board.yellowAt = board.turnStartTime + limits.YELLOW;
        board.redAt = board.turnStartTime + limits.RED;
        entry.autoRolled = false;

        // MUST sync new timestamps to Redis immediately
        await redis.set(`match:ludo:${gameId}`, JSON.stringify(board));

        // Broadcast to clients
        broadcastGameState(gameId, 'turnStarted', {
            whoseTurn: board.players[board.currentPlayerIndex].id,
            timeLimit: limits.TOTAL,
            turnStartTime: board.turnStartTime,
            yellowAt: board.yellowAt,
            redAt: board.redAt,
            serverTime: Date.now()
        });
    },

    clearTurnTimer: (gameId) => {
        // Central ticker handles cleanup via game winner or removal
    },

    handleTurnTimeout: async (gameId, playerId) => {
        const entry = activeLudoGames.get(gameId);
        if (!entry) return;

        entry.lock = entry.lock.then(async () => {
            entry.isLocked = true;
            try {
                const board = entry.state;
                if (board.winner || board.status === 'COMPLETED') return;

                // 1. Authoritative Auto-Play via Engine
                const nextBoard = ludoGameEngine.handleTurnTimeout(board);

                // 2. Check Forfeit
                const playerIndex = nextBoard.currentPlayerIndex; // The player who just timed out
                const player = nextBoard.players[playerIndex];
                const limits = nextBoard.level >= 3 ? TIME_LIMITS.RULE_ONE : TIME_LIMITS.RULE_TWO;

                if (player.timeouts >= limits.FORFEIT) {
                    await ludoGameLoop.handleForfeit(gameId, player.id);
                    return;
                }

                // 3. Save & Broadcast
                entry.state = nextBoard;
                await redis.set(`match:ludo:${gameId}`, JSON.stringify(nextBoard));

                broadcastGameState(gameId, 'gameStateUpdate', nextBoard);

                // Refresh timer for next turn (handleTurnTimeout already switched turn if move played)
                const nextUser = nextBoard.players[nextBoard.currentPlayerIndex];
                // Resolve real UUID if needed (here we assume nextUser.id matches logical IDs)
                // For simplicity, we just restart the timer logic
                await ludoGameLoop.startTurnTimer(gameId, null);

            } catch (err) {
                console.error(`[LudoLoop] Timeout error: ${err.message}`);
            } finally {
                entry.isLocked = false;
            }
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

        broadcastGameState(gameId, 'gameEnded', { winnerId, reason: 'forfeit' });

        // --- ARCHIVE CHAT ---
        chatRepository.persistMatchChat(gameId);

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
                let board = entry.state;
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

                    // Step 1: Broadcast "rolling started" to everyone immediately.
                    // The opponent's phone uses this to start the spinning animation.
                    broadcastGameState(gameId, 'ludoActionUpdate', {
                        type: 'DICE_ROLLING_STARTED',
                        rollingPlayerIndex: isPlayer1 ? 0 : 1
                    });

                    // Step 2: Wait 500ms so the two events arrive in SEPARATE socket
                    // batches on the opponent's phone. Without this delay, React batches
                    // both events into one render, the animation frame is skipped entirely.
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // Step 3: Compute the actual result and continue broadcasting below.
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

                    broadcastGameState(gameId, 'gameEnded', { winnerId });

                    // --- ARCHIVE CHAT ---
                    chatRepository.persistMatchChat(gameId);

                    activeLudoGames.delete(gameId);
                    await redis.del(`match:ludo:${gameId}`);
                    return;
                }

                entry.state = updatedBoard;
                await redis.set(`match:ludo:${gameId}`, JSON.stringify(updatedBoard));

                // Step 6: Reduce Payload Size for actions (DICE_ROLLED / PIECE_MOVED)
                broadcastGameState(gameId, 'ludoActionUpdate', {
                    type: action.type,
                    move: action.type === 'MOVE_PIECE' ? action.move : undefined,
                    dice: action.type === 'ROLL_DICE' ? updatedBoard.dice : undefined,
                    stateVersion: updatedBoard.stateVersion,
                    currentPlayerIndex: updatedBoard.currentPlayerIndex,
                    waitingForRoll: updatedBoard.waitingForRoll,
                    diceUsed: updatedBoard.diceUsed,
                    lastProcessedMoveId: action.moveId,
                    actionPlayerIndex: isPlayer1 ? 0 : 1
                });

                // Only restart timer if the turn passes to another player OR the current player earns a bonus roll
                const turnChanged = board.currentPlayerIndex !== updatedBoard.currentPlayerIndex;
                const isBonusTurn = !board.waitingForRoll && updatedBoard.waitingForRoll && !turnChanged;

                if (turnChanged || isBonusTurn) {
                    await ludoGameLoop.startTurnTimer(gameId, null);
                }

            } catch (err) {
                console.error(`[LudoLoop] Action error: ${err.message}`);
                throw err;
            } finally {
                entry.isLocked = false;
            }
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

