/**
 * Server-Side Whot Game Engine
 * 
 * Pure functions ported from client game.ts + rules.ts + rules2.ts.
 * Used by the socket handler to validate and apply moves authoritatively.
 * Zero external dependencies. Each function runs in <1ms.
 */

// =========================================================
// RULE 1 — Validation
// =========================================================

const isValidMoveRule1 = (card, state) => {
    const { pile, pendingAction, lastPlayedCard, calledSuit } = state;
    if (pile.length === 0) return true;

    const topCard = pile[pile.length - 1];
    const cardToMatch = lastPlayedCard || topCard;

    // Defense State
    if (pendingAction?.type === 'defend' && pendingAction.playerIndex === state.currentPlayer) {
        const attackNumber = lastPlayedCard?.number || topCard.number;
        return card.number === attackNumber;
    }

    // Continuation State
    if (pendingAction?.type === 'continue') {
        if (card.number === 20) return true;
        if (cardToMatch.number === 1 || cardToMatch.number === 8) {
            return card.number === cardToMatch.number || card.suit === cardToMatch.suit;
        }
        if (cardToMatch.number === 20 && calledSuit) {
            return card.suit === calledSuit;
        }
        return card.suit === cardToMatch.suit;
    }

    // Normal Turn
    if (!pendingAction) {
        if (topCard.number === 20 && calledSuit) {
            return card.suit === calledSuit || card.number === 20;
        }
        return card.suit === topCard.suit || card.number === topCard.number || card.number === 20;
    }

    return false;
};

// =========================================================
// RULE 1 — Effects
// =========================================================

const applyCardEffectRule1 = (card, state, playerIndex) => {
    const newState = {
        ...state,
        pile: [...state.pile, card],
        lastPlayedCard: card,
        players: state.players.map((p, idx) =>
            idx === playerIndex
                ? { ...p, hand: p.hand.filter(c => c.id !== card.id) }
                : p
        ),
        calledSuit: undefined,
    };

    const getNextPlayerIndex = (steps = 1) => {
        return (playerIndex + newState.direction * steps + newState.players.length) % newState.players.length;
    };

    const opponentIndex = getNextPlayerIndex(1);
    const wasInBattle = state.pendingAction?.type === 'draw' && state.pendingAction.playerIndex === opponentIndex;
    const isCounteringAttack = state.pendingAction?.type === 'defend' && state.pendingAction.playerIndex === playerIndex;

    switch (card.number) {
        case 1: // Hold On
            newState.currentPlayer = playerIndex;
            newState.pendingAction = { type: 'continue', playerIndex };
            break;

        case 8: // Suspension
            newState.currentPlayer = playerIndex;
            newState.pendingAction = { type: 'continue', playerIndex };
            break;

        case 14: // General Market
            newState.currentPlayer = opponentIndex;
            newState.pendingAction = { type: 'draw', playerIndex: opponentIndex, count: 1, returnTurnTo: playerIndex };
            break;

        case 2: { // Pick Two
            if (isCounteringAttack && state.lastPlayedCard?.number === 2) {
                newState.pendingAction = null;
                newState.currentPlayer = getNextPlayerIndex(1);
                break;
            }
            newState.currentPlayer = opponentIndex;
            newState.pendingAction = { type: 'defend', playerIndex: opponentIndex, count: 2, returnTurnTo: playerIndex };
            break;
        }

        case 5: { // Pick Three
            if (isCounteringAttack && state.lastPlayedCard?.number === 5) {
                newState.pendingAction = null;
                newState.currentPlayer = getNextPlayerIndex(1);
                break;
            }
            newState.currentPlayer = opponentIndex;
            newState.pendingAction = { type: 'defend', playerIndex: opponentIndex, count: 3, returnTurnTo: playerIndex };
            break;
        }

        case 20: // WHOT
            newState.currentPlayer = playerIndex;
            newState.pendingAction = { type: 'call_suit', playerIndex, nextAction: wasInBattle ? 'continue' : 'pass' };
            break;

        default:
            newState.currentPlayer = getNextPlayerIndex(1);
            newState.pendingAction = null;
            newState.lastPlayedCard = null;
            break;
    }

    return newState;
};

// =========================================================
// RULE 2 — Validation
// =========================================================

