/**
 * Centralized Redis / Valkey Configuration
 *
 * Provides validated, sanitized configuration for Redis/Valkey connections.
 * Follows fail-safe principles: disabled by default, requires valid credentials
 * when enabled, and never prints credentials in logs or error messages.
 */

/**
 * Checks whether Redis is explicitly enabled via environment variables.
 * Defaults to false if REDIS_ENABLED is absent, empty, or false.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
export function isRedisEnabled(env = process.env) {
    if (!env || !env.REDIS_ENABLED) {
        return false;
    }
    const val = String(env.REDIS_ENABLED).trim().toLowerCase();
    return val === "true" || val === "1";
}

/**
 * Checks whether the Socket.IO Redis Adapter is explicitly enabled via environment variables.
 * Defaults to false if SOCKET_IO_REDIS_ADAPTER_ENABLED is absent, empty, or false.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
export function isSocketRedisAdapterEnabled(env = process.env) {
    if (!env || !env.SOCKET_IO_REDIS_ADAPTER_ENABLED) {
        return false;
    }
    const val = String(env.SOCKET_IO_REDIS_ADAPTER_ENABLED).trim().toLowerCase();
    return val === "true" || val === "1";
}

/**
 * Checks whether Redis-backed online presence tracking is explicitly enabled.
 * Defaults to false if PRESENCE_REDIS_ENABLED is absent, empty, or false.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
export function isPresenceRedisEnabled(env = process.env) {
    if (!env || !env.PRESENCE_REDIS_ENABLED) {
        return false;
    }
    const val = String(env.PRESENCE_REDIS_ENABLED).trim().toLowerCase();
    return val === "true" || val === "1";
}

/**
 * Checks whether Redis-backed random matchmaking is explicitly enabled.
 * Defaults to false if MATCHMAKING_REDIS_ENABLED is absent, empty, or false.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
export function isMatchmakingRedisEnabled(env = process.env) {
    if (!env || !env.MATCHMAKING_REDIS_ENABLED) {
        return false;
    }
    const val = String(env.MATCHMAKING_REDIS_ENABLED).trim().toLowerCase();
    return val === "true" || val === "1";
}

/**
 * Checks whether Redis-backed distributed rate limiting is explicitly enabled.
 * Defaults to false if RATE_LIMIT_REDIS_ENABLED is absent, empty, or false.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
export function isRateLimitRedisEnabled(env = process.env) {
    if (!env || !env.RATE_LIMIT_REDIS_ENABLED) {
        return false;
    }
    const val = String(env.RATE_LIMIT_REDIS_ENABLED).trim().toLowerCase();
    return val === "true" || val === "1";
}

/**
 * Validates Redis configuration settings.
 * When REDIS_ENABLED=true, requires a valid redis:// or rediss:// connection URL.
 * Never includes raw URL, usernames, or passwords in error messages.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, url: string|null, tls: boolean, host?: string, port?: number }}
 * @throws {Error} Sanitized configuration error
 */
export function validateRedisConfig(env = process.env) {
    if (!isRedisEnabled(env)) {
        return {
            enabled: false,
            url: null,
            tls: false,
        };
    }

    const rawUrl = env.REDIS_URL;
    if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
        throw new Error("Invalid Redis configuration: REDIS_URL is required when REDIS_ENABLED=true.");
    }

    const trimmedUrl = rawUrl.trim();
    let parsed;
    try {
        parsed = new URL(trimmedUrl);
    } catch (_) {
        throw new Error("Invalid Redis configuration: REDIS_URL is malformed.");
    }

    const protocol = parsed.protocol;
    if (protocol !== "redis:" && protocol !== "rediss:") {
        throw new Error("Invalid Redis configuration: REDIS_URL must use 'redis:' or 'rediss:' protocol.");
    }

    if (!parsed.hostname) {
        throw new Error("Invalid Redis configuration: REDIS_URL must specify a host.");
    }

    return {
        enabled: true,
        url: trimmedUrl,
        tls: protocol === "rediss:",
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : (protocol === "rediss:" ? 6380 : 6379),
    };
}

