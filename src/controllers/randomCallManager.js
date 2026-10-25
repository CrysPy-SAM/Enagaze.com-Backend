import crypto from "crypto";
import { User } from "../models/user.model.js";
import { Block } from "../models/block.model.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import {
    isPlainObject,
    isValidSignalPayload,
    checkSocketRateLimit,
    clearSocketRateLimits,
} from "../utils/socketValidator.js";
import { isMatchmakingRedisEnabled } from "../config/redis.js";
import {
    findAndReserveMatchRedis,
    dequeueUserRedis,
    getCallSessionRedis,
    getCallIdForSocketRedis,
    getCallIdForUserRedis,
    setUserConsentRedis,
    setMediaReadyRedis,
    endCallSessionRedis,
    endActiveCallBetweenUsersRedis,
} from "../services/randomMatchmakingRedis.service.js";
import { isUserOnline } from "../services/presence.service.js";

// In-memory matchmaking state
const matchmakingQueue = [];
const activeCalls = new Map(); // callId -> { callId, peers: [{ socketId, userId, userProfile, isInitiator }], startedAt }
const socketToCall = new Map(); // socketId -> callId
const userToCall = new Map(); // userId -> callId

/**
 * Remove a user/socket from the matchmaking queue
 */
function removeFromQueue(socketId, userId) {
    let removed = false;
    for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
        const item = matchmakingQueue[i];
        if ((socketId && item.socketId === socketId) || (userId && item.userId === userId.toString())) {
            matchmakingQueue.splice(i, 1);
            removed = true;
        }
    }
    return removed;
}

/**
 * Check if a user or socket is in the matchmaking queue
 */
function isUserInQueue(socketId, userId) {
    return matchmakingQueue.some(
        (item) =>
            (socketId && item.socketId === socketId) ||
            (userId && item.userId === userId.toString())
    );
}

/**
 * Cleanly terminate an active call session
 */
