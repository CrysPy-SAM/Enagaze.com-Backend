import httpStatus from "http-status";
import mongoose from "mongoose";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";
import { getIO } from "./socketManager.js";
import { toPublicProfile, toSenderProfile, toMessageDto } from "../serializers/profile.serializer.js";
import { getPresenceForViewer } from "../services/presence.service.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import { safeLean } from "../utils/queryHelper.js";

const isChatDbReady = () => Boolean(mongoose.connection?.readyState === 1 || (Conversation.find && Conversation.find !== mongoose.Model.find));

// ==========================================
// 1. GET ALL CONVERSATIONS FOR CURRENT USER
// ==========================================
const getConversations = async (req, res) => {
    if (!isChatDbReady()) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Database service unavailable",
        });
    }
    try {
        const userId = req.user._id;
        const userObjId = mongoose.Types.ObjectId.isValid(userId)
            ? new mongoose.Types.ObjectId(userId.toString())
            : userId;

        // Run block list and mutual active matches lookups concurrently
        const [blockedUserIds, userMatches] = await Promise.all([
            Block.getBlockedUserIds(userObjId),
            safeLean(Match.find({ users: userObjId, status: "active" }).select("_id users createdAt")),
        ]);
        const blockedSet = new Set(blockedUserIds.map((id) => id.toString()));

        // Auto-sync: Ensure all active mutual matches for this user have a conversation record
        if (userMatches.length > 0) {
            const matchIds = userMatches.map((m) => m._id);
            const existingConvs = await safeLean(Conversation.find({ match: { $in: matchIds } }).select("match"));
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

        const conversations = await safeLean(
            Conversation.find({
                participants: userObjId,
                hiddenFor: { $ne: userObjId },
            })
                .sort({ lastMessageAt: -1 })
                .populate({
                    path: "match",
                    select: "status",
                })
                .populate({
                    path: "participants",
                    select: "name photos dob gender bio interests isProfileComplete lastSeenAt privacySettings",
                })
                .populate({
                    path: "lastMessage",
                    select: "content sender createdAt readBy deletedFor isDeletedForEveryone deletedAt",
                    populate: { path: "sender", select: "name photos" },
                })
        );

        // Filter active, unblocked conversations
        const activeConvs = conversations.filter((conv) => {
            if (!conv.match || conv.match.status !== "active") return false;
            if (conv.hiddenFor && conv.hiddenFor.some((id) => (id?._id || id)?.toString() === userObjId.toString())) {
                return false;
            }
            const otherParticipant = conv.participants.find(
                (p) => p && (p._id || p).toString() !== userObjId.toString()
            );
            if (!otherParticipant) return false;
            if (otherParticipant.status === "deleted" || otherParticipant.status === "suspended") return false;
            const otherId = (otherParticipant._id || otherParticipant).toString();
            if (blockedSet.has(otherId)) return false;
            return true;
        });

        // Batch-calculate unread message counts across all active conversations
        const allUserIds = [userObjId, userObjId.toString()];
        let unreadMap = new Map();
        if (activeConvs.length > 0) {
            const counts = await Promise.all(
                activeConvs.map(async (conv) => {
                    const cId = conv._id;
                    const cIdStr = cId.toString();
                    const clearedEntry = Array.isArray(conv.clearedAt)
                        ? conv.clearedAt.find((c) => (c.user?._id || c.user)?.toString() === userObjId.toString())
                        : null;
                    const clearedAt = clearedEntry?.at ? new Date(clearedEntry.at) : null;
                    const query = {
                        conversation: cId,
                        sender: { $ne: userObjId, $nin: allUserIds },
                        readBy: { $ne: userObjId, $nin: allUserIds },
                        deletedFor: { $ne: userObjId, $nin: allUserIds },
                        isDeletedForEveryone: { $ne: true },
                    };
                    if (clearedAt) {
                        query.createdAt = { $gt: clearedAt };
                    }
                    return Message.countDocuments(query);
                })
            );
            activeConvs.forEach((conv, idx) => {
                unreadMap.set(conv._id.toString(), counts[idx] || 0);
            });
        }

        // Format other participant and map pre-aggregated unread counts
        const formatted = await Promise.all(
            activeConvs.map(async (conv) => {
                const otherParticipant = conv.participants.find(
                    (p) => p && p._id.toString() !== userObjId.toString()
                );
                const unreadCount = unreadMap.get(conv._id.toString()) || 0;

                let lastMsgDto = null;
                if (conv.lastMessage) {
                    const isDeletedForMe = Boolean(
                        conv.lastMessage.deletedFor &&
                        conv.lastMessage.deletedFor.some((id) => (id?._id || id)?.toString() === userObjId.toString())
                    );
                    const clearedEntry = conv.clearedAt && conv.clearedAt.find(
                        (c) => (c.user?._id || c.user)?.toString() === userObjId.toString()
                    );
                    const isCleared = clearedEntry && clearedEntry.at &&
                        conv.lastMessage.createdAt &&
                        new Date(conv.lastMessage.createdAt) <= new Date(clearedEntry.at);

                    if (!isDeletedForMe && !isCleared) {
                        lastMsgDto = toMessageDto(conv.lastMessage, userObjId);
                    }
                }

                const presence = otherParticipant ? await getPresenceForViewer(otherParticipant, req.user, true) : null;

                return {
                    _id: conv._id,
                    match: conv.match?._id || conv.match,
                    otherParticipant: toPublicProfile(otherParticipant, presence),
                    lastMessage: lastMsgDto,
                    lastMessageAt: conv.lastMessageAt,
                    unreadCount,
                };
            })
        );

        return res.status(httpStatus.OK).json({
            success: true,
            conversations: formatted,
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
// ==========================================
// 1b. GET TOTAL UNREAD MESSAGE COUNT FOR CURRENT USER
// ==========================================
const calculateUserUnreadCount = async (userId) => {
    if (!userId || !isChatDbReady()) {
        return { totalUnreadCount: 0, unreadConversationsCount: 0, conversationsUnread: {} };
    }

    try {
        const userObjId = mongoose.Types.ObjectId.isValid(userId)
            ? new mongoose.Types.ObjectId(userId.toString())
            : userId;

        const [blockedUserIds, conversations] = await Promise.all([
            Block.getBlockedUserIds(userObjId),
            safeLean(
                Conversation.find({
                    participants: userObjId,
                    hiddenFor: { $ne: userObjId },
                })
                    .select("_id match participants clearedAt")
                    .populate([
                        { path: "match", select: "status" },
                        { path: "participants", select: "_id status" },
                    ])
            ),
        ]);
        const blockedSet = new Set(blockedUserIds.map((id) => id.toString()));

        const activeConvs = conversations.filter((conv) => {
            if (!conv.match || conv.match.status !== "active") return false;
            const otherParticipant = (conv.participants || []).find(
                (p) => p && (p._id || p).toString() !== userObjId.toString()
            );
            if (!otherParticipant) return false;
            if (otherParticipant.status === "deleted" || otherParticipant.status === "suspended") return false;
            const otherId = (otherParticipant._id || otherParticipant).toString();
            if (blockedSet.has(otherId)) return false;
            return true;
        });

        const activeConvIds = activeConvs.map((c) =>
            mongoose.Types.ObjectId.isValid(c._id) ? new mongoose.Types.ObjectId(c._id.toString()) : c._id
        );

        if (activeConvIds.length === 0) {
            return { totalUnreadCount: 0, unreadConversationsCount: 0, conversationsUnread: {} };
        }

        let conversationsUnread = {};
        let totalUnreadCount = 0;
        const allUserIds = [userObjId, userObjId.toString()];

        const counts = await Promise.all(
            activeConvs.map(async (conv) => {
                const cId = conv._id;
                const cIdStr = cId.toString();
                const clearedEntry = Array.isArray(conv.clearedAt)
                    ? conv.clearedAt.find((c) => (c.user?._id || c.user)?.toString() === userObjId.toString())
                    : null;
                const clearedAt = clearedEntry?.at ? new Date(clearedEntry.at) : null;
                const query = {
                        conversation: cId,
                        sender: { $ne: userObjId, $nin: allUserIds },
                        readBy: { $ne: userObjId, $nin: allUserIds },
                        deletedFor: { $ne: userObjId, $nin: allUserIds },
                        isDeletedForEveryone: { $ne: true },
                    };
                if (clearedAt) {
                    query.createdAt = { $gt: clearedAt };
                }
                return Message.countDocuments(query);
            })
        );

        activeConvs.forEach((conv, idx) => {
            const count = counts[idx] || 0;
            if (count > 0) {
                conversationsUnread[conv._id.toString()] = count;
                totalUnreadCount += count;
            }
        });

        const unreadConversationsCount = Object.keys(conversationsUnread).length;

        return {
            totalUnreadCount,
            unreadConversationsCount,
            conversationsUnread,
        };
    } catch (err) {
        console.error("calculateUserUnreadCount error:", err);
        return { totalUnreadCount: 0, unreadConversationsCount: 0, conversationsUnread: {} };
    }
};

const getUnreadMessageCount = async (req, res) => {
    if (!isChatDbReady()) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Database service unavailable",
        });
    }
    try {
        const userId = req.user._id;
        const result = await calculateUserUnreadCount(userId);
        return res.status(httpStatus.OK).json({
            success: true,
            unreadCount: result.totalUnreadCount,
            unreadConversationsCount: result.unreadConversationsCount,
            conversationsUnread: result.conversationsUnread,
        });
    } catch (e) {
        console.error('Get unread message count error:', e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to calculate unread message count',
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
            select: "name photos dob gender bio interests isProfileComplete lastSeenAt privacySettings",
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

        if (match.status !== "active") {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "MATCH_NOT_ACTIVE",
                message: "Conversation requires an active accepted match.",
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

        const presence = otherParticipant ? await getPresenceForViewer(otherParticipant, req.user, true) : null;

        return res.status(httpStatus.OK).json({
            success: true,
            conversation: {
                _id: conversation._id,
                match: match._id,
                otherParticipant: toPublicProfile(otherParticipant, presence),
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
        const userObjId = mongoose.Types.ObjectId.isValid(req.user._id)
            ? new mongoose.Types.ObjectId(req.user._id.toString())
            : req.user._id;
        const convObjId = mongoose.Types.ObjectId.isValid(conversationId)
            ? new mongoose.Types.ObjectId(conversationId.toString())
            : conversationId;

        const conversation = await Conversation.findById(convObjId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        // Security: verify authenticated user is a participant
        const isParticipant = conversation.participants.some(
            (p) => (p?._id || p).toString() === userObjId.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to view messages in this conversation",
            });
        }

        const otherParticipantId = conversation.participants.find(
            (p) => p.toString() !== userObjId.toString()
        );
        if (otherParticipantId) {
            const isBlocked = await Block.isBlockedBidirectional(userObjId, otherParticipantId);
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
            if (match && match.status !== "active") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_NOT_ACTIVE",
                    message: "An active accepted connection is required to access messages.",
                });
            }
        }

        // Determine if user has cleared messages
        const clearedEntry = conversation.clearedAt?.find(
            (c) => (c.user?._id || c.user)?.toString() === userObjId.toString()
        );
        const clearedTime = clearedEntry?.at ? new Date(clearedEntry.at) : null;

        const baseFilter = {
            conversation: conversationId,
            deletedFor: { $ne: userObjId },
        };
        if (clearedTime) {
            baseFilter.createdAt = { $gt: clearedTime };
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
            const afterFilter = { ...baseFilter };
            if (afterMessage) {
                afterFilter.$or = [
                    { createdAt: { $gt: afterMessage.createdAt } },
                    { createdAt: afterMessage.createdAt, _id: { $gt: afterMessage._id } },
                ];
            } else {
                afterFilter._id = { $gt: new mongoose.Types.ObjectId(req.query.after) };
            }

            let missedQuery = Message.find(afterFilter)
                .sort({ createdAt: 1, _id: 1 })
                .limit(limit)
                .populate({
                    path: "sender",
                    select: "name photos",
                });
            if (typeof missedQuery.lean === "function") missedQuery = missedQuery.lean();
            const missedMessages = await missedQuery;

            return res.status(httpStatus.OK).json({
                success: true,
                conversationId,
                messages: missedMessages.map((m) => toMessageDto(m, userObjId)),
                after: req.query.after,
                count: missedMessages.length,
            });
        }

        // Cursor-based backward pagination: fetch messages created before a given message ID
        if (req.query.before) {
            if (!mongoose.Types.ObjectId.isValid(req.query.before)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Invalid before message ID",
                });
            }

            const beforeMessage = await Message.findById(req.query.before).select("_id createdAt");
            const beforeFilter = { ...baseFilter };
            if (beforeMessage) {
                beforeFilter.$or = [
                    { createdAt: { $lt: beforeMessage.createdAt } },
                    { createdAt: beforeMessage.createdAt, _id: { $lt: beforeMessage._id } },
                ];
            } else {
                beforeFilter._id = { $lt: new mongoose.Types.ObjectId(req.query.before) };
            }

            let olderQuery = Message.find(beforeFilter)
                .sort({ createdAt: -1, _id: -1 })
                .limit(limit)
                .populate({
                    path: "sender",
                    select: "name photos",
                });
            if (typeof olderQuery.lean === "function") olderQuery = olderQuery.lean();
            const olderMessagesDesc = await olderQuery;

            const olderMessagesChronological = olderMessagesDesc.reverse();
            const nextBeforeCursor = olderMessagesDesc.length === limit && olderMessagesChronological[0]
                ? olderMessagesChronological[0]._id
                : null;

            return res.status(httpStatus.OK).json({
                success: true,
                conversationId,
                messages: olderMessagesChronological.map((m) => toMessageDto(m, userObjId)),
                before: req.query.before,
                nextBeforeCursor,
                hasMore: Boolean(nextBeforeCursor),
                count: olderMessagesChronological.length,
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const skip = (page - 1) * limit;

        let pageQuery = Message.find(baseFilter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: "sender",
                select: "name photos",
            });
        if (typeof pageQuery.lean === "function") pageQuery = pageQuery.lean();

        const [total, messagesDesc] = await Promise.all([
            Message.countDocuments(baseFilter),
            pageQuery,
        ]);

        const messagesChronological = messagesDesc.reverse();
        const nextBeforeCursor = messagesChronological.length > 0 ? messagesChronological[0]._id : null;

        return res.status(httpStatus.OK).json({
            success: true,
            conversationId,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            nextBeforeCursor,
            hasMore: total > skip + messagesChronological.length,
            messages: messagesChronological.map((m) => toMessageDto(m, userObjId)),
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
// ==========================================
// 4. MARK CONVERSATION AS READ
// ==========================================
const markConversationAsRead = async (req, res) => {
    if (!isChatDbReady()) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Database service unavailable",
        });
    }
    const { conversationId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation ID",
        });
    }

    try {
        const userObjId = mongoose.Types.ObjectId.isValid(req.user._id)
            ? new mongoose.Types.ObjectId(req.user._id.toString())
            : req.user._id;
        const convObjId = mongoose.Types.ObjectId.isValid(conversationId)
            ? new mongoose.Types.ObjectId(conversationId.toString())
            : conversationId;

        const conversation = await Conversation.findById(convObjId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => (p?._id || p).toString() === userObjId.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to perform this action",
            });
        }

        const otherParticipantId = conversation.participants.find(
            (p) => p.toString() !== userObjId.toString()
        );
        if (otherParticipantId) {
            const isBlocked = await Block.isBlockedBidirectional(userObjId, otherParticipantId);
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
            if (match && match.status !== "active") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_NOT_ACTIVE",
                    message: "An active accepted connection is required to access messages.",
                });
            }
        }

        const allUserIds = [userObjId, userObjId.toString()];
        const allConvIds = [convObjId, conversationId.toString()];
        const updateResult = await Message.updateMany(
            {
                conversation: convObjId,
                sender: { $ne: userObjId, $nin: allUserIds },
                readBy: { $ne: userObjId, $nin: allUserIds },
            },
            {
                $addToSet: { readBy: userObjId },
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
                readerId: userObjId.toString(),
            });

            // Real-time authoritative unread count notification specifically to the reader
            calculateUserUnreadCount(userObjId)
                .then((counts) => {
                    io.to(`user:${userObjId.toString()}`).emit("chat:unread-count", {
                        unreadCount: counts.totalUnreadCount,
                        unreadConversationsCount: counts.unreadConversationsCount,
                        conversationsUnread: counts.conversationsUnread,
                    });
                })
                .catch(() => {});
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
            (p) => (p?._id || p).toString() === req.user._id.toString()
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

        // Run block check, match status, and idempotency lookup concurrently to collapse 3 round-trips into 1
        const [isBlocked, match, existing] = await Promise.all([
            otherParticipantId ? Block.isBlockedBidirectional(req.user._id, otherParticipantId) : Promise.resolve(false),
            conversation.match ? safeLean(Match.findById(conversation.match).select("status")) : Promise.resolve(null),
            sanitizedTempId
                ? Message.findOne({
                      conversation: conversationId,
                      sender: req.user._id,
                      clientTempId: sanitizedTempId,
                  }).populate({ path: "sender", select: "name photos" })
                : Promise.resolve(null),
        ]);

        if (isBlocked) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "BLOCKED_USER",
                message: "You cannot message this user.",
            });
        }

        if (match) {
            if (match.status === "unmatched") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_UNMATCHED",
                    message: "This match has been unmatched.",
                });
            }
            if (match.status !== "active") {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    code: "MATCH_NOT_ACTIVE",
                    message: "An active accepted connection is required to access messages.",
                });
            }
        }

        if (existing) {
            return res.status(httpStatus.OK).json({
                success: true,
                message: toMessageDto(existing),
                duplicate: true,
            });
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
        if (conversation.hiddenFor && conversation.hiddenFor.length > 0) {
            conversation.hiddenFor = [];
        }
        await conversation.save();

        // Attach sender profile without an extra round-trip to database
        newMessage.sender = {
            _id: req.user._id,
            name: req.user.name,
            photos: req.user.photos,
        };
        const messageDto = toMessageDto(newMessage);
        if (!messageDto.sender || !messageDto.sender._id || messageDto.sender.name === "Engaze Member") {
            messageDto.sender = {
                _id: req.user._id ? req.user._id.toString() : String(req.user),
                name: req.user.name || "Engaze Member",
                photos: Array.isArray(req.user.photos) ? req.user.photos : [],
            };
        }

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


// ==========================================
// 6. DELETE MESSAGE FOR ME
// ==========================================
const deleteMessageForMe = async (req, res) => {
    const { conversationId, messageId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId) ||
        !messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation or message ID",
        });
    }

    try {
        const userObjId = mongoose.Types.ObjectId.isValid(req.user._id)
            ? new mongoose.Types.ObjectId(req.user._id.toString())
            : req.user._id;
        const convObjId = mongoose.Types.ObjectId.isValid(conversationId)
            ? new mongoose.Types.ObjectId(conversationId.toString())
            : conversationId;
        const msgObjId = mongoose.Types.ObjectId.isValid(messageId)
            ? new mongoose.Types.ObjectId(messageId.toString())
            : messageId;

        const conversation = await Conversation.findById(convObjId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => (p?._id || p).toString() === userObjId.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to delete this message",
            });
        }

        const message = await Message.findOne({ _id: msgObjId, conversation: convObjId });
        if (!message) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Message not found",
            });
        }

        await Message.updateOne(
            { _id: msgObjId },
            { $addToSet: { deletedFor: userObjId } }
        );

        const io = req.app?.get("io") || getIO();
        if (io) {
            io.to(`user:${userObjId.toString()}`).emit("chat:message-deleted", {
                conversationId: conversationId.toString(),
                messageId: messageId.toString(),
                deleteType: "me",
            });

            calculateUserUnreadCount(userObjId)
                .then((counts) => {
                    io.to(`user:${userObjId.toString()}`).emit("chat:unread-count", counts);
                })
                .catch(() => {});
        }

        return res.status(httpStatus.OK).json({
            success: true,
            conversationId: conversationId.toString(),
            messageId: messageId.toString(),
            deleteType: "me",
        });
    } catch (e) {
        console.error("Delete message for me error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to delete message for you",
        });
    }
};

