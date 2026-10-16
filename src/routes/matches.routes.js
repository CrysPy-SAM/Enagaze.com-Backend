import { Router } from "express";
import { getMatches } from "../controllers/discovery.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// GET /api/v1/matches - Paginated mutual matches list
router.route("/").get(protect, getMatches);

export default router;

