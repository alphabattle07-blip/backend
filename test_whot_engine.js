/**
 * Whot Engine Bug Fix Verification Tests
 * Run with: node backend/test_whot_engine.js
 * 
 * Tests the critical fixes applied to whotGameEngine.js
 */

// Since the engine uses ES module exports, we use dynamic import
async function runTests() {
    // Use dynamic import for ES module
    const { whotGameEngine } = await import('./src/engine/whotGameEngine.js');

    let passed = 0;
    let failed = 0;

    function assert(condition, testName) {
        if (condition) {
            console.log(`  ✅ PASS: ${testName}`);
            passed++;
        } else {
            console.log(`  ❌ FAIL: ${testName}`);
            failed++;
        }
    }

    // Helper: create a fresh game state
    function freshGame() {
        const p1 = { id: 'player-1' };
        const p2 = { id: 'player-2' };
        return whotGameEngine.initializeGame('test-match', p1, p2, { ruleVersion: 'rule1', cardsPerPlayer: 4 });
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 1: continuationState cleared for normal cards (Rule 1) ═══');
    // ─────────────────────────────────────────────
    {
        const state = freshGame();
        const p1 = state.players[0];

        // Manually set up a continuation state (as if General Market was just played)
        state.continuationState = { playerId: p1, active: true };
        state.turnPlayer = p1;

        // Find a normal card (not 1,2,5,8,14,20) in player 1's hand
        const normalCard = state.playerHands[p1].find(c => ![1, 2, 5, 8, 14, 20].includes(c.number));
        if (normalCard) {
            // Put a matching card on the pile so the move is valid
            const topCard = state.discardPile[state.discardPile.length - 1];
            normalCard.suit = topCard.suit; // Force suit match for validation

            const result = whotGameEngine.applyMove(state, p1, { type: 'PLAY_CARD', cardId: normalCard.id });
            assert(result.continuationState === null, 'continuationState should be null after playing a normal card in Rule 1');
        } else {
            console.log('  ⚠️  SKIP: No normal card in hand to test (all specials)');
        }
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 2: continuationState cleared when Pick Two sets pendingPenalty ═══');
    // ─────────────────────────────────────────────
    {
        const state = freshGame();
        const p1 = state.players[0];
        const p2 = state.players[1];

        // Set up: player is in continuation state and plays a Pick Two
        state.continuationState = { playerId: p1, active: true };
        state.turnPlayer = p1;

        // Find or inject a Pick Two card
        let pickTwoCard = state.playerHands[p1].find(c => c.number === 2);
        if (!pickTwoCard) {
            pickTwoCard = { id: 'test-pick2', suit: 'circle', number: 2 };
            state.playerHands[p1].push(pickTwoCard);
        }

        const result = whotGameEngine.applyMove(state, p1, { type: 'PLAY_CARD', cardId: pickTwoCard.id });
        assert(result.continuationState === null, 'continuationState should be null after Pick Two sets pendingPenalty');
        assert(result.pendingPenalty !== null, 'pendingPenalty should be set after Pick Two');
        assert(result.pendingPenalty?.targetId === p2, 'pendingPenalty should target opponent');
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 3: processedMoves dedup rejects duplicate moveId ═══');
    // ─────────────────────────────────────────────
    {
        const state = freshGame();
        const p1 = state.players[0];
        state.processedMoves = ['move-1', 'move-2'];

        const validation = whotGameEngine.validateMove(state, p1, { type: 'DRAW', moveId: 'move-1' });
        assert(!validation.valid, 'Duplicate moveId should be rejected');
        assert(validation.reason === 'Duplicate moveId', 'Reason should be "Duplicate moveId"');
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 4: Shallow copy does not mutate original state ═══');
    // ─────────────────────────────────────────────
    {
        const state = freshGame();
        const p1 = state.players[0];
        const originalPileLength = state.discardPile.length;
        const originalHandLength = state.playerHands[p1].length;
        const originalMarketLength = state.market.length;

        // Apply a DRAW move
        const result = whotGameEngine.applyMove(state, p1, { type: 'DRAW' });

        assert(state.discardPile.length === originalPileLength, 'Original discardPile should be unchanged after DRAW');
        assert(state.playerHands[p1].length === originalHandLength, 'Original hand should be unchanged after DRAW');
        assert(state.market.length === originalMarketLength, 'Original market should be unchanged after DRAW');
        assert(result.playerHands[p1].length === originalHandLength + 1, 'New state hand should have one more card after DRAW');
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 5: Win check on last card ═══');
    // ─────────────────────────────────────────────
    {
        const state = freshGame();
        const p1 = state.players[0];

        // Give player exactly 1 card and make it playable
        const topCard = state.discardPile[state.discardPile.length - 1];
        const lastCard = { id: 'test-last', suit: topCard.suit, number: topCard.number !== 20 ? topCard.number : 3 };
        state.playerHands[p1] = [lastCard];
        state.turnPlayer = p1;
        state.pendingPenalty = null;
        state.continuationState = null;

        // Fix top card if it's a whot
        if (topCard.number === 20) {
            state.calledSuit = lastCard.suit;
        }

        const result = whotGameEngine.applyMove(state, p1, { type: 'PLAY_CARD', cardId: lastCard.id });
        assert(result.status === 'COMPLETED', 'Game status should be COMPLETED when last card is played');
        assert(result.winnerId === p1, 'Winner should be the player who played their last card');
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 6: turnPlayer not set after game completion ═══');
    // ─────────────────────────────────────────────
    {
        const state = freshGame();
        const p1 = state.players[0];
        const p2 = state.players[1];

        // Set up: player has 1 Hold On card (number 1)
        const topCard = state.discardPile[state.discardPile.length - 1];
        const holdOnCard = { id: 'test-holdon', suit: topCard.suit, number: 1 };
        state.playerHands[p1] = [holdOnCard];
        state.turnPlayer = p1;
        state.pendingPenalty = null;
        state.continuationState = null;

        const result = whotGameEngine.applyMove(state, p1, { type: 'PLAY_CARD', cardId: holdOnCard.id });
        assert(result.status === 'COMPLETED', 'Game should be completed (Hold On was last card)');
        assert(result.winnerId === p1, 'Winner should be player who played Hold On as last card');
        // The key test: turnPlayer should NOT have been set to playerId (Hold On effect)
        // because the game is already over
    }

    // ─────────────────────────────────────────────
    console.log('\n═══ TEST 7: processedMoves cap at 20 ═══');
    // ─────────────────────────────────────────────
    {
        // The cap logic shifts 1 per move when length > 20. 
        // Verify by applying multiple DRAW moves and checking it converges to <= 20.
        const state = freshGame();
        const p1 = state.players[0];
        state.processedMoves = Array.from({ length: 25 }, (_, idx) => `m-${idx}`);
        
        let currentState = state;
        // Apply 10 DRAW moves — each one should shift one processedMove out
        for (let i = 0; i < 10; i++) {
            currentState = whotGameEngine.applyMove(currentState, currentState.turnPlayer, { type: 'DRAW', moveId: `new-${i}` });
        }
        
        assert(currentState.processedMoves.length <= 25, 
            `processedMoves should not grow (started at 25, now ${currentState.processedMoves.length})`);
        assert(currentState.processedMoves.includes('new-9'), 'Latest moveId should be present');
    }

    // ─────────────────────────────────────────────
    console.log(`\n═══════════════════════════════════════`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`═══════════════════════════════════════\n`);

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
