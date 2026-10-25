/**
 * Redis-Backed Distributed Random Matchmaking Service (Phase 3C.2)
 *
 * Provides distributed FIFO matchmaking queue and atomic call reservation
 * across horizontally scaled Node.js backend instances using Redis/Valkey:
 * 1. FIFO queue ordering via Redis Sorted Sets (ZSET) by joined timestamp.
 * 2. Atomic candidate reservation via Lua scripts to prevent dual-matching races.
 * 3. Shared call session state machine (consent_pending -> media_setup -> media_ready -> ended)
 *    accessible from any backend instance.
 * 4. Cross-instance event routing and WebRTC signaling via @socket.io/redis-adapter.
 */

import crypto from "crypto";
import { User } from "../models/user.model.js";
import { Block } from "../models/block.model.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import { isUserOnline } from "./presence.service.js";
import { getRedisClient } from "./redis.service.js";
import {
    isMatchmakingRedisEnabled,
    validateMatchmakingRedisConfig,
    formatSafeRedisError,
} from "../config/redis.js";

// =============================================================================
// Service State & Overrides
// =============================================================================

let redisClientOverride = null;
let isServiceReady = false;

// =============================================================================
// Atomic Lua Scripts
// =============================================================================

/**
 * Atomic Enqueue Script:
 * 1. Verifies user is not currently in an active call reservation.
 * 2. Adds user to queue sorted set with joined timestamp score.
 * 3. Sets user metadata with expiration TTL.
 * Returns: 1 on success, -1 if user is already in active call.
 */
export const ENQUEUE_USER_LUA = `
local queueKey = KEYS[1]
local userMetaKey = KEYS[2]
local userCallKey = KEYS[3]
local socketCallKey = KEYS[4]

local userId = ARGV[1]
local socketId = ARGV[2]
local nowMs = tonumber(ARGV[3])
local userMetaJson = ARGV[4]
local queueTtlSec = tonumber(ARGV[5])

if redis.call('EXISTS', userCallKey) == 1 or redis.call('EXISTS', socketCallKey) == 1 then
    return -1
end

redis.call('ZADD', queueKey, nowMs, userId)
redis.call('SET', userMetaKey, userMetaJson, 'EX', queueTtlSec)
return 1
`;

/**
 * Atomic Dequeue Script:
 * 1. Verifies matching socketId if provided (prevents stale socket clearing newer queue entry).
 * 2. Removes user from queue sorted set.
 * 3. Deletes user metadata key.
 * Returns: 1 if removed, 0 if not present or mismatched socket.
 */
export const DEQUEUE_USER_LUA = `
local queueKey = KEYS[1]
local userMetaKey = KEYS[2]

local userId = ARGV[1]
local socketId = ARGV[2]

if socketId and socketId ~= '' then
    local meta = redis.call('GET', userMetaKey)
    if meta then
        local decoded = cjson.decode(meta)
        if decoded.socketId and decoded.socketId ~= socketId then
            return 0
        end
    end
end

redis.call('ZREM', queueKey, userId)
redis.call('DEL', userMetaKey)
return 1
`;

/**
 * Atomic Reserve Match Script:
 * 1. Checks candidate is still present in queue (score != nil).
 * 2. Verifies neither candidate nor current user is in an active call.
 * 3. Atomically removes candidate from queue and deletes metadata.
 * 4. Creates call session key with callTtlSec TTL.
 * 5. Binds index pointers (user_call and socket_call) for both peers.
 * Returns: 1 on success, 0 on race condition / conflict.
 */
export const RESERVE_MATCH_LUA = `
local queueKey = KEYS[1]
local candUserMetaKey = KEYS[2]
local callKey = KEYS[3]
local candUserCallKey = KEYS[4]
local candSocketCallKey = KEYS[5]
local myUserCallKey = KEYS[6]
local mySocketCallKey = KEYS[7]

local candUserId = ARGV[1]
local callId = ARGV[2]
local callSessionJson = ARGV[3]
local callTtlSec = tonumber(ARGV[4])

local score = redis.call('ZSCORE', queueKey, candUserId)
if not score then
    return 0
end

if redis.call('EXISTS', candUserCallKey) == 1 or
   redis.call('EXISTS', candSocketCallKey) == 1 or
   redis.call('EXISTS', myUserCallKey) == 1 or
   redis.call('EXISTS', mySocketCallKey) == 1 then
    return 0
end

redis.call('ZREM', queueKey, candUserId)
redis.call('DEL', candUserMetaKey)

redis.call('SET', callKey, callSessionJson, 'EX', callTtlSec)
redis.call('SET', candUserCallKey, callId, 'EX', callTtlSec)
redis.call('SET', candSocketCallKey, callId, 'EX', callTtlSec)
redis.call('SET', myUserCallKey, callId, 'EX', callTtlSec)
redis.call('SET', mySocketCallKey, callId, 'EX', callTtlSec)

return 1
`;

