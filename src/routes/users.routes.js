import express, { Router } from "express";
import {
    login,
    register,
    getMyProfile,
    updateMyProfile,
    googleLogin
} from "../controllers/user.controller.js";
import {
    requestUploadUrl,
    confirmUpload,
    removePhoto,
    uploadPayload,
    serveMedia
} from "../controllers/photoUpload.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import {
    loginIpLimiter,
    loginAccountLimiter,
    registerLimiter,
    googleLoginLimiter,
    photoUploadLimiter,
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

// Profile photo upload pipeline endpoints
router.route("/profile/photo/upload-url")
    .post(protect, photoUploadLimiter, requestUploadUrl);

router.route("/profile/photo/confirm")
    .post(protect, photoUploadLimiter, confirmUpload);

router.route("/profile/photo/:photoIndex")
    .delete(protect, removePhoto);

// Dev/Mock binary upload endpoint (requires valid HMAC upload token in query)
router.route("/profile/photo/upload-payload/*")
    .put(express.raw({ type: ["image/*", "application/octet-stream", "*/*"], limit: "6mb" }), uploadPayload);

// Dev/Mock media delivery endpoint
router.route("/profile/photo/media/*")
    .get(serveMedia);

export default router;
