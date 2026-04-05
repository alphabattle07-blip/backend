import { randomInt } from 'crypto';
import seedrandom from 'seedrandom';

export const LOGIC_VERSION = "v1.0.1";

export const START_OFFSETS = {
    red: 0,
    green: 13,
    yellow: 26,
    blue: 39
};

export const SAFE_TILES = [0, 8, 13, 21, 26, 34, 39, 47];

export const getAbsoluteIndex = (color, tileIndex) => {
    return (START_OFFSETS[color] + tileIndex) % 52;
};

const generateDiceBatch = (level, count, seedState) => {
    const rng = seedrandom(seedState || Math.random().toString(), { state: true });
    
    if (seedState && typeof seedState === 'object') {
        rng.state(seedState);
    }

    const batch = [];
    for (let i = 0; i < count; i++) {
        const d1 = Math.floor(rng() * 6) + 1;
        const d2 = Math.floor(rng() * 6) + 1;
        batch.push(level >= 3 ? [d1, d2] : [d1]);
    }
    
    return {
        batch,
        newState: rng.state()
    };
};

const pullNextDice = (state) => {
    let queue = state.diceQueue || [];
    let currentSeedState = state.diceSeedState;
    
    if (queue.length < 10) {
        const newData = generateDiceBatch(state.level, 50, currentSeedState);
        queue = [...queue, ...newData.batch];
        currentSeedState = newData.newState;
    }

    if (!queue.length) {
        const emergencyData = generateDiceBatch(state.level, 50, currentSeedState);
        queue = [...emergencyData.batch];
        currentSeedState = emergencyData.newState;
    }

    const dice = queue.shift();
    return { dice, nextQueue: queue, nextSeedState: currentSeedState };
};

export const initializeGame = (p1Color, p2Color, level = 1, matchSeed = null) => {
    const initialDiceData = generateDiceBatch(level, 50, matchSeed || `match_${Date.now()}_${Math.random()}`);
    let queue = initialDiceData.batch;
    let seedState = initialDiceData.newState;

    const firstRoll = queue.shift();

    return {
        players: [
            {
                id: 'p1',
                color: p1Color,
                seeds: Array.from({ length: 4 }).map((_, i) => ({ 
                    id: `${p1Color}-${i}`, 
                    zone: 'HOME', 
                    tileIndex: -1, 
                    landingZone: 'HOME', 
                    landingIndex: -1, 
                    animationDelay: 0 
                })),
                lastProcessedMoveId: null,
                consecutiveNoSixes: 0,
            },
            {
                id: 'p2',
                color: p2Color,
                seeds: Array.from({ length: 4 }).map((_, i) => ({ 
                    id: `${p2Color}-${i}`, 
                    zone: 'HOME', 
                    tileIndex: -1, 
                    landingZone: 'HOME', 
                    landingIndex: -1, 
                    animationDelay: 0 
                })),
                lastProcessedMoveId: null,
                consecutiveNoSixes: 0,
            },
        ],
        currentPlayerIndex: 0,
        dice: [],
        diceUsed: [],
        preRolledDice: firstRoll, 
        diceQueue: queue,
        diceSeedState: seedState,
        waitingForRoll: true,
        winner: null,
        level: level,
        stateVersion: 0,
        eventId: 0,
        readyPlayers: { p1: false, p2: false },
        gameStartConfirmed: false,
        countdownStarted: false,
        matchStartDeadline: null,
    };
};

export const rollDice = (state) => {
    if (!state.waitingForRoll) return state;

    const dice = state.preRolledDice || pullNextDice(state).dice;
    const diceUsed = state.level >= 3 ? [false, false] : [false];

    const newPlayers = JSON.parse(JSON.stringify(state.players));
    const player = newPlayers[state.currentPlayerIndex];
    let consecutiveNoSixes = player.consecutiveNoSixes || 0;
    
    const activeCount = player.seeds.filter(s => s.zone !== 'HOME' && !(s.zone === 'FINISH' && s.tileIndex === 56)).length;

    if (activeCount === 0) {
        if (!dice.includes(6)) {
            consecutiveNoSixes++;
            let forceSix = false;
            if (consecutiveNoSixes >= 5) forceSix = true;
            else if (consecutiveNoSixes === 4 && Math.random() < 0.40) forceSix = true;
            else if (consecutiveNoSixes === 3 && Math.random() < 0.20) forceSix = true;
            else if (consecutiveNoSixes === 2 && Math.random() < 0.10) forceSix = true;

            if (forceSix) {
                dice[0] = 6;
                consecutiveNoSixes = 0;
            }
        } else {
            consecutiveNoSixes = 0; 
        }
    } else {
        consecutiveNoSixes = 0;
    }
    
    player.consecutiveNoSixes = consecutiveNoSixes;

    return {
        ...state,
        players: newPlayers,
        dice,
        diceUsed,
        preRolledDice: null,
        waitingForRoll: false,
        stateVersion: (state.stateVersion || 0) + 1,
        eventId: (state.eventId || 0) + 1,
    };
};

