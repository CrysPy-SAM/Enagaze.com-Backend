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
            peers: [peerA, peerB],
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
        });

        // Notify current socket (Receiver)
        io.to(peerB.socketId).emit("random:matched", {
            callId,
            isInitiator: false,
            partner: peerA.userProfile,
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
        if (!checkSocketRateLimit(`${socket.id}:join-queue`, 5, 2000)) {
            const err = { message: "Queue join rate limit exceeded. Please wait a moment." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        const userIdStr = socket.userId.toString();

        // If user is currently in an active call, terminate it first
        if (socketToCall.has(socket.id) || userToCall.has(userIdStr)) {
            const currentCallId = socketToCall.get(socket.id) || userToCall.get(userIdStr);
            endActiveCall(currentCallId, socket.id, "started_new_search", io);
        }

        await matchOrQueueUser(io, socket, ack);
    });

    // -------------------------------------------------------------
    // 2. Cancel / Leave Matchmaking Queue
    // -------------------------------------------------------------
    socket.on("random:leave-queue", (data, ack) => {
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
        const removed = removeFromQueue(socket.id, userIdStr);

        socket.emit("random:queue-left", { success: true });
        if (typeof ack === "function") {
            ack({ success: true, wasQueued: removed });
        }
    });

    // -------------------------------------------------------------
    // 3. WebRTC Signaling (Offer, Answer, ICE Candidates)
    // -------------------------------------------------------------
    socket.on("random:signal", async (data, ack) => {
        if (!socket.userId) {
            const err = { message: "Authentication required for signaling" };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
            return;
        }

        // Throttle high-frequency signaling: max 60 signals per 2 seconds per socket
        if (!checkSocketRateLimit(`${socket.id}:signal`, 60, 2000)) {
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
    socket.on("random:end-call", (data, ack) => {
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
        if (!checkSocketRateLimit(`${socket.id}:next`, 5, 2000)) {
            const err = { message: "Next match rate limit exceeded. Please slow down." };
            socket.emit("random:error", err);
            if (typeof ack === "function") ack({ success: false, ...err });
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
    socket.on("disconnect", () => {
        // 1. Remove this specific socket from matchmaking queue if present
        removeFromQueue(socket.id);

        // 2. Terminate active call if this socket was a participant
        const callId = socketToCall.get(socket.id);
        if (callId) {
            endActiveCall(callId, socket.id, "partner_disconnected", io);
        }

        // 3. Clear rate limits for this socket
        clearSocketRateLimits(socket.id);
    });
}

/**
 * Safely terminate any active call between two users (e.g. upon block/report)
 */
export function endActiveCallBetweenUsers(userIdA, userIdB, io) {
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
    setActiveCall: (callId, callData) => {
        activeCalls.set(callId, {
            callId,
            peers: [
                { userId: callData.user1.userId, socketId: callData.user1.socketId },
                { userId: callData.user2.userId, socketId: callData.user2.socketId },
            ],
            createdAt: callData.startedAt || new Date(),
        });
        userToCall.set(callData.user1.userId, callId);
        userToCall.set(callData.user2.userId, callId);
        socketToCall.set(callData.user1.socketId, callId);
        socketToCall.set(callData.user2.socketId, callId);
    },
    clearAll: () => {
        matchmakingQueue.length = 0;
        activeCalls.clear();
        socketToCall.clear();
        userToCall.clear();
    },
};
