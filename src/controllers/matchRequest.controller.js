import httpStatus from "http-status";
import mongoose from "mongoose";
import { MatchRequest } from "../models/matchRequest.model.js";
import { Match } from "../models/match.model.js";
import { Conversation } from "../models/conversation.model.js";
import { User } from "../models/user.model.js";
import { Block } from "../models/block.model.js";
import { findOrCreateCanonicalMatchAndConversation } from "../services/matching.service.js";
import {
    createNotification,
    supersedeMatchRequestNotifications,
    getUnreadNotificationCounts,
} from "../services/notification.service.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import { safeLean } from "../utils/queryHelper.js";
import { getIO } from "./socketManager.js";

// ==========================================
// 1. SEND MATCH REQUEST (A -> B)
// ==========================================
export const sendMatchRequest = async (req, res) => {
    const targetUserId = req.body.recipientId || req.body.targetUserId;
    const message = req.body.message;

    // 1. Validate targetUserId
    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid target user ID",
        });
    }

    // 2. Reject self-requests
    if (targetUserId.toString() === req.user._id.toString()) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "You cannot send a match request to yourself",
        });
    }

    // 3. Verify sender eligibility
    const senderEligibility = checkUserEligibility(req.user);
    if (!senderEligibility.isEligible) {
        return res.status(httpStatus.FORBIDDEN).json({
            success: false,
            code: senderEligibility.code,
            message: senderEligibility.reason,
            missingFields: senderEligibility.missingFields,
        });
    }

    try {
        // 4. Verify target user exists and is eligible
        const targetUser = await User.findById(targetUserId).select(
            "name dob gender bio photos interests isProfileComplete"
        );
        if (!targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Target profile not found",
            });
        }

        const targetEligibility = checkUserEligibility(targetUser);
        if (!targetEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "TARGET_INELIGIBLE",
                message: "Target profile is not eligible for discovery interactions.",
            });
        }

        // 5. Enforce bidirectional block check
        const isBlocked = await Block.isBlockedBidirectional(req.user._id, targetUserId);
        if (isBlocked) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "BLOCKED_USER",
                message: "Interaction not permitted.",
            });
        }

        // 6. Verify not previously unmatched
        const userPair = Match.getCanonicalPair(req.user._id, targetUserId);
        const existingMatchRecord = await Match.findOne({ userPair });
        if (existingMatchRecord && existingMatchRecord.status === "unmatched") {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "MATCH_UNMATCHED",
                message: "This profile was previously unmatched.",
            });
        }

        // 7. Check if already actively connected
        if (existingMatchRecord && existingMatchRecord.status === "active") {
            const conversation = await Conversation.findOne({ match: existingMatchRecord._id });
            return res.status(httpStatus.OK).json({
                success: true,
                isConnected: true,
                message: "You are already connected with this user",
                match: {
                    _id: existingMatchRecord._id,
                    matchedUser: toPublicProfile(targetUser),
                    conversationId: conversation?._id,
                    createdAt: existingMatchRecord.createdAt,
                },
            });
        }

        // 8. Check existing requests from sender to target
        const existingOutRequest = await MatchRequest.findOne({
            sender: req.user._id,
            recipient: targetUserId,
        }).sort({ createdAt: -1 });

        if (existingOutRequest) {
            if (existingOutRequest.status === "pending") {
                return res.status(httpStatus.OK).json({
                    success: true,
                    duplicate: true,
                    message: "Match request is already pending",
                    request: {
                        _id: existingOutRequest._id,
                        recipient: toPublicProfile(targetUser),
                        status: "pending",
                        createdAt: existingOutRequest.createdAt,
                    },
                });
            }

            if (existingOutRequest.status === "accepted") {
                const activeMatch = await Match.findOne({ userPair, status: "active" });
                const conv = activeMatch ? await Conversation.findOne({ match: activeMatch._id }) : null;
                return res.status(httpStatus.OK).json({
                    success: true,
                    isConnected: true,
                    message: "You are already connected with this user",
                    match: activeMatch ? {
                        _id: activeMatch._id,
                        matchedUser: toPublicProfile(targetUser),
                        conversationId: conv?._id,
                        createdAt: activeMatch.createdAt,
                    } : null,
                });
            }

            if (existingOutRequest.status === "declined") {
                return res.status(httpStatus.CONFLICT).json({
                    success: false,
                    code: "REQUEST_DECLINED",
                    message: "Match request was previously declined.",
                });
            }
        }

        // 9. Check if target user has already sent a pending request to current user
        const reverseRequest = await MatchRequest.findOne({
            sender: targetUserId,
            recipient: req.user._id,
            status: "pending",
        });

        if (reverseRequest) {
            // Mutual consent achieved! Atomically accept reverse request and establish connection
            await MatchRequest.findOneAndUpdate(
                { _id: reverseRequest._id },
                { status: "accepted", respondedAt: new Date() }
            );

            const { match, conversation } = await findOrCreateCanonicalMatchAndConversation(
                req.user._id,
                targetUserId
            );

            const io = req.app?.get("io") || getIO();
            await Promise.allSettled([
                createNotification({
                    recipient: targetUserId,
                    sender: req.user._id,
                    type: "match_accepted",
                    data: { matchId: match._id, conversationId: conversation._id, requestId: reverseRequest._id },
                    io,
                }),
                supersedeMatchRequestNotifications(req.user._id, targetUserId),
            ]);

            if (io) {
                const currentUserPublic = toPublicProfile(req.user);
                const targetUserPublic = toPublicProfile(targetUser);

                io.to(`user:${targetUserId.toString()}`).emit("match:accepted", {
                    requestId: reverseRequest._id,
                    matchId: match._id,
                    conversationId: conversation._id,
                    partner: currentUserPublic,
                });
                io.to(`user:${targetUserId.toString()}`).emit("match:new", {
                    match: {
                        _id: match._id,
                        matchedUser: currentUserPublic,
                        conversationId: conversation._id,
                        createdAt: match.createdAt,
                    },
                });
                io.to(`user:${req.user._id.toString()}`).emit("match:new", {
                    match: {
                        _id: match._id,
                        matchedUser: targetUserPublic,
                        conversationId: conversation._id,
                        createdAt: match.createdAt,
                    },
                });
            }

            return res.status(httpStatus.OK).json({
                success: true,
                isConnected: true,
                isMatch: true,
                message: "Mutual match connection established!",
                match: {
                    _id: match._id,
                    matchedUser: toPublicProfile(targetUser),
                    conversationId: conversation._id,
                    createdAt: match.createdAt,
                },
            });
        }

        // 10. Create new pending Match Request with duplicate-key recovery
        let newRequest;
        const sanitizedMsg = typeof message === "string" ? message.trim().slice(0, 200) : "";
        try {
            newRequest = await MatchRequest.create({
                sender: req.user._id,
                recipient: targetUserId,
                userPair,
                status: "pending",
                message: sanitizedMsg,
            });
        } catch (e) {
            if (e.code === 11000) {
                const concurrentReq = await MatchRequest.findOne({
                    sender: req.user._id,
                    recipient: targetUserId,
                    status: "pending",
                });
                if (concurrentReq) {
                    return res.status(httpStatus.OK).json({
                        success: true,
                        duplicate: true,
                        message: "Match request is already pending",
                        request: {
                            _id: concurrentReq._id,
                            recipient: toPublicProfile(targetUser),
                            status: "pending",
                            createdAt: concurrentReq.createdAt,
                        },
                    });
                }
            }
            throw e;
        }

        // 11. Notify recipient via in-app persistent notification and socket event
        const io = req.app?.get("io") || getIO();
        await createNotification({
            recipient: targetUserId,
            sender: req.user._id,
            type: "match_request",
            data: { requestId: newRequest._id },
            io,
        });

        if (io) {
            io.to(`user:${targetUserId.toString()}`).emit("match_request:new", {
                request: {
                    _id: newRequest._id,
                    sender: toPublicProfile(req.user),
                    status: "pending",
                    message: newRequest.message,
                    createdAt: newRequest.createdAt,
                },
            });
            try {
                const counts = await getUnreadNotificationCounts(targetUserId);
                io.to(`user:${targetUserId.toString()}`).emit("notification:counts", {
                    unreadCount: counts.total,
                    unreadLikesCount: counts.likes,
                    unreadRequestsCount: counts.requests,
                });
            } catch (_) {}
        }

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: "Match request sent successfully",
            request: {
                _id: newRequest._id,
                recipient: toPublicProfile(targetUser),
                status: "pending",
                message: newRequest.message,
                createdAt: newRequest.createdAt,
            },
        });
    } catch (e) {
        console.error("Send match request error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to send match request",
        });
    }
};

