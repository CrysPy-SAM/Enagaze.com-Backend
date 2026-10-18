import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";
import { registerRandomCallHandlers } from "./randomCallManager.js";
import { getJwtSecret } from "../config/jwt.js";
import { corsOptions } from "../config/cors.js";
import { toMessageDto } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import {
    isPlainObject,
    isValidObjectId,
    sanitizeString,
    checkSocketRateLimit,
    clearSocketRateLimits,
} from "../utils/socketValidator.js";

let ioInstance = null;

export const getIO = () => ioInstance;

export const connectToSocket = (server) => {
    const io = new Server(server, {
        cors: corsOptions,
    });

    // Handshake middleware for JWT authentication
    io.use((socket, next) => {
        let token = socket.handshake.auth?.token;
        if (!token && socket.handshake.headers?.authorization) {
            const parts = socket.handshake.headers.authorization.split(" ");
            if (parts.length === 2 && parts[0] === "Bearer") {
                token = parts[1];
            }
        }
        if (!token && socket.handshake.query?.token) {
            token = socket.handshake.query.token;
        }

        if (!token) {
            return next(new Error("Authentication error: Token required"));
        }

        try {
            const decoded = jwt.verify(token, getJwtSecret());
            if (!decoded || !decoded.id) {
                return next(new Error("Authentication error: Invalid token payload"));
            }
            socket.userId = decoded.id.toString();
            socket.username = decoded.username || null;
            next();
        } catch (err) {
            return next(new Error("Authentication error: Invalid or expired token"));
        }
    });

    ioInstance = io;

    io.on("connection", (socket) => {
        // Automatically join authenticated user room for real-time delivery and match notifications
        if (socket.userId) {
            socket.join(`user:${socket.userId.toString()}`);
        }

        // ==========================================
        // 1. RANDOM 1-TO-1 VIDEO MATCHMAKING EVENTS
        // ==========================================
        registerRandomCallHandlers(io, socket);

        // ==========================================
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

            if (!checkSocketRateLimit(`${socket.id}:chat:join`, 10, 2000)) {
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

            if (!checkSocketRateLimit(`${socket.id}:chat:send`, 10, 2000)) {
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
                // Authoritative caller eligibility check
                const callerUser = await User.findById(socket.userId).select("name dob gender bio photos interests isProfileComplete");
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
                    const err = { message: "You are not authorized to send messages in this conversation" };
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
                        const err = { code: "BLOCKED_USER", message: "You cannot message this user" };
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
                }

                // Check for duplicate retry using sanitizedTempId scoped to sender
                if (sanitizedTempId) {
                    const existing = await Message.findOne({
                        conversation: conversationId,
                        sender: socket.userId,
                        clientTempId: sanitizedTempId,
                    }).populate({ path: "sender", select: "name photos" });

                    if (existing) {
                        if (typeof ack === "function") ack({ success: true, message: toMessageDto(existing), duplicate: true });
                        return;
                    }
                }

                // Persist new message: sender identity is derived STRICTLY from verified socket.userId
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

                await newMsg.populate({ path: "sender", select: "name photos" });
                const messageDto = toMessageDto(newMsg);

                // Broadcast to conversation room AND all participant user rooms (deduplicated by socket.io)
                const roomName = `conversation:${conversationId}`;
                let broadcast = io.to(roomName);
                if (Array.isArray(conversation.participants)) {
                    for (const p of conversation.participants) {
                        broadcast = broadcast.to(`user:${p.toString()}`);
                    }
                }
                broadcast.emit("chat:new-message", messageDto);

                if (typeof ack === "function") {
                    ack({ success: true, message: messageDto });
                }
            } catch (e) {
                // Handle idempotency race condition gracefully
                if (e.code === 11000 && sanitizedTempId) {
                    const existing = await Message.findOne({
                        conversation: conversationId,
                        sender: socket.userId,
                        clientTempId: sanitizedTempId,
                    }).populate({ path: "sender", select: "name photos" });

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

            if (!checkSocketRateLimit(`${socket.id}:chat:read`, 15, 2000)) {
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
            if (!checkSocketRateLimit(`${socket.id}:chat:typing`, 10, 2000)) {
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

        socket.on("disconnect", () => {
            // Clean up rate limits on socket disconnect
            clearSocketRateLimits(socket.id);
        });
    });

    return io;
};
