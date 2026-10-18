import { Router } from "express";
import {
    login,
    register,
    getMyProfile,
    updateMyProfile,
    googleLogin
} from "../controllers/user.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import {
    loginIpLimiter,
    loginAccountLimiter,
    registerLimiter,
    googleLoginLimiter,
} from "../middlewares/rateLimiter.middleware.js";

const router = Router();

// Public auth endpoints with differentiated brute-force protection
router.route("/login").post(loginIpLimiter, loginAccountLimiter, login);
router.route("/register").post(registerLimiter, register);
router.route("/google-login").post(googleLoginLimiter, googleLogin);

// Protected profile endpoints
router.route("/profile/me")
    .get(protect, getMyProfile)
    .put(protect, updateMyProfile);

export default router;