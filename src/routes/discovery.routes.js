import { Router } from "express";
import { getDiscoveryProfiles, swipe, resetDiscoverySwipes } from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// GET /api/v1/discovery - Paginated eligible profiles feed
router.route("/").get(protect, getDiscoveryProfiles);

// POST /api/v1/discovery/swipe - Like or pass a profile
router.route("/swipe").post(protect, swipe);

// POST /api/v1/discovery/reset - Reset passed swipes so profiles reappear in feed
router.route("/reset").post(protect, resetDiscoverySwipes);

export default router;

