import httpStatus from "http-status";
import mongoose from "mongoose";
import { Report, REPORT_STATUSES, REPORT_ACTIONS } from "../models/report.model.js";
import { User } from "../models/user.model.js";
import { revokeUserSessions } from "./socketManager.js";

/**
 * GET /api/v1/moderation/reports
 * List reports with optional status filtering and pagination.
 */
export const listReportsHandler = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        const filter = {};
        if (req.query.status && REPORT_STATUSES.includes(req.query.status)) {
            filter.status = req.query.status;
        }

        const total = await Report.countDocuments(filter);
        const reports = await Report.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: "reporter",
                select: "name photos email role",
            })
            .populate({
                path: "reportedUser",
                select: "name photos email role isProfileComplete",
            })
            .populate({
                path: "reviewedBy",
                select: "name",
            });

        return res.status(httpStatus.OK).json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            reports,
        });
    } catch (e) {
        console.error("List moderation reports error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to list moderation reports.",
        });
    }
};

/**
 * GET /api/v1/moderation/reports/:reportId
 * Retrieve detailed report by ID.
 */
export const getReportDetailsHandler = async (req, res) => {
    const { reportId } = req.params;

    if (!reportId || !mongoose.Types.ObjectId.isValid(reportId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid report ID.",
        });
    }

    try {
        const report = await Report.findById(reportId)
            .populate({
                path: "reporter",
                select: "name photos email role",
            })
            .populate({
                path: "reportedUser",
                select: "name photos email role isProfileComplete",
            })
            .populate({
                path: "reviewedBy",
                select: "name",
            });

        if (!report) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Moderation report not found.",
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            report,
        });
    } catch (e) {
        console.error("Get report details error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve report details.",
        });
    }
};

/**
 * PATCH /api/v1/moderation/reports/:reportId
 * Update moderation report status, resolution notes, and optionally enforce account actions (ban/suspend).
 */
export const updateReportStatusHandler = async (req, res) => {
    const { reportId } = req.params;
    const { status, resolutionNotes, action, actionReason, suspensionDurationHours } = req.body;

    if (!reportId || !mongoose.Types.ObjectId.isValid(reportId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid report ID.",
        });
    }

    if (!status || !REPORT_STATUSES.includes(status)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: `Invalid status. Must be one of: ${REPORT_STATUSES.join(", ")}`,
        });
    }

    if (action && !REPORT_ACTIONS.includes(action)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: `Invalid action. Must be one of: ${REPORT_ACTIONS.join(", ")}`,
        });
    }

    try {
        const report = await Report.findById(reportId);
        if (!report) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Moderation report not found.",
            });
        }

        report.status = status;
        if (resolutionNotes !== undefined) {
            report.resolutionNotes = resolutionNotes;
        }
        report.reviewedBy = req.user?._id || null;
        report.reviewedAt = new Date();

        // Account-level enforcement if action is specified
        if (action && action !== "none") {
            const reportedUser = await User.findById(report.reportedUser);
            if (!reportedUser) {
                return res.status(httpStatus.NOT_FOUND).json({
                    success: false,
                    message: "Reported user account not found.",
                });
            }

            // Anti-escalation & privilege protection: moderators cannot moderate staff/admins
            const actorRole = req.user?.role || "moderator";
            if (actorRole !== "admin" && (reportedUser.role === "admin" || reportedUser.role === "moderator")) {
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    message: "Access forbidden. Moderators cannot enforce moderation actions against other staff members.",
                });
            }

            const effectiveReason = String(actionReason || resolutionNotes || `Report ${reportId} resolved with ${action}`).trim();

            if (action === "ban") {
                reportedUser.status = "banned";
                reportedUser.bannedAt = new Date();
                reportedUser.banReason = effectiveReason;
                await reportedUser.save();

                report.action = "ban";
                report.actionReason = effectiveReason;
                report.actionTakenAt = new Date();
                report.actionTakenBy = req.user?._id || null;

                // Real-time session revocation: disconnect sockets, terminate calls, leave queues
                await revokeUserSessions(reportedUser._id, "banned", effectiveReason);
            } else if (action === "suspend") {
                const hours = Math.max(1, Math.min(8760, Number(suspensionDurationHours) || 24));
                const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

                reportedUser.status = "suspended";
                reportedUser.suspensionExpiresAt = expiresAt;
                reportedUser.suspensionReason = effectiveReason;
                await reportedUser.save();

                report.action = "suspend";
                report.actionReason = effectiveReason;
                report.suspensionDurationHours = hours;
                report.suspensionExpiresAt = expiresAt;
                report.actionTakenAt = new Date();
                report.actionTakenBy = req.user?._id || null;

                // Real-time session revocation: disconnect sockets, terminate calls, leave queues
                await revokeUserSessions(reportedUser._id, "suspended", effectiveReason);
            } else if (action === "warn") {
                report.action = "warn";
                report.actionReason = effectiveReason;
                report.actionTakenAt = new Date();
                report.actionTakenBy = req.user?._id || null;
            } else if (action === "dismiss") {
                report.action = "dismiss";
                report.actionReason = effectiveReason;
                report.actionTakenAt = new Date();
                report.actionTakenBy = req.user?._id || null;
            }
        }

        await report.save();

        await report.populate([
            { path: "reporter", select: "name photos email" },
            { path: "reportedUser", select: "name photos email status suspensionExpiresAt bannedAt" },
            { path: "reviewedBy", select: "name" },
        ]);

        return res.status(httpStatus.OK).json({
            success: true,
            message: `Report marked as ${status}${action && action !== "none" ? ` with action ${action}` : ""}.`,
            report,
        });
    } catch (e) {
        console.error("Update report status error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to update report status.",
        });
    }
};