const pushSingleMove = (state, singleMoves, player, sIdx, dIdx, nextPos) => {
    let nextZone = 'TRACK';
    if (nextPos > 51) {
        nextZone = 'FINISH';
    }

    if (nextPos <= 56) {
        let isCapture = false;

        // Captures only occur on TRACK zone
        if (nextZone === 'TRACK') {
            const opponentIndex = (state.currentPlayerIndex + 1) % 2;
            const opponent = state.players[opponentIndex];
            
            const absIndex = getAbsoluteIndex(player.color, nextPos);
            const isSafeTile = state.level < 3 && SAFE_TILES.includes(absIndex);

            if (!isSafeTile) {
                isCapture = opponent.seeds.some(oppSeed => {
                    if (oppSeed.zone !== 'TRACK') return false;
                    const oppAbsIndex = getAbsoluteIndex(opponent.color, oppSeed.tileIndex);
                    return absIndex === oppAbsIndex;
                });
            }
        }
        
        singleMoves.push({ 
            seedIndex: sIdx, 
            diceIndices: [dIdx], 
            targetZone: nextZone, 
            targetPos: nextPos, 
            isCapture 
        });
    }
};

export const getValidMoves = (state) => {
    if (state.waitingForRoll || state.winner) return [];

    const player = state.players[state.currentPlayerIndex];
    const singleMoves = [];

    // 1. Generate Single Die moves
    state.dice.forEach((die, dIdx) => {
        if (state.diceUsed[dIdx]) return;

        player.seeds.forEach((seed, sIdx) => {
            if (seed.zone === 'HOME') {
                if (die === 6) {
                    singleMoves.push({ seedIndex: sIdx, diceIndices: [dIdx], targetZone: 'TRACK', targetPos: 0, isCapture: false });
                }
                return;
            }

            if (seed.zone === 'FINISH' && seed.tileIndex === 56) return;

            const nextPos = seed.tileIndex + die;
            pushSingleMove(state, singleMoves, player, sIdx, dIdx, nextPos);
        });
    });

    // 2. Combination Logic
    const activeDiceCount = state.dice.filter((_, i) => !state.diceUsed[i]).length;
    if (activeDiceCount === 2) {
        const movableSeedIndices = [...new Set(singleMoves.map(m => m.seedIndex))];

        if (movableSeedIndices.length === 1) {
            const seedIndex = movableSeedIndices[0];
            const seed = player.seeds[seedIndex];

            if (seed.zone !== 'HOME') {
                const totalDiceValue = state.dice[0] + state.dice[1];
                const combinedTarget = seed.tileIndex + totalDiceValue;

                if (combinedTarget <= 56) {
                    let nextZone = combinedTarget > 51 ? 'FINISH' : 'TRACK';
                    let isCapture = false;

                    if (nextZone === 'TRACK') {
                        const opponentIndex = (state.currentPlayerIndex + 1) % 2;
                        const opponent = state.players[opponentIndex];
                        const absIndex = getAbsoluteIndex(player.color, combinedTarget);
                        const isSafeTile = state.level < 3 && SAFE_TILES.includes(absIndex);

                        if (!isSafeTile) {
                            isCapture = opponent.seeds.some(oppSeed => {
                                if (oppSeed.zone !== 'TRACK') return false;
                                return absIndex === getAbsoluteIndex(opponent.color, oppSeed.tileIndex);
                            });
                        }
                    }

                    return [{
                        seedIndex: seedIndex,
                        diceIndices: [0, 1], // Mark both used
                        targetZone: nextZone,
                        targetPos: combinedTarget,
                        isCapture: isCapture
                    }];
                }
            }
        }
    }

    return singleMoves;
};

