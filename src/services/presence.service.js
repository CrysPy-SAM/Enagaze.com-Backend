/**
 * Presence Service for Engaze
 *
 * Provides:
 * 1. Multi-tab / multi-device active socket connection tracking per user.
 * 2. Grace period on disconnect to prevent UI flicker on page reload / tab switch.
 * 3. WhatsApp-style reciprocal privacy evaluation for Last Seen and Online status.
 * 4. Phase 3C.1: Distributed Redis/Valkey-backed presence state with expiring leases,
 *    atomic Lua transitions, background renewal, and safe multi-instance broadcast coordination.
 */

import { getRedisClient } from "./redis.service.js";
import {
    isPresenceRedisEnabled,
    validatePresenceRedisConfig,
    formatSafeRedisError,
} from "../config/redis.js";

// =============================================================================
// State & Registries
// =============================================================================

// In-memory mapping of active sockets (used when PRESENCE_REDIS_ENABLED is false):
// userId (string) -> Set<socketId>
const activeSocketsByUser = new Map();

// In-memory mapping of disconnect grace timers: userId (string) -> timerHandle
const disconnectTimers = new Map();

// Local process socket lease registry (used when PRESENCE_REDIS_ENABLED is true):
// socketId (string) -> { userId: string, lastRenewedAt: number }
const localProcessSockets = new Map();

// Background lease renewal timer handle for local sockets
let renewalIntervalTimer = null;

// Test/injection override client
let redisClientOverride = null;

// =============================================================================
// Lua Scripts for Atomic Redis State Transitions
// =============================================================================

/**
 * Atomic userConnected Lua Script:
 * 1. Purges stale/expired socket leases for this user.
 * 2. Counts active sockets BEFORE adding the new one.
 * 3. Inserts or updates the new socket's expiring lease.
 * 4. Sets key TTL to auto-expire if abandoned.
 * 5. Returns 1 if user was previously offline (prevCount == 0), else 0.
 */
const USER_CONNECTED_LUA = `
local key = KEYS[1]
local socketId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local expiresAtMs = tonumber(ARGV[3])
local keyTtlSec = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
local prevCount = redis.call('ZCARD', key)
redis.call('ZADD', key, expiresAtMs, socketId)
redis.call('EXPIRE', key, keyTtlSec)

if prevCount == 0 then
    return 1
else
    return 0
end
`;

/**
 * Atomic userDisconnected Lua Script:
 * 1. Removes the disconnecting socket.
 * 2. Purges stale/expired socket leases for this user.
 * 3. Counts remaining active sockets across ALL instances.
 * 4. Sets key TTL.
 * 5. Returns remaining active socket count.
 */
const USER_DISCONNECTED_LUA = `
local key = KEYS[1]
local socketId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local keyTtlSec = tonumber(ARGV[3])

redis.call('ZREM', key, socketId)
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
local remaining = redis.call('ZCARD', key)
redis.call('EXPIRE', key, keyTtlSec)

return remaining
`;

/**
 * Atomic isUserOnline Lua Script:
 * 1. Purges stale/expired socket leases for this user.
 * 2. Counts remaining active sockets.
 * 3. Returns 1 if count > 0, else 0.
 */
const IS_USER_ONLINE_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])

redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
local count = redis.call('ZCARD', key)

if count > 0 then
    return 1
else
    return 0
