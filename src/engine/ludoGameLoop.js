import { broadcastGameState } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { initializeGame, rollDice, applyMove, passTurn, getValidMoves } from './ludoGameEngine.js';

const prisma = new PrismaClient();

// Rule 2 & 7: Active matches live in memory to prevent DB/Memory explosion.
const activeGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

const TIME_LIMITS = {
    CASUAL: { ROLL: 15000, MOVE: 30000 },
    COMPETITIVE: { ROLL: 10000, MOVE: 20000 }
};

const MAX_TIMEOUTS = {
    CASUAL: 5,
    COMPETITIVE: 3
};

const getTimeLimits = (rating) => rating >= RANK_THRESHOLDS.WARRIOR ? TIME_LIMITS.COMPETITIVE : TIME_LIMITS.CASUAL;
const getMaxTimeouts = (rating) => rating >= RANK_THRESHOLDS.WARRIOR ? MAX_TIMEOUTS.COMPETITIVE : MAX_TIMEOUTS.CASUAL;

// Rule 2: Single Shared Game Ticker (Scale Rule)
setInterval(() => {
    const now = Date.now();
    for (const [gameId, match] of activeGames.entries()) {
        const timeLimit = match.board.waitingForRoll ? match.limits.ROLL : match.limits.MOVE;

        if (now >= match.turnStartTime + timeLimit) {
            // Rule 3: Strict Timeout Execution Lock
            executeTimeoutSafely(gameId);
        }
    }
}, 300); // Run ONE global interval

const executeTimeoutSafely = (gameId) => {
    const match = activeGames.get(gameId);
    if (!match) return;

    // Queue operation
    match.lock = match.lock.then(async () => {
        // Re-verify after gaining lock
        const currentMatch = activeGames.get(gameId);
        if (!currentMatch) return;

        const timeLimit = currentMatch.board.waitingForRoll ? currentMatch.limits.ROLL : currentMatch.limits.MOVE;
        if (Date.now() < currentMatch.turnStartTime + timeLimit) return; // Situation resolved while waiting

        await handleTimeout(gameId, currentMatch);
    }).catch(err => console.error('[Ludo Engine Error in Timeout]', err));
};

const handleTimeout = async (gameId, match) => {
    // Rule 4: Timeout Behavior Rules
    const board = match.board;
    const playerIndex = board.currentPlayerIndex;
    const playerObj = board.players[playerIndex];
    const playerId = playerIndex === 0 ? match.player1Id : match.player2Id;

    if (!playerObj.timeouts) playerObj.timeouts = 0;
    playerObj.timeouts += 1;

    console.log(`[LudoEngine] Timeout for ${playerId} in game ${gameId} (Count: ${playerObj.timeouts})`);

    // Check Forfeit
    if (playerObj.timeouts >= match.maxTimeouts) {
        await handleForfeit(gameId, playerId);
        return;
    }

    // Auto-Resolve Turn
    let newBoard = board;
    if (newBoard.waitingForRoll) {
        newBoard = rollDice(newBoard);
    } else {
        const validMoves = getValidMoves(newBoard);
        if (validMoves.length > 0) {
            // Auto-move random/first
            newBoard = applyMove(newBoard, { seedIndex: validMoves[0].seedIndex });
        } else {
            newBoard = passTurn(newBoard);
        }
    }

    match.board = newBoard;
    match.turnStartTime = Date.now();
    match.turnsSinceSave = (match.turnsSinceSave || 0) + 1;

    // Rule 6: Broadcast after validation/mutation
    broadcastState(gameId, match);

    // Rule 7: DB sync occasionally
    if (match.turnsSinceSave >= 5 || newBoard.winner) {
        await persistMatch(gameId, match);
    }
};

const handleForfeit = async (gameId, losingPlayerId) => {
    const match = activeGames.get(gameId);
    if (!match) return;

    const winnerId = match.player1Id === losingPlayerId ? match.player2Id : match.player1Id;
    match.board.winner = match.board.players[0].id === (winnerId === match.player1Id ? 'p1' : 'p2') ? 'p1' : 'p2';

    await persistMatch(gameId, match, 'COMPLETED', winnerId);

    broadcastGameState(gameId, 'gameForfeit', {
        winnerId,
        loserId: losingPlayerId,
        message: "Opponent timed out too many times."
    });

    // Rule 10: Match Cleanup Rule
    activeGames.delete(gameId);
};

const persistMatch = async (gameId, match, status = 'IN_PROGRESS', winnerId = null) => {
    match.turnsSinceSave = 0;
    const updateData = {
        board: match.board,
        currentTurn: match.board.currentPlayerIndex === 0 ? match.player1Id : match.player2Id,
        status
    };
    if (winnerId) {
        updateData.winnerId = winnerId;
        updateData.endedAt = new Date();
    }
    await prisma.game.update({
        where: { id: gameId },
        data: updateData
    });
};

