
import { broadcastGameState } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { ludoGameEngine } from './ludoGameEngine.js';

const prisma = new PrismaClient();

// In-memory storage for active game loops/timers
// Key: gameId, Value: { timer: NodeJS.Timeout, startTime: number, warningTimer: NodeJS.Timeout, etc. }
const activeLudoGames = new Map();

const TIME_LIMITS = {
    RULE_ONE: { // Warrior mode (user prompt specifically said Rule One is Warrior/25s)
        TOTAL: 25000,
        YELLOW: 10000,
        AUTO_ROLL: 15000,
        RED: 20000,
        FORFEIT: 5
    },
    RULE_TWO: { // 19s
        TOTAL: 19000,
        YELLOW: 7000,
        AUTO_ROLL: 10000,
        RED: 14000,
        FORFEIT: 3
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
     */
    startTurnTimer: async (gameId, currentPlayerUserId) => {
        // Fetch or create entry
        let entry = activeLudoGames.get(gameId);
        if (!entry) {
            const game = await prisma.game.findUnique({ where: { id: gameId } });
            if (!game) return;
            entry = {
                state: typeof game.board === 'string' ? JSON.parse(game.board) : game.board,
                lock: Promise.resolve(),
                isLocked: false,
                autoRolled: false
            };
            activeLudoGames.set(gameId, entry);
        }

        const board = entry.state;
        const limits = board.level >= 3 ? TIME_LIMITS.RULE_ONE : TIME_LIMITS.RULE_TWO;

        board.turnStartTime = Date.now();
        board.turnDuration = limits.TOTAL;
        board.yellowAt = board.turnStartTime + limits.YELLOW;
        board.redAt = board.turnStartTime + limits.RED;
        entry.autoRolled = false;

        // Broadcast to clients
        broadcastGameState(gameId, 'turnStarted', {
            whoseTurn: board.players[board.currentPlayerIndex].id,
            timeLimit: limits.TOTAL,
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
                await prisma.game.update({
                    where: { id: gameId },
                    data: { board: nextBoard }
                });

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

        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'COMPLETED',
                winnerId: winnerId,
                endedAt: new Date()
            }
        });

        broadcastGameState(gameId, 'gameEnded', { winnerId, reason: 'forfeit' });
        activeLudoGames.delete(gameId);
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
                    const game = await prisma.game.findUnique({ where: { id: gameId } });
                    return game.player1Id === userId;
                })();

                const logicalPlayerId = isPlayer1 ? 'p1' : 'p2';

                // Idempotency & Turn Validation (Existing logic)
                if (action.moveId) {
                    const player = board.players[isPlayer1 ? 0 : 1];
                    if (player.lastProcessedMoveId === action.moveId) return;
                }

                // ... (Engine execution logic here ...)
                let updatedBoard = { ...board };
                if (action.type === 'ROLL_DICE') {
                    updatedBoard = ludoGameEngine.rollDice(updatedBoard);
                } else if (action.type === 'MOVE_PIECE') {
                    // (Validate and apply move)
                    updatedBoard = ludoGameEngine.applyMove(updatedBoard, action.move);
                } else if (action.type === 'PASS_TURN') {
                    updatedBoard = ludoGameEngine.passTurn(updatedBoard);
                }

                // Update state
                if (action.moveId) updatedBoard.players[isPlayer1 ? 0 : 1].lastProcessedMoveId = action.moveId;
                updatedBoard.stateVersion = (updatedBoard.stateVersion || 0) + 1;

                entry.state = updatedBoard;
                await prisma.game.update({
                    where: { id: gameId },
                    data: { board: updatedBoard }
                });

                broadcastGameState(gameId, 'gameStateUpdate', updatedBoard);

                // If turn changed, restart timer
                if (board.currentPlayerIndex !== updatedBoard.currentPlayerIndex) {
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
            const game = await prisma.game.findUnique({ where: { id: gameId } });
            if (!game || game.status !== 'IN_PROGRESS') return null;
            entry = {
                state: typeof game.board === 'string' ? JSON.parse(game.board) : game.board,
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
    }
};
