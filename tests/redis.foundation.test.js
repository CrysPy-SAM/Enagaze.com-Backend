import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import mongoose from "mongoose";
import EventEmitter from "node:events";

import {
    isRedisEnabled,
    validateRedisConfig,
    formatSafeRedisError,
} from "../src/config/redis.js";
import {
    initRedisClient,
    getRedisClient,
    getRedisStatus,
    closeRedisClient,
    _setClientForTesting,
    _resetClientForTesting,
} from "../src/services/redis.service.js";
import {
    app,
    server,
    start,
    gracefulShutdown,
    _resetShutdownForTesting,
} from "../src/app.js";

/**
 * Creates a controllable mock Redis client adhering to ioredis EventEmitter interface.
 */
function createMockRedisClient({ status = "ready", connectDelayMs = 0, failConnect = false, failQuit = false } = {}) {
    const emitter = new EventEmitter();
    emitter.status = status;

    emitter.connect = async () => {
        if (connectDelayMs > 0) {
            await new Promise((r) => setTimeout(r, connectDelayMs));
        }
        if (failConnect) {
            emitter.status = "end";
            const err = new Error("ECONNREFUSED: Connection refused to Redis host");
            err.code = "ECONNREFUSED";
            emitter.emit("error", err);
            throw err;
        }
        emitter.status = status;
        emitter.emit("ready");
    };

    emitter.quit = async () => {
        if (failQuit) {
            throw new Error("Failed to cleanly quit Redis connection");
        }
        emitter.status = "end";
        emitter.emit("close");
    };

    emitter.disconnect = () => {
        emitter.status = "end";
        emitter.emit("close");
    };

    return emitter;
}

describe("Phase 3A: Redis/Valkey Foundation & Reliability Suite", () => {
    const originalEnv = { ...process.env };
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    let originalReadyState;
    let testLogs = [];
    let testErrLogs = [];

    beforeEach(() => {
        testLogs = [];
        testErrLogs = [];
        console.log = (...args) => testLogs.push(args.join(" "));
        console.error = (...args) => testErrLogs.push(args.join(" "));
        process.env = { ...originalEnv };
        delete process.env.REDIS_ENABLED;
        delete process.env.REDIS_URL;
        originalReadyState = mongoose.connection.readyState;
        _resetShutdownForTesting();
        _resetClientForTesting();
    });

    afterEach(async () => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.env = { ...originalEnv };
        delete server.listening;
        _resetShutdownForTesting();
        _resetClientForTesting();
        Object.defineProperty(mongoose.connection, "readyState", {
            value: originalReadyState,
            configurable: true,
            writable: true,
        });
    });

    // =========================================================================
    // 1. Centralized Configuration & Sanitization
    // =========================================================================
    describe("1. Configuration & Security Validation", () => {
        it("isRedisEnabled returns false by default when REDIS_ENABLED is absent", () => {
            delete process.env.REDIS_ENABLED;
            assert.equal(isRedisEnabled(), false);
        });

        it("isRedisEnabled returns false when REDIS_ENABLED is 'false', '0', or invalid", () => {
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "false" }), false);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "FALSE" }), false);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "0" }), false);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "" }), false);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "arbitrary" }), false);
        });

        it("isRedisEnabled returns true when REDIS_ENABLED is 'true' or '1'", () => {
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "true" }), true);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "TRUE" }), true);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "  true  " }), true);
            assert.equal(isRedisEnabled({ REDIS_ENABLED: "1" }), true);
        });

        it("validateRedisConfig returns disabled state when REDIS_ENABLED is false", () => {
            const config = validateRedisConfig({ REDIS_ENABLED: "false" });
            assert.equal(config.enabled, false);
            assert.equal(config.url, null);
            assert.equal(config.tls, false);
        });

        it("throws sanitized error when REDIS_ENABLED=true but REDIS_URL is missing or empty", () => {
            assert.throws(
                () => validateRedisConfig({ REDIS_ENABLED: "true" }),
                /REDIS_URL is required when REDIS_ENABLED=true/
            );
            assert.throws(
                () => validateRedisConfig({ REDIS_ENABLED: "true", REDIS_URL: "   " }),
                /REDIS_URL is required when REDIS_ENABLED=true/
            );
        });

        it("throws sanitized error when REDIS_URL is malformed", () => {
            assert.throws(
                () => validateRedisConfig({ REDIS_ENABLED: "true", REDIS_URL: "not_a_valid_url" }),
                /REDIS_URL is malformed/
            );
        });

        it("rejects unsupported protocols (e.g., http://, postgres://)", () => {
            assert.throws(
                () => validateRedisConfig({ REDIS_ENABLED: "true", REDIS_URL: "http://localhost:6379" }),
                /REDIS_URL must use 'redis:' or 'rediss:' protocol/
            );
            assert.throws(
                () => validateRedisConfig({ REDIS_ENABLED: "true", REDIS_URL: "postgres://localhost:5432" }),
                /REDIS_URL must use 'redis:' or 'rediss:' protocol/
            );
        });

        it("rejects URLs lacking a hostname", () => {
            assert.throws(
                () => validateRedisConfig({ REDIS_ENABLED: "true", REDIS_URL: "redis://" }),
                /REDIS_URL must specify a host/
            );
        });

        it("parses valid redis:// URL correctly with default port and TLS disabled", () => {
            const config = validateRedisConfig({
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://localhost:6379",
            });
            assert.equal(config.enabled, true);
            assert.equal(config.host, "localhost");
            assert.equal(config.port, 6379);
            assert.equal(config.tls, false);
        });

        it("parses valid rediss:// TLS URL correctly with default TLS port", () => {
            const config = validateRedisConfig({
                REDIS_ENABLED: "true",
                REDIS_URL: "rediss://cache.internal.render.com",
            });
            assert.equal(config.enabled, true);
            assert.equal(config.host, "cache.internal.render.com");
            assert.equal(config.port, 6380);
            assert.equal(config.tls, true);
        });

        it("never includes passwords or credentials in error messages", () => {
            const secretPassword = "super_secret_redis_password_xyz987";
            const sensitiveUrl = `redis://default:${secretPassword}@invalid-domain-with-no-host/`;

            try {
                validateRedisConfig({
                    REDIS_ENABLED: "true",
                    REDIS_URL: sensitiveUrl,
                });
            } catch (err) {
                assert.ok(!err.message.includes(secretPassword), "Secret password must not appear in error message");
            }

            const formattedErr = formatSafeRedisError(new Error(`Failed to connect to ${sensitiveUrl}`));
            assert.ok(!formattedErr.includes(secretPassword), "Credentials must not appear in formatted errors");
            assert.ok(formattedErr.includes("Redis connection failed"));
        });
    });

    // =========================================================================
    // 2. Client Lifecycle, Error Handling & Idempotency
    // =========================================================================
    describe("2. Client Service Lifecycle & Connection Management", () => {
        it("initRedisClient returns null and makes zero connection attempts when disabled", async () => {
            let factoryCalled = false;
            const client = await initRedisClient({
                env: { REDIS_ENABLED: "false" },
                clientFactory: () => {
                    factoryCalled = true;
                },
            });

            assert.equal(client, null);
            assert.equal(factoryCalled, false);
            assert.equal(getRedisClient(), null);
        });

        it("initRedisClient connects and returns active client when enabled", async () => {
            const mock = createMockRedisClient({ status: "ready" });
            const client = await initRedisClient({
                env: { REDIS_ENABLED: "true", REDIS_URL: "redis://localhost:6379" },
                clientFactory: () => mock,
            });

            assert.equal(client, mock);
            assert.equal(getRedisClient(), mock);
            assert.equal(mock.status, "ready");
        });

        it("initRedisClient is idempotent and returns existing client without reconnecting", async () => {
            let connectCalls = 0;
            const mock = createMockRedisClient({ status: "ready" });
            mock.connect = async () => {
                connectCalls++;
                mock.status = "ready";
            };

            const client1 = await initRedisClient({
                env: { REDIS_ENABLED: "true", REDIS_URL: "redis://localhost:6379" },
                clientFactory: () => mock,
            });
            const client2 = await initRedisClient({
                env: { REDIS_ENABLED: "true", REDIS_URL: "redis://localhost:6379" },
                clientFactory: () => mock,
            });

            assert.equal(client1, client2);
            assert.equal(connectCalls, 1, "Must not connect multiple times for same client");
        });

        it("registered error listener prevents unhandled EventEmitter errors during runtime", async () => {
            const mock = createMockRedisClient({ status: "ready" });
            await initRedisClient({
                env: { REDIS_ENABLED: "true", REDIS_URL: "redis://localhost:6379" },
                clientFactory: () => mock,
            });

            // Emit a runtime error event on the client
            assert.doesNotThrow(() => {
                const simulatedError = new Error("ECONNRESET: Connection dropped by peer");
                simulatedError.code = "ECONNRESET";
                mock.emit("error", simulatedError);
            });

            const hasErrorLog = testErrLogs.some((l) => l.includes("[Redis] Runtime error:"));
            assert.ok(hasErrorLog, "Must log sanitized runtime error");
        });

        it("closeRedisClient cleanly closes the client and resets client reference", async () => {
            let quitCalled = false;
            const mock = createMockRedisClient({ status: "ready" });
            mock.quit = async () => {
                quitCalled = true;
                mock.status = "end";
            };

            _setClientForTesting(mock);
            assert.equal(getRedisClient(), mock);

            await closeRedisClient({ timeoutMs: 1000 });
            assert.equal(quitCalled, true);
            assert.equal(getRedisClient(), null);
        });

        it("closeRedisClient is a safe no-op when client was never initialized", async () => {
            _resetClientForTesting();
            await assert.doesNotReject(async () => {
                await closeRedisClient();
            });
            assert.equal(getRedisClient(), null);
        });

        it("closeRedisClient handles quit failure safely using fallback disconnect", async () => {
            let disconnectCalled = false;
            const mock = createMockRedisClient({ status: "ready", failQuit: true });
            mock.disconnect = () => {
                disconnectCalled = true;
            };

            _setClientForTesting(mock);
            await closeRedisClient({ timeoutMs: 500 });

            assert.equal(disconnectCalled, true);
            assert.equal(getRedisClient(), null);
        });
    });

    // =========================================================================
    // 3. Startup Integration & Safe Failure Handling
    // =========================================================================
    describe("3. Startup Lifecycle Integration", () => {
        it("startup does not attempt Redis connection when REDIS_ENABLED is false", async () => {
            process.env.MONGO_URI = "mongodb://localhost:27017/test_db";
            process.env.REDIS_ENABLED = "false";

            const originalConnect = mongoose.connect;
            mongoose.connect = async () => ({ connection: { host: "localhost" } });

            const origListen = server.listen;
            try {
                server.listen = (port, cb) => {
                    cb();
                };

                const res = await start({ exitOnError: false });
                assert.equal(res.redisClient, null);
                assert.equal(getRedisClient(), null);
            } finally {
                server.listen = origListen;
                mongoose.connect = originalConnect;
            }
        });

        it("startup fails immediately if REDIS_ENABLED=true but REDIS_URL is missing", async () => {
            process.env.MONGO_URI = "mongodb://localhost:27017/test_db";
            process.env.REDIS_ENABLED = "true";
            delete process.env.REDIS_URL;

            let dbConnected = false;
            const originalConnect = mongoose.connect;
            mongoose.connect = async () => {
                dbConnected = true;
            };

            try {
                await assert.rejects(
                    async () => {
                        await start({ exitOnError: false });
                    },
                    /REDIS_URL is required when REDIS_ENABLED=true/
                );

                assert.equal(dbConnected, false, "Must not connect to database if Redis configuration is invalid");
            } finally {
                mongoose.connect = originalConnect;
            }
        });

        it("startup fails safely and cleans up resources when Redis connection fails", async () => {
            process.env.MONGO_URI = "mongodb://localhost:27017/test_db";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://invalid-unreachable-host:6379";

            let dbConnected = false;
            const originalConnect = mongoose.connect;
            mongoose.connect = async () => {
                dbConnected = true;
            };

            // Inject a mock that fails connection
            const mock = createMockRedisClient({ failConnect: true });
            const originalInit = initRedisClient;

            try {
                await assert.rejects(
                    async () => {
                        await initRedisClient({
                            env: process.env,
                            clientFactory: () => mock,
                        });
                    },
                    /Failed to initialize Redis client/
                );

                assert.equal(getRedisClient(), null, "Client must be reset to null on failure");
            } finally {
                mongoose.connect = originalConnect;
            }
        });
    });

    // =========================================================================
    // 4. Health & Readiness Probes Integration
    // =========================================================================
    describe("4. Health, Liveness & Readiness Probes", () => {
        it("Liveness probe (GET /health) returns 200 OK independently of Redis state", async () => {
            _setClientForTesting(null);
            process.env.REDIS_ENABLED = "true";

            const res = await request(app).get("/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "ok");
            assert.equal(res.body.service, "Engaze.com Backend API");
        });

        it("Readiness probe does not include redis field when REDIS_ENABLED is false", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            process.env.REDIS_ENABLED = "false";
            _resetClientForTesting();

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.ready, true);
            assert.equal(res.body.database, "connected");
            assert.equal(res.body.redis, undefined);
        });

        it("Readiness probe returns 200 OK and redis: 'connected' when Redis is ready", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            process.env.REDIS_ENABLED = "true";
            const mock = createMockRedisClient({ status: "ready" });
            _setClientForTesting(mock);

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.ready, true);
            assert.equal(res.body.database, "connected");
            assert.equal(res.body.redis, "connected");
        });

        it("Readiness probe fails with 503 and redis: 'disconnected' when Redis is disconnected", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            process.env.REDIS_ENABLED = "true";
            const mock = createMockRedisClient({ status: "connecting" });
            _setClientForTesting(mock);

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 503);
            assert.equal(res.body.ready, false);
            assert.equal(res.body.database, "connected");
            assert.equal(res.body.redis, "disconnected");
        });

        it("Readiness response never exposes hostnames, ports, credentials, or URLs", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://user:secretpass@secret-redis-host.com:6379";
            const mock = createMockRedisClient({ status: "ready" });
            _setClientForTesting(mock);

            const res = await request(app).get("/api/v1/health");
            const responseText = JSON.stringify(res.body);

            assert.ok(!responseText.includes("secretpass"));
            assert.ok(!responseText.includes("secret-redis-host"));
            assert.ok(!responseText.includes("6379"));
            assert.ok(!responseText.includes("redis://"));
        });
    });

    // =========================================================================
    // 5. Graceful Shutdown Integration
    // =========================================================================
    describe("5. Graceful Shutdown & Resource Cleanup", () => {
        it("gracefulShutdown cleanly closes the Redis client when one is initialized", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            let redisQuitCalled = false;
            const mock = createMockRedisClient({ status: "ready" });
            mock.quit = async () => {
                redisQuitCalled = true;
                mock.status = "end";
            };

            process.env.REDIS_ENABLED = "true";
            _setClientForTesting(mock);

            const originalMongooseDisconnect = mongoose.disconnect;
            let mongooseDisconnected = false;
            mongoose.disconnect = async () => {
                mongooseDisconnected = true;
            };

            try {
                await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 1000 });
                assert.equal(redisQuitCalled, true, "Redis client must be closed during shutdown");
                assert.equal(mongooseDisconnected, true, "Mongoose must still be disconnected cleanly");
                assert.equal(getRedisClient(), null);
            } finally {
                mongoose.disconnect = originalMongooseDisconnect;
            }
        });

        it("gracefulShutdown succeeds when Redis was never initialized", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            _resetClientForTesting();
            process.env.REDIS_ENABLED = "false";

            const originalMongooseDisconnect = mongoose.disconnect;
            let mongooseDisconnected = false;
            mongoose.disconnect = async () => {
                mongooseDisconnected = true;
            };

            try {
                await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 1000 });
                assert.equal(mongooseDisconnected, true);
                assert.equal(getRedisClient(), null);
            } finally {
                mongoose.disconnect = originalMongooseDisconnect;
            }
        });

        it("gracefulShutdown continues with Mongoose cleanup if Redis close encounters an error", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
            const mock = createMockRedisClient({ status: "ready", failQuit: true });
            process.env.REDIS_ENABLED = "true";
            _setClientForTesting(mock);

            const originalMongooseDisconnect = mongoose.disconnect;
            let mongooseDisconnected = false;
            mongoose.disconnect = async () => {
                mongooseDisconnected = true;
            };

            try {
                await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 1000 });
                assert.equal(mongooseDisconnected, true, "Mongoose must be disconnected despite Redis close error");
                assert.equal(getRedisClient(), null);
            } finally {
                mongoose.disconnect = originalMongooseDisconnect;
            }
        });
    });
});