const isValidMoveRule2 = (card, state) => {
    if (state.pile.length === 0) return true;
    const topCard = state.pile[state.pile.length - 1];

    if (state.pendingAction?.type === 'draw' && state.pendingAction.playerIndex === state.currentPlayer) {
        return false;
    }

    if (state.pendingAction?.type === 'continue' && state.pendingAction.playerIndex === state.currentPlayer) {
        const specialCard = state.lastPlayedCard || topCard;
        if (specialCard.number === 1) {
            return card.suit === specialCard.suit || card.number === specialCard.number;
        }
        if (specialCard.number === 2 || specialCard.number === 14) {
            return card.suit === specialCard.suit;
        }
    }

    return card.suit === topCard.suit || card.number === topCard.number;
};

// =========================================================
// RULE 2 — Effects
// =========================================================

const applyCardEffectRule2 = (card, state, playerIndex) => {
    const newState = { ...state, calledSuit: undefined };

    const getNextPlayerIndex = (currentIdx, steps = 1) => {
        return (currentIdx + newState.direction * steps + newState.players.length) % newState.players.length;
    };

    const opponentIndex = getNextPlayerIndex(playerIndex, 1);

    switch (card.number) {
        case 1:
            newState.currentPlayer = playerIndex;
            newState.pendingAction = { type: 'continue', playerIndex };
            break;
        case 2:
            newState.currentPlayer = playerIndex;
            newState.pendingAction = { type: 'draw', playerIndex: opponentIndex, count: 2, returnTurnTo: playerIndex };
            break;
        case 14:
            newState.currentPlayer = playerIndex;
            newState.pendingAction = { type: 'draw', playerIndex: opponentIndex, count: 1, returnTurnTo: playerIndex };
            break;
        default:
            newState.currentPlayer = getNextPlayerIndex(playerIndex, 1);
            newState.pendingAction = null;
            break;
    }

    newState.pile = [...newState.pile, card];
    newState.lastPlayedCard = card;
    newState.players = newState.players.map((p, idx) =>
        idx === playerIndex ? { ...p, hand: p.hand.filter(c => c.id !== card.id) } : p
    );

    return newState;
};

// =========================================================
// RULE SELECTOR
// =========================================================

const selectRuleSet = (ruleVersion) => {
    return ruleVersion === 'rule1'
        ? { isValidMove: isValidMoveRule1, applyCardEffect: applyCardEffectRule1 }
        : { isValidMove: isValidMoveRule2, applyCardEffect: applyCardEffectRule2 };
};

// =========================================================
// CORE GAME FUNCTIONS
// =========================================================

/**
 * Validate and play a card. Throws on invalid move.
 */
export const playCard = (state, playerIndex, card) => {
    const { isValidMove, applyCardEffect } = selectRuleSet(state.ruleVersion);

    if (!isValidMove(card, state)) {
        throw new Error('Invalid move');
    }

    let newState = applyCardEffect(card, state, playerIndex);

    // Check for winner
    const player = newState.players[playerIndex];
    if (player.hand.length === 0) {
        return { ...newState, winner: player, pendingAction: null };
    }

    return newState;
};

/**
 * Pick a card from market.
 */
export const pickCard = (state, playerIndex) => {
    const { pendingAction } = state;

    // Rule 2 logic
    if (state.ruleVersion === 'rule2') {
        if (state.pendingAction?.type === 'draw' && state.pendingAction.playerIndex === playerIndex) {
            return { newState: state, drawnCards: [] };
        }

        const market = [...state.market];
        if (market.length === 0) {
            return { newState: { ...state, marketExhausted: true, pendingAction: null, currentPlayer: -1 }, drawnCards: [] };
        }

        const drawnCards = market.splice(0, 1);
        const newHand = [...drawnCards, ...state.players[playerIndex].hand];
        const nextPlayer = (playerIndex + state.direction + state.players.length) % state.players.length;

        let preservedPendingAction = null;
        if (state.pendingAction?.type === 'draw' && state.pendingAction.playerIndex === nextPlayer) {
            preservedPendingAction = state.pendingAction;
        }

        const newPlayers = [...state.players];
        newPlayers[playerIndex] = { ...state.players[playerIndex], hand: newHand };

        const stateWithCardDrawn = {
            ...state, market, players: newPlayers, currentPlayer: nextPlayer,
            pendingAction: preservedPendingAction, lastPlayedCard: null,
        };

        if (market.length === 0) {
            return { newState: { ...stateWithCardDrawn, marketExhausted: true, pendingAction: null, currentPlayer: -1 }, drawnCards };
        }

        return { newState: stateWithCardDrawn, drawnCards };
    }

    // Rule 1: Defend → Draw conversion
    if (pendingAction?.type === 'defend' && pendingAction.playerIndex === playerIndex) {
        return { newState: { ...state, pendingAction: { ...pendingAction, type: 'draw' } }, drawnCards: [] };
    }

    // Rule 1: Normal pick or continue
    if (!pendingAction || (pendingAction?.type === 'continue' && pendingAction.playerIndex === playerIndex)) {
        const market = [...state.market];
        if (market.length === 0) {
            return {
                newState: {
                    ...state,
                    currentPlayer: (playerIndex + state.direction + state.players.length) % state.players.length,
                    pendingAction: null, pendingPick: 0, lastPlayedCard: null,
                },
                drawnCards: [],
            };
        }

        const drawnCards = market.splice(0, 1);
        const newHand = [...drawnCards, ...state.players[playerIndex].hand];
        const newPlayers = [...state.players];
        newPlayers[playerIndex] = { ...state.players[playerIndex], hand: newHand };

        return {
            newState: {
                ...state, market, players: newPlayers,
                currentPlayer: (playerIndex + state.direction + state.players.length) % state.players.length,
                pendingAction: null, pendingPick: 0, lastPlayedCard: null,
            },
            drawnCards,
        };
    }

    return { newState: state, drawnCards: [] };
};