/**
 * POST /api/v1/moderation/users/:userId/ban
 * Direct user ban by moderator/admin.
 */
export const banUserHandler = async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid user ID.",
        });
    }

    try {
        const targetUser = await User.findById(userId);
        if (!targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found.",
            });
        }

        // Anti-escalation check
        const actorRole = req.user?.role || "moderator";
        if (actorRole !== "admin" && (targetUser.role === "admin" || targetUser.role === "moderator")) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "Access forbidden. Moderators cannot ban other staff members.",
            });
        }

        const effectiveReason = (reason && String(reason).trim()) || "Account permanently banned by moderation.";

        targetUser.status = "banned";
        targetUser.bannedAt = new Date();
        targetUser.banReason = effectiveReason;
        targetUser.suspensionExpiresAt = null;
        targetUser.suspensionReason = null;
        await targetUser.save();

        await revokeUserSessions(targetUser._id, "banned", effectiveReason);

        return res.status(httpStatus.OK).json({
            success: true,
            message: `User ${targetUser.username} has been permanently banned.`,
            user: {
                _id: targetUser._id,
                username: targetUser.username,
                status: targetUser.status,
                bannedAt: targetUser.bannedAt,
                banReason: targetUser.banReason,
            },
        });
    } catch (e) {
        console.error("Ban user error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to ban user.",
        });
    }
};

/**
 * POST /api/v1/moderation/users/:userId/suspend
 * Direct user temporary suspension by moderator/admin.
 */
export const suspendUserHandler = async (req, res) => {
    const { userId } = req.params;
    const { durationHours, reason } = req.body;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid user ID.",
        });
    }

    const hours = Math.max(1, Math.min(8760, Number(durationHours) || 24));
    const effectiveReason = (reason && String(reason).trim()) || "Account temporarily suspended by moderation.";
    const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

    try {
        const targetUser = await User.findById(userId);
        if (!targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found.",
            });
        }

        // Anti-escalation check
        const actorRole = req.user?.role || "moderator";
        if (actorRole !== "admin" && (targetUser.role === "admin" || targetUser.role === "moderator")) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: "Access forbidden. Moderators cannot suspend other staff members.",
            });
        }

        targetUser.status = "suspended";
        targetUser.suspensionExpiresAt = expiresAt;
        targetUser.suspensionReason = effectiveReason;
        await targetUser.save();

        await revokeUserSessions(targetUser._id, "suspended", effectiveReason);

        return res.status(httpStatus.OK).json({
            success: true,
            message: `User ${targetUser.username} has been suspended for ${hours} hours.`,
            user: {
                _id: targetUser._id,
                username: targetUser.username,
                status: targetUser.status,
                suspensionExpiresAt: targetUser.suspensionExpiresAt,
                suspensionReason: targetUser.suspensionReason,
            },
        });
    } catch (e) {
        console.error("Suspend user error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to suspend user.",
        });
    }
};

/**
 * POST /api/v1/moderation/users/:userId/reinstate
 * Reinstates a banned or suspended user to active status.
 */
export const reinstateUserHandler = async (req, res) => {
    const { userId } = req.params;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid user ID.",
        });
    }

    try {
        const targetUser = await User.findById(userId);
        if (!targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found.",
            });
        }

        targetUser.status = "active";
        targetUser.suspensionExpiresAt = null;
        targetUser.suspensionReason = null;
        targetUser.bannedAt = null;
        targetUser.banReason = null;
        await targetUser.save();

        return res.status(httpStatus.OK).json({
            success: true,
            message: `User ${targetUser.username} has been reinstated to active status.`,
            user: {
                _id: targetUser._id,
                username: targetUser.username,
                status: targetUser.status,
            },
        });
    } catch (e) {
        console.error("Reinstate user error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to reinstate user.",
        });
    }
};


