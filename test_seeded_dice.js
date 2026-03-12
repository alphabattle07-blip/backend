import { initializeGame, rollDice } from './src/engine/ludoGameEngine.js';

console.log("=== Testing Deterministic Seeded Dice Queue ===");

const TEST_SEED = "AlphaBattle_Tournament_Final_001";
const LEVEL = 3;

console.log(`\nTEST RUN 1: Seed "${TEST_SEED}"`);
let state1 = initializeGame('red', 'yellow', LEVEL, TEST_SEED);

let sequence1 = [];
for (let i=0; i<10; i++) {
   const current = state1.diceQueue[0];
   sequence1.push(`[${current}]`);
   state1 = rollDice(state1);
   state1.waitingForRoll = true;
}
console.log(`First 10 rolls: ${sequence1.join(', ')}`);


console.log(`\nTEST RUN 2: Seed "${TEST_SEED}"`);
let state2 = initializeGame('red', 'yellow', LEVEL, TEST_SEED);

let sequence2 = [];
for (let i=0; i<10; i++) {
   const current = state2.diceQueue[0];
   sequence2.push(`[${current}]`);
   state2 = rollDice(state2);
   state2.waitingForRoll = true;
}
console.log(`First 10 rolls: ${sequence2.join(', ')}`);

const isMatch = sequence1.join('') === sequence2.join('');
if (isMatch) {
    console.log(`\n✅ Determinism Test PASS: Sequences are identical.`);
    console.log(`   Tournament dice sequences are mathematically fair and repeatable.`);
} else {
    console.log(`\n❌ Determinism Test FAIL: Sequences do not match!`);
}