function endActiveCall(callId, initiatorSocketId, reason, io) {
    const call = activeCalls.get(callId);
    if (!call) return null;

    call.state = "ended";
    if (call.consentedUsers) call.consentedUsers.clear();
    if (call.mediaReadyUsers) call.mediaReadyUsers.clear();

    const roomName = `random-call:${callId}`;

    // Notify partner peer if still connected and leave room
    for (const peer of call.peers) {
        socketToCall.delete(peer.socketId);
        userToCall.delete(peer.userId);

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

    activeCalls.delete(callId);
    return call;
}

/**
 * Retrieve public dating profile for matchmaking preview
 */
async function getPublicProfile(userId) {
    try {
        const user = await User.findById(userId).select("name dob photos gender bio interests isProfileComplete");
        if (!user) return { _id: userId ? userId.toString() : undefined, name: "Engaze Member", photos: [] };
        return toPublicProfile(user);
    } catch {
        return { _id: userId ? userId.toString() : undefined, name: "Engaze Member", photos: [] };
    }
}

/**
 * Atomically match a socket with a waiting peer or insert into the matchmaking queue
 */
export async function matchOrQueueUser(io, socket, ack) {
    const userIdStr = socket.userId.toString();

    // Prevent duplicate queue entries for the same user or socket
    removeFromQueue(socket.id, userIdStr);

    // Verify authoritative user eligibility before queue mutation or matching
    const user = await User.findById(socket.userId).select("name dob gender bio photos interests isProfileComplete");
    const eligibility = checkUserEligibility(user);
    if (!eligibility.isEligible) {
        const err = {
            code: eligibility.code,
            message: eligibility.reason || "Complete your profile and confirm age to join random video matchmaking",
            missingFields: eligibility.missingFields,
        };
        socket.emit("random:error", err);
        if (typeof ack === "function") ack({ success: false, ...err });
        return;
    }

    // Fetch user profile for matchmaking card
    const userProfile = toPublicProfile(user);

    // If Redis matchmaking is enabled, coordinate queue and reservation via Redis/Valkey
    if (isMatchmakingRedisEnabled()) {
        await findAndReserveMatchRedis({ io, socket, userId: socket.userId, userProfile, ack });
        return;
    }

    // Atomic candidate search: Find eligible peer already waiting in queue
    let candidate = null;
    const skippedCandidates = [];

    while (matchmakingQueue.length > 0) {
        const nextInLine = matchmakingQueue.shift();

        // Self-matching prevention
        if (nextInLine.userId === userIdStr || nextInLine.socketId === socket.id) {
            continue; // Skip and discard duplicate self-entries
        }

        // Verify candidate socket is still connected
        const candidateSocket = io.sockets.sockets.get(nextInLine.socketId);
        if (candidateSocket && candidateSocket.connected) {
            // Verify candidate user remains eligible
            const candUser = await User.findById(nextInLine.userId).select("name dob gender bio photos interests isProfileComplete");
            const candElig = checkUserEligibility(candUser);
            if (!candElig.isEligible) {
                continue; // Discard ineligible candidate from queue
            }

            // Check if either user has blocked the other
            const isBlocked = await Block.isBlockedBidirectional(userIdStr, nextInLine.userId);
            if (isBlocked) {
                skippedCandidates.push(nextInLine);
                continue; // Cannot pair with blocked user; retain candidate for other users
            }

            candidate = nextInLine;
            break;
        }
        // Disconnected candidate automatically discarded
    }

    // Restore skipped candidates back to the front of queue in original relative order
    if (skippedCandidates.length > 0) {
        matchmakingQueue.unshift(...skippedCandidates);
    }

    if (candidate) {
        // MATCH FOUND! Atomically create private 2-person call session
        const callId = `call_${crypto.randomUUID()}`;
        const roomName = `random-call:${callId}`;

        const peerA = {
            socketId: candidate.socketId,
            userId: candidate.userId,
            userProfile: candidate.userProfile,
            isInitiator: true, // Caller: creates offer
        };
        const peerB = {
            socketId: socket.id,
            userId: userIdStr,
            userProfile: userProfile,
            isInitiator: false, // Callee: awaits offer, responds with answer
        };

        const callSession = {
            callId,
            state: "consent_pending",
            peers: [peerA, peerB],
            consentedUsers: new Set(),
            mediaReadyUsers: new Set(),
            startedAt: Date.now(),
        };

        activeCalls.set(callId, callSession);
        socketToCall.set(peerA.socketId, callId);
        socketToCall.set(peerB.socketId, callId);
        userToCall.set(peerA.userId, callId);
        userToCall.set(peerB.userId, callId);

        // Join isolated Socket.io room
        const candidateSocket = io.sockets.sockets.get(candidate.socketId);
        if (candidateSocket) candidateSocket.join(roomName);
        socket.join(roomName);

        // Notify candidate (Initiator)
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
    } else {
        // No eligible partner waiting: Add to queue
        matchmakingQueue.push({
            socketId: socket.id,
            userId: userIdStr,
            userProfile,
            joinedAt: Date.now(),
        });

        socket.emit("random:queue-joined", {
            status: "waiting",
            message: "Looking for an available match...",
        });

        if (typeof ack === "function") {
            ack({ success: true, status: "waiting" });
        }
    }
}

/**
 * Register all Random 1-to-1 Video Matchmaking event handlers on a socket
 */
export function registerRandomCallHandlers(io, socket) {
    // -------------------------------------------------------------
    // 1. Join Matchmaking Queue
    // -------------------------------------------------------------
    socket.on("random:join-queue", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required to join random video matchmaking" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (data !== undefined && data !== null && !isPlainObject(data)) {
            const err = { message: "Invalid payload format: plain object expected" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Abuse throttle: max 5 queue join attempts per 2 seconds
        if (!(await checkSocketRateLimit(`${socket.id}:join-queue`, 5, 2000))) {
            const err = { message: "Queue join rate limit exceeded. Please wait a moment." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const userIdStr = socket.userId.toString();

        // If user is currently in an active call, terminate it first
        if (isMatchmakingRedisEnabled()) {
            const currentCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(userIdStr));
            if (currentCallId) {
                await endCallSessionRedis({ callId: currentCallId, initiatorSocketId: socket.id, reason: "started_new_search", io });
            }
        } else {
            if (socketToCall.has(socket.id) || userToCall.has(userIdStr)) {
                const currentCallId = socketToCall.get(socket.id) || userToCall.get(userIdStr);
                endActiveCall(currentCallId, socket.id, "started_new_search", io);
            }
        }

        await matchOrQueueUser(io, socket, ack);
    });

    // -------------------------------------------------------------
    // 2. Cancel / Leave Matchmaking Queue
    // -------------------------------------------------------------
    socket.on("random:leave-queue", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (data !== undefined && data !== null && !isPlainObject(data)) {
            const err = { message: "Invalid payload format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const userIdStr = socket.userId.toString();

        if (isMatchmakingRedisEnabled()) {
            const { removed } = await dequeueUserRedis({ userId: userIdStr, socketId: socket.id });
            socket.emit("random:queue-left", { success: true });
            if (typeof ack === "function") {
                ack({ success: true, wasQueued: removed });
            }
            return;
        }

        const removed = removeFromQueue(socket.id, userIdStr);

        socket.emit("random:queue-left", { success: true });
        if (typeof ack === "function") {
            ack({ success: true, wasQueued: removed });
        }
    });

    // -------------------------------------------------------------
    // 3. User Consent Gate
    // -------------------------------------------------------------
    socket.on("random:consent", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Rate limit consent attempts: max 10 per 2 seconds
        if (!(await checkSocketRateLimit(`${socket.id}:consent`, 10, 2000))) {
            const err = { message: "Consent rate limit exceeded. Please wait a moment." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (!isPlainObject(data)) {
            const err = { message: "Invalid payload format: plain object expected" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const { callId, consent } = data;

        if (!callId || typeof callId !== "string" || !/^call_[0-9a-fA-F-]+$/.test(callId)) {
            const err = { message: "Invalid call ID format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (typeof consent !== "boolean") {
            const err = { message: "Invalid consent parameter: boolean expected" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (isMatchmakingRedisEnabled()) {
            const call = await getCallSessionRedis(callId);
            if (!call) {
                const err = { message: "Active call session not found or has ended" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const callerPeer = call.peers.find(
                (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
            );
            if (!callerPeer) {
                const err = { message: "Unauthorized consent attempt: not an active call participant" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const activeCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(socket.userId.toString()));
            if (activeCallId !== callId) {
                const err = { message: "Mismatched or stale call session" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            await setUserConsentRedis({ callId, userId: socket.userId, consent, io, socket, ack });
            return;
        }

        const call = activeCalls.get(callId);
        if (!call) {
            const err = { message: "Active call session not found or has ended" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const callerPeer = call.peers.find(
            (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
        );
        if (!callerPeer) {
            const err = { message: "Unauthorized consent attempt: not an active call participant" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify that caller's state machine mappings match this active call
        if (socketToCall.get(socket.id) !== callId || userToCall.get(socket.userId.toString()) !== callId) {
            const err = { message: "Mismatched or stale call session" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (consent === false) {
            // User explicitly declined match
            socket.emit("random:call-ended", {
                callId,
                reason: "declined_by_user",
            });
            endActiveCall(callId, socket.id, "declined_by_partner", io);
            if (typeof ack === "function") ack({ success: true, status: "declined" });
            return;
        }

        // Idempotency: If call already transitioned beyond consent_pending, do not re-trigger both-consented
        if (call.state !== "consent_pending") {
            if (typeof ack === "function") ack({ success: true, status: call.state });
            return;
        }

        // User consented (consent === true)
        call.consentedUsers.add(socket.userId.toString());

        const partner = call.peers.find((p) => p.socketId !== socket.id);
        const partnerConsented = partner && call.consentedUsers.has(partner.userId);

        if (partnerConsented) {
            call.state = "media_setup";
            for (const peer of call.peers) {
                io.to(peer.socketId).emit("random:both-consented", { callId });
            }
            if (typeof ack === "function") ack({ success: true, status: "both_consented" });
        } else {
            socket.emit("random:waiting-for-partner-consent", { callId });
            if (partner) {
                io.to(partner.socketId).emit("random:partner-consented", { callId });
            }
            if (typeof ack === "function") ack({ success: true, status: "waiting_for_partner" });
        }
    });

    // -------------------------------------------------------------
    // 4. Local Media Readiness Confirmation
    // -------------------------------------------------------------
    socket.on("random:media-ready", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Rate limit media-ready attempts: max 10 per 2 seconds
        if (!(await checkSocketRateLimit(`${socket.id}:media-ready`, 10, 2000))) {
            const err = { message: "Media readiness rate limit exceeded. Please wait a moment." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (!isPlainObject(data)) {
            const err = { message: "Invalid payload format: plain object expected" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const { callId } = data;

        if (!callId || typeof callId !== "string" || !/^call_[0-9a-fA-F-]+$/.test(callId)) {
            const err = { message: "Invalid call ID format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (isMatchmakingRedisEnabled()) {
            const call = await getCallSessionRedis(callId);
            if (!call) {
                const err = { message: "Active call session not found or has ended" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const callerPeer = call.peers.find(
                (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
            );
            if (!callerPeer) {
                const err = { message: "Unauthorized media-ready attempt: not an active call participant" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const activeCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(socket.userId.toString()));
            if (activeCallId !== callId) {
                const err = { message: "Mismatched or stale call session" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (call.state === "consent_pending") {
                const err = { message: "Mutual consent required before media setup" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            await setMediaReadyRedis({ callId, userId: socket.userId, io, socket, ack });
            return;
        }

        const call = activeCalls.get(callId);
        if (!call) {
            const err = { message: "Active call session not found or has ended" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const callerPeer = call.peers.find(
            (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
        );
        if (!callerPeer) {
            const err = { message: "Unauthorized media-ready attempt: not an active call participant" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify that caller's state machine mappings match this active call
        if (socketToCall.get(socket.id) !== callId || userToCall.get(socket.userId.toString()) !== callId) {
            const err = { message: "Mismatched or stale call session" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (call.state === "consent_pending") {
            const err = { message: "Mutual consent required before media setup" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Idempotency: If call already reached media_ready, do not re-broadcast media-start
        if (call.state === "media_ready") {
            if (typeof ack === "function") ack({ success: true, status: "media_ready" });
            return;
        }

        call.mediaReadyUsers.add(socket.userId.toString());

        const partner = call.peers.find((p) => p.socketId !== socket.id);
        const partnerReady = partner && call.mediaReadyUsers.has(partner.userId);

        if (partnerReady) {
            call.state = "media_ready";
            const initiator = call.peers.find((p) => p.isInitiator);
            for (const peer of call.peers) {
                io.to(peer.socketId).emit("random:media-start", {
                    callId,
                    initiatorId: initiator?.userId,
                    isInitiator: peer.isInitiator,
                });
            }
            if (typeof ack === "function") ack({ success: true, status: "media_ready" });
        } else {
            socket.emit("random:waiting-for-partner-media", { callId });
            if (typeof ack === "function") ack({ success: true, status: "waiting_for_partner" });
        }
    });

    // -------------------------------------------------------------
    // 5. Media Failure Reporting (Permission Denied / Device Error)
    // -------------------------------------------------------------
    socket.on("random:media-failed", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (!isPlainObject(data)) {
            const err = { message: "Invalid payload format: plain object expected" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const { callId } = data;

        if (!callId || typeof callId !== "string" || !/^call_[0-9a-fA-F-]+$/.test(callId)) {
            const err = { message: "Invalid call ID format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (isMatchmakingRedisEnabled()) {
            const call = await getCallSessionRedis(callId);
            if (!call) {
                if (typeof ack === "function") ack({ success: true, wasActive: false });
                return;
            }

            const callerPeer = call.peers.find(
                (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
            );
            if (!callerPeer) {
                const err = { message: "Unauthorized media-failed attempt: not an active call participant" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const activeCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(socket.userId.toString()));
            if (activeCallId !== callId) {
                if (typeof ack === "function") ack({ success: true, wasActive: false });
                return;
            }

            socket.emit("random:call-ended", {
                callId,
                reason: "media_failed",
            });
            await endCallSessionRedis({ callId, initiatorSocketId: socket.id, reason: "partner_media_failed", io });

            if (typeof ack === "function") {
                ack({ success: true, status: "media_failed" });
            }
            return;
        }

        const call = activeCalls.get(callId);
        if (!call) {
            if (typeof ack === "function") ack({ success: true, wasActive: false });
            return;
        }

        const callerPeer = call.peers.find(
            (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
        );
        if (!callerPeer) {
            const err = { message: "Unauthorized media-failed attempt: not an active call participant" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify that caller's state machine mappings match this active call
        if (socketToCall.get(socket.id) !== callId || userToCall.get(socket.userId.toString()) !== callId) {
            if (typeof ack === "function") ack({ success: true, wasActive: false });
            return;
        }

        socket.emit("random:call-ended", {
            callId,
            reason: "media_failed",
        });
        endActiveCall(callId, socket.id, "partner_media_failed", io);

        if (typeof ack === "function") {
            ack({ success: true, status: "media_failed" });
        }
    });

    // -------------------------------------------------------------
    // 6. WebRTC Signaling (Offer, Answer, ICE Candidates)
    // -------------------------------------------------------------
    socket.on("random:signal", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required for signaling" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Throttle high-frequency signaling: max 60 signals per 2 seconds per socket
        if (!(await checkSocketRateLimit(`${socket.id}:signal`, 60, 2000))) {
            const err = { message: "Signaling rate limit exceeded. Please slow down." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (!isPlainObject(data)) {
            const err = { message: "Invalid signaling payload: plain object required" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const { callId, signalData, recipientId } = data;

        // Validate callId format: must start with call_ and contain alphanumeric/dashes
        if (!callId || typeof callId !== "string" || !/^call_[0-9a-fA-F-]+$/.test(callId)) {
            const err = { message: "Invalid call ID format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Validate signalData structure and size (<= 64KB, no oversized or malformed payloads)
        if (!isValidSignalPayload(signalData, 65536)) {
            const err = { message: "Invalid or oversized signaling payload" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (isMatchmakingRedisEnabled()) {
            const call = await getCallSessionRedis(callId);
            if (!call) {
                const err = { message: "Active call session not found or has ended" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const callerPeer = call.peers.find(
                (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
            );
            if (!callerPeer) {
                const err = { message: "Unauthorized signaling attempt: not an active call participant" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const activeCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(socket.userId.toString()));
            if (activeCallId !== callId) {
                const err = { message: "Mismatched or stale call session" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (call.state !== "media_ready") {
                const err = {
                    code: "SIGNAL_GATE_RESTRICTED",
                    message: "Signaling forbidden: both participants must consent and finish media setup before WebRTC signaling",
                };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const partner = call.peers.find((p) => p.socketId !== socket.id);
            if (!partner) {
                const err = { message: "Partner peer is no longer in call" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (recipientId && recipientId !== partner.userId && recipientId !== partner.socketId) {
                const err = { message: "Unauthorized recipient mismatch" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const partnerSocket = io?.sockets?.sockets?.get?.(partner.socketId);
            let isConnected = false;
            if (partnerSocket && partnerSocket.connected) {
                isConnected = true;
            } else {
                isConnected = await isUserOnline(partner.userId);
            }

            if (!isConnected) {
                await endCallSessionRedis({ callId, initiatorSocketId: socket.id, reason: "partner_disconnected", io });
                const err = { message: "Partner disconnected" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const isBlocked = await Block.isBlockedBidirectional(socket.userId, partner.userId);
            if (isBlocked) {
                await endCallSessionRedis({ callId, initiatorSocketId: socket.id, reason: "ended_by_partner", io });
                const err = { message: "Call session ended" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            io.to(partner.socketId).emit("random:signal", {
                callId,
                signalData,
                senderId: socket.userId.toString(),
            });

            if (typeof ack === "function") {
                ack({ success: true });
            }
            return;
        }

        const call = activeCalls.get(callId);
        if (!call) {
            const err = { message: "Active call session not found or has ended" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify that transmitting socket is a registered participant in this active call
        const callerPeer = call.peers.find(
            (p) => p.socketId === socket.id && p.userId === socket.userId.toString()
        );
        if (!callerPeer) {
            const err = { message: "Unauthorized signaling attempt: not an active call participant" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify that caller's state machine mappings match this active call
        if (socketToCall.get(socket.id) !== callId || userToCall.get(socket.userId.toString()) !== callId) {
            const err = { message: "Mismatched or stale call session" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Enforce Server-Side Consent & Media Readiness Gate
        if (call.state !== "media_ready") {
            const err = {
                code: "SIGNAL_GATE_RESTRICTED",
                message: "Signaling forbidden: both participants must consent and finish media setup before WebRTC signaling",
            };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Route signaling message strictly to the partner peer
        const partner = call.peers.find((p) => p.socketId !== socket.id);
        if (!partner) {
            const err = { message: "Partner peer is no longer in call" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Anti-spoofing: if client supplied recipientId, verify it matches the actual partner
        if (recipientId && recipientId !== partner.userId && recipientId !== partner.socketId) {
            const err = { message: "Unauthorized recipient mismatch" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify partner socket is still connected
        const partnerSocket = io.sockets.sockets.get(partner.socketId);
        if (!partnerSocket || !partnerSocket.connected) {
            endActiveCall(callId, socket.id, "partner_disconnected", io);
            const err = { message: "Partner disconnected" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Verify neither participant has blocked the other
        const isBlocked = await Block.isBlockedBidirectional(socket.userId, partner.userId);
        if (isBlocked) {
            endActiveCall(callId, socket.id, "ended_by_partner", io);
            const err = { message: "Call session ended" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Transmit private signaling data strictly to partner socket
        // Identity is derived server-side from socket.userId (never trust client-supplied sender)
        io.to(partner.socketId).emit("random:signal", {
            callId,
            signalData,
            senderId: socket.userId.toString(),
        });

        if (typeof ack === "function") {
            ack({ success: true });
        }
    });

    // -------------------------------------------------------------
    // 4. End Call / Hangup
    // -------------------------------------------------------------
    socket.on("random:end-call", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (data !== undefined && data !== null && !isPlainObject(data)) {
            const err = { message: "Invalid payload format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (isMatchmakingRedisEnabled()) {
            const activeCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(socket.userId.toString()));
            if (!activeCallId) {
                if (typeof ack === "function") ack({ success: true, wasActive: false });
                return;
            }

            if (data?.callId && data.callId !== activeCallId) {
                const err = { message: "Cannot end a call you are not participating in" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            await endCallSessionRedis({ callId: activeCallId, initiatorSocketId: socket.id, reason: "ended_by_user", io });

            if (typeof ack === "function") {
                ack({ success: true, wasActive: true });
            }
            return;
        }

        const activeCallId = socketToCall.get(socket.id);
        if (!activeCallId) {
            // Idempotent: already ended or not in call
            if (typeof ack === "function") ack({ success: true, wasActive: false });
            return;
        }

        // If client supplied a callId, make sure it matches their current active call
        if (data?.callId && data.callId !== activeCallId) {
            const err = { message: "Cannot end a call you are not participating in" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        endActiveCall(activeCallId, socket.id, "ended_by_user", io);

        if (typeof ack === "function") {
            ack({ success: true, wasActive: true });
        }
    });

    // -------------------------------------------------------------
    // 5. Next Match (Skip to next user)
    // -------------------------------------------------------------
    socket.on("random:next", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required to find next match" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (data !== undefined && data !== null && !isPlainObject(data)) {
            const err = { message: "Invalid payload format" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Rate limit next skips: max 5 per 2 seconds
        if (!(await checkSocketRateLimit(`${socket.id}:next`, 5, 2000))) {
            const err = { message: "Next match rate limit exceeded. Please slow down." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (isMatchmakingRedisEnabled()) {
            const activeCallId = (await getCallIdForSocketRedis(socket.id)) || (await getCallIdForUserRedis(socket.userId.toString()));
            if (data?.callId && activeCallId && data.callId !== activeCallId) {
                const err = { message: "Cannot skip a call you are not participating in" };
                socket.emit("random:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (activeCallId) {
                await endCallSessionRedis({ callId: activeCallId, initiatorSocketId: socket.id, reason: "skipped_by_partner", io });
            }

            await matchOrQueueUser(io, socket, ack);
            return;
        }

        const activeCallId = socketToCall.get(socket.id);
        if (data?.callId && activeCallId && data.callId !== activeCallId) {
            const err = { message: "Cannot skip a call you are not participating in" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        if (activeCallId) {
            endActiveCall(activeCallId, socket.id, "skipped_by_partner", io);
        }

        // Atomically match with a waiting partner or re-enter the queue
        await matchOrQueueUser(io, socket, ack);
    });

    // -------------------------------------------------------------
    // 6. Disconnect Cleanup
    // -------------------------------------------------------------
    socket.on("disconnect", async () => {
        if (isMatchmakingRedisEnabled()) {
            try {
                await dequeueUserRedis({ socketId: socket.id, userId: socket.userId ? socket.userId.toString() : "" });
                const callId = await getCallIdForSocketRedis(socket.id);
                if (callId) {
                    await endCallSessionRedis({ callId, initiatorSocketId: socket.id, reason: "partner_disconnected", io });
                }
            } catch (_) {}
        } else {
            // 1. Remove this specific socket from matchmaking queue if present
            removeFromQueue(socket.id);

            // 2. Terminate active call if this socket was a participant
            const callId = socketToCall.get(socket.id);
            if (callId) {
                endActiveCall(callId, socket.id, "partner_disconnected", io);
            }
        }

        // 3. Clear rate limits for this socket
        clearSocketRateLimits(socket.id);
    });
}

/**
 * Safely terminate any active call between two users (e.g. upon block/report)
 */
export function endActiveCallBetweenUsers(userIdA, userIdB, io) {
    if (isMatchmakingRedisEnabled()) {
        return endActiveCallBetweenUsersRedis(userIdA, userIdB, io);
    }
    if (!userIdA || !userIdB) return null;
    const userAStr = userIdA.toString();
    const userBStr = userIdB.toString();
    const callId = userToCall.get(userAStr) || userToCall.get(userBStr);
    if (!callId) return null;

    const call = activeCalls.get(callId);
    if (!call) return null;

    const hasA = call.peers.some((p) => p.userId === userAStr);
    const hasB = call.peers.some((p) => p.userId === userBStr);
    if (hasA && hasB) {
        return endActiveCall(callId, null, "ended_by_partner", io);
    }
    return null;
}

// For unit testing inspection
export const _testing = {
    getQueue: () => [...matchmakingQueue],
    getActiveCalls: () => new Map(activeCalls),
    getSocketToCall: () => new Map(socketToCall),
    getUserToCall: () => new Map(userToCall),
    getCallState: (callId) => activeCalls.get(callId)?.state,
    setActiveCall: (callId, callData) => {
        const user1 = callData.user1 || (callData.peers && callData.peers[0]) || { userId: "user1", socketId: "sock1" };
        const user2 = callData.user2 || (callData.peers && callData.peers[1]) || { userId: "user2", socketId: "sock2" };
        const consentedUsers = new Set(callData.consentedUsers || [user1.userId, user2.userId]);
        const mediaReadyUsers = new Set(callData.mediaReadyUsers || [user1.userId, user2.userId]);
        activeCalls.set(callId, {
            callId,
            state: callData.state || "media_ready",
            peers: [
                { userId: user1.userId, socketId: user1.socketId, isInitiator: true },
                { userId: user2.userId, socketId: user2.socketId, isInitiator: false },
            ],
            consentedUsers,
            mediaReadyUsers,
            startedAt: callData.startedAt || new Date(),
        });
        userToCall.set(user1.userId, callId);
        userToCall.set(user2.userId, callId);
        socketToCall.set(user1.socketId, callId);
        socketToCall.set(user2.socketId, callId);
    },
    clearAll: () => {
        matchmakingQueue.length = 0;
        activeCalls.clear();
        socketToCall.clear();
        userToCall.clear();
    },
};
