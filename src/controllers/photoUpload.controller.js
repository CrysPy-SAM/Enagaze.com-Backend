import httpStatus from "http-status";
import {
    requestPhotoUploadAuthorization,
    confirmPhotoUpload,
    deleteProfilePhoto,
    getStorageAdapter,
    verifyUploadToken,
} from "../services/storage.service.js";
import {
    validateImageBuffer,
    stripMetadata,
} from "../services/imageValidation.service.js";

/**
 * 1. Request signed photo upload authorization URL
 * POST /api/v1/users/profile/photo/upload-url
 */
export const requestUploadUrl = async (req, res) => {
    try {
        const { filename, contentType, fileSize, targetIndex } = req.body;

        const authResult = await requestPhotoUploadAuthorization(req.user, {
            filename,
            contentType,
            fileSize: Number(fileSize),
            targetIndex: targetIndex !== undefined ? Number(targetIndex) : undefined,
        });

        return res.status(httpStatus.OK).json({
            success: true,
            ...authResult,
        });
    } catch (err) {
        const status = err.statusCode || (err.code === "STORAGE_UNAVAILABLE" ? httpStatus.SERVICE_UNAVAILABLE : httpStatus.BAD_REQUEST);
        return res.status(status).json({
            success: false,
            message: err.message || "Failed to issue upload authorization",
            code: err.code || undefined,
        });
    }
};

/**
 * 2. Confirm completed upload and atomically update profile photos
 * POST /api/v1/users/profile/photo/confirm
 */
export const confirmUpload = async (req, res) => {
    try {
        const { key, uploadToken, targetIndex } = req.body;

        const result = await confirmPhotoUpload(req.user._id, {
            key,
            uploadToken,
            targetIndex: targetIndex !== undefined ? Number(targetIndex) : undefined,
        });

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Profile photo updated successfully",
            ...result,
        });
    } catch (err) {
        const status = err.statusCode || (err.code === "STORAGE_UNAVAILABLE" ? httpStatus.SERVICE_UNAVAILABLE : httpStatus.BAD_REQUEST);
        return res.status(status).json({
            success: false,
            message: err.message || "Failed to confirm photo upload",
            code: err.code || undefined,
        });
    }
};

/**
 * 3. Delete a profile photo by index
 * DELETE /api/v1/users/profile/photo/:photoIndex
 */
export const removePhoto = async (req, res) => {
    try {
        const photoIndex = parseInt(req.params.photoIndex, 10);
        if (isNaN(photoIndex) || photoIndex < 0) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Invalid photo index parameter",
            });
        }

        const result = await deleteProfilePhoto(req.user._id, photoIndex);

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Profile photo removed successfully",
            ...result,
        });
    } catch (err) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: err.message || "Failed to delete profile photo",
        });
    }
};

/**
 * 4. Dev/Mock upload payload receiver
 * PUT /api/v1/users/profile/photo/upload-payload/:key
 * Receives binary stream, validates magic numbers and dimensions, strips EXIF metadata.
 */
export const uploadPayload = async (req, res) => {
    try {
        if (process.env.NODE_ENV === "production") {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Dev/mock upload endpoint is disabled in production",
            });
        }

        const key = req.params.key || req.params[0];
        const token = req.query.token;

        if (!token) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Missing upload authorization token in query parameter",
            });
        }

        // Buffer from body
        let buffer = req.body;
        if (!Buffer.isBuffer(buffer)) {
            if (typeof buffer === "string") {
                buffer = Buffer.from(buffer);
            } else {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Invalid binary image payload",
                });
            }
        }

        // Verify token against key (userId extracted from token payload)
        const parts = token.split(".");
        if (parts.length !== 2) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Malformed upload token",
            });
        }

        const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        verifyUploadToken(token, payload.userId, key);

        // Validate image buffer
        const validation = validateImageBuffer(buffer, {
            maxSizeBytes: payload.maxSizeBytes,
        });

        if (!validation.valid) {
            return res.status(httpStatus.UNPROCESSABLE_ENTITY).json({
                success: false,
                message: validation.error,
            });
        }

        // Strip EXIF metadata
        const sanitizedBuffer = stripMetadata(buffer, validation.mimeType);

        // Store in adapter
        const adapter = getStorageAdapter();
        await adapter.putObject(key, sanitizedBuffer, validation.mimeType);

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Image payload validated, metadata stripped, and saved to storage successfully",
            key,
            sizeBytes: sanitizedBuffer.length,
            mimeType: validation.mimeType,
        });
    } catch (err) {
        const status = err.statusCode || (err.code === "STORAGE_UNAVAILABLE" ? httpStatus.SERVICE_UNAVAILABLE : httpStatus.BAD_REQUEST);
        return res.status(status).json({
            success: false,
            message: err.message || "Failed to process image payload",
            code: err.code || undefined,
        });
    }
};

/**
 * 5. Dev/Mock media server
 * GET /api/v1/users/profile/photo/media/:key
 */
export const serveMedia = async (req, res) => {
    try {
        if (process.env.NODE_ENV === "production") {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Dev/mock media endpoint is disabled in production",
            });
        }

        const key = req.params.key || req.params[0];
        const adapter = getStorageAdapter();
        const obj = await adapter.getObject(key);

        if (!obj || !obj.buffer) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Image not found",
            });
        }

        res.setHeader("Content-Type", obj.mimeType || "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.status(httpStatus.OK).send(obj.buffer);
    } catch (err) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to serve media",
        });
    }
};