/**
 * Atomic Consent Transition Script:
 * 1. Reads call session.
 * 2. If consent is 0 (declined), transitions state to ended and clears keys.
 * 3. If consent is 1, idempotently adds userId to consentedUsers.
 * 4. If both peers consented, transitions state to media_setup.
 * Returns: {status_code, state}
 */
export const SET_CONSENT_LUA = `
local callKey = KEYS[1]
local userId = ARGV[1]
local consentVal = ARGV[2]
local callTtlSec = tonumber(ARGV[3])

local raw = redis.call('GET', callKey)
if not raw then
    return {'not_found', ''}
end

local call = cjson.decode(raw)

if consentVal == '0' then
    call.state = 'ended'
    redis.call('DEL', callKey)
    return {'declined', 'ended'}
end

if call.state ~= 'consent_pending' then
    return {'already_advanced', call.state}
end

-- Add userId to consentedUsers set
local alreadyConsented = false
for _, uid in ipairs(call.consentedUsers) do
    if uid == userId then
        alreadyConsented = true
        break
    end
end
if not alreadyConsented then
    table.insert(call.consentedUsers, userId)
end

-- Check if both peers consented
local peerCount = #call.peers
local consentedCount = #call.consentedUsers

if consentedCount >= peerCount and peerCount >= 2 then
    call.state = 'media_setup'
    local updated = cjson.encode(call)
    redis.call('SET', callKey, updated, 'EX', callTtlSec)
    return {'both_consented', 'media_setup'}
else
    local updated = cjson.encode(call)
    redis.call('SET', callKey, updated, 'EX', callTtlSec)
    return {'waiting_for_partner', 'consent_pending'}
end
`;

/**
 * Atomic Media Ready Transition Script:
 * 1. Reads call session.
 * 2. Verifies call is in media_setup (rejects if consent_pending).
 * 3. Idempotently adds userId to mediaReadyUsers.
 * 4. If both peers media ready, transitions state to media_ready.
 * Returns: {status_code, state}
 */
export const SET_MEDIA_READY_LUA = `
local callKey = KEYS[1]
local userId = ARGV[1]
local callTtlSec = tonumber(ARGV[2])

local raw = redis.call('GET', callKey)
if not raw then
    return {'not_found', ''}
end

local call = cjson.decode(raw)

if call.state == 'consent_pending' then
    return {'consent_required', call.state}
end

if call.state == 'media_ready' then
    return {'already_ready', 'media_ready'}
end

local alreadyReady = false
for _, uid in ipairs(call.mediaReadyUsers) do
    if uid == userId then
        alreadyReady = true
        break
    end
end
if not alreadyReady then
    table.insert(call.mediaReadyUsers, userId)
end

local peerCount = #call.peers
local readyCount = #call.mediaReadyUsers

if readyCount >= peerCount and peerCount >= 2 then
    call.state = 'media_ready'
    local updated = cjson.encode(call)
    redis.call('SET', callKey, updated, 'EX', callTtlSec)
    return {'media_ready', 'media_ready'}
else
    local updated = cjson.encode(call)
    redis.call('SET', callKey, updated, 'EX', callTtlSec)
    return {'waiting_for_partner', 'media_setup'}
end
`;

/**
 * Atomic End Call Script:
 * Atomically deletes call session key and all peer index keys.
 */
export const END_CALL_LUA = `
for i = 1, #KEYS do
    redis.call('DEL', KEYS[i])
end
return 1
`;

// =============================================================================
// Helper Functions
// =============================================================================

const getEffectiveRedisClient = () => {
    return redisClientOverride || getRedisClient();
};

