import mongoose from "mongoose";
import { Block } from "../models/block.model.js";
import { Report, REPORT_CATEGORIES, REPORT_CONTEXTS } from "../models/report.model.js";
import { Match } from "../models/match.model.js";
import { Conversation } from "../models/conversation.model.js";
import { User } from "../models/user.model.js";
import { endActiveCallBetweenUsers } from "../controllers/randomCallManager.js";
import { getIO } from "../controllers/socketManager.js";

/**
 * Check if two users have a bidirectional block relationship
 */
export async function isBlockedBidirectional(userIdA, userIdB) {
    return Block.isBlockedBidirectional(userIdA, userIdB);
}

/**
 * Retrieve all user IDs blocked by or blocking a given user
 */
export async function getBlockedUserIds(userId) {
    return Block.getBlockedUserIds(userId);
}

/**
 * Block a target user (idempotent, breaks matches, cleans up calls and chat)
 */
export async function blockUser(blockerId, blockedId, reason = "") {
    if (!blockerId || !blockedId) {
        throw new Error("Both blockerId and blockedId are required");
    }

    const blockerStr = blockerId.toString();
    const blockedStr = blockedId.toString();

    if (blockerStr === blockedStr) {
        const err = new Error("You cannot block your own account");
        err.statusCode = 400;
        throw err;
    }

    if (!mongoose.Types.ObjectId.isValid(blockedId)) {
        const err = new Error("Invalid target user ID");
        err.statusCode = 400;
        throw err;
    }

    // Verify target user exists
    const targetUser = await User.findById(blockedId).select("_id");
    if (!targetUser) {
        const err = new Error("Target user not found");
        err.statusCode = 404;
        throw err;
    }

    // 1. Persist block record (upsert for idempotency)
    const blockRecord = await Block.findOneAndUpdate(
        { blocker: blockerId, blocked: blockedId },
        {
            $setOnInsert: {
                blocker: blockerId,
                blocked: blockedId,
                reason: String(reason || "").trim().slice(0, 500),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 2. Break any active mutual match between the two users
    const userPair = Match.getCanonicalPair(blockerId, blockedId);
    const existingMatch = await Match.findOne({ userPair });

    if (existingMatch && existingMatch.status !== "unmatched") {
        existingMatch.status = "unmatched";
        existingMatch.unmatchedBy = blockerId;
        existingMatch.unmatchedAt = new Date();
        await existingMatch.save();
    }

    // 3. Terminate any active random video call between them immediately with neutral reason
    const io = getIO();
    if (io) {
        endActiveCallBetweenUsers(blockerId, blockedId, io);

        // Notify socket rooms neutrally to remove match from live UI without disclosing block details
        if (existingMatch) {
            io.to(`user:${blockedStr}`).emit("match:unmatched", {
                matchId: existingMatch._id,
            });
            io.to(`user:${blockerStr}`).emit("match:unmatched", {
                matchId: existingMatch._id,
            });
        }
    }

    return {
        success: true,
        block: blockRecord,
    };
}

/**
 * Unblock a target user
 */
export async function unblockUser(blockerId, blockedId) {
    if (!blockerId || !blockedId) {
        throw new Error("Both blockerId and blockedId are required");
    }

    const blockerStr = blockerId.toString();
    const blockedStr = blockedId.toString();

    if (blockerStr === blockedStr) {
        const err = new Error("Invalid user ID");
        err.statusCode = 400;
        throw err;
    }

    if (!mongoose.Types.ObjectId.isValid(blockedId)) {
        const err = new Error("Invalid target user ID");
        err.statusCode = 400;
        throw err;
    }

    const result = await Block.deleteOne({ blocker: blockerId, blocked: blockedId });

    return {
        success: true,
        unblocked: result.deletedCount > 0,
    };
}

/**
 * Report a user with context, category, and audit metadata
 */
export async function reportUser(reporterId, reportedUserId, payload = {}) {
    const { category, reason = "", context, conversationId, callId } = payload;

    if (!reporterId || !reportedUserId) {
        throw new Error("Both reporterId and reportedUserId are required");
    }

    const reporterStr = reporterId.toString();
    const reportedStr = reportedUserId.toString();

    if (reporterStr === reportedStr) {
        const err = new Error("You cannot submit a report against yourself");
        err.statusCode = 400;
        throw err;
    }

    if (!mongoose.Types.ObjectId.isValid(reportedUserId)) {
        const err = new Error("Invalid reported user ID");
        err.statusCode = 400;
        throw err;
    }

    if (!category || !REPORT_CATEGORIES.includes(category)) {
        const err = new Error(`Category must be one of: ${REPORT_CATEGORIES.join(", ")}`);
        err.statusCode = 400;
        throw err;
    }

    if (!context || !REPORT_CONTEXTS.includes(context)) {
        const err = new Error(`Context must be one of: ${REPORT_CONTEXTS.join(", ")}`);
        err.statusCode = 400;
        throw err;
    }

    // Verify reported user exists
    const reportedUser = await User.findById(reportedUserId).select("_id");
    if (!reportedUser) {
        const err = new Error("Reported user profile not found");
        err.statusCode = 404;
        throw err;
    }

    // If conversationId is provided, verify reporter is actually a participant
    let validatedConvId = null;
    if (conversationId) {
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            const err = new Error("Invalid conversation ID reference");
            err.statusCode = 400;
            throw err;
        }

        const conv = await Conversation.findById(conversationId);
        if (!conv) {
            const err = new Error("Referenced conversation not found");
            err.statusCode = 404;
            throw err;
        }

        const isParticipant = conv.participants.some(
            (p) => p.toString() === reporterStr
        );
        if (!isParticipant) {
            const err = new Error("You cannot report on a conversation you are not a participant in");
            err.statusCode = 403;
            throw err;
        }
        validatedConvId = conv._id;
    }

    // Persist report without sensitive dumps
    const newReport = new Report({
        reporter: reporterId,
        reportedUser: reportedUserId,
        category,
        reason: String(reason || "").trim().slice(0, 1000),
        context,
        conversation: validatedConvId,
        callId: callId ? String(callId).trim().slice(0, 100) : null,
        status: "pending",
    });

    await newReport.save();

    return {
        success: true,
        reportId: newReport._id,
        report: newReport,
        message: "Report submitted successfully. Our safety team will review it.",
    };
}

/**
 * Unmatch a mutual match relationship
 */
export async function unmatch(actingUserId, matchId) {
    if (!actingUserId || !matchId) {
        throw new Error("actingUserId and matchId are required");
    }

    if (!mongoose.Types.ObjectId.isValid(matchId)) {
        const err = new Error("Invalid match ID");
        err.statusCode = 400;
        err.status = 400;
        throw err;
    }

    const match = await Match.findById(matchId);
    if (!match) {
        const err = new Error("Match not found");
        err.statusCode = 404;
        err.status = 404;
        throw err;
    }

    const isParticipant = match.users.some(
        (u) => u.toString() === actingUserId.toString()
    );
    if (!isParticipant) {
        const err = new Error("You are not authorized to unmatch this relationship");
        err.statusCode = 403;
        err.status = 403;
        throw err;
    }

    // Idempotent: if already unmatched, return success
    if (match.status === "unmatched") {
        return {
            success: true,
            message: "Match is already unmatched",
            matchId: match._id,
            match,
        };
    }

    match.status = "unmatched";
    match.unmatchedBy = actingUserId;
    match.unmatchedAt = new Date();
    await match.save();

    // Notify other participant neutrally to update their matches list
    const io = getIO();
    if (io) {
        for (const user of match.users) {
            io.to(`user:${user.toString()}`).emit("match:unmatched", {
                matchId: match._id,
            });
        }
    }

    return {
        success: true,
        message: "Unmatched successfully",
        matchId: match._id,
        match,
    };
}
