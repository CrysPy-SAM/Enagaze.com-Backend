import { Router } from "express";
import { getMatches, getLikesYou } from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { requireEligibility } from "../services/eligibility.service.js";

import { unmatchHandler } from "../controllers/safety.controller.js";
import { unmatchLimiter } from "../middlewares/rateLimiter.middleware.js";

const router = Router();

// GET /api/v1/matches - Paginated mutual matches list
router.route("/").get(protect, requireEligibility, getMatches);

// GET /api/v1/matches/likes-you - Profiles who liked current user
router.get("/likes-you", protect, requireEligibility, getLikesYou);

// POST /api/v1/matches/:matchId/unmatch - Unmatch a mutual match
router.post("/:matchId/unmatch", protect, unmatchLimiter, unmatchHandler);

export default router;

