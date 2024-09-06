import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"

const PORT = process.env.PORT ?? 3008
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''

// Map para almacenar la cola de usuarios y los bloqueos
const userQueues = new Map();
const userLocks = new Map(); // Bloqueo de procesamiento por usuario
const userBans = new Map(); // Almacena los usuarios temporalmente bloqueados
const messageLimits = new Map(); // Almacena el contador de mensajes de cada usuario
const MAX_MESSAGES = 20; // Límite de mensajes
const BAN_DURATION = 24 * 60 * 60 * 1000; // Duración del bloqueo (24 horas)

/**
 * Función para verificar si un usuario está bloqueado
 */
const isUserBanned = (userId) => {
    const banEnd = userBans.get(userId);
    if (banEnd && banEnd > Date.now()) {
        return true; // Usuario está bloqueado
    }
    return false; // Usuario no está bloqueado
};

/**
 * Función para bloquear a un usuario por exceder el límite de mensajes
 */
const banUser = (userId) => {
    userBans.set(userId, Date.now() + BAN_DURATION); // Bloquear por 24 horas
    messageLimits.delete(userId); // Resetear el conteo de mensajes
};

/**
 * Función para controlar el límite de mensajes
 */
const rateLimitUser = (userId) => {
    const messageCount = messageLimits.get(userId) || 0;
    if (messageCount >= MAX_MESSAGES) {
        return false; // El usuario excedió el límite de mensajes
    }
    messageLimits.set(userId, messageCount + 1); // Incrementar el conteo de mensajes
    return true;
};

/**
 * Función para procesar el mensaje de usuario
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider); // Inicia el estado de "escribiendo"
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);

    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        // Limpiar el texto, reemplazando los asteriscos dobles por uno solo
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ]/g, "").replace(/\*\*/g, "*");
        await flowDynamic([{ body: cleanedChunk }]);
    }
};

/**
 * Función para manejar la cola de mensajes de un usuario
 */
const handleQueue = async (userId, ctx, provider) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) {
        return; // Si el usuario está bloqueado, no procesar
    }

    // Mantener el estado de "escribiendo" mientras haya mensajes en la cola
    const typingInterval = setInterval(async () => {
        await typing(ctx, provider);
    }, 1000); // Enviar "escribiendo" cada segundo

    while (queue.length > 0) {
        userLocks.set(userId, true); // Bloquear procesamiento mientras se procesa el mensaje
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Liberar el bloqueo
        }
    }

    clearInterval(typingInterval); // Detener el estado de "escribiendo" cuando la cola esté vacía
    userLocks.delete(userId); // Eliminar el bloqueo al terminar
    userQueues.delete(userId); // Eliminar la cola una vez procesados todos los mensajes
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        // Verificar si el usuario está bloqueado
        if (isUserBanned(userId)) {
            console.log(`User ${userId} is banned. Ignoring message.`);
            return; // Ignorar mensajes si el usuario está bloqueado
        }

        // Verificar si excedió el límite de mensajes
        if (!rateLimitUser(userId)) {
            banUser(userId); // Bloquear por exceder el límite
            await flowDynamic([{ body: "Has sido bloqueado temporalmente por exceder el límite de mensajes." }]);
            return;
        }

        // Manejar la cola de mensajes
        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId, ctx, provider); // Agregado parámetro ctx y provider para el typing
        }
    });

/**
 * Función principal para configurar el bot
 */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
    });

    const adapterDB = new MemoryDB();

    adapterProvider.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
            console.error('Connection closed. Reconnecting:', shouldReconnect, lastDisconnect?.error);
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
        } else {
            console.log('Connection update:', update);
        }
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    httpServer(+PORT);
};

main();