// ==========================================
// 2. GET INCOMING MATCH REQUESTS (Pending)
// ==========================================
export const getIncomingMatchRequests = async (req, res) => {
    try {
        const viewerEligibility = checkUserEligibility(req.user);
        if (!viewerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: viewerEligibility.code,
                message: viewerEligibility.reason,
                missingFields: viewerEligibility.missingFields,
            });
        }

        const blockedUserIds = await Block.getBlockedUserIds(req.user._id);

        const requests = await safeLean(
            MatchRequest.find({
                recipient: req.user._id,
                status: "pending",
                sender: { $nin: blockedUserIds },
            })
                .sort({ createdAt: -1 })
                .populate({
                    path: "sender",
                    select: "name dob gender bio photos interests isProfileComplete",
                })
        );

        const formatted = requests
            .filter((r) => r.sender && checkUserEligibility(r.sender).isEligible)
            .map((r) => ({
                _id: r._id,
                sender: toPublicProfile(r.sender),
                status: r.status,
                message: r.message,
                createdAt: r.createdAt,
            }));

        return res.status(httpStatus.OK).json({
            success: true,
            count: formatted.length,
            requests: formatted,
        });
    } catch (e) {
        console.error("Get incoming match requests error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve incoming match requests",
        });
    }
};

// ==========================================
// 3. GET OUTGOING MATCH REQUESTS (Pending)
// ==========================================
export const getOutgoingMatchRequests = async (req, res) => {
    try {
        const viewerEligibility = checkUserEligibility(req.user);
        if (!viewerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: viewerEligibility.code,
                message: viewerEligibility.reason,
                missingFields: viewerEligibility.missingFields,
            });
        }

        const blockedUserIds = await Block.getBlockedUserIds(req.user._id);

        const requests = await safeLean(
            MatchRequest.find({
                sender: req.user._id,
                status: "pending",
                recipient: { $nin: blockedUserIds },
            })
                .sort({ createdAt: -1 })
                .populate({
                    path: "recipient",
                    select: "name dob gender bio photos interests isProfileComplete",
                })
        );

        const formatted = requests
            .filter((r) => r.recipient && checkUserEligibility(r.recipient).isEligible)
            .map((r) => ({
                _id: r._id,
                recipient: toPublicProfile(r.recipient),
                status: r.status,
                message: r.message,
                createdAt: r.createdAt,
            }));

        return res.status(httpStatus.OK).json({
            success: true,
            count: formatted.length,
            requests: formatted,
        });
    } catch (e) {
        console.error("Get outgoing match requests error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve outgoing match requests",
        });
    }
};

