/**
 * Distributed Rate Limiting Service (Phase 3D)
 *
 * Provides distributed rate limiting across horizontally scaled Node.js backend
 * instances using Redis/Valkey:
 * 1. Backing store for express-rate-limit via rate-limit-redis (RedisStore).
 * 2. Distinct, isolated key prefixes per policy to prevent counter collisions.
 * 3. Atomic sliding-window rate limiting for Socket.IO actions via Redis Sorted Sets (ZSET).
 * 4. Safe Redis failure handling (fail-closed, sanitized error reporting, no leaked credentials).
 * 5. Lifecycle management: startup validation, readiness reporting, and graceful shutdown.
 */

import { RedisStore } from "rate-limit-redis";
import { getRedisClient } from "./redis.service.js";
import {
    isRateLimitRedisEnabled,
    validateRateLimitRedisConfig,
    formatSafeRedisError,
} from "../config/redis.js";

// =============================================================================
// Service State & Testing Overrides
// =============================================================================

let redisClientOverride = null;
let isServiceReady = false;

// Cache of initialized RedisStore instances per policy
const storeCache = new Map();

// =============================================================================
// Atomic Lua Script for Socket Sliding-Window Rate Limiting
// =============================================================================

/**
 * Sliding Window Rate Limiting Lua Script:
 * 1. Purges expired timestamps older than (nowMs - windowMs).
 * 2. Counts requests remaining in the sliding window.
 * 3. If count >= maxRequests, updates TTL and returns 0 (rate-limited).
 * 4. If count < maxRequests, adds current timestamp with unique seq, updates TTL, returns 1 (allowed).
 */
export const SOCKET_SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local keyTtlSec = tonumber(ARGV[4])

local windowStart = nowMs - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local currentHits = redis.call('ZCARD', key)

if currentHits >= maxRequests then
    redis.call('EXPIRE', key, keyTtlSec)
    return 0
else
    local seqKey = key .. ':seq'
    local seq = redis.call('INCR', seqKey)
    redis.call('EXPIRE', seqKey, keyTtlSec)
    redis.call('ZADD', key, nowMs, tostring(nowMs) .. ':' .. tostring(seq))
    redis.call('EXPIRE', key, keyTtlSec)
    return 1