end
`;

// =============================================================================
// Helper Functions
// =============================================================================

export const getDisconnectGraceMs = () => {
    if (process.env.PRESENCE_GRACE_MS) {
        const parsed = parseInt(process.env.PRESENCE_GRACE_MS, 10);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) {
        return 100;
    }
    return 5000;
};

const getEffectiveRedisClient = (env = process.env) => {
    return redisClientOverride || getRedisClient();
};

const getUserSocketsKey = (prefix, userId) => {
    return `${prefix}:user:{${userId.toString()}}:sockets`;
};

/**
 * Background task to renew expiring leases for sockets owned by THIS process.
 */
const renewLocalSockets = async () => {
    if (localProcessSockets.size === 0) return;

    const env = process.env;
    if (!isPresenceRedisEnabled(env)) return;

    let config;
    try {
        config = validatePresenceRedisConfig(env);
    } catch (_) {
        return;
    }

    const client = getEffectiveRedisClient(env);
    if (!client || client.status !== "ready") return;

    const now = Date.now();
    const expiresAt = now + config.leaseTtlMs;
    const ttlSeconds = Math.ceil((config.leaseTtlMs * 2) / 1000);

    try {
        if (typeof client.pipeline === "function") {
            const pipeline = client.pipeline();
            for (const [socketId, entry] of localProcessSockets.entries()) {
                const key = getUserSocketsKey(config.keyPrefix, entry.userId);
                pipeline.zadd(key, expiresAt, socketId);
                pipeline.expire(key, ttlSeconds);
            }
            await pipeline.exec();
        }
    } catch (err) {
        const safeMsg = formatSafeRedisError(err);
        console.warn(`[Presence] Error during local socket renewal: ${safeMsg}`);
    }
};

const ensureRenewalTimer = () => {
    if (renewalIntervalTimer) return;
    const env = process.env;
    if (!isPresenceRedisEnabled(env)) return;

    let config;
    try {
        config = validatePresenceRedisConfig(env);
    } catch (_) {
        return;
    }

    renewalIntervalTimer = setInterval(() => {
        renewLocalSockets().catch(() => {});
    }, config.renewalIntervalMs);

    if (typeof renewalIntervalTimer.unref === "function") {
        renewalIntervalTimer.unref();
    }
};

// =============================================================================
// Lifecycle Management: Startup, Readiness, Shutdown
// =============================================================================

/**
 * Initializes Redis-backed presence tracking when PRESENCE_REDIS_ENABLED is true.
 *
 * @param {Object} [options]
 * @param {any} [options.redisClient]
 * @param {Object} [options.env=process.env]
 * @returns {Promise<{ enabled: boolean, mode: string } | null>}
 */
export const initPresenceService = async ({ redisClient = null, env = process.env } = {}) => {
    if (!isPresenceRedisEnabled(env)) {
        return null;
    }

    const config = validatePresenceRedisConfig(env);
    if (redisClient) {
        redisClientOverride = redisClient;
    }

    const client = getEffectiveRedisClient(env);
    if (!client || client.status !== "ready") {
        throw new Error("Failed to initialize Presence Service: Redis client is not connected and ready.");
    }

    ensureRenewalTimer();
    return { enabled: true, mode: "redis", config };
};

/**
 * Retrieves safe presence service status for readiness probes.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, ready: boolean, status: string, mode: string, localSocketsCount: number }}
 */
export const getPresenceStatus = (env = process.env) => {
    const enabled = isPresenceRedisEnabled(env);
    if (!enabled) {
        return {
            enabled: false,
            ready: true,
            status: "disabled",
            mode: "in_memory",
            localSocketsCount: 0,
        };
    }

    const client = getEffectiveRedisClient(env);
    const clientReady = Boolean(client && client.status === "ready");

    return {
        enabled: true,
        ready: clientReady,
        status: clientReady ? "ready" : (client?.status || "disconnected"),
        mode: "redis",
        localSocketsCount: localProcessSockets.size,
    };
};

/**
 * Gracefully shuts down presence tracking, stops renewal timers, clears disconnect
 * timers, and cleans up local socket leases from Redis within a bounded timeout.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=2000]
 * @param {Object} [options.env=process.env]
 * @returns {Promise<void>}
 */
export const closePresenceService = async ({ timeoutMs = 2000, env = process.env } = {}) => {
    // 1. Stop background renewal loop
    if (renewalIntervalTimer) {
        clearInterval(renewalIntervalTimer);
        renewalIntervalTimer = null;
    }

    // 2. Clear pending disconnect grace timers
    for (const timer of disconnectTimers.values()) {
        clearTimeout(timer);
    }
    disconnectTimers.clear();

    // 3. Remove local sockets from Redis if Redis is active
    if (isPresenceRedisEnabled(env) && localProcessSockets.size > 0) {
        const client = getEffectiveRedisClient(env);
        if (client && client.status === "ready" && typeof client.pipeline === "function") {
            try {
                let config;
                try { config = validatePresenceRedisConfig(env); } catch (_) {}
                const prefix = config?.keyPrefix || "engaze:presence";

                const cleanupPromise = (async () => {
                    const pipeline = client.pipeline();
                    for (const [socketId, entry] of localProcessSockets.entries()) {
                        const key = getUserSocketsKey(prefix, entry.userId);
                        pipeline.zrem(key, socketId);
                    }
                    await pipeline.exec();
                })();

                const timerPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
                await Promise.race([cleanupPromise, timerPromise]);
            } catch (err) {
                const safeMsg = formatSafeRedisError(err);
                console.error(`[Presence] Error cleaning up local sockets during shutdown: ${safeMsg}`);
            }
        }
    }

    localProcessSockets.clear();
    activeSocketsByUser.clear();
    redisClientOverride = null;
};

/**
 * Resets all presence tracking state (used in unit/integration tests).
 */
export const _resetPresenceState = () => {
    if (renewalIntervalTimer) {
        clearInterval(renewalIntervalTimer);
        renewalIntervalTimer = null;
    }
    for (const timer of disconnectTimers.values()) {
        clearTimeout(timer);
    }
    disconnectTimers.clear();
    activeSocketsByUser.clear();
    localProcessSockets.clear();
    redisClientOverride = null;
};

// =============================================================================
// Core Presence Handlers: Connect, Disconnect, Query
// =============================================================================

/**
 * Records a user socket connection.
 * Cancels any pending disconnect grace timer for this user.
 *
 * @param {string} userId - User ID string
 * @param {string} socketId - Socket ID string
 * @returns {boolean|Promise<boolean>} wasOffline - True if user had zero active sockets prior to this connection
 */
export const userConnected = (userId, socketId) => {
    if (!userId || !socketId) return false;
    const uid = userId.toString();

    // Cancel any pending disconnect grace timer
    if (disconnectTimers.has(uid)) {
        clearTimeout(disconnectTimers.get(uid));
        disconnectTimers.delete(uid);
    }

    // In-memory mode (PRESENCE_REDIS_ENABLED=false)
    if (!isPresenceRedisEnabled()) {
        let sockets = activeSocketsByUser.get(uid);
        const wasOffline = !sockets || sockets.size === 0;

        if (!sockets) {
            sockets = new Set();
            activeSocketsByUser.set(uid, sockets);
        }
        sockets.add(socketId);

        return wasOffline;
    }

    // Distributed Redis mode (PRESENCE_REDIS_ENABLED=true)
    return (async () => {
        localProcessSockets.set(socketId, {
            userId: uid,
            lastRenewedAt: Date.now(),
        });
        ensureRenewalTimer();

        let config;
        try {
            config = validatePresenceRedisConfig();
        } catch (err) {
            console.error(`[Presence] Invalid config: ${err.message}`);
            return false;
        }

        const client = getEffectiveRedisClient();
        if (!client || client.status !== "ready") {
            console.warn("[Presence] Redis client not ready during userConnected; failing safe.");
            return false;
        }

        const key = getUserSocketsKey(config.keyPrefix, uid);
        const nowMs = Date.now();
        const expiresAtMs = nowMs + config.leaseTtlMs;
        const keyTtlSec = Math.ceil((config.leaseTtlMs * 2) / 1000);

        try {
            const res = await client.eval(USER_CONNECTED_LUA, 1, key, socketId, nowMs, expiresAtMs, keyTtlSec);
            return Number(res) === 1;
        } catch (err) {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[Presence] userConnected Redis error: ${safeMsg}`);
            return false;
        }
    })();
};

