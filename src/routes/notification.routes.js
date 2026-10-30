import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
    getNotificationsHandler,
    getUnreadCountHandler,
    markAsReadHandler,
    markAllAsReadHandler,
    markTypeAsReadHandler,
} from "../controllers/notification.controller.js";

const router = Router();

// GET /api/v1/notifications - Paginated list of notifications
router.get("/", protect, getNotificationsHandler);

// GET /api/v1/notifications/unread-count - Unread count badge
router.get("/unread-count", protect, getUnreadCountHandler);

// PATCH /api/v1/notifications/read-all - Mark all read (must precede /:id/read)
router.patch("/read-all", protect, markAllAsReadHandler);

// PATCH /api/v1/notifications/read-type/:type - Mark all of specific type as read (must precede /:id/read)
router.patch("/read-type/:type", protect, markTypeAsReadHandler);

// PATCH /api/v1/notifications/:id/read - Mark single notification as read
router.patch("/:id/read", protect, markAsReadHandler);

export default router;

