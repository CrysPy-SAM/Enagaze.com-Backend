/**
 * Phase 4A: BullMQ Background Worker Infrastructure Test Suite
 *
 * Verifies:
 * 1. Configuration & Feature Flag Validation (defaults to false, prerequisite checks).
 * 2. Producer vs Worker Connection Options (bounded vs maxRetriesPerRequest: null).
 * 3. Queue Producer Lifecycle, Status Probes & Idempotent Shutdown.
 * 4. Deterministic Job IDs & Bounded Retention Options.
 * 5. Media Cleanup Worker Processor (Idempotency, key path validation, retry propagation).
 * 6. Worker Process Lifecycle & Graceful Bounded Shutdown.
 * 7. Express Readiness Probe & Storage Service Integration.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import {
    isBullMQEnabled,
    validateBullMQConfig,
} from "../src/config/redis.js";
import {
    QUEUE_NAMES,
    DEFAULT_JOB_OPTIONS,
    getProducerConnectionConfig,
    getWorkerConnectionConfig,
} from "../src/config/queue.js";
import {
    initQueueService,
    closeQueueService,
    getQueueServiceStatus,
    enqueueMediaCleanup,
    _testingQueueService,
} from "../src/services/queue.service.js";
import { processMediaCleanupJob } from "../src/workers/mediaCleanup.worker.js";
import {
    startWorkerProcess,
    shutdownWorkerProcess,
} from "../src/workers/index.js";
import {
    dispatchMediaCleanup,
    getStorageAdapter,
    setStorageAdapter,
} from "../src/services/storage.service.js";
import { app } from "../src/app.js";

// =============================================================================
// Mock Redis Client Builder
// =============================================================================

function createMockRedisClient() {
    return {
        status: "ready",
        options: {},
        quit: async () => "OK",
        disconnect: () => {},
        on: () => {},
        once: () => {},
        off: () => {},
    };
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Phase 4A: BullMQ Background Worker Infrastructure Suite", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.BULLMQ_ENABLED;
        delete process.env.BULLMQ_KEY_PREFIX;
        delete process.env.BULLMQ_CONCURRENCY;
        _testingQueueService.resetClientOverride();
    });

    afterEach(async () => {
        await closeQueueService();
        await shutdownWorkerProcess({ timeoutMs: 100 });
        _testingQueueService.resetClientOverride();
        process.env = { ...originalEnv };
    });

    // =========================================================================
    // 1. Configuration & Feature Flag Validation
    // =========================================================================

    describe("1. Configuration & Feature Flag Validation", () => {
        it("Requirement 1: isBullMQEnabled defaults to false when unset, empty, or false", () => {
            assert.equal(isBullMQEnabled({}), false);
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "" }), false);
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "false" }), false);
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "0" }), false);
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "no" }), false);
        });

        it("Requirement 2: isBullMQEnabled returns true for 'true' or '1'", () => {
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "true" }), true);
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "TRUE" }), true);
            assert.equal(isBullMQEnabled({ BULLMQ_ENABLED: "1" }), true);
        });

        it("Requirement 3: validateBullMQConfig returns disabled defaults when flag is false", () => {
            const config = validateBullMQConfig({ BULLMQ_ENABLED: "false" });
            assert.equal(config.enabled, false);
            assert.equal(config.keyPrefix, "engaze:bullmq");
            assert.equal(config.concurrency, 5);
        });

        it("Requirement 4: Fails startup validation if BULLMQ_ENABLED=true without REDIS_ENABLED=true", () => {
            assert.throws(
                () => {
                    validateBullMQConfig({
                        BULLMQ_ENABLED: "true",
                        REDIS_ENABLED: "false",
                    });
                },
                /REDIS_ENABLED=true is required when BULLMQ_ENABLED=true/i
            );
        });

        it("Requirement 5: Fails startup validation if BULLMQ_ENABLED=true without REDIS_URL", () => {
            assert.throws(
                () => {
                    validateBullMQConfig({
                        BULLMQ_ENABLED: "true",
                        REDIS_ENABLED: "true",
                        REDIS_URL: "",
                    });
                },
                /REDIS_URL is required/i
            );
        });

        it("Requirement 6: Parses custom BULLMQ_KEY_PREFIX and bounded BULLMQ_CONCURRENCY", () => {
            const config = validateBullMQConfig({
                BULLMQ_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://127.0.0.1:6379",
                BULLMQ_KEY_PREFIX: "custom:prefix",
                BULLMQ_CONCURRENCY: "12",
            });
            assert.equal(config.enabled, true);
            assert.equal(config.keyPrefix, "custom:prefix");
            assert.equal(config.concurrency, 12);
        });
    });

    // =========================================================================
    // 2. Producer vs Worker Connection Options
    // =========================================================================

    describe("2. Producer vs Worker Connection Options", () => {
        const dummyRedisConfig = {
            url: "redis://127.0.0.1:6379",
            tls: false,
        };

        it("Requirement 7: getProducerConnectionConfig enforces bounded maxRetriesPerRequest (3)", () => {
            const opts = getProducerConnectionConfig(dummyRedisConfig);
            assert.equal(opts.url, "redis://127.0.0.1:6379");
            assert.equal(opts.maxRetriesPerRequest, 3);
            assert.equal(opts.enableReadyCheck, false);
        });

        it("Requirement 8: getWorkerConnectionConfig strictly enforces maxRetriesPerRequest: null", () => {
            const opts = getWorkerConnectionConfig(dummyRedisConfig);
            assert.equal(opts.url, "redis://127.0.0.1:6379");
            assert.equal(opts.maxRetriesPerRequest, null);
            assert.equal(opts.enableReadyCheck, false);
        });

        it("Requirement 9: Separate configurations ensure producer and worker clients do not share retry policy", () => {
            const producerOpts = getProducerConnectionConfig(dummyRedisConfig);
            const workerOpts = getWorkerConnectionConfig(dummyRedisConfig);
            assert.notEqual(producerOpts.maxRetriesPerRequest, workerOpts.maxRetriesPerRequest);
            assert.equal(producerOpts.maxRetriesPerRequest, 3);
            assert.equal(workerOpts.maxRetriesPerRequest, null);
        });
    });

    // =========================================================================
    // 3. Queue Producer Lifecycle & Health Probes
    // =========================================================================

    describe("3. Queue Producer Lifecycle & Health Probes", () => {
        it("Requirement 10: initQueueService is a no-op when BULLMQ_ENABLED is false", async () => {
            process.env.BULLMQ_ENABLED = "false";
            const res = await initQueueService();
            assert.equal(res.enabled, false);
            assert.equal(res.ready, false);

            const status = getQueueServiceStatus();
            assert.equal(status.enabled, false);
            assert.equal(status.status, "disabled");
        });

        it("Requirement 11: initQueueService initializes registered queues when enabled", async () => {
            process.env.BULLMQ_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://127.0.0.1:6379";

            const mockClient = createMockRedisClient();
            _testingQueueService.setClientOverride(mockClient);

            const res = await initQueueService({ redisClient: mockClient });
            assert.equal(res.enabled, true);
            assert.equal(res.ready, true);

            const status = getQueueServiceStatus();
            assert.equal(status.enabled, true);
            assert.equal(status.ready, true);
            assert.equal(status.status, "ready");
            assert.ok(status.queues.includes(QUEUE_NAMES.MEDIA_CLEANUP));
        });

        it("Requirement 12: getQueueServiceStatus sanitizes output without leaking credentials or job data", () => {
            process.env.BULLMQ_ENABLED = "false";
            const status = getQueueServiceStatus();
            assert.deepEqual(status, {
                enabled: false,
                ready: true,
                status: "disabled",
            });
        });

        it("Requirement 13: closeQueueService closes all active queues and resets state", async () => {
            process.env.BULLMQ_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://127.0.0.1:6379";

            const mockClient = createMockRedisClient();
            _testingQueueService.setClientOverride(mockClient);

            await initQueueService({ redisClient: mockClient });
            const closeRes = await closeQueueService();
            assert.equal(closeRes.ready, false);

            const status = getQueueServiceStatus();
            assert.equal(status.ready, false);
        });

        it("Requirement 14: Repeated closeQueueService calls are safe and idempotent", async () => {
            await assert.doesNotReject(async () => {
                await closeQueueService();
                await closeQueueService();
                await closeQueueService();
            });
        });
    });

    // =========================================================================
    // 4. Deterministic Job IDs & Enqueue Behavior
    // =========================================================================

    describe("4. Deterministic Job IDs & Enqueue Behavior", () => {
        it("Requirement 15: enqueueMediaCleanup returns enqueued: false when disabled", async () => {
            process.env.BULLMQ_ENABLED = "false";
            const res = await enqueueMediaCleanup({
                key: "profile-photos/user123/pic.jpg",
                userId: "user123",
            });
            assert.deepEqual(res, { enqueued: false });
        });

        it("Requirement 16: enqueueMediaCleanup generates deterministic jobId and uses default retention", async () => {
            process.env.BULLMQ_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://127.0.0.1:6379";

            let capturedJob = null;
            const mockQueue = {
                add: async (name, data, opts) => {
                    capturedJob = { name, data, opts };
                    return { id: opts.jobId };
                },
                close: async () => {},
            };

            _testingQueueService.setMockQueue(QUEUE_NAMES.MEDIA_CLEANUP, mockQueue);

            const testKey = "profile-photos/user123/avatar_1.webp";
            const res = await enqueueMediaCleanup({
                key: testKey,
                userId: "user123",
            });

            assert.equal(res.enqueued, true);
            assert.equal(res.jobId, `media-cleanup:${encodeURIComponent(testKey)}`);
            assert.equal(capturedJob.name, "cleanup-object");
            assert.equal(capturedJob.data.key, testKey);
            assert.equal(capturedJob.data.userId, "user123");
            assert.equal(capturedJob.opts.attempts, DEFAULT_JOB_OPTIONS.attempts);
            assert.deepEqual(capturedJob.opts.backoff, DEFAULT_JOB_OPTIONS.backoff);
            assert.deepEqual(capturedJob.opts.removeOnComplete, DEFAULT_JOB_OPTIONS.removeOnComplete);
            assert.deepEqual(capturedJob.opts.removeOnFail, DEFAULT_JOB_OPTIONS.removeOnFail);
        });

        it("Requirement 17: enqueueMediaCleanup rejects with error if key is missing or invalid", async () => {
            await assert.rejects(
                async () => enqueueMediaCleanup({ key: "", userId: "u1" }),
                /key is required and must be a string/i
            );
        });
    });

    // =========================================================================
    // 5. Media Cleanup Worker Processor (Idempotency & Safety)
    // =========================================================================

    describe("5. Media Cleanup Worker Processor (Idempotency & Safety)", () => {
        let deletedKeys = [];
        const originalStorageAdapter = getStorageAdapter();

        beforeEach(() => {
            deletedKeys = [];
            setStorageAdapter({
                deleteObject: async (key) => {
                    deletedKeys.push(key);
                    return true;
                },
            });
        });

        afterEach(() => {
            setStorageAdapter(originalStorageAdapter);
        });

        it("Requirement 18: processMediaCleanupJob validates user path and calls adapter.deleteObject", async () => {
            const fakeJob = {
                id: "job-1",
                data: {
                    key: "profile-photos/user456/photo1.jpg",
                    userId: "user456",
                },
                attemptsMade: 0,
            };

            const result = await processMediaCleanupJob(fakeJob);
            assert.deepEqual(result, { deleted: true, key: "profile-photos/user456/photo1.jpg" });
            assert.equal(deletedKeys.length, 1);
            assert.equal(deletedKeys[0], "profile-photos/user456/photo1.jpg");
        });

        it("Requirement 19: processMediaCleanupJob aborts if key does not match userId directory", async () => {
            const fakeJob = {
                id: "job-bad",
                data: {
                    key: "profile-photos/attacker/photo.jpg",
                    userId: "victim123",
                },
                attemptsMade: 0,
            };

            const result = await processMediaCleanupJob(fakeJob);
            assert.equal(result.deleted, false);
            assert.equal(result.reason, "unauthorized_key");
            assert.equal(deletedKeys.length, 0); // No delete executed
        });

        it("Requirement 20: processMediaCleanupJob is idempotent when object is already deleted", async () => {
            // S3 and our mock return successfully if object is already gone
            const fakeJob = {
                id: "job-2",
                data: {
                    key: "profile-photos/user456/already_deleted.jpg",
                    userId: "user456",
                },
                attemptsMade: 1,
            };

            const result = await processMediaCleanupJob(fakeJob);
            assert.deepEqual(result, { deleted: true, key: "profile-photos/user456/already_deleted.jpg" });
        });

        it("Requirement 21: processMediaCleanupJob re-throws transient error to allow BullMQ retry", async () => {
            setStorageAdapter({
                deleteObject: async () => {
                    throw new Error("S3 503 Service Unavailable");
                },
            });

            const fakeJob = {
                id: "job-transient",
                data: {
                    key: "profile-photos/user456/photo.jpg",
                    userId: "user456",
                },
                attemptsMade: 0,
            };

            await assert.rejects(
                async () => processMediaCleanupJob(fakeJob),
                /S3 503 Service Unavailable/
            );
        });
    });

    // =========================================================================
    // 6. Worker Process Lifecycle & Graceful Shutdown
    // =========================================================================

    describe("6. Worker Process Lifecycle & Graceful Shutdown", () => {
        it("Requirement 22: startWorkerProcess fails with error if BULLMQ_ENABLED is false", async () => {
            process.env.BULLMQ_ENABLED = "false";
            await assert.rejects(
                async () => startWorkerProcess(),
                /BULLMQ_ENABLED is false/i
            );
        });

        it("Requirement 23: startWorkerProcess starts worker with configured concurrency and worker client", async () => {
            process.env.BULLMQ_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://127.0.0.1:6379";

            const mockWorkerClient = createMockRedisClient();

            const { worker, shutdown } = await startWorkerProcess({
                redisClient: mockWorkerClient,
                concurrency: 7,
            });

            assert.ok(worker);
            assert.equal(worker.opts.concurrency, 7);

            await shutdown(100);
        });

        it("Requirement 24: shutdownWorkerProcess closes active worker and client within bounded deadline", async () => {
            process.env.BULLMQ_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://127.0.0.1:6379";

            const mockWorkerClient = createMockRedisClient();
            await startWorkerProcess({ redisClient: mockWorkerClient });

            await assert.doesNotReject(async () => {
                await shutdownWorkerProcess({ timeoutMs: 200 });
            });
        });

        it("Requirement 25: Repeated shutdownWorkerProcess calls do not error", async () => {
            await assert.doesNotReject(async () => {
                await shutdownWorkerProcess({ timeoutMs: 100 });
                await shutdownWorkerProcess({ timeoutMs: 100 });
            });
        });
    });

    // =========================================================================
    // 7. Express Readiness Probe & Storage Service Integration
    // =========================================================================

    describe("7. Express Readiness Probe & Storage Service Integration", () => {
        it("Requirement 26: Readiness probe omits bullmq field when BULLMQ_ENABLED=false", async () => {
            process.env.BULLMQ_ENABLED = "false";
            const res = await request(app).get("/readyz");
            assert.equal(res.body.bullmq, undefined);
        });

        it("Requirement 27: dispatchMediaCleanup delegates to queue when enabled, falls back inline when disabled", async () => {
            let inlineDeleted = [];
            const mockAdapter = {
                deleteObject: async (k) => inlineDeleted.push(k),
            };

            // Mode 1: Disabled -> deletes inline
            process.env.BULLMQ_ENABLED = "false";
            await dispatchMediaCleanup({
                key: "profile-photos/user1/pic1.jpg",
                userId: "user1",
                adapter: mockAdapter,
            });
            assert.equal(inlineDeleted.length, 1);
            assert.equal(inlineDeleted[0], "profile-photos/user1/pic1.jpg");

            // Mode 2: Enabled -> enqueues to BullMQ
            process.env.BULLMQ_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://127.0.0.1:6379";

            let enqueuedKeys = [];
            _testingQueueService.setMockQueue(QUEUE_NAMES.MEDIA_CLEANUP, {
                add: async (_name, data) => {
                    enqueuedKeys.push(data.key);
                    return { id: "job-mock" };
                },
                close: async () => {},
            });

            await dispatchMediaCleanup({
                key: "profile-photos/user1/pic2.jpg",
                userId: "user1",
                adapter: mockAdapter,
            });
            assert.equal(enqueuedKeys.length, 1);
            assert.equal(enqueuedKeys[0], "profile-photos/user1/pic2.jpg");
            // Inline delete was NOT called for pic2
            assert.equal(inlineDeleted.length, 1);
        });

        it("Requirement 28: Liveness probe (/health) remains 200 OK independently of BullMQ state", async () => {
            const res = await request(app).get("/health");
            assert.equal(res.status, 200);
        });
    });
});
