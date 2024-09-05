import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''

// Stores user queues and locks
const userQueues = new Map();
const userLocks = new Map();
const userMessageCounts = new Map(); // Stores message count for rate limiting
const userBanList = new Map(); // Tracks banned users and ban expiration times

/** Function to check if a user is banned */
const isUserBanned = (userId) => {
    const banExpiry = userBanList.get(userId);
    if (!banExpiry) return false; // User is not banned
    if (Date.now() > banExpiry) {
        userBanList.delete(userId); // Ban expired, remove from ban list
        return false;
    }
    return true; // User is still banned
}

/** Function to ban a user */
const banUser = (userId, duration) => {
    const banExpiry = Date.now() + duration;
    userBanList.set(userId, banExpiry);
}

/** Function to check rate limits and apply bans */
const rateLimitUser = (userId) => {
    const currentCount = userMessageCounts.get(userId) ?? 0;
    const newCount = currentCount + 1;
    userMessageCounts.set(userId, newCount);

    if (newCount > 30) {
        return false; // Exceeds rate limit
    }
    return true; // Within rate limit
}

/** Function to process the user's message by sending it to the OpenAI API and sending the response back to the user. */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);

    // Remove special characters and send response
    const cleanedResponse = response.replace(/\[.*?\]|\*\*/g, "").replace(/\*\*/g, "*");
    const chunks = cleanedResponse.split(/\n\n+/);

    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim();
        await flowDynamic([{ body: cleanedChunk }]);
    }
}

/** Function to handle the queue for each user. */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) {
        return; // If locked, skip processing
    }

    while (queue.length > 0) {
        userLocks.set(userId, true); // Lock the queue
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Release the lock
        }
    }

    userLocks.delete(userId); // Remove the lock once all messages are processed
    userQueues.delete(userId); // Remove the queue once all messages are processed
}

/** Flujo de bienvenida que maneja las respuestas del asistente de IA */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        if (isUserBanned(userId)) {
            return; // Ignore banned users
        }

        if (!rateLimitUser(userId)) {
            banUser(userId, 60 * 60 * 1000); // Ban for 1 hour
            await flowDynamic([{ body: "You have been temporarily banned for exceeding the message limit." }]);
            return;
        }

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        // If this is the only message in the queue, process it immediately
        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });

/** Función principal que configura y inicia el bot */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
    });

    const adapterDB = new MemoryDB();

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    httpServer(+PORT);
}

main();
