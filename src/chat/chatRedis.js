import redis from '../utils/redis.js';

const CHAT_PREFIX = 'match_chat';
const MAX_MESSAGES = 100;
const TTL_SECONDS = 7200; // 2 hours

export const chatRedis = {
    /**
     * Get the Redis key for a specific match
     */
    getKey(matchId) {
        return `${CHAT_PREFIX}:${matchId}`;
    },

    /**
     * Save a message to the match's Redis list.
     * Trims the list to keep only the latest MAX_MESSAGES.
     * Resets the TTL to 2 hours.
     * 
     * @param {string} matchId The ID of the match
     * @param {object} messageObj The message payload object
     */
    async saveMessage(matchId, messageObj) {
        try {
            const key = this.getKey(matchId);
            const value = JSON.stringify(messageObj);

            // Handle MemoryRedis fallback logic
            if (redis.constructor.name === 'MemoryRedis') {
                if (!redis.data.has(key)) {
                    redis.data.set(key, []);
                }
                const list = redis.data.get(key);
                list.push(value);

                // Trim in memory
                if (list.length > MAX_MESSAGES) {
                    list.splice(0, list.length - MAX_MESSAGES);
                }
                return true;
            }

            // Real Redis logic using pipeline for atomicity
            const pipeline = redis.pipeline();

            // Append message to the end of the list
            pipeline.rpush(key, value);

            // Keep only the newest MAX_MESSAGES (negative indices count from end)
            // LTRIM list -100 -1 keeps the last 100 elements. 
            // NOTE: Requirement says LPUSH, but chronological order usually dictates RPUSH
            // We use RPUSH so new messages go to the end, LRANGE 0 -1 returns oldest first.
            // If using LPUSH, new messages go to the start, and we'd LTRIM 0 99.
            // Adjusting to LPUSH based on prompt requirement:
            pipeline.lpush(key, value);
            pipeline.ltrim(key, 0, MAX_MESSAGES - 1);

            // Reset expiration timer
            pipeline.expire(key, TTL_SECONDS);

            await pipeline.exec();
            return true;
        } catch (error) {
            console.error(`[Chat Redis] Error saving message for match ${matchId}:`, error);
            return false; // Fallback: don't crash the server, just drop the history
        }
    },

    /**
     * Retrieve the recent messages for a match
     * 
     * @param {string} matchId The ID of the match
     * @returns {Array<object>} Array of parsed message objects
     */
    async getRecentMessages(matchId) {
        try {
            const key = this.getKey(matchId);

            // Handle MemoryRedis fallback logic
            if (redis.constructor.name === 'MemoryRedis') {
                const list = redis.data.get(key) || [];
                return list.map(item => JSON.parse(item));
            }

            // Real Redis logic
            // Because we used LPUSH, the list is [newest, ..., oldest].
            // Usually UI wants chronological order [oldest, ..., newest], so we reverse it.
            const messages = await redis.lrange(key, 0, -1);
            return messages.map(msg => JSON.parse(msg)).reverse();
        } catch (error) {
            console.error(`[Chat Redis] Error getting messages for match ${matchId}:`, error);
            return []; // Fallback: Return empty list on failure
        }
    },

    /**
     * Delete the chat history for a match (e.g., when saving to DB finishes)
     * 
     * @param {string} matchId 
     */
    async clearChat(matchId) {
        try {
            const key = this.getKey(matchId);
            await redis.del(key);
            return true;
        } catch (error) {
            console.error(`[Chat Redis] Error clearing chat for match ${matchId}:`, error);
            return false;
        }
    }
};
