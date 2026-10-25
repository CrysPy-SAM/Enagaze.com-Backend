/**
 * Dedicated Socket.IO Redis Adapter Service
 *
 * Centralizes lifecycle, dedicated pub/sub connection management, error handling,
 * and status monitoring for the @socket.io/redis-adapter integration.
 *
 * Notice: Redis Pub/Sub requires two dedicated connection instances (pubClient and subClient).
 * These must be separate from the general-purpose application client (sharedClient) because
 * once a Redis connection issues SUBSCRIBE, it enters subscriber mode and cannot execute
 * general application commands.
 */

import Redis from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import {
    isSocketRedisAdapterEnabled,
    validateSocketRedisAdapterConfig,
    formatSafeRedisError,
} from "../config/redis.js";
import { DEFAULT_REDIS_CLIENT_OPTIONS } from "./redis.service.js";

/** @type {Redis|null} */
let pubClient = null;

/** @type {Redis|null} */
let subClient = null;

/** @type {any|null} */
let adapterInstance = null;

let isConnecting = false;

/**
 * Initializes dedicated pub and sub clients and attaches the Redis adapter to Socket.IO.
 * Idempotent: returns existing connected adapter if already initialized.
 *
 * @param {import("socket.io").Server} io - Socket.IO Server instance
 * @param {Object} [options]
 * @param {Object} [options.env=process.env]
 * @param {Function} [options.clientFactory] - Optional factory for test injection: (role, config) => Redis
 * @returns {Promise<{ pubClient: Redis, subClient: Redis, adapter: any } | null>}
 */
export async function initSocketRedisAdapter(io, options = {}) {
    const env = options.env || process.env;

    if (!isSocketRedisAdapterEnabled(env)) {
        return null;
    }

    // Idempotent guard: return existing instances if already ready
    if (pubClient && subClient && adapterInstance) {
        if (pubClient.status === "ready" && subClient.status === "ready") {
            return { pubClient, subClient, adapter: adapterInstance };
        }
    }

    const config = validateSocketRedisAdapterConfig(env);
    isConnecting = true;

    let createdPub = null;
    let createdSub = null;

    try {
        if (typeof options.clientFactory === "function") {
            createdPub = options.clientFactory("pub", config);
            createdSub = options.clientFactory("sub", config);
        } else {
            createdPub = new Redis(config.redisConfig.url, {
                ...DEFAULT_REDIS_CLIENT_OPTIONS,
            });
            createdSub = new Redis(config.redisConfig.url, {
                ...DEFAULT_REDIS_CLIENT_OPTIONS,
            });
        }

        // Attach safe error listeners immediately to prevent unhandled EventEmitter errors
        createdPub.on("error", (err) => {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[Socket.IO Redis Pub] Runtime error: ${safeMsg}`);
        });

        createdSub.on("error", (err) => {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[Socket.IO Redis Sub] Runtime error: ${safeMsg}`);
        });

        // Await connection readiness concurrently on both clients
        const connectPromises = [];
        if (typeof createdPub.connect === "function") {
            connectPromises.push(createdPub.connect());
        }
        if (typeof createdSub.connect === "function") {
            connectPromises.push(createdSub.connect());
        }

        if (connectPromises.length > 0) {
            await Promise.all(connectPromises);
        }

        // Create the adapter with the configured channel key prefix
        const adapter = createAdapter(createdPub, createdSub, {
            key: config.key,
        });

        if (io && typeof io.adapter === "function") {
            io.adapter(adapter);
        }

        pubClient = createdPub;
        subClient = createdSub;
        adapterInstance = adapter;
        isConnecting = false;

        return { pubClient, subClient, adapter: adapterInstance };
    } catch (err) {
        isConnecting = false;
        // Clean up partially opened clients on failure
        const cleanupPromises = [];
        for (const client of [createdPub, createdSub]) {
            if (client) {
                try {
                    if (typeof client.disconnect === "function") {
                        client.disconnect();
                    } else if (typeof client.quit === "function") {
                        cleanupPromises.push(client.quit().catch(() => {}));
                    }
                } catch (_) {}
            }
        }
        if (cleanupPromises.length > 0) {
            await Promise.allSettled(cleanupPromises);
        }

        pubClient = null;
        subClient = null;
        adapterInstance = null;

        const safeMsg = formatSafeRedisError(err);
        const wrappedErr = new Error(`Failed to initialize Socket.IO Redis adapter: ${safeMsg}`);
        wrappedErr.originalError = err;
        throw wrappedErr;
    }
}

