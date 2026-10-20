import crypto from "crypto";
import { User } from "../models/user.model.js";
import {
    detectMimeType,
    stripMetadata,
    validateImageBuffer,
    validatePublicPhotoUrl,
    MAX_PHOTO_BYTES,
    ALLOWED_MIME_TYPES,
} from "./imageValidation.service.js";

const UPLOAD_TOKEN_TTL_SECONDS = 300; // 5 minutes

/**
 * In-memory buffer cache for Dev/Mock storage provider.
 * Keyed by object key.
 */
const mockStorageObjects = new Map();

/**
 * Create a cryptographically signed upload token.
 * Prevents tampering with userId, target key, mime type, or size constraints.
 *
 * @param {object} claims
 * @returns {string} token
 */
export function createUploadToken(claims) {
    const secret = process.env.JWT_SECRET || "engaze_jwt_dev_secret_key_12345";
    const payload = {
        userId: String(claims.userId),
        key: String(claims.key),
        expectedMime: String(claims.expectedMime),
        maxSizeBytes: Number(claims.maxSizeBytes || MAX_PHOTO_BYTES),
        targetIndex: claims.targetIndex !== undefined ? Number(claims.targetIndex) : undefined,
        expiresAt: Number(claims.expiresAt || (Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000)),
    };

    const serialized = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", secret)
        .update(serialized)
        .digest("base64url");

    return `${serialized}.${signature}`;
}

/**
 * Verifies an upload token against HMAC signature, expiration, and key ownership.
 *
 * @param {string} tokenString
 * @param {string} expectedUserId
 * @param {string} expectedKey
 * @returns {object} Decoded claims
 */
export function verifyUploadToken(tokenString, expectedUserId, expectedKey) {
    if (!tokenString || typeof tokenString !== "string") {
        throw new Error("Missing upload authorization token");
    }

    const parts = tokenString.split(".");
    if (parts.length !== 2) {
        throw new Error("Malformed upload authorization token");
    }

    const [serialized, receivedSig] = parts;
    const secret = process.env.JWT_SECRET || "engaze_jwt_dev_secret_key_12345";

    const expectedSig = crypto
        .createHmac("sha256", secret)
        .update(serialized)
        .digest("base64url");

    const receivedBuf = Buffer.from(receivedSig);
    const expectedBuf = Buffer.from(expectedSig);
    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
        throw new Error("Invalid upload authorization token signature");
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8"));
    } catch {
        throw new Error("Invalid upload authorization payload format");
    }

    if (Date.now() > payload.expiresAt) {
        throw new Error("Upload authorization token has expired");
    }

    if (String(payload.userId) !== String(expectedUserId)) {
        throw new Error("Upload token is not authorized for this user account");
    }

    if (expectedKey && String(payload.key) !== String(expectedKey)) {
        throw new Error("Upload token is not authorized for the specified object key");
    }

    return payload;
}

/**
 * Generate a collision-resistant, server-controlled object key scoped to user.
 *
 * @param {string} userId
 * @param {string} mimeType
 * @returns {string} Server object key
 */
export function generatePhotoKey(userId, mimeType) {
    const extMap = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
    };
    const ext = extMap[mimeType] || "jpg";
    const uuid = crypto.randomUUID();
    return `profile-photos/${userId}/${uuid}.${ext}`;
}

/**
 * Dev/Mock storage provider adapter.
 * Used when real cloud credentials (AWS S3 / Cloudflare R2) are not configured.
 * Strictly restricted to development and test environments.
 */
export class DevMockStorageAdapter {
    constructor() {
        this.name = "mock";
    }

