
import { broadcastGameState } from '../socket/socketManager.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { initializeGameData } from '../utils/gameUtils.js';

const prisma = new PrismaClient();

// In-memory storage for active game loops/timers
// Key: gameId, Value: { timer: NodeJS.Timeout, startTime: number, warningTimer: NodeJS.Timeout, etc. }
const activeWhotGames = new Map();

const RANK_THRESHOLDS = {
    WARRIOR: 1750
};

const TIME_LIMITS = {
    CASUAL: { // Below 1750
        TOTAL: 50000, // 50s
        WARNING: 20000, // At 20s elapsed (30s left) - Yellow
        DANGER: 40000,  // At 40s elapsed (10s left) - Red
    },
    COMPETITIVE: { // Warrior+ (1750+)
        TOTAL: 25000, // 25s
        WARNING: 15000, // At 15s elapsed (10s left) - Red Warning starts
        DANGER: 20000,  // At 20s elapsed (5s left) - Final Danger
    }
};

const MAX_TIMEOUTS = {
    CASUAL: 5,
    COMPETITIVE: 3
};

// Helper to get time limits based on player rating
const getWhotTimeLimits = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? TIME_LIMITS.COMPETITIVE : TIME_LIMITS.CASUAL;
};

const getWhotMaxTimeouts = (rating) => {
    return rating >= RANK_THRESHOLDS.WARRIOR ? MAX_TIMEOUTS.COMPETITIVE : MAX_TIMEOUTS.CASUAL;
};

// Helper: Check if card matches pile card
const isValidMove = (card, pileCard, calledSuit) => {
    // Whot (20) matches anything
    if (card.number === 20) return true;

    // If there's a called suit, must match that suit
    if (calledSuit) {
        return card.suit === calledSuit;
    }

    // Match suit or number
    return card.suit === pileCard.suit || card.number === pileCard.number;
};

