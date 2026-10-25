import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import mongoose from "mongoose";
import EventEmitter from "node:events";

import {
    isPresenceRedisEnabled,
    validatePresenceRedisConfig,
} from "../src/config/redis.js";
import {
    userConnected,
    userDisconnected,
    isUserOnline,
    getPresenceForViewer,
    canViewerSeeLastSeen,
    canViewerSeeOnline,
    initPresenceService,
    getPresenceStatus,
    closePresenceService,
    _resetPresenceState,
    _setPresenceRedisClientForTesting,
    _getLocalProcessSocketsForTesting,
} from "../src/services/presence.service.js";
import {
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
 * Creates an in-memory mock Redis client that accurately emulates
 * Redis sorted set operations, Lua script execution, pipelining, and locks.
 */
function createMockRedisClient({ status = "ready", failEval = false } = {}) {
    const emitter = new EventEmitter();
    emitter.status = status;

    // Key -> Map<member, score (expiresAtMs)>
    const zsets = new Map();
    // Key -> string/number (locks and strings)
    const strings = new Map();

    const getZSet = (key) => {
        if (!zsets.has(key)) zsets.set(key, new Map());
        return zsets.get(key);
    };

    emitter.eval = async (script, numKeys, key, ...args) => {
        if (emitter.status !== "ready" || failEval) {
            throw new Error("RedisConnectionClosed: Connection lost");
        }

        const zset = getZSet(key);

        // Check which script is being evaluated
        if (script.includes("prevCount")) {
            const socketId = String(args[0]);
            const nowMs = Number(args[1]);
            const expiresAtMs = Number(args[2]);

            // Purge expired
            for (const [member, score] of zset.entries()) {
                if (score <= nowMs) zset.delete(member);
            }

            const prevCount = zset.size;
            zset.set(socketId, expiresAtMs);
            return prevCount === 0 ? 1 : 0;
        }

        if (script.includes("local remaining")) {
            const socketId = String(args[0]);
            const nowMs = Number(args[1]);

            zset.delete(socketId);

            // Purge expired
            for (const [member, score] of zset.entries()) {
                if (score <= nowMs) zset.delete(member);
            }

            return zset.size;
        }

        if (script.includes("local count")) {
            const nowMs = Number(args[0]);

            // Purge expired
            for (const [member, score] of zset.entries()) {
                if (score <= nowMs) zset.delete(member);
            }

            return zset.size > 0 ? 1 : 0;
        }

        throw new Error("Unknown Lua script in test mock");
    };

    emitter.set = async (key, val, nx, ex, ttl) => {
        if (emitter.status !== "ready") throw new Error("Connection lost");
        if (nx === "NX" && strings.has(key)) {
            return null; // lock already held
        }
        strings.set(key, val);
        return "OK";
    };

    emitter.pipeline = () => {
        const ops = [];
        return {
            zadd(key, score, member) {
                ops.push(() => {
                    const z = getZSet(key);
                    z.set(member, score);
                });
                return this;
            },
            zrem(key, member) {
                ops.push(() => {
                    const z = getZSet(key);
                    z.delete(member);
                });
                return this;
            },
            expire() { return this; },
            pexpire() { return this; },
            async exec() {
                if (emitter.status !== "ready") throw new Error("Connection lost");
                for (const op of ops) op();
                return ops.map(() => [null, 1]);
            },
        };
    };

    emitter.quit = async () => {
        emitter.status = "end";
        emitter.emit("close");
    };

    emitter.disconnect = () => {
        emitter.status = "end";
        emitter.emit("close");
    };

    emitter._inspectZSet = (key) => getZSet(key);
    emitter._inspectStrings = () => strings;

    return emitter;
}

describe("Phase 3C.1: Distributed Redis/Valkey Presence Suite", () => {
    const originalEnv = { ...process.env };
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    let originalReadyState;
    let testLogs = [];
    let testErrLogs = [];

    beforeEach(() => {
        testLogs = [];
        testErrLogs = [];
        console.log = (...args) => testLogs.push(args.join(" "));
        console.error = (...args) => testErrLogs.push(args.join(" "));
        console.warn = (...args) => testErrLogs.push(args.join(" "));
        process.env = { ...originalEnv };
        delete process.env.REDIS_ENABLED;
        delete process.env.REDIS_URL;
        delete process.env.PRESENCE_REDIS_ENABLED;
        delete process.env.PRESENCE_LEASE_TTL_MS;
        delete process.env.PRESENCE_RENEWAL_INTERVAL_MS;
        originalReadyState = mongoose.connection.readyState;
        _resetShutdownForTesting();
        _resetClientForTesting();
        _resetPresenceState();
    });

    afterEach(async () => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        process.env = { ...originalEnv };
        delete server.listening;
        _resetShutdownForTesting();
        _resetClientForTesting();
        _resetPresenceState();
        Object.defineProperty(mongoose.connection, "readyState", {
            value: originalReadyState,
            configurable: true,
            writable: true,
        });
    });

    describe("1. Configuration & Feature Flag Validation", () => {
        it("isPresenceRedisEnabled defaults to false when unset", () => {
            assert.equal(isPresenceRedisEnabled({}), false);
            assert.equal(isPresenceRedisEnabled(process.env), false);
        });

        it("isPresenceRedisEnabled returns false for 'false', '0', empty", () => {
            assert.equal(isPresenceRedisEnabled({ PRESENCE_REDIS_ENABLED: "false" }), false);
            assert.equal(isPresenceRedisEnabled({ PRESENCE_REDIS_ENABLED: "0" }), false);
            assert.equal(isPresenceRedisEnabled({ PRESENCE_REDIS_ENABLED: "" }), false);
        });

        it("isPresenceRedisEnabled returns true for 'true' and '1'", () => {
            assert.equal(isPresenceRedisEnabled({ PRESENCE_REDIS_ENABLED: "true" }), true);
            assert.equal(isPresenceRedisEnabled({ PRESENCE_REDIS_ENABLED: "1" }), true);
        });

        it("validatePresenceRedisConfig returns disabled when flag is false", () => {
            const config = validatePresenceRedisConfig({});
            assert.equal(config.enabled, false);
        });

        it("throws sanitized error when presence enabled but REDIS_ENABLED is false", () => {
            assert.throws(
                () => validatePresenceRedisConfig({
                    PRESENCE_REDIS_ENABLED: "true",
                    REDIS_ENABLED: "false",
                    REDIS_URL: "redis://localhost:6379",
                }),
                /REDIS_ENABLED=true is required when PRESENCE_REDIS_ENABLED=true/
            );
        });

        it("throws sanitized error when presence enabled with REDIS_ENABLED=true but REDIS_URL missing", () => {
            assert.throws(
                () => validatePresenceRedisConfig({
                    PRESENCE_REDIS_ENABLED: "true",
                    REDIS_ENABLED: "true",
                }),
                /REDIS_URL is required/
            );
        });

        it("parses valid configuration with custom TTL and renewal intervals", () => {
            const config = validatePresenceRedisConfig({
                PRESENCE_REDIS_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://localhost:6379",
                PRESENCE_LEASE_TTL_MS: "45000",
                PRESENCE_RENEWAL_INTERVAL_MS: "15000",
                PRESENCE_REDIS_KEY_PREFIX: "custom:presence",
            });
            assert.equal(config.enabled, true);
            assert.equal(config.leaseTtlMs, 45000);
            assert.equal(config.renewalIntervalMs, 15000);
            assert.equal(config.keyPrefix, "custom:presence");
        });
    });

    describe("2. Multi-Socket & Multi-Instance Presence Lifecycle", () => {
        const userId = "65cb1234567890abcdef1001";

        beforeEach(() => {
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";
        });

        it("detects first socket connection as wasOffline=true", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            assert.equal(await isUserOnline(userId), false);

            const wasOffline = await userConnected(userId, "socket-1");
            assert.equal(wasOffline, true);
            assert.equal(await isUserOnline(userId), true);
        });

        it("subsequent sockets on same or different instances report wasOffline=false", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            // Tab 1 on Instance A
            const first = await userConnected(userId, "tab-1-instance-a");
            assert.equal(first, true);

            // Tab 2 connected on simulated Instance B (shares same Redis mock)
            const second = await userConnected(userId, "tab-2-instance-b");
            assert.equal(second, false);

            assert.equal(await isUserOnline(userId), true);
        });

        it("disconnecting one socket keeps user online if other sockets remain", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected(userId, "tab-1");
            await userConnected(userId, "tab-2");

            // Disconnect tab 1: tab 2 remains active -> no grace period started
            const gracePending = await userDisconnected(userId, "tab-1");
            assert.equal(gracePending, false);
            assert.equal(await isUserOnline(userId), true);
        });

        it("only the final active socket disappearing schedules offline grace transition", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected(userId, "tab-1");
            await userConnected(userId, "tab-2");

            await userDisconnected(userId, "tab-1");

            // Disconnect final socket: grace timer should start
            const gracePending = await userDisconnected(userId, "tab-2");
            assert.equal(gracePending, true);

            // In Redis, 0 active sockets
            assert.equal(await isUserOnline(userId), false);
        });

        it("reconnection during grace period aborts offline transition", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected(userId, "socket-old");

            let expiredCalled = false;
            await userDisconnected(userId, "socket-old", async () => {
                expiredCalled = true;
            });

            // Reconnect before grace timer expires
            const wasOffline = await userConnected(userId, "socket-new");
            assert.equal(wasOffline, true);
            assert.equal(await isUserOnline(userId), true);

            // Wait 150ms (test grace period is 100ms)
            await new Promise((r) => setTimeout(r, 150));

            assert.equal(expiredCalled, false);
            assert.equal(await isUserOnline(userId), true);
        });

        it("grace expiration triggers callback and writes offline lock when no reconnection occurs", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected(userId, "socket-leave");

            let callbackInvoked = false;
            await userDisconnected(userId, "socket-leave", async () => {
                callbackInvoked = true;
            });

            // Wait 150ms for grace to expire
            await new Promise((r) => setTimeout(r, 150));

            assert.equal(callbackInvoked, true);
            assert.equal(await isUserOnline(userId), false);
            // Offline lock was set
            const lockKey = `engaze:presence:user:{${userId}}:offline_lock`;
            assert.ok(mockRedis._inspectStrings().has(lockKey));
        });

        it("stale leases expire automatically without explicit disconnect", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            const zset = mockRedis._inspectZSet(`engaze:presence:user:{${userId}}:sockets`);
            // Simulate an abandoned socket whose lease expired in the past
            zset.set("abandoned-socket-crashed-node", Date.now() - 5000);

            // isUserOnline purges expired leases and reports false
            assert.equal(await isUserOnline(userId), false);
            assert.equal(zset.size, 0);
        });
    });

    describe("3. Privacy & Viewer Integration", () => {
        const alice = {
            _id: "65cb1234567890abcdef0001",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
            lastSeenAt: new Date("2026-10-25T12:00:00Z"),
        };
        const bob = {
            _id: "65cb1234567890abcdef0002",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };

        beforeEach(() => {
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";
        });

        it("returns offline presence when user has no active sockets in Redis", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            const presence = await getPresenceForViewer(alice, bob, true);
            assert.equal(presence.isOnline, false);
            assert.equal(presence.lastSeenAt.toISOString(), alice.lastSeenAt.toISOString());
        });

        it("returns online presence when user has active socket in Redis", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected(alice._id, "socket-online");

            const presence = await getPresenceForViewer(alice, bob, true);
            assert.equal(presence.isOnline, true);
            assert.equal(presence.lastSeenAt.toISOString(), alice.lastSeenAt.toISOString());
        });

        it("enforces WhatsApp reciprocity even when Redis presence is online", async () => {
            const mockRedis = createMockRedisClient();
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected(alice._id, "socket-online");

            const secretiveViewer = {
                _id: "65cb1234567890abcdef0003",
                privacySettings: { lastSeen: "nobody", online: "everyone" },
            };

            const presence = await getPresenceForViewer(alice, secretiveViewer, true);
            // Secretive viewer cannot see lastSeenAt due to reciprocity
            assert.equal(presence.lastSeenAt, null);
            assert.equal(presence.isOnline, true);
        });
    });

    describe("4. Error Resilience, Readiness & Lifecycle", () => {
        it("fails safe closed (isOnline=false) if Redis disconnects during runtime", async () => {
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";

            const mockRedis = createMockRedisClient({ status: "disconnected" });
            _setPresenceRedisClientForTesting(mockRedis);

            const online = await isUserOnline("65cb1234567890abcdef1001");
            assert.equal(online, false);
        });

        it("readiness probe excludes presence field when PRESENCE_REDIS_ENABLED is false", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.presence, undefined);
        });

        it("readiness probe includes presence: 'connected' when ready", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";

            const mockRedis = createMockRedisClient({ status: "ready" });
            _setClientForTesting(mockRedis);
            _setPresenceRedisClientForTesting(mockRedis);

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.presence, "connected");
            assert.equal(res.body.ready, true);
        });

        it("readiness probe fails with 503 and presence: 'disconnected' when Redis drops", async () => {
            Object.defineProperty(mongoose.connection, "readyState", {
                value: 1,
                configurable: true,
                writable: true,
            });
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";

            const mockRedis = createMockRedisClient({ status: "end" });
            _setClientForTesting(mockRedis);
            _setPresenceRedisClientForTesting(mockRedis);

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 503);
            assert.equal(res.body.presence, "disconnected");
            assert.equal(res.body.ready, false);
        });

        it("liveness probe (/health) returns 200 independently of presence Redis state", async () => {
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";

            const mockRedis = createMockRedisClient({ status: "end" });
            _setClientForTesting(mockRedis);
            _setPresenceRedisClientForTesting(mockRedis);

            const res = await request(app).get("/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "ok");
        });

        it("gracefulShutdown cleanly removes local sockets from Redis and clears timers", async () => {
            process.env.PRESENCE_REDIS_ENABLED = "true";
            process.env.REDIS_ENABLED = "true";
            process.env.REDIS_URL = "redis://localhost:6379";

            const mockRedis = createMockRedisClient({ status: "ready" });
            _setPresenceRedisClientForTesting(mockRedis);

            await userConnected("65cb1234567890abcdef1001", "sock-shutdown-1");
            assert.equal(_getLocalProcessSocketsForTesting().size, 1);

            await closePresenceService({ timeoutMs: 500 });
            assert.equal(_getLocalProcessSocketsForTesting().size, 0);
        });
    });
});
