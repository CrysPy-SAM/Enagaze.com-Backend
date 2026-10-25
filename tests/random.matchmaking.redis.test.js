import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import EventEmitter from "node:events";

import {
    isMatchmakingRedisEnabled,
    validateMatchmakingRedisConfig,
} from "../src/config/redis.js";
import {
    initMatchmakingRedisService,
    closeMatchmakingRedisService,
    getMatchmakingRedisStatus,
    enqueueUserRedis,
    dequeueUserRedis,
    isUserInQueueRedis,
    findAndReserveMatchRedis,
    getCallSessionRedis,
    getCallIdForSocketRedis,
    getCallIdForUserRedis,
    setUserConsentRedis,
    setMediaReadyRedis,
    endCallSessionRedis,
    endActiveCallBetweenUsersRedis,
    _testingRedis,
} from "../src/services/randomMatchmakingRedis.service.js";
import {
    _setPresenceRedisClientForTesting,
    _resetPresenceState,
} from "../src/services/presence.service.js";
import {
    _setClientForTesting,
    _resetClientForTesting,
} from "../src/services/redis.service.js";
import {
    _setClientsForTesting,
} from "../src/services/socketRedisAdapter.service.js";
import mongoose from "mongoose";
import {
    app,
    server,
    gracefulShutdown,
    _resetShutdownForTesting,
} from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Block } from "../src/models/block.model.js";

/**
 * Creates an in-memory mock Redis client emulating Sorted Sets, Key-Value storage,
 * and Lua scripts for atomic distributed matchmaking.
 */
