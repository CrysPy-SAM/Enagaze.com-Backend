import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { registerRandomCallHandlers } from "./randomCallManager.js";

const JWT_SECRET = process.env.JWT_SECRET || "engaze_super_secret_jwt_key_2026_dev_secure";

let connections = {};
let messages = {};
let timeOnline = {};

export const connectToSocket = (server) => {
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            allowedHeaders: ["*"],
            credentials: true,
        },
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

        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                socket.userId = decoded.id;
                socket.username = decoded.username;
            } catch (err) {
                // Token invalid - leave socket.userId undefined (video room guests allowed)
                socket.userId = null;
            }
        } else {
            socket.userId = null;
        }

        next();
    });

    io.on("connection", (socket) => {
        // ==========================================
        // 1. RANDOM 1-TO-1 VIDEO MATCHMAKING EVENTS
        // ==========================================
        registerRandomCallHandlers(io, socket);

        // ==========================================
        // 2. MATCH-BASED PRIVATE CHAT EVENTS
        // ==========================================

        // Event: Join a private match conversation room
        socket.on("chat:join", async (data, ack) => {
            const conversationId = data?.conversationId;

            if (!socket.userId) {
                const err = { message: "Authentication required to join private chat" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
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
            const { conversationId, content, clientTempId } = data || {};

            if (!socket.userId) {
                const err = { message: "Authentication required to send messages" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
                const err = { message: "Invalid conversation ID" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            const trimmedContent = String(content || "").trim();
            if (!trimmedContent) {
                const err = { message: "Message content cannot be empty" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
                return;
            }

            if (trimmedContent.length > 2000) {
                const err = { message: "Message exceeds maximum length of 2000 characters" };
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
                    const err = { message: "You are not authorized to send messages in this conversation" };
                    socket.emit("chat:error", err);
                    if (typeof ack === "function") ack({ success: false, ...err });
                    return;
                }

                // Check for duplicate retry using clientTempId
                if (clientTempId) {
                    const existing = await Message.findOne({
                        conversation: conversationId,
                        clientTempId,
                    }).populate({ path: "sender", select: "name username photos" });

                    if (existing) {
                        if (typeof ack === "function") ack({ success: true, message: existing.toJSON(), duplicate: true });
                        return;
                    }
                }

                // Persist new message to MongoDB
                const newMsg = new Message({
                    conversation: conversationId,
                    sender: socket.userId,
                    content: trimmedContent,
                    clientTempId: clientTempId || undefined,
                    readBy: [socket.userId],
                });

                await newMsg.save();

                // Update conversation's last message tracking
                conversation.lastMessage = newMsg._id;
                conversation.lastMessageAt = newMsg.createdAt;
                await conversation.save();

                await newMsg.populate({ path: "sender", select: "name username photos" });
                const messageJson = newMsg.toJSON();

                // Broadcast exclusively to participants in this conversation room
                const roomName = `conversation:${conversationId}`;
                io.to(roomName).emit("chat:new-message", messageJson);

                if (typeof ack === "function") {
                    ack({ success: true, message: messageJson });
                }
            } catch (e) {
                // Handle idempotency race condition gracefully
                if (e.code === 11000 && clientTempId) {
                    const existing = await Message.findOne({
                        conversation: conversationId,
                        clientTempId,
                    }).populate({ path: "sender", select: "name username photos" });

                    if (existing && typeof ack === "function") {
                        return ack({ success: true, message: existing.toJSON(), duplicate: true });
                    }
                }

                console.error("Socket chat:send error:", e);
                const err = { message: "Failed to persist and send message" };
                socket.emit("chat:error", err);
                if (typeof ack === "function") ack({ success: false, ...err });
            }
        });

        // Event: Mark conversation as read in real-time
        socket.on("chat:read", async (data) => {
            const conversationId = data?.conversationId;
            if (!socket.userId || !conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
                return;
            }

            try {
                const conversation = await Conversation.findById(conversationId);
                if (!conversation) return;

                const isParticipant = conversation.participants.some(
                    (p) => p.toString() === socket.userId.toString()
                );
                if (!isParticipant) return;

                await Message.updateMany(
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
                socket.to(roomName).emit("chat:read", {
                    conversationId,
                    readerId: socket.userId,
                });
            } catch (e) {
                console.error("Socket chat:read error:", e);
            }
        });

        // ==========================================
        // 2. EXISTING WEBRTC SIGNALING (PRESERVED)
        // ==========================================
        socket.on("join-call", (path) => {
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
            io.to(toId).emit("signal", socket.id, message);
        });

        socket.on("chat-message", (data, sender) => {
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

                messages[matchingRoom].push({
                    sender: sender,
                    data: data,
                    "socket-id-sender": socket.id,
                });

                connections[matchingRoom].forEach((elem) => {
                    io.to(elem).emit("chat-message", data, sender, socket.id);
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
        });
    });

    return io;
};