/**
 * Records a user socket disconnect.
 * If all sockets for this user are gone, schedules a grace timer before marking offline.
 *
 * @param {string} userId - User ID string
 * @param {string} socketId - Socket ID string
 * @param {Function} [onGraceExpired] - Async callback invoked if the grace timer expires without reconnection
 * @returns {boolean|Promise<boolean>} isGracePending - True if a grace timer was started
 */
export const userDisconnected = (userId, socketId, onGraceExpired) => {
    if (!userId || !socketId) return false;
    const uid = userId.toString();

    // In-memory mode (PRESENCE_REDIS_ENABLED=false)
    if (!isPresenceRedisEnabled()) {
        const sockets = activeSocketsByUser.get(uid);
        if (sockets) {
            sockets.delete(socketId);
            if (sockets.size === 0) {
                activeSocketsByUser.delete(uid);
            }
        }

        if (activeSocketsByUser.has(uid) && activeSocketsByUser.get(uid).size > 0) {
            return false;
        }

        if (disconnectTimers.has(uid)) {
            clearTimeout(disconnectTimers.get(uid));
            disconnectTimers.delete(uid);
        }

        const graceMs = getDisconnectGraceMs();
        const timer = setTimeout(async () => {
            disconnectTimers.delete(uid);

            const currentSockets = activeSocketsByUser.get(uid);
            if (!currentSockets || currentSockets.size === 0) {
                if (typeof onGraceExpired === "function") {
                    try {
                        await onGraceExpired(new Date());
                    } catch (err) {
                        console.error(`Error in presence grace expiration handler for user ${uid}:`, err);
                    }
                }
            }
        }, graceMs);

        if (typeof timer.unref === "function") {
            timer.unref();
        }

        disconnectTimers.set(uid, timer);
        return true;
    }

    // Distributed Redis mode (PRESENCE_REDIS_ENABLED=true)
    return (async () => {
        localProcessSockets.delete(socketId);

        let config;
        try {
            config = validatePresenceRedisConfig();
        } catch (err) {
            console.error(`[Presence] Invalid config: ${err.message}`);
            return false;
        }

        const client = getEffectiveRedisClient();
        if (!client || client.status !== "ready") {
            console.warn("[Presence] Redis client not ready during userDisconnected; failing safe.");
            return false;
        }

        const key = getUserSocketsKey(config.keyPrefix, uid);
        const nowMs = Date.now();
        const keyTtlSec = Math.ceil((config.leaseTtlMs * 2) / 1000);

        let remaining = 0;
        try {
            const res = await client.eval(USER_DISCONNECTED_LUA, 1, key, socketId, nowMs, keyTtlSec);
            remaining = Number(res);
        } catch (err) {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[Presence] userDisconnected Redis error: ${safeMsg}`);
            return false;
        }

        // Active sockets still exist across instances: do NOT start grace timer
        if (remaining > 0) {
            return false;
        }

        // Zero sockets remaining globally: start disconnect grace timer
        if (disconnectTimers.has(uid)) {
            clearTimeout(disconnectTimers.get(uid));
            disconnectTimers.delete(uid);
        }

        const graceMs = getDisconnectGraceMs();
        const timer = setTimeout(async () => {
            disconnectTimers.delete(uid);

            try {
                // Recheck global Redis presence before executing offline transition
                const isOnline = await isUserOnline(uid);
                if (!isOnline) {
                    // Deduplication lock to ensure strictly one instance executes offline callback
                    let lockAcquired = true;
                    if (typeof client.set === "function") {
                        const lockKey = `${config.keyPrefix}:user:{${uid}}:offline_lock`;
                        const lockRes = await client.set(lockKey, Date.now(), "NX", "EX", 10).catch(() => null);
                        lockAcquired = Boolean(lockRes);
                    }

                    if (lockAcquired && typeof onGraceExpired === "function") {
                        await onGraceExpired(new Date());
                    }
                }
            } catch (err) {
                console.error(`Error in presence grace expiration handler for user ${uid}:`, err);
            }
        }, graceMs);

        if (typeof timer.unref === "function") {
            timer.unref();
        }

        disconnectTimers.set(uid, timer);
        return true;
    })();
};

/**
 * Checks whether a user is currently considered online (has at least 1 active socket lease).
 *
 * @param {string} userId
 * @returns {boolean|Promise<boolean>}
 */
export const isUserOnline = (userId) => {
    if (!userId) return false;
    const uid = userId.toString();

    // In-memory mode (PRESENCE_REDIS_ENABLED=false)
    if (!isPresenceRedisEnabled()) {
        const sockets = activeSocketsByUser.get(uid);
        return Boolean(sockets && sockets.size > 0);
    }

    // Distributed Redis mode (PRESENCE_REDIS_ENABLED=true)
    return (async () => {
        let config;
        try {
            config = validatePresenceRedisConfig();
        } catch (_) {
            return false;
        }

        const client = getEffectiveRedisClient();
        if (!client || client.status !== "ready") {
            return false;
        }

        const key = getUserSocketsKey(config.keyPrefix, uid);
        const nowMs = Date.now();

        try {
            const res = await client.eval(IS_USER_ONLINE_LUA, 1, key, nowMs);
            return Number(res) === 1;
        } catch (err) {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[Presence] isUserOnline Redis error: ${safeMsg}`);
            return false;
        }
    })();
};