// ==========================================
// 4. ACCEPT MATCH REQUEST (B accepts A's request)
// ==========================================
export const acceptMatchRequest = async (req, res) => {
    const { requestId } = req.params;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid match request ID",
        });
    }

    try {
        const matchRequest = await MatchRequest.findById(requestId).populate(
            "sender recipient"
        );

        if (!matchRequest) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Match request not found",
            });
        }

        // 1. Authoritative Recipient Validation: Only intended recipient can accept
        const recipientId = matchRequest.recipient?._id
            ? matchRequest.recipient._id.toString()
            : matchRequest.recipient.toString();

        if (recipientId !== req.user._id.toString()) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "UNAUTHORIZED_RECIPIENT",
                message: "You are not authorized to accept this match request.",
            });
        }

        const senderUser = matchRequest.sender;
        const senderId = senderUser?._id
            ? senderUser._id.toString()
            : matchRequest.sender.toString();

        // 2. Idempotent acceptance retry
        if (matchRequest.status === "accepted") {
            const { match, conversation } = await findOrCreateCanonicalMatchAndConversation(
                senderId,
                req.user._id
            );
            return res.status(httpStatus.OK).json({
                success: true,
                duplicate: true,
                isConnected: true,
                message: "Match request is already accepted",
                match: {
                    _id: match._id,
                    matchedUser: toPublicProfile(senderUser),
                    conversationId: conversation?._id,
                    createdAt: match.createdAt,
                },
            });
        }

        // 3. State transition validation: Only pending requests can be accepted
        if (matchRequest.status !== "pending") {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                code: "INVALID_STATE_TRANSITION",
                message: `Cannot accept match request with status: ${matchRequest.status}`,
            });
        }

        // 4. Enforce block check
        const isBlocked = await Block.isBlockedBidirectional(req.user._id, senderId);
        if (isBlocked) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "BLOCKED_USER",
                message: "Interaction not permitted.",
            });
        }

        // 5. Enforce eligibility of both participants
        const recipientElig = checkUserEligibility(req.user);
        if (!recipientElig.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: recipientElig.code,
                message: recipientElig.reason,
            });
        }

        const senderElig = checkUserEligibility(senderUser);
        if (!senderElig.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "SENDER_INELIGIBLE",
                message: "Sender profile is no longer eligible.",
            });
        }

        // 6. Atomically transition status to 'accepted'
        const updatedRequest = await MatchRequest.findOneAndUpdate(
            { _id: requestId, recipient: req.user._id, status: "pending" },
            { status: "accepted", respondedAt: new Date() },
            { new: true }
        );

        if (!updatedRequest) {
            // Concurrent acceptance race
            const checkCurrent = await MatchRequest.findById(requestId);
            if (checkCurrent && checkCurrent.status === "accepted") {
                const { match, conversation } = await findOrCreateCanonicalMatchAndConversation(
                    senderId,
                    req.user._id
                );
                return res.status(httpStatus.OK).json({
                    success: true,
                    duplicate: true,
                    isConnected: true,
                    message: "Match request is already accepted",
                    match: {
                        _id: match._id,
                        matchedUser: toPublicProfile(senderUser),
                        conversationId: conversation?._id,
                        createdAt: match.createdAt,
                    },
                });
            }
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                code: "INVALID_STATE_TRANSITION",
                message: "Failed to accept request due to concurrent modification",
            });
        }

        // 7. Establish canonical Match & Conversation (idempotent, race-safe)
        const { match, conversation } = await findOrCreateCanonicalMatchAndConversation(
            senderId,
            req.user._id
        );

        // 8. Notifications & Socket.IO events
        const io = req.app?.get("io") || getIO();
        await Promise.allSettled([
            createNotification({
                recipient: senderId,
                sender: req.user._id,
                type: "match_accepted",
                data: { matchId: match._id, conversationId: conversation._id, requestId: matchRequest._id },
                io,
            }),
            supersedeMatchRequestNotifications(req.user._id, senderId),
        ]);

        if (io) {
            const senderPublic = toPublicProfile(senderUser);
            const recipientPublic = toPublicProfile(req.user);

            // Notify Sender A that Request was accepted
            io.to(`user:${senderId}`).emit("match:accepted", {
                requestId: matchRequest._id,
                matchId: match._id,
                conversationId: conversation._id,
                partner: recipientPublic,
            });

            // Dual match:new events to integrate with active connections lists
            io.to(`user:${senderId}`).emit("match:new", {
                match: {
                    _id: match._id,
                    matchedUser: recipientPublic,
                    conversationId: conversation._id,
                    createdAt: match.createdAt,
                },
            });

            io.to(`user:${req.user._id.toString()}`).emit("match:new", {
                match: {
                    _id: match._id,
                    matchedUser: senderPublic,
                    conversationId: conversation._id,
                    createdAt: match.createdAt,
                },
            });

            // Match request accepted events to remove pending cards from requests feeds
            io.to(`user:${senderId}`).emit("match_request:accepted", {
                requestId: matchRequest._id,
            });
            io.to(`user:${req.user._id.toString()}`).emit("match_request:accepted", {
                requestId: matchRequest._id,
            });

            try {
                const [countsSender, countsRecipient] = await Promise.all([
                    getUnreadNotificationCounts(senderId),
                    getUnreadNotificationCounts(req.user._id),
                ]);
                io.to(`user:${senderId}`).emit("notification:counts", {
                    unreadCount: countsSender.total,
                    unreadLikesCount: countsSender.likes,
                    unreadRequestsCount: countsSender.requests,
                });
                io.to(`user:${req.user._id.toString()}`).emit("notification:counts", {
                    unreadCount: countsRecipient.total,
                    unreadLikesCount: countsRecipient.likes,
                    unreadRequestsCount: countsRecipient.requests,
                });
            } catch (_) {}
        }

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Match request accepted! Connection established.",
            isConnected: true,
            match: {
                _id: match._id,
                matchedUser: toPublicProfile(senderUser),
                conversationId: conversation._id,
                createdAt: match.createdAt,
            },
        });
    } catch (e) {
        console.error("Accept match request error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to accept match request",
        });
    }
};

