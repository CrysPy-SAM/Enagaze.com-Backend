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