// ==========================================
// 7. DELETE MESSAGE FOR EVERYONE
// ==========================================
const deleteMessageForEveryone = async (req, res) => {
    const { conversationId, messageId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId) ||
        !messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation or message ID",
        });
    }

    try {
        const userObjId = mongoose.Types.ObjectId.isValid(req.user._id)
            ? new mongoose.Types.ObjectId(req.user._id.toString())
            : req.user._id;
        const convObjId = mongoose.Types.ObjectId.isValid(conversationId)
            ? new mongoose.Types.ObjectId(conversationId.toString())
            : conversationId;
        const msgObjId = mongoose.Types.ObjectId.isValid(messageId)
            ? new mongoose.Types.ObjectId(messageId.toString())
            : messageId;

        const conversation = await Conversation.findById(convObjId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => (p?._id || p).toString() === userObjId.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to delete this message",
            });
        }

        const message = await Message.findOne({ _id: msgObjId, conversation: convObjId });
        if (!message) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Message not found",
            });
        }

        // Security check: Only original sender can delete for everyone
        if (message.sender.toString() !== userObjId.toString()) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You can only delete your own messages for everyone",
            });
        }

        message.isDeletedForEveryone = true;
        message.content = "This message was deleted";
        message.deletedAt = new Date();
        await message.save();

        const messageDto = toMessageDto(message);

        const io = req.app?.get("io") || getIO();
        if (io) {
            const payload = {
                conversationId: conversationId.toString(),
                messageId: messageId.toString(),
                deleteType: "everyone",
                message: messageDto,
            };

            const roomName = `conversation:${conversationId}`;
            let broadcast = io.to(roomName);
            if (Array.isArray(conversation.participants)) {
                for (const p of conversation.participants) {
                    broadcast = broadcast.to(`user:${p.toString()}`);
                }
            }
            broadcast.emit("chat:message-deleted", payload);

            // Recompute unread counts for all participants
            if (Array.isArray(conversation.participants)) {
                for (const p of conversation.participants) {
                    calculateUserUnreadCount(p)
                        .then((counts) => {
                            io.to(`user:${p.toString()}`).emit("chat:unread-count", counts);
                        })
                        .catch(() => {});
                }
            }
        }

        return res.status(httpStatus.OK).json({
            success: true,
            conversationId: conversationId.toString(),
            messageId: messageId.toString(),
            deleteType: "everyone",
            message: messageDto,
        });
    } catch (e) {
        console.error("Delete message for everyone error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to delete message for everyone",
        });
    }
};

