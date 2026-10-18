import { Router } from "express";
import { requireModerator } from "../middlewares/auth.middleware.js";
import {
    listReportsHandler,
    getReportDetailsHandler,
    updateReportStatusHandler,
} from "../controllers/moderation.controller.js";

const router = Router();

// Moderation routes require valid authentication and moderator/admin privileges
router.use(requireModerator);

router.get("/reports", listReportsHandler);
router.get("/reports/:reportId", getReportDetailsHandler);
router.patch("/reports/:reportId", updateReportStatusHandler);

export default router;