function createMockRedisClient({ status = "ready", failEval = false } = {}) {
    const emitter = new EventEmitter();
    emitter.status = status;

    // Key -> string value
    const strings = new Map();
    // Key -> Map<member, score>
    const zsets = new Map();

    const getZSet = (key) => {
        if (!zsets.has(key)) zsets.set(key, new Map());
        return zsets.get(key);
    };

    emitter.get = async (key) => strings.get(key) || null;
    emitter.set = async (key, val) => {
        strings.set(key, String(val));
        return "OK";
    };
    emitter.del = async (...keys) => {
        let count = 0;
        for (const k of keys) {
            if (strings.delete(k)) count++;
            if (zsets.delete(k)) count++;
        }
        return count;
    };
    emitter.zscore = async (key, member) => {
        const zset = getZSet(key);
        return zset.has(member) ? zset.get(member) : null;
    };
    emitter.zrange = async (key, start, stop) => {
        const zset = getZSet(key);
        // Sort entries by score ascending (FIFO)
        const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
        const end = stop === -1 ? undefined : stop + 1;
        return sorted.slice(start, end);
    };
    emitter.zrem = async (key, member) => {
        const zset = getZSet(key);
        return zset.delete(member) ? 1 : 0;
    };

    emitter.eval = async (script, numKeys, ...args) => {
        if (emitter.status !== "ready" || failEval) {
            throw new Error("RedisConnectionClosed: Connection lost");
        }

        const keys = args.slice(0, numKeys);
        const scriptArgs = args.slice(numKeys);

        // 1. Enqueue User
        if (script.includes("ENQUEUE_USER_LUA") || script.includes("nowMs = tonumber(ARGV[3])")) {
            const [queueKey, userMetaKey, userCallKey, socketCallKey] = keys;
            const [userId, socketId, nowMs, userMetaJson, queueTtlSec] = scriptArgs;

            if (strings.has(userCallKey) || strings.has(socketCallKey)) {
                return -1;
            }

            const zset = getZSet(queueKey);
            zset.set(userId, Number(nowMs));
            strings.set(userMetaKey, userMetaJson);
            return 1;
        }

        // 2. Dequeue User
        if (script.includes("DEQUEUE_USER_LUA") || script.includes("cjson.decode(meta)")) {
            const [queueKey, userMetaKey] = keys;
            const [userId, socketId] = scriptArgs;

            if (socketId && strings.has(userMetaKey)) {
                try {
                    const parsed = JSON.parse(strings.get(userMetaKey));
                    if (parsed.socketId && parsed.socketId !== socketId) {
                        return 0;
                    }
                } catch (_) {}
            }

            const zset = getZSet(queueKey);
            zset.delete(userId);
            strings.delete(userMetaKey);
            return 1;
        }

        // 3. Reserve Match
        if (script.includes("RESERVE_MATCH_LUA") || script.includes("candUserMetaKey = KEYS[2]")) {
            const [queueKey, candUserMetaKey, callKey, candUserCallKey, candSocketCallKey, myUserCallKey, mySocketCallKey] = keys;
            const [candUserId, callId, callSessionJson, callTtlSec] = scriptArgs;

            const zset = getZSet(queueKey);
            if (!zset.has(candUserId)) {
                return 0;
            }

            if (strings.has(candUserCallKey) || strings.has(candSocketCallKey) || strings.has(myUserCallKey) || strings.has(mySocketCallKey)) {
                return 0;
            }

            zset.delete(candUserId);
            strings.delete(candUserMetaKey);

            strings.set(callKey, callSessionJson);
            strings.set(candUserCallKey, callId);
            strings.set(candSocketCallKey, callId);
            strings.set(myUserCallKey, callId);
            strings.set(mySocketCallKey, callId);

            return 1;
        }

        // 4. Set Consent
        if (script.includes("SET_CONSENT_LUA") || script.includes("consentVal == '0'")) {
            const [callKey] = keys;
            const [userId, consentVal] = scriptArgs;

            const raw = strings.get(callKey);
            if (!raw) return ["not_found", ""];

            const call = JSON.parse(raw);
            if (consentVal === "0") {
                call.state = "ended";
                strings.delete(callKey);
                return ["declined", "ended"];
            }

            if (call.state !== "consent_pending") {
                return ["already_advanced", call.state];
            }

            if (!call.consentedUsers.includes(userId)) {
                call.consentedUsers.push(userId);
            }

            if (call.consentedUsers.length >= call.peers.length && call.peers.length >= 2) {
                call.state = "media_setup";
                strings.set(callKey, JSON.stringify(call));
                return ["both_consented", "media_setup"];
            } else {
                strings.set(callKey, JSON.stringify(call));
                return ["waiting_for_partner", "consent_pending"];
            }
        }

        // 5. Set Media Ready
        if (script.includes("SET_MEDIA_READY_LUA") || script.includes("consent_required")) {
            const [callKey] = keys;
            const [userId] = scriptArgs;

            const raw = strings.get(callKey);
            if (!raw) return ["not_found", ""];

            const call = JSON.parse(raw);
            if (call.state === "consent_pending") {
                return ["consent_required", call.state];
            }
            if (call.state === "media_ready") {
                return ["already_ready", "media_ready"];
            }

            if (!call.mediaReadyUsers.includes(userId)) {
                call.mediaReadyUsers.push(userId);
            }

            if (call.mediaReadyUsers.length >= call.peers.length && call.peers.length >= 2) {
                call.state = "media_ready";
                strings.set(callKey, JSON.stringify(call));
                return ["media_ready", "media_ready"];
            } else {
                strings.set(callKey, JSON.stringify(call));
                return ["waiting_for_partner", "media_setup"];
            }
        }

        // 6. End Call
        if (script.includes("END_CALL_LUA") || script.includes("KEYS[i]")) {
            for (const k of keys) {
                strings.delete(k);
                zsets.delete(k);
            }
            return 1;
        }

        return 0;
    };

    return emitter;
}

