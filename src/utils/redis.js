import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// --- IN-MEMORY FALLBACK ---
// This allows the server to run without a real Redis instance (Local Memory)
class MemoryRedis {
    constructor() {
        this.data = new Map();
        console.log('⚠️ [Redis] Using In-Memory Fallback (Local Storage)');
    }
    async get(key) { return this.data.get(key) || null; }
    async set(key, value) { this.data.set(key, value.toString()); return 'OK'; }
    async del(key) { this.data.delete(key); return 1; }
    async incr(key) {
        let val = parseInt(this.data.get(key) || 0, 10);
        val++;
        this.data.set(key, val.toString());
        return val;
    }
    async keys(pattern) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return Array.from(this.data.keys()).filter(k => regex.test(k));
    }
    on() { /* ignore events */ }
    once() { /* ignore events */ }
}

const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : new MemoryRedis();

if (redis instanceof Redis) {
    redis.on('error', (err) => {
        console.error('Redis error:', err);
    });

    redis.on('connect', () => {
        console.log('Connected to Redis');
    });
}

export default redis;
