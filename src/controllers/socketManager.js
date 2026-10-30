import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import crypto from "crypto";
import { User, evaluateAccountStatus } from "../models/user.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";
import { registerRandomCallHandlers, terminateUserRandomCallsAndQueues } from "./randomCallManager.js";
import { getJwtSecret } from "../config/jwt.js";
import { corsOptions } from "../config/cors.js";
import { toMessageDto, toPublicProfile } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import { calculateUserUnreadCount } from "./chat.controller.js";
import {
    recordCallInitiated,
    recordCallAccepted,
    recordCallEnded,
    getUnseenMissedCallsCount,
} from "./call.controller.js";
import {
    userConnected,
    userDisconnected,
    isUserOnline,
    canViewerSeeLastSeen,
    canViewerSeeOnline,
    getPresenceForViewer,
} from "../services/presence.service.js";
import { safeLean } from "../utils/queryHelper.js";
import {
    isPlainObject,
    isValidObjectId,
    sanitizeString,
    checkSocketRateLimit,
    clearSocketRateLimits,
} from "../utils/socketValidator.js";

let ioInstance = null;

// In-memory active direct 1-on-1 call sessions
const activeDirectCalls = new Map(); // callId -> { callId, callerId, calleeId, status, callerSocketId, calleeSocketId, conversationId, createdAt, timeoutHandle }
const userToDirectCall = new Map();  // userId -> callId

export const _resetInMemoryDirectCalls = () => {
    for (const call of activeDirectCalls.values()) {
        if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
    }
    activeDirectCalls.clear();
    userToDirectCall.clear();
};

/**
 * Cleanly terminates any active direct 1-on-1 call for a specific user
 * (e.g. upon ban, suspension, or manual termination).
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {string} [reason="moderation_action"]
 * @returns {object|null} Terminated call object
 */
export const terminateUserActiveDirectCalls = (userId, reason = "moderation_action") => {
    if (!userId) return null;
    const userIdStr = userId.toString();
    const callId = userToDirectCall.get(userIdStr);
    if (!callId) return null;

    const call = activeDirectCalls.get(callId);
    if (!call) {
        userToDirectCall.delete(userIdStr);
        return null;
    }

    if (call.timeoutHandle) clearTimeout(call.timeoutHandle);

    recordCallEnded({ callId, endReason: reason, io: ioInstance }).catch((err) =>
        console.warn("Error finalizing call on termination:", err?.message)
    );

    const partnerId = call.callerId === userIdStr ? call.calleeId : call.callerId;
    if (ioInstance && partnerId) {
        ioInstance.to(`user:${partnerId}`).emit("direct_call:ended", {
            callId,
            reason,
        });
    }

    userToDirectCall.delete(call.callerId);
    userToDirectCall.delete(call.calleeId);
    activeDirectCalls.delete(callId);
    return call;
};

/**
 * Revokes all active sessions, calls, queues, and connected sockets for a moderated user.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {string} [status="banned"]
 * @param {string} [reason="Policy violation"]
 */
export const revokeUserSessions = async (userId, status = "banned", reason = "Policy violation") => {
    if (!userId) return;
    const userIdStr = userId.toString();

    // 1. Terminate random matchmaking calls & remove from queues
    try {
        await terminateUserRandomCallsAndQueues(userIdStr, ioInstance);
    } catch (err) {
        console.warn("Failed to terminate random calls during session revocation:", err?.message);
    }

    // 2. Terminate any active direct 1-on-1 call
    try {
        terminateUserActiveDirectCalls(userIdStr, "moderation_action");
    } catch (err) {
        console.warn("Failed to terminate direct call during session revocation:", err?.message);
    }

    // 3. Forcefully disconnect all active sockets for this user
    if (ioInstance) {
        try {
            const sockets = await ioInstance.in(`user:${userIdStr}`).fetchSockets();
            for (const sock of sockets) {
                sock.emit("account:moderated", {
                    status,
                    reason,
                });
                sock.disconnect(true);
            }
        } catch (err) {
            console.warn("Error disconnecting sockets during revocation:", err?.message);
        }
    }

    // 4. Mark offline in presence service
    try {
        await userDisconnected(userIdStr, null);
        if (ioInstance) {
            await broadcastPresenceUpdate(ioInstance, userIdStr, false);
        }
    } catch (err) {
        console.warn("Error updating presence during revocation:", err?.message);
    }
};


