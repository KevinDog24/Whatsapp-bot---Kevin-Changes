// Import required dependencies and configurations
import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"

// Define constant values
const PORT = process.env.PORT ?? 3008
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''

// Define interfaces for type safety
interface UserMessageInfo {
    count: number;
    firstMessageTime: number;
    queue: any[];
    processing: boolean;
    bannedNotified: boolean; // New flag to track if the user was notified
}

interface RateLimitResult {
    allowed: boolean;
    count: number;
    timeUntilReset: number;
}

// Custom LRU Cache implementation to track recent usage and automatically evict the least recently used entries.
class SimpleLRUCache<K, V> {
    private cache: Map<K, V>;
    private capacity: number;

    constructor(capacity: number) {
        this.cache = new Map();
        this.capacity = capacity;
    }

    /**
     * Get a value from the cache and mark it as recently used
     * @param key - The key to get from the cache
     * @returns The cached value or undefined if not found
     */
    get(key: K): V | undefined {
        if (!this.cache.has(key)) {
            return undefined;
        }
        const value = this.cache.get(key)!;
        this.cache.delete(key); // Remove the old entry
        this.cache.set(key, value); // Reinsert to mark it as recently used
        return value;
    }

    /**
     * Add a value to the cache
     * If the cache exceeds the capacity, remove the least recently used item
     * @param key - The key to add or update
     * @param value - The value to cache
     */
    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key); // Remove the old entry if it exists
        } else if (this.cache.size >= this.capacity) {
            // Remove the least recently used (first) entry
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value); // Add the new entry
    }

    /**
     * Check if the cache contains a key
     * @param key - The key to check
     * @returns True if the cache contains the key, false otherwise
     */
    has(key: K): boolean {
        return this.cache.has(key);
    }

    /**
     * Clear the cache
     */
    clear(): void {
        this.cache.clear();
    }
}

// Initialize the user message information cache with a limit of 1000 users
const userMessageInfo = new SimpleLRUCache<string, UserMessageInfo>(1000);

// Define rate limiting constants
const MAX_MESSAGES = 20;
const RESET_PERIOD = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const NOTIFICATION_THRESHOLD = 15;

/**
 * Applies rate limiting to user messages.
 * 
 * - This function tracks how many messages a specific user has sent within the
 *   current 24-hour period. If the user exceeds the limit of MAX_MESSAGES, they
 *   are prevented from sending more messages until the reset period (24 hours) elapses.
 * - It stores user-specific data (message count and first message timestamp) 
 *   in a cache (userMessageInfo).
 * 
 * @param userId - The unique identifier of the user (typically their WhatsApp number)
 * @returns An object that includes whether the user is allowed to send messages,
 *          how many messages they have sent, and how much time remains before 
 *          the limit resets.
 */
const rateLimitUser = (userId: string): RateLimitResult => {
    const now = Date.now();
    let userInfo = userMessageInfo.get(userId);

    // If user info is not present or their reset period has passed, initialize/reset their data
    if (!userInfo || (now - userInfo.firstMessageTime) >= RESET_PERIOD) {
        userInfo = { 
            count: 0, 
            firstMessageTime: now, 
            queue: [], 
            processing: false, 
            bannedNotified: false // Initialize bannedNotified
        };
        userMessageInfo.set(userId, userInfo); // Set userInfo in cache
        console.log(`User ${userId} has been unbanned.`);
    }

    const timeUntilReset = RESET_PERIOD - (now - userInfo.firstMessageTime);

    if (userInfo.count >= MAX_MESSAGES) {
        if (!userInfo.bannedNotified) {
            console.log(`User ${userId} is banned. Time until reset: ${timeUntilReset} ms`);
            userInfo.bannedNotified = true; // Notify the user only once
            userMessageInfo.set(userId, userInfo); // Update userInfo in cache
            return { allowed: false, count: userInfo.count, timeUntilReset };
        }
        return { allowed: false, count: userInfo.count, timeUntilReset };
    }

    // Increment message count and reset bannedNotified flag if user is within limits
    userInfo.count++;
    userInfo.bannedNotified = false; // Reset the notification flag
    userMessageInfo.set(userId, userInfo); // Update userInfo in cache

    console.log(`User ${userId} message count: ${userInfo.count}`);
    return { allowed: true, count: userInfo.count, timeUntilReset };
}

/**
 * Formats the remaining time until rate limit reset
 * - Converts the remaining time from milliseconds into a human-readable format
 *   (hours).
 * 
 * @param milliseconds - Time in milliseconds
 * @returns Formatted time string
 */
const formatTimeRemaining = (milliseconds: number): string => {
    const hours = Math.floor(milliseconds / (1000 * 60 * 60));
    return `${hours} hora${hours !== 1 ? 's' : ''}`;
}

/**
 * Returns the notification message for approaching rate limit
 * - This function generates a message that warns the user when they have
 *   reached the threshold of message usage (NOTIFICATION_THRESHOLD).
 * 
 * @returns Notification message string
 */
const getNotificationMessage = (): string => {
    return `Debido a que es un servicio gratuito actualmente tenemos un limite de ${MAX_MESSAGES} mensajes por cada 24-horas. Haz usado ${NOTIFICATION_THRESHOLD} mensajes, te quedan 5 interacciones en este periodo.`;
}

