import { Router } from "express";
import { getDiscoveryProfiles, swipe, resetDiscoverySwipes } from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { discoveryLimiter, swipeLimiter } from "../middlewares/rateLimiter.middleware.js";

const router = Router();

// GET /api/v1/discovery - Paginated eligible profiles feed (rate limited)
router.route("/").get(protect, discoveryLimiter, getDiscoveryProfiles);

// POST /api/v1/discovery/swipe - Like or pass a profile (anti-automation rate limited)
router.route("/swipe").post(protect, swipeLimiter, swipe);

// POST /api/v1/discovery/reset - Reset passed swipes so profiles reappear in feed
router.route("/reset").post(protect, swipeLimiter, resetDiscoverySwipes);

export default router;