// ==========================================
// 8. CLEAR CHAT HISTORY FOR USER
// ==========================================
const clearChat = async (req, res) => {
    const { conversationId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation ID",
        });
    }

    try {
        const userObjId = mongoose.Types.ObjectId.isValid(req.user._id)
            ? new mongoose.Types.ObjectId(req.user._id.toString())
            : req.user._id;
        const convObjId = mongoose.Types.ObjectId.isValid(conversationId)
            ? new mongoose.Types.ObjectId(conversationId.toString())
            : conversationId;

        const conversation = await Conversation.findById(convObjId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => (p?._id || p).toString() === userObjId.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to clear this chat",
            });
        }

        const now = new Date();

        if (!Array.isArray(conversation.clearedAt)) {
            conversation.clearedAt = [];
        }
        conversation.clearedAt = conversation.clearedAt.filter(
            (c) => (c.user?._id || c.user)?.toString() !== userObjId.toString()
        );
        conversation.clearedAt.push({ user: userObjId, at: now });
        await conversation.save();

        await Message.updateMany(
            { conversation: convObjId },
            { $addToSet: { deletedFor: userObjId } }
        );

        const io = req.app?.get("io") || getIO();
        if (io) {
            io.to(`user:${userObjId.toString()}`).emit("chat:cleared", {
                conversationId: conversationId.toString(),
                clearedAt: now,
            });

            calculateUserUnreadCount(userObjId)
                .then((counts) => {
                    io.to(`user:${userObjId.toString()}`).emit("chat:unread-count", counts);
                })
                .catch(() => {});
        }

        return res.status(httpStatus.OK).json({
            success: true,
            conversationId: conversationId.toString(),
            message: "Chat cleared successfully",
        });
    } catch (e) {
        console.error("Clear chat error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to clear chat",
        });
    }
};

