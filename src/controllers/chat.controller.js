import httpStatus from "http-status";
import mongoose from "mongoose";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Match } from "../models/match.model.js";
import { getIO } from "./socketManager.js";
import { toPublicProfile, toSenderProfile, toMessageDto } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";

// ==========================================
// 1. GET ALL CONVERSATIONS FOR CURRENT USER
// ==========================================
const getConversations = async (req, res) => {
    try {
        const userId = req.user._id;

        // Auto-sync: Ensure all mutual matches for this user have a conversation record
        const userMatches = await Match.find({ users: userId }).select("_id users createdAt");
        if (userMatches.length > 0) {
            const matchIds = userMatches.map((m) => m._id);
            const existingConvs = await Conversation.find({ match: { $in: matchIds } }).select("match");
            const existingMatchIdSet = new Set(existingConvs.map((c) => c.match.toString()));

            const missingMatches = userMatches.filter((m) => !existingMatchIdSet.has(m._id.toString()));
            if (missingMatches.length > 0) {
                const newConvs = missingMatches.map((m) => ({
                    match: m._id,
                    participants: m.users,
                    lastMessageAt: m.createdAt || new Date(),
                }));
                try {
                    await Conversation.insertMany(newConvs, { ordered: false });
                } catch (insertErr) {
                    // Ignore duplicate key race conditions
                }
            }
        }

        const conversations = await Conversation.find({ participants: userId })
            .sort({ lastMessageAt: -1 })
            .populate({
                path: "participants",
                select: "name photos dob gender bio interests isProfileComplete",
            })
            .populate({
                path: "lastMessage",
                select: "content sender createdAt readBy",
                populate: { path: "sender", select: "name photos" },
            });

        // Compute unread counts and format other participant
        const formatted = await Promise.all(
            conversations.map(async (conv) => {
                const otherParticipant = conv.participants.find(
                    (p) => p && p._id.toString() !== userId.toString()
                );

                if (!otherParticipant) return null;

                const unreadCount = await Message.countDocuments({
                    conversation: conv._id,
                    sender: { $ne: userId },
                    readBy: { $ne: userId },
                });

                const lastMsgDto = conv.lastMessage ? toMessageDto(conv.lastMessage) : null;

                return {
                    _id: conv._id,
                    match: conv.match,
                    otherParticipant: toPublicProfile(otherParticipant),
                    lastMessage: lastMsgDto,
                    lastMessageAt: conv.lastMessageAt,
                    unreadCount,
                };
            })
        );

        return res.status(httpStatus.OK).json({
            success: true,
            conversations: formatted.filter(Boolean),
        });
    } catch (e) {
        console.error("Get conversations error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to load conversations",
        });
    }
};

// ==========================================
// 2. GET OR CREATE CONVERSATION BY MATCH ID
// ==========================================
const getOrCreateConversationByMatch = async (req, res) => {
    const { matchId } = req.params;

    if (!matchId || !mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid match ID",
        });
    }

    try {
        const match = await Match.findById(matchId).populate({
            path: "users",
            select: "name photos dob gender bio interests isProfileComplete",
        });

        if (!match) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Mutual match record not found",
            });
        }

        // Verify authenticated user is a participant of this match
        const isParticipant = match.users.some(
            (u) => u && u._id.toString() === req.user._id.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to access this conversation",
            });
        }

        // Find or create conversation
        let conversation = await Conversation.findOne({ match: match._id });
        if (!conversation) {
            conversation = new Conversation({
                match: match._id,
                participants: match.users.map((u) => u._id),
                lastMessageAt: match.createdAt || new Date(),
            });
            await conversation.save();
        }

        const otherParticipant = match.users.find(
            (u) => u && u._id.toString() !== req.user._id.toString()
        );

        if (!otherParticipant) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation partner profile not found",
            });
        }

        const otherEligibility = checkUserEligibility(otherParticipant);
        if (!otherEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "PARTNER_INELIGIBLE",
                message: "Conversation partner is no longer eligible for messaging.",
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            conversation: {
                _id: conversation._id,
                match: match._id,
                otherParticipant: toPublicProfile(otherParticipant),
                lastMessage: conversation.lastMessage,
                lastMessageAt: conversation.lastMessageAt,
            },
        });
    } catch (e) {
        console.error("Get or create conversation error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to load or initialize conversation",
        });
    }
};