const getKeys = () => {
    const config = validateMatchmakingRedisConfig();
    const prefix = config.keyPrefix || "engaze:matchmaking";
    return {
        prefix,
        queueKey: `${prefix}:queue`,
        userMetaKey: (userId) => `${prefix}:user:{${userId}}`,
        callKey: (callId) => `${prefix}:call:{${callId}}`,
        userCallKey: (userId) => `${prefix}:user_call:{${userId}}`,
        socketCallKey: (socketId) => `${prefix}:socket_call:{${socketId}}`,
        queueTtlSec: Math.ceil(config.queueTtlMs / 1000),
        callTtlSec: Math.ceil(config.callTtlMs / 1000),
    };
};

// =============================================================================
// Service Lifecycle
// =============================================================================

/**
 * Initializes the Redis Matchmaking Service.
 * Validates configuration and verifies client connectivity.
 */
export const initMatchmakingRedisService = async ({ redisClient } = {}) => {
    const config = validateMatchmakingRedisConfig();
    if (!config.enabled) {
        isServiceReady = false;
        return { enabled: false, ready: false };
    }

    const client = redisClient || getEffectiveRedisClient();
    if (!client) {
        throw new Error("Matchmaking Redis Service initialization failed: Redis client unavailable.");
    }

    if (client.status && client.status !== "ready" && client.status !== "connect") {
        throw new Error(`Matchmaking Redis Service initialization failed: client status is ${client.status}.`);
    }

    isServiceReady = true;
    return { enabled: true, ready: true };
};

/**
 * Closes and resets the Matchmaking Redis Service cleanly.
 */
export const closeMatchmakingRedisService = async () => {
    isServiceReady = false;
    return { enabled: isMatchmakingRedisEnabled(), ready: false };
};

/**
 * Returns current health and readiness status of the matchmaking service.
 */
export const getMatchmakingRedisStatus = () => {
    const enabled = isMatchmakingRedisEnabled();
    if (!enabled) {
        return { enabled: false, ready: true, status: "disabled" };
    }
    const client = getEffectiveRedisClient();
    const isClientReady = Boolean(client && (client.status === "ready" || client.status === "connect" || !client.status));
    const ready = isServiceReady && isClientReady;
    return {
        enabled: true,
        ready,
        status: ready ? "ready" : "disconnected",
    };
};

// =============================================================================
// Queue Operations
// =============================================================================

/**
 * Enqueues a user into the Redis FIFO matchmaking queue.
 */
export const enqueueUserRedis = async ({ userId, socketId, userProfile }) => {
    const client = getEffectiveRedisClient();
    if (!client) throw new Error("Redis client unavailable");

    const { queueKey, userMetaKey, userCallKey, socketCallKey, queueTtlSec } = getKeys();
    const userIdStr = userId.toString();
    const nowMs = Date.now();
    const userMetaJson = JSON.stringify({
        userId: userIdStr,
        socketId,
        userProfile,
        joinedAt: nowMs,
    });

    const result = await client.eval(
        ENQUEUE_USER_LUA,
        4,
        queueKey,
        userMetaKey(userIdStr),
        userCallKey(userIdStr),
        socketCallKey(socketId),
        userIdStr,
        socketId,
        nowMs,
        userMetaJson,
        queueTtlSec
    );

    return { enqueued: result === 1, alreadyInCall: result === -1 };
};

/**
 * Dequeues a user from the Redis matchmaking queue.
 */
export const dequeueUserRedis = async ({ userId, socketId }) => {
    const client = getEffectiveRedisClient();
    if (!client) return { removed: false };

    const { queueKey, userMetaKey } = getKeys();
    const userIdStr = userId ? userId.toString() : "";
    const result = await client.eval(
        DEQUEUE_USER_LUA,
        2,
        queueKey,
        userMetaKey(userIdStr),
        userIdStr,
        socketId || ""
    );

    return { removed: result === 1 };
};

/**
 * Checks whether a user is currently queued in Redis.
 */
export const isUserInQueueRedis = async (userId) => {
    const client = getEffectiveRedisClient();
    if (!client) return false;

    const { queueKey } = getKeys();
    const score = await client.zscore(queueKey, userId.toString());
    return score !== null && score !== undefined;
};

// =============================================================================
// Atomic Candidate Search & Match Reservation
// =============================================================================

/**
 * Atomically finds an eligible candidate from the Redis queue and reserves a match,
 * or inserts the current user into the queue.
 */
