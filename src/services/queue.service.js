/**
 * BullMQ Queue Producer Service (Phase 4A)
 *
 * Manages BullMQ Queue producers in the API process:
 * 1. Initializes registered queues with bounded producer connection limits.
 * 2. Uses deterministic job identifiers for deduplication.
 * 3. Enforces bounded job retention policies to prevent Redis memory expansion.
 * 4. Exposes sanitized status and health probes for readiness checks.
 * 5. Provides safe, reliable enqueuing for background tasks (e.g. media cleanup).
 */

import crypto from "node:crypto";
import { Queue } from "bullmq";
import {
    isBullMQEnabled,
    validateBullMQConfig,
    formatSafeRedisError,
} from "../config/redis.js";
import {
    QUEUE_NAMES,
    DEFAULT_JOB_OPTIONS,
    createProducerRedisClient,
} from "../config/queue.js";

// =============================================================================
// Service State & Testing Overrides
// =============================================================================

let producerClient = null;
let isServiceReady = false;
let clientOverride = null;
const queues = new Map();

// =============================================================================
// Queue Lifecycle
// =============================================================================

/**
 * Initializes BullMQ queue producers for the API process.
 * Does NOT start any worker processors in this process.
 *
 * @param {Object} [options]
 * @param {Object} [options.redisClient] - Optional injected client for testing
 * @returns {Promise<{ enabled: boolean, ready: boolean }>}
 */
export const initQueueService = async ({ redisClient } = {}) => {
    const config = validateBullMQConfig();
    if (!config.enabled) {
        isServiceReady = false;
        return { enabled: false, ready: false };
    }

    // Use test override or injected client or create dedicated producer client
    const effectiveClient = clientOverride || redisClient || createProducerRedisClient(config.redisConfig);
    producerClient = effectiveClient;

    const prefix = config.keyPrefix || "engaze:bullmq";

    try {
        // Initialize registered queues
        for (const queueName of Object.values(QUEUE_NAMES)) {
            if (!queues.has(queueName)) {
                const queue = new Queue(queueName, {
                    connection: producerClient,
                    prefix,
                    defaultJobOptions: DEFAULT_JOB_OPTIONS,
                });
                queues.set(queueName, queue);
            }
        }

        isServiceReady = true;
        return { enabled: true, ready: true };
    } catch (err) {
        isServiceReady = false;
        await closeQueueService();
        const safeMsg = formatSafeRedisError(err);
        console.error(`[BullMQ:Producer] Initialization error: ${safeMsg}`);
        throw new Error(`BullMQ Queue Service initialization failed: ${safeMsg}`);
    }
};

/**
 * Closes all active BullMQ queue instances and disconnects the producer client.
 */
export const closeQueueService = async () => {
    isServiceReady = false;
    const closePromises = [];

    for (const [name, queue] of queues.entries()) {
        try {
            closePromises.push(queue.close());
        } catch (_) {}
    }

    await Promise.allSettled(closePromises);
    queues.clear();

    if (producerClient && !clientOverride) {
        try {
            if (typeof producerClient.quit === "function") {
                await producerClient.quit();
            } else if (typeof producerClient.disconnect === "function") {
                producerClient.disconnect();
            }
        } catch (_) {}
    }
    producerClient = null;

    return { enabled: isBullMQEnabled(), ready: false };
};

/**
 * Returns sanitized health and readiness status for BullMQ queue producers.
 * Never exposes credentials, Redis URLs, or job payloads.
 */
export const getQueueServiceStatus = () => {
    const enabled = isBullMQEnabled();
    if (!enabled) {
        return { enabled: false, ready: true, status: "disabled" };
    }

    const client = clientOverride || producerClient;
    const isClientReady = Boolean(
        client &&
        (client.status === "ready" || client.status === "connect" || !client.status)
    );
    const ready = isServiceReady && isClientReady;

    return {
        enabled: true,
        ready,
        status: ready ? "ready" : "disconnected",
        queues: Array.from(queues.keys()),
    };
};

/**
 * Retrieves an initialized Queue instance by name.
 * Throws if the queue service is not initialized or queue is not registered.
 */
export const getQueue = (queueName) => {
    if (!isBullMQEnabled()) {
        throw new Error("BullMQ Queue Service is disabled. Cannot retrieve queue.");
    }
    const queue = queues.get(queueName);
    if (!queue) {
        throw new Error(`Queue '${queueName}' is not initialized or registered.`);
    }
    return queue;
};

// =============================================================================
// Background Task Enqueuing: Media Cleanup
// =============================================================================

/**
 * Generates a deterministic, colon-free custom job ID for media cleanup.
 * BullMQ custom job IDs must not contain colons (':').
 *
 * Uses SHA-256 over normalized userId and key to guarantee uniqueness
 * across distinct user/object pairs without leaking raw paths or keys.
 *
 * @param {string} key - S3 object key
 * @param {string} [userId] - Owning user ID
 * @returns {string} Safe custom job ID (e.g. "media-cleanup-a1b2c3d4...")
 */
export const generateMediaCleanupJobId = (key, userId = "") => {
    const normalizedUser = (userId || "").toString().trim();
    const normalizedKey = (key || "").toString().trim();
    const hash = crypto
        .createHash("sha256")
        .update(`${normalizedUser}|${normalizedKey}`)
        .digest("hex");
    return `media-cleanup-${hash}`;
};

/**
 * Enqueues a non-critical media cleanup task to remove an orphaned or replaced
 * photo from storage (e.g. AWS S3).
 *
 * Uses deterministic, colon-free job IDs derived from SHA-256 hash of userId + key
 * to prevent duplicate cleanup jobs without violating BullMQ key syntax rules.
 *
 * @param {Object} params
 * @param {string} params.key - Storage object key (e.g. "profile-photos/<userId>/<file>")
 * @param {string} params.userId - Owning user ID for authorization validation
 * @param {Object} [jobOptions] - Optional job option overrides
 * @returns {Promise<{ enqueued: boolean, jobId?: string }>}
 */
export const enqueueMediaCleanup = async ({ key, userId }, jobOptions = {}) => {
    if (!key || typeof key !== "string") {
        throw new Error("Cannot enqueue media cleanup: key is required and must be a string.");
    }

    if (!isBullMQEnabled()) {
        return { enqueued: false };
    }

    try {
        const queue = getQueue(QUEUE_NAMES.MEDIA_CLEANUP);
        const jobId = generateMediaCleanupJobId(key, userId);

        const minimalPayload = {
            key,
            userId: userId ? userId.toString() : null,
        };

        const job = await queue.add(
            "cleanup-object",
            minimalPayload,
            {
                jobId,
                ...DEFAULT_JOB_OPTIONS,
                ...jobOptions,
            }
        );

        return {
            enqueued: true,
            jobId: job.id || jobId,
        };
    } catch (err) {
        const safeMsg = formatSafeRedisError(err);
        console.error(`[BullMQ:MediaCleanup] Enqueue failed for key '${key}': ${safeMsg}`);
        throw new Error(`Failed to enqueue media cleanup: ${safeMsg}`);
    }
};

// =============================================================================
// Testing Inspection Helpers
// =============================================================================

export const _testingQueueService = {
    setClientOverride: (client) => {
        clientOverride = client;
        isServiceReady = Boolean(client);
    },
    resetClientOverride: () => {
        clientOverride = null;
        isServiceReady = false;
        queues.clear();
    },
    setMockQueue: (name, mockQueue) => {
        queues.set(name, mockQueue);
        isServiceReady = true;
    },
    clearQueues: () => queues.clear(),
};

