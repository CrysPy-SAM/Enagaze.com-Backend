import { Router } from "express";
import {
    login,
    register,
    getMyProfile,
    updateMyProfile,
    getUserHistory,
    addToHistory
} from "../controllers/user.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// Public auth endpoints
router.route("/login").post(login);
router.route("/register").post(register);

// Protected profile endpoints
router.route("/profile/me")
    .get(protect, getMyProfile)
    .put(protect, updateMyProfile);

// Protected meeting activity endpoints
router.route("/add_to_activity").post(protect, addToHistory);
router.route("/get_all_activity").get(protect, getUserHistory);

export default router;