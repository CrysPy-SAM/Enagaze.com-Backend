import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import mongoose from "mongoose";
import EventEmitter from "node:events";

import {
    isSocketRedisAdapterEnabled,
    validateSocketRedisAdapterConfig,
} from "../src/config/redis.js";
import {
    initSocketRedisAdapter,
    getSocketRedisAdapterClients,
    getSocketRedisAdapterStatus,
    closeSocketRedisAdapter,
    _setClientsForTesting,
    _resetAdapterForTesting,
} from "../src/services/socketRedisAdapter.service.js";
import {
    _resetClientForTesting,
} from "../src/services/redis.service.js";
import {
    app,
    server,
    io,
    start,
    gracefulShutdown,
    _resetShutdownForTesting,
} from "../src/app.js";

/**
 * Creates a controllable mock Redis client for pub/sub testing.
 */
function createMockRedisClient({ status = "ready", failConnect = false, failQuit = false } = {}) {
    const emitter = new EventEmitter();
    emitter.status = status;

    emitter.connect = async () => {
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

describe("Phase 3B: Socket.IO Redis Adapter Suite", () => {
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
        delete process.env.SOCKET_IO_REDIS_ADAPTER_ENABLED;
        delete process.env.SOCKET_IO_REDIS_ADAPTER_KEY;
        originalReadyState = mongoose.connection.readyState;
        _resetShutdownForTesting();
        _resetClientForTesting();
        _resetAdapterForTesting();
    });

    afterEach(async () => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.env = { ...originalEnv };
        delete server.listening;
        _resetShutdownForTesting();
        _resetClientForTesting();
        _resetAdapterForTesting();
        Object.defineProperty(mongoose.connection, "readyState", {
            value: originalReadyState,
            configurable: true,
            writable: true,
        });
    });

    describe("1. Configuration Validation", () => {
        it("isSocketRedisAdapterEnabled defaults to false when unset", () => {
            assert.equal(isSocketRedisAdapterEnabled({}), false);
            assert.equal(isSocketRedisAdapterEnabled(process.env), false);
        });

        it("isSocketRedisAdapterEnabled returns false for false/empty/0 values", () => {
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "false" }), false);
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "0" }), false);
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "" }), false);
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "no" }), false);
        });

        it("isSocketRedisAdapterEnabled returns true for 'true' and '1'", () => {
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "true" }), true);
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "TRUE" }), true);
            assert.equal(isSocketRedisAdapterEnabled({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "1" }), true);
        });

        it("validateSocketRedisAdapterConfig returns disabled when flag is not set", () => {
            const config = validateSocketRedisAdapterConfig({});
            assert.equal(config.enabled, false);
            assert.equal(config.key, "engaze:socket.io");
        });

        it("throws sanitized error when adapter is enabled but REDIS_ENABLED is false or missing", () => {
            assert.throws(
                () => validateSocketRedisAdapterConfig({
                    SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                    REDIS_ENABLED: "false",
                    REDIS_URL: "redis://localhost:6379",
                }),
                /Invalid Socket\.IO Redis adapter configuration: REDIS_ENABLED=true is required/
            );

            assert.throws(
                () => validateSocketRedisAdapterConfig({
                    SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                }),
                /Invalid Socket\.IO Redis adapter configuration: REDIS_ENABLED=true is required/
            );
        });

        it("throws sanitized error when adapter is enabled with REDIS_ENABLED=true but REDIS_URL is missing", () => {
            assert.throws(
                () => validateSocketRedisAdapterConfig({
                    SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                    REDIS_ENABLED: "true",
                }),
                /REDIS_URL is required/
            );
        });

        it("uses default channel key 'engaze:socket.io' when SOCKET_IO_REDIS_ADAPTER_KEY is unset", () => {
            const config = validateSocketRedisAdapterConfig({
                SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://localhost:6379",
            });
            assert.equal(config.enabled, true);
            assert.equal(config.key, "engaze:socket.io");
            assert.equal(config.redisConfig.host, "localhost");
        });

        it("uses custom channel key when SOCKET_IO_REDIS_ADAPTER_KEY is set", () => {
            const config = validateSocketRedisAdapterConfig({
                SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://localhost:6379",
                SOCKET_IO_REDIS_ADAPTER_KEY: "custom:socket.io",
            });
            assert.equal(config.enabled, true);
            assert.equal(config.key, "custom:socket.io");
        });
    });

    describe("2. Dedicated Pub/Sub Client Lifecycle", () => {
        it("initSocketRedisAdapter returns null when adapter is disabled", async () => {
            const result = await initSocketRedisAdapter(io, {
                env: { SOCKET_IO_REDIS_ADAPTER_ENABLED: "false" },
            });
            assert.equal(result, null);
            assert.equal(getSocketRedisAdapterClients().pubClient, null);
            assert.equal(getSocketRedisAdapterClients().subClient, null);
        });

        it("creates two separate dedicated clients (pubClient !== subClient) and attaches adapter to io", async () => {
            let pubCreated = null;
            let subCreated = null;

            const mockIo = {
                attachedAdapter: null,
                adapter(ad) {
                    this.attachedAdapter = ad;
                },
            };

            const clientFactory = (role) => {
                const client = createMockRedisClient({ status: "ready" });
                if (role === "pub") pubCreated = client;
                if (role === "sub") subCreated = client;
                return client;
            };

            const result = await initSocketRedisAdapter(mockIo, {
                env: {
                    SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                    REDIS_ENABLED: "true",
                    REDIS_URL: "redis://localhost:6379",
                },
                clientFactory,
            });

            assert.ok(result);
            assert.ok(result.pubClient);
            assert.ok(result.subClient);
            assert.notEqual(result.pubClient, result.subClient);
            assert.equal(result.pubClient, pubCreated);
            assert.equal(result.subClient, subCreated);
            assert.ok(mockIo.attachedAdapter);
        });

        it("initSocketRedisAdapter is idempotent when called repeatedly", async () => {
            let clientCount = 0;
            const clientFactory = () => {
                clientCount++;
                return createMockRedisClient({ status: "ready" });
            };

            const mockIo = { adapter() {} };
            const env = {
                SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://localhost:6379",
            };

            const first = await initSocketRedisAdapter(mockIo, { env, clientFactory });
            const second = await initSocketRedisAdapter(mockIo, { env, clientFactory });

            assert.equal(first.pubClient, second.pubClient);
            assert.equal(first.subClient, second.subClient);
            assert.equal(clientCount, 2); // 1 pub + 1 sub, not re-created
        });

        it("cleans up both clients and resets state if connection fails", async () => {
            const clientFactory = (role) => {
                return createMockRedisClient({
                    status: "ready",
                    failConnect: role === "sub", // fail subscriber
                });
            };

            const mockIo = { adapter() {} };
            const env = {
                SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://localhost:6379",
            };

            await assert.rejects(
                async () => initSocketRedisAdapter(mockIo, { env, clientFactory }),
                /Failed to initialize Socket\.IO Redis adapter/
            );

            assert.equal(getSocketRedisAdapterClients().pubClient, null);
            assert.equal(getSocketRedisAdapterClients().subClient, null);
        });

        it("closeSocketRedisAdapter closes both clients cleanly", async () => {
            const pub = createMockRedisClient({ status: "ready" });
            const sub = createMockRedisClient({ status: "ready" });
            _setClientsForTesting({ pubClient: pub, subClient: sub });

            await closeSocketRedisAdapter({ timeoutMs: 1000 });

            assert.equal(pub.status, "end");
            assert.equal(sub.status, "end");
            assert.equal(getSocketRedisAdapterClients().pubClient, null);
            assert.equal(getSocketRedisAdapterClients().subClient, null);
        });

        it("closeSocketRedisAdapter is safe to call when not initialized", async () => {
            await assert.doesNotReject(async () => {
                await closeSocketRedisAdapter({ timeoutMs: 1000 });
            });
        });
    });

    describe("3. Status & Health/Readiness Probes", () => {
        it("getSocketRedisAdapterStatus reports disabled when adapter is disabled", () => {
            const status = getSocketRedisAdapterStatus({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "false" });
            assert.deepEqual(status, {
                enabled: false,
                ready: false,
                status: "disabled",
                pubStatus: "disabled",
                subStatus: "disabled",
            });
        });

        it("getSocketRedisAdapterStatus reports disconnected when enabled but uninitialized", () => {
            const status = getSocketRedisAdapterStatus({ SOCKET_IO_REDIS_ADAPTER_ENABLED: "true" });
            assert.equal(status.enabled, true);
            assert.equal(status.ready, false);
            assert.equal(status.pubStatus, "disconnected");
            assert.equal(status.subStatus, "disconnected");
        });

        it("getSocketRedisAdapterStatus reports ready only when BOTH pub and sub clients are ready", () => {
            const env = { SOCKET_IO_REDIS_ADAPTER_ENABLED: "true" };

            // Pub ready, Sub connecting -> NOT ready
            _setClientsForTesting({
                pubClient: { status: "ready" },
                subClient: { status: "connecting" },
            });
            assert.equal(getSocketRedisAdapterStatus(env).ready, false);
            assert.equal(getSocketRedisAdapterStatus(env).pubStatus, "ready");
            assert.equal(getSocketRedisAdapterStatus(env).subStatus, "connecting");

            // Pub disconnected, Sub ready -> NOT ready
            _setClientsForTesting({
                pubClient: { status: "disconnected" },
                subClient: { status: "ready" },
            });
            assert.equal(getSocketRedisAdapterStatus(env).ready, false);

            // Both ready -> ready
            _setClientsForTesting({
                pubClient: { status: "ready" },
                subClient: { status: "ready" },
            });
            const readyStatus = getSocketRedisAdapterStatus(env);
            assert.equal(readyStatus.ready, true);
            assert.equal(readyStatus.status, "ready");
        });

        it("readiness probe does not include socketAdapter field when adapter is disabled", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.socketAdapter, undefined);
        });

        it("readiness probe returns 200 OK and socketAdapter: 'connected' when adapter is ready", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });
            process.env.SOCKET_IO_REDIS_ADAPTER_ENABLED = "true";

            _setClientsForTesting({
                pubClient: { status: "ready" },
                subClient: { status: "ready" },
            });

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.socketAdapter, "connected");
            assert.equal(res.body.ready, true);
        });

        it("readiness probe returns 503 and socketAdapter: 'disconnected' when pub or sub is disconnected", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });
            process.env.SOCKET_IO_REDIS_ADAPTER_ENABLED = "true";

            _setClientsForTesting({
                pubClient: { status: "ready" },
                subClient: { status: "disconnected" },
            });

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 503);
            assert.equal(res.body.socketAdapter, "disconnected");
            assert.equal(res.body.ready, false);
        });

        it("liveness probe (/health) returns 200 independently of adapter state", async () => {
            process.env.SOCKET_IO_REDIS_ADAPTER_ENABLED = "true";
            _setClientsForTesting({
                pubClient: { status: "disconnected" },
                subClient: { status: "disconnected" },
            });

            const res = await request(app).get("/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "ok");
        });
    });

    describe("4. Graceful Shutdown Integration", () => {
        it("gracefulShutdown cleanly closes the adapter clients when initialized", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });

            process.env.SOCKET_IO_REDIS_ADAPTER_ENABLED = "true";
            const pub = createMockRedisClient({ status: "ready" });
            const sub = createMockRedisClient({ status: "ready" });
            _setClientsForTesting({ pubClient: pub, subClient: sub });

            await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 500 });

            assert.equal(pub.status, "end");
            assert.equal(sub.status, "end");
            assert.equal(getSocketRedisAdapterClients().pubClient, null);
            assert.equal(getSocketRedisAdapterClients().subClient, null);
        });

        it("gracefulShutdown succeeds when adapter was never initialized", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });

            await assert.doesNotReject(async () => {
                await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 500 });
            });
        });
    });
});

