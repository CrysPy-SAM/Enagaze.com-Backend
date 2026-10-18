import httpStatus from "http-status";
import mongoose from "mongoose";
import { Block } from "../models/block.model.js";
import { Match } from "../models/match.model.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";
import {
    blockUser,
    unblockUser,
    reportUser,
    unmatch,
} from "../services/safety.service.js";

/**
 * POST /api/v1/safety/block
 * Block a target user bidirectionally terminating active interactions.
 */
export const blockUserHandler = async (req, res) => {
    const targetUserId = req.body.userId || req.body.targetUserId;
    const reason = req.body.reason;

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "A valid target user ID is required to block.",
        });
    }

    if (targetUserId.toString() === req.user._id.toString()) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "You cannot block yourself.",
        });
    }

    try {
        const result = await blockUser(req.user._id, targetUserId, reason);
        return res.status(httpStatus.OK).json({
            success: true,
            message: "User blocked successfully.",
            block: result.block,
        });
    } catch (e) {
        console.error("Block user error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: e.message || "Failed to block user.",
        });
    }
};

/**
 * POST /api/v1/safety/unblock
 * Remove block on a target user.
 */
export const unblockUserHandler = async (req, res) => {
    const targetUserId = req.body.userId || req.body.targetUserId;

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "A valid target user ID is required to unblock.",
        });
    }

    try {
        const result = await unblockUser(req.user._id, targetUserId);
        return res.status(httpStatus.OK).json({
            success: true,
            message: result.unblocked ? "User unblocked successfully." : "User was not blocked.",
            unblocked: result.unblocked,
        });
    } catch (e) {
        console.error("Unblock user error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: e.message || "Failed to unblock user.",
        });
    }
};

/**
 * GET /api/v1/safety/blocked
 * Retrieve list of users currently blocked by the authenticated user.
 */
export const getBlockedUsersHandler = async (req, res) => {
    try {
        const blocks = await Block.find({ blocker: req.user._id })
            .sort({ createdAt: -1 })
            .populate({
                path: "blocked",
                select: "name photos dob gender bio interests isProfileComplete",
            });

        const blockedUsers = blocks
            .map((b) => {
                if (!b.blocked) return null;
                return {
                    _id: b.blocked._id,
                    user: toPublicProfile(b.blocked),
                    blockedAt: b.createdAt,
                    reason: b.reason || null,
                };
            })
            .filter(Boolean);

        return res.status(httpStatus.OK).json({
            success: true,
            total: blockedUsers.length,
            blockedUsers,
        });
    } catch (e) {
        console.error("Get blocked users error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve blocked users.",
        });
    }
};

/**
 * POST /api/v1/safety/report
 * Submit a safety moderation report against a user.
 */
export const reportUserHandler = async (req, res) => {
    const reportedUserId = req.body.reportedUserId || req.body.userId;
    const { category, reason, context, conversationId, callId } = req.body;

    if (!reportedUserId || !mongoose.Types.ObjectId.isValid(reportedUserId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "A valid reported user ID is required.",
        });
    }

    if (reportedUserId.toString() === req.user._id.toString()) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "You cannot report yourself.",
        });
    }

    if (!category) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Report category is required.",
        });
    }

    try {
        const result = await reportUser(req.user._id, reportedUserId, {
            category,
            reason,
            context,
            conversationId,
            callId,
        });

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: "Report submitted successfully. Thank you for helping keep our community safe.",
            reportId: result.report._id,
        });
    } catch (e) {
        const code = e.statusCode || e.status;
        if (code) {
            return res.status(code).json({
                success: false,
                message: e.message,
            });
        }
        console.error("Report user error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: e.message || "Failed to submit report.",
        });
    }
};

/**
 * POST /api/v1/safety/unmatch OR POST /api/v1/matches/:matchId/unmatch
 * Mark a mutual match as unmatched idempotently.
 */
export const unmatchHandler = async (req, res) => {
    let matchId = req.params.matchId || req.body.matchId;

    // Support unmatching by targetUserId if matchId is not explicitly passed
    if (!matchId && req.body.targetUserId) {
        if (!mongoose.Types.ObjectId.isValid(req.body.targetUserId)) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Invalid target user ID.",
            });
        }
        const pair = Match.getCanonicalPair(req.user._id, req.body.targetUserId);
        const existing = await Match.findOne({ userPair: pair }).select("_id");
        if (existing) {
            matchId = existing._id.toString();
        }
    }

    if (!matchId || !mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "A valid match ID or target user ID is required to unmatch.",
        });
    }

    try {
        const result = await unmatch(req.user._id, matchId);
        return res.status(httpStatus.OK).json({
            success: true,
            message: "Match has been unmatched successfully.",
            matchId: result.match._id,
            status: result.match.status,
        });
    } catch (e) {
        const code = e.statusCode || e.status;
        if (code) {
            return res.status(code).json({
                success: false,
                message: e.message,
            });
        }
        console.error("Unmatch error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: e.message || "Failed to unmatch.",
        });
    }
};
