import { PrismaClient } from './src/generated/prisma/index.js';
const prisma = new PrismaClient();
async function main() {
    try {
        await prisma.$executeRawUnsafe(`ALTER TYPE "GameStatus" ADD VALUE IF NOT EXISTS 'MATCHED';`);
        console.log("Enum 'MATCHED' added successfully!");
    } catch (err) {
        console.error("Error altering type:", err);
    }
}
main().finally(() => prisma.$disconnect());