export const findAndReserveMatchRedis = async ({ io, socket, userId, userProfile, ack }) => {
    const client = getEffectiveRedisClient();
    if (!client) throw new Error("Redis client unavailable for matchmaking");

    const userIdStr = userId.toString();
    const {
        queueKey,
        userMetaKey,
        callKey,
        userCallKey,
        socketCallKey,
        callTtlSec,
    } = getKeys();

    // 1. Cleanly dequeue any prior entry for this user or socket
    await dequeueUserRedis({ userId: userIdStr, socketId: socket.id });

    // 2. Fetch candidates from the front of the queue (FIFO ordering: lowest score first)
    // Scan up to 20 candidates per matchmaking turn
    const candidateIds = await client.zrange(queueKey, 0, 19);

    let reservedCall = null;
    let matchedCandidate = null;

    for (const candId of candidateIds) {
        // Discard self-entries
        if (candId === userIdStr) {
            await client.zrem(queueKey, candId);
            await client.del(userMetaKey(candId));
            continue;
        }

        // Fetch candidate metadata
        const candMetaRaw = await client.get(userMetaKey(candId));
        if (!candMetaRaw) {
            // Missing metadata indicates expired/stale queue entry; purge from queue
            await client.zrem(queueKey, candId);
            continue;
        }

        let candMeta;
        try {
            candMeta = typeof candMetaRaw === "string" ? JSON.parse(candMetaRaw) : candMetaRaw;
        } catch (_) {
            await client.zrem(queueKey, candId);
            await client.del(userMetaKey(candId));
            continue;
        }

        if (candMeta.socketId === socket.id) {
            await client.zrem(queueKey, candId);
            await client.del(userMetaKey(candId));
            continue;
        }

        // Check if candidate is still online across any cluster instance
        const localCandidateSocket = io?.sockets?.sockets?.get?.(candMeta.socketId);
        let candOnline = false;
        if (localCandidateSocket && localCandidateSocket.connected) {
            candOnline = true;
        } else {
            candOnline = await isUserOnline(candId);
        }

        if (!candOnline) {
            // Candidate is offline; purge from queue
            await client.zrem(queueKey, candId);
            await client.del(userMetaKey(candId));
            continue;
        }

        // Check candidate DB eligibility
        const candUser = await User.findById(candId).select("name dob gender bio photos interests isProfileComplete");
        const candElig = checkUserEligibility(candUser);
        if (!candElig.isEligible) {
            await client.zrem(queueKey, candId);
            await client.del(userMetaKey(candId));
            continue;
        }

        // Check bidirectional block status
        const isBlocked = await Block.isBlockedBidirectional(userIdStr, candId);
        if (isBlocked) {
            // Retain candidate in queue for other users; skip pairing
            continue;
        }

        // Candidate is eligible, online, and unblocked. Attempt atomic reservation!
        const callId = `call_${crypto.randomUUID()}`;
        const peerA = {
            socketId: candMeta.socketId,
            userId: candId,
            userProfile: candMeta.userProfile,
            isInitiator: true, // Caller: creates WebRTC offer
        };
        const peerB = {
            socketId: socket.id,
            userId: userIdStr,
            userProfile,
            isInitiator: false, // Callee: awaits offer, responds with answer
        };

        const callSession = {
            callId,
            state: "consent_pending",
            peers: [peerA, peerB],
            consentedUsers: [],
            mediaReadyUsers: [],
            startedAt: Date.now(),
        };

        const callSessionJson = JSON.stringify(callSession);

        const reserved = await client.eval(
            RESERVE_MATCH_LUA,
            7,
            queueKey,
            userMetaKey(candId),
            callKey(callId),
            userCallKey(candId),
            socketCallKey(candMeta.socketId),
            userCallKey(userIdStr),
            socketCallKey(socket.id),
            candId,
            callId,
            callSessionJson,
            callTtlSec
        );

        if (reserved === 1) {
            reservedCall = callSession;
            matchedCandidate = candMeta;
            break;
        }
        // If reservation returned 0, another concurrent instance claimed candidate; continue scanning
    }

    if (reservedCall && matchedCandidate) {
        const { callId, peers } = reservedCall;
        const [peerA, peerB] = peers;
        const roomName = `random-call:${callId}`;

        // Join socket.io room locally if socket is connected on this instance
        const candSocket = io?.sockets?.sockets?.get?.(peerA.socketId);
        if (candSocket) candSocket.join(roomName);
        socket.join(roomName);

        // Notify candidate (Initiator) via cross-instance Socket.IO broadcast
        io.to(peerA.socketId).emit("random:matched", {
            callId,
            isInitiator: true,
            partner: peerB.userProfile,
            requiresConsent: true,
        });

        // Notify current socket (Receiver)
        io.to(peerB.socketId).emit("random:matched", {
            callId,
            isInitiator: false,
            partner: peerA.userProfile,
            requiresConsent: true,
        });

        if (typeof ack === "function") {
            ack({ success: true, status: "matched", callId });
        }

        return { status: "matched", callId, callSession: reservedCall };
    }

    // No eligible candidate waiting: Enqueue current user
    await enqueueUserRedis({
        userId: userIdStr,
        socketId: socket.id,
        userProfile,
    });

    socket.emit("random:queue-joined", {
        status: "waiting",
        message: "Looking for an available match...",
    });

    if (typeof ack === "function") {
        ack({ success: true, status: "waiting" });
    }

    return { status: "waiting" };
};