// =============================================================================
// Privacy Evaluation: Reciprocity & Viewer Masking
// =============================================================================

/**
 * Determines whether viewerUser has permission to see targetUser's lastSeenAt.
 *
 * Enforces WhatsApp reciprocity:
 * - If viewer's own lastSeen setting is "nobody", viewer cannot see ANY other user's lastSeenAt.
 * - If target's lastSeen setting is "nobody", target's lastSeenAt is hidden from everyone (except self).
 * - If target's lastSeen is "everyone", visible to everyone (unless viewer has "nobody").
 * - If target's lastSeen is "matches", visible only to active mutual matches.
 * - If target's lastSeen is "matches_except", visible to matches who are NOT in target's exceptions list.
 *
 * @param {Object} targetUser - Target user document or object
 * @param {Object} viewerUser - Viewer user document or object
 * @param {boolean} [isMatch=false] - Whether target and viewer are active mutual matches
 * @returns {boolean}
 */
export const canViewerSeeLastSeen = (targetUser, viewerUser, isMatch = false) => {
    if (!targetUser || !viewerUser) return false;

    const targetId = targetUser._id ? targetUser._id.toString() : targetUser.id?.toString() || targetUser.toString();
    const viewerId = viewerUser._id ? viewerUser._id.toString() : viewerUser.id?.toString() || viewerUser.toString();

    // User can always see their own last seen
    if (targetId === viewerId) return true;

    const viewerPrivacy = viewerUser.privacySettings || {};
    const viewerLastSeenSetting = viewerPrivacy.lastSeen || "everyone";

    // WhatsApp Reciprocal Rule: If viewer sets their last seen to 'nobody',
    // viewer is not permitted to see other users' last seen.
    if (viewerLastSeenSetting === "nobody") {
        return false;
    }

    const targetPrivacy = targetUser.privacySettings || {};
    const targetLastSeenSetting = targetPrivacy.lastSeen || "everyone";

    switch (targetLastSeenSetting) {
        case "nobody":
            return false;
        case "everyone":
            return true;
        case "matches":
            return Boolean(isMatch);
        case "matches_except": {
            if (!isMatch) return false;
            const exceptions = Array.isArray(targetPrivacy.lastSeenExceptions)
                ? targetPrivacy.lastSeenExceptions.map((id) => (id?._id || id).toString())
                : [];
            return !exceptions.includes(viewerId);
        }
        default:
            return true;
    }
};