// ==========================================
// 3. GET MESSAGES FOR A CONVERSATION
// ==========================================
const getMessages = async (req, res) => {
    const { conversationId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation ID",
        });
    }

    try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        // Security: verify authenticated user is a participant
        const isParticipant = conversation.participants.some(
            (p) => p.toString() === req.user._id.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to view messages in this conversation",
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const skip = (page - 1) * limit;

        const total = await Message.countDocuments({ conversation: conversationId });

        // Retrieve latest messages first for pagination, then sort chronologically
        const messagesDesc = await Message.find({ conversation: conversationId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: "sender",
                select: "name photos",
            });

        const messagesChronological = messagesDesc.reverse();

        return res.status(httpStatus.OK).json({
            success: true,
            conversationId,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            messages: messagesChronological.map(toMessageDto),
        });
    } catch (e) {
        console.error("Get messages error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to load messages",
        });
    }
};

// ==========================================
// 4. MARK CONVERSATION AS READ
// ==========================================
const markConversationAsRead = async (req, res) => {
    const { conversationId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation ID",
        });
    }

    try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => p.toString() === req.user._id.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to perform this action",
            });
        }

        const updateResult = await Message.updateMany(
            {
                conversation: conversationId,
                sender: { $ne: req.user._id },
                readBy: { $ne: req.user._id },
            },
            {
                $addToSet: { readBy: req.user._id },
            }
        );

        // Real-time notification to conversation room and participants
        const io = req.app?.get("io") || getIO();
        if (io) {
            const roomName = `conversation:${conversationId}`;
            let broadcast = io.to(roomName);
            if (Array.isArray(conversation.participants)) {
                for (const p of conversation.participants) {
                    broadcast = broadcast.to(`user:${p.toString()}`);
                }
            }
            broadcast.emit("chat:read", {
                conversationId,
                readerId: req.user._id,
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Messages marked as read",
            modifiedCount: updateResult.modifiedCount,
        });
    } catch (e) {
        console.error("Mark as read error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to mark messages as read",
        });
    }
};

// ==========================================
// 5. REST FALLBACK: SEND MESSAGE
// ==========================================
const sendMessageRest = async (req, res) => {
    const { conversationId } = req.params;
    const { content, clientTempId } = req.body;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation ID",
        });
    }

    if (!content || !String(content).trim()) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Message content cannot be empty",
        });
    }

    const trimmed = String(content).trim();
    if (trimmed.length > 2000) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Message cannot exceed 2000 characters",
        });
    }

    try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => p.toString() === req.user._id.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to send messages in this conversation",
            });
        }

        // Check for idempotency key to prevent duplicates
        if (clientTempId) {
            const existing = await Message.findOne({
                conversation: conversationId,
                clientTempId,
            }).populate({ path: "sender", select: "name photos" });

            if (existing) {
                return res.status(httpStatus.OK).json({
                    success: true,
                    message: toMessageDto(existing),
                    duplicate: true,
                });
            }
        }

        const newMessage = new Message({
            conversation: conversationId,
            sender: req.user._id,
            content: trimmed,
            clientTempId: clientTempId || undefined,
            readBy: [req.user._id],
        });

        await newMessage.save();

        // Update conversation summary
        conversation.lastMessage = newMessage._id;
        conversation.lastMessageAt = newMessage.createdAt;
        await conversation.save();

        await newMessage.populate({ path: "sender", select: "name photos" });
        const messageDto = toMessageDto(newMessage);

        // Broadcast to conversation room AND all participant user rooms
        const io = req.app?.get("io") || getIO();
        if (io) {
            const roomName = `conversation:${conversationId}`;
            let broadcast = io.to(roomName);
            if (Array.isArray(conversation.participants)) {
                for (const p of conversation.participants) {
                    broadcast = broadcast.to(`user:${p.toString()}`);
                }
            }
            broadcast.emit("chat:new-message", messageDto);
        }

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: messageDto,
        });
    } catch (e) {
        // Catch duplicate key error if concurrent retry
        if (e.code === 11000) {
            const existing = await Message.findOne({
                conversation: conversationId,
                clientTempId,
            }).populate({ path: "sender", select: "name photos" });

            if (existing) {
                return res.status(httpStatus.OK).json({
                    success: true,
                    message: toMessageDto(existing),
                    duplicate: true,
                });
            }
        }

        console.error("Send message error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to send message",
        });
    }
};

export {
    getConversations,
    getOrCreateConversationByMatch,
    getMessages,
    markConversationAsRead,
    sendMessageRest,
};