describe("Phase 3C.2: Redis-Backed Distributed Random Matchmaking Suite", () => {
    let originalEnv;
    let mockRedis;
    let originalFindById;
    let originalIsBlocked;

    const mockUser1 = {
        _id: "65cb11111111111111111111",
        name: "Alice",
        gender: "female",
        dob: new Date("1995-05-15"),
        bio: "Alice bio",
        photos: ["https://example.com/alice.jpg"],
        interests: ["music"],
        isProfileComplete: true,
    };

    const mockUser2 = {
        _id: "65cb22222222222222222222",
        name: "Bob",
        gender: "male",
        dob: new Date("1993-08-20"),
        bio: "Bob bio",
        photos: ["https://example.com/bob.jpg"],
        interests: ["travel"],
        isProfileComplete: true,
    };

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.REDIS_ENABLED = "true";
        process.env.REDIS_URL = "redis://127.0.0.1:6379";
        process.env.PRESENCE_REDIS_ENABLED = "true";
        process.env.SOCKET_IO_REDIS_ADAPTER_ENABLED = "true";
        process.env.MATCHMAKING_REDIS_ENABLED = "true";

        mockRedis = createMockRedisClient();
        _testingRedis.setClient(mockRedis);
        _setPresenceRedisClientForTesting(mockRedis);
        _setClientForTesting(mockRedis);
        _setClientsForTesting({ pubClient: mockRedis, subClient: mockRedis });

        Object.defineProperty(mongoose.connection, "readyState", {
            value: 1,
            configurable: true,
            writable: true,
        });

        originalFindById = User.findById;
        User.findById = (id) => {
            const idStr = id ? id.toString() : "";
            let found = null;
            if (idStr === mockUser1._id) found = { ...mockUser1 };
            else if (idStr === mockUser2._id) found = { ...mockUser2 };

            return {
                select: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        originalIsBlocked = Block.isBlockedBidirectional;
        Block.isBlockedBidirectional = () => Promise.resolve(false);
    });

    afterEach(async () => {
        process.env = originalEnv;
        _testingRedis.resetClient();
        _resetPresenceState();
        _resetClientForTesting();
        _setClientsForTesting();
        User.findById = originalFindById;
        Block.isBlockedBidirectional = originalIsBlocked;
        _resetShutdownForTesting();
    });

    // =========================================================================
    // 1. Configuration & Flag Validation
    // =========================================================================
    describe("Configuration & Flag Validation", () => {
        it("Requirement 1: isMatchmakingRedisEnabled returns false by default or when unset", () => {
            assert.strictEqual(isMatchmakingRedisEnabled({}), false);
            assert.strictEqual(isMatchmakingRedisEnabled({ MATCHMAKING_REDIS_ENABLED: "false" }), false);
            assert.strictEqual(isMatchmakingRedisEnabled({ MATCHMAKING_REDIS_ENABLED: "" }), false);
        });

        it("Requirement 2: isMatchmakingRedisEnabled returns true when enabled", () => {
            assert.strictEqual(isMatchmakingRedisEnabled({ MATCHMAKING_REDIS_ENABLED: "true" }), true);
            assert.strictEqual(isMatchmakingRedisEnabled({ MATCHMAKING_REDIS_ENABLED: "1" }), true);
        });

        it("Requirement 3: validateMatchmakingRedisConfig returns defaults when disabled", () => {
            const config = validateMatchmakingRedisConfig({ MATCHMAKING_REDIS_ENABLED: "false" });
            assert.strictEqual(config.enabled, false);
            assert.strictEqual(config.queueKey, "engaze:matchmaking:queue");
            assert.strictEqual(config.queueTtlMs, 120000);
            assert.strictEqual(config.callTtlMs, 300000);
        });

        it("Requirement 4: Fails if MATCHMAKING_REDIS_ENABLED=true without REDIS_ENABLED=true", () => {
            assert.throws(
                () => validateMatchmakingRedisConfig({
                    MATCHMAKING_REDIS_ENABLED: "true",
                    REDIS_ENABLED: "false",
                }),
                /REDIS_ENABLED=true is required/
            );
        });

        it("Requirement 5: Fails if MATCHMAKING_REDIS_ENABLED=true without PRESENCE_REDIS_ENABLED=true", () => {
            assert.throws(
                () => validateMatchmakingRedisConfig({
                    MATCHMAKING_REDIS_ENABLED: "true",
                    REDIS_ENABLED: "true",
                    REDIS_URL: "redis://127.0.0.1:6379",
                    PRESENCE_REDIS_ENABLED: "false",
                }),
                /PRESENCE_REDIS_ENABLED=true is required/
            );
        });

        it("Requirement 6: Fails if MATCHMAKING_REDIS_ENABLED=true without SOCKET_IO_REDIS_ADAPTER_ENABLED=true", () => {
            assert.throws(
                () => validateMatchmakingRedisConfig({
                    MATCHMAKING_REDIS_ENABLED: "true",
                    REDIS_ENABLED: "true",
                    REDIS_URL: "redis://127.0.0.1:6379",
                    PRESENCE_REDIS_ENABLED: "true",
                    SOCKET_IO_REDIS_ADAPTER_ENABLED: "false",
                }),
                /SOCKET_IO_REDIS_ADAPTER_ENABLED=true is required/
            );
        });

        it("Requirement 7: Succeeds when all prerequisites are met and supports custom config", () => {
            const config = validateMatchmakingRedisConfig({
                MATCHMAKING_REDIS_ENABLED: "true",
                REDIS_ENABLED: "true",
                REDIS_URL: "redis://127.0.0.1:6379",
                PRESENCE_REDIS_ENABLED: "true",
                SOCKET_IO_REDIS_ADAPTER_ENABLED: "true",
                MATCHMAKING_REDIS_KEY_PREFIX: "custom:match",
                MATCHMAKING_QUEUE_TTL_MS: "60000",
                MATCHMAKING_CALL_TTL_MS: "180000",
            });
            assert.strictEqual(config.enabled, true);
            assert.strictEqual(config.keyPrefix, "custom:match");
            assert.strictEqual(config.queueKey, "custom:match:queue");
            assert.strictEqual(config.queueTtlMs, 60000);
            assert.strictEqual(config.callTtlMs, 180000);
        });
    });

    // =========================================================================
    // 2. Service Lifecycle & Readiness Probe
    // =========================================================================
    describe("Service Lifecycle & Readiness", () => {
        it("Requirement 8: initMatchmakingRedisService returns enabled: true when client ready", async () => {
            const status = await initMatchmakingRedisService({ redisClient: mockRedis });
            assert.strictEqual(status.enabled, true);
            assert.strictEqual(status.ready, true);

            const readStatus = getMatchmakingRedisStatus();
            assert.strictEqual(readStatus.ready, true);
            assert.strictEqual(readStatus.status, "ready");
        });

        it("Requirement 9: closeMatchmakingRedisService resets ready status cleanly", async () => {
            await initMatchmakingRedisService({ redisClient: mockRedis });
            assert.strictEqual(getMatchmakingRedisStatus().ready, true);

            await closeMatchmakingRedisService();
            assert.strictEqual(getMatchmakingRedisStatus().ready, false);
        });
    });

    // =========================================================================
    // 3. Queue Operations & Candidate Filtering
    // =========================================================================
    describe("Queue Operations & Candidate Filtering", () => {
        it("Requirement 10: Enqueues and dequeues user cleanly in Redis", async () => {
            const res = await enqueueUserRedis({
                userId: mockUser1._id,
                socketId: "sock_1",
                userProfile: { name: "Alice" },
            });
            assert.strictEqual(res.enqueued, true);

            const isQueued = await isUserInQueueRedis(mockUser1._id);
            assert.strictEqual(isQueued, true);

            const deqRes = await dequeueUserRedis({ userId: mockUser1._id, socketId: "sock_1" });
            assert.strictEqual(deqRes.removed, true);

            const isQueuedAfter = await isUserInQueueRedis(mockUser1._id);
            assert.strictEqual(isQueuedAfter, false);
        });

        it("Requirement 11: Candidate search skips self-entries cleanly", async () => {
            // Enqueue Alice
            await enqueueUserRedis({
                userId: mockUser1._id,
                socketId: "sock_alice_1",
                userProfile: { name: "Alice" },
            });

            // Alice tries to match herself
            const fakeSocket = { id: "sock_alice_2", emit: () => {} };
            const fakeIo = { sockets: { sockets: new Map() }, to: () => ({ emit: () => {} }) };

            const result = await findAndReserveMatchRedis({
                io: fakeIo,
                socket: fakeSocket,
                userId: mockUser1._id,
                userProfile: { name: "Alice" },
            });

            // Alice should not match with herself; should be enqueued
            assert.strictEqual(result.status, "waiting");
        });

        it("Requirement 12: Candidate search skips and retains blocked candidate", async () => {
            // Enqueue Alice
            await enqueueUserRedis({
                userId: mockUser1._id,
                socketId: "sock_alice",
                userProfile: { name: "Alice" },
            });

            // Mock Bob and Alice as mutually blocked
            Block.isBlockedBidirectional = () => Promise.resolve(true);

            const fakeSocket = { id: "sock_bob", emit: () => {} };
            const fakeIo = {
                sockets: {
                    sockets: new Map([["sock_alice", { connected: true, join: () => {} }]]),
                },
                to: () => ({ emit: () => {} }),
            };

            const result = await findAndReserveMatchRedis({
                io: fakeIo,
                socket: fakeSocket,
                userId: mockUser2._id,
                userProfile: { name: "Bob" },
            });

            // Blocked; Bob could not match Alice, joins queue
            assert.strictEqual(result.status, "waiting");

            // Alice MUST still be in the queue for non-blocked users!
            const aliceStillQueued = await isUserInQueueRedis(mockUser1._id);
            assert.strictEqual(aliceStillQueued, true);
        });
    });

    // =========================================================================
    // 4. Atomic Match Reservation & Race Guard
    // =========================================================================
    describe("Atomic Match Reservation & Race Guard", () => {
        it("Requirement 13: Atomically reserves match and creates 2-peer callSession", async () => {
            // Alice queues
            await enqueueUserRedis({
                userId: mockUser1._id,
                socketId: "sock_alice",
                userProfile: { name: "Alice" },
            });

            const emitted = [];
            const fakeSocket = {
                id: "sock_bob",
                join: () => {},
                emit: (event, data) => emitted.push({ event, data }),
            };
            const fakeIo = {
                sockets: {
                    sockets: new Map([["sock_alice", { connected: true, join: () => {} }]]),
                },
                to: (target) => ({
                    emit: (event, data) => emitted.push({ target, event, data }),
                }),
            };

            const result = await findAndReserveMatchRedis({
                io: fakeIo,
                socket: fakeSocket,
                userId: mockUser2._id,
                userProfile: { name: "Bob" },
            });

            assert.strictEqual(result.status, "matched");
            assert.ok(result.callId.startsWith("call_"));

            // Verify call session state in Redis
            const call = await getCallSessionRedis(result.callId);
            assert.ok(call);
            assert.strictEqual(call.state, "consent_pending");
            assert.strictEqual(call.peers.length, 2);

            // Verify index pointers
            const aliceCallId = await getCallIdForUserRedis(mockUser1._id);
            const bobCallId = await getCallIdForUserRedis(mockUser2._id);
            assert.strictEqual(aliceCallId, result.callId);
            assert.strictEqual(bobCallId, result.callId);
        });

        it("Requirement 14: Competing instance race condition prevention", async () => {
            // Simulate that Alice was in queue, but another concurrent worker removed her before Lua reserve
            const fakeSocket = { id: "sock_bob", emit: () => {} };
            const fakeIo = {
                sockets: {
                    sockets: new Map([["sock_alice", { connected: true, join: () => {} }]]),
                },
                to: () => ({ emit: () => {} }),
            };

            // Don't enqueue Alice; pretend candidateIds had Alice but she left
            const { queueKey } = _testingRedis.getKeys();
            await mockRedis.eval(
                `local q = KEYS[1]; redis.call('ZADD', q, 100, '${mockUser1._id}'); return 1;`,
                1,
                queueKey
            );
            // Delete metadata key so candidate fetch fails
            const result = await findAndReserveMatchRedis({
                io: fakeIo,
                socket: fakeSocket,
                userId: mockUser2._id,
                userProfile: { name: "Bob" },
            });

            // Discarded stale entry; queued Bob
            assert.strictEqual(result.status, "waiting");
        });
    });

    // =========================================================================
    // 5. Distributed Consent & Media Setup State Machine
    // =========================================================================
    describe("Distributed Consent & Media Setup State Machine", () => {
        let callId;
        const emitted = [];
        const fakeIo = {
            to: (target) => ({
                emit: (event, data) => emitted.push({ target, event, data }),
            }),
        };

        beforeEach(async () => {
            await enqueueUserRedis({
                userId: mockUser1._id,
                socketId: "sock_alice",
                userProfile: { name: "Alice" },
            });
            const fakeSocketBob = { id: "sock_bob", join: () => {}, emit: () => {} };
            const localIo = {
                sockets: {
                    sockets: new Map([["sock_alice", { connected: true, join: () => {} }]]),
                },
                to: () => ({ emit: () => {} }),
            };
            const match = await findAndReserveMatchRedis({
                io: localIo,
                socket: fakeSocketBob,
                userId: mockUser2._id,
                userProfile: { name: "Bob" },
            });
            callId = match.callId;
            emitted.length = 0;
        });

        it("Requirement 15: Single consent leaves call in consent_pending; both consent advances to media_setup", async () => {
            const socketAlice = { id: "sock_alice", emit: (ev, d) => emitted.push({ target: "alice", ev, d }) };
            const resAlice = await setUserConsentRedis({
                callId,
                userId: mockUser1._id,
                consent: true,
                io: fakeIo,
                socket: socketAlice,
            });
            assert.strictEqual(resAlice.status, "waiting_for_partner");

            const socketBob = { id: "sock_bob", emit: (ev, d) => emitted.push({ target: "bob", ev, d }) };
            const resBob = await setUserConsentRedis({
                callId,
                userId: mockUser2._id,
                consent: true,
                io: fakeIo,
                socket: socketBob,
            });
            assert.strictEqual(resBob.status, "both_consented");

            // Verify both-consented broadcast
            const bothConsentedEmits = emitted.filter((e) => e.data && e.data.callId === callId);
            assert.ok(bothConsentedEmits.length >= 2);

            const call = await getCallSessionRedis(callId);
            assert.strictEqual(call.state, "media_setup");
        });

        it("Requirement 16: Premature media-ready is rejected before mutual consent", async () => {
            const socketAlice = { id: "sock_alice", emit: (ev, d) => emitted.push({ target: "alice", ev, d }) };
            const res = await setMediaReadyRedis({
                callId,
                userId: mockUser1._id,
                io: fakeIo,
                socket: socketAlice,
            });
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.message, "Mutual consent required before media setup");
        });

        it("Requirement 17: Both media-ready transitions state to media_ready and emits media-start", async () => {
            // First both consent
            await setUserConsentRedis({ callId, userId: mockUser1._id, consent: true, io: fakeIo, socket: { id: "sock_alice", emit: () => {} } });
            await setUserConsentRedis({ callId, userId: mockUser2._id, consent: true, io: fakeIo, socket: { id: "sock_bob", emit: () => {} } });

            emitted.length = 0;
            const res1 = await setMediaReadyRedis({
                callId,
                userId: mockUser1._id,
                io: fakeIo,
                socket: { id: "sock_alice", emit: () => {} },
            });
            assert.strictEqual(res1.status, "waiting_for_partner");

            const res2 = await setMediaReadyRedis({
                callId,
                userId: mockUser2._id,
                io: fakeIo,
                socket: { id: "sock_bob", emit: () => {} },
            });
            assert.strictEqual(res2.status, "media_ready");

            const call = await getCallSessionRedis(callId);
            assert.strictEqual(call.state, "media_ready");
        });

        it("Requirement 18: Cleanly ends call session and clears index pointers", async () => {
            await endCallSessionRedis({
                callId,
                initiatorSocketId: "sock_alice",
                reason: "ended_by_user",
                io: fakeIo,
            });

            const callAfter = await getCallSessionRedis(callId);
            assert.strictEqual(callAfter, null);

            const aliceCall = await getCallIdForUserRedis(mockUser1._id);
            const bobCall = await getCallIdForUserRedis(mockUser2._id);
            assert.strictEqual(aliceCall, null);
            assert.strictEqual(bobCall, null);
        });

        it("Requirement 19: endActiveCallBetweenUsersRedis terminates active session between blocked users", async () => {
            const ended = await endActiveCallBetweenUsersRedis(mockUser1._id, mockUser2._id, fakeIo);
            assert.ok(ended);
            assert.strictEqual(ended.callId, callId);

            const callAfter = await getCallSessionRedis(callId);
            assert.strictEqual(callAfter, null);
        });
    });

    // =========================================================================
    // 6. Readiness Probe & Graceful Shutdown Integration
    // =========================================================================
    describe("Readiness Probe & Graceful Shutdown", () => {
        it("Requirement 20: Readiness probe reports matchmaking: connected when ready", async () => {
            await initMatchmakingRedisService({ redisClient: mockRedis });

            const res = await request(app).get("/readyz");
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.matchmaking, "connected");
            assert.strictEqual(res.body.presence, "connected");
            assert.strictEqual(res.body.socketAdapter, "connected");
        });

        it("Requirement 21: Readiness probe reports 503 and matchmaking: disconnected when Redis lost", async () => {
            await initMatchmakingRedisService({ redisClient: mockRedis });
            mockRedis.status = "close";

            const res = await request(app).get("/readyz");
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.body.matchmaking, "disconnected");
        });

        it("Requirement 22: Graceful shutdown cleans up matchmaking service cleanly", async () => {
            await initMatchmakingRedisService({ redisClient: mockRedis });
            assert.strictEqual(getMatchmakingRedisStatus().ready, true);

            await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 1000 });
            assert.strictEqual(getMatchmakingRedisStatus().ready, false);
        });
    });
});
