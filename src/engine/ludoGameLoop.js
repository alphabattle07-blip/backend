
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

        // --- Match Ready Timeout Check ---
        if (!board.gameStartConfirmed) {
            if (board.matchStartDeadline && Date.now() > board.matchStartDeadline) {
                if (entry.isLocked) continue;
                entry.isLocked = true;
                console.log(`[LudoLoop] Match ready timeout for game ${gameId}`);
                await ludoGameLoop.cancelMatchAndRefund(gameId);
                continue; // entry is deleted inside cancel
            }
            continue; // Skip turn timer checks until game is confirmed
        }

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

        board.turnStartTime = Date.now();
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
                    const winnerLogicalId = updatedBoard.winner.id; // 'p1' or 'p2'
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

                broadcastGameState(gameId, 'gameStateUpdate', updatedBoard);

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

    /**
     * Register a newly matched game into memory without starting the turn timer.
     * Sets matchStartDeadline for 30-second ready timeout.
     */
    registerPendingGame: async (gameId) => {
        // Fetch game record from DB for both board state and player UUIDs
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!game) return;

        // Load game state from Redis or DB
        const cached = await redis.get(`match:ludo:${gameId}`);
        let gameState = null;

        if (cached) {
            gameState = JSON.parse(cached);
        } else {
            gameState = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;
        }

        // Set the match start deadline (30 seconds to ready up)
        gameState.matchStartDeadline = Date.now() + 30000;
        await redis.set(`match:ludo:${gameId}`, JSON.stringify(gameState));

        const entry = {
            state: gameState,
            lock: Promise.resolve(),
            isLocked: false,
            autoRolled: false,
            player1UserId: game.player1Id || null,
            player2UserId: game.player2Id || null
        };
        activeLudoGames.set(gameId, entry);
        console.log(`[LudoLoop] Registered pending game ${gameId}, waiting for MATCH_READY`);
    },

    /**
     * Handle a player signaling they are ready.
     * Race-condition safe via entry.isLocked.
     */
    handleMatchReady: async (gameId, userId) => {
        const entry = activeLudoGames.get(gameId);
        if (!entry) return;

        if (entry.isLocked) return; // Prevents race condition
        entry.isLocked = true;

        try {
            const board = entry.state;

            if (board.gameStartConfirmed) return;

            // Validate user from stored player UUIDs (no DB call)
            let logicalId = null;
            if (userId === entry.player1UserId) logicalId = 'p1';
            else if (userId === entry.player2UserId) logicalId = 'p2';
            else return; // Not a participant

            board.readyPlayers[logicalId] = true;
            console.log(`[LudoLoop] Player ${logicalId} (${userId}) ready in game ${gameId}`);

            await redis.set(`match:ludo:${gameId}`, JSON.stringify(board));

            const allReady = board.readyPlayers.p1 && board.readyPlayers.p2;
            if (!allReady) return;

            if (board.countdownStarted) return; // Double-start guard

            board.countdownStarted = true;
            console.log(`[LudoLoop] Both players ready in game ${gameId}, starting countdown`);

            broadcastGameState(gameId, 'matchCountdown', { seconds: 3 });

            setTimeout(async () => {
                const latestEntry = activeLudoGames.get(gameId);
                if (!latestEntry) return;

                const latestBoard = latestEntry.state;
                if (latestBoard.gameStartConfirmed) return;

                latestBoard.gameStartConfirmed = true;

                // Transition DB status from MATCHED to IN_PROGRESS
                await prisma.game.update({
                    where: { id: gameId },
                    data: { status: 'IN_PROGRESS' }
                });

                await redis.set(`match:ludo:${gameId}`, JSON.stringify(latestBoard));

                await ludoGameLoop.startTurnTimer(gameId, null);
                console.log(`[LudoLoop] Game ${gameId} officially started`);
            }, 3000);

        } finally {
            entry.isLocked = false;
        }
    },

    /**
     * Cancel a match that failed the ready handshake.
     * Checks DB status to prevent double-refund.
     */
    cancelMatchAndRefund: async (gameId) => {
        const game = await prisma.game.findUnique({ where: { id: gameId } });

        if (!game || game.status !== 'MATCHED') {
            // Already transitioned or doesn't exist - just clean up memory
            activeLudoGames.delete(gameId);
            await redis.del(`match:ludo:${gameId}`);
            return;
        }

        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'CANCELLED',
                endedAt: new Date()
            }
        });

        broadcastGameState(gameId, 'matchCancelled', {
            reason: 'Player failed to ready up'
        });

        console.log(`[LudoLoop] Match ${gameId} cancelled - ready timeout`);
        activeLudoGames.delete(gameId);
        await redis.del(`match:ludo:${gameId}`);
    }
};

