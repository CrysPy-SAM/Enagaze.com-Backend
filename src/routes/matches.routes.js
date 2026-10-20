import { Router } from "express";
import { getMatches, getLikesYou } from "../controllers/discovery.controller.js";
import {
    sendMatchRequest,
    getIncomingMatchRequests,
    getOutgoingMatchRequests,
    acceptMatchRequest,
    declineMatchRequest,
} from "../controllers/matchRequest.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { requireEligibility } from "../services/eligibility.service.js";
import { unmatchHandler } from "../controllers/safety.controller.js";
import { unmatchLimiter, swipeLimiter } from "../middlewares/rateLimiter.middleware.js";

const router = Router();

// ==========================================
// CONSENT-BASED MATCH REQUEST ENDPOINTS
// ==========================================
// POST /api/v1/matches/requests - Send a match request (A -> B)
router.post("/requests", protect, requireEligibility, swipeLimiter, sendMatchRequest);

// GET /api/v1/matches/requests/incoming - Pending match requests received by current user
router.get("/requests/incoming", protect, requireEligibility, getIncomingMatchRequests);

// GET /api/v1/matches/requests/outgoing - Pending match requests sent by current user
router.get("/requests/outgoing", protect, requireEligibility, getOutgoingMatchRequests);

// POST /api/v1/matches/requests/:requestId/accept - Accept a pending match request
router.post("/requests/:requestId/accept", protect, requireEligibility, acceptMatchRequest);

// POST /api/v1/matches/requests/:requestId/decline - Decline a pending match request
router.post("/requests/:requestId/decline", protect, requireEligibility, declineMatchRequest);

// ==========================================
// ACTIVE MATCHES & SAFETY ENDPOINTS
// ==========================================
// GET /api/v1/matches - Paginated mutual matches list
router.route("/").get(protect, requireEligibility, getMatches);

// GET /api/v1/matches/likes-you - Profiles who liked current user
router.get("/likes-you", protect, requireEligibility, getLikesYou);

// POST /api/v1/matches/:matchId/unmatch - Unmatch a mutual match
router.post("/:matchId/unmatch", protect, unmatchLimiter, unmatchHandler);

export default router;

