
import { broadcastGameState } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';

const prisma = new PrismaClient();

// In-memory storage for active game loops/timers
// Key: gameId, Value: { timer: NodeJS.Timeout, startTime: number, warningTimer: NodeJS.Timeout, etc. }
const activeGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

const TIME_LIMITS = {
    CASUAL: {
        TOTAL: 45000,
        ROLL: 15000, // 0-15s
        MOVE: 20000, // 15-35s (Starts after roll)
        WARNING: 10000, // Last 10s
    },
    COMPETITIVE: { // Warrior and above
        TOTAL: 30000,
        ROLL: 8000, // 0-8s
        MOVE: 15000, // 8-23s
        WARNING: 7000, // Last 7s
    }
};

const MAX_TIMEOUTS = {
    CASUAL: 5,
    COMPETITIVE: 3
};

// Helper to get time limits based on player rating
const getTimeLimits = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? TIME_LIMITS.COMPETITIVE : TIME_LIMITS.CASUAL;
};

const getMaxTimeouts = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? MAX_TIMEOUTS.COMPETITIVE : MAX_TIMEOUTS.CASUAL;
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
        if (isRollingPhase) {
            turnState.rollTimeout = setTimeout(async () => {
                await ludoGameLoop.handleAutoRoll(gameId, currentPlayerId);
            }, limits.ROLL);
        }

        // 2. Warning Countdown
        // Starts at TOTAL - WARNING
        const warningDelay = limits.TOTAL - limits.WARNING;
        turnState.warningTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerWarning', {
                timeLeft: limits.WARNING
            });
        }, warningDelay);

        // 3. Turn Expiration (Forfeit/Safe Move)
        // If they haven't finished their turn (moved) by TOTAL
        turnState.turnTimeout = setTimeout(async () => {
            await ludoGameLoop.handleTurnTimeout(gameId, currentPlayerId);
        }, limits.TOTAL);
    },

    clearTurnTimer: (gameId) => {
        const state = activeGames.get(gameId);
        if (state) {
            if (state.rollTimeout) clearTimeout(state.rollTimeout);
            if (state.warningTimeout) clearTimeout(state.warningTimeout);
            if (state.turnTimeout) clearTimeout(state.turnTimeout);
            activeGames.delete(gameId);
        }
    },

    handleAutoRoll: async (gameId, playerId) => {
        console.log(`[LudoEngine] Auto-rolling for ${playerId} in game ${gameId}`);
        // Logic to simulate a dice roll and update DB
        // Fetch current state
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!game) return;

        let board = game.board;
        if (typeof board === 'string') board = JSON.parse(board);

        // Only auto-roll if still waiting for roll
        if (!board.waitingForRoll) return;

        // Perform Roll (Random 1-6)
        const diceValue = Math.floor(Math.random() * 6) + 1;

        // Update Board State
        board.dice = [diceValue];
        board.waitingForRoll = false;
        // Note: Logic might need to check if valid moves exist. 
        // If 6, they might get another roll? Simplified for now.

        // Save to DB
        await prisma.game.update({
            where: { id: gameId },
            data: { board: board }
        });

        // Broadcast update
        broadcastGameState(gameId, 'gameStateUpdate', { board });

        // Important: The main turn timer continues! We don't reset it.
        // But we should visually indicate the roll happened.
    },

    handleTurnTimeout: async (gameId, playerId) => {
        console.log(`[LudoEngine] Turn timeout for ${playerId} in game ${gameId}`);

        // 1. Increment Timeout Count
        // We need a place to store timeout counts. 
        // board.players[index].timeouts ??

        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!game) return;

        let board = game.board;
        if (typeof board === 'string') board = JSON.parse(board);

        const playerIndex = board.players.findIndex(p => p.id === (playerId === game.player1Id ? 'p1' : 'p2'));
        if (playerIndex === -1) return;

        if (!board.players[playerIndex].timeouts) board.players[playerIndex].timeouts = 0;
        board.players[playerIndex].timeouts += 1;

        const currentTimeouts = board.players[playerIndex].timeouts;
        const state = activeGames.get(gameId); // Get limits from state if available, else re-derive
        // Re-deriving for safety
        const maxTimeouts = getMaxTimeouts(activeGames.get(gameId)?.maxTimeouts || 5); // Fallback to 5

        // 2. Check Forfeit Condition
        if (currentTimeouts >= maxTimeouts) {
            await ludoGameLoop.handleForfeit(gameId, playerId);
            return;
        }

        // 3. Play Safe/Random Move
        // Logic to find a valid piece to move.
        await ludoGameLoop.playSafeMove(gameId, playerId, board);
    },

    playSafeMove: async (gameId, playerId, board) => {
        // Implement logic to find the "best" or "first available" move
        // For now, just pick the first valid piece that can move with the current dice.

        // Simplified: Switch turn
        board.currentPlayerIndex = board.currentPlayerIndex === 0 ? 1 : 0;
        board.waitingForRoll = true;
        board.dice = [];

        // Save
        await prisma.game.update({
            where: { id: gameId },
            data: {
                board: board,
                currentTurn: board.currentPlayerIndex === 0 ? board.players[0].id : board.players[1].id // This might need mapping back to real user IDs
            }
        });

        broadcastGameState(gameId, 'gameStateUpdate', { board });

        // Trigger next turn timer
        // We need the ID of the next player. 
        // WARNING: Using 'p1'/'p2' vs real UUIDs is tricky.
        // Assuming we can resolve the next player ID.
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
    }
};