/**
 * Validates Socket.IO Redis Adapter configuration settings.
 * When SOCKET_IO_REDIS_ADAPTER_ENABLED=true, requires REDIS_ENABLED=true
 * and a valid REDIS_URL via validateRedisConfig.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, key: string, redisConfig?: object }}
 * @throws {Error} Sanitized configuration error
 */
export function validateSocketRedisAdapterConfig(env = process.env) {
    if (!isSocketRedisAdapterEnabled(env)) {
        return {
            enabled: false,
            key: "engaze:socket.io",
        };
    }

    if (!isRedisEnabled(env)) {
        throw new Error(
            "Invalid Socket.IO Redis adapter configuration: REDIS_ENABLED=true is required when SOCKET_IO_REDIS_ADAPTER_ENABLED=true."
        );
    }

    const redisConfig = validateRedisConfig(env);
    const customKey = env.SOCKET_IO_REDIS_ADAPTER_KEY ? String(env.SOCKET_IO_REDIS_ADAPTER_KEY).trim() : "";
    const key = customKey || "engaze:socket.io";

    return {
        enabled: true,
        key,
        redisConfig,
    };
}

/**
 * Validates Presence Redis configuration settings.
 * When PRESENCE_REDIS_ENABLED=true, requires REDIS_ENABLED=true
 * and a valid REDIS_URL via validateRedisConfig.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, leaseTtlMs: number, renewalIntervalMs: number, keyPrefix: string, redisConfig?: object }}
 * @throws {Error} Sanitized configuration error
 */
export function validatePresenceRedisConfig(env = process.env) {
    if (!isPresenceRedisEnabled(env)) {
        return {
            enabled: false,
            leaseTtlMs: 30000,
            renewalIntervalMs: 10000,
            keyPrefix: "engaze:presence",
        };
    }

    if (!isRedisEnabled(env)) {
        throw new Error(
            "Invalid Presence Redis configuration: REDIS_ENABLED=true is required when PRESENCE_REDIS_ENABLED=true."
        );
    }

    const redisConfig = validateRedisConfig(env);

    let leaseTtlMs = 30000;
    if (env.PRESENCE_LEASE_TTL_MS) {
        const parsed = parseInt(env.PRESENCE_LEASE_TTL_MS, 10);
        if (!isNaN(parsed) && parsed > 0) leaseTtlMs = parsed;
    }

    let renewalIntervalMs = 10000;
    if (env.PRESENCE_RENEWAL_INTERVAL_MS) {
        const parsed = parseInt(env.PRESENCE_RENEWAL_INTERVAL_MS, 10);
        if (!isNaN(parsed) && parsed > 0) renewalIntervalMs = parsed;
    }

    const keyPrefix = env.PRESENCE_REDIS_KEY_PREFIX ? String(env.PRESENCE_REDIS_KEY_PREFIX).trim() : "engaze:presence";

    return {
        enabled: true,
        leaseTtlMs,
        renewalIntervalMs,
        keyPrefix: keyPrefix || "engaze:presence",
        redisConfig,
    };
}

/**
 * Validates Matchmaking Redis configuration settings.
 * When MATCHMAKING_REDIS_ENABLED=true, requires:
 * 1. REDIS_ENABLED=true and a valid REDIS_URL via validateRedisConfig.
 * 2. PRESENCE_REDIS_ENABLED=true (to track cross-instance online candidate status).
 * 3. SOCKET_IO_REDIS_ADAPTER_ENABLED=true (for cross-instance WebRTC signaling & event delivery).
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, keyPrefix: string, queueKey: string, queueTtlMs: number, callTtlMs: number, reservationTtlMs: number, redisConfig?: object }}
 * @throws {Error} Sanitized configuration error
 */