const broadcastState = (gameId, match) => {
    const timeLimit = match.board.waitingForRoll ? match.limits.ROLL : match.limits.MOVE;
    broadcastGameState(gameId, 'gameStateUpdate', {
        board: match.board,
        turnStartTime: match.turnStartTime,
        timeLimit: timeLimit,
        serverTime: Date.now()
    });
};

export const ludoGameLoop = {
    // Loads game into active memory and starts the turn
    startOrResumeGame: async (gameId) => {
        if (activeGames.has(gameId)) return activeGames.get(gameId);

        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: {
                player1: { select: { id: true, rating: true } },
                player2: { select: { id: true, rating: true } }
            }
        });

        if (!game || game.status !== 'IN_PROGRESS') return null;

        const limits = getTimeLimits(game.player1.rating || 0);
        const maxTimeouts = getMaxTimeouts(game.player1.rating || 0);

        let board = game.board;
        if (typeof board === 'string') board = JSON.parse(board);
        if (!board || !board.players) {
            board = initializeGame('red', 'yellow', game.level || 2);
        }

        const match = {
            gameId,
            player1Id: game.player1Id,
            player2Id: game.player2Id,
            board: board,
            limits,
            maxTimeouts,
            turnStartTime: Date.now(),
            turnsSinceSave: 0,
            lock: Promise.resolve() // Rule 3: Strict Lock
        };

        activeGames.set(gameId, match);
        broadcastState(gameId, match);
        return match;
    },

    // Rule 1: Handle player intent dynamically
    handleAction: (gameId, userId, actionIntent) => {
        const match = activeGames.get(gameId);
        if (!match) return Promise.reject("Match not active");

        // Queue on lock
        return new Promise((resolve, reject) => {
            match.lock = match.lock.then(async () => {
                const board = match.board;
                if (board.winner) return reject("Game already finished");

                const activePlayerId = board.currentPlayerIndex === 0 ? match.player1Id : match.player2Id;
                if (activePlayerId !== userId) return reject("Not your turn");

                // Rule 9: Optimistic UI Protection - Version Check
                if (actionIntent.stateVersion !== undefined && actionIntent.stateVersion !== board.stateVersion) {
                    return reject(`Stale move version: server ${board.stateVersion}, client ${actionIntent.stateVersion}`);
                }

                let newBoard = board;

                if (actionIntent.action === 'ROLL') {
                    if (!board.waitingForRoll) return reject("Already rolled");
                    newBoard = rollDice(board);
                } else if (actionIntent.action === 'MOVE') {
                    if (board.waitingForRoll) return reject("Must roll first");
                    const seedIndex = actionIntent.seedIndex;
                    if (seedIndex === undefined) return reject("Missing seedIndex");
                    newBoard = applyMove(board, { seedIndex });
                } else {
                    return reject("Unknown action");
                }

                if (newBoard === board) {
                    return reject("Invalid Move or No state change");
                }

                // Mutate
                match.board = newBoard;

                if (newBoard.currentPlayerIndex !== board.currentPlayerIndex || newBoard.waitingForRoll !== board.waitingForRoll) {
                    match.turnStartTime = Date.now();
                }

                // Rule 6: Broadcast only AFTER validation
                broadcastState(gameId, match);

                match.turnsSinceSave = (match.turnsSinceSave || 0) + 1;
                if (match.turnsSinceSave >= 5 || newBoard.winner) {
                    await persistMatch(gameId, match, newBoard.winner ? 'COMPLETED' : 'IN_PROGRESS', newBoard.winner ? (newBoard.winner === 'p1' ? match.player1Id : match.player2Id) : null);
                    if (newBoard.winner) activeGames.delete(gameId);
                }

                resolve(newBoard);
            }).catch(reject);
        });
    },

    // Rule 5: Reconnect-Safe Snapshot
    getSnapshot: async (gameId) => {
        let match = activeGames.get(gameId);
        if (!match) {
            match = await ludoGameLoop.startOrResumeGame(gameId);
        }
        if (!match) return null;

        return new Promise((resolve) => {
            match.lock = match.lock.then(async () => {
                const timeLimit = match.board.waitingForRoll ? match.limits.ROLL : match.limits.MOVE;
                // If it should have timed out, force it to time out before sending snapshot
                if (Date.now() >= match.turnStartTime + timeLimit) {
                    await handleTimeout(gameId, match);
                }

                resolve({
                    board: match.board,
                    turnStartTime: match.turnStartTime,
                    timeLimit: match.board.waitingForRoll ? match.limits.ROLL : match.limits.MOVE,
                    serverTime: Date.now()
                });
            });
        });
    }
};
