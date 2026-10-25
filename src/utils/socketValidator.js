import mongoose from "mongoose";
import { isRateLimitRedisEnabled } from "../config/redis.js";
import {
    checkSocketRateLimitRedis,
    clearSocketRateLimitsRedis,
} from "../services/rateLimitRedis.service.js";

/**
 * Validates that an incoming value is a plain JavaScript Object.
 * Rejects null, arrays, functions, and primitives.
 */
export function isPlainObject(val) {
    return (
        typeof val === "object" &&
        val !== null &&
        !Array.isArray(val) &&
        Object.prototype.toString.call(val) === "[object Object]"
    );
}

/**
 * Validates that a string is a strictly valid 24-hex-character MongoDB ObjectId.
 */
export function isValidObjectId(id) {
    if (!id || typeof id !== "string") return false;
    return /^[0-9a-fA-F]{24}$/.test(id) && mongoose.Types.ObjectId.isValid(id);
}

/**
 * Validates and sanitizes a string within length bounds.
 */
export function sanitizeString(val, minLen = 1, maxLen = 2000) {
    if (typeof val !== "string") return null;
    const trimmed = val.trim();
    if (trimmed.length < minLen || trimmed.length > maxLen) return null;
    return trimmed;
}

/**
 * Validates signaling payload size and structure.
 * Rejects payloads exceeding maxBytes (default 64KB) or malformed structures.
 */
export function isValidSignalPayload(signalData, maxBytes = 65536) {
    if (!signalData) return false;
    if (typeof signalData !== "object" && typeof signalData !== "string") return false;

    try {
        const serialized = typeof signalData === "string" ? signalData : JSON.stringify(signalData);
        if (serialized.length > maxBytes) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * In-memory sliding-window rate limiter for Socket.IO actions.
 * Keyed by `${socketId}:${action}` or `${userId}:${action}`.
 */
const rateLimitMap = new Map();

export function checkSocketRateLimit(key, maxRequests, windowMs) {
    if (isRateLimitRedisEnabled()) {
        return checkSocketRateLimitRedis(key, maxRequests, windowMs);
    }

    const now = Date.now();
    let timestamps = rateLimitMap.get(key);
    if (!timestamps) {
        timestamps = [];
        rateLimitMap.set(key, timestamps);
    }

    const windowStart = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
        return false; // Rate limit exceeded
    }

    timestamps.push(now);
    return true; // Allowed
}

/**
 * Clean up all rate limit buckets associated with a specific socket ID.
 */
export function clearSocketRateLimits(socketId) {
    if (isRateLimitRedisEnabled()) {
        clearSocketRateLimitsRedis(socketId);
    }
    if (!socketId) return;
    const prefix = `${socketId}:`;
    for (const key of rateLimitMap.keys()) {
        if (key.startsWith(prefix)) {
            rateLimitMap.delete(key);
        }
    }
}

/**
 * Helper for testing rate limit state
 */
export const _testingRateLimits = {
    clearAll: () => rateLimitMap.clear(),
    getMapSize: () => rateLimitMap.size,
};