export function validateMatchmakingRedisConfig(env = process.env) {
    if (!isMatchmakingRedisEnabled(env)) {
        return {
            enabled: false,
            keyPrefix: "engaze:matchmaking",
            queueKey: "engaze:matchmaking:queue",
            queueTtlMs: 120000,
            callTtlMs: 300000,
            reservationTtlMs: 30000,
        };
    }

    if (!isRedisEnabled(env)) {
        throw new Error(
            "Invalid Matchmaking Redis configuration: REDIS_ENABLED=true is required when MATCHMAKING_REDIS_ENABLED=true."
        );
    }

    if (!isPresenceRedisEnabled(env)) {
        throw new Error(
            "Invalid Matchmaking Redis configuration: PRESENCE_REDIS_ENABLED=true is required when MATCHMAKING_REDIS_ENABLED=true."
        );
    }

    if (!isSocketRedisAdapterEnabled(env)) {
        throw new Error(
            "Invalid Matchmaking Redis configuration: SOCKET_IO_REDIS_ADAPTER_ENABLED=true is required when MATCHMAKING_REDIS_ENABLED=true."
        );
    }

    const redisConfig = validateRedisConfig(env);

    const keyPrefix = env.MATCHMAKING_REDIS_KEY_PREFIX ? String(env.MATCHMAKING_REDIS_KEY_PREFIX).trim() : "engaze:matchmaking";

    let queueTtlMs = 120000;
    if (env.MATCHMAKING_QUEUE_TTL_MS) {
        const parsed = parseInt(env.MATCHMAKING_QUEUE_TTL_MS, 10);
        if (!isNaN(parsed) && parsed > 0) queueTtlMs = parsed;
    }

    let callTtlMs = 300000;
    if (env.MATCHMAKING_CALL_TTL_MS) {
        const parsed = parseInt(env.MATCHMAKING_CALL_TTL_MS, 10);
        if (!isNaN(parsed) && parsed > 0) callTtlMs = parsed;
    }

    let reservationTtlMs = 30000;
    if (env.MATCHMAKING_RESERVATION_TTL_MS) {
        const parsed = parseInt(env.MATCHMAKING_RESERVATION_TTL_MS, 10);
        if (!isNaN(parsed) && parsed > 0) reservationTtlMs = parsed;
    }

    return {
        enabled: true,
        keyPrefix: keyPrefix || "engaze:matchmaking",
        queueKey: `${keyPrefix || "engaze:matchmaking"}:queue`,
        queueTtlMs,
        callTtlMs,
        reservationTtlMs,
        redisConfig,
    };
}

/**
 * Validates Rate Limit Redis configuration settings.
 * When RATE_LIMIT_REDIS_ENABLED=true, requires REDIS_ENABLED=true
 * and a valid REDIS_URL via validateRedisConfig.
 *
 * @param {Object} [env=process.env]
 * @returns {{ enabled: boolean, keyPrefix: string, redisConfig?: object }}
 * @throws {Error} Sanitized configuration error
 */
export function validateRateLimitRedisConfig(env = process.env) {
    if (!isRateLimitRedisEnabled(env)) {
        return {
            enabled: false,
            keyPrefix: "engaze:ratelimit",
        };
    }

    if (!isRedisEnabled(env)) {
        throw new Error(
            "Invalid Rate Limit Redis configuration: REDIS_ENABLED=true is required when RATE_LIMIT_REDIS_ENABLED=true."
        );
    }

    const redisConfig = validateRedisConfig(env);
    const customPrefix = env.RATE_LIMIT_REDIS_KEY_PREFIX ? String(env.RATE_LIMIT_REDIS_KEY_PREFIX).trim() : "";
    const keyPrefix = customPrefix || "engaze:ratelimit";

    return {
        enabled: true,
        keyPrefix,
        redisConfig,
    };
}

/**
 * Formats a Redis runtime error safely without leaking credentials.
 *
 * @param {any} err
 * @returns {string}
 */
export function formatSafeRedisError(err) {
    if (!err) return "Unknown Redis error";
    const name = err.name || "RedisError";
    const code = err.code ? ` [code: ${err.code}]` : "";
    return `Redis connection failed (${name}${code}). Please verify network reachability and REDIS_URL configuration.`;
}

