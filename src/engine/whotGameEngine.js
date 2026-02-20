
/**
 * Whot Game Engine (Server-Authoritative)
 * Controls game rules, turn order, card distribution, and state transitions.
 */

const SUIT_CARDS = {
    circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
    triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
    cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
    square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
    star: [1, 2, 3, 4, 5, 7, 8],
};

const SPECIAL_NUMBERS = {
    HOLD_ON: 1,
    PICK_TWO: 2,
    PICK_THREE: 5,
    SUSPENSION: 8,
    GENERAL_MARKET: 14,
    WHOT: 20
};

export const whotGameEngine = {
    /**
     * Generate a standard Whot deck
     */
    generateDeck: (ruleVersion = "rule1") => {
        const deck = [];
        for (const suit in SUIT_CARDS) {
            SUIT_CARDS[suit].forEach((num) => {
                deck.push({
                    id: `${suit}-${num}-${Math.random().toString(36).substr(2, 5)}`,
                    suit: suit,
                    number: num
                });
            });
        }

        // Add Whot cards
        const whotCount = ruleVersion === "rule1" ? 5 : 4; // Standard is usually 5
        for (let i = 1; i <= whotCount; i++) {
            deck.push({
                id: `whot-${i}-${Math.random().toString(36).substr(2, 5)}`,
                suit: "whot",
                number: SPECIAL_NUMBERS.WHOT
            });
        }
        return deck;
    },

    /**
     * Shuffle deck using Fisher-Yates algorithm
     */
    shuffleDeck: (deck) => {
        const shuffled = [...deck];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    },

    /**
     * Initialize a new game state
     */
    initializeGame: (matchId, player1, player2, config = {}) => {
        const ruleVersion = config.ruleVersion || "rule1";
        const cardsPerPlayer = config.cardsPerPlayer || 4;

        let deck = whotGameEngine.generateDeck(ruleVersion);
        deck = whotGameEngine.shuffleDeck(deck);

        const players = [player1.id, player2.id];
        const playerHands = {
            [player1.id]: [],
            [player2.id]: []
        };

        // Deal cards
        for (let i = 0; i < cardsPerPlayer; i++) {
            playerHands[player1.id].push(deck.pop());
            playerHands[player2.id].push(deck.pop());
        }

        // Initial pile card (cannot be a special card for starting)
        let firstCard = deck.pop();
        while (whotGameEngine.isSpecialCard(firstCard) && deck.length > 0) {
            deck.unshift(firstCard);
            firstCard = deck.pop();
        }

        const rankType = config.gameRankType === 'warrior' ? 'warrior' : 'casual';
        const turnDuration = rankType === 'warrior' ? 25000 : 50000;
        const turnStartTime = Date.now();

        return {
            matchId,
            players,
            turnPlayer: player1.id,
            discardPile: [firstCard],
            market: deck,
            playerHands,
            timerStart: turnStartTime,
            turnStartTime: turnStartTime,
            turnDuration: turnDuration,
            warningYellowAt: turnStartTime + (rankType === 'warrior' ? 15000 : 20000),
            warningRedAt: turnStartTime + (rankType === 'warrior' ? 20000 : 40000),
            timeoutCount: { [player1.id]: 0, [player2.id]: 0 },
            pendingPenalty: null,
            gameRankType: rankType,
            rankType: rankType,
            calledSuit: null,
            status: 'IN_PROGRESS',
            lastMoveId: 0,
            processedMoves: []
        };
    },

    isSpecialCard: (card) => {
        return Object.values(SPECIAL_NUMBERS).includes(card.number);
    },

    /**
     * Validate if a move is legal
     */
    validateMove: (matchState, playerId, move) => {
        if (playerId !== matchState.turnPlayer) {
            return { valid: false, reason: "Not your turn" };
        }

        // Move ID tracking
        if (move.moveId && matchState.processedMoves.includes(move.moveId)) {
            return { valid: false, reason: "Duplicate moveId" };
        }

        const hand = matchState.playerHands[playerId];
        const topCard = matchState.discardPile[matchState.discardPile.length - 1];

        // Case 1: Drawing a card
        if (move.type === 'DRAW') {
            return { valid: true };
        }

        // Case 2: Playing a card
        if (move.type === 'PLAY_CARD') {
            const card = hand.find(c => c.id === move.cardId);
            if (!card) return { valid: false, reason: "Card not in hand" };

            // If under attack
            if (matchState.pendingPenalty && matchState.pendingPenalty.type === 'draw' && matchState.pendingPenalty.targetId === playerId) {
                if (card.number === topCard.number) {
                    return { valid: true };
                }
                return { valid: false, reason: "Must defend or draw" };
            }

            if (card.number === SPECIAL_NUMBERS.WHOT) {
                return { valid: true };
            }

            if (matchState.calledSuit) {
                if (card.suit === matchState.calledSuit) return { valid: true };
                return { valid: false, reason: `Must match called suit: ${matchState.calledSuit}` };
            }

            if (card.suit === topCard.suit || card.number === topCard.number) {
                return { valid: true };
            }

            return { valid: false, reason: "Card does not match pile" };
        }

        return { valid: false, reason: "Unknown move type" };
    },

    /**
     * Apply a move and return the new state
     */
    applyMove: (matchState, playerId, move) => {
        const newState = JSON.parse(JSON.stringify(matchState));
        const opponentId = newState.players.find(id => id !== playerId);
        const hand = newState.playerHands[playerId];

        newState.timerStart = Date.now();
        newState.calledSuit = null;

        if (move.moveId) {
            newState.lastMoveId = move.moveId;
            newState.processedMoves.push(move.moveId);
            if (newState.processedMoves.length > 50) newState.processedMoves.shift();
        }

        if (move.type === 'DRAW') {
            let drawCount = 1;
            if (newState.pendingPenalty && newState.pendingPenalty.type === 'draw' && newState.pendingPenalty.targetId === playerId) {
                drawCount = newState.pendingPenalty.count;
                newState.pendingPenalty = null;
            }

            for (let i = 0; i < drawCount; i++) {
                if (newState.market.length === 0) {
                    whotGameEngine.reshufflePile(newState);
                }
                if (newState.market.length > 0) {
                    hand.push(newState.market.pop());
                }
            }

            newState.turnPlayer = opponentId;
            return newState;
        }

        if (move.type === 'PLAY_CARD') {
            const cardIndex = hand.findIndex(c => c.id === move.cardId);
            const card = hand.splice(cardIndex, 1)[0];
            newState.discardPile.push(card);

            let nextTurnPlayer = opponentId;

            const getNewPenaltyCount = (addedCount) => {
                if (matchState.pendingPenalty && matchState.pendingPenalty.type === 'draw' && matchState.pendingPenalty.targetId === playerId) {
                    return matchState.pendingPenalty.count + addedCount;
                }
                return addedCount;
            };

            switch (card.number) {
                case SPECIAL_NUMBERS.HOLD_ON:
                case SPECIAL_NUMBERS.SUSPENSION:
                    nextTurnPlayer = playerId;
                    break;
                case SPECIAL_NUMBERS.PICK_TWO:
                    newState.pendingPenalty = { type: 'draw', count: getNewPenaltyCount(2), targetId: opponentId };
                    break;
                case SPECIAL_NUMBERS.PICK_THREE:
                    newState.pendingPenalty = { type: 'draw', count: getNewPenaltyCount(3), targetId: opponentId };
                    break;
                case SPECIAL_NUMBERS.GENERAL_MARKET:
                    newState.pendingPenalty = { type: 'draw', count: getNewPenaltyCount(1), targetId: opponentId };
                    break;
                case SPECIAL_NUMBERS.WHOT:
                    newState.calledSuit = move.calledSuit || 'circle';
                    break;
            }

            if (hand.length === 0) {
                newState.status = 'COMPLETED';
                newState.winnerId = playerId;
                return newState;
            }

            newState.turnPlayer = nextTurnPlayer;
            return newState;
        }

        return newState;
    },

    reshufflePile: (matchState) => {
        if (matchState.discardPile.length <= 1) return;
        const topCard = matchState.discardPile.pop();
        const newMarket = whotGameEngine.shuffleDeck(matchState.discardPile);
        matchState.market = newMarket;
        matchState.discardPile = [topCard];
    },

    /**
     * Handle turn timeout
     */
    handleTimeout: (matchState, playerId) => {
        const hand = matchState.playerHands[playerId];

        for (const card of hand) {
            const validation = whotGameEngine.validateMove(matchState, playerId, { type: 'PLAY_CARD', cardId: card.id });
            if (validation.valid) {
                let calledSuit = null;
                if (card.number === SPECIAL_NUMBERS.WHOT) {
                    const suits = {};
                    hand.forEach(c => { if (c.suit !== 'whot') suits[c.suit] = (suits[c.suit] || 0) + 1; });
                    calledSuit = Object.keys(suits).reduce((a, b) => suits[a] > suits[b] ? a : b, 'circle');
                }
                return whotGameEngine.applyMove(matchState, playerId, { type: 'PLAY_CARD', cardId: card.id, calledSuit });
            }
        }

        return whotGameEngine.applyMove(matchState, playerId, { type: 'DRAW' });
    },

    /**
     * Scrub game state for a specific player (Fog of War)
     */
    scrubState: (matchState, playerId) => {
        const scrubbed = {
            matchId: matchState.matchId,
            players: matchState.players,
            turnPlayer: matchState.turnPlayer,
            playerHand: matchState.playerHands[playerId] || [],
            opponentHandCount: {},
            turnStartTime: matchState.turnStartTime || matchState.timerStart,
            turnDuration: matchState.turnDuration || (matchState.gameRankType === 'warrior' ? 25000 : 50000),
            warningYellowAt: matchState.warningYellowAt || 0,
            warningRedAt: matchState.warningRedAt || 0,
            timeoutCount: matchState.timeoutCount || {},
            rankType: matchState.rankType || 'casual',
            timerStart: matchState.timerStart, // legacy
            pendingPenalty: matchState.pendingPenalty,
            calledSuit: matchState.calledSuit,
            status: matchState.status,
            winnerId: matchState.winnerId,
            gameRankType: matchState.gameRankType,
            marketCount: matchState.market.length
        };

        // Populate opponent counts
        matchState.players.forEach(pId => {
            if (pId !== playerId) {
                scrubbed.opponentHandCount[pId] = matchState.playerHands[pId].length;
            }
        });

        return scrubbed;
    },

    /**
     * Scrub GameState into the exact format expected by the frontend React components
     */
    scrubStateForClient: (matchState, playerId) => {
        const opponentId = matchState.players.find(id => id !== playerId);

        // FOG-OF-WAR: Use REAL card IDs for stable tracking, but hide suit/number
        const oppHand = (matchState.playerHands[opponentId] || []).map(c => ({
            id: c.id, suit: 'hidden', number: 0
        }));

        const myHand = matchState.playerHands[playerId] || [];
        const topCard = matchState.discardPile[matchState.discardPile.length - 1];

        // FOG-OF-WAR: Market cards use real IDs but hidden data
        const marketFogged = (matchState.market || []).map(c => ({
            id: c.id, suit: 'hidden', number: 0
        }));

        const currentPlayerIndex = matchState.turnPlayer === playerId ? 0 : 1;

        const pendingPick = matchState.pendingPenalty?.type === 'draw' ? matchState.pendingPenalty.count : 0;
        const pendingAction = matchState.pendingPenalty ? {
            type: matchState.pendingPenalty.type,
            count: matchState.pendingPenalty.count,
            playerIndex: matchState.pendingPenalty.targetId === playerId ? 0 : 1
        } : null;

        return {
            players: [
                { id: playerId, name: playerId, hand: myHand },
                { id: opponentId, name: opponentId, hand: oppHand }
            ],
            pile: matchState.discardPile,
            market: marketFogged,
            currentPlayer: currentPlayerIndex,
            direction: 1,
            ruleVersion: 'rule1',
            pendingPick,
            calledSuit: matchState.calledSuit,
            lastPlayedCard: topCard,
            pendingAction,
            winner: matchState.winnerId ? { id: matchState.winnerId } : null,
            status: matchState.status,
            turnStartTime: matchState.turnStartTime || matchState.timerStart,
            turnDuration: matchState.turnDuration || (matchState.gameRankType === 'warrior' ? 25000 : 50000),
            warningYellowAt: matchState.warningYellowAt || 0,
            warningRedAt: matchState.warningRedAt || 0,
            timeoutCount: matchState.timeoutCount || {},
            rankType: matchState.rankType || 'casual',
            allCards: [
                ...myHand,
                ...oppHand,
                ...marketFogged,
                ...matchState.discardPile
            ]
        };
    },

    /**
     * Handle Turn Timeout (Smart Auto-Play)
     * Priority: 1. Play valid non-penalty card 2. Draw card 3. Play if drawn card valid 4. End turn
     */
    handleTurnTimeout: (matchState) => {
        const turnPlayer = matchState.turnPlayer;
        const hand = matchState.playerHands[turnPlayer] || [];
        const topCard = matchState.discardPile[matchState.discardPile.length - 1];

        // 1. Increment Timeout Count
        matchState.timeoutCount[turnPlayer] = (matchState.timeoutCount[turnPlayer] || 0) + 1;

        // 2. Find a valid card to play autonomously
        let cardToPlay = null;

        if (matchState.pendingPenalty) {
            // Must defend or draw. Auto-play favors drawing so we don't accidentally waste good defense cards.
            // (You could improve this by auto-defending if holding a 2 or 5)
        } else {
            // Find valid cards
            const validCards = hand.filter(card => {
                if (card.number === SPECIAL_NUMBERS.WHOT) return true;
                if (matchState.calledSuit) return card.suit === matchState.calledSuit;
                return card.suit === topCard.suit || card.number === topCard.number;
            });

            if (validCards.length > 0) {
                // Prefer non-special cards, and non-Whot cards
                const nonSpecial = validCards.filter(c => !whotGameEngine.isSpecialCard(c));
                if (nonSpecial.length > 0) {
                    cardToPlay = nonSpecial[0]; // Just pick the first non-special
                } else {
                    // Try to save 20s for last
                    const notTwenty = validCards.filter(c => c.number !== SPECIAL_NUMBERS.WHOT);
                    if (notTwenty.length > 0) {
                        cardToPlay = notTwenty[0];
                    } else {
                        cardToPlay = validCards[0]; // Have to play the 20
                    }
                }
            }
        }

        let nextState;
        if (cardToPlay) {
            // Auto-play the chosen card
            const move = { type: 'PLAY_CARD', cardId: cardToPlay.id, suitChoice: 'circle' }; // Give default suit for 20
            nextState = whotGameEngine.applyMove(matchState, turnPlayer, move);
        } else {
            // Draw a card
            nextState = whotGameEngine.applyMove(matchState, turnPlayer, { type: 'DRAW' });
        }

        return nextState;
    }
};
