import { broadcastGameState } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { initializeGame, rollDice, applyMove, passTurn, getValidMoves } from './ludoGameEngine.js';

const prisma = new PrismaClient();

// Rule 2 & 7: Active matches live in memory to prevent DB/Memory explosion.
const activeGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

COMPETITIVE: 3 // Rule Two
};

const getTimerProfile = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? 'ruleOne' : 'ruleTwo';
};

const getMaxAutoPlays = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? MAX_TIMEOUTS.WARRIOR : MAX_TIMEOUTS.COMPETITIVE;
};

const setTurnProfile = (match) => {
    const now = Date.now();
    match.turnStartTime = now;

    // Reset roll tracker
    match.hasRolledThisTurn = !match.board.waitingForRoll;

    if (match.timerProfile === 'ruleOne') {
        match.turnDuration = 25000;
        match.yellowAt = now + 10000;
        match.diceTriggerAt = now + 15000;
        match.redAt = now + 20000;
        match.autoPlayAt = now + 25000;
    } else {
        match.turnDuration = 19000;
        match.yellowAt = now + 7000;
        match.diceTriggerAt = now + 10000;
        match.redAt = now + 14000;
        match.autoPlayAt = now + 19000;
    }
};

// Central Ticker Enhancement
setInterval(() => {
    const now = Date.now();
    for (const [gameId, match] of activeGames.entries()) {
        const board = match.board;
        if (board.winner) continue;

        // A. Dice Trigger Check
        if (!match.hasRolledThisTurn && now >= match.diceTriggerAt) {
            executeAutoRollSafely(gameId);
        }

        // B. Auto-Play Check
        if (now >= match.autoPlayAt) {
            executeAutoPlaySafely(gameId);
        }
    }
}, 300); // 300ms non-blocking

const executeAutoRollSafely = (gameId) => {
    const match = activeGames.get(gameId);
    if (!match) return;

    match.lock = match.lock.then(async () => {
        const currentMatch = activeGames.get(gameId);
        if (!currentMatch || currentMatch.board.winner) return;
        if (currentMatch.hasRolledThisTurn || Date.now() < currentMatch.diceTriggerAt) return; // Prevent duplicate

        console.log(`[LudoEngine] Auto-roll triggered for game ${gameId}`);
        const newBoard = rollDice(currentMatch.board);

        currentMatch.board = newBoard;
        currentMatch.hasRolledThisTurn = true;
        // Do NOT increment autoPlay count
        // Do NOT reset timer

        broadcastState(gameId, currentMatch);
    }).catch(err => console.error('[Ludo Engine Error Auto-Roll]', err));
};

const executeAutoPlaySafely = (gameId) => {
    const match = activeGames.get(gameId);
    if (!match) return;

    match.lock = match.lock.then(async () => {
        const currentMatch = activeGames.get(gameId);
        if (!currentMatch || currentMatch.board.winner) return;
        if (Date.now() < currentMatch.autoPlayAt) return; // Situation resolved while waiting

        await handleAutoPlay(gameId, currentMatch);
    }).catch(err => console.error('[Ludo Engine Error Auto-Play]', err));
};

import { getDeterministicAutoMove } from './ludoGameEngine.js'; // Will implement next

const handleAutoPlay = async (gameId, match) => {
    const board = match.board;
    const playerIndex = board.currentPlayerIndex;
    const playerId = playerIndex === 0 ? match.player1Id : match.player2Id;

    if (!match.autoPlayCount) match.autoPlayCount = {};
    if (!match.autoPlayCount[playerId]) match.autoPlayCount[playerId] = 0;

    match.autoPlayCount[playerId] += 1;
    console.log(`[LudoEngine] Auto-play triggered for ${playerId} in game ${gameId} (Count: ${match.autoPlayCount[playerId]}/${match.maxAutoPlays})`);

    // Check Loss Threshold
    if (match.autoPlayCount[playerId] >= match.maxAutoPlays) {
        await handleForfeit(gameId, playerId);
        return;
    }

    // Auto-Play Logic (Deterministic Only)
    let newBoard = board;
    if (newBoard.waitingForRoll) {
        newBoard = rollDice(newBoard);
    }

    // Try to get a deterministic move
    const autoMove = getDeterministicAutoMove(newBoard);
    if (autoMove) {
        newBoard = applyMove(newBoard, autoMove);
    } else {
        newBoard = passTurn(newBoard);
    }

    match.board = newBoard;
    setTurnProfile(match); // Reset strictly
    match.turnsSinceSave = (match.turnsSinceSave || 0) + 1;

    broadcastState(gameId, match);

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
    broadcastGameState(gameId, 'gameStateUpdate', {
        board: match.board,
        turnStartTime: match.turnStartTime,
        turnDuration: match.turnDuration,
        yellowAt: match.yellowAt,
        redAt: match.redAt,
        autoPlayAt: match.autoPlayAt,
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

        const timerProfile = getTimerProfile(game.player1.rating || 0);
        const maxAutoPlays = getMaxAutoPlays(game.player1.rating || 0);

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
            timerProfile,
            maxAutoPlays,
            autoPlayCount: {},
            turnsSinceSave: 0,
            lock: Promise.resolve()
        };

        setTurnProfile(match);

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

                // Anti-Desync validation: Reject moves after autoPlayAt
                if (Date.now() >= match.autoPlayAt) return reject("Time expired");

                let newBoard = board;

                if (actionIntent.action === 'ROLL') {
                    if (!board.waitingForRoll) return reject("Already rolled");
                    newBoard = rollDice(board);
                    match.hasRolledThisTurn = true;
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

                // Turn transition
                if (newBoard.currentPlayerIndex !== board.currentPlayerIndex) {
                    setTurnProfile(match);
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
                const now = Date.now();

                // Reconnect Snapshot validation
                if (now >= match.autoPlayAt) {
                    await handleAutoPlay(gameId, match);
                } else if (!match.hasRolledThisTurn && now >= match.diceTriggerAt) {
                    await executeAutoRollSafely(gameId);
                }

                resolve({
                    board: match.board,
                    turnStartTime: match.turnStartTime,
                    turnDuration: match.turnDuration,
                    yellowAt: match.yellowAt,
                    redAt: match.redAt,
                    autoPlayAt: match.autoPlayAt,
                    serverTime: Date.now()
                });
            });
        });
    }
};