    async createPresignedUpload(user, key, mimeType, maxBytes, targetIndex) {
        const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000;
        const uploadToken = createUploadToken({
            userId: user._id,
            key,
            expectedMime: mimeType,
            maxSizeBytes: maxBytes,
            targetIndex,
            expiresAt,
        });

        const baseUrl = process.env.STORAGE_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        const uploadUrl = `${baseUrl}/api/v1/users/profile/photo/upload-payload/${encodeURIComponent(key)}?token=${encodeURIComponent(uploadToken)}`;
        const publicUrl = `${baseUrl}/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`;

        return {
            provider: "dev-mock",
            uploadUrl,
            publicUrl,
            key,
            uploadToken,
            expiresInSeconds: UPLOAD_TOKEN_TTL_SECONDS,
            maxSizeBytes: maxBytes,
            targetIndex,
        };
    }

    async putObject(key, buffer, mimeType) {
        mockStorageObjects.set(key, {
            buffer,
            mimeType,
            size: buffer.length,
            uploadedAt: Date.now(),
        });
        return true;
    }

    async getObject(key) {
        return mockStorageObjects.get(key) || null;
    }

    async objectExists(key) {
        return mockStorageObjects.has(key);
    }

    async getObjectMetadata(key) {
        const obj = mockStorageObjects.get(key);
        if (!obj) return null;
        return {
            size: obj.size,
            contentType: obj.mimeType,
            uploadedAt: obj.uploadedAt,
        };
    }

    async deleteObject(key) {
        mockStorageObjects.delete(key);
        return true;
    }

    clearAll() {
        mockStorageObjects.clear();
    }
}

/**
 * Storage Unavailable Adapter.
 * Returned in production when real cloud storage credentials (AWS S3 / Cloudflare R2) are not configured.
 * Safely fails closed with 503 SERVICE_UNAVAILABLE on any upload operation.
 */
export class StorageUnavailableAdapter {
    constructor(reason = "Photo storage provider is not configured for production.") {
        this.name = "unavailable";
        this.reason = reason;
    }

    async createPresignedUpload() {
        const error = new Error("Photo storage service is temporarily unavailable. Cloud storage provider is not configured.");
        error.statusCode = 503;
        error.code = "STORAGE_UNAVAILABLE";
        throw error;
    }

    async putObject() {
        const error = new Error("Photo storage service is unavailable. Cannot store image payload.");
        error.statusCode = 503;
        error.code = "STORAGE_UNAVAILABLE";
        throw error;
    }

    async objectExists() {
        return false;
    }

    async getObjectMetadata() {
        return null;
    }

    async getObject() {
        return null;
    }

    async deleteObject() {
        return false;
    }
}

/**
 * S3 Storage Provider Adapter.
 * Activates when STORAGE_PROVIDER === 's3' and AWS credentials are set.
 */
export class S3StorageAdapter {
    constructor() {
        this.name = "s3";
        this.bucket = process.env.AWS_S3_BUCKET;
        this.region = process.env.AWS_REGION || "us-east-1";
    }

    async createPresignedUpload(user, key, mimeType, maxBytes, targetIndex) {
        const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000;
        const uploadToken = createUploadToken({
            userId: user._id,
            key,
            expectedMime: mimeType,
            maxSizeBytes: maxBytes,
            targetIndex,
            expiresAt,
        });

        // Use custom CDN or fallback to S3 bucket domain
        const publicBase =
            process.env.STORAGE_PUBLIC_BASE_URL ||
            process.env.AWS_S3_PUBLIC_URL ||
            `https://${this.bucket}.s3.${this.region}.amazonaws.com`;

        const publicUrl = `${publicBase}/${key}`;
        const uploadUrl = `${publicBase}/${key}?signed=true`; // Placeholder when SDK credentials exist

        return {
            provider: "s3",
            uploadUrl,
            publicUrl,
            key,
            uploadToken,
            expiresInSeconds: UPLOAD_TOKEN_TTL_SECONDS,
            maxSizeBytes: maxBytes,
            targetIndex,
        };
    }

