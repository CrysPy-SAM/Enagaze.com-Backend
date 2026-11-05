import httpStatus from "http-status";
import { DeviceToken } from "../models/deviceToken.model.js";

/**
 * Register or refresh a device push token for the authenticated user.
 * POST /api/v1/users/device-token
 */
export const registerDeviceToken = async (req, res) => {
    try {
        const userId = req.user?._id;
        const { token, platform = "android", deviceId = null } = req.body || {};

        if (!userId) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Authentication required",
            });
        }

        if (!token || typeof token !== "string" || !token.trim()) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Valid device push token is required",
            });
        }

        const registered = await DeviceToken.registerToken({
            userId,
            token: token.trim(),
            platform: ["android", "ios", "web"].includes(platform) ? platform : "android",
            deviceId: deviceId ? String(deviceId).trim() : null,
        });

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Device token registered successfully",
            data: {
                platform: registered.platform,
                lastUsedAt: registered.lastUsedAt,
            },
        });
    } catch (err) {
        console.error("[DeviceToken] Register error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to register device token",
        });
    }
};

/**
 * Deactivate a device push token on user logout.
 * DELETE /api/v1/users/device-token
 */
export const unregisterDeviceToken = async (req, res) => {
    try {
        const { token } = req.body || {};

        if (token && typeof token === "string") {
            await DeviceToken.deactivateToken(token.trim());
        }

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Device token unregistered successfully",
        });
    } catch (err) {
        console.error("[DeviceToken] Unregister error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to unregister device token",
        });
    }
};

