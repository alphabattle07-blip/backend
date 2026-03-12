import { initializeGame, rollDice, ludoGameEngine } from './src/engine/ludoGameEngine.js';

console.log("=== Testing Ludo Pre-Generated Dice Rolls ===");

// 1. Initialize Game
let state = initializeGame('red', 'yellow', 3);
console.log(`[INIT] Queue length: ${state.diceQueue.length}`);
console.log(`[INIT] Next 3 rolls secretly in queue: ${JSON.stringify(state.diceQueue.slice(0, 3))}`);

// 2. Roll a few times
for(let i=1; i<=3; i++) {
    state = rollDice(state);
    state.waitingForRoll = true; // reset for next roll test
    console.log(`\n[ROLL ${i}] Result: ${JSON.stringify(state.dice)}`);
    console.log(`[ROLL ${i}] Remaining in queue: ${state.diceQueue.length}`);
}

// 3. Test Scrubbing
const scrubbed = ludoGameEngine.scrubStateForClient(state);
console.log(`\n[SECURITY] Is diceQueue in original state? ${'diceQueue' in state}`);
console.log(`[SECURITY] Is diceQueue in scrubbed state? ${'diceQueue' in scrubbed}`);
if (!('diceQueue' in scrubbed)) {
    console.log("✅ Security Pass: Clients cannot cheat by reading the socket payload.");
} else {
    console.log("❌ Security Fail: Queue leaked to client.");
}

// 4. Test Auto-Refill
console.log("\n[REFILL] Draining queue to trigger refill...");
for(let i=0; i<45; i++) {
    state = rollDice(state);
    state.waitingForRoll = true;
}
console.log(`[REFILL] Queue length after 45 rolls: ${state.diceQueue.length}`);
state = rollDice(state);
console.log(`[REFILL] Output: ${JSON.stringify(state.dice)}`);
console.log(`[REFILL] Queue length after refill trigger (expected ~50): ${state.diceQueue.length}`);