/**
 * Retrieves the current Socket.IO Redis adapter clients and instance.
 *
 * @returns {{ pubClient: Redis|null, subClient: Redis|null, adapter: any|null }}
 */
export function getSocketRedisAdapterClients() {
    return { pubClient, subClient, adapter: adapterInstance };
}

/**
 * Retrieves safe status metadata for health and readiness probes.
 * Returns ready=true ONLY when both pubClient and subClient report status="ready".
 * Never exposes connection URLs or credentials.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, ready: boolean, status: string, pubStatus: string, subStatus: string }}
 */
export function getSocketRedisAdapterStatus(env = process.env) {
    const enabled = isSocketRedisAdapterEnabled(env);

    if (!enabled) {
        return {
            enabled: false,
            ready: false,
            status: "disabled",
            pubStatus: "disabled",
            subStatus: "disabled",
        };
    }

    if (!pubClient || !subClient) {
        return {
            enabled: true,
            ready: false,
            status: isConnecting ? "connecting" : "disconnected",
            pubStatus: "disconnected",
            subStatus: "disconnected",
        };
    }

    const pubStatus = pubClient.status || "unknown";
    const subStatus = subClient.status || "unknown";
    const isReady = pubStatus === "ready" && subStatus === "ready";

    return {
        enabled: true,
        ready: isReady,
        status: isReady ? "ready" : (pubStatus !== "ready" ? pubStatus : subStatus),
        pubStatus,
        subStatus,
    };
}

/**
 * Gracefully closes both dedicated adapter Redis clients with a bounded timeout.
 * Idempotent: safe to call repeatedly or when adapter was never initialized.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=5000] - Maximum milliseconds to wait for clean quit
 * @returns {Promise<void>}
 */
export async function closeSocketRedisAdapter({ timeoutMs = 5000 } = {}) {
    const clientsToClose = [pubClient, subClient].filter(Boolean);
    pubClient = null;
    subClient = null;
    adapterInstance = null;
    isConnecting = false;

    if (clientsToClose.length === 0) {
        return;
    }

    try {
        const quitPromises = clientsToClose.map(async (client) => {
            try {
                if (typeof client.quit === "function") {
                    await client.quit();
                } else if (typeof client.disconnect === "function") {
                    client.disconnect();
                }
            } catch (err) {
                if (typeof client.disconnect === "function") {
                    try {
                        client.disconnect();
                    } catch (_) {}
                }
            }
        });

        const timerPromise = new Promise((resolve) => {
            const t = setTimeout(() => {
                for (const client of clientsToClose) {
                    if (typeof client.disconnect === "function") {
                        try {
                            client.disconnect();
                        } catch (_) {}
                    }
                }
                resolve();
            }, timeoutMs);
            if (typeof t.unref === "function") {
                t.unref();
            }
        });

        await Promise.race([Promise.allSettled(quitPromises), timerPromise]);
    } catch (err) {
        for (const client of clientsToClose) {
            try {
                if (typeof client.disconnect === "function") {
                    client.disconnect();
                }
            } catch (_) {}
        }
        const safeMsg = formatSafeRedisError(err);
        console.error(`[Socket.IO Redis Adapter] Error closing clients: ${safeMsg}`);
    }
}

/**
 * Test helper to inject mock clients for unit testing.
 *
 * @param {Object} mocks
 * @param {any} [mocks.pubClient]
 * @param {any} [mocks.subClient]
 * @param {any} [mocks.adapter]
 */
export function _setClientsForTesting({ pubClient: pub = null, subClient: sub = null, adapter = null } = {}) {
    pubClient = pub;
    subClient = sub;
    adapterInstance = adapter;
    isConnecting = false;
}

/**
 * Test helper to reset adapter state.
 */
export function _resetAdapterForTesting() {
    pubClient = null;
    subClient = null;
    adapterInstance = null;
    isConnecting = false;
}

