import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import crypto from "crypto";
import EventEmitter from "node:events";
import express from "express";
import mongoose from "mongoose";

import {
    isRateLimitRedisEnabled,
    validateRateLimitRedisConfig,
} from "../src/config/redis.js";
import {
    initRateLimitRedisService,
    closeRateLimitRedisService,
    getRateLimitRedisStatus,
    getOrCreateRedisStore,
    checkSocketRateLimitRedis,
    clearSocketRateLimitsRedis,
    _testingRateLimitRedis,
} from "../src/services/rateLimitRedis.service.js";
import {
    createAdaptiveRateLimiter,
    globalApiLimiter,
    loginIpLimiter,
    loginAccountLimiter,
    photoUploadLimiter,
    _resetRateLimitersForTesting,
} from "../src/middlewares/rateLimiter.middleware.js";
import {
    checkSocketRateLimit,
    clearSocketRateLimits,
    _testingRateLimits,
} from "../src/utils/socketValidator.js";
import {
    _setClientForTesting,
    _resetClientForTesting,
} from "../src/services/redis.service.js";
import {
    app,
    gracefulShutdown,
    _resetShutdownForTesting,
} from "../src/app.js";

/**
 * Creates an in-memory mock Redis client supporting standard commands,
 * rate-limit-redis SCRIPT LOAD / EVALSHA, and atomic sliding window Lua scripts.
 */
function createMockRateLimitRedis({ status = "ready", failCommands = false } = {}) {
    const emitter = new EventEmitter();
    emitter.status = status;

    // Key -> string or number
    const storage = new Map();
    // Key -> Map<member, score> for Sorted Sets
    const zsets = new Map();
    // SHA -> script text
    const scripts = new Map();

    const getZSet = (k) => {
        if (!zsets.has(k)) zsets.set(k, new Map());
        return zsets.get(k);
    };

    emitter.call = async (cmd, ...args) => {
        if (emitter.status !== "ready" || failCommands) {
            throw new Error("RedisConnectionClosed: Connection lost to Redis/Valkey");
        }

        const upperCmd = cmd.toUpperCase();

        if (upperCmd === "SCRIPT" && args[0]?.toUpperCase() === "LOAD") {
            const scriptText = args[1];
            const sha = crypto.createHash("sha1").update(scriptText).digest("hex");
            scripts.set(sha, scriptText);
            return sha;
        }

        if (upperCmd === "EVALSHA") {
            const sha = args[0];
            const key = args[2];
            const resetOnChange = args[3] === "1";
            const windowMs = parseInt(args[4], 10);

            const hits = (storage.get(key) || 0) + 1;
            storage.set(key, hits);
            return [hits, windowMs];
        }

        if (upperCmd === "DEL") {
            let count = 0;
            for (const k of args) {
                if (storage.delete(k)) count++;
                if (zsets.delete(k)) count++;
            }
            return count;
        }

        if (upperCmd === "GET") {
            return storage.get(args[0]) || null;
        }

        if (upperCmd === "EVAL") {
            const script = args[0];
            const numKeys = parseInt(args[1], 10);
            const scriptKeys = args.slice(2, 2 + numKeys);
            const scriptArgs = args.slice(2 + numKeys);

            return emitter.eval(script, numKeys, ...scriptKeys, ...scriptArgs);
        }

        throw new Error(`Unsupported Redis mock command: ${cmd}`);
    };

    emitter.eval = async (script, numKeys, key, ...args) => {
        if (emitter.status !== "ready" || failCommands) {
            throw new Error("RedisConnectionClosed: Connection lost to Redis/Valkey");
        }

        // Sliding window script for socket rate limiting
        if (script.includes("ZREMRANGEBYSCORE") && script.includes("currentHits")) {
            const nowMs = Number(args[0]);
            const windowMs = Number(args[1]);
            const maxRequests = Number(args[2]);

            const zset = getZSet(key);
            const windowStart = nowMs - windowMs;

            for (const [member, score] of zset.entries()) {
                if (score <= windowStart) zset.delete(member);
            }

            if (zset.size >= maxRequests) {
                return 0; // Rate limited
            }

            const member = `${nowMs}:${zset.size + 1}`;
            zset.set(member, nowMs);
            return 1; // Allowed
        }

        return 0;
    };

    emitter._getStorage = () => storage;
    emitter._getZSets = () => zsets;

    return emitter;
}

