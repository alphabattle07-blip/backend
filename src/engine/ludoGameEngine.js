import { randomInt } from 'crypto';
import seedrandom from 'seedrandom';
import { LudoBoardData } from './ludoCoordinates.js';

const HOUSE_POS = -1;
const FINISH_POS = 56;

// Stateful generator that uses and updates a seed string
const generateDiceBatch = (level, count, seedState) => {
    // If no state provided, create a fresh truly random seed
    const rng = seedrandom(seedState || Math.random().toString(), { state: true });
    
    // If we passed an existing state string, we MUST restore the RNG's internal state
    if (seedState && typeof seedState === 'object') {
        rng.state(seedState);
    }

    const batch = [];
    for (let i = 0; i < count; i++) {
        // seedrandom returns 0 [inclusive] to 1 [exclusive]
        // Math.floor(rng() * 6) + 1 gives 1 to 6
        const d1 = Math.floor(rng() * 6) + 1;
        const d2 = Math.floor(rng() * 6) + 1;
        batch.push(level >= 3 ? [d1, d2] : [d1]);
    }
    
    // Return both the batch AND the new internal state of the generator
    return {
        batch,
        newState: rng.state()
    };
};

/**
 * Internal helper to pull next dice from the state's queue.
 * Does not modify state; returns { dice, nextQueue, nextSeedState }.
 */
const pullNextDice = (state) => {
    let queue = state.diceQueue || [];
    let currentSeedState = state.diceSeedState;
    
    // Refill queue if running low
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

    const initialDiceData = generateDiceBatch(level, 50, matchSeed || `match_${Date.now()}_${Math.random()}`);
    let queue = initialDiceData.batch;
    let seedState = initialDiceData.newState;

    // PRE-ROLL THE FIRST DICE SECRETLY
    const firstRoll = queue.shift();

    return {
        players: [
            {
                id: 'p1',
                color: p1Color,
                seeds: Array.from({ length: 4 }).map((_, i) => ({ id: `${p1Color}-${i}`, position: HOUSE_POS, landingPos: HOUSE_POS, animationDelay: 0 })),
                lastProcessedMoveId: null,
                consecutiveNoSixes: 0,
            },
            {
                id: 'p2',
                color: p2Color,
                seeds: Array.from({ length: 4 }).map((_, i) => ({ id: `${p2Color}-${i}`, position: HOUSE_POS, landingPos: HOUSE_POS, animationDelay: 0 })),
                lastProcessedMoveId: null,
                consecutiveNoSixes: 0,
            },
        ],
        currentPlayerIndex: 0,
        dice: [],
        diceUsed: [],
        preRolledDice: firstRoll, // Secretly rolled for p1
        diceQueue: queue,
        diceSeedState: seedState,
        waitingForRoll: true,
        winner: null,
        log: ['Game Started'],
        level: level,
        stateVersion: 0,
        readyPlayers: { p1: false, p2: false },
        gameStartConfirmed: false,
        countdownStarted: false,
        matchStartDeadline: null,
    };
};

export const rollDice = (state) => {
    if (!state.waitingForRoll) return state;

    // REVEAL THE PRE-ROLLED DICE INSTANTLY
    const dice = state.preRolledDice || pullNextDice(state).dice;
    const diceUsed = state.level >= 3 ? [false, false] : [false];

    // --- Pity Timer (Mercy Rule) ---
    // Note: Applying pity timer to pre-rolled dice might change them.
    const newPlayers = JSON.parse(JSON.stringify(state.players));
    const player = newPlayers[state.currentPlayerIndex];
    let consecutiveNoSixes = player.consecutiveNoSixes || 0;
    
    const activeCount = player.seeds.filter(s => s.position !== HOUSE_POS && s.position !== FINISH_POS).length;

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
        preRolledDice: null, // Revealed
        waitingForRoll: false,
        stateVersion: (state.stateVersion || 0) + 1,
        log: [...(state.log || []).slice(-9), `Rolled [${dice.join(', ')}]`],
    };
};