// ==========================================
// 9. DELETE CHAT (HIDE CONVERSATION FOR USER)
// ==========================================
const deleteChat = async (req, res) => {
    const { conversationId } = req.params;

    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid conversation ID",
        });
    }

    try {
        const userObjId = mongoose.Types.ObjectId.isValid(req.user._id)
            ? new mongoose.Types.ObjectId(req.user._id.toString())
            : req.user._id;
        const convObjId = mongoose.Types.ObjectId.isValid(conversationId)
            ? new mongoose.Types.ObjectId(conversationId.toString())
            : conversationId;

        const conversation = await Conversation.findById(convObjId);
        if (!conversation) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Conversation not found",
            });
        }

        const isParticipant = conversation.participants.some(
            (p) => (p?._id || p).toString() === userObjId.toString()
        );
        if (!isParticipant) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "You are not authorized to delete this conversation",
            });
        }

        const now = new Date();

        if (!Array.isArray(conversation.hiddenFor)) {
            conversation.hiddenFor = [];
        }
        if (!conversation.hiddenFor.some((id) => (id?._id || id)?.toString() === userObjId.toString())) {
            conversation.hiddenFor.push(userObjId);
        }

        if (!Array.isArray(conversation.clearedAt)) {
            conversation.clearedAt = [];
        }
        conversation.clearedAt = conversation.clearedAt.filter(
            (c) => (c.user?._id || c.user)?.toString() !== userObjId.toString()
        );
        conversation.clearedAt.push({ user: userObjId, at: now });
        await conversation.save();

        await Message.updateMany(
            { conversation: convObjId },
            { $addToSet: { deletedFor: userObjId } }
        );

        const io = req.app?.get("io") || getIO();
        if (io) {
            io.to(`user:${userObjId.toString()}`).emit("chat:deleted", {
                conversationId: conversationId.toString(),
            });

            calculateUserUnreadCount(userObjId)
                .then((counts) => {
                    io.to(`user:${userObjId.toString()}`).emit("chat:unread-count", counts);
                })
                .catch(() => {});
        }

        return res.status(httpStatus.OK).json({
            success: true,
            conversationId: conversationId.toString(),
            message: "Conversation deleted successfully",
        });
    } catch (e) {
        console.error("Delete chat error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to delete conversation",
        });
    }
};

export {
    getConversations,
    getUnreadMessageCount,
    calculateUserUnreadCount,
    getOrCreateConversationByMatch,
    getMessages,
    markConversationAsRead,
    sendMessageRest,
    deleteMessageForMe,
    deleteMessageForEveryone,
    clearChat,
    deleteChat,
};