// =============================================================================
// Call Session State Management
// =============================================================================

/**
 * Retrieves the active call session by callId from Redis.
 */
export const getCallSessionRedis = async (callId) => {
    const client = getEffectiveRedisClient();
    if (!client || !callId) return null;

    const { callKey } = getKeys();
    const raw = await client.get(callKey(callId));
    if (!raw) return null;

    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        // Convert array representations to Sets for compatibility with internal call checks if needed
        return parsed;
    } catch {
        return null;
    }
};

/**
 * Retrieves the active callId for a given socketId from Redis index.
 */
export const getCallIdForSocketRedis = async (socketId) => {
    const client = getEffectiveRedisClient();
    if (!client || !socketId) return null;

    const { socketCallKey } = getKeys();
    return await client.get(socketCallKey(socketId));
};

/**
 * Retrieves the active callId for a given userId from Redis index.
 */
export const getCallIdForUserRedis = async (userId) => {
    const client = getEffectiveRedisClient();
    if (!client || !userId) return null;

    const { userCallKey } = getKeys();
    return await client.get(userCallKey(userId.toString()));
};

/**
 * Sets user consent in the Redis call session.
 */
export const setUserConsentRedis = async ({ callId, userId, consent, io, socket, ack }) => {
    const client = getEffectiveRedisClient();
    if (!client) throw new Error("Redis client unavailable");

    const { callKey, callTtlSec } = getKeys();
    const userIdStr = userId.toString();

    if (consent === false) {
        // Explicit decline: cleanly terminate call session
        socket.emit("random:call-ended", {
            callId,
            reason: "declined_by_user",
        });
        await endCallSessionRedis({ callId, initiatorSocketId: socket.id, reason: "declined_by_partner", io });
        if (typeof ack === "function") ack({ success: true, status: "declined" });
        return { success: true, status: "declined" };
    }

    // Call atomic consent transition Lua script
    const result = await client.eval(
        SET_CONSENT_LUA,
        1,
        callKey(callId),
        userIdStr,
        "1",
        callTtlSec
    );

    const [statusCode, state] = Array.isArray(result) ? result : [result, ""];

    if (statusCode === "not_found") {
        const err = { message: "Active call session not found or has ended" };
        socket.emit("random:error", err);
        if (typeof ack === "function") ack({ success: false, ...err });
        return { success: false, ...err };
    }

    if (statusCode === "already_advanced") {
        if (typeof ack === "function") ack({ success: true, status: state });
        return { success: true, status: state };
    }

    const updatedCall = await getCallSessionRedis(callId);
    if (!updatedCall) {
        if (typeof ack === "function") ack({ success: true, status: "ended" });
        return { success: true, status: "ended" };
    }

    const partner = updatedCall.peers.find((p) => p.socketId !== socket.id);

    if (statusCode === "both_consented") {
        for (const peer of updatedCall.peers) {
            io.to(peer.socketId).emit("random:both-consented", { callId });
        }
        if (typeof ack === "function") ack({ success: true, status: "both_consented" });
        return { success: true, status: "both_consented" };
    } else {
        socket.emit("random:waiting-for-partner-consent", { callId });
        if (partner) {
            io.to(partner.socketId).emit("random:partner-consented", { callId });
        }
        if (typeof ack === "function") ack({ success: true, status: "waiting_for_partner" });
        return { success: true, status: "waiting_for_partner" };
    }
};

/**
 * Sets user media readiness in the Redis call session.
 */
