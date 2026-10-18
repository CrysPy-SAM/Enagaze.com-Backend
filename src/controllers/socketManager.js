import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { registerRandomCallHandlers } from "./randomCallManager.js";
import { getJwtSecret } from "../config/jwt.js";
import { corsOptions } from "../config/cors.js";
import { toMessageDto } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import {
    isPlainObject,
    isValidObjectId,
    sanitizeString,
    isValidSignalPayload,
    checkSocketRateLimit,
    clearSocketRateLimits,
} from "../utils/socketValidator.js";

let connections = {};
let messages = {};
let timeOnline = {};
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

                // Check for duplicate retry using sanitizedTempId
                if (sanitizedTempId) {
                    const existing = await Message.findOne({
                        conversation: conversationId,
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
        // 3. EXISTING WEBRTC SIGNALING (LEGACY)
        // ==========================================
        socket.on("join-call", (path) => {
            if (!socket.userId) return;
            if (typeof path !== "string" || !path.trim() || path.length > 256) return;
            if (!checkSocketRateLimit(`${socket.id}:legacy:join-call`, 10, 2000)) return;

            if (connections[path] === undefined) {
                connections[path] = [];
            }
            connections[path].push(socket.id);

            timeOnline[socket.id] = new Date();

            for (let a = 0; a < connections[path].length; a++) {
                io.to(connections[path][a]).emit("user-joined", socket.id, connections[path]);
            }

            if (messages[path] !== undefined) {
                for (let a = 0; a < messages[path].length; ++a) {
                    io.to(socket.id).emit(
                        "chat-message",
                        messages[path][a]["data"],
                        messages[path][a]["sender"],
                        messages[path][a]["socket-id-sender"]
                    );
                }
            }
        });

        socket.on("signal", (toId, message) => {
            if (!socket.userId) return;
            if (typeof toId !== "string" || toId.length > 64) return;
            if (!isValidSignalPayload(message, 65536)) return;
            if (!checkSocketRateLimit(`${socket.id}:legacy:signal`, 60, 2000)) return;

            // Enforce room isolation: verify target socket is in at least one common legacy room
            const senderRooms = Object.entries(connections)
                .filter(([_, sockets]) => Array.isArray(sockets) && sockets.includes(socket.id))
                .map(([roomKey]) => roomKey);

            const isTargetInSameRoom = senderRooms.some(
                (roomKey) => Array.isArray(connections[roomKey]) && connections[roomKey].includes(toId)
            );

            if (!isTargetInSameRoom) {
                return; // Prevent cross-room signaling injection
            }

            io.to(toId).emit("signal", socket.id, message);
        });

        socket.on("chat-message", (data, sender) => {
            if (!socket.userId) return;
            if (typeof data !== "string" || data.length > 2000) return;
            if (!checkSocketRateLimit(`${socket.id}:legacy:chat`, 15, 2000)) return;

            const [matchingRoom, found] = Object.entries(connections).reduce(
                ([room, isFound], [roomKey, roomValue]) => {
                    if (!isFound && roomValue.includes(socket.id)) {
                        return [roomKey, true];
                    }
                    return [room, isFound];
                },
                ["", false]
            );

            if (found === true) {
                if (messages[matchingRoom] === undefined) {
                    messages[matchingRoom] = [];
                }

                // Security: sender identity derived from authenticated socket, ignoring client-supplied parameter
                const authenticatedSender = socket.username || socket.userId;

                messages[matchingRoom].push({
                    sender: authenticatedSender,
                    data: data,
                    "socket-id-sender": socket.id,
                });

                connections[matchingRoom].forEach((elem) => {
                    io.to(elem).emit("chat-message", data, authenticatedSender, socket.id);
                });
            }
        });

        socket.on("disconnect", () => {
            for (const [k, v] of JSON.parse(JSON.stringify(Object.entries(connections)))) {
                for (let a = 0; a < v.length; ++a) {
                    if (v[a] === socket.id) {
                        const key = k;

                        for (let a = 0; a < connections[key].length; ++a) {
                            io.to(connections[key][a]).emit("user-left", socket.id);
                        }

                        const index = connections[key].indexOf(socket.id);
                        connections[key].splice(index, 1);

                        if (connections[key].length === 0) {
                            delete connections[key];
                        }
                    }
                }
            }

            // Clean up rate limits on socket disconnect
            clearSocketRateLimits(socket.id);
        });
    });

    return io;
};

// Test inspection helpers for legacy meeting state
export const _testingLegacy = {
    getConnections: () => connections,
    clearAll: () => {
        connections = {};
        messages = {};
        timeOnline = {};
    },
};
