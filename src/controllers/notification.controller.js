import httpStatus from "http-status";
import {
    getNotificationsForUser,
    getUnreadNotificationCount,
    getUnreadNotificationCounts,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    markNotificationsAsReadByType,
} from "../services/notification.service.js";
import { getIO } from "./socketManager.js";

/**
 * GET /api/v1/notifications
 * Paginated list of notifications for the authenticated user.
 */
export const getNotificationsHandler = async (req, res) => {
    try {
        const { page, limit, unreadOnly } = req.query;
        const result = await getNotificationsForUser(req.user._id, {
            page,
            limit,
            unreadOnly: unreadOnly === "true",
        });

        return res.status(httpStatus.OK).json({
            success: true,
            ...result,
        });
    } catch (error) {
        console.error("Error in getNotificationsHandler:", error);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve notifications",
        });
    }
};

/**
 * GET /api/v1/notifications/unread-count
 * Returns unread notification count for the authenticated user.
 */
export const getUnreadCountHandler = async (req, res) => {
    try {
        const counts = await getUnreadNotificationCounts(req.user._id);

        return res.status(httpStatus.OK).json({
            success: true,
            unreadCount: counts.total,
            unreadLikesCount: counts.likes,
            unreadRequestsCount: counts.requests,
        });
    } catch (error) {
        console.error("Error in getUnreadCountHandler:", error);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve unread count",
        });
    }
};

/**
 * PATCH /api/v1/notifications/:id/read
 * Marks a single notification as read.
 */
export const markAsReadHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const notification = await markNotificationAsRead(id, req.user._id);

        if (!notification) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Notification not found or access denied",
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            notification,
        });
    } catch (error) {
        console.error("Error in markAsReadHandler:", error);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to mark notification as read",
        });
    }
};

/**
 * PATCH /api/v1/notifications/read-all
 * Marks all notifications for the authenticated user as read.
 */
export const markAllAsReadHandler = async (req, res) => {
    try {
        const updatedCount = await markAllNotificationsAsRead(req.user._id);

        return res.status(httpStatus.OK).json({
            success: true,
            message: "All notifications marked as read",
            updatedCount,
        });
    } catch (error) {
        console.error("Error in markAllAsReadHandler:", error);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to mark all notifications as read",
        });
    }
};

/**
 * PATCH /api/v1/notifications/read-type/:type
 * Marks all notifications of a specific type (e.g. 'like', 'match_request') as read.
 */
export const markTypeAsReadHandler = async (req, res) => {
    try {
        const { type } = req.params;
        const validTypes = ["like", "match", "message", "match_request", "match_accepted", "missed_call"];
        if (!type || !validTypes.includes(type)) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: `Invalid notification type: ${type}`,
            });
        }

        const updatedCount = await markNotificationsAsReadByType(req.user._id, type);
        const counts = await getUnreadNotificationCounts(req.user._id);

        const io = req.app?.get("io") || getIO();
        if (io) {
            io.to(`user:${req.user._id.toString()}`).emit("notification:counts", {
                unreadCount: counts.total,
                unreadLikesCount: counts.likes,
                unreadRequestsCount: counts.requests,
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            message: `Notifications of type '${type}' marked as read`,
            updatedCount,
            unreadCount: counts.total,
            unreadLikesCount: counts.likes,
            unreadRequestsCount: counts.requests,
        });
    } catch (error) {
        console.error("Error in markTypeAsReadHandler:", error);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to mark notifications by type as read",
        });
    }
};