/**
 * Returns the message for when rate limit is reached
 * - This function generates a message for when the user has reached their
 *   daily message limit and provides the time until the reset.
 * 
 * @param timeUntilReset - Time until rate limit resets
 * @returns Rate limit reached message string
 */
const getLimitReachedMessage = (timeUntilReset: number): string => {
    const formattedTime = formatTimeRemaining(timeUntilReset);
    return `Haz alcanzado el limite de mensajes. Por favor regresa en ${formattedTime} para continuar ayudandote. Esperamos verte pronto!`;
}

/**
 * Processes a user message by sending it to the AI assistant and returning the response
 * 
 * - This function sends the user's message to the AI assistant using the `toAsk` function.
 * - The response from the AI assistant is split into chunks to be sent back to the user 
 *   in a more readable format.
 * - Any error encountered during the message processing is caught and handled gracefully.
 * 
 * @param ctx - The context object containing message details
 * @param flowDynamic - Function to send dynamic responses
 * @param state - The current state object
 * @param provider - The message provider
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    try {
        await typing(ctx, provider);

        const response = await toAsk(ASSISTANT_ID, ctx.body, state);

        if (!response) {
            throw new Error("Ups, parece que el servicio de nuestra IA no esta disponible, lo estamos revisando.");
        }

        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk
                .trim()
                .replace(/【.*?】/g, "")
                .replace(/\*\*/g, "*")
                .replace(/\n-\s/g, "\n");
            
            await flowDynamic([{ body: cleanedChunk }]);
        }

        console.log(`Message processed successfully for user ${ctx.from}`);
    } catch (error) {
        console.error(`Error processing message for user ${ctx.from}:`, error);
        await flowDynamic([{ body: "Una disculpa, ocurrio un error mientras procesaba tu mensaje. Por favor intentalo nuevamente." }]);
    }
};

/**
 * Handles the message queue for a user
 * 
 * - This function ensures that messages for a user are processed in order.
 * - If a message is already being processed, further messages are queued.
 * - Typing indicators are simulated periodically while processing.
 * 
 * @param userId - The unique identifier for the user
 * @param ctx - The context object containing message details
 * @param provider - The message provider
 */
const handleQueue = async (userId, ctx, provider) => {
    const userInfo = userMessageInfo.get(userId);
    const queue = userInfo?.queue || [];
    if (userInfo?.processing) {
        return;
    }

    const typingInterval = setInterval(async () => {
        await typing(ctx, provider);
    }, 1000);

    while (queue.length > 0) {
        userInfo.processing = true;
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
            await flowDynamic([{ body: "Una disculpa, ocurrio un error mientras procesaba tu mensaje. Por favor intentalo nuevamente." }]);
        } finally {
            userInfo.processing = false;
        }
    }

    clearInterval(typingInterval);
    userInfo.queue = []; // Ensure this is done after processing
    userMessageInfo.set(userId, userInfo); // Save the updated userInfo back into the cache
};

// Define the welcome flow for the chatbot
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        try {
            // Apply rate limiting to the user
            const rateLimitResult = rateLimitUser(userId);

            // If user exceeds the rate limit, notify them
            if (!rateLimitResult.allowed) {
                await flowDynamic([{ body: getLimitReachedMessage(rateLimitResult.timeUntilReset) }]);
                return;
            }

            // Notify user if they are close to the rate limit threshold
            if (rateLimitResult.count === NOTIFICATION_THRESHOLD) {
                await flowDynamic([{ body: getNotificationMessage() }]);
            }

            // Initialize or update user information
            if (!userMessageInfo.has(userId)) {
                userMessageInfo.set(userId, { 
                    count: rateLimitResult.count, 
                    firstMessageTime: Date.now(), 
                    queue: [], 
                    processing: false, 
                    bannedNotified: false
                });
            }
            

            const userInfo = userMessageInfo.get(userId);
            userInfo.queue.push({ ctx, flowDynamic, state, provider });

            // Process the queue if it's not already being processed
            if (!userInfo.processing && userInfo.queue.length === 1) {
                await handleQueue(userId, ctx, provider);
            }
        } catch (error) {
            console.error(`Error in welcome flow for user ${userId}:`, error);
            await flowDynamic([{ body: "Una disculpa, ocurrio un error mientras procesaba tu mensaje. Por favor intentalo nuevamente." }]);
        }
    });

/**
 * Main function to set up and run the chatbot
 */
const main = async () => {
    try {
        // Create flow, provider, and database adapters
        const adapterFlow = createFlow([welcomeFlow]);
        const adapterProvider = createProvider(BaileysProvider, {
            groupsIgnore: true,
            readStatus: false,
        });
        const adapterDB = new MemoryDB();

        // Set up connection event listener
        adapterProvider.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
                console.error('Connection closed. Reconnecting:', shouldReconnect, 'Error:', lastDisconnect?.error);
            } else if (connection === 'open') {
                console.log('✅ Connected to WhatsApp');
            } else {
                console.log('Connection update:', update);
            }
        });

        // Create and start the bot
        const { httpServer } = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        // Inject HTTP server and start listening on the specified port
        httpInject(adapterProvider.server);
        httpServer(+PORT);

        console.log(`Bot started and listening on port ${PORT}`);
    } catch (error) {
        console.error('Failed to start the bot:', error);
        process.exit(1);
    }
};

// Run the main function
main();