export const setMediaReadyRedis = async ({ callId, userId, io, socket, ack }) => {
    const client = getEffectiveRedisClient();
    if (!client) throw new Error("Redis client unavailable");

    const { callKey, callTtlSec } = getKeys();
    const userIdStr = userId.toString();

    const result = await client.eval(
        SET_MEDIA_READY_LUA,
        1,
        callKey(callId),
        userIdStr,
        callTtlSec
    );

    const [statusCode, state] = Array.isArray(result) ? result : [result, ""];

    if (statusCode === "not_found") {
        const err = { message: "Active call session not found or has ended" };
        socket.emit("random:error", err);
        if (typeof ack === "function") ack({ success: false, ...err });
        return { success: false, ...err };
    }

    if (statusCode === "consent_required") {
        const err = { message: "Mutual consent required before media setup" };
        socket.emit("random:error", err);
        if (typeof ack === "function") ack({ success: false, ...err });
        return { success: false, ...err };
    }

    if (statusCode === "already_ready") {
        if (typeof ack === "function") ack({ success: true, status: "media_ready" });
        return { success: true, status: "media_ready" };
    }

    const updatedCall = await getCallSessionRedis(callId);
    if (!updatedCall) {
        if (typeof ack === "function") ack({ success: true, status: "ended" });
        return { success: true, status: "ended" };
    }

    if (statusCode === "media_ready") {
        const initiator = updatedCall.peers.find((p) => p.isInitiator);
        for (const peer of updatedCall.peers) {
            io.to(peer.socketId).emit("random:media-start", {
                callId,
                initiatorId: initiator?.userId,
                isInitiator: peer.isInitiator,
            });
        }
        if (typeof ack === "function") ack({ success: true, status: "media_ready" });
        return { success: true, status: "media_ready" };
    } else {
        socket.emit("random:waiting-for-partner-media", { callId });
        if (typeof ack === "function") ack({ success: true, status: "waiting_for_partner" });
        return { success: true, status: "waiting_for_partner" };
    }
};

/**
 * Cleanly terminates an active call session in Redis and cleans up all index pointers.
 */
export const endCallSessionRedis = async ({ callId, initiatorSocketId, reason, io }) => {
    const client = getEffectiveRedisClient();
    if (!client || !callId) return null;

    const { callKey, userCallKey, socketCallKey } = getKeys();
    const call = await getCallSessionRedis(callId);
    if (!call) return null;

    // Keys to delete: callKey, and userCallKey/socketCallKey for each peer
    const keysToDelete = [callKey(callId)];
    for (const peer of call.peers) {
        if (peer.userId) keysToDelete.push(userCallKey(peer.userId));
        if (peer.socketId) keysToDelete.push(socketCallKey(peer.socketId));
    }

    await client.eval(
        END_CALL_LUA,
        keysToDelete.length,
        ...keysToDelete
    );

    const roomName = `random-call:${callId}`;

    // Clean up local process socket rooms and notify partner
    for (const peer of call.peers) {
        const peerSocket = io?.sockets?.sockets?.get?.(peer.socketId);
        if (peerSocket) {
            peerSocket.leave(roomName);
        }

        if (peer.socketId !== initiatorSocketId && io) {
            io.to(peer.socketId).emit("random:call-ended", {
                callId,
                reason: reason || "ended_by_partner",
            });
        }
    }

    return call;
};

/**
 * Safely terminates any active call between two users in Redis (e.g. upon block/report).
 */
export const endActiveCallBetweenUsersRedis = async (userIdA, userIdB, io) => {
    if (!userIdA || !userIdB) return null;
    const userAStr = userIdA.toString();
    const userBStr = userIdB.toString();

    const callIdA = await getCallIdForUserRedis(userAStr);
    const callIdB = await getCallIdForUserRedis(userBStr);
    const callId = callIdA || callIdB;
    if (!callId) return null;

    const call = await getCallSessionRedis(callId);
    if (!call) return null;

    const hasA = call.peers.some((p) => p.userId === userAStr);
    const hasB = call.peers.some((p) => p.userId === userBStr);
    if (hasA && hasB) {
        return await endCallSessionRedis({ callId, initiatorSocketId: null, reason: "ended_by_partner", io });
    }
    return null;
};

// =============================================================================
// Testing Inspection Helpers
// =============================================================================

export const _testingRedis = {
    setClient: (client) => {
        redisClientOverride = client;
        isServiceReady = Boolean(client);
    },
    resetClient: () => {
        redisClientOverride = null;
        isServiceReady = false;
    },
    getKeys,
};

