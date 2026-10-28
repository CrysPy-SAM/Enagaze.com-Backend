import { Router } from "express";
import { requireModerator } from "../middlewares/auth.middleware.js";
import {
    listReportsHandler,
    getReportDetailsHandler,
    updateReportStatusHandler,
    banUserHandler,
    suspendUserHandler,
    reinstateUserHandler,
} from "../controllers/moderation.controller.js";

const router = Router();

// Moderation routes require valid authentication and moderator/admin privileges
router.use(requireModerator);

router.get("/reports", listReportsHandler);
router.get("/reports/:reportId", getReportDetailsHandler);
router.patch("/reports/:reportId", updateReportStatusHandler);

// Direct account moderation actions
router.post("/users/:userId/ban", banUserHandler);
router.post("/users/:userId/suspend", suspendUserHandler);
router.post("/users/:userId/reinstate", reinstateUserHandler);

export default router;