// ==========================================
// 5. DECLINE MATCH REQUEST (B declines A's request)
// ==========================================
export const declineMatchRequest = async (req, res) => {
    const { requestId } = req.params;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid match request ID",
        });
    }

    try {
        const matchRequest = await MatchRequest.findById(requestId);

        if (!matchRequest) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Match request not found",
            });
        }

        // 1. Authoritative Recipient Validation: Only intended recipient can decline
        const recipientId = matchRequest.recipient.toString();
        if (recipientId !== req.user._id.toString()) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "UNAUTHORIZED_RECIPIENT",
                message: "You are not authorized to decline this match request.",
            });
        }

        // 2. Idempotent decline retry
        if (matchRequest.status === "declined") {
            return res.status(httpStatus.OK).json({
                success: true,
                duplicate: true,
                message: "Match request is already declined",
            });
        }

        // 3. State transition validation: Accepted requests cannot be declined
        if (matchRequest.status === "accepted") {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                code: "INVALID_STATE_TRANSITION",
                message: "An accepted connection cannot be declined as a request.",
            });
        }

        // 4. Atomically transition status to 'declined'
        await MatchRequest.findOneAndUpdate(
            { _id: requestId, recipient: req.user._id, status: "pending" },
            { status: "declined", respondedAt: new Date() }
        );

        // 5. Supersede pending match_request notifications
        await supersedeMatchRequestNotifications(req.user._id, matchRequest.sender);

        const io = req.app?.get("io") || getIO();
        if (io) {
            io.to(`user:${req.user._id.toString()}`).emit("match_request:declined", {
                requestId,
            });
            io.to(`user:${matchRequest.sender.toString()}`).emit("match_request:declined", {
                requestId,
            });
            try {
                const counts = await getUnreadNotificationCounts(req.user._id);
                io.to(`user:${req.user._id.toString()}`).emit("notification:counts", {
                    unreadCount: counts.total,
                    unreadLikesCount: counts.likes,
                    unreadRequestsCount: counts.requests,
                });
            } catch (_) {}
        }

        // Keep chat and video calling strictly locked; no Match record created
        return res.status(httpStatus.OK).json({
            success: true,
            message: "Match request declined",
        });
    } catch (e) {
        console.error("Decline match request error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to decline match request",
        });
    }
};
