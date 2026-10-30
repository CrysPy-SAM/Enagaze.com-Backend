import { Router } from "express";
import {
    getCallHistory,
    getMissedCallCount,
    markMissedCallsAsSeen,
} from "../controllers/call.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { requireEligibility } from "../services/eligibility.service.js";

const router = Router();

// All call routes require authentication & account eligibility
router.use(protect);
router.use(requireEligibility);

router.route("/history").get(getCallHistory);
router.route("/missed-count").get(getMissedCallCount);
router.route("/mark-seen").post(markMissedCallsAsSeen);

export default router;
