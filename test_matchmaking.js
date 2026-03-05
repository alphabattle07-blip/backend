const API_URL = 'http://127.0.0.1:3000/api';

async function testMatchmaking() {
    try {
        console.log('Registering user 1...');
        const user1Resp = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: `test1_${Date.now()}@test.com`,
                password: 'password123',
                name: 'Test 1'
            })
        });
        const user1 = await user1Resp.json();
        console.log('User 1 Register Response:', user1);
        const token1 = user1.token;
        if (!token1) return;

        console.log('Registering user 2...');
        const user2Resp = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: `test2_${Date.now()}@test.com`,
                password: 'password123',
                name: 'Test 2'
            })
        });
        const user2 = await user2Resp.json();
        const token2 = user2.token;

        console.log('\nUser 1 starting matchmaking...');
        const res1Resp = await fetch(`${API_URL}/matchmaking/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token1}` },
            body: JSON.stringify({ gameType: 'ludo' })
        });
        const res1 = await res1Resp.json();
        console.log('User 1 response:', res1);

        console.log('\nUser 2 starting matchmaking...');
        const res2Resp = await fetch(`${API_URL}/matchmaking/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token2}` },
            body: JSON.stringify({ gameType: 'ludo' })
        });
        const res2 = await res2Resp.json();
        console.log('User 2 response:', res2);
    } catch (err) {
        console.error('Script Error:', err.message);
    }
}

testMatchmaking();