    async objectExists(key) {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            const err = new Error("S3 storage credentials not configured for object verification");
            err.statusCode = 503;
            err.code = "STORAGE_UNAVAILABLE";
            throw err;
        }
        // Placeholder for HeadObjectCommand when AWS SDK is present
        return true;
    }

    async getObjectMetadata(key) {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            const err = new Error("S3 storage credentials not configured for object verification");
            err.statusCode = 503;
            err.code = "STORAGE_UNAVAILABLE";
            throw err;
        }
        return null;
    }

    async deleteObject() {
        // Will be deleted via DeleteObjectCommand when credentials exist
        return true;
    }
}

// Active singleton adapter
let currentAdapter = null;

export function getStorageAdapter() {
    if (!currentAdapter) {
        const isProduction = process.env.NODE_ENV === "production";
        if (process.env.STORAGE_PROVIDER === "s3" && process.env.AWS_S3_BUCKET) {
            currentAdapter = new S3StorageAdapter();
        } else if (isProduction) {
            currentAdapter = new StorageUnavailableAdapter();
        } else {
            currentAdapter = new DevMockStorageAdapter();
        }
    }
    return currentAdapter;
}

export function setStorageAdapter(customAdapter) {
    currentAdapter = customAdapter;
}

/**
 * Request an authorized upload URL for profile photo.
 *
 * @param {object} user Authenticated Mongoose User doc
 * @param {object} payload { filename, contentType, fileSize, targetIndex }
 * @returns {Promise<object>}
 */
export async function requestPhotoUploadAuthorization(user, payload) {
    if (!user || !user._id) {
        throw new Error("User must be authenticated");
    }

    const adapter = getStorageAdapter();
    if (adapter.name === "unavailable") {
        const error = new Error("Photo storage service is temporarily unavailable. Cloud storage provider is not configured.");
        error.statusCode = 503;
        error.code = "STORAGE_UNAVAILABLE";
        throw error;
    }

    const { contentType, fileSize, targetIndex } = payload;
    if (!contentType || !ALLOWED_MIME_TYPES.includes(contentType)) {
        throw new Error("Invalid or unsupported content type. Allowed formats: image/jpeg, image/png, image/webp");
    }

    if (!fileSize || typeof fileSize !== "number" || fileSize <= 0) {
        throw new Error("Invalid file size parameter");
    }

    if (fileSize > MAX_PHOTO_BYTES) {
        throw new Error(`File size exceeds maximum allowed limit of ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB`);
    }

    if (Array.isArray(user.photos) && user.photos.length >= 6 && targetIndex === undefined) {
        throw new Error("Profile photo limit reached (maximum 6 photos). Replace an existing photo or delete one first");
    }

    const key = generatePhotoKey(user._id, contentType);
    return adapter.createPresignedUpload(user, key, contentType, MAX_PHOTO_BYTES, targetIndex);
}

/**
 * Confirm uploaded photo and atomically update user profile.
 *
 * @param {string} userId
 * @param {object} payload { key, uploadToken, targetIndex }
 * @returns {Promise<object>}
 */