export const applyMove = (state, move) => {
    // Basic guards
    if (!state || !state.players || !state.diceUsed || !move || !move.diceIndices) {
        return state;
    }

    const player = state.players[state.currentPlayerIndex];
    if (!player || !player.seeds) return state;

    const newDiceUsed = [...state.diceUsed];
    move.diceIndices.forEach(idx => newDiceUsed[idx] = true);

    const newPlayers = JSON.parse(JSON.stringify(state.players));
    const activePlayer = newPlayers[state.currentPlayerIndex];
    const targetSeed = activePlayer.seeds[move.seedIndex];

    if (!targetSeed) return state;

    const oldPosition = targetSeed.tileIndex;
    targetSeed.landingZone = move.targetZone;
    targetSeed.landingIndex = move.targetPos;
    targetSeed.animationDelay = 0;
    
    targetSeed.zone = move.targetZone;
    targetSeed.tileIndex = move.targetPos;

    let stateChanged = true;

    // --- PURE INDEX CAPTURE LOGIC ---
    if (move.targetZone === 'TRACK') {
        const opponentIndex = (state.currentPlayerIndex + 1) % 2;
        const opponent = newPlayers[opponentIndex];

        const absIndex = getAbsoluteIndex(activePlayer.color, move.targetPos);
        const isSafeTile = state.level < 3 && SAFE_TILES.includes(absIndex);

        if (!isSafeTile) {
            const capturedOpponentSeed = opponent.seeds.find((oppSeed) => {
                if (oppSeed.zone !== 'TRACK') return false;
                return absIndex === getAbsoluteIndex(opponent.color, oppSeed.tileIndex);
            });

            if (capturedOpponentSeed) {
                capturedOpponentSeed.zone = 'HOME';
                capturedOpponentSeed.tileIndex = -1;
                capturedOpponentSeed.landingZone = 'HOME';
                capturedOpponentSeed.landingIndex = -1;

                const steps = oldPosition === -1 ? 1 : Math.max(0, move.targetPos - oldPosition);
                capturedOpponentSeed.animationDelay = steps * 200;

                // Aggressive Mode Capture Boost
                if (state.level >= 3) {
                    targetSeed.zone = 'FINISH';
                    targetSeed.tileIndex = 56;
                }
            }
        }
    }

    let winner = state.winner;
    if (activePlayer.seeds.every((s) => s.zone === 'FINISH' && s.tileIndex === 56)) {
        winner = activePlayer.id;
    }

    let nextTurn = state.currentPlayerIndex;
    let waiting = state.waitingForRoll;
    let resetDice = newDiceUsed;

    if (resetDice.every(u => u)) {
        const rolledDoubleSix = state.level >= 3 && state.dice[0] === 6 && state.dice[1] === 6;
        const rolledSingleSix = state.level < 3 && state.dice[0] === 6;
        const captureBonus = move.isCapture && state.level < 3;

        if ((rolledDoubleSix || rolledSingleSix || captureBonus) && !winner) {
            waiting = true;
            resetDice = state.level >= 3 ? [false, false] : [false];
        } else {
            nextTurn = (state.currentPlayerIndex + 1) % 2;
            waiting = true;
            resetDice = state.level >= 3 ? [false, false] : [false];
        }
    } else {
        waiting = false;
    }

    let nextDiceInfo = { dice: null, nextQueue: state.diceQueue, nextSeedState: state.diceSeedState };
    if (waiting) {
        nextDiceInfo = pullNextDice({ ...state, diceQueue: state.diceQueue, diceSeedState: state.diceSeedState });
    }

    return {
        ...state,
        players: newPlayers,
        currentPlayerIndex: nextTurn,
        diceUsed: resetDice,
        waitingForRoll: waiting,
        dice: waiting ? [] : state.dice,
        preRolledDice: waiting ? nextDiceInfo.dice : null,
        diceQueue: nextDiceInfo.nextQueue,
        diceSeedState: nextDiceInfo.nextSeedState,
        winner: winner,
        stateVersion: stateChanged ? (state.stateVersion || 0) + 1 : state.stateVersion,
        eventId: (state.eventId || 0) + 1,
    };
};

export const passTurn = (state) => {
    const nextDiceInfo = pullNextDice(state);
    return {
        ...state,
        currentPlayerIndex: (state.currentPlayerIndex + 1) % 2,
        waitingForRoll: true,
        diceUsed: state.level >= 3 ? [false, false] : [false],
        dice: [],
        preRolledDice: nextDiceInfo.dice,
        diceQueue: nextDiceInfo.nextQueue,
        diceSeedState: nextDiceInfo.nextSeedState,
        stateVersion: (state.stateVersion || 0) + 1,
        eventId: (state.eventId || 0) + 1,
    };
};

export const handleTurnTimeout = (state) => {
    const player = state.players[state.currentPlayerIndex];
    player.timeouts = (player.timeouts || 0) + 1;

    if (state.waitingForRoll) {
        return rollDice(state);
    } else {
        const validMoves = getValidMoves(state);
        if (validMoves.length > 0) {
            return applyMove(state, validMoves[0]);
        } else {
            return passTurn(state);
        }
    }
};

export const ludoGameEngine = {
    initializeGame,
    rollDice,
    getValidMoves,
    applyMove,
    passTurn,
    handleTurnTimeout,
    scrubStateForClient: (state) => {
        if (!state) return state;
        const scrubbed = { ...state };
        delete scrubbed.diceQueue;
        delete scrubbed.diceSeedState;
        delete scrubbed.preRolledDice;
        return scrubbed;
    }
};