export const whotGameLoop = {
    /**
     * Start or reset the turn timer for a Whot game
     */
    startTurnTimer: async (gameId, currentPlayerId) => {
        // Clear existing timers
        whotGameLoop.clearTurnTimer(gameId);

        // Fetch game/player info to determine rank settings
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: {
                player1: { select: { id: true, rating: true } },
                player2: { select: { id: true, rating: true } }
            }
        });

        if (!game || game.status !== 'IN_PROGRESS') return;

        // Verify it's actually this player's turn
        // (Double check against DB currentTurn just in case, though usually controller handles this)
        // if (game.currentTurn !== currentPlayerId) return;

        const currentPlayer = game.player1Id === currentPlayerId ? game.player1 : game.player2;
        if (!currentPlayer) return;

        const limits = getWhotTimeLimits(currentPlayer.rating || 0);
        const maxTimeouts = getWhotMaxTimeouts(currentPlayer.rating || 0);

        const turnState = {
            gameId,
            playerId: currentPlayerId,
            startTime: Date.now(),
            limits,
            maxTimeouts,
            // Timers
            warningTimeout: null,
            dangerTimeout: null,
            turnTimeout: null
        };

        activeWhotGames.set(gameId, turnState);

        // Broadcast timer start event
        broadcastGameState(gameId, 'turnTimerStart', {
            totalTime: limits.TOTAL,
            warningTime: limits.WARNING,
            dangerTime: limits.DANGER,
            startTime: turnState.startTime,
            playerId: currentPlayerId
        });

        // 1. Warning Timer (Yellow/Red start)
        turnState.warningTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerWarning', {
                timeLeft: limits.TOTAL - limits.WARNING,
                type: 'warning'
            });
        }, limits.WARNING);

        // 2. Danger Timer (Final countdown)
        turnState.dangerTimeout = setTimeout(() => {
            broadcastGameState(gameId, 'turnTimerDanger', {
                timeLeft: limits.TOTAL - limits.DANGER,
                type: 'danger'
            });
        }, limits.DANGER);

        // 3. Turn Expiration -> Auto Play
        turnState.turnTimeout = setTimeout(async () => {
            await whotGameLoop.handleTurnTimeout(gameId, currentPlayerId);
        }, limits.TOTAL);
    },

    clearTurnTimer: (gameId) => {
        const state = activeWhotGames.get(gameId);
        if (state) {
            if (state.warningTimeout) clearTimeout(state.warningTimeout);
            if (state.dangerTimeout) clearTimeout(state.dangerTimeout);
            if (state.turnTimeout) clearTimeout(state.turnTimeout);
            activeWhotGames.delete(gameId);
        }
    },

    handleTurnTimeout: async (gameId, playerId) => {
        console.log(`[WhotEngine] Turn timeout for ${playerId} in game ${gameId}`);

        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (!game) return;

        let board = game.board;
        if (typeof board === 'string') board = JSON.parse(board); // Handle JSON storage

        // 1. Increment Timeout Count
        const playerIndex = board.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;

        if (!board.players[playerIndex].timeouts) board.players[playerIndex].timeouts = 0;
        board.players[playerIndex].timeouts += 1;

        const currentTimeouts = board.players[playerIndex].timeouts;
        const state = activeWhotGames.get(gameId); // Get limits from likely active state
        // Fallback to recalculating if state is somehow gone (race condition)
        // Note: We just cleared the timer, so state might be gone if we cleared it first? 
        // No, 'clearTurnTimer' removes it from map. But we are inside the timeout callback.
        // We should clear the map entry now that it fired.
        whotGameLoop.clearTurnTimer(gameId);

        // Re-calculate max timeouts to be safe
        const playerObj = playerIndex === 0 ? game.player1 : game.player2; // We might need to refetch if not in board? 
        // Actually board.players usually has minimal info. Let's rely on stored timeouts.
        // Rank check:
        // We can't easily get rank from board.players. 
        // Let's assume passed limits were correct or fetch again.
        // Fetching again is safer.
        const freshGame = await prisma.game.findUnique({
            where: { id: gameId },
            include: { player1: { select: { rating: true } }, player2: { select: { rating: true } } }
        });
        const rating = (playerIndex === 0 ? freshGame.player1.rating : freshGame.player2.rating) || 0;
        const maxTimeouts = getWhotMaxTimeouts(rating);

        console.log(`[WhotEngine] Timeouts: ${currentTimeouts}/${maxTimeouts}`);

        // 2. Check Forfeit
        if (currentTimeouts >= maxTimeouts) {
            await whotGameLoop.handleForfeit(gameId, playerId);
            return;
        }

        // 3. Auto-Play Logic
        await whotGameLoop.executeAutoPlay(game, board, playerIndex, playerId);
    },

    executeAutoPlay: async (game, board, playerIndex, playerId) => {
        const playerHand = board.players[playerIndex].hand || [];
        const pileCard = board.pile[board.pile.length - 1];
        const calledSuit = board.calledSuit;

        // Find best valid card
        // Strategy: First valid card found.
        // Priority: 
        // 1. If 'Draw 2'/'Pick 3' active on me? (Not standard Whot unless defensive)
        //    Standard Whot rules: 
        //    If pending 'draw' action exists (someone played 2 against me), I must defend or draw.
        //    Defense: Plays 2 or 14? Depending on rules. 
        //    For simplicity: Check existing valid moves logic.

        let validCardIndex = -1;

        // Check if I am under attack
        const pendingAction = board.pendingAction;
        const mustDefend = pendingAction && pendingAction.type === 'draw' && pendingAction.playerIndex === playerIndex;
        // If must defend, usually standard rules say I can defend with another 2 or 14 (if general market).
        // Let's assume standard interaction:
        // Filter hand for valid cards.

        // Simple valid check loop
        for (let i = 0; i < playerHand.length; i++) {
            const card = playerHand[i];

            // Special defense logic
            if (mustDefend) {
                // Can only play matching defense card (e.g. another 2)
                // This depends heavily on specific game rules implemented in 'playCard' logic.
                // If we want to be safe, we might just "Draw" if under attack to avoid complex rule validation here.
                // But let's try to match number if 2.
                const attackCardNum = 2; // Usually only 2 causes draw 2. 14 causes general market.
                // For now, let's try standard validity. 
                // If it fails validation in a real turn, it would be bad.
                // Safest fallback: AUTO DRAW if under attack.
                continue;
            }

            if (isValidMove(card, pileCard, calledSuit)) {
                validCardIndex = i;
                break;
            }
        }

        // Action Construction
        if (validCardIndex !== -1 && !mustDefend) {
            // Play the card
            const cardToPlay = playerHand[validCardIndex];

            // Remove from hand
            board.players[playerIndex].hand.splice(validCardIndex, 1);

            // Add to pile
            board.pile.push(cardToPlay);

            // Handle Effects
            // 1, 2, 5, 8, 14, 20
            let nextPlayerIndex = playerIndex === 0 ? 1 : 0;
            let skipTurn = false;
            let pending = null;
            let marketPick = 0;
            let called = null;

            if (cardToPlay.number === 1) { // HOLD ON
                nextPlayerIndex = playerIndex; // Play again
            } else if (cardToPlay.number === 2) { // PICK TWO
                // Next player draws 2 unless they defend
                pending = { type: 'draw', playerIndex: nextPlayerIndex, count: 2, sourceCard: cardToPlay };
            } else if (cardToPlay.number === 5) { // PICK THREE (Standard?) Or just 5? 
                // Often 5 is Pick 3 in some variations, or just regular. 
                // Let's assume 5 is Pick 3 for now if that's the rule, otherwise nothing.
                // User prompt didn't specify card rules, only timer rules.
                // I will assume simple flow: 
                // 14 = General Market (Usually)
                // 8 = Suspension (Skip)
            } else if (cardToPlay.number === 8) { // SUSPENSION
                skipTurn = true; // effectively play again? No, usually skips next player. In 2 player, it means play again.
                nextPlayerIndex = playerIndex;
            } else if (cardToPlay.number === 14) { // GENERAL MARKET
                // All players play? Or next player goes to market?
                // Standard: Next player goes to market (Draw 1).
                pending = { type: 'draw', playerIndex: nextPlayerIndex, count: 1, sourceCard: cardToPlay };
            } else if (cardToPlay.number === 20) { // WHOT
                // Request Suit? 
                // Auto-play needs to pick a suit.
                // Strategy: Pick suit of most cards in hand.
                const suits = {};
                board.players[playerIndex].hand.forEach(c => {
                    suits[c.suit] = (suits[c.suit] || 0) + 1;
                });
                const bestSuit = Object.keys(suits).reduce((a, b) => suits[a] > suits[b] ? a : b, 'circle');
                called = bestSuit;
                // If Whot is played, turn usually passes unless it's a "Hold on" variant? 
                // Standard: Turn passes.
            }

            board.calledSuit = called;
            board.pendingAction = pending;

            // Check Win
            if (board.players[playerIndex].hand.length === 0) {
                // Game Over
                await whotGameLoop.handleWin(game.id, playerId, board);
                return;
            }

            // Update Turn
            // If next is same (Hold On / Suspension in 2p), timer restarts for SAME player.
            // If next is diff, timer starts for diff.
            board.currentPlayer = nextPlayerIndex;
            board.currentTurn = nextPlayerIndex === 0 ? game.player1Id : game.player2Id; // Map back

            // Save
            await prisma.game.update({
                where: { id: game.id },
                data: {
                    board: board,
                    currentTurn: board.currentTurn
                }
            });

            broadcastGameState(game.id, 'gameStateUpdate', { board });

            // Perform "Move" Broadcast so client knows who played what (for animation)
            broadcastGameState(game.id, 'opponentMove', {
                type: 'CARD_PLAYED',
                cardId: cardToPlay.id,
                playerId: playerId,
                moveId: Date.now() // Simple ID
            });

            // Restart Timer
            whotGameLoop.startTurnTimer(game.id, board.currentTurn);

        } else {
            // AUTO DRAW (No valid move OR must defend)
            // Logic: Draw 1 card from Market.

            let cardDrawn = null;
            if (board.market.length > 0) {
                cardDrawn = board.market.shift(); // Remove from front
                board.players[playerIndex].hand.push(cardDrawn);
            } else if (board.pile.length > 1) {
                // Reshuffle Pile to Market?
                // Simplified: Just say no card if market empty for now, or implement reshuffle.
                // For Auto-play, let's keep it robust: if market empty, pass turn?
            }

            // Pass Turn
            const nextPlayerIndex = playerIndex === 0 ? 1 : 0;
            board.currentPlayer = nextPlayerIndex;
            board.currentTurn = nextPlayerIndex === 0 ? game.player1Id : game.player2Id;

            // Save
            await prisma.game.update({
                where: { id: game.id },
                data: {
                    board: board,
                    currentTurn: board.currentTurn
                }
            });

            broadcastGameState(game.id, 'gameStateUpdate', { board });
            broadcastGameState(game.id, 'opponentMove', {
                type: 'PICK_CARD',
                playerId: playerId,
                moveId: Date.now()
            });

            // Restart Timer
            whotGameLoop.startTurnTimer(game.id, board.currentTurn);
        }
    },

    handleWin: async (gameId, winnerId, board) => {
        await prisma.game.update({
            where: { id: gameId },
            data: {
                status: 'COMPLETED',
                winnerId: winnerId,
                endedAt: new Date(),
                board: board
            }
        });
        broadcastGameState(gameId, 'gameEnded', { winnerId });
        whotGameLoop.clearTurnTimer(gameId);
    },

    handleForfeit: async (gameId, losingPlayerId) => {
        console.log(`[WhotEngine] Forfeit ${losingPlayerId} in game ${gameId}`);

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

        whotGameLoop.clearTurnTimer(gameId);
    }
};
