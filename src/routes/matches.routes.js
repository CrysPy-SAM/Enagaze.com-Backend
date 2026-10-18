import { Router } from "express";
import { getMatches } from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { requireEligibility } from "../services/eligibility.service.js";

const router = Router();

// GET /api/v1/matches - Paginated mutual matches list
router.route("/").get(protect, requireEligibility, getMatches);

export default router;