export const getValidMoves = (state) => {
    if (state.waitingForRoll || state.winner) return [];

    const player = state.players[state.currentPlayerIndex];
    const singleMoves = [];

    // 1. Generate all possible Single Die moves first
    state.dice.forEach((die, dIdx) => {
        if (state.diceUsed[dIdx]) return;

        player.seeds.forEach((seed, sIdx) => {
            // A. Move out of House
            if (seed.position === HOUSE_POS) {
                if (die === 6) {
                    singleMoves.push({ seedIndex: sIdx, diceIndices: [dIdx], targetPos: 0, isCapture: false });
                }
                return;
            }

            // B. Already Finished
            if (seed.position === FINISH_POS) return;

            // C. Move on Track
            const nextPos = seed.position + die;
            if (nextPos <= FINISH_POS) {
                // Check capture logic for single move
                let isCapture = false;
                if (nextPos >= 0 && nextPos <= 51) {
                    const opponentIndex = (state.currentPlayerIndex + 1) % 2;
                    const opponent = state.players[opponentIndex];
                    const activePlayerPath = LudoBoardData.getPathForColor(player.color);
                    const targetCoord = activePlayerPath[nextPos];

                    if (targetCoord) {
                        const isSafeTile = state.level < 3 && LudoBoardData.shieldPositions.some((pos) =>
                            Math.abs(pos.x - targetCoord.x) < 0.01 && Math.abs(pos.y - targetCoord.y) < 0.01
                        );

                        if (!isSafeTile) {
                            isCapture = opponent.seeds.some(oppSeed => {
                                if (oppSeed.position < 0 || oppSeed.position >= 52) return false;
                                const opponentPath = LudoBoardData.getPathForColor(opponent.color);
                                const oppCoord = opponentPath[oppSeed.position];
                                if (!oppCoord) return false;
                                return Math.abs(targetCoord.x - oppCoord.x) < 0.01 &&
                                    Math.abs(targetCoord.y - oppCoord.y) < 0.01;
                            });
                        }
                    }
                }
                singleMoves.push({ seedIndex: sIdx, diceIndices: [dIdx], targetPos: nextPos, isCapture });
            }
        });
    });

    // 2. CHECK FOR COMBINATION LOGIC
    const activeDiceCount = state.dice.filter((_, i) => !state.diceUsed[i]).length;

    if (activeDiceCount === 2) {
        // Get unique seed indices that have valid moves
        const movableSeedIndices = [...new Set(singleMoves.map(m => m.seedIndex))];

        if (movableSeedIndices.length === 1) {
            const seedIndex = movableSeedIndices[0];
            const seed = player.seeds[seedIndex];

            // EXCEPTION: If the seed is in the HOUSE, we do NOT combine (Move Out + Move is sequential, not atomic)
            if (seed.position !== HOUSE_POS) {
                // Calculate Combined Move
                const totalDiceValue = state.dice[0] + state.dice[1];
                const combinedTarget = seed.position + totalDiceValue;

                if (combinedTarget <= FINISH_POS) {
                    // Recalculate Capture for the FINAL destination
                    let isCapture = false;
                    if (combinedTarget >= 0 && combinedTarget <= 51) {
                        const opponentIndex = (state.currentPlayerIndex + 1) % 2;
                        const opponent = state.players[opponentIndex];
                        const activePlayerPath = LudoBoardData.getPathForColor(player.color);
                        const targetCoord = activePlayerPath[combinedTarget];

                        if (targetCoord) {
                            const isSafeTile = state.level < 3 && LudoBoardData.shieldPositions.some((pos) =>
                                Math.abs(pos.x - targetCoord.x) < 0.01 && Math.abs(pos.y - targetCoord.y) < 0.01
                            );
                            if (!isSafeTile) {
                                isCapture = opponent.seeds.some(oppSeed => {
                                    if (oppSeed.position < 0 || oppSeed.position >= 52) return false;
                                    const opponentPath = LudoBoardData.getPathForColor(opponent.color);
                                    const oppCoord = opponentPath[oppSeed.position];
                                    if (!oppCoord) return false;
                                    return Math.abs(targetCoord.x - oppCoord.x) < 0.01 &&
                                        Math.abs(targetCoord.y - oppCoord.y) < 0.01;
                                });
                            }
                        }
                    }

                    // Return ONLY the combined move (forces the player to move the full distance)
                    return [{
                        seedIndex: seedIndex,
                        diceIndices: [0, 1], // Mark both dice as used
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
    const player = state.players[state.currentPlayerIndex];
    const newDiceUsed = [...state.diceUsed];
    move.diceIndices.forEach(idx => newDiceUsed[idx] = true);

    const newPlayers = JSON.parse(JSON.stringify(state.players));
    const activePlayer = newPlayers[state.currentPlayerIndex];
    const targetSeed = activePlayer.seeds[move.seedIndex];

    // Always track landing position (where the move logically ends)
    const oldPosition = targetSeed.position;
    targetSeed.landingPos = move.targetPos;
    targetSeed.animationDelay = 0; // Reset delay for the moving seed
    // Set the new position for the moving seed
    targetSeed.position = move.targetPos;

    // --- CAPTURE LOGIC ---
    // Only check for captures on the main track (positions 0-51)
    if (move.targetPos >= 0 && move.targetPos <= 51) {
        const opponentIndex = (state.currentPlayerIndex + 1) % 2;
        const opponent = newPlayers[opponentIndex];

        // Get the physical coordinates of the capturing seed's target position
        const activePlayerPath = LudoBoardData.getPathForColor(activePlayer.color);
        const targetCoord = activePlayerPath[move.targetPos];

        if (targetCoord) {
            // Check if this is a safe tile (Shield) - only for level < 3
            const isSafeTile = state.level < 3 && LudoBoardData.shieldPositions.some((pos) => {
                const tolerance = 0.01;
                return Math.abs(pos.x - targetCoord.x) < tolerance &&
                    Math.abs(pos.y - targetCoord.y) < tolerance;
            });

            if (!isSafeTile) {
                // Check each opponent seed - find only the first one to capture
                const capturedOpponentSeed = opponent.seeds.find((oppSeed) => {
                    // Skip seeds in house, finished, or in victory lane
                    if (oppSeed.position < 0 || oppSeed.position >= 52) return false;

                    // Get opponent seed's physical coordinates
                    const opponentPath = LudoBoardData.getPathForColor(opponent.color);
                    const oppCoord = opponentPath[oppSeed.position];

                    if (oppCoord) {
                        // Compare physical coordinates (with small tolerance for floating point)
                        const tolerance = 0.01;
                        const sameX = Math.abs(targetCoord.x - oppCoord.x) < tolerance;
                        const sameY = Math.abs(targetCoord.y - oppCoord.y) < tolerance;
                        return sameX && sameY;
                    }
                    return false;
                });

                if (capturedOpponentSeed) {
                    capturedOpponentSeed.position = HOUSE_POS; // Send opponent seed back to house
                    capturedOpponentSeed.landingPos = HOUSE_POS;

                    // Calculate delay based on how many steps the capturing seed takes
                    const steps = oldPosition === HOUSE_POS ? 1 : Math.max(0, move.targetPos - oldPosition);
                    // 200ms per tile (TILE_ANIMATION_DURATION)
                    capturedOpponentSeed.animationDelay = steps * 200;

                    // AS PER AGGRESSIVE MODE: Capturing seed moves to finish! (Only for Warrior level and above)
                    if (state.level >= 3) {
                        targetSeed.position = FINISH_POS;
                    }
                }
            }
        }
    }

    // Check Win
    let winner = state.winner;
    if (activePlayer.seeds.every((s) => s.position === FINISH_POS)) {
        winner = activePlayer.id;
    }

    // Turn Logic
    let nextTurn = state.currentPlayerIndex;
    let waiting = state.waitingForRoll;
    let resetDice = newDiceUsed;

    // If all dice are used:
    if (resetDice.every(u => u)) {
        // --- NEW RULE: ONLY 6 AND 6 GIVES ANOTHER TURN (Multi-die) ---
        // --- OR ROLLED 6 (Single-die) ---
        // --- OR CAPTURE (Only for level 1 & 2) ---
        const rolledDoubleSix = state.level >= 3 && state.dice[0] === 6 && state.dice[1] === 6;
        const rolledSingleSix = state.level < 3 && state.dice[0] === 6;
        const captureBonus = move.isCapture && state.level < 3;

        if ((rolledDoubleSix || rolledSingleSix || captureBonus) && !winner) {
            // BONUS TURN (Same Player)
            waiting = true;
            resetDice = state.level >= 3 ? [false, false] : [false];
            // nextTurn remains current
        } else {
            // PASS TURN
            nextTurn = (state.currentPlayerIndex + 1) % 2;
            waiting = true;
            resetDice = state.level >= 3 ? [false, false] : [false];
        }
    } else {
        // STILL MOVING (One die remaining)
        waiting = false;
    }

    // Pre-calculate next dice if we are transitioning back to waiting for roll
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
        stateVersion: (state.stateVersion || 0) + 1,
        log: [...(state.log || []).slice(-9), `Moved seed`],
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
        log: [...(state.log || []).slice(-9), `Turn passed`],
    };
};

export const handleTurnTimeout = (state) => {
    const player = state.players[state.currentPlayerIndex];

    // 1. Increment Timeout Count
    // In our engine, we store timeouts per player object
    player.timeouts = (player.timeouts || 0) + 1;

    // 2. Perform Auto-Action
    if (state.waitingForRoll) {
        // Auto-roll
        return rollDice(state);
    } else {
        // Auto-play safe move
        const validMoves = getValidMoves(state);
        if (validMoves.length > 0) {
            // Pick the first valid move
            return applyMove(state, validMoves[0]);
        } else {
            // No moves possible? Pass turn
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
        delete scrubbed.diceQueue;    // Never send future rolls to clients!
        delete scrubbed.diceSeedState; // Never send RNG state to clients!
        delete scrubbed.preRolledDice; // Never send hidden roll result!
        delete scrubbed.log;           // Log is server debug data only
        return scrubbed;
    }
};