end
`;

// =============================================================================
// Client & Key Helpers
// =============================================================================

export const getEffectiveRateLimitClient = () => {
    return redisClientOverride || getRedisClient();
};

export const getRateLimitPrefix = (policyName = "generic") => {
    const config = validateRateLimitRedisConfig();
    const basePrefix = config.keyPrefix || "engaze:ratelimit";
    return `${basePrefix}:${policyName}:`;
};

// =============================================================================
// Service Lifecycle
// =============================================================================

/**
 * Initializes the Distributed Rate Limiting Service.
 * Validates configuration and verifies client connectivity.
 */
export const initRateLimitRedisService = async ({ redisClient } = {}) => {
    const config = validateRateLimitRedisConfig();
    if (!config.enabled) {
        isServiceReady = false;
        return { enabled: false, ready: false };
    }

    const client = redisClient || getEffectiveRateLimitClient();
    if (!client) {
        throw new Error("Rate Limit Redis Service initialization failed: Redis client unavailable.");
    }

    if (client.status && client.status !== "ready" && client.status !== "connect") {
        throw new Error(`Rate Limit Redis Service initialization failed: client status is ${client.status}.`);
    }

    isServiceReady = true;
    return { enabled: true, ready: true };
};

/**
 * Closes and resets the Rate Limit Redis Service cleanly.
 */
export const closeRateLimitRedisService = async () => {
    isServiceReady = false;
    storeCache.clear();
    return { enabled: isRateLimitRedisEnabled(), ready: false };
};

/**
 * Returns current health and readiness status of the rate limiting service.
 */
export const getRateLimitRedisStatus = () => {
    const enabled = isRateLimitRedisEnabled();
    if (!enabled) {
        return { enabled: false, ready: true, status: "disabled" };
    }
    const client = getEffectiveRateLimitClient();
    const isClientReady = Boolean(client && (client.status === "ready" || client.status === "connect" || !client.status));
    const ready = isServiceReady && isClientReady;
    return {
        enabled: true,
        ready,
        status: ready ? "ready" : "disconnected",
    };
};

// =============================================================================
// Store Creation for express-rate-limit
// =============================================================================

/**
 * Creates a fresh RedisStore for express-rate-limit with a distinct policy prefix.
 *
 * @param {string} policyName - Identifier for the policy (e.g. 'global', 'login_ip', 'photo_upload')
 * @returns {RedisStore}
 */
export const createRedisStore = (policyName) => {
    const prefix = getRateLimitPrefix(policyName);

    const store = new RedisStore({
        sendCommand: async (command, ...args) => {
            const client = getEffectiveRateLimitClient();
            if (!client || (client.status && client.status !== "ready" && client.status !== "connect")) {
                throw new Error("Redis client unavailable for rate limiting");
            }
            if (typeof client.call === "function") {
                return await client.call(command, ...args);
            }
            if (typeof client.sendCommand === "function") {
                return await client.sendCommand([command, ...args]);
            }
            throw new Error("Redis client does not support call or sendCommand");
        },
        prefix,
    });

    // Suppress floating unhandled rejections from background script loading on cold/disconnected start
    if (store.incrementScriptSha && typeof store.incrementScriptSha.catch === "function") {
        store.incrementScriptSha.catch(() => {});
    }
    if (store.getScriptSha && typeof store.getScriptSha.catch === "function") {
        store.getScriptSha.catch(() => {});
    }

    return store;
};

export const getOrCreateRedisStore = createRedisStore;

// =============================================================================
// Socket Sliding-Window Rate Limiting
// =============================================================================

/**
 * Distributed sliding-window rate limiter for Socket.IO actions.
 *
 * @param {string} key - Rate limit key (e.g. `${socket.id}:chat:send` or `${userId}:action`)
 * @param {number} maxRequests - Max requests allowed in the window
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Promise<boolean>} - true if allowed, false if rate limited
 */
export const checkSocketRateLimitRedis = async (key, maxRequests, windowMs) => {
    const client = getEffectiveRateLimitClient();
    if (!client) {
        console.error("[RateLimit:socket] Redis client unavailable; failing closed for safety.");
        return false;
    }

    const prefix = getRateLimitPrefix("socket");
    const redisKey = `${prefix}${key}`;
    const nowMs = Date.now();
    const keyTtlSec = Math.max(2, Math.ceil((windowMs * 2) / 1000));

    try {
        let result;
        if (typeof client.eval === "function") {
            result = await client.eval(
                SOCKET_SLIDING_WINDOW_LUA,
                1,
                redisKey,
                nowMs,
                windowMs,
                maxRequests,
                keyTtlSec
            );
        } else if (typeof client.call === "function") {
            result = await client.call(
                "EVAL",
                SOCKET_SLIDING_WINDOW_LUA,
                "1",
                redisKey,
                nowMs.toString(),
                windowMs.toString(),
                maxRequests.toString(),
                keyTtlSec.toString()
            );
        } else {
            throw new Error("Redis client does not support eval or call");
        }

        return result === 1;
    } catch (err) {
        const safeMsg = formatSafeRedisError(err);
        console.error(`[RateLimit:socket] Redis error: ${safeMsg}. Failing closed for security.`);
        return false; // Fail-closed to protect against unmetered flooding
    }
};

/**
 * Clears rate limit keys for a given socketId in Redis.
 *
 * @param {string} socketId
 */
export const clearSocketRateLimitsRedis = async (socketId) => {
    if (!socketId) return;
    const client = getEffectiveRateLimitClient();
    if (!client) return;

    // Keys naturally expire within seconds via keyTtlSec.
    // If client supports scan/keys or specific known actions, delete them.
    const knownActions = ["join-queue", "consent", "media-ready", "signal", "next", "chat:join", "chat:send", "chat:read", "chat:typing"];
    const prefix = getRateLimitPrefix("socket");
    const keys = knownActions.map((act) => `${prefix}${socketId}:${act}`);
    const seqKeys = knownActions.map((act) => `${prefix}${socketId}:${act}:seq`);

    try {
        if (typeof client.del === "function") {
            await client.del(...keys, ...seqKeys);
        } else if (typeof client.call === "function") {
            await client.call("DEL", ...keys, ...seqKeys);
        }
    } catch (_) {}
};

// =============================================================================
// Testing Inspection Helpers
// =============================================================================

export const _testingRateLimitRedis = {
    setClient: (client) => {
        redisClientOverride = client;
        isServiceReady = Boolean(client);
        storeCache.clear();
    },
    resetClient: () => {
        redisClientOverride = null;
        isServiceReady = false;
        storeCache.clear();
    },
    clearStoreCache: () => storeCache.clear(),
};
