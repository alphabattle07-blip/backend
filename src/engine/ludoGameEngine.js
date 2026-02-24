import { LudoBoardData } from './ludoCoordinates.js';
import crypto from 'crypto';

const HOUSE_POS = -1;
const FINISH_POS = 56;

export const initializeGame = (p1Color = 'red', p2Color = 'yellow', level = 2) => {
    return {
        players: [
            {
                id: 'p1',
                color: p1Color,
                seeds: Array.from({ length: 4 }).map((_, i) => ({ id: `${p1Color}-${i}`, position: HOUSE_POS, landingPos: HOUSE_POS, animationDelay: 0 })),
            },
            {
                id: 'p2',
                color: p2Color,
                seeds: Array.from({ length: 4 }).map((_, i) => ({ id: `${p2Color}-${i}`, position: HOUSE_POS, landingPos: HOUSE_POS, animationDelay: 0 })),
            },
        ],
        currentPlayerIndex: 0,
        dice: [],
        diceUsed: [],
        waitingForRoll: true,
        winner: null,
        log: ['Game Started'],
        level: level,
        stateVersion: 1, // Rule 9: Optimistic UI Sync
    };
};

export const rollDice = (state) => {
    if (!state.waitingForRoll) return state;

    // Rule 8: Dice Security - Server Side Secure Random
    const d1 = crypto.randomInt(1, 7);
    const d2 = crypto.randomInt(1, 7);

    const dice = state.level >= 3 ? [d1, d2] : [d1];
    const diceUsed = state.level >= 3 ? [false, false] : [false];

    return {
        ...state,
        dice,
        diceUsed,
        waitingForRoll: false,
        log: [...state.log, `Rolled [${dice.join(', ')}]`],
        stateVersion: state.stateVersion + 1,
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
            if (seed.position === HOUSE_POS) {
                if (die === 6) {
                    singleMoves.push({ seedIndex: sIdx, diceIndices: [dIdx], targetPos: 0, isCapture: false });
                }
                return;
            }

            if (seed.position === FINISH_POS) return;

            const nextPos = seed.position + die;
            if (nextPos <= FINISH_POS) {
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

    const activeDiceCount = state.dice.filter((_, i) => !state.diceUsed[i]).length;

    if (activeDiceCount === 2) {
        const movableSeedIndices = [...new Set(singleMoves.map(m => m.seedIndex))];

        if (movableSeedIndices.length === 1) {
            const seedIndex = movableSeedIndices[0];
            const seed = player.seeds[seedIndex];

            if (seed.position !== HOUSE_POS) {
                const totalDiceValue = state.dice[0] + state.dice[1];
                const combinedTarget = seed.position + totalDiceValue;

                if (combinedTarget <= FINISH_POS) {
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

                    return [{
                        seedIndex: seedIndex,
                        diceIndices: [0, 1],
                        targetPos: combinedTarget,
                        isCapture: isCapture
                    }];
                }
            }
        }
    }

    return singleMoves;
};

// Deterministic Auto-Play Logic
export const getDeterministicAutoMove = (state) => {
    const validMoves = getValidMoves(state);
    if (validMoves.length === 0) return null;

    // 1. Valid capture.
    const capturingMoves = validMoves.filter(m => m.isCapture);
    if (capturingMoves.length > 0) {
        // Tie-breaker: Move the piece that is furthest along
        return capturingMoves.sort((a, b) => b.targetPos - a.targetPos)[0];
    }

    // 2. Entering victory lane (targetPos > 51 but <= 56)
    const victoryLaneMoves = validMoves.filter(m => m.targetPos > 51 && m.targetPos <= FINISH_POS);
    if (victoryLaneMoves.length > 0) {
        // Tie-breaker: Closest to finish
        return victoryLaneMoves.sort((a, b) => b.targetPos - a.targetPos)[0];
    }

    // 3. Furthest progressed seed
    return validMoves.sort((a, b) => {
        const player = state.players[state.currentPlayerIndex];
        const posA = player.seeds[a.seedIndex].position === HOUSE_POS ? -1 : player.seeds[a.seedIndex].position;
        const posB = player.seeds[b.seedIndex].position === HOUSE_POS ? -1 : player.seeds[b.seedIndex].position;
        return posB - posA;
    })[0];
};

export const applyMove = (state, moveIntent) => {
    // moveIntent is { seedIndex: number } to denote which piece to move.
    // The engine maps this to a valid move generated by getValidMoves.
    const validMoves = getValidMoves(state);
    const move = validMoves.find(m => m.seedIndex === moveIntent.seedIndex);

    if (!move) {
        console.warn(`[LudoGameEngine] Invalid move intent for seedIndex ${moveIntent.seedIndex}`);
        return state; // Rule 1: Reject invalid intent
    }

    const player = state.players[state.currentPlayerIndex];
    const newDiceUsed = [...state.diceUsed];
    move.diceIndices.forEach(idx => newDiceUsed[idx] = true);

    const newPlayers = JSON.parse(JSON.stringify(state.players));
    const activePlayer = newPlayers[state.currentPlayerIndex];
    const targetSeed = activePlayer.seeds[move.seedIndex];

    const oldPosition = targetSeed.position;
    targetSeed.landingPos = move.targetPos;
    targetSeed.animationDelay = 0;
    targetSeed.position = move.targetPos;

    if (move.targetPos >= 0 && move.targetPos <= 51) {
        const opponentIndex = (state.currentPlayerIndex + 1) % 2;
        const opponent = newPlayers[opponentIndex];
        const activePlayerPath = LudoBoardData.getPathForColor(activePlayer.color);
        const targetCoord = activePlayerPath[move.targetPos];

        if (targetCoord) {
            const isSafeTile = state.level < 3 && LudoBoardData.shieldPositions.some((pos) => {
                const tolerance = 0.01;
                return Math.abs(pos.x - targetCoord.x) < tolerance &&
                    Math.abs(pos.y - targetCoord.y) < tolerance;
            });

            if (!isSafeTile) {
                const capturedOpponentSeed = opponent.seeds.find((oppSeed) => {
                    if (oppSeed.position < 0 || oppSeed.position >= 52) return false;
                    const opponentPath = LudoBoardData.getPathForColor(opponent.color);
                    const oppCoord = opponentPath[oppSeed.position];
                    if (oppCoord) {
                        const tolerance = 0.01;
                        return Math.abs(targetCoord.x - oppCoord.x) < tolerance &&
                            Math.abs(targetCoord.y - oppCoord.y) < tolerance;
                    }
                    return false;
                });

                if (capturedOpponentSeed) {
                    capturedOpponentSeed.position = HOUSE_POS;
                    capturedOpponentSeed.landingPos = HOUSE_POS;
                    const steps = oldPosition === HOUSE_POS ? 1 : Math.max(0, move.targetPos - oldPosition);
                    capturedOpponentSeed.animationDelay = steps * 200;

                    if (state.level >= 3) {
                        targetSeed.position = FINISH_POS;
                    }
                }
            }
        }
    }

    let winner = state.winner;
    if (activePlayer.seeds.every((s) => s.position === FINISH_POS)) {
        winner = activePlayer.id; // Either 'p1' or 'p2'
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

    return {
        ...state,
        players: newPlayers,
        currentPlayerIndex: nextTurn,
        diceUsed: resetDice,
        waitingForRoll: waiting,
        dice: waiting ? [] : state.dice,
        winner: winner,
        log: [...state.log, `Moved seed`],
        stateVersion: state.stateVersion + 1,
    };
};

export const passTurn = (state) => {
    return {
        ...state,
        currentPlayerIndex: (state.currentPlayerIndex + 1) % 2,
        waitingForRoll: true,
        diceUsed: state.level >= 3 ? [false, false] : [false],
        dice: [],
        log: [...state.log, `Turn passed`],
        stateVersion: state.stateVersion + 1,
    };
};
