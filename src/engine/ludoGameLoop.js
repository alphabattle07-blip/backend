
import { broadcastGameState } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { ludoGameEngine } from './ludoGameEngine.js';

const prisma = new PrismaClient();

// In-memory storage for active game loops/timers
// Key: gameId, Value: { timer: NodeJS.Timeout, startTime: number, warningTimer: NodeJS.Timeout, etc. }
const activeGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

export const ludoGameLoop = {
    /**
     * Start or reset the turn timer for a game
     */
    startTurnTimer: async (gameId, currentPlayerId) => {
        // Clear existing timers
        ludoGameLoop.clearTurnTimer(gameId);

        // Fetch game/player info to determine rank settings
        // Optimally, this data should be passed in or cached to avoid DB hits every turn
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: {
                player1: { select: { id: true, rating: true } },
                player2: { select: { id: true, rating: true } }
            }
        });

        if (!game || game.status !== 'IN_PROGRESS') return;

        const currentPlayer = game.player1Id === currentPlayerId ? game.player1 : game.player2;
        if (!currentPlayer) return; // Should not happen

        const limits = getTimeLimits(currentPlayer.rating || 0); // Default to 0/Casual if no rating
        const maxTimeouts = getMaxTimeouts(currentPlayer.rating || 0);

        // Parse board state to check if we are waiting for roll or move
        // This requires the board to be stored in a way we can read. 
        // Assuming previously it was stored as JSON or JsonObject in Prisma
        let boardState = game.board;
        if (typeof boardState === 'string') {
            try {
                boardState = JSON.parse(boardState);
            } catch (e) {
                console.error("Failed to parse board state", e);
                return;
            }
        }

        const isRollingPhase = boardState?.waitingForRoll ?? true;

        const phaseDuration = isRollingPhase ? limits.ROLL : limits.MOVE;
        // Note: The prompt implies a continuous flow, but usually these are distinct phases in implementation.
        // However, the prompt says:
        // Casual: 0-15s Roll. If no action -> Auto-roll.
        // Then 15-35s Play.
        // This implies if they roll at 2s, they then have until the end of the turn time? 
        // Or does the "Move" timer start fresh?
        // "Total turn time: 45 seconds" implies a single clock.
        // Let's implement a single turn timer that handles checkpoints.

        const turnState = {
            gameId,
            playerId: currentPlayerId,
            startTime: Date.now(),
            limits,
            maxTimeouts,
            // Timers
            rollTimeout: null,
            warningTimeout: null,
            turnTimeout: null,
            isRollingPhase
        };

        activeGames.set(gameId, turnState);

        // Broadcast timer start event
        broadcastGameState(gameId, 'turnTimerStart', {
            totalTime: limits.TOTAL,
            rollTime: limits.ROLL,
            startTime: turnState.startTime
        });

        // 1. Auto-Roll Checkpoint
        // If they haven't rolled by limits.ROLL, we auto-roll for them.
        // if (isRollingPhase) {
        //     turnState.rollTimeout = setTimeout(async () => {
        //         await ludoGameLoop.handleAutoRoll(gameId, currentPlayerId);
        //     }, limits.ROLL);
        // }

        // 2. Warning Countdown
        // Starts at TOTAL - WARNING
        const warningDelay = limits.TOTAL - limits.WARNING;
        turnState.warningTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerWarning', {
                timeLeft: limits.WARNING
            });
        }, warningDelay);

        // 2b. Danger Countdown
        const dangerDelay = limits.TOTAL - limits.DANGER;
        turnState.dangerTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerDanger', {
                timeLeft: limits.DANGER
            });
        }, dangerDelay);

        // 3. Turn Expiration (Forfeit/Safe Move)
        // If they haven't finished their turn (moved) by TOTAL
        // turnState.turnTimeout = setTimeout(async () => {
        //     await ludoGameLoop.handleTurnTimeout(gameId, currentPlayerId);
        // }, limits.TOTAL);
    },

    clearTurnTimer: (gameId) => {
        const state = activeGames.get(gameId);
        if (state) {
            if (state.rollTimeout) clearTimeout(state.rollTimeout);
            if (state.warningTimeout) clearTimeout(state.warningTimeout);
            if (state.dangerTimeout) clearTimeout(state.dangerTimeout);
            if (state.turnTimeout) clearTimeout(state.turnTimeout);
            activeGames.delete(gameId);
        }
    },

    handleAutoRoll: async (gameId, board) => {
        console.log(`[LudoLoop] Auto-rolling for game ${gameId}`);

        let updatedBoard = ludoGameEngine.rollDice(board);
        updatedBoard.stateVersion = (updatedBoard.stateVersion || 0) + 1;

        await prisma.game.update({
            where: { id: gameId },
            data: { board: updatedBoard }
        });

        broadcastGameState(gameId, 'gameStateUpdate', updatedBoard);
    },

    handleAutoPlay: async (gameRecord, board, forfeitLimit) => {
        const gameId = gameRecord.id;
        const logicalPlayerId = board.players[board.currentPlayerIndex].id;
        const realPlayerId = logicalPlayerId === 'p1' ? gameRecord.player1Id : gameRecord.player2Id;

        console.log(`[LudoLoop] Auto-playing for player ${logicalPlayerId} in game ${gameId}`);

        // 1. Increment Auto-Play Count
        if (!board.autoPlayCountByPlayer) board.autoPlayCountByPlayer = { p1: 0, p2: 0 };
        board.autoPlayCountByPlayer[logicalPlayerId]++;

        // 2. Check Forfeit
        if (board.autoPlayCountByPlayer[logicalPlayerId] >= forfeitLimit) {
            await ludoGameLoop.handleForfeit(gameId, realPlayerId);
            return;
        }

        // 3. Perform Safe Move (Pure Engine)
        // If dice haven't been rolled (should be true if handleAutoRoll was skipped or failed), roll first
        let currentBoard = { ...board };
        if (!currentBoard.diceRolled) {
            currentBoard = ludoGameEngine.rollDice(currentBoard);
        }

        const validMoves = ludoGameEngine.getValidMoves(currentBoard);
        let finalBoard;

        if (validMoves.length > 0) {
            // Pick first valid move
            finalBoard = ludoGameEngine.applyMove(currentBoard, validMoves[0]);
        } else {
            // No moves possible, pass turn
            finalBoard = ludoGameEngine.passTurn(currentBoard);
        }

        finalBoard.stateVersion = (finalBoard.stateVersion || 0) + 1;

        // 4. Persistence & Turn Transition
        const turnChanged = board.currentPlayerIndex !== finalBoard.currentPlayerIndex;
        const nextPlayerId = finalBoard.currentPlayerIndex === 0 ? gameRecord.player1Id : gameRecord.player2Id;

        await prisma.game.update({
            where: { id: gameId },
            data: {
                board: finalBoard,
                status: finalBoard.winner ? 'COMPLETED' : 'IN_PROGRESS',
                winnerId: finalBoard.winner ? (finalBoard.winner === 'p1' ? gameRecord.player1Id : gameRecord.player2Id) : null
            }
        });

        broadcastGameState(gameId, 'gameStateUpdate', finalBoard);

        if (turnChanged && !finalBoard.winner) {
            await ludoGameLoop.startTurn(gameId, nextPlayerId);
        } else if (finalBoard.winner) {
            activeGames.delete(gameId);
        }
    },

    handleForfeit: async (gameId, losingPlayerId) => {
        console.log(`[LudoEngine] Forfeit ${losingPlayerId} in game ${gameId}`);

        const game = await prisma.game.findUnique({ where: { id: gameId } });
        const winnerId = game.player1Id === losingPlayerId ? game.player2Id : game.player1Id;

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

        ludoGameLoop.clearTurnTimer(gameId);
    },

    /**
     * Executes a player action (intent) securely on the server
     */
    executeAction: async (gameId, userId, action) => {
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!game || game.status !== 'IN_PROGRESS') {
            throw new Error("Game is not in progress");
        }

        let board = game.board;
        if (typeof board === 'string') board = JSON.parse(board);

        // Map database userId to 'p1' or 'p2' logically
        const isPlayer1 = game.player1Id === userId;
        const logicalPlayerId = isPlayer1 ? 'p1' : 'p2';

        // 1. Idempotency Check (moveId)
        if (action.moveId) {
            const player = board.players[isPlayer1 ? 0 : 1];
            if (player.lastProcessedMoveId === action.moveId) {
                console.log(`[LudoLoop] Duplicate move detected (moveId: ${action.moveId}). Ignoring.`);
                return; // Already processed
            }
        }

        // 2. Validate Turn
        const currentPlayerIndex = board.currentPlayerIndex;
        if (board.players[currentPlayerIndex].id !== logicalPlayerId) {
            throw new Error("Not your turn");
        }

        const stateBefore = JSON.stringify(board);
        let updatedBoard = { ...board };

        // 3. Process Intent
        if (action.type === 'ROLL_DICE') {
            if (!updatedBoard.waitingForRoll) {
                throw new Error("Not waiting for roll");
            }
            updatedBoard = ludoGameEngine.rollDice(updatedBoard);

        } else if (action.type === 'MOVE_PIECE') {
            if (updatedBoard.waitingForRoll) {
                throw new Error("Must roll dice first");
            }

            // In a perfect authoritative engine, the server generates valid moves and
            // compares the user's intent against them.
            const validMoves = ludoGameEngine.getValidMoves(updatedBoard);
            const moveIntent = action.move;

            // Find a matching valid move
            const isValid = validMoves.some(m =>
                m.seedIndex === moveIntent.seedIndex &&
                m.targetPos === moveIntent.targetPos &&
                JSON.stringify(m.diceIndices) === JSON.stringify(moveIntent.diceIndices)
            );

            if (!isValid) {
                console.log("[LudoEngine] Invalid move intent rejected:", moveIntent);
                throw new Error("Invalid move");
            }

            updatedBoard = ludoGameEngine.applyMove(updatedBoard, moveIntent);
        } else if (action.type === 'PASS_TURN') {
            if (updatedBoard.waitingForRoll) {
                throw new Error("Cannot pass before rolling");
            }

            const validMoves = ludoGameEngine.getValidMoves(updatedBoard);
            if (validMoves.length > 0) {
                console.log(`[LudoEngine] Invalid pass intent rejected. Valid moves exist:`, validMoves.length);
                throw new Error("Cannot pass when valid moves exist");
            }

            updatedBoard = ludoGameEngine.passTurn(updatedBoard);
        } else {
            throw new Error("Unknown action type");
        }

        // 4. Update Idempotency Marker & stateVersion
        if (action.moveId) {
            updatedBoard.players[isPlayer1 ? 0 : 1].lastProcessedMoveId = action.moveId;
        }
        updatedBoard.stateVersion = (updatedBoard.stateVersion || 0) + 1;

        // 5. Check if State Changed. If yes, save and broadcast.
        if (stateBefore !== JSON.stringify(updatedBoard)) {
            // If winner detected
            let status = 'IN_PROGRESS';
            let winnerId = null;

            if (updatedBoard.winner) {
                status = 'COMPLETED';
                winnerId = updatedBoard.winner === 'p1' ? game.player1Id : game.player2Id;
                ludoGameLoop.clearTurnTimer(gameId);
            }

            await prisma.game.update({
                where: { id: gameId },
                data: {
                    board: updatedBoard,
                    status: status,
                    winnerId: winnerId,
                    ...(status === 'COMPLETED' ? { endedAt: new Date() } : {})
                }
            });

            // Broadcast updated board to everyone
            broadcastGameState(gameId, 'gameStateUpdate', updatedBoard);

            // If game still progressing and turn changed, restart timer
            if (status === 'IN_PROGRESS' && board.currentPlayerIndex !== updatedBoard.currentPlayerIndex) {
                const nextTurnUserId = updatedBoard.currentPlayerIndex === 0 ? game.player1Id : game.player2Id;
                await ludoGameLoop.startTurn(gameId, nextTurnUserId);
            }
        }
    }
};
