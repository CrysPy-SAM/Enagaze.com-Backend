/**
 * Reusable Redis / Valkey Client Service
 *
 * Centralizes lifecycle, connection management, error handling, and status
 * monitoring for the application's shared Redis client.
 */

import Redis from "ioredis";
import { isRedisEnabled, validateRedisConfig, formatSafeRedisError } from "../config/redis.js";

/** @type {Redis|null} */
let sharedClient = null;
let isConnecting = false;

/**
 * Default connection options for the general-purpose application client.
 */
export const DEFAULT_REDIS_CLIENT_OPTIONS = {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10000,
    retryStrategy(times) {
        // Bounded exponential backoff with ceiling at 3000ms
        const delay = Math.min(times * 100, 3000);
        return delay;
    },
};

/**
 * Initializes and establishes connection to Redis when REDIS_ENABLED=true.
 * Idempotent: returns existing connected client if already initialized.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env]
 * @param {Function} [options.clientFactory] - Optional factory function for testing/injection
 * @returns {Promise<Redis|null>}
 */
export async function initRedisClient(options = {}) {
    const env = options.env || process.env;

    if (!isRedisEnabled(env)) {
        return null;
    }

    // Idempotent guard: return active client if already created and usable
    if (sharedClient) {
        if (sharedClient.status === "ready" || sharedClient.status === "connecting") {
            return sharedClient;
        }
    }

    const config = validateRedisConfig(env);

    isConnecting = true;
    let client;
    try {
        if (typeof options.clientFactory === "function") {
            client = options.clientFactory(config);
        } else {
            client = new Redis(config.url, {
                ...DEFAULT_REDIS_CLIENT_OPTIONS,
            });
        }

        // Register default error listener to prevent unhandled EventEmitter errors
        client.on("error", (err) => {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[Redis] Runtime error: ${safeMsg}`);
        });

        // Await connection readiness before accepting traffic
        if (typeof client.connect === "function") {
            await client.connect();
        }

        sharedClient = client;
        isConnecting = false;
        return sharedClient;
    } catch (err) {
        isConnecting = false;
        // Clean up partial client on initialization failure
        if (client) {
            try {
                if (typeof client.disconnect === "function") {
                    client.disconnect();
                } else if (typeof client.quit === "function") {
                    await client.quit();
                }
            } catch (_) {}
        }
        sharedClient = null;

        const safeMsg = formatSafeRedisError(err);
        const wrappedErr = new Error(`Failed to initialize Redis client: ${safeMsg}`);
        wrappedErr.originalError = err;
        throw wrappedErr;
    }
}

/**
 * Retrieves the shared Redis client instance.
 * Returns null if Redis is disabled or not yet initialized.
 *
 * @returns {Redis|null}
 */
export function getRedisClient() {
    return sharedClient;
}

/**
 * Retrieves safe status metadata for health and readiness probes.
 * Never exposes credentials, hostnames, or connection URLs.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, status: string, ready: boolean }}
 */
export function getRedisStatus(env = process.env) {
    const enabled = isRedisEnabled(env);

    if (!enabled) {
        return {
            enabled: false,
            status: "disabled",
            ready: false,
        };
    }

    if (!sharedClient) {
        return {
            enabled: true,
            status: isConnecting ? "connecting" : "disconnected",
            ready: false,
        };
    }

    const clientStatus = sharedClient.status || "unknown";
    const isReady = clientStatus === "ready";

    return {
        enabled: true,
        status: clientStatus,
        ready: isReady,
    };
}

/**
 * Gracefully closes the shared Redis client with a bounded timeout.
 * Idempotent: safe to call repeatedly or when client was never initialized.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=5000] - Maximum milliseconds to wait for clean quit
 * @returns {Promise<void>}
 */
export async function closeRedisClient({ timeoutMs = 5000 } = {}) {
    const client = sharedClient;
    sharedClient = null;
    isConnecting = false;

    if (!client) {
        return;
    }

    try {
        let timedOut = false;
        const quitPromise = new Promise(async (resolve, reject) => {
            try {
                if (typeof client.quit === "function") {
                    await client.quit();
                } else if (typeof client.disconnect === "function") {
                    client.disconnect();
                }
                resolve();
            } catch (quitErr) {
                reject(quitErr);
            }
        });

        const timerPromise = new Promise((resolve) => {
            const t = setTimeout(() => {
                timedOut = true;
                if (typeof client.disconnect === "function") {
                    try {
                        client.disconnect();
                    } catch (_) {}
                }
                resolve();
            }, timeoutMs);
            if (typeof t.unref === "function") {
                t.unref();
            }
        });

        await Promise.race([quitPromise, timerPromise]);
    } catch (err) {
        // Disconnect immediately on error
        try {
            if (typeof client.disconnect === "function") {
                client.disconnect();
            }
        } catch (_) {}
        const safeMsg = formatSafeRedisError(err);
        console.error(`[Redis] Error closing client: ${safeMsg}`);
    }
}

/**
 * Test helper to inject a mock/fake Redis client.
 *
 * @param {any} mock
 */
export function _setClientForTesting(mock) {
    sharedClient = mock;
    isConnecting = false;
}

/**
 * Test helper to reset client state.
 */
export function _resetClientForTesting() {
    sharedClient = null;
    isConnecting = false;
}

