import httpStatus from "http-status";
import mongoose from "mongoose";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";
import { getIO } from "./socketManager.js";
import { toPublicProfile, toSenderProfile, toMessageDto } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";

// ==========================================
// 1. GET ALL CONVERSATIONS FOR CURRENT USER
// ==========================================
const getConversations = async (req, res) => {
    try {
        const userId = req.user._id;

        const blockedUserIds = await Block.getBlockedUserIds(userId);
        const blockedSet = new Set(blockedUserIds.map((id) => id.toString()));

        // Auto-sync: Ensure all active mutual matches for this user have a conversation record
        const userMatches = await Match.find({ users: userId, status: "active" }).select("_id users createdAt");
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
                path: "match",
                select: "status",
            })
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
                // If match is unmatched, exclude from active conversation list
                if (conv.match && conv.match.status === "unmatched") {
                    return null;
                }

                const otherParticipant = conv.participants.find(
                    (p) => p && p._id.toString() !== userId.toString()
                );

                if (!otherParticipant) return null;

                // If either has blocked the other, exclude from active conversation list
                if (blockedSet.has(otherParticipant._id.toString())) {
                    return null;
                }

                const unreadCount = await Message.countDocuments({
                    conversation: conv._id,
                    sender: { $ne: userId },
                    readBy: { $ne: userId },
                });

                const lastMsgDto = conv.lastMessage ? toMessageDto(conv.lastMessage) : null;

                return {
                    _id: conv._id,
                    match: conv.match?._id || conv.match,
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

        if (match.status === "unmatched") {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "MATCH_UNMATCHED",
                message: "This match has been unmatched.",
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

        const isBlocked = await Block.isBlockedBidirectional(req.user._id, otherParticipant._id);
        if (isBlocked) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "BLOCKED_USER",
                message: "You cannot message this user.",
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

        const otherParticipantId = conversation.participants.find(
            (p) => p.toString() !== req.user._id.toString()
        );
        if (otherParticipantId) {
            const isBlocked = await Block.isBlockedBidirectional(req.user._id, otherParticipantId);
            if (isBlocked) {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "BLOCKED_USER",
                    message: "You cannot access messages for this user.",
                });
            }
        }

        if (conversation.match) {
            const match = await Match.findById(conversation.match).select("status");
            if (match && match.status === "unmatched") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_UNMATCHED",
                    message: "This match has been unmatched.",
                });
            }
        }

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

        // Cursor-based missed message recovery: fetch messages created after a given message ID
        if (req.query.after) {
            if (!mongoose.Types.ObjectId.isValid(req.query.after)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Invalid after message ID",
                });
            }

            const afterMessage = await Message.findById(req.query.after).select("_id createdAt");
            const afterFilter = {
                conversation: conversationId,
            };
            if (afterMessage) {
                // Compound cursor: strictly greater timestamp OR same timestamp with greater _id tie-breaker
                afterFilter.$or = [
                    { createdAt: { $gt: afterMessage.createdAt } },
                    { createdAt: afterMessage.createdAt, _id: { $gt: afterMessage._id } },
                ];
            } else {
                afterFilter._id = { $gt: new mongoose.Types.ObjectId(req.query.after) };
            }

            const missedMessages = await Message.find(afterFilter)
                .sort({ createdAt: 1, _id: 1 })
                .limit(limit)
                .populate({
                    path: "sender",
                    select: "name photos",
                });

            return res.status(httpStatus.OK).json({
                success: true,
                conversationId,
                messages: missedMessages.map(toMessageDto),
                after: req.query.after,
                count: missedMessages.length,
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
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

        const otherParticipantId = conversation.participants.find(
            (p) => p.toString() !== req.user._id.toString()
        );
        if (otherParticipantId) {
            const isBlocked = await Block.isBlockedBidirectional(req.user._id, otherParticipantId);
            if (isBlocked) {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "BLOCKED_USER",
                    message: "Action not permitted.",
                });
            }
        }

        if (conversation.match) {
            const match = await Match.findById(conversation.match).select("status");
            if (match && match.status === "unmatched") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_UNMATCHED",
                    message: "This match has been unmatched.",
                });
            }
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

    let sanitizedTempId = undefined;
    if (clientTempId !== undefined && clientTempId !== null) {
        if (typeof clientTempId !== "string" || clientTempId.length > 100) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Invalid clientTempId format: string up to 100 characters expected",
            });
        }
        sanitizedTempId = clientTempId.trim() || undefined;
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

        // Authoritative caller eligibility check
        const callerEligibility = checkUserEligibility(req.user);
        if (!callerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: callerEligibility.code,
                message: callerEligibility.reason,
                missingFields: callerEligibility.missingFields,
            });
        }

        const otherParticipantId = conversation.participants.find(
            (p) => p.toString() !== req.user._id.toString()
        );
        if (otherParticipantId) {
            const isBlocked = await Block.isBlockedBidirectional(req.user._id, otherParticipantId);
            if (isBlocked) {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "BLOCKED_USER",
                    message: "You cannot message this user.",
                });
            }
        }

        if (conversation.match) {
            const match = await Match.findById(conversation.match).select("status");
            if (match && match.status === "unmatched") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_UNMATCHED",
                    message: "This match has been unmatched.",
                });
            }
        }

        // Check for idempotency key to prevent duplicates scoped to conversation, sender, and clientTempId
        if (sanitizedTempId) {
            const existing = await Message.findOne({
                conversation: conversationId,
                sender: req.user._id,
                clientTempId: sanitizedTempId,
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
            clientTempId: sanitizedTempId,
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
        if (e.code === 11000 && sanitizedTempId) {
            const existing = await Message.findOne({
                conversation: conversationId,
                sender: req.user._id,
                clientTempId: sanitizedTempId,
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

