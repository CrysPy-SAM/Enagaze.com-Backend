import { Router } from "express";
import { getDiscoveryProfiles, swipe } from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// GET /api/v1/discovery - Paginated eligible profiles feed
router.route("/").get(protect, getDiscoveryProfiles);

// POST /api/v1/discovery/swipe - Like or pass a profile
router.route("/swipe").post(protect, swipe);

export default router;

