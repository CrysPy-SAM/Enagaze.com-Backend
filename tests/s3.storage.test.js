import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { User } from "../src/models/user.model.js";
import {
    validateStorageConfig,
    S3StorageAdapter,
    StorageUnavailableAdapter,
    DevMockStorageAdapter,
    getStorageAdapter,
    setStorageAdapter,
    requestPhotoUploadAuthorization,
    confirmPhotoUpload,
    deleteProfilePhoto,
    createUploadToken,
    verifyUploadToken,
} from "../src/services/storage.service.js";
import {
    generatePresignedPutUrl,
    signS3Request,
    resolveEndpoint,
    uriEncode,
    sha256Hex,
} from "../src/services/s3Signer.service.js";

describe("Prompt 16: Production-Ready S3/R2 Profile Photo Storage Integration Suite", () => {
    const userAliceId = new mongoose.Types.ObjectId("65cb11111111111111111111");
    const userBobId = new mongoose.Types.ObjectId("65cb22222222222222222222");

    let originalEnv;
    let mockAlice;
    let mockBob;

    const validAwsEnv = {
        STORAGE_PROVIDER: "s3",
        STORAGE_BUCKET: "engaze-profile-photos",
        STORAGE_REGION: "us-east-1",
        STORAGE_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        STORAGE_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        STORAGE_PUBLIC_BASE_URL: "https://photos.engaze.com",
    };

    const validR2Env = {
        STORAGE_PROVIDER: "r2",
        STORAGE_BUCKET: "engaze-r2-photos",
        STORAGE_REGION: "auto",
        STORAGE_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
        STORAGE_ACCESS_KEY_ID: "r2_access_key_123456",
        STORAGE_SECRET_ACCESS_KEY: "r2_secret_key_78901234567",
        STORAGE_PUBLIC_BASE_URL: "https://photos.engaze.com",
    };

    before(() => {
        originalEnv = { ...process.env };
    });

    after(() => {
        process.env = { ...originalEnv };
        setStorageAdapter(null);
    });

    beforeEach(() => {
        setStorageAdapter(null);
        process.env.JWT_SECRET = "test-jwt-secret-for-s3-integration-minimum-32-chars";

        mockAlice = {
            _id: userAliceId,
            name: "Alice Active",
            photos: ["https://photos.engaze.com/profile-photos/65cb11111111111111111111/existing1.jpg"],
            save: async function () {
                return this;
            },
        };

        mockBob = {
            _id: userBobId,
            name: "Bob Builder",
            photos: ["https://photos.engaze.com/profile-photos/65cb22222222222222222222/existingBob.jpg"],
            save: async function () {
                return this;
            },
        };

        User.findById = async (id) => {
            if (String(id) === String(userAliceId)) return mockAlice;
            if (String(id) === String(userBobId)) return mockBob;
            return null;
        };
    });

    afterEach(() => {
        setStorageAdapter(null);
        process.env = { ...originalEnv };
    });

    describe("1. Environment Configuration & Validation", () => {
        it("validates complete AWS S3 configuration successfully", () => {
            const result = validateStorageConfig(validAwsEnv);
            assert.equal(result.valid, true);
            assert.equal(result.config.provider, "s3");
            assert.equal(result.config.bucket, "engaze-profile-photos");
            assert.equal(result.config.region, "us-east-1");
            assert.equal(result.config.accessKeyId, "AKIAIOSFODNN7EXAMPLE");
            assert.equal(result.config.secretAccessKey, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
            assert.equal(result.config.publicBaseUrl, "https://photos.engaze.com");
            assert.equal(result.config.endpoint, null);
            assert.equal(result.config.forcePathStyle, false);
        });

        it("validates complete Cloudflare R2 configuration with custom endpoint successfully", () => {
            const result = validateStorageConfig(validR2Env);
            assert.equal(result.valid, true);
            assert.equal(result.config.provider, "r2");
            assert.equal(result.config.bucket, "engaze-r2-photos");
            assert.equal(result.config.region, "auto");
            assert.equal(result.config.endpoint, "https://0123456789abcdef.r2.cloudflarestorage.com");
            assert.equal(result.config.forcePathStyle, true);
        });

        it("supports provider-specific fallback variable names (AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)", () => {
            const fallbackEnv = {
                STORAGE_PROVIDER: "s3",
                AWS_S3_BUCKET: "fallback-aws-bucket",
                AWS_REGION: "eu-west-1",
                AWS_ACCESS_KEY_ID: "AWS_ACCESS_KEY_XYZ",
                AWS_SECRET_ACCESS_KEY: "AWS_SECRET_KEY_12345678",
                AWS_S3_PUBLIC_URL: "https://cdn.engaze.com",
            };
            const result = validateStorageConfig(fallbackEnv);
            assert.equal(result.valid, true);
            assert.equal(result.config.bucket, "fallback-aws-bucket");
            assert.equal(result.config.region, "eu-west-1");
            assert.equal(result.config.publicBaseUrl, "https://cdn.engaze.com");
        });

        it("fails validation when STORAGE_PROVIDER is missing or unsupported", () => {
            const result = validateStorageConfig({ ...validAwsEnv, STORAGE_PROVIDER: "local_disk" });
            assert.equal(result.valid, false);
            assert.ok(result.reason.includes("STORAGE_PROVIDER is not set to 's3' or 'r2'"));
        });

        it("fails validation when storage bucket is missing or empty", () => {
            const result = validateStorageConfig({ ...validAwsEnv, STORAGE_BUCKET: "" });
            assert.equal(result.valid, false);
            assert.ok(result.reason.includes("Missing required storage bucket configuration"));
        });

        it("fails validation when storage access key is missing or too short", () => {
            const result = validateStorageConfig({ ...validAwsEnv, STORAGE_ACCESS_KEY_ID: "abc" });
            assert.equal(result.valid, false);
            assert.ok(result.reason.includes("Missing or invalid storage access key ID"));
        });

        it("fails validation when storage secret key is missing or too short", () => {
            const result = validateStorageConfig({ ...validAwsEnv, STORAGE_SECRET_ACCESS_KEY: "short" });
            assert.equal(result.valid, false);
            assert.ok(result.reason.includes("Missing or invalid storage secret access key"));
        });

        it("fails validation when publicBaseUrl is missing or not an HTTP/HTTPS URL", () => {
            const result = validateStorageConfig({ ...validAwsEnv, STORAGE_PUBLIC_BASE_URL: "ftp://photos.com" });
            assert.equal(result.valid, false);
            assert.ok(result.reason.includes("public delivery base URL"));
        });

        it("validation failure messages never print secret keys or credentials", () => {
            const badEnv = {
                STORAGE_PROVIDER: "s3",
                STORAGE_BUCKET: "",
                STORAGE_ACCESS_KEY_ID: "MY_CONFIDENTIAL_KEY_ID",
                STORAGE_SECRET_ACCESS_KEY: "SUPER_SECRET_VALUE_DO_NOT_LEAK",
                STORAGE_PUBLIC_BASE_URL: "https://photos.engaze.com",
            };
            const result = validateStorageConfig(badEnv);
            assert.equal(result.valid, false);
            assert.equal(result.reason.includes("SUPER_SECRET_VALUE_DO_NOT_LEAK"), false);
            assert.equal(result.reason.includes("MY_CONFIDENTIAL_KEY_ID"), false);
        });
    });

    describe("2. Fail-Closed Behavior in Production & Unconfigured State", () => {
        it("returns StorageUnavailableAdapter in production when storage configuration is missing", () => {
            delete process.env.STORAGE_PROVIDER;
            delete process.env.STORAGE_BUCKET;
            process.env.NODE_ENV = "production";

            const adapter = getStorageAdapter();
            assert.equal(adapter.name, "unavailable");
        });

        it("never returns DevMockStorageAdapter in production under any circumstances", () => {
            process.env.NODE_ENV = "production";
            process.env.STORAGE_PROVIDER = "mock"; // Attempted dev bypass

            const adapter = getStorageAdapter();
            assert.notEqual(adapter.name, "mock");
            assert.equal(adapter.name, "unavailable");
        });

        it("StorageUnavailableAdapter rejects presigned upload request with 503 STORAGE_UNAVAILABLE", async () => {
            const unavailable = new StorageUnavailableAdapter("Missing S3 credentials");
            setStorageAdapter(unavailable);

            await assert.rejects(
                async () => {
                    await requestPhotoUploadAuthorization(mockAlice, {
                        filename: "test.jpg",
                        contentType: "image/jpeg",
                        fileSize: 1024 * 100,
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 503);
                    assert.equal(err.code, "STORAGE_UNAVAILABLE");
                    assert.ok(err.message.includes("temporarily unavailable"));
                    return true;
                }
            );
        });

        it("StorageUnavailableAdapter rejects upload confirmation with 503 STORAGE_UNAVAILABLE", async () => {
            const unavailable = new StorageUnavailableAdapter("Missing S3 credentials");
            setStorageAdapter(unavailable);

            const uploadToken = createUploadToken({
                userId: userAliceId,
                key: "profile-photos/65cb11111111111111111111/photo.jpg",
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, {
                        key: "profile-photos/65cb11111111111111111111/photo.jpg",
                        uploadToken,
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 503);
                    assert.equal(err.code, "STORAGE_UNAVAILABLE");
                    return true;
                }
            );
        });
    });

    describe("3. Presigned Upload URL Generation & SigV4 Signing", () => {
        let s3Adapter;

        beforeEach(() => {
            const validation = validateStorageConfig(validAwsEnv);
            s3Adapter = new S3StorageAdapter(validation.config);
            setStorageAdapter(s3Adapter);
        });

        it("generates presigned upload URL with valid SigV4 parameters and permanent public URL", async () => {
            const authResult = await requestPhotoUploadAuthorization(mockAlice, {
                filename: "selfie.jpg",
                contentType: "image/jpeg",
                fileSize: 1024 * 500,
            });

            assert.equal(authResult.provider, "s3");
            assert.ok(authResult.uploadUrl.startsWith("https://engaze-profile-photos.s3.amazonaws.com/profile-photos/"));
            assert.ok(authResult.uploadUrl.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
            assert.ok(authResult.uploadUrl.includes("X-Amz-Credential="));
            assert.ok(authResult.uploadUrl.includes("X-Amz-SignedHeaders=content-type%3Bhost"));
            assert.ok(authResult.uploadUrl.includes("X-Amz-Signature="));
            assert.ok(authResult.uploadUrl.includes("X-Amz-Expires=300"));

            // Permanent public delivery URL uses configured CDN, not expiring presigned query string
            assert.ok(authResult.publicUrl.startsWith("https://photos.engaze.com/profile-photos/"));
            assert.equal(authResult.publicUrl.includes("X-Amz-Signature"), false);

            // Server-issued HMAC token is attached
            assert.ok(authResult.uploadToken);
            const verified = verifyUploadToken(authResult.uploadToken, userAliceId, authResult.key);
            assert.equal(verified.userId, String(userAliceId));
            assert.equal(verified.key, authResult.key);
            assert.equal(verified.expectedMime, "image/jpeg");
        });

        it("Cloudflare R2 adapter generates path-style presigned URL targeted to R2 endpoint", async () => {
            const r2Validation = validateStorageConfig(validR2Env);
            const r2Adapter = new S3StorageAdapter(r2Validation.config);
            setStorageAdapter(r2Adapter);

            const authResult = await requestPhotoUploadAuthorization(mockAlice, {
                filename: "avatar.png",
                contentType: "image/png",
                fileSize: 1024 * 300,
            });

            assert.equal(authResult.provider, "r2");
            assert.ok(authResult.uploadUrl.startsWith("https://0123456789abcdef.r2.cloudflarestorage.com/engaze-r2-photos/profile-photos/"));
            assert.ok(authResult.uploadUrl.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
            assert.ok(authResult.uploadUrl.includes("auto%2Fs3%2Faws4_request"));
            assert.ok(authResult.publicUrl.startsWith("https://photos.engaze.com/profile-photos/"));
        });

        it("rejects unauthorized MIME types before generating presigned URL", async () => {
            await assert.rejects(
                async () => {
                    await requestPhotoUploadAuthorization(mockAlice, {
                        filename: "malicious.exe",
                        contentType: "application/x-msdownload",
                        fileSize: 1024,
                    });
                },
                (err) => {
                    assert.ok(err.message.includes("Invalid or unsupported content type"));
                    return true;
                }
            );
        });

        it("rejects files exceeding MAX_PHOTO_BYTES before generating presigned URL", async () => {
            await assert.rejects(
                async () => {
                    await requestPhotoUploadAuthorization(mockAlice, {
                        filename: "giant.jpg",
                        contentType: "image/jpeg",
                        fileSize: 10 * 1024 * 1024, // 10MB > 5MB limit
                    });
                },
                (err) => {
                    assert.ok(err.message.includes("exceeds maximum allowed limit"));
                    return true;
                }
            );
        });
    });

    describe("4. Upload Confirmation & Server-Authoritative Metadata Checks", () => {
        it("confirms upload and updates profile when object exists and matches token metadata", async () => {
            const key = `profile-photos/${userAliceId}/photo1.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            // Mock S3 REST HEAD returning 200 with 150KB image/jpeg
            const mockFetch = async (url, options) => {
                if (options.method === "HEAD") {
                    return {
                        status: 200,
                        headers: new Map([
                            ["content-length", "153600"],
                            ["content-type", "image/jpeg"],
                            ["etag", '"abc123etag"'],
                        ]),
                    };
                }
                return { status: 404 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            const result = await confirmPhotoUpload(userAliceId, { key, uploadToken });
            assert.equal(result.success, true);
            assert.equal(result.publicUrl, `https://photos.engaze.com/${key}`);
            assert.ok(result.photos.includes(`https://photos.engaze.com/${key}`));
        });

        it("rejects confirmation with 400 when object does not exist in storage", async () => {
            const key = `profile-photos/${userAliceId}/nonexistent.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            // Mock S3 HEAD returning 404 Not Found
            const mockFetch = async () => ({ status: 404, headers: new Map() });
            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key, uploadToken });
                },
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.ok(err.message.includes("Uploaded photo not found in storage"));
                    return true;
                }
            );
        });

        it("rejects oversized object, deletes it from S3, and leaves existing photos intact", async () => {
            const key = `profile-photos/${userAliceId}/oversized.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            let deleteCalledWith = null;

            // Mock S3 HEAD returning 8MB (exceeds 5MB limit)
            const mockFetch = async (url, options) => {
                if (options.method === "HEAD") {
                    return {
                        status: 200,
                        headers: new Map([
                            ["content-length", String(8 * 1024 * 1024)],
                            ["content-type", "image/jpeg"],
                        ]),
                    };
                }
                if (options.method === "DELETE") {
                    deleteCalledWith = url;
                    return { status: 204 };
                }
                return { status: 404 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            const initialAlicePhotos = [...mockAlice.photos];

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key, uploadToken });
                },
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.ok(err.message.includes("exceeds maximum allowed limit"));
                    return true;
                }
            );

            // Verified: Oversized object was deleted from S3
            assert.ok(deleteCalledWith && deleteCalledWith.includes(key));
            // Verified: Existing profile photos remain preserved
            assert.deepEqual(mockAlice.photos, initialAlicePhotos);
        });

        it("rejects mismatched content-type, deletes it from S3, and leaves existing photos intact", async () => {
            const key = `profile-photos/${userAliceId}/fake-jpeg.png`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg", // Authorized for JPEG
                maxSizeBytes: 5 * 1024 * 1024,
            });

            let deleteCalledWith = null;

            // Mock S3 HEAD returning image/png instead of expected image/jpeg
            const mockFetch = async (url, options) => {
                if (options.method === "HEAD") {
                    return {
                        status: 200,
                        headers: new Map([
                            ["content-length", "204800"],
                            ["content-type", "image/png"],
                        ]),
                    };
                }
                if (options.method === "DELETE") {
                    deleteCalledWith = url;
                    return { status: 204 };
                }
                return { status: 404 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            const initialAlicePhotos = [...mockAlice.photos];

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key, uploadToken });
                },
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.ok(err.message.includes("does not match authorized content type"));
                    return true;
                }
            );

            assert.ok(deleteCalledWith && deleteCalledWith.includes(key));
            assert.deepEqual(mockAlice.photos, initialAlicePhotos);
        });
    });

    describe("5. Authorization & Cross-Account Protection", () => {
        it("rejects confirmation when User Bob attempts to confirm User Alice's upload token", async () => {
            const key = `profile-photos/${userAliceId}/alice.jpg`;
            const aliceToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            await assert.rejects(
                async () => {
                    // Bob attempts to confirm Alice's token
                    await confirmPhotoUpload(userBobId, { key, uploadToken: aliceToken });
                },
                (err) => {
                    assert.ok(err.message.includes("Upload token is not authorized for this user account"));
                    return true;
                }
            );
        });

        it("rejects confirmation when upload token was tampered with", async () => {
            const key = `profile-photos/${userAliceId}/alice.jpg`;
            const validToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            const tamperedToken = validToken.slice(0, -5) + "abcde";

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key, uploadToken: tamperedToken });
                },
                (err) => {
                    assert.ok(err.message.includes("Invalid upload authorization token signature"));
                    return true;
                }
            );
        });

        it("rejects confirmation when upload token has expired", async () => {
            const key = `profile-photos/${userAliceId}/alice.jpg`;
            const expiredToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
                expiresAt: Date.now() - 1000, // Expired 1 second ago
            });

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key, uploadToken: expiredToken });
                },
                (err) => {
                    assert.ok(err.message.includes("Upload authorization token has expired"));
                    return true;
                }
            );
        });

        it("rejects confirmation when token targetIndex does not match request targetIndex", async () => {
            const key = `profile-photos/${userAliceId}/alice.jpg`;
            const slotBoundToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
                targetIndex: 0, // Bound strictly to slot 0
            });

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, {
                        key,
                        uploadToken: slotBoundToken,
                        targetIndex: 2, // Requesting slot 2
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.ok(err.message.includes("Upload token is bound to a different photo slot"));
                    return true;
                }
            );
        });
    });

    describe("6. Safe Photo Replacement & Cleanup Resilience", () => {
        it("cleans up replaced photo from S3 only AFTER database save succeeds", async () => {
            const oldPhotoUrl = "https://photos.engaze.com/profile-photos/65cb11111111111111111111/oldPhoto.jpg";
            mockAlice.photos = [oldPhotoUrl];

            const newKey = `profile-photos/${userAliceId}/newPhoto.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key: newKey,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
                targetIndex: 0,
            });

            let deletedKey = null;

            const mockFetch = async (url, options) => {
                if (options.method === "HEAD") {
                    return {
                        status: 200,
                        headers: new Map([
                            ["content-length", "100000"],
                            ["content-type", "image/jpeg"],
                        ]),
                    };
                }
                if (options.method === "DELETE") {
                    deletedKey = url;
                    return { status: 204 };
                }
                return { status: 404 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            const result = await confirmPhotoUpload(userAliceId, { key: newKey, uploadToken, targetIndex: 0 });
            assert.equal(result.success, true);
            assert.equal(mockAlice.photos[0], `https://photos.engaze.com/${newKey}`);

            // Old photo was deleted from S3
            assert.ok(deletedKey && deletedKey.includes("oldPhoto.jpg"));
        });

        it("preserves old photo and rolls back new uploaded object if database save fails", async () => {
            const oldPhotoUrl = "https://photos.engaze.com/profile-photos/65cb11111111111111111111/oldPhoto.jpg";
            mockAlice.photos = [oldPhotoUrl];
            mockAlice.save = async () => {
                throw new Error("Simulated MongoDB write error");
            };

            const newKey = `profile-photos/${userAliceId}/newPhoto.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key: newKey,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
                targetIndex: 0,
            });

            let deletedKey = null;

            const mockFetch = async (url, options) => {
                if (options.method === "HEAD") {
                    return {
                        status: 200,
                        headers: new Map([
                            ["content-length", "100000"],
                            ["content-type", "image/jpeg"],
                        ]),
                    };
                }
                if (options.method === "DELETE") {
                    deletedKey = url;
                    return { status: 204 };
                }
                return { status: 404 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key: newKey, uploadToken, targetIndex: 0 });
                },
                (err) => {
                    assert.ok(err.message.includes("Simulated MongoDB write error"));
                    return true;
                }
            );

            // Verified: The newly uploaded object was rolled back/deleted from S3
            assert.ok(deletedKey && deletedKey.includes(newKey));
            // Verified: Old photo was NOT deleted
            assert.ok(!deletedKey.includes("oldPhoto.jpg"));
        });

        it("deleteProfilePhoto removes photo from user doc and deletes object from S3", async () => {
            const photoUrl = `https://photos.engaze.com/profile-photos/${userAliceId}/todelete.jpg`;
            mockAlice.photos = [photoUrl];

            let deletedUrl = null;
            const mockFetch = async (url, options) => {
                if (options.method === "DELETE") {
                    deletedUrl = url;
                    return { status: 204 };
                }
                return { status: 200 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            const result = await deleteProfilePhoto(userAliceId, 0);
            assert.equal(result.success, true);
            assert.equal(result.photos.length, 0);
            assert.ok(deletedUrl && deletedUrl.includes("todelete.jpg"));
        });

        it("deleteProfilePhoto prevents deleting photos belonging to a different user account", async () => {
            // Suppose photo URL contains another user's key
            const foreignPhotoUrl = `https://photos.engaze.com/profile-photos/${userBobId}/bobsPhoto.jpg`;
            mockAlice.photos = [foreignPhotoUrl];

            let deleteCalled = false;
            const mockFetch = async () => {
                deleteCalled = true;
                return { status: 204 };
            };

            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            const result = await deleteProfilePhoto(userAliceId, 0);
            assert.equal(result.success, true);
            // S3 delete was blocked by security prefix check (key must match profile-photos/${userId}/)
            assert.equal(deleteCalled, false);
        });
    });

    describe("7. S3 Provider Errors & Sanitized Responses", () => {
        it("returns sanitized 503 error when S3 returns 403 Forbidden without disclosing secrets", async () => {
            const key = `profile-photos/${userAliceId}/forbidden.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            // Mock S3 HEAD returning 403 Access Denied
            const mockFetch = async () => ({ status: 403, headers: new Map() });
            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });
            setStorageAdapter(s3Adapter);

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userAliceId, { key, uploadToken });
                },
                (err) => {
                    assert.equal(err.statusCode, 503);
                    assert.equal(err.code, "STORAGE_UNAVAILABLE");
                    assert.ok(err.message.includes("Storage provider access denied"));
                    // Verified: No secrets or credentials in error message
                    assert.equal(err.message.includes("AKIA"), false);
                    assert.equal(err.message.includes("Secret"), false);
                    return true;
                }
            );
        });

        it("handles network failure gracefully during objectExists with 503 STORAGE_UNAVAILABLE", async () => {
            const mockFetch = async () => {
                throw new Error("getaddrinfo ENOTFOUND engaze-profile-photos.s3.amazonaws.com");
            };
            const s3Adapter = new S3StorageAdapter(validateStorageConfig(validAwsEnv).config, { fetchFn: mockFetch });

            await assert.rejects(
                async () => {
                    await s3Adapter.objectExists("profile-photos/u1/photo.jpg");
                },
                (err) => {
                    assert.equal(err.statusCode, 503);
                    assert.equal(err.code, "STORAGE_UNAVAILABLE");
                    return true;
                }
            );
        });
    });

    describe("8. Private S3 Bucket Support & Media URL Resolution", () => {
        const privateS3Env = {
            STORAGE_PROVIDER: "s3",
            STORAGE_BUCKET: "engaze-profile-photos-unique",
            STORAGE_REGION: "ap-southeast-2",
            STORAGE_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
            STORAGE_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            // Notice: STORAGE_PUBLIC_BASE_URL is intentionally omitted
        };

        it("validates private S3 configuration without STORAGE_PUBLIC_BASE_URL", () => {
            const result = validateStorageConfig(privateS3Env);
            assert.equal(result.valid, true);
            assert.equal(result.config.isPrivate, true);
            assert.equal(result.config.publicBaseUrl, null);
            assert.equal(result.config.region, "ap-southeast-2");
            assert.equal(result.config.bucket, "engaze-profile-photos-unique");
        });

        it("generates presigned download GET URL with SigV4 authentication parameters", async () => {
            const config = validateStorageConfig(privateS3Env).config;
            const adapter = new S3StorageAdapter(config);
            const downloadUrl = await adapter.getPresignedDownloadUrl("profile-photos/alice/pic.jpg", 600);

            assert.ok(downloadUrl.startsWith("https://engaze-profile-photos-unique.s3.ap-southeast-2.amazonaws.com/profile-photos/alice/pic.jpg?"));
            const parsed = new URL(downloadUrl);
            assert.equal(parsed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
            assert.ok(parsed.searchParams.get("X-Amz-Credential").includes("ap-southeast-2/s3/aws4_request"));
            assert.equal(parsed.searchParams.get("X-Amz-Expires"), "600");
            assert.ok(parsed.searchParams.get("X-Amz-Signature"));
        });

        it("confirms photo upload in private mode and stores backend media path in user profile", async () => {
            const key = `profile-photos/${userAliceId}/avatar.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            const headersMap = new Map();
            headersMap.set("content-type", "image/jpeg");
            headersMap.set("content-length", "2048");

            const mockFetch = async (url, opts) => {
                if (opts?.method === "HEAD") {
                    return {
                        status: 200,
                        headers: {
                            get: (h) => headersMap.get(h.toLowerCase()),
                        },
                    };
                }
                return { status: 200, headers: { get: () => null } };
            };

            const config = validateStorageConfig(privateS3Env).config;
            const adapter = new S3StorageAdapter(config, { fetchFn: mockFetch });
            setStorageAdapter(adapter);

            const result = await confirmPhotoUpload(userAliceId, { key, uploadToken });
            assert.equal(result.success, true);
            const expectedUrl = `/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`;
            assert.equal(result.publicUrl, expectedUrl);
            assert.ok(mockAlice.photos.includes(expectedUrl));
        });

        it("cleans up previous private-mode photo key from S3 when photo is replaced", async () => {
            const oldKey = `profile-photos/${userAliceId}/old_private.jpg`;
            mockAlice.photos = [`/api/v1/users/profile/photo/media/${oldKey}`];

            const newKey = `profile-photos/${userAliceId}/new_private.jpg`;
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key: newKey,
                expectedMime: "image/jpeg",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            const deletedKeys = [];
            const mockFetch = async (url, opts) => {
                if (opts?.method === "HEAD") {
                    return {
                        status: 200,
                        headers: {
                            get: (h) => (h.toLowerCase() === "content-type" ? "image/jpeg" : "2048"),
                        },
                    };
                }
                if (opts?.method === "DELETE") {
                    deletedKeys.push(url);
                    return { status: 204, headers: { get: () => null } };
                }
                return { status: 200, headers: { get: () => null } };
            };

            const config = validateStorageConfig(privateS3Env).config;
            const adapter = new S3StorageAdapter(config, { fetchFn: mockFetch });
            setStorageAdapter(adapter);

            const result = await confirmPhotoUpload(userAliceId, { key: newKey, uploadToken, targetIndex: 0 });
            assert.equal(result.success, true);
            assert.equal(deletedKeys.length, 1);
            assert.ok(deletedKeys[0].includes("old_private.jpg"));
        });
    });
});

