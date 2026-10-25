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
import {
    generatePresignedPutUrl,
    generatePresignedGetUrl,
    signS3Request,
    sha256Hex,
} from "./s3Signer.service.js";
import { getJwtSecret } from "../config/jwt.js";

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
    const secret = getJwtSecret();
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
    const secret = getJwtSecret();

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
 * Validates S3/R2 storage provider environment configuration.
 * Never prints or leaks secret credential values in output messages.
 *
 * @param {object} [env=process.env]
 * @returns {{ valid: boolean, reason?: string, config?: object }}
 */
export function validateStorageConfig(env = process.env) {
    const provider = (env.STORAGE_PROVIDER || "").toLowerCase().trim();
    if (provider !== "s3" && provider !== "r2") {
        return { valid: false, reason: "STORAGE_PROVIDER is not set to 's3' or 'r2'." };
    }

    const bucket = (env.STORAGE_BUCKET || env.AWS_S3_BUCKET || env.R2_BUCKET || "").trim();
    if (!bucket) {
        return { valid: false, reason: "Missing required storage bucket configuration (STORAGE_BUCKET or AWS_S3_BUCKET)." };
    }

    const accessKeyId = (env.STORAGE_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim();
    if (!accessKeyId || accessKeyId.length < 4) {
        return { valid: false, reason: "Missing or invalid storage access key ID (STORAGE_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID)." };
    }

    const secretAccessKey = (env.STORAGE_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim();
    if (!secretAccessKey || secretAccessKey.length < 8) {
        return { valid: false, reason: "Missing or invalid storage secret access key (STORAGE_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY)." };
    }

    const region = (env.STORAGE_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || (provider === "r2" ? "auto" : "us-east-1")).trim();
    if (!region) {
        return { valid: false, reason: "Missing storage region configuration (STORAGE_REGION or AWS_REGION)." };
    }

    const rawPublicUrl = (
        env.STORAGE_PUBLIC_BASE_URL ||
        env.CLOUDFLARE_R2_PUBLIC_URL ||
        env.AWS_S3_PUBLIC_URL ||
        ""
    ).trim().replace(/\/+$/, "");

    if (rawPublicUrl && !rawPublicUrl.startsWith("http")) {
        return { valid: false, reason: "Invalid public delivery base URL (STORAGE_PUBLIC_BASE_URL or AWS_S3_PUBLIC_URL). Must start with http:// or https://." };
    }

    const isPrivate = !rawPublicUrl;
    const publicBaseUrl = rawPublicUrl || null;

    const rawEndpoint = (env.STORAGE_ENDPOINT || env.AWS_S3_ENDPOINT || env.CLOUDFLARE_R2_ENDPOINT || "").trim().replace(/\/+$/, "");
    let endpoint = rawEndpoint || null;

    if (!endpoint && provider === "r2" && env.CLOUDFLARE_R2_ACCOUNT_ID) {
        endpoint = `https://${env.CLOUDFLARE_R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`;
    }

    const forcePathStyle =
        env.STORAGE_FORCE_PATH_STYLE !== undefined
            ? env.STORAGE_FORCE_PATH_STYLE === "true"
            : Boolean(endpoint);

    return {
        valid: true,
        config: {
            provider,
            bucket,
            accessKeyId,
            secretAccessKey,
            region,
            endpoint,
            forcePathStyle,
            publicBaseUrl,
            isPrivate,
        },
    };
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
 * Production S3-Compatible Storage Provider Adapter.
 * Supports AWS S3 and S3-compatible object storage providers (Cloudflare R2, MinIO, Wasabi).
 * Generates AWS SigV4 presigned upload PUT URLs and executes server-to-S3 HEAD/DELETE operations.
 */
export class S3StorageAdapter {
    constructor(config = null, options = {}) {
        this.config = config || validateStorageConfig().config;
        if (!this.config) {
            const err = new Error("S3StorageAdapter requires valid storage configuration");
            err.statusCode = 503;
            err.code = "STORAGE_UNAVAILABLE";
            throw err;
        }
        this.name = this.config.provider || "s3";
        this.bucket = this.config.bucket;
        this.region = this.config.region;
        this.publicBaseUrl = this.config.publicBaseUrl;
        this.fetchFn = options.fetchFn || globalThis.fetch;
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

        const uploadUrl = generatePresignedPutUrl({
            config: this.config,
            key,
            contentType: mimeType,
            expiresInSeconds: UPLOAD_TOKEN_TTL_SECONDS,
        });

        // Resulting public URL uses configured CDN, or private backend media delivery URL
        let publicUrl;
        if (this.publicBaseUrl && !this.config.isPrivate) {
            publicUrl = `${this.publicBaseUrl}/${key}`;
        } else {
            const apiBase = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
            publicUrl = apiBase
                ? `${apiBase.replace(/\/+$/, "")}/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`
                : `/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`;
        }

        return {
            provider: this.name,
            uploadUrl,
            publicUrl,
            key,
            uploadToken,
            expiresInSeconds: UPLOAD_TOKEN_TTL_SECONDS,
            maxSizeBytes: maxBytes,
            targetIndex,
        };
    }

    /**
     * Generate secure presigned GET download URL for viewing private S3 objects.
     *
     * @param {string} key
     * @param {number} [expiresInSeconds=3600]
     * @returns {string}
     */
    getPresignedDownloadUrl(key, expiresInSeconds = 3600) {
        return generatePresignedGetUrl({
            config: this.config,
            key,
            expiresInSeconds,
        });
    }

    /**
     * Upload an object directly to S3 from backend buffer.
     *
     * @param {string} key
     * @param {Buffer} buffer
     * @param {string} [mimeType="image/jpeg"]
     * @returns {Promise<boolean>}
     */
    async putObject(key, buffer, mimeType = "image/jpeg") {
        try {
            const payloadHash = sha256Hex(buffer);
            const signed = signS3Request({
                config: this.config,
                method: "PUT",
                key,
                headers: { "content-type": mimeType },
                payloadHash,
            });
            const res = await this.fetchFn(signed.url, {
                method: "PUT",
                headers: signed.headers,
                body: buffer,
            });
            return res.status === 200 || res.status === 204;
        } catch (err) {
            console.warn("Storage object put error:", err?.message);
            return false;
        }
    }

    async objectExists(key) {
        try {
            const signed = signS3Request({
                config: this.config,
                method: "HEAD",
                key,
            });
            const res = await this.fetchFn(signed.url, {
                method: "HEAD",
                headers: signed.headers,
            });

            if (res.status === 200) {
                return true;
            }
            if (res.status === 404) {
                return false;
            }
            if (res.status === 403) {
                const err = new Error("Storage provider access denied. S3/R2 bucket credentials or permissions invalid.");
                err.statusCode = 503;
                err.code = "STORAGE_UNAVAILABLE";
                throw err;
            }
            return false;
        } catch (err) {
            if (err.statusCode) throw err;
            const error = new Error(`Storage provider connection error: ${err.message}`);
            error.statusCode = 503;
            error.code = "STORAGE_UNAVAILABLE";
            throw error;
        }
    }

    async getObjectMetadata(key) {
        try {
            const signed = signS3Request({
                config: this.config,
                method: "HEAD",
                key,
            });
            const res = await this.fetchFn(signed.url, {
                method: "HEAD",
                headers: signed.headers,
            });

            if (res.status === 200) {
                const contentLength = res.headers?.get
                    ? res.headers.get("content-length")
                    : res.headers?.["content-length"];
                const contentType = res.headers?.get
                    ? res.headers.get("content-type")
                    : res.headers?.["content-type"];
                const lastModified = res.headers?.get
                    ? res.headers.get("last-modified")
                    : res.headers?.["last-modified"];
                const etag = res.headers?.get
                    ? res.headers.get("etag")
                    : res.headers?.["etag"];

                return {
                    size: contentLength ? parseInt(contentLength, 10) : 0,
                    contentType: contentType ? contentType.split(";")[0].trim().toLowerCase() : "",
                    lastModified: lastModified || null,
                    etag: etag || null,
                };
            }
            if (res.status === 404) {
                return null;
            }
            if (res.status === 403) {
                const err = new Error("Storage provider access denied. S3/R2 bucket credentials or permissions invalid.");
                err.statusCode = 503;
                err.code = "STORAGE_UNAVAILABLE";
                throw err;
            }
            return null;
        } catch (err) {
            if (err.statusCode) throw err;
            const error = new Error(`Storage provider connection error: ${err.message}`);
            error.statusCode = 503;
            error.code = "STORAGE_UNAVAILABLE";
            throw error;
        }
    }

    async deleteObject(key) {
        try {
            const signed = signS3Request({
                config: this.config,
                method: "DELETE",
                key,
            });
            const res = await this.fetchFn(signed.url, {
                method: "DELETE",
                headers: signed.headers,
            });

            return res.status === 204 || res.status === 200 || res.status === 404;
        } catch (err) {
            console.warn("Non-fatal storage object delete error:", err?.message);
            return false;
        }
    }
}

// Active singleton adapter
let currentAdapter = null;

export function getStorageAdapter() {
    if (!currentAdapter) {
        const isProduction = process.env.NODE_ENV === "production";
        const validation = validateStorageConfig();

        if (validation.valid) {
            currentAdapter = new S3StorageAdapter(validation.config);
        } else if (isProduction) {
            currentAdapter = new StorageUnavailableAdapter(validation.reason);
        } else if (process.env.STORAGE_PROVIDER === "s3" || process.env.STORAGE_PROVIDER === "r2") {
            // In dev/test, if S3/R2 was specifically requested but configuration is invalid, fail closed
            currentAdapter = new StorageUnavailableAdapter(validation.reason);
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
                // Delete oversized object from storage to free up space and prevent unverified files
                try {
                    await adapter.deleteObject(key);
                } catch (cleanupErr) {
                    console.warn("Non-fatal cleanup error for oversized object:", cleanupErr?.message);
                }
                const error = new Error(`Uploaded file size (${meta.size} bytes) exceeds maximum allowed limit of ${Math.round((tokenClaims.maxSizeBytes || MAX_PHOTO_BYTES) / (1024 * 1024))}MB`);
                error.statusCode = 400;
                throw error;
            }
            if (meta.contentType && tokenClaims.expectedMime && meta.contentType !== tokenClaims.expectedMime) {
                // Delete mismatched content-type object from storage
                try {
                    await adapter.deleteObject(key);
                } catch (cleanupErr) {
                    console.warn("Non-fatal cleanup error for mismatched content-type object:", cleanupErr?.message);
                }
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

    // Construct resulting public URL or private media delivery URL
    let publicUrl;
    if (adapter.name === "mock") {
        const baseUrl = process.env.STORAGE_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8000}`;
        publicUrl = `${baseUrl}/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`;
    } else if (adapter.publicBaseUrl && !adapter.config?.isPrivate) {
        publicUrl = `${adapter.publicBaseUrl}/${key}`;
    } else {
        const apiBase = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
        publicUrl = apiBase
            ? `${apiBase.replace(/\/+$/, "")}/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`
            : `/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`;
    }

    // Validate the resulting URL through host allowlist and SSRF checks
    let adapterHost = null;
    try {
        if (publicUrl) {
            adapterHost = new URL(publicUrl).hostname;
        }
    } catch { /* ignore */ }

    const urlValidation = validatePublicPhotoUrl(
        publicUrl,
        adapterHost ? { additionalApprovedHosts: [adapterHost] } : {}
    );
    if (!urlValidation.valid) {
        throw new Error(`Validated URL rejected: ${urlValidation.error}`);
    }

    // Capture existing photos array for safe rollback on persistence error
    const previousPhotos = Array.isArray(user.photos) ? [...user.photos] : [];
    const effectiveTargetIndex = targetIndex !== undefined ? Number(targetIndex) : tokenClaims.targetIndex;
    const previousPhotoUrl =
        typeof effectiveTargetIndex === "number" && effectiveTargetIndex >= 0 && effectiveTargetIndex < previousPhotos.length
            ? previousPhotos[effectiveTargetIndex]
            : null;

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

    // Save user profile with rollback protection
    try {
        await user.save();
    } catch (saveError) {
        // Safe rollback: delete the newly uploaded object from storage if database persistence fails
        try {
            await adapter.deleteObject(key);
        } catch (cleanupErr) {
            console.warn("Non-fatal cleanup error on persistence failure:", cleanupErr?.message);
        }
        throw saveError;
    }

    // On successful replacement, clean up old photo from storage if it belonged to our platform
    if (previousPhotoUrl && previousPhotoUrl !== publicUrl && previousPhotoUrl.includes("/profile-photos/")) {
        const keyMatch = previousPhotoUrl.match(/(profile-photos\/[^?]+)/);
        if (keyMatch) {
            const oldKey = decodeURIComponent(keyMatch[1]);
            if (oldKey.startsWith(`profile-photos/${userId}/`)) {
                try {
                    await adapter.deleteObject(oldKey);
                } catch (cleanupErr) {
                    console.warn("Non-fatal cleanup error for replaced photo:", cleanupErr?.message);
                }
            }
        }
    }

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
        if (removedUrl && removedUrl.includes("/profile-photos/")) {
            const keyMatch = removedUrl.match(/(profile-photos\/[^?]+)/);
            if (keyMatch) {
                const key = decodeURIComponent(keyMatch[1]);
                // Ensure key belongs to current user to prevent deleting another user's photos
                if (key.startsWith(`profile-photos/${userId}/`)) {
                    const adapter = getStorageAdapter();
                    await adapter.deleteObject(key);
                }
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