/**
 * Determines whether viewerUser has permission to see targetUser's Online indicator.
 *
 * WhatsApp Rule:
 * - "everyone": Visible to everyone.
 * - "same_as_last_seen": Evaluates against target's lastSeen permission rules for viewer.
 *
 * @param {Object} targetUser - Target user document or object
 * @param {Object} viewerUser - Viewer user document or object
 * @param {boolean} [isMatch=false] - Whether target and viewer are active mutual matches
 * @returns {boolean}
 */
export const canViewerSeeOnline = (targetUser, viewerUser, isMatch = false) => {
    if (!targetUser || !viewerUser) return false;

    const targetId = targetUser._id ? targetUser._id.toString() : targetUser.id?.toString() || targetUser.toString();
    const viewerId = viewerUser._id ? viewerUser._id.toString() : viewerUser.id?.toString() || viewerUser.toString();

    // User can always see their own online status
    if (targetId === viewerId) return true;

    const targetPrivacy = targetUser.privacySettings || {};
    const targetOnlineSetting = targetPrivacy.online || "everyone";

    if (targetOnlineSetting === "everyone") {
        return true;
    }

    if (targetOnlineSetting === "same_as_last_seen") {
        return canViewerSeeLastSeen(targetUser, viewerUser, isMatch);
    }

    return true;
};

/**
 * Calculates sanitized presence data for targetUser as seen by viewerUser.
 * Handles both synchronous (in-memory) and asynchronous (Redis) presence states.
 *
 * @param {Object} targetUser - Target user document or object (must include privacySettings, lastSeenAt)
 * @param {Object} viewerUser - Viewer user document or object (must include privacySettings)
 * @param {boolean} [isMatch=false] - Whether they are active mutual matches
 * @returns {{ isOnline: boolean, lastSeenAt: Date|null } | Promise<{ isOnline: boolean, lastSeenAt: Date|null }>}
 */
export const getPresenceForViewer = (targetUser, viewerUser, isMatch = false) => {
    if (!targetUser) {
        return { isOnline: false, lastSeenAt: null };
    }

    const targetId = targetUser._id ? targetUser._id.toString() : targetUser.id?.toString() || targetUser.toString();
    const online = isUserOnline(targetId);

    // If online status is a Promise (Redis mode)
    if (online && typeof online.then === "function") {
        return online.then((isOnline) => {
            const canSeeOnline = isOnline && canViewerSeeOnline(targetUser, viewerUser, isMatch);
            const canSeeLastSeen = canViewerSeeLastSeen(targetUser, viewerUser, isMatch);

            return {
                isOnline: Boolean(canSeeOnline),
                lastSeenAt: canSeeLastSeen ? (targetUser.lastSeenAt || null) : null,
            };
        }).catch(() => {
            return { isOnline: false, lastSeenAt: null };
        });
    }

    // Synchronous in-memory mode
    const canSeeOnline = online && canViewerSeeOnline(targetUser, viewerUser, isMatch);
    const canSeeLastSeen = canViewerSeeLastSeen(targetUser, viewerUser, isMatch);

    return {
        isOnline: Boolean(canSeeOnline),
        lastSeenAt: canSeeLastSeen ? (targetUser.lastSeenAt || null) : null,
    };
};

// =============================================================================
// Testing Helpers
// =============================================================================

export const _setPresenceRedisClientForTesting = (mockClient) => {
    redisClientOverride = mockClient;
};

export const _getLocalProcessSocketsForTesting = () => {
    return localProcessSockets;
};
