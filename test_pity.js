import { initializeGame, rollDice, passTurn } from './src/engine/ludoGameEngine.js';

for (let g = 0; g < 20; g++) {
    let state = initializeGame('red', 'yellow', 1, `test_${g}_${Math.random()}`);
    let maxRolls = 0;
    
    for (let i = 1; i <= 10; i++) {
        state = rollDice(state);
        const p1 = state.players[0];
        
        if (!state.dice.includes(6)) {
            maxRolls = i;
            // It's p1 turn, state.currentPlayerIndex is 0
            state = passTurn(state); // Now p2 turn
            state = passTurn(state); // Back to p1 turn
        } else {
            console.log(`Game ${g}: Got 6 on roll ${i}. cNoSix was ${p1.consecutiveNoSixes} before reset.`);
            break;
        }
        
        if (i === 10) {
            console.log(`Game ${g}: FAILED! Reached 10 rolls without a 6!`);
        }
    }
}
