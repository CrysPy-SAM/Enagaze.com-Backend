import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { getIceServers, submitDiagnostics, verifyCallAccess } from "../controllers/webrtc.controller.js";

const router = Router();

// Retrieve secure ICE servers (STUN/TURN) for the authenticated user
router.get("/ice-servers", protect, getIceServers);

// Submit safe, sanitized connection diagnostics
router.post("/diagnostics", protect, submitDiagnostics);

// Verify active connection permission for video calling
router.get("/verify-access/:targetUserId", protect, verifyCallAccess);
router.post("/verify-access", protect, verifyCallAccess);

export default router;