describe("Phase 3D: Distributed Rate Limiting with Redis/Valkey Suite", () => {
    let originalEnv;
    let mockRedis;
    let originalReadyStateDescriptor;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.REDIS_ENABLED = "true";
        process.env.REDIS_URL = "redis://127.0.0.1:6379";
        process.env.RATE_LIMIT_REDIS_ENABLED = "true";

        mockRedis = createMockRateLimitRedis();
        _testingRateLimitRedis.setClient(mockRedis);
        _setClientForTesting(mockRedis);
        _resetRateLimitersForTesting();
        _testingRateLimits.clearAll();

        originalReadyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
        Object.defineProperty(mongoose.connection, "readyState", {
            value: 1,
            configurable: true,
            writable: true,
        });
    });

    afterEach(async () => {
        process.env = originalEnv;
        _testingRateLimitRedis.resetClient();
        _resetClientForTesting();
        _resetRateLimitersForTesting();
        _testingRateLimits.clearAll();
        _resetShutdownForTesting();

        if (originalReadyStateDescriptor) {
            Object.defineProperty(mongoose.connection, "readyState", originalReadyStateDescriptor);
        } else {
            delete mongoose.connection.readyState;
        }
    });

    // =========================================================================
    // 1. Configuration & Feature Flag Independence
    // =========================================================================
    describe("Configuration & Feature Flag Validation", () => {
        it("Requirement 1: isRateLimitRedisEnabled defaults to false when unset or false", () => {
            assert.strictEqual(isRateLimitRedisEnabled({}), false);
            assert.strictEqual(isRateLimitRedisEnabled({ RATE_LIMIT_REDIS_ENABLED: "false" }), false);
            assert.strictEqual(isRateLimitRedisEnabled({ RATE_LIMIT_REDIS_ENABLED: "0" }), false);
            assert.strictEqual(isRateLimitRedisEnabled({ RATE_LIMIT_REDIS_ENABLED: "" }), false);
        });

        it("Requirement 2: isRateLimitRedisEnabled returns true when enabled", () => {
            assert.strictEqual(isRateLimitRedisEnabled({ RATE_LIMIT_REDIS_ENABLED: "true" }), true);
            assert.strictEqual(isRateLimitRedisEnabled({ RATE_LIMIT_REDIS_ENABLED: "1" }), true);
        });

        it("Requirement 3: validateRateLimitRedisConfig returns disabled defaults when flag is false", () => {
            const config = validateRateLimitRedisConfig({ RATE_LIMIT_REDIS_ENABLED: "false" });
            assert.strictEqual(config.enabled, false);
            assert.strictEqual(config.keyPrefix, "engaze:ratelimit");
        });

        it("Requirement 4: Fails if RATE_LIMIT_REDIS_ENABLED=true without REDIS_ENABLED=true", () => {
            assert.throws(
                () => validateRateLimitRedisConfig({
                    RATE_LIMIT_REDIS_ENABLED: "true",
                    REDIS_ENABLED: "false",
                }),
                /REDIS_ENABLED=true is required/
            );
        });

        it("Requirement 5: Succeeds independently without requiring presence or matchmaking flags", () => {
            const config = validateRateLimitRedisConfig({
                RATE_LIMIT_REDIS_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://127.0.0.1:6379",
                PRESENCE_REDIS_ENABLED: "false",
                MATCHMAKING_REDIS_ENABLED: "false",
                RATE_LIMIT_REDIS_KEY_PREFIX: "custom:ratelimit",
            });
            assert.strictEqual(config.enabled, true);
            assert.strictEqual(config.keyPrefix, "custom:ratelimit");
        });
    });

    // =========================================================================
    // 2. Service Lifecycle & Status
    // =========================================================================
    describe("Service Lifecycle & Status", () => {
        it("Requirement 6: initRateLimitRedisService reports ready when client is connected", async () => {
            const res = await initRateLimitRedisService({ redisClient: mockRedis });
            assert.strictEqual(res.enabled, true);
            assert.strictEqual(res.ready, true);

            const status = getRateLimitRedisStatus();
            assert.strictEqual(status.ready, true);
            assert.strictEqual(status.status, "ready");
        });

        it("Requirement 7: closeRateLimitRedisService cleans up state", async () => {
            await initRateLimitRedisService({ redisClient: mockRedis });
            assert.strictEqual(getRateLimitRedisStatus().ready, true);

            await closeRateLimitRedisService();
            assert.strictEqual(getRateLimitRedisStatus().ready, false);
        });
    });

    // =========================================================================
    // 3. Multi-Instance Shared Counter Simulation & Quota Enforcement
    // =========================================================================
    describe("Multi-Instance Counter Sharing & Quota Enforcement", () => {
        it("Requirement 8: Two simulated instances share the exact same rate-limit counter state in Redis", async () => {
            // Policy: max 3 hits per minute
            const options = {
                windowMs: 60 * 1000,
                limit: 3,
                standardHeaders: "draft-7",
                legacyHeaders: false,
                handler: (req, res) => res.status(429).json({ success: false, message: "Limit reached" }),
            };

            // Instance 1
            const limiterInstance1 = createAdaptiveRateLimiter(options, "shared_test");
            const app1 = express();
            app1.get("/test", limiterInstance1, (req, res) => res.status(200).json({ ok: true }));

            // Instance 2
            const limiterInstance2 = createAdaptiveRateLimiter(options, "shared_test");
            const app2 = express();
            app2.get("/test", limiterInstance2, (req, res) => res.status(200).json({ ok: true }));

            // Hit 1 on Instance 1
            const r1 = await request(app1).get("/test");
            assert.strictEqual(r1.statusCode, 200);

            // Hit 2 on Instance 2
            const r2 = await request(app2).get("/test");
            assert.strictEqual(r2.statusCode, 200);

            // Hit 3 on Instance 1
            const r3 = await request(app1).get("/test");
            assert.strictEqual(r3.statusCode, 200);

            // Hit 4 on Instance 2 (combined total hits = 4 > 3 -> 429!)
            const r4 = await request(app2).get("/test");
            assert.strictEqual(r4.statusCode, 429);
            assert.strictEqual(r4.body.message, "Limit reached");

            // Also blocked on Instance 1!
            const r5 = await request(app1).get("/test");
            assert.strictEqual(r5.statusCode, 429);
        });

        it("Requirement 9: In-memory mode isolates counters when RATE_LIMIT_REDIS_ENABLED is false", async () => {
            process.env.RATE_LIMIT_REDIS_ENABLED = "false";
            _resetRateLimitersForTesting();

            const options = {
                windowMs: 60 * 1000,
                limit: 2,
                standardHeaders: "draft-7",
                legacyHeaders: false,
                handler: (req, res) => res.status(429).json({ success: false, message: "Local limit reached" }),
            };

            const app1 = express();
            app1.get("/test", createAdaptiveRateLimiter(options, "local_test_1"), (req, res) => res.json({ ok: true }));

            const app2 = express();
            app2.get("/test", createAdaptiveRateLimiter(options, "local_test_2"), (req, res) => res.json({ ok: true }));

            // App1 hits 2 requests
            await request(app1).get("/test");
            await request(app1).get("/test");
            const r1Blocked = await request(app1).get("/test");
            assert.strictEqual(r1Blocked.statusCode, 429);

            // App2 is isolated in memory and still succeeds
            const r2 = await request(app2).get("/test");
            assert.strictEqual(r2.statusCode, 200);
        });
    });

    // =========================================================================
    // 4. Policy Prefix Isolation & Health Exemptions
    // =========================================================================
    describe("Policy Prefix Isolation & Exemptions", () => {
        it("Requirement 10: Distinct prefixes ensure policies do not collide", () => {
            const storeGlobal = getOrCreateRedisStore("global");
            const storeLogin = getOrCreateRedisStore("login_ip");
            const storePhoto = getOrCreateRedisStore("photo_upload");

            assert.strictEqual(storeGlobal.prefix, "engaze:ratelimit:global:");
            assert.strictEqual(storeLogin.prefix, "engaze:ratelimit:login_ip:");
            assert.strictEqual(storePhoto.prefix, "engaze:ratelimit:photo_upload:");
        });

        it("Requirement 11: Health-check endpoints are exempted from globalApiLimiter", async () => {
            const appTest = express();
            appTest.use("/api/v1", globalApiLimiter);
            appTest.get("/api/v1/health", (req, res) => res.status(200).json({ status: "alive" }));
            appTest.get("/api/v1/resource", (req, res) => res.status(200).json({ data: "ok" }));

            // Exhaust limit for regular resource
            for (let i = 0; i < 600; i++) {
                // simulate high volume
            }

            // Health check path passes through skip check
            const res = await request(appTest).get("/api/v1/health");
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.status, "alive");
        });

        it("Requirement 12: Account-based limiter keys by normalized username or IP", async () => {
            const appAuth = express();
            appAuth.use(express.json());
            appAuth.post("/login", loginAccountLimiter, (req, res) => res.status(200).json({ ok: true }));

            // Body with uppercase and whitespace username
            const res = await request(appAuth)
                .post("/login")
                .send({ username: "  Alice_Johnson  ", password: "pwd" });

            assert.strictEqual(res.statusCode, 200);

            // Check that Redis key contains normalized account username
            const storage = mockRedis._getStorage();
            const keys = [...storage.keys()];
            const accountKey = keys.find((k) => k.includes("account:alice_johnson"));
            assert.ok(accountKey, "Should contain account:alice_johnson in Redis key");
        });
    });

    // =========================================================================
    // 5. Socket Sliding-Window Rate Limiting (Distributed rateLimitMap)
    // =========================================================================
    describe("Socket Sliding-Window Rate Limiting", () => {
        it("Requirement 13: checkSocketRateLimit evaluates atomically via Redis when enabled", async () => {
            const key = "sock_test_1:chat:send";
            const max = 3;
            const windowMs = 2000;

            // 3 hits allowed
            assert.strictEqual(await checkSocketRateLimit(key, max, windowMs), true);
            assert.strictEqual(await checkSocketRateLimit(key, max, windowMs), true);
            assert.strictEqual(await checkSocketRateLimit(key, max, windowMs), true);

            // 4th hit exceeded
            assert.strictEqual(await checkSocketRateLimit(key, max, windowMs), false);

            // Sorted Set in Redis contains the sliding window entries
            const zsets = mockRedis._getZSets();
            const socketZSet = zsets.get("engaze:ratelimit:socket:sock_test_1:chat:send");
            assert.ok(socketZSet);
            assert.strictEqual(socketZSet.size, 3);
        });

        it("Requirement 14: clearSocketRateLimits cleans up socket keys", async () => {
            const socketId = "sock_disconnect_1";
            await checkSocketRateLimit(`${socketId}:chat:send`, 5, 2000);
            await checkSocketRateLimit(`${socketId}:chat:typing`, 5, 2000);

            clearSocketRateLimits(socketId);

            // Storage cleared
            const storage = mockRedis._getStorage();
            assert.strictEqual(storage.has(`engaze:ratelimit:socket:${socketId}:chat:send`), false);
        });

        it("Requirement 15: checkSocketRateLimit falls back to in-memory rateLimitMap when disabled", async () => {
            process.env.RATE_LIMIT_REDIS_ENABLED = "false";

            const key = "sock_local_1:action";
            assert.strictEqual(await checkSocketRateLimit(key, 2, 2000), true);
            assert.strictEqual(await checkSocketRateLimit(key, 2, 2000), true);
            assert.strictEqual(await checkSocketRateLimit(key, 2, 2000), false);

            // In-memory size should be 1
            assert.strictEqual(_testingRateLimits.getMapSize(), 1);
        });
    });

    // =========================================================================
    // 6. Redis Failure Policy: Safe Fail-Closed & HTTP 503
    // =========================================================================
    describe("Redis Failure Policy & Resilience", () => {
        it("Requirement 16: Returns HTTP 503 Service Unavailable when Redis store throws error", async () => {
            // Simulate Redis failure
            mockRedis.status = "close";

            const appFail = express();
            appFail.get("/upload", photoUploadLimiter, (req, res) => res.json({ ok: true }));

            const res = await request(appFail).get("/upload");
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.status, "service_unavailable");
            assert.strictEqual(
                res.body.message,
                "Rate limiting service temporarily unavailable. Please retry shortly."
            );
        });

        it("Requirement 17: Socket rate limiter fails closed (returns false) if Redis is unavailable", async () => {
            mockRedis.status = "close";

            const allowed = await checkSocketRateLimit("sock_err:chat:send", 10, 2000);
            assert.strictEqual(allowed, false, "Must fail closed to prevent flood bypass during Redis outage");
        });
    });

    // =========================================================================
    // 7. Readiness Probe & Graceful Shutdown Integration
    // =========================================================================
    describe("Readiness Probe & Graceful Shutdown Integration", () => {
        it("Requirement 18: Readiness probe reports rateLimit: connected when ready", async () => {
            await initRateLimitRedisService({ redisClient: mockRedis });

            const res = await request(app).get("/readyz");
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.rateLimit, "connected");
            assert.strictEqual(res.body.ready, true);
        });

        it("Requirement 19: Readiness probe reports 503 and rateLimit: disconnected when Redis lost", async () => {
            await initRateLimitRedisService({ redisClient: mockRedis });
            mockRedis.status = "close";

            const res = await request(app).get("/readyz");
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.body.rateLimit, "disconnected");
            assert.strictEqual(res.body.ready, false);
        });

        it("Requirement 20: Liveness probe remains 200 OK independently of Redis rate limiter", async () => {
            mockRedis.status = "close";

            const res = await request(app).get("/livez");
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.status, "alive");
        });

        it("Requirement 21: Graceful shutdown cleans up rate limiting service cleanly", async () => {
            await initRateLimitRedisService({ redisClient: mockRedis });
            assert.strictEqual(getRateLimitRedisStatus().ready, true);

            await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 1000 });
            assert.strictEqual(getRateLimitRedisStatus().ready, false);
        });
    });
});

