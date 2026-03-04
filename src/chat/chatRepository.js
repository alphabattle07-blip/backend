import { prisma } from '../utils/prisma.js';
import { chatRedis } from './chatRedis.js';

export const chatRepository = {
    /**
     * Persists match chat history from Redis to Supabase
     * and clears the Redis cache. Called when a match ends.
     * 
     * @param {string} matchId The ID of the match that ended
     */
    async persistMatchChat(matchId) {
        try {
            console.log(`[Chat Repository] Archiving chat for match ${matchId}...`);

            // 1. Fetch messages from Redis
            const messages = await chatRedis.getRecentMessages(matchId);

            if (!messages || messages.length === 0) {
                console.log(`[Chat Repository] No chat messages to archive for match ${matchId}.`);
                // Clean up Redis key
                await chatRedis.clearChat(matchId);
                return true;
            }

            // 2. Prepare Bulk Insert Query
            // Since we need a dynamic number of rows, we build parameterized placeholders for Prisma
            const values = [];
            const placeholders = [];
            let paramIndex = 1;

            for (const msg of messages) {
                placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
                values.push(
                    matchId,
                    msg.senderId,
                    msg.message,
                    // Prisma raw accepts JS Date objects for Postgres TIMESTAMPTZ
                    new Date(msg.timestamp)
                );
            }

            const query = `
                INSERT INTO public.match_chats (match_id, sender_id, message, created_at)
                VALUES ${placeholders.join(', ')}
            `;

            // 3. Bulk insert into Supabase via Prisma's executeRawUnsafe
            await prisma.$executeRawUnsafe(query, ...values);

            console.log(`[Chat Repository] Successfully archived ${messages.length} messages for match ${matchId}.`);

            // 4. Delete Redis key after successful insert
            await chatRedis.clearChat(matchId);
            return true;

        } catch (error) {
            console.error(`[Chat Repository] 🚨 Failed to persist chat for match ${matchId}:`, error);
            // 5. Fail safely: Do not crash the game server. 
            // By NOT clearing the Redis chat here, we give it a chance to be read 
            // if we implement a retry mechanism later, or it will just naturally expire 
            // via the 2-hour TTL set during saveMessage.
            return false;
        }
    }
};
