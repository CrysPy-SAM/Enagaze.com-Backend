import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
    blockLimiter,
    reportLimiter,
    unmatchLimiter,
} from "../middlewares/rateLimiter.middleware.js";
import {
    blockUserHandler,
    unblockUserHandler,
    getBlockedUsersHandler,
    reportUserHandler,
    unmatchHandler,
} from "../controllers/safety.controller.js";

const router = Router();

// All safety routes require authenticated user
router.use(protect);

router.post("/block", blockLimiter, blockUserHandler);
router.post("/unblock", blockLimiter, unblockUserHandler);
router.get("/blocked", getBlockedUsersHandler);
router.post("/report", reportLimiter, reportUserHandler);
router.post("/unmatch", unmatchLimiter, unmatchHandler);

export default router;

