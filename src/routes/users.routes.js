import express, { Router } from "express";
import {
    login,
    register,
    getMyProfile,
    updateMyProfile,
    googleLogin,
    getPrivacySettings,
    updatePrivacySettings,
    checkUsernameAvailability,
    setupInitialUsername,
    getUsernameEligibility,
    updateUsername,
} from "../controllers/user.controller.js";
import {
    searchUsers,
    getPublicUserProfile,
} from "../controllers/userSearch.controller.js";
import {
    requestUploadUrl,
    confirmUpload,
    removePhoto,
    uploadPayload,
    serveMedia
} from "../controllers/photoUpload.controller.js";
import { protect, requireUsernameCompleted, optionalAuth } from "../middlewares/auth.middleware.js";
import {
    loginIpLimiter,
    loginAccountLimiter,
    registerLimiter,
    googleLoginLimiter,
    photoUploadLimiter,
    userSearchLimiter,
    usernameCheckLimiter,
} from "../middlewares/rateLimiter.middleware.js";

const router = Router();

// Public auth endpoints with differentiated brute-force protection
router.route("/login").post(loginIpLimiter, loginAccountLimiter, login);
router.route("/register").post(registerLimiter, register);
router.route("/google-login").post(googleLoginLimiter, googleLogin);

// Username verification & management endpoints
router.route("/check-username").get(usernameCheckLimiter, optionalAuth, checkUsernameAvailability);
router.route("/setup-username").post(protect, setupInitialUsername);
router.route("/username-eligibility").get(protect, getUsernameEligibility);
router.route("/username").put(protect, updateUsername);

// People Discovery & Instagram-style Search endpoints
router.route("/search")
    .get(protect, requireUsernameCompleted, userSearchLimiter, searchUsers);

router.route("/profile/public/:userId")
    .get(protect, getPublicUserProfile);

// Protected profile endpoints
router.route("/profile/me")
    .get(protect, getMyProfile)
    .put(protect, updateMyProfile);

// Protected privacy settings endpoints
router.route("/privacy")
    .get(protect, getPrivacySettings)
    .put(protect, updatePrivacySettings);

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
