import jwt from "jsonwebtoken";
import crypto from "crypto";
import httpStatus from "http-status";
import { User, evaluateAccountStatus } from "../models/user.model.js";
import { getJwtSecret } from "../config/jwt.js";

const safeCompare = (provided, expected) => {
    if (typeof provided !== "string" || typeof expected !== "string") return false;
    const bufProvided = Buffer.from(provided);
    const bufExpected = Buffer.from(expected);
    if (bufProvided.length !== bufExpected.length) return false;
    return crypto.timingSafeEqual(bufProvided, bufExpected);
};

export const protect = async (req, res, next) => {
    let token = null;

    // Restrict REST token transport strictly to Authorization: Bearer <token> header
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
        return res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            message: "Authentication required. Please provide a valid token."
        });
    }

    try {
        const decoded = jwt.verify(token, getJwtSecret());

        const user = await User.findById(decoded.id).select("-password");
        if (!user) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "User account no longer exists."
            });
        }

        // Enforce account moderation status (banned / suspended)
        const accountStatus = evaluateAccountStatus(user);
        if (!accountStatus.allowed) {
            const isBanned = accountStatus.status === "banned";
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: isBanned
                    ? "Your account has been permanently banned."
                    : `Your account is temporarily suspended until ${user.suspensionExpiresAt ? new Date(user.suspensionExpiresAt).toISOString() : "further notice"}. Reason: ${user.suspensionReason || "Policy violation"}`,
                code: isBanned ? "ACCOUNT_BANNED" : "ACCOUNT_SUSPENDED",
                reason: accountStatus.reason,
                expiresAt: accountStatus.expiresAt,
            });
        }

        // Auto-persist reinstatement if temporary suspension had expired
        if (accountStatus.wasExpired) {
            user.status = "active";
            user.suspensionExpiresAt = null;
            user.suspensionReason = null;
            if (typeof user.save === "function") {
                user.save().catch((saveErr) => console.warn("Failed to auto-reinstate expired user:", saveErr?.message));
            }
        }

        req.user = user;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Session expired. Please log in again."
            });
        }
        return res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            message: "Invalid authentication token."
        });
    }
};

export const requireModerator = async (req, res, next) => {
    // 1. Dedicated operational secret header for automation/scripts: x-moderator-secret
    const secret = req.headers["x-moderator-secret"];
    if (secret !== undefined) {
        const expectedSecret = process.env.MODERATOR_API_KEY;
        // Fails closed if MODERATOR_API_KEY is not configured or empty
        if (
            expectedSecret &&
            typeof expectedSecret === "string" &&
            expectedSecret.trim().length > 0 &&
            safeCompare(secret, expectedSecret)
        ) {
            if (!req.user) {
                req.user = { _id: null, role: "admin", name: "System Admin" };
            }
            return next();
        }

        return res.status(httpStatus.FORBIDDEN).json({
            success: false,
            message: "Access forbidden. Invalid moderator credentials.",
        });
    }

    // 2. Check if user is already authenticated via protect middleware
    if (req.user) {
        if (req.user.role === "moderator" || req.user.role === "admin") {
            return next();
        }
        return res.status(httpStatus.FORBIDDEN).json({
            success: false,
            message: "Access forbidden. Moderator or admin privileges required.",
        });
    }

    // 3. User is not yet authenticated and no secret header -> delegate to protect
    return protect(req, res, () => {
        if (req.user && (req.user.role === "moderator" || req.user.role === "admin")) {
            return next();
        }
        return res.status(httpStatus.FORBIDDEN).json({
            success: false,
            message: "Access forbidden. Moderator or admin privileges required.",
        });
    });
};


