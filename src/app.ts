import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
const userQueues = new Map();
const userLocks = new Map();
const userMessageCount = new Map();
const userBanList = new Map(); // Holds user bans with expiry times
const MAX_MESSAGES_PER_DAY = 20;
const BAN_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/** Function to rate-limit users */
const rateLimitUser = (userId) => {
    const currentTime = Date.now();
    const userStats = userMessageCount.get(userId) || { count: 0, firstMessageTime: currentTime };

    if (currentTime - userStats.firstMessageTime > 24 * 60 * 60 * 1000) {
        // Reset the count if more than 24 hours have passed
        userStats.count = 1;
        userStats.firstMessageTime = currentTime;
    } else {
        userStats.count += 1;
    }

    userMessageCount.set(userId, userStats);

    return userStats.count <= MAX_MESSAGES_PER_DAY;
};

/** Function to ban a user for a specified duration */
const banUser = (userId, duration) => {
    const banExpiry = Date.now() + duration;
    userBanList.set(userId, banExpiry);
};

/** Function to check if a user is banned */
const isUserBanned = (userId) => {
    const banExpiry = userBanList.get(userId);
    if (!banExpiry) return false; // User is not banned
    if (Date.now() > banExpiry) {
        userBanList.delete(userId); // Ban expired, remove from ban list
        return false;
    }
    return true; // User is still banned
};

/** Function to process the user's message by sending it to the OpenAI API and sending the response back to the user */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);

    // Split the response into chunks and send them sequentially
    const cleanedResponse = response
        .replace(/\[.*?\]/g, "") // Removes text inside brackets []
        .replace(/\*\*(.*?)\*\*/g, "*$1*"); // Converts **text** to *text*

    const chunks = cleanedResponse.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim();
        await flowDynamic([{ body: cleanedChunk }]);
    }
};

/** Function to handle the queue for each user */
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
};

/** Flujo de bienvenida que maneja las respuestas del asistente de IA */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; // Use the user's ID to create a unique queue for each user

        if (isUserBanned(userId)) {
            return; // User is banned, don't process or queue the message
        }

        if (!rateLimitUser(userId)) {
            banUser(userId, BAN_DURATION); // Ban for 24 hours
            await flowDynamic([{ body: "Haz abusado del servicio, estas baneado por 24 horas." }]);
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
};

main();
