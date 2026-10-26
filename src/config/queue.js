/**
 * BullMQ Queue Configuration (Phase 4A)
 *
 * Centralizes queue names, job retention, retry backoff policies,
 * and separate ioredis connection configurations for producers and workers.
 */

import Redis from "ioredis";
import { validateBullMQConfig } from "./redis.js";

export const QUEUE_NAMES = {
    MEDIA_CLEANUP: "media-cleanup",
};

/**
 * Standard job options:
 * - 3 retry attempts with exponential backoff and jitter
 * - Bounded retention for completed (24h / 1,000 max) and failed (7d / 5,000 max) jobs
 *   to prevent unbounded Redis memory growth.
 */
export const DEFAULT_JOB_OPTIONS = {
    attempts: 3,
    backoff: {
        type: "exponential",
        delay: 1000,
    },
    removeOnComplete: {
        age: 24 * 3600, // keep completed jobs up to 24 hours
        count: 1000,    // keep at most 1,000 completed jobs
    },
    removeOnFail: {
        age: 7 * 24 * 3600, // keep failed jobs up to 7 days
        count: 5000,        // keep at most 5,000 failed jobs
    },
};

/**
 * Returns connection options for Queue producers (Express web process).
 * Bounded retry limit prevents API requests from hanging indefinitely.
 */
export const getProducerConnectionConfig = (redisConfig) => {
    const config = redisConfig || validateBullMQConfig().redisConfig;
    if (!config || !config.url) {
        throw new Error("Cannot configure BullMQ producer connection: valid redisConfig is required.");
    }

    return {
        url: config.url,
        maxRetriesPerRequest: 3, // Bounded for fast failure in API request path
        commandTimeout: 5000,    // Fail fast if a command hangs
        enableReadyCheck: false,
        lazyConnect: true,
        connectTimeout: 5000,
        retryStrategy: (times) => {
            if (times > 5) return null;
            return Math.min(times * 200, 1000);
        },
        tls: config.tls ? {} : undefined,
    };
};

/**
 * Returns connection options for Queue Workers (standalone background process).
 * BullMQ strictly requires maxRetriesPerRequest: null for blocking commands.
 */
export const getWorkerConnectionConfig = (redisConfig) => {
    const config = redisConfig || validateBullMQConfig().redisConfig;
    if (!config || !config.url) {
        throw new Error("Cannot configure BullMQ worker connection: valid redisConfig is required.");
    }

    return {
        url: config.url,
        maxRetriesPerRequest: null, // REQUIRED by BullMQ for workers
        enableReadyCheck: false,
        lazyConnect: true,
        connectTimeout: 10000,
        retryStrategy: (times) => {
            return Math.min(times * 500, 5000);
        },
        tls: config.tls ? {} : undefined,
    };
};

/**
 * Factory to instantiate a dedicated ioredis client for Queue producers.
 */
export const createProducerRedisClient = (redisConfig) => {
    const opts = getProducerConnectionConfig(redisConfig);
    const { url, ...redisOptions } = opts;
    return new Redis(url, redisOptions);
};

/**
 * Factory to instantiate a dedicated ioredis client for Queue workers.
 */
export const createWorkerRedisClient = (redisConfig) => {
    const opts = getWorkerConnectionConfig(redisConfig);
    const { url, ...redisOptions } = opts;
    return new Redis(url, redisOptions);
};