/**
 * Call a suit after playing WHOT.
 */
export const callSuit = (state, playerIndex, suit) => {
    if (state.pendingAction?.type !== 'call_suit' || state.pendingAction.playerIndex !== playerIndex) {
        throw new Error('Not a valid time to call suit.');
    }

    const { nextAction } = state.pendingAction;

    if (nextAction === 'pass') {
        const nextPlayer = (playerIndex + state.direction + state.players.length) % state.players.length;
        return { ...state, calledSuit: suit, currentPlayer: nextPlayer, pendingAction: null };
    } else {
        return { ...state, calledSuit: suit, currentPlayer: playerIndex, pendingAction: { type: 'continue', playerIndex } };
    }
};

/**
 * Execute a single forced draw.
 */
export const executeForcedDraw = (state) => {
    if (state.pendingAction?.type !== 'draw') {
        return { newState: state, drawnCard: null };
    }

    const { playerIndex, count, returnTurnTo } = state.pendingAction;

    if (state.market.length === 0) {
        return { newState: state, drawnCard: null };
    }

    const market = [...state.market];
    const drawnCard = market.splice(0, 1)[0];
    const newHand = [drawnCard, ...state.players[playerIndex].hand];
    const remainingCount = count - 1;

    const newPlayers = [...state.players];
    newPlayers[playerIndex] = { ...state.players[playerIndex], hand: newHand };

    // Rule 2: market exhaustion check
    if (state.ruleVersion === 'rule2' && market.length === 0) {
        return {
            newState: { ...state, market, players: newPlayers, marketExhausted: true, pendingAction: null, currentPlayer: -1 },
            drawnCard,
        };
    }

    if (remainingCount > 0) {
        return {
            newState: { ...state, market, players: newPlayers, pendingAction: { ...state.pendingAction, count: remainingCount } },
            drawnCard,
        };
    } else {
        const nextPlayer = returnTurnTo !== undefined ? returnTurnTo : playerIndex;
        return {
            newState: { ...state, market, players: newPlayers, currentPlayer: nextPlayer, pendingAction: null, lastPlayedCard: null },
            drawnCard,
        };
    }
};

/**
 * Reshuffle pile into market (keeping top card).
 */
export const getReshuffledState = (state) => {
    if (state.pile.length <= 1) return state;

    const topCard = state.pile[state.pile.length - 1];
    const cardsToShuffle = state.pile.slice(0, state.pile.length - 1);

    // Fisher-Yates shuffle
    const shuffled = [...cardsToShuffle];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return { ...state, pile: [topCard], market: shuffled };
};

/**
 * Calculate hand score (Rule 2 market exhaustion).
 */
export const calculateHandScore = (hand) => {
    return hand.reduce((total, card) => total + card.number, 0);
};

/**
 * Finalize market exhaustion (Rule 2).
 */
export const finalizeMarketExhaustion = (state) => {
    const playersWithScores = state.players.map(p => ({ player: p, score: calculateHandScore(p.hand) }));
    playersWithScores.sort((a, b) => a.score - b.score);
    return { ...state, marketExhausted: false, winner: playersWithScores[0].player };
};