export const broadcastPresenceUpdate = async (io, userId, isOnline, lastSeenAt = null) => {
    if (!io || !userId) return;
    if (mongoose.connection?.readyState !== 1) return;
    try {
        const user = await User.findById(userId).select("privacySettings lastSeenAt");
        if (!user) return;

        const effectiveLastSeen = lastSeenAt || user.lastSeenAt || null;

        const matches = await Match.find({ users: userId, status: "active" })
            .populate({ path: "users", select: "privacySettings lastSeenAt" });

        for (const match of matches) {
            const partner = match.users.find((u) => u && u._id.toString() !== userId.toString());
            if (partner) {
                const partnerId = partner._id.toString();
                const canSeeOnline = isOnline && canViewerSeeOnline(user, partner, true);
                const canSeeLastSeen = canViewerSeeLastSeen(user, partner, true);

                io.to(`user:${partnerId}`).emit("presence:update", {
                    userId: userId.toString(),
                    isOnline: Boolean(canSeeOnline),
                    lastSeenAt: canSeeLastSeen ? effectiveLastSeen : null,
                });
            }
        }
    } catch (err) {
        console.error("broadcastPresenceUpdate error:", err);
    }
};

export const getIO = () => ioInstance;

export const connectToSocket = (server) => {
    const io = new Server(server, {
        cors: corsOptions,
    });

    // Handshake middleware for JWT authentication
    io.use(async (socket, next) => {
        let token = socket.handshake.auth?.token;
        if (!token && socket.handshake.headers?.authorization) {
            const parts = socket.handshake.headers.authorization.split(" ");
            if (parts.length === 2 && parts[0] === "Bearer") {
                token = parts[1];
            }
        }

        if (!token) {
            return next(new Error("Authentication error: Token required"));
        }

        try {
            const decoded = jwt.verify(token, getJwtSecret());
            if (!decoded || !decoded.id) {
                return next(new Error("Authentication error: Invalid token payload"));
            }

            // Enforce account moderation status if real database is connected or User.findById is stubbed
            const isRealDbConnected = Boolean(mongoose.connection?.readyState === 1 && mongoose.connection?.db);
            const isModelStubbed = Boolean(User.findById && User.findById !== mongoose.Model.findById);

            if (isRealDbConnected || isModelStubbed) {
                const userQuery = User.findById(decoded.id);
                const user = typeof userQuery?.select === "function"
                    ? await userQuery.select("status suspensionExpiresAt suspensionReason bannedAt banReason")
                    : await userQuery;

                if (user) {
                    const accountStatus = evaluateAccountStatus(user);
                    if (!accountStatus.allowed) {
                        return next(new Error(`Authentication error: Account ${accountStatus.status}`));
                    }
                    if (accountStatus.wasExpired) {
                        user.status = "active";
                        user.suspensionExpiresAt = null;
                        user.suspensionReason = null;
                        if (typeof user.save === "function") {
                            user.save().catch((saveErr) => console.warn("Failed to auto-reinstate socket user:", saveErr?.message));
                        }
                    }
                }
            }

            socket.userId = decoded.id.toString();
            socket.username = decoded.username || null;
            next();
        } catch (err) {
            if (err.message && err.message.startsWith("Authentication error:")) {
                return next(err);
            }
            return next(new Error("Authentication error: Invalid or expired token"));
        }
    });

    ioInstance = io;

    io.on("connection", async (socket) => {
        // Automatically join authenticated user room for real-time delivery and match notifications
        if (socket.userId) {
            socket.join(`user:${socket.userId.toString()}`);
            const wasOffline = await userConnected(socket.userId, socket.id);
            if (wasOffline) {
                broadcastPresenceUpdate(io, socket.userId, true).catch((err) => {
                    console.error("Error broadcasting online presence:", err);
                });
            }
        }

        // ==========================================
        // 1. RANDOM 1-TO-1 VIDEO MATCHMAKING EVENTS
        // ==========================================
        registerRandomCallHandlers(io, socket);

        // ==========================================
        // Event: Query presence of a specific user or match partner
        socket.on("presence:get", async (data, ack) => {
            if (!socket.userId) {
                if (typeof ack === "function") ack({ success: false, message: "Authentication required" });
                return;
            }
            const { targetUserId } = data || {};
            if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
                if (typeof ack === "function") ack({ success: false, message: "Valid targetUserId required" });
                return;
            }

            try {
                const [targetUser, viewerUser] = await Promise.all([
                    User.findById(targetUserId).select("privacySettings lastSeenAt"),
                    User.findById(socket.userId).select("privacySettings"),
                ]);

                if (!targetUser) {
                    if (typeof ack === "function") ack({ success: false, message: "User not found" });
                    return;
                }

                const isMatch = await Match.exists({
                    users: { $all: [socket.userId, targetUserId] },
                    status: "active",
                });

                const presence = await getPresenceForViewer(targetUser, viewerUser, Boolean(isMatch));
                if (typeof ack === "function") {
                    ack({ success: true, userId: targetUserId, ...presence });
                }
            } catch (e) {
                console.error("presence:get error:", e);
                if (typeof ack === "function") ack({ success: false, message: "Failed to get presence" });
            }
        });

        // 2. MATCH-BASED PRIVATE CHAT EVENTS
        // ==========================================

        // Event: Join a private match conversation room
        socket.on("chat:join", async (data, ack) => {
            if (!socket.userId) {
                const err = { message: "Authentication required to join private chat" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!isPlainObject(data)) {
                const err = { message: "Invalid payload format: plain object expected" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!(await checkSocketRateLimit(`${socket.id}:chat:join`, 10, 2000))) {
                const err = { message: "Join room rate limit exceeded. Please wait a moment." };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { conversationId } = data;

            if (!isValidObjectId(conversationId)) {
                const err = { message: "Invalid conversation ID" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            try {
                // Authoritative eligibility check
                const callerUser = await User.findById(socket.userId).select("name dob gender bio photos interests isProfileComplete");
                const eligibility = checkUserEligibility(callerUser);
                if (!eligibility.isEligible) {
                    const err = {
                        code: eligibility.code,
                        message: eligibility.reason || "Complete your profile and confirm age to join chat",
                        missingFields: eligibility.missingFields,
                    };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                const conversation = await Conversation.findById(conversationId);
                if (!conversation) {
                    const err = { message: "Conversation not found" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                const isParticipant = conversation.participants.some(
                    (p) => p.toString() === socket.userId.toString()
                );

                if (!isParticipant) {
                    const err = { message: "You are not authorized to join this conversation" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Verify neither participant has blocked the other
                const otherParticipantId = conversation.participants.find(
                    (p) => p.toString() !== socket.userId.toString()
                );
                if (otherParticipantId) {
                    const isBlocked = await Block.isBlockedBidirectional(socket.userId, otherParticipantId);
                    if (isBlocked) {
                        const err = { code: "BLOCKED_USER", message: "You cannot access this conversation" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                // Verify match status if conversation is linked to a match
                if (conversation.match && mongoose.connection.readyState !== 0) {
                    const match = await Match.findById(conversation.match).select("status");
                    if (match && match.status === "unmatched") {
                        const err = { code: "MATCH_UNMATCHED", message: "This match has been unmatched" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                    if (match && match.status !== "active") {
                        const err = { code: "MATCH_NOT_ACTIVE", message: "An active accepted connection is required for private chat" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                // Authorize socket to join the isolated conversation room
                const roomName = `conversation:${conversationId}`;
                socket.join(roomName);

                socket.emit("chat:joined", { conversationId });
                if (typeof ack === "function") ack({ success: true, conversationId });
            } catch (e) {
                console.error("Socket chat:join error:", e);
                const err = { message: "Failed to join conversation room" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        // Event: Send a message in a private conversation
        socket.on("chat:send", async (data, ack) => {
            if (!socket.userId) {
                const err = { message: "Authentication required to send messages" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!isPlainObject(data)) {
                const err = { message: "Invalid payload format: plain object expected" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!(await checkSocketRateLimit(`${socket.id}:chat:send`, 10, 2000))) {
                const err = { message: "Message rate limit exceeded. Please slow down." };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { conversationId, content, clientTempId } = data;

            if (!isValidObjectId(conversationId)) {
                const err = { message: "Invalid conversation ID" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const trimmedContent = sanitizeString(content, 1, 2000);
            if (!trimmedContent) {
                const err = { message: "Message content cannot be empty or exceed 2000 characters" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            let sanitizedTempId = undefined;
            if (clientTempId !== undefined && clientTempId !== null) {
                if (typeof clientTempId !== "string" || clientTempId.length > 100) {
                    const err = { message: "Invalid clientTempId format" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }
                sanitizedTempId = clientTempId.trim() || undefined;
            }

            try {
                const sendStart = Date.now();

                // Stage 1: Parallelize caller profile and conversation lookups
                const [callerUser, conversation] = await Promise.all([
                    safeLean(User.findById(socket.userId).select("name dob gender bio photos interests isProfileComplete")),
                    Conversation.findById(conversationId),
                ]);

                if (!callerUser) {
                    const err = { message: "Authenticated user record not found" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Authoritative caller eligibility check
                const eligibility = checkUserEligibility(callerUser);
                if (!eligibility.isEligible) {
                    const err = {
                        code: eligibility.code,
                        message: eligibility.reason || "Complete your profile and confirm age to send messages",
                        missingFields: eligibility.missingFields,
                    };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                if (!conversation) {
                    const err = { message: "Conversation not found" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                const isParticipant = conversation.participants.some(
                    (p) => p.toString() === socket.userId.toString()
                );

                if (!isParticipant) {
                    const err = { message: "You are not authorized to send messages in this conversation" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                const otherParticipantId = conversation.participants.find(
                    (p) => p.toString() !== socket.userId.toString()
                );

                // Stage 2: Parallelize block check, match status, and duplicate lookup to collapse 3 round-trips into 1
                const [isBlocked, match, existing] = await Promise.all([
                    otherParticipantId ? Block.isBlockedBidirectional(socket.userId, otherParticipantId) : Promise.resolve(false),
                    conversation.match && mongoose.connection.readyState !== 0
                        ? safeLean(Match.findById(conversation.match).select("status"))
                        : Promise.resolve(null),
                    sanitizedTempId
                        ? Message.findOne({
                              conversation: conversationId,
                              sender: socket.userId,
                              clientTempId: sanitizedTempId,
                          }).populate({ path: "sender", select: "name photos" })
                        : Promise.resolve(null),
                ]);

                if (isBlocked) {
                    const err = { code: "BLOCKED_USER", message: "You cannot message this user" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                if (match) {
                    if (match.status === "unmatched") {
                        const err = { code: "MATCH_UNMATCHED", message: "This match has been unmatched" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                    if (match.status !== "active") {
                        const err = { code: "MATCH_NOT_ACTIVE", message: "An active accepted connection is required for private chat" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                if (existing) {
                    if (typeof ack === "function") ack({ success: true, message: toMessageDto(existing), duplicate: true });
                    return;
                }

                // Persist new message: sender identity is derived STRICTLY from verified socket.userId
                const persistStart = Date.now();
                const newMsg = new Message({
                    conversation: conversationId,
                    sender: socket.userId,
                    content: trimmedContent,
                    clientTempId: sanitizedTempId,
                    readBy: [socket.userId],
                });

                await newMsg.save();

                // Update conversation's last message tracking
                conversation.lastMessage = newMsg._id;
                conversation.lastMessageAt = newMsg.createdAt;
                await conversation.save();

                // Attach caller profile without an extra round-trip to database
                newMsg.sender = {
                    _id: callerUser._id,
                    name: callerUser.name,
                    photos: callerUser.photos,
                };
                const messageDto = toMessageDto(newMsg);
                if (!messageDto.sender || !messageDto.sender._id || messageDto.sender.name === "Engaze Member") {
                    messageDto.sender = {
                        _id: callerUser._id ? callerUser._id.toString() : socket.userId.toString(),
                        name: callerUser.name || "Engaze Member",
                        photos: Array.isArray(callerUser.photos) ? callerUser.photos : [],
                    };
                }
                const persistMs = Date.now() - persistStart;

                // Stage 4: Non-sensitive diagnostic timing metric
                const totalDurationMs = Date.now() - sendStart;
                if (process.env.NODE_ENV !== "test") {
                    console.log(`[ChatLatency] conv=${conversationId} persistMs=${persistMs} totalMs=${totalDurationMs}`);
                }

                // Broadcast to conversation room AND all participant user rooms (deduplicated by socket.io)
                const roomName = `conversation:${conversationId}`;
                let broadcast = io.to(roomName);
                if (Array.isArray(conversation.participants)) {
                    for (const p of conversation.participants) {
                        broadcast = broadcast.to(`user:${p.toString()}`);
                    }
                }
                broadcast.emit("chat:new-message", messageDto);

                // Push real-time unread count notification to recipient user room
                if (otherParticipantId) {
                    calculateUserUnreadCount(otherParticipantId)
                        .then((counts) => {
                            io.to(`user:${otherParticipantId.toString()}`).emit("chat:unread-count", {
                                unreadCount: counts.totalUnreadCount,
                                unreadConversationsCount: counts.unreadConversationsCount,
                                conversationsUnread: counts.conversationsUnread,
                            });
                        })
                        .catch(() => {});
                }

                if (typeof ack === "function") {
                    ack({ success: true, message: messageDto, serverLatencyMs: totalDurationMs });
                }
            } catch (e) {
                // Handle idempotency race condition gracefully
                if (e.code === 11000 && sanitizedTempId) {
                    let existingQuery = Message.findOne({
                        conversation: conversationId,
                        sender: socket.userId,
                        clientTempId: sanitizedTempId,
                    }).populate({ path: "sender", select: "name photos" });
                    if (typeof existingQuery.lean === "function") existingQuery = existingQuery.lean();
                    const existing = await existingQuery;

                    if (existing && typeof ack === "function") {
                        return ack({ success: true, message: toMessageDto(existing), duplicate: true });
                    }
                }

                console.error("Socket chat:send error:", e);
                const err = { message: "Failed to persist and send message" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        // Event: Mark conversation as read in real-time
        socket.on("chat:read", async (data, ack) => {
            if (!socket.userId) {
                const err = { message: "Authentication required" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!isPlainObject(data)) {
                const err = { message: "Invalid payload format: plain object expected" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!(await checkSocketRateLimit(`${socket.id}:chat:read`, 15, 2000))) {
                const err = { message: "Read receipt rate limit exceeded" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { conversationId } = data;
            if (!isValidObjectId(conversationId)) {
                const err = { message: "Invalid conversation ID" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            try {
                const conversation = await Conversation.findById(conversationId);
                if (!conversation) {
                    const err = { message: "Conversation not found" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                const isParticipant = conversation.participants.some(
                    (p) => p.toString() === socket.userId.toString()
                );
                if (!isParticipant) {
                    const err = { message: "You are not authorized to access this conversation" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Verify neither participant has blocked the other
                const otherParticipantId = conversation.participants.find(
                    (p) => p.toString() !== socket.userId.toString()
                );
                if (otherParticipantId) {
                    const isBlocked = await Block.isBlockedBidirectional(socket.userId, otherParticipantId);
                    if (isBlocked) {
                        const err = { code: "BLOCKED_USER", message: "Action not permitted" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                if (conversation.match && mongoose.connection.readyState !== 0) {
                    const match = await Match.findById(conversation.match).select("status");
                    if (match && match.status === "unmatched") {
                        const err = { code: "MATCH_UNMATCHED", message: "This match has been unmatched" };
                        socket.emit("chat:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                // Security: Updates strictly apply to the authenticated socket user's read state
                // Reader identity cannot be spoofed to alter another participant's read status
                const updateRes = await Message.updateMany(
                    {
                        conversation: conversationId,
                        sender: { $ne: socket.userId },
                        readBy: { $ne: socket.userId },
                    },
                    {
                        $addToSet: { readBy: socket.userId },
                    }
                );

                const roomName = `conversation:${conversationId}`;
                let broadcast = socket.to(roomName);
                if (Array.isArray(conversation.participants)) {
                    for (const p of conversation.participants) {
                        if (p.toString() !== socket.userId.toString()) {
                            broadcast = broadcast.to(`user:${p.toString()}`);
                        }
                    }
                }
                broadcast.emit("chat:read", {
                    conversationId,
                    readerId: socket.userId,
                });
                // Push real-time unread count to reader user room
                calculateUserUnreadCount(socket.userId)
                    .then((counts) => {
                        io.to(`user:${socket.userId.toString()}`).emit("chat:unread-count", {
                            unreadCount: counts.totalUnreadCount,
                            unreadConversationsCount: counts.unreadConversationsCount,
                            conversationsUnread: counts.conversationsUnread,
                        });
                    })
                    .catch(() => {});

                if (typeof ack === "function") {
                    ack({ success: true, conversationId, readerId: socket.userId, modifiedCount: updateRes.modifiedCount });
                }
            } catch (e) {
                console.error("Socket chat:read error:", e);
                const err = { message: "Failed to mark messages as read" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        // Event: Ephemeral Typing Indicator
        socket.on("chat:typing", async (data, ack) => {
            if (!socket.userId) {
                const err = { message: "Authentication required" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!isPlainObject(data)) {
                const err = { message: "Invalid payload format: plain object expected" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            // Throttle typing indicator emissions: max 10 per 2 seconds
            if (!(await checkSocketRateLimit(`${socket.id}:chat:typing`, 10, 2000))) {
                if (typeof ack === "function") ack({ success: false, rateLimited: true });
                return;
            }

            const { conversationId, isTyping } = data;
            if (!isValidObjectId(conversationId)) {
                const err = { message: "Invalid conversation ID" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            try {
                const conversation = await Conversation.findById(conversationId);
                if (!conversation) {
                    const err = { message: "Conversation not found" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                const isParticipant = conversation.participants.some(
                    (p) => p.toString() === socket.userId.toString()
                );
                if (!isParticipant) {
                    const err = { message: "You are not authorized to emit typing in this conversation" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Verify neither participant has blocked the other
                const otherParticipantId = conversation.participants.find(
                    (p) => p.toString() !== socket.userId.toString()
                );
                if (otherParticipantId) {
                    const isBlocked = await Block.isBlockedBidirectional(socket.userId, otherParticipantId);
                    if (isBlocked) {
                        if (typeof ack === "function") ack({ success: false, code: "BLOCKED_USER" });
                        return;
                    }
                }

                if (conversation.match && mongoose.connection.readyState !== 0) {
                    const match = await Match.findById(conversation.match).select("status");
                    if (match && match.status === "unmatched") {
                        if (typeof ack === "function") ack({ success: false, code: "MATCH_UNMATCHED" });
                        return;
                    }
                }

                const typingState = Boolean(isTyping !== undefined ? isTyping : true);

                // Ephemeral notification: delivered strictly to other participants without echoing back to sender
                const roomName = `conversation:${conversationId}`;
                let broadcast = socket.to(roomName);
                if (Array.isArray(conversation.participants)) {
                    for (const p of conversation.participants) {
                        if (p.toString() !== socket.userId.toString()) {
                            broadcast = broadcast.to(`user:${p.toString()}`);
                        }
                    }
                }
                broadcast.emit("chat:typing", {
                    conversationId,
                    userId: socket.userId,
                    isTyping: typingState,
                });

                if (typeof ack === "function") {
                    ack({ success: true, conversationId, isTyping: typingState });
                }
            } catch (e) {
                console.error("Socket chat:typing error:", e);
                const err = { message: "Failed to broadcast typing state" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        // ==========================================
        // 3. 1-ON-1 DIRECT VIDEO CALLING (MUTUAL ACTIVE MATCHES ONLY)
        // ==========================================
        socket.on("call:initiate", async (data, ack) => {
            if (!socket.userId) {
                const err = { code: "AUTH_REQUIRED", message: "Authentication required to initiate calls" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!isPlainObject(data)) {
                const err = { code: "INVALID_PAYLOAD", message: "Invalid payload format" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { targetUserId, conversationId } = data;
            let calleeId = targetUserId;

            if (!calleeId && conversationId && isValidObjectId(conversationId)) {
                const conv = await Conversation.findById(conversationId);
                if (conv && Array.isArray(conv.participants)) {
                    calleeId = conv.participants.find((p) => p.toString() !== socket.userId.toString())?.toString();
                }
            }

            if (!calleeId || !isValidObjectId(calleeId)) {
                const err = { code: "INVALID_TARGET", message: "Valid target user ID required" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (calleeId === socket.userId) {
                const err = { code: "SELF_CALL_PROHIBITED", message: "Cannot call yourself" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            try {
                // Authoritative caller eligibility check
                const callerUser = await User.findById(socket.userId).select("name dob gender bio photos interests isProfileComplete");
                const callerElig = checkUserEligibility(callerUser);
                if (!callerElig.isEligible) {
                    const err = { code: callerElig.code, message: callerElig.reason };
                    socket.emit("call:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Verify bidirectional block
                const isBlocked = await Block.isBlockedBidirectional(socket.userId, calleeId);
                if (isBlocked) {
                    const err = { code: "BLOCKED_USER", message: "Call not permitted." };
                    socket.emit("call:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Strict Connection Gate: Verify active accepted connection exists
                const userPair = Match.getCanonicalPair(socket.userId, calleeId);
                const activeMatch = await Match.findOne({ userPair, status: "active" });

                if (!activeMatch) {
                    const err = {
                        code: "CALL_UNAUTHORIZED",
                        message: "Video calling is only allowed between users with an active connection.",
                    };
                    socket.emit("call:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Busy Check: Is the recipient already in another direct call session?
                if (userToDirectCall.has(calleeId)) {
                    const existingCallId = userToDirectCall.get(calleeId);
                    const existingCall = activeDirectCalls.get(existingCallId);
                    if (existingCall && (existingCall.status === "ringing" || existingCall.status === "connected")) {
                        const err = { code: "USER_BUSY", message: "User is currently busy on another call." };
                        socket.emit("call:busy", { targetUserId: calleeId, reason: "busy" });
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                // Clean up previous caller session if any was left hanging
                if (userToDirectCall.has(socket.userId)) {
                    const prevCallId = userToDirectCall.get(socket.userId);
                    const prevCall = activeDirectCalls.get(prevCallId);
                    if (prevCall) {
                        if (prevCall.timeoutHandle) clearTimeout(prevCall.timeoutHandle);
                        activeDirectCalls.delete(prevCallId);
                        userToDirectCall.delete(prevCall.callerId);
                        userToDirectCall.delete(prevCall.calleeId);
                        recordCallEnded({ callId: prevCallId, endReason: "cancelled", io }).catch(() => {});
                    }
                }

                const callId = `call_${crypto.randomUUID()}`;
                const roomName = `direct-call:${callId}`;
                socket.join(roomName);

                // Determine whether callee is actually online and connected to be alerted
                const calleeSockets = await io.in(`user:${calleeId}`).fetchSockets();
                const receiverAlerted = calleeSockets.length > 0;
                const callType = data?.callType === "audio" ? "audio" : "video";

                // Persist call initiation in MongoDB
                await recordCallInitiated({
                    callId,
                    callerId: socket.userId,
                    calleeId,
                    conversationId,
                    callType,
                    receiverAlerted,
                });

                // Set 35s ringing timeout
                const timeoutHandle = setTimeout(async () => {
                    const call = activeDirectCalls.get(callId);
                    if (call && call.status === "ringing") {
                        call.status = "ended";
                        activeDirectCalls.delete(callId);
                        userToDirectCall.delete(call.callerId);
                        userToDirectCall.delete(call.calleeId);

                        await recordCallEnded({ callId, endReason: "timeout", io });

                        io.to(`user:${call.callerId}`).emit("call:no-answer", { callId, reason: "timeout" });
                        io.to(`user:${call.calleeId}`).emit("call:ended", { callId, reason: "timeout" });
                    }
                }, 35000);

                const callSession = {
                    callId,
                    callerId: socket.userId,
                    calleeId: calleeId,
                    status: "ringing",
                    callerSocketId: socket.id,
                    calleeSocketId: null,
                    conversationId: conversationId || null,
                    callType,
                    receiverAlerted,
                    createdAt: Date.now(),
                    timeoutHandle,
                };

                activeDirectCalls.set(callId, callSession);
                userToDirectCall.set(socket.userId, callId);
                userToDirectCall.set(calleeId, callId);

                // Notify target recipient of incoming direct call
                io.to(`user:${calleeId}`).emit("call:incoming", {
                    callId,
                    caller: toPublicProfile(callerUser),
                    conversationId: conversationId || null,
                    callType,
                });

                if (typeof ack === "function") {
                    ack({ success: true, callId });
                }
            } catch (e) {
                console.error("Socket call:initiate error:", e);
                const err = { message: "Failed to initiate call" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        socket.on("call:accept", async (data, ack) => {
            if (!socket.userId) {
                const err = { code: "AUTH_REQUIRED", message: "Authentication required" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { callId } = data || {};
            const call = activeDirectCalls.get(callId);

            if (!call || call.status !== "ringing") {
                const err = { code: "CALL_NOT_FOUND", message: "Call session not found or already ended" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            // Strict check: Only intended callee can accept
            if (socket.userId.toString() !== call.calleeId.toString()) {
                const err = { code: "CALL_UNAUTHORIZED", message: "Not authorized to accept this call" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
            call.status = "connected";
            call.calleeSocketId = socket.id;

            // Persist acceptance in MongoDB
            await recordCallAccepted({ callId });

            const roomName = `direct-call:${callId}`;
            socket.join(roomName);

            // Notify caller that callee accepted
            io.to(`user:${call.callerId}`).emit("call:accepted", {
                callId,
                calleeId: socket.userId,
            });

            if (typeof ack === "function") {
                ack({ success: true, callId });
            }
        });

        socket.on("call:join", async (data, ack) => {
            if (!socket.userId) {
                const err = { code: "AUTH_REQUIRED", message: "Authentication required to join call" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { callId, targetUserId } = data || {};
            if (!callId || typeof callId !== "string") {
                const err = { code: "INVALID_CALL_ID", message: "Call ID required" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            try {
                // If call exists in active session map, verify participant membership
                const call = activeDirectCalls.get(callId);
                if (call) {
                    const isCaller = socket.userId.toString() === call.callerId.toString();
                    const isCallee = socket.userId.toString() === call.calleeId.toString();
                    if (!isCaller && !isCallee) {
                        const err = { code: "CALL_UNAUTHORIZED", message: "Unauthorized to join this call" };
                        socket.emit("call:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                if (targetUserId && isValidObjectId(targetUserId)) {
                    const userPair = Match.getCanonicalPair(socket.userId, targetUserId);
                    const activeMatch = await Match.findOne({ userPair, status: "active" });
                    if (!activeMatch) {
                        const err = {
                            code: "CALL_UNAUTHORIZED",
                            message: "Video calling is only allowed between users with an active connection.",
                        };
                        socket.emit("call:error", err);
                        if (typeof ack === "function") ack({ success: false, ...err });
                        return;
                    }
                }

                const roomName = `direct-call:${callId}`;
                socket.join(roomName);
                socket.to(roomName).emit("call:user-joined", { userId: socket.userId, callId });

                if (typeof ack === "function") {
                    ack({ success: true, callId });
                }
            } catch (e) {
                console.error("Socket call:join error:", e);
                const err = { message: "Failed to join call" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        socket.on("call:signal", async (data, ack) => {
            if (!socket.userId) {
                const err = { code: "AUTH_REQUIRED", message: "Authentication required" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const { callId, targetUserId, signal } = data || {};
            if (!targetUserId || !signal) {
                const err = { code: "INVALID_SIGNAL", message: "Target user ID and signal payload required" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            try {
                // Strict Connection Gate: Verify active connection before routing WebRTC signal
                const userPair = Match.getCanonicalPair(socket.userId, targetUserId);
                const activeMatch = await Match.findOne({ userPair, status: "active" });
                if (!activeMatch) {
                    const err = {
                        code: "CALL_UNAUTHORIZED",
                        message: "Signaling is only allowed between users with an active connection.",
                    };
                    socket.emit("call:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // If call session exists in memory, verify sender and receiver belong to this call
                if (callId) {
                    const call = activeDirectCalls.get(callId);
                    if (call) {
                        const isCaller = socket.userId.toString() === call.callerId.toString() && targetUserId.toString() === call.calleeId.toString();
                        const isCallee = socket.userId.toString() === call.calleeId.toString() && targetUserId.toString() === call.callerId.toString();
                        if (!isCaller && !isCallee) {
                            const err = { code: "CALL_UNAUTHORIZED", message: "Not authorized for this call session" };
                            socket.emit("call:error", err);
                            if (typeof ack === "function") ack({ success: false, ...err });
                            return;
                        }
                    }
                }

                io.to(`user:${targetUserId.toString()}`).emit("call:signal", {
                    callId,
                    senderId: socket.userId,
                    signal,
                });

                if (typeof ack === "function") {
                    ack({ success: true });
                }
            } catch (e) {
                console.error("Socket call:signal error:", e);
                const err = { message: "Failed to forward signal" };
                socket.emit("call:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        socket.on("call:end", async (data, ack) => {
            const { callId, targetUserId } = data || {};
            const activeId = callId || (socket.userId ? userToDirectCall.get(socket.userId) : null);
            if (activeId) {
                const call = activeDirectCalls.get(activeId);
                if (call) {
                    if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
                    activeDirectCalls.delete(activeId);
                    userToDirectCall.delete(call.callerId);
                    userToDirectCall.delete(call.calleeId);

                    await recordCallEnded({
                        callId: activeId,
                        endReason: "ended_by_partner",
                        endedByUserId: socket.userId,
                        io,
                    });

                    const partnerId = targetUserId || (socket.userId.toString() === call.callerId.toString() ? call.calleeId : call.callerId);
                    io.to(`user:${partnerId.toString()}`).emit("call:ended", { callId: activeId, reason: "ended_by_partner" });
                }
                socket.leave(`direct-call:${activeId}`);
            } else if (targetUserId) {
                io.to(`user:${targetUserId.toString()}`).emit("call:ended", { callId, reason: "ended_by_partner" });
            }
            if (typeof ack === "function") ack({ success: true });
        });

        socket.on("call:decline", async (data, ack) => {
            const { callId, targetUserId } = data || {};
            const activeId = callId || (socket.userId ? userToDirectCall.get(socket.userId) : null);
            if (activeId) {
                const call = activeDirectCalls.get(activeId);
                if (call) {
                    if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
                    activeDirectCalls.delete(activeId);
                    userToDirectCall.delete(call.callerId);
                    userToDirectCall.delete(call.calleeId);

                    await recordCallEnded({
                        callId: activeId,
                        endReason: "declined",
                        endedByUserId: socket.userId,
                        io,
                    });

                    const partnerId = targetUserId || (socket.userId.toString() === call.callerId.toString() ? call.calleeId : call.callerId);
                    io.to(`user:${partnerId.toString()}`).emit("call:declined", { callId: activeId, reason: "declined_by_partner" });
                }
                socket.leave(`direct-call:${activeId}`);
            } else if (targetUserId) {
                io.to(`user:${targetUserId.toString()}`).emit("call:declined", { callId, reason: "declined_by_partner" });
            }
            if (typeof ack === "function") ack({ success: true });
        });

        socket.on("disconnect", async () => {
            // Clean up rate limits on socket disconnect
            clearSocketRateLimits(socket.id);

            // Handle presence tracking with disconnect grace period
            if (socket.userId) {
                await userDisconnected(socket.userId, socket.id, async (lastSeenAt) => {
                    try {
                        await User.findByIdAndUpdate(socket.userId, { lastSeenAt });
                        await broadcastPresenceUpdate(io, socket.userId, false, lastSeenAt);
                    } catch (err) {
                        console.error("Error processing disconnect presence grace expiration:", err);
                    }
                });
            }

            // Clean up any direct call session in which this user was participating
            if (socket.userId && userToDirectCall.has(socket.userId)) {
                const directCallId = userToDirectCall.get(socket.userId);
                const call = activeDirectCalls.get(directCallId);
                if (call) {
                    if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
                    activeDirectCalls.delete(directCallId);
                    userToDirectCall.delete(call.callerId);
                    userToDirectCall.delete(call.calleeId);

                    await recordCallEnded({
                        callId: directCallId,
                        endReason: "partner_disconnected",
                        endedByUserId: socket.userId,
                        io,
                    });

                    const otherUserId = socket.userId.toString() === call.callerId.toString() ? call.calleeId : call.callerId;
                    io.to(`user:${otherUserId}`).emit("call:ended", { callId: directCallId, reason: "partner_disconnected" });
                }
            }
        });
    });

    return io;
};
