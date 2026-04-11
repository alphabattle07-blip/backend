
/**
 * Whot Game Engine (Server-Authoritative)
 * Supports two rule sets:
 *   - Rule 1 (Standard): 54-card deck, all specials including Whot
 *   - Rule 2 (Aggressive/Warrior+): 49-card deck, no Whot, continuation for 2/14, 5/8 normal
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

// Which card numbers are "special" per rule set
const RULE1_SPECIALS = new Set([1, 2, 5, 8, 14, 20]);
const RULE2_SPECIALS = new Set([1, 2, 14]); // 5, 8 are normal; 20 not in deck

export const whotGameEngine = {
    /**
     * Generate a Whot deck based on the rule version.
     *   Rule 1: SUIT_CARDS + 5 Whot cards = 54
     *   Rule 2: SUIT_CARDS only, no Whot cards = 49
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

        if (ruleVersion === "rule1") {
            // Add 5 Whot cards for Rule 1
            for (let i = 1; i <= 5; i++) {
                deck.push({
                    id: `whot-${i}-${Math.random().toString(36).substr(2, 5)}`,
                    suit: "whot",
                    number: SPECIAL_NUMBERS.WHOT
                });
            }
        }
        // Rule 2: No Whot cards added — deck stays at 49

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
     * Check if a card is "special" under the given rule version
     */
    isSpecialCard: (card, ruleVersion = "rule1") => {
        if (ruleVersion === "rule2") {
            return RULE2_SPECIALS.has(card.number);
        }
        return RULE1_SPECIALS.has(card.number);
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
        while (whotGameEngine.isSpecialCard(firstCard, ruleVersion) && deck.length > 0) {
            deck.unshift(firstCard);
            firstCard = deck.pop();
        }

        const rankType = config.gameRankType === 'warrior' ? 'warrior' : 'casual';
        const turnDuration = rankType === 'warrior' ? 19000 : 25000;
        const turnStartTime = Date.now();

        return {
            matchId,
            players,
            ruleVersion,
            turnPlayer: player1.id,
            discardPile: [firstCard],
            market: deck,
            playerHands,
            timerStart: turnStartTime,
            turnStartTime: turnStartTime,
            turnDuration: turnDuration,
            warningYellowAt: turnStartTime + (rankType === 'warrior' ? 7000 : 10000),
            warningRedAt: turnStartTime + (rankType === 'warrior' ? 14000 : 20000),
            timeoutCount: { [player1.id]: 0, [player2.id]: 0 },
            pendingPenalty: null,
            continuationState: null, // Rule 2 only: { playerId, active: true }
            gameRankType: rankType,
            rankType: rankType,
            calledSuit: null,
            status: 'IN_PROGRESS',
            lastMoveId: 0,
            processedMoves: []
        };
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

        const ruleVersion = matchState.ruleVersion || "rule1";
        const hand = matchState.playerHands[playerId];
        const topCard = matchState.discardPile[matchState.discardPile.length - 1];

        // ── DRAW ──
        if (move.type === 'DRAW') {
            return { valid: true };
        }

        // ── PLAY_CARD ──
        if (move.type === 'PLAY_CARD') {
            const card = hand.find(c => c.id === move.cardId);
            if (!card) return { valid: false, reason: "Card not in hand" };

            // ══════════════════════════════════════════════════════
            // PENALTY DEFENSE — checked FIRST, before any normal validation
            // ══════════════════════════════════════════════════════
            if (matchState.pendingPenalty && matchState.pendingPenalty.type === 'draw' && matchState.pendingPenalty.targetId === playerId) {
                // Determine the defense number: use stored cardNumber, or fall back to topCard.number
                const defenseNumber = matchState.pendingPenalty.cardNumber || topCard.number;

                console.log(`[Engine] PENALTY DEFENSE CHECK: card.number=${card.number}, defenseNumber=${defenseNumber}, pendingPenalty=`, JSON.stringify(matchState.pendingPenalty));

                // Defense: card number must match the penalty's cardNumber (2 defends 2, 5 defends 5)
                // NO suit matching — number only
                if (card.number === defenseNumber) {
                    console.log(`[Engine] DEFENSE ACCEPTED: ${card.number} matches ${defenseNumber}`);
                    return { valid: true };
                }
                // Everything else is REJECTED — must defend or draw
                console.log(`[Engine] DEFENSE REJECTED: ${card.number} does not match ${defenseNumber}`);
                return { valid: false, reason: "Must defend with matching card or draw" };
            }

            // ── Continuation state (both rules) ──
            if (matchState.continuationState && matchState.continuationState.active && matchState.continuationState.playerId === playerId) {
                // In continuation: must play a card matching pile suit OR another continuation-triggering special (2 or 14)
                if (card.number === SPECIAL_NUMBERS.PICK_TWO || card.number === SPECIAL_NUMBERS.GENERAL_MARKET) {
                    return { valid: true }; // Another special extends the continuation
                }
                // In Rule 1, Whot can break continuation
                if (card.number === SPECIAL_NUMBERS.WHOT && ruleVersion === "rule1") {
                    return { valid: true };
                }
                if (card.suit === topCard.suit || card.number === topCard.number) {
                    return { valid: true }; // Matching suit or number
                }
                return { valid: false, reason: "Must play matching suit/number or another special to continue, or draw to end turn" };
            }

            // ── Whot card (Rule 1 only — shouldn't exist in Rule 2 deck) ──
            if (card.number === SPECIAL_NUMBERS.WHOT && ruleVersion === "rule1") {
                return { valid: true };
            }

            // ── Called suit check ──
            if (matchState.calledSuit) {
                // Whot (20) can ALWAYS be played, even under called suit
                if (card.number === SPECIAL_NUMBERS.WHOT && ruleVersion === "rule1") {
                    return { valid: true };
                }
                if (card.suit === matchState.calledSuit) return { valid: true };
                return { valid: false, reason: `Must match called suit: ${matchState.calledSuit}` };
            }

            // ── Standard match: suit or number ──
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
        // Targeted shallow copy — avoids deep-copying the entire discardPile/market on every move
        const newState = {
            ...matchState,
            discardPile: [...matchState.discardPile],
            market: [...matchState.market],
            playerHands: {
                [matchState.players[0]]: [...matchState.playerHands[matchState.players[0]]],
                [matchState.players[1]]: [...matchState.playerHands[matchState.players[1]]]
            },
            processedMoves: [...(matchState.processedMoves || [])],
            timeoutCount: { ...matchState.timeoutCount },
        };
        const ruleVersion = newState.ruleVersion || "rule1";
        const opponentId = newState.players.find(id => id !== playerId);
        const hand = newState.playerHands[playerId];

        newState.timerStart = Date.now();
        // NOTE: calledSuit is NOT cleared here. It persists until a matching-suit card is played.
        // See PLAY_CARD section below for clearing logic.

        if (move.moveId) {
            newState.lastMoveId = move.moveId;
            newState.processedMoves.push(move.moveId);
            if (newState.processedMoves.length > 20) newState.processedMoves.shift();
        }

        // ────────────────────────────────────────
        // DRAW
        // ────────────────────────────────────────
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
                    hand.unshift(newState.market.pop());
                }
            }

            // Drawing ends continuation state (Rule 2)
            if (newState.continuationState && newState.continuationState.active && newState.continuationState.playerId === playerId) {
                newState.continuationState = null;
            }

            newState.turnPlayer = opponentId;
            return newState;
        }

        // ────────────────────────────────────────
        // PLAY_CARD
        // ────────────────────────────────────────
        if (move.type === 'PLAY_CARD') {
            const cardIndex = hand.findIndex(c => c.id === move.cardId);
            const card = hand.splice(cardIndex, 1)[0];
            newState.discardPile.push(card);

            // ── Clear calledSuit ONLY when a non-Whot card matching the called suit is played ──
            // Whot (20) overrides calledSuit with a new one (handled in switch below)
            if (card.number !== SPECIAL_NUMBERS.WHOT) {
                if (newState.calledSuit && card.suit === newState.calledSuit) {
                    newState.calledSuit = null; // Satisfied — clear it
                } else if (!newState.calledSuit) {
                    // No called suit — nothing to clear
                } else {
                    // Card doesn't match calledSuit but passed validation — clear anyway
                    // (e.g. penalty defense cards that bypass suit check)
                    newState.calledSuit = null;
                }
            }

            let nextTurnPlayer = opponentId;

            // ══════════════════════════════════════════════════════
            // DEFENSE INTERCEPTION — runs BEFORE any rule-specific logic
            // If player is under penalty AND plays the matching defense card,
            // the penalty is CANCELLED entirely. Turn returns to attacker.
            // ══════════════════════════════════════════════════════
            const isUnderPenalty = matchState.pendingPenalty &&
                matchState.pendingPenalty.type === 'draw' &&
                matchState.pendingPenalty.targetId === playerId;

            if (isUnderPenalty) {
                const defenseNumber = matchState.pendingPenalty.cardNumber ||
                    matchState.discardPile[matchState.discardPile.length - 2]?.number; // fallback: card before the one just played

                if (card.number === defenseNumber) {
                    // ✅ DEFENSE SUCCESSFUL — penalty cancelled completely
                    console.log(`[Engine] DEFENSE: ${card.number} cancels penalty. Penalty cleared.`);
                    newState.pendingPenalty = null;

                    // WIN CHECK — if defender played their last card, they win
                    if (hand.length === 0) {
                        newState.status = 'COMPLETED';
                        newState.winnerId = playerId;
                        return newState;
                    }

                    newState.turnPlayer = opponentId; // Turn returns to the original attacker
                    return newState;
                }
            }

            // ── RULE 1: Standard Effects ──
            if (ruleVersion === "rule1") {
                switch (card.number) {
                    case SPECIAL_NUMBERS.HOLD_ON: // 1
                        nextTurnPlayer = playerId; // Play again
                        break;

                    case SPECIAL_NUMBERS.SUSPENSION: // 8
                        nextTurnPlayer = playerId; // Skip opponent
                        break;

                    case SPECIAL_NUMBERS.PICK_TWO: // 2
                        // Fresh attack (defense was handled above)
                        newState.pendingPenalty = {
                            type: 'draw',
                            count: 2,
                            cardNumber: 2,
                            targetId: opponentId
                        };
                        newState.continuationState = null; // Bug 4 fix: clear continuation when initiating new penalty
                        nextTurnPlayer = opponentId;
                        break;

                    case SPECIAL_NUMBERS.PICK_THREE: // 5
                        // Fresh attack (defense was handled above)
                        newState.pendingPenalty = {
                            type: 'draw',
                            count: 3,
                            cardNumber: 5,
                            targetId: opponentId
                        };
                        newState.continuationState = null; // Bug 4 fix: clear continuation when initiating new penalty
                        nextTurnPlayer = opponentId;
                        break;

                    case SPECIAL_NUMBERS.GENERAL_MARKET: { // 14
                        // Same in both rules: opponent draws 1 immediately, player enters continuation
                        const oppHand = newState.playerHands[opponentId];
                        if (newState.market.length === 0) whotGameEngine.reshufflePile(newState);
                        if (newState.market.length > 0) oppHand.unshift(newState.market.pop());
                        newState.pendingPenalty = null;
                        newState.continuationState = { playerId, active: true };
                        nextTurnPlayer = playerId; // Player stays in turn
                        break;
                    }

                    case SPECIAL_NUMBERS.WHOT: // 20
                        newState.calledSuit = move.calledSuit || 'circle';
                        nextTurnPlayer = opponentId;
                        break;

                    default:
                        // Bug 3 fix: Clear continuation state when a NON-SPECIAL card is played in Rule 1
                        // Without this, continuationState lingers after General Market / Hold On chains,
                        // causing wrong validation paths on subsequent turns.
                        if (newState.continuationState && newState.continuationState.active && newState.continuationState.playerId === playerId) {
                            newState.continuationState = null;
                        }
                        break;
                }
            }

            // ── RULE 2: Aggressive Effects ──
            if (ruleVersion === "rule2") {
                switch (card.number) {
                    case SPECIAL_NUMBERS.HOLD_ON: // 1
                        nextTurnPlayer = playerId;
                        newState.continuationState = null;
                        break;

                    case SPECIAL_NUMBERS.PICK_TWO: {
                        // Defense already handled by interception block above.
                        // If we're here, it's a fresh attack.
                        const drawCount = 2;
                        const oppHandR2 = newState.playerHands[opponentId];
                        for (let i = 0; i < drawCount; i++) {
                            if (newState.market.length === 0) whotGameEngine.reshufflePile(newState);
                            if (newState.market.length > 0) oppHandR2.unshift(newState.market.pop());
                        }
                        newState.pendingPenalty = null;
                        newState.continuationState = { playerId, active: true };
                        nextTurnPlayer = playerId;
                        break;
                    }

                    case SPECIAL_NUMBERS.GENERAL_MARKET: {
                        const oppHandGM = newState.playerHands[opponentId];
                        if (newState.market.length === 0) whotGameEngine.reshufflePile(newState);
                        if (newState.market.length > 0) oppHandGM.unshift(newState.market.pop());
                        newState.pendingPenalty = null;
                        newState.continuationState = { playerId, active: true };
                        nextTurnPlayer = playerId;
                        break;
                    }

                    // 5 (Pick Three) and 8 (Suspension) are NORMAL in Rule 2
                    // 20 (Whot) doesn't exist in the deck

                    default:
                        if (newState.continuationState && newState.continuationState.active && newState.continuationState.playerId === playerId) {
                            newState.continuationState = null;
                        }
                        break;
                }
            }

            // ── WIN CHECK ──
            if (hand.length === 0) {
                newState.status = 'COMPLETED';
                newState.winnerId = playerId;
                return newState;
            }

            // Bug 5 fix: Only set next turn player if game is still in progress
            // (prevents brief "zombie turn" state after win)
            if (newState.status !== 'COMPLETED') {
                newState.turnPlayer = nextTurnPlayer;
            }
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
     * Scrub game state for a specific player (Fog of War) — simple format
     */
    scrubState: (matchState, playerId) => {
        const scrubbed = {
            matchId: matchState.matchId,
            players: matchState.players,
            turnPlayer: matchState.turnPlayer,
            playerHand: matchState.playerHands[playerId] || [],
            opponentHandCount: {},
            turnStartTime: matchState.turnStartTime || matchState.timerStart,
            turnDuration: matchState.turnDuration || (matchState.gameRankType === 'warrior' ? 19000 : 25000),
            warningYellowAt: matchState.warningYellowAt || 0,
            warningRedAt: matchState.warningRedAt || 0,
            timeoutCount: matchState.timeoutCount || {},
            rankType: matchState.rankType || 'casual',
            timerStart: matchState.timerStart,
            pendingPenalty: matchState.pendingPenalty,
            continuationState: matchState.continuationState,
            calledSuit: matchState.calledSuit,
            status: matchState.status,
            winnerId: matchState.winnerId,
            gameRankType: matchState.gameRankType,
            ruleVersion: matchState.ruleVersion || 'rule1',
            marketCount: matchState.market.length
        };

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
        const ruleVersion = matchState.ruleVersion || 'rule1';

        const oppHand = matchState.playerHands[opponentId] || [];
        const myHand = matchState.playerHands[playerId] || [];
        const topCard = matchState.discardPile[matchState.discardPile.length - 1];

        const currentPlayerIndex = matchState.turnPlayer === playerId ? 0 : 1;

        const pendingPick = matchState.pendingPenalty?.type === 'draw' ? matchState.pendingPenalty.count : 0;
        // Map server's 'draw' penalty type to client's 'defend' action type
        // Client rules.ts checks for type === 'defend' to allow defense plays
        const pendingAction = matchState.pendingPenalty ? {
            type: 'defend', // Client expects 'defend', not 'draw'
            count: matchState.pendingPenalty.count,
            cardNumber: matchState.pendingPenalty.cardNumber || null,
            playerIndex: matchState.pendingPenalty.targetId === playerId ? 0 : 1
        } : null;

        // Map continuation state to client-friendly format
        const continuationAction = matchState.continuationState ? {
            active: matchState.continuationState.active,
            playerIndex: matchState.continuationState.playerId === playerId ? 0 : 1
        } : null;

        return {
            players: [
                { id: playerId, name: playerId, hand: myHand },
                { id: opponentId, name: opponentId, hand: oppHand }
            ],
            pile: matchState.discardPile,
            market: matchState.market,
            currentPlayer: currentPlayerIndex,
            direction: 1,
            ruleVersion,
            pendingPick,
            calledSuit: matchState.calledSuit,
            lastPlayedCard: topCard,
            pendingAction,
            continuationAction,
            winner: matchState.winnerId ? { id: matchState.winnerId } : null,
            status: matchState.status,
            turnStartTime: matchState.turnStartTime || matchState.timerStart,
            turnDuration: matchState.turnDuration || (matchState.gameRankType === 'warrior' ? 19000 : 25000),
            warningYellowAt: matchState.warningYellowAt || 0,
            warningRedAt: matchState.warningRedAt || 0,
            timeoutCount: matchState.timeoutCount || {},
            rankType: matchState.rankType || 'casual',
            currentPlayerId: matchState.turnPlayer,
            allCards: [
                ...myHand,
                ...oppHand,
                ...matchState.market,
                ...matchState.discardPile
            ]
        };
    },

    /**
     * Handle Turn Timeout (Smart Auto-Play)
     * Rule-aware: respects Rule 1 vs Rule 2 special cards and continuation state.
     */
    handleTurnTimeout: (matchState) => {
        const turnPlayer = matchState.turnPlayer;
        const ruleVersion = matchState.ruleVersion || "rule1";
        const hand = matchState.playerHands[turnPlayer] || [];
        const topCard = matchState.discardPile[matchState.discardPile.length - 1];

        // 1. Increment Timeout Count
        matchState.timeoutCount[turnPlayer] = (matchState.timeoutCount[turnPlayer] || 0) + 1;

        // 2. If there's a pending penalty targeting this player, auto-draw
        if (matchState.pendingPenalty && matchState.pendingPenalty.targetId === turnPlayer) {
            return whotGameEngine.applyMove(matchState, turnPlayer, { type: 'DRAW' });
        }

        // 3. Continuation: if in continuation, try to play a valid card or draw to end
        if (matchState.continuationState && matchState.continuationState.active && matchState.continuationState.playerId === turnPlayer) {
            // Try to find a valid continuation card (matching suit/number or 2/14)
            const validCards = hand.filter(card => {
                if (ruleVersion === "rule1" && card.number === SPECIAL_NUMBERS.WHOT) return true;
                if (card.number === SPECIAL_NUMBERS.PICK_TWO || card.number === SPECIAL_NUMBERS.GENERAL_MARKET) return true;
                return card.suit === topCard.suit || card.number === topCard.number;
            });

            if (validCards.length > 0) {
                // Prefer non-special cards
                const specialSet = ruleVersion === "rule2" ? RULE2_SPECIALS : RULE1_SPECIALS;
                const nonSpecial = validCards.filter(c => !specialSet.has(c.number));
                let cardToPlay;
                
                if (nonSpecial.length > 0) {
                    cardToPlay = nonSpecial[0];
                } else {
                    if (ruleVersion === "rule1") {
                        const notTwenty = validCards.filter(c => c.number !== SPECIAL_NUMBERS.WHOT);
                        cardToPlay = notTwenty.length > 0 ? notTwenty[0] : validCards[0];
                    } else {
                        cardToPlay = validCards[0];
                    }
                }

                if (cardToPlay) {
                    const move = { type: 'PLAY_CARD', cardId: cardToPlay.id };
                    // For Whot card (Rule 1), pick the most common suit in hand
                    if (cardToPlay.number === SPECIAL_NUMBERS.WHOT) {
                        const suits = {};
                        hand.forEach(c => { if (c.suit !== 'whot') suits[c.suit] = (suits[c.suit] || 0) + 1; });
                        move.calledSuit = Object.keys(suits).reduce((a, b) => suits[a] > suits[b] ? a : b, 'circle');
                    }
                    return whotGameEngine.applyMove(matchState, turnPlayer, move);
                }
            }

            // No valid card — draw to end continuation
            return whotGameEngine.applyMove(matchState, turnPlayer, { type: 'DRAW' });
        }

        // 4. Standard auto-play: find valid cards
        let cardToPlay = null;

        const validCards = hand.filter(card => {
            if (ruleVersion === "rule1" && card.number === SPECIAL_NUMBERS.WHOT) return true;
            if (matchState.calledSuit) return card.suit === matchState.calledSuit;
            return card.suit === topCard.suit || card.number === topCard.number;
        });

        if (validCards.length > 0) {
            // Prefer non-special cards
            const specialSet = ruleVersion === "rule2" ? RULE2_SPECIALS : RULE1_SPECIALS;
            const nonSpecial = validCards.filter(c => !specialSet.has(c.number));
            if (nonSpecial.length > 0) {
                cardToPlay = nonSpecial[0];
            } else {
                // For Rule 1: try to save Whot (20) for last
                if (ruleVersion === "rule1") {
                    const notTwenty = validCards.filter(c => c.number !== SPECIAL_NUMBERS.WHOT);
                    cardToPlay = notTwenty.length > 0 ? notTwenty[0] : validCards[0];
                } else {
                    cardToPlay = validCards[0];
                }
            }
        }

        if (cardToPlay) {
            const move = { type: 'PLAY_CARD', cardId: cardToPlay.id };
            // For Whot card (Rule 1), pick the most common suit in hand
            if (cardToPlay.number === SPECIAL_NUMBERS.WHOT) {
                const suits = {};
                hand.forEach(c => { if (c.suit !== 'whot') suits[c.suit] = (suits[c.suit] || 0) + 1; });
                move.calledSuit = Object.keys(suits).reduce((a, b) => suits[a] > suits[b] ? a : b, 'circle');
            }
            return whotGameEngine.applyMove(matchState, turnPlayer, move);
        }

        // No valid card — draw
        return whotGameEngine.applyMove(matchState, turnPlayer, { type: 'DRAW' });
    }
};
