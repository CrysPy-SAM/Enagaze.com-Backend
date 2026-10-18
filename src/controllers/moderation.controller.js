import httpStatus from "http-status";
import mongoose from "mongoose";
import { Report, REPORT_STATUSES } from "../models/report.model.js";

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
 * Update moderation report status and resolution notes.
 */
export const updateReportStatusHandler = async (req, res) => {
    const { reportId } = req.params;
    const { status, resolutionNotes } = req.body;

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

        await report.save();

        await report.populate([
            { path: "reporter", select: "name photos email" },
            { path: "reportedUser", select: "name photos email" },
            { path: "reviewedBy", select: "name" },
        ]);

        return res.status(httpStatus.OK).json({
            success: true,
            message: `Report marked as ${status}.`,
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

