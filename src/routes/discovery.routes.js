import { Router } from "express";
import {
    getDiscoveryProfiles,
    swipe,
    resetDiscoverySwipes,
    getDiscoveryPreferences,
    updateDiscoveryPreferences,
} from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { requireEligibility } from "../services/eligibility.service.js";
import { discoveryLimiter, swipeLimiter } from "../middlewares/rateLimiter.middleware.js";

const router = Router();

// All discovery endpoints require authenticated session
router.use(protect);

// GET & PUT /api/v1/discovery/preferences - Read and update persisted discovery filters
router.route("/preferences")
    .get(getDiscoveryPreferences)
    .put(updateDiscoveryPreferences);

// Browsing, swiping, and resetting require verified adult eligibility (18+ and complete profile)
router.use(requireEligibility);

// GET /api/v1/discovery - Paginated eligible profiles feed (rate limited)
router.route("/").get(discoveryLimiter, getDiscoveryProfiles);

// POST /api/v1/discovery/swipe - Like or pass a profile (anti-automation rate limited)
router.route("/swipe").post(swipeLimiter, swipe);

// POST /api/v1/discovery/reset - Reset passed swipes so profiles reappear in feed
router.route("/reset").post(swipeLimiter, resetDiscoverySwipes);

export default router;