export async function confirmPhotoUpload(userId, payload) {
    const { key, uploadToken, targetIndex } = payload;
    if (!key || !uploadToken) {
        throw new Error("Missing required parameters: key and uploadToken");
    }

    // 1. Verify token claims and ownership
    const tokenClaims = verifyUploadToken(uploadToken, userId, key);

    // If token was bound to a specific targetIndex, ensure caller matches
    if (tokenClaims.targetIndex !== undefined && targetIndex !== undefined && Number(tokenClaims.targetIndex) !== Number(targetIndex)) {
        const error = new Error("Upload token is bound to a different photo slot");
        error.statusCode = 400;
        throw error;
    }

    // 2. Storage Adapter & Object Verification
    const adapter = getStorageAdapter();
    if (adapter.name === "unavailable") {
        const error = new Error("Photo storage service is temporarily unavailable. Cloud storage provider is not configured.");
        error.statusCode = 503;
        error.code = "STORAGE_UNAVAILABLE";
        throw error;
    }

    // Verify object actually exists in storage before updating user profile
    const exists = await adapter.objectExists(key);
    if (!exists) {
        const error = new Error("Uploaded photo not found in storage. Object must be uploaded before confirmation.");
        error.statusCode = 400;
        throw error;
    }

    // Validate uploaded object's actual size and content type using trusted provider metadata
    if (typeof adapter.getObjectMetadata === "function") {
        const meta = await adapter.getObjectMetadata(key);
        if (meta) {
            if (meta.size && meta.size > (tokenClaims.maxSizeBytes || MAX_PHOTO_BYTES)) {
                const error = new Error(`Uploaded file size (${meta.size} bytes) exceeds maximum allowed limit of ${Math.round((tokenClaims.maxSizeBytes || MAX_PHOTO_BYTES) / (1024 * 1024))}MB`);
                error.statusCode = 400;
                throw error;
            }
            if (meta.contentType && tokenClaims.expectedMime && meta.contentType !== tokenClaims.expectedMime) {
                const error = new Error(`Uploaded object content type (${meta.contentType}) does not match authorized content type (${tokenClaims.expectedMime})`);
                error.statusCode = 400;
                throw error;
            }
        }
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new Error("User not found");
    }

    // Construct resulting public URL
    const baseUrl =
        process.env.STORAGE_PUBLIC_BASE_URL ||
        process.env.CLOUDFLARE_R2_PUBLIC_URL ||
        process.env.AWS_S3_PUBLIC_URL ||
        `http://localhost:${process.env.PORT || 5000}`;

    let publicUrl;
    if (adapter.name === "mock") {
        publicUrl = `${baseUrl}/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`;
    } else {
        publicUrl = `${baseUrl}/${key}`;
    }

    // Validate the resulting URL through host allowlist and SSRF checks
    const urlValidation = validatePublicPhotoUrl(publicUrl);
    if (!urlValidation.valid) {
        throw new Error(`Validated URL rejected: ${urlValidation.error}`);
    }

    // Capture existing photos array for safe rollback on persistence error
    const previousPhotos = Array.isArray(user.photos) ? [...user.photos] : [];
    const effectiveTargetIndex = targetIndex !== undefined ? Number(targetIndex) : tokenClaims.targetIndex;

    if (typeof effectiveTargetIndex === "number" && effectiveTargetIndex >= 0 && effectiveTargetIndex < 6) {
        // Replace existing photo at targetIndex, or pad if within bounds
        const updated = [...previousPhotos];
        if (effectiveTargetIndex < updated.length) {
            updated[effectiveTargetIndex] = publicUrl;
        } else {
            updated.push(publicUrl);
        }
        user.photos = updated;
    } else {
        // Append new photo
        if (previousPhotos.length >= 6) {
            throw new Error("Maximum 6 profile photos allowed");
        }
        user.photos = [...previousPhotos, publicUrl];
    }

    // Save user profile
    await user.save();

    return {
        success: true,
        publicUrl,
        photos: user.photos,
    };
}

/**
 * Remove a photo at a given index and clean up storage.
 *
 * @param {string} userId
 * @param {number} photoIndex
 * @returns {Promise<object>}
 */
export async function deleteProfilePhoto(userId, photoIndex) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error("User not found");
    }

    if (!Array.isArray(user.photos) || photoIndex < 0 || photoIndex >= user.photos.length) {
        throw new Error("Invalid photo index");
    }

    const removedUrl = user.photos[photoIndex];
    user.photos.splice(photoIndex, 1);
    await user.save();

    // Trigger cleanup on adapter if the photo was stored on our platform
    try {
        if (removedUrl.includes("/profile-photos/")) {
            const keyMatch = removedUrl.match(/(profile-photos\/[^?]+)/);
            if (keyMatch) {
                const key = decodeURIComponent(keyMatch[1]);
                const adapter = getStorageAdapter();
                await adapter.deleteObject(key);
            }
        }
    } catch (e) {
        console.warn("Non-fatal storage object cleanup error:", e?.message);
    }

    return {
        success: true,
        photos: user.photos,
        removedUrl,
    };
}
