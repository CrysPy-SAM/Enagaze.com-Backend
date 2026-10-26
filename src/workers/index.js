/**
 * BullMQ Background Worker Process Entry Point (Phase 4A)
 *
 * Standalone background worker process for asynchronous, reliable job execution.
 * Run independently via: `npm run worker`
 *
 * Requirements:
 * 1. Independent worker process: never runs inside the Express request loop.
 * 2. Dedicated worker Redis connection with `maxRetriesPerRequest: null`.
 * 3. Bounded worker concurrency.
 * 4. Graceful shutdown on SIGTERM and SIGINT with a strict bounded deadline.
 * 5. Sanitized logging (no credentials, no tokens).
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Worker } from "bullmq";
import {
    isBullMQEnabled,
    validateBullMQConfig,
    formatSafeRedisError,
} from "../config/redis.js";
import {
    QUEUE_NAMES,
    createWorkerRedisClient,
} from "../config/queue.js";
import { processMediaCleanupJob } from "./mediaCleanup.worker.js";

// Load environment variables if running directly
dotenv.config();

let activeWorker = null;
let activeWorkerClient = null;
let isShuttingDown = false;

/**
 * Initializes and starts all registered BullMQ worker processors.
 *
 * @param {Object} [options]
 * @param {Object} [options.redisClient] - Optional injected client for testing
 * @param {number} [options.concurrency] - Worker concurrency override
 * @param {boolean} [options.registerSignalHandlers=false] - Whether to bind process SIGTERM/SIGINT
 * @returns {Promise<{ worker: Worker, workerClient: Object, shutdown: Function }>}
 */
export const startWorkerProcess = async ({
    redisClient = null,
    concurrency = null,
    registerSignalHandlers = false,
} = {}) => {
    const config = validateBullMQConfig();
    if (!config.enabled) {
        throw new Error("Cannot start worker: BULLMQ_ENABLED is false. Set BULLMQ_ENABLED=true and configure REDIS_URL.");
    }

    const effectiveConcurrency = concurrency || config.concurrency || 5;
    const prefix = config.keyPrefix || "engaze:bullmq";

    // Dedicated worker client with maxRetriesPerRequest: null
    const workerClient = redisClient || createWorkerRedisClient(config.redisConfig);
    activeWorkerClient = workerClient;

    if (typeof workerClient.on === "function") {
        workerClient.on("error", (err) => {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[BullMQ:WorkerClient] Redis connection error: ${safeMsg}`);
        });
    }

    try {
        const worker = new Worker(
            QUEUE_NAMES.MEDIA_CLEANUP,
            processMediaCleanupJob,
            {
                connection: workerClient,
                concurrency: effectiveConcurrency,
                prefix,
            }
        );
        activeWorker = worker;

        // Sanitized event listeners
        worker.on("completed", (job) => {
            console.log(`[BullMQ:Worker] Job ${job.id} (${job.name}) completed successfully.`);
        });

        worker.on("failed", (job, err) => {
            const safeErr = err?.message || "Unknown error";
            const attempts = job ? `${job.attemptsMade}/${job.opts.attempts}` : "unknown";
            console.error(`[BullMQ:Worker] Job ${job?.id} (${job?.name}) failed (attempt ${attempts}): ${safeErr}`);
        });

        worker.on("error", (err) => {
            const safeMsg = formatSafeRedisError(err);
            console.error(`[BullMQ:Worker] Connection/runtime error: ${safeMsg}`);
        });

        const shutdown = (timeoutMs = 10000) => shutdownWorkerProcess({ timeoutMs });

        if (registerSignalHandlers) {
            const handleSignal = async (signal) => {
                if (isShuttingDown) return;
                console.log(`\n[BullMQ:Worker] Received ${signal}. Initiating graceful worker shutdown...`);
                await shutdown();
                process.exit(0);
            };

            process.once("SIGTERM", () => handleSignal("SIGTERM"));
            process.once("SIGINT", () => handleSignal("SIGINT"));
        }

        console.log(`✅ [BullMQ:Worker] Worker process started for queue '${QUEUE_NAMES.MEDIA_CLEANUP}' (concurrency: ${effectiveConcurrency}).`);
        return { worker, workerClient, shutdown };
    } catch (startupErr) {
        const safeMsg = formatSafeRedisError(startupErr);
        console.error(`❌ [BullMQ:Worker] Startup failure: ${safeMsg}`);
        await shutdownWorkerProcess({ timeoutMs: 2000 });
        throw startupErr;
    }
};

/**
 * Gracefully shuts down the worker process with a bounded timeout.
 * Stops accepting new jobs and waits for active jobs to finish up to timeoutMs.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000]
 */
export const shutdownWorkerProcess = async ({ timeoutMs = 10000 } = {}) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("[BullMQ:Worker] Stopping worker and closing connections...");

    try {
        if (activeWorker) {
            // worker.close() pauses queue and waits for in-flight jobs to complete
            const closePromise = activeWorker.close();
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => {
                    console.warn(`[BullMQ:Worker] Graceful shutdown timeout (${timeoutMs}ms) exceeded. Forcing worker stop.`);
                    resolve();
                }, timeoutMs)
            );
            await Promise.race([closePromise, timeoutPromise]);
            activeWorker = null;
        }

        if (activeWorkerClient) {
            try {
                if (typeof activeWorkerClient.quit === "function") {
                    await activeWorkerClient.quit();
                } else if (typeof activeWorkerClient.disconnect === "function") {
                    activeWorkerClient.disconnect();
                }
            } catch (_) {}
            activeWorkerClient = null;
        }

        console.log("[BullMQ:Worker] Worker shutdown complete.");
    } finally {
        isShuttingDown = false;
    }
};

// Auto-run if executed directly as entry script
const isDirectExecution = () => {
    try {
        const currentFile = fileURLToPath(import.meta.url);
        return process.argv[1] && currentFile === process.argv[1];
    } catch {
        return false;
    }
};

if (isDirectExecution()) {
    startWorkerProcess({ registerSignalHandlers: true }).catch((err) => {
        console.error("Fatal worker startup failure:", err.message);
        process.exit(1);
    });
}

