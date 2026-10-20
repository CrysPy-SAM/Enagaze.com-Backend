import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import usersRouter from "../src/routes/users.routes.js";
import {
    detectMimeType,
    extractDimensions,
    validateImageBuffer,
    stripMetadata,
    validatePublicPhotoUrl,
    MAX_PHOTO_BYTES,
    MIN_DIMENSION_PX,
    MAX_DIMENSION_PX,
} from "../src/services/imageValidation.service.js";
import {
    createUploadToken,
    verifyUploadToken,
    generatePhotoKey,
    getStorageAdapter,
    setStorageAdapter,
    DevMockStorageAdapter,
    StorageUnavailableAdapter,
    requestPhotoUploadAuthorization,
    confirmPhotoUpload,
    deleteProfilePhoto,
} from "../src/services/storage.service.js";
import {
    createMockPngWithMetadata,
    createMockJpegWithExif,
    createMockWebPWithExif,
} from "./helpers/mockImages.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

describe("Prompt 14: Safe Profile Image Upload Pipeline Suite", () => {
    let server;
    let app;

    let originalUserFindById;
    let originalUserFindOne;
    let originalUserSave;

    const userAliceId = new mongoose.Types.ObjectId("65cb11111111111111111111");
    const userBobId = new mongoose.Types.ObjectId("65cb22222222222222222222");

    let mockAlice;
    let mockBob;

    before(() => {
        app = express();
        app.use(express.json({ limit: "40kb" }));
        app.use(express.urlencoded({ limit: "40kb", extended: true }));
        app.use("/api/v1/users", usersRouter);
        server = createServer(app);
    });

    beforeEach(() => {
        // Reset in-memory storage adapter
        const adapter = getStorageAdapter();
        if (adapter && typeof adapter.clearAll === "function") {
            adapter.clearAll();
        }

        mockAlice = {
            _id: userAliceId,
            name: "Alice Active",
            username: "alice_active",
            dob: new Date("1996-06-15"),
            gender: "female",
            bio: "Photography and travel lover",
            photos: ["https://images.unsplash.com/photo-1534528741775-53994a69daeb"],
            interests: ["photography", "travel"],
            isProfileComplete: true,
            datingPreferences: {
                interestedIn: ["male"],
                ageRange: { min: 25, max: 40 },
            },
            save: async function () {
                return this;
            },
            toJSON: function () {
                return { ...this };
            },
        };

        mockBob = {
            _id: userBobId,
            name: "Bob Builder",
            username: "bob_builder",
            dob: new Date("1994-04-10"),
            gender: "male",
            bio: "Architect and hiker",
            photos: ["https://lh3.googleusercontent.com/a/mock-bob"],
            interests: ["hiking", "design"],
            isProfileComplete: true,
            datingPreferences: {
                interestedIn: ["female"],
                ageRange: { min: 22, max: 35 },
            },
            save: async function () {
                return this;
            },
            toJSON: function () {
                return { ...this };
            },
        };

        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;

        const makeQueryDoc = (doc) => {
            if (!doc) {
                return {
                    select: () => Promise.resolve(null),
                    then: (resolve) => resolve(null),
                };
            }
            return {
                select: () => Promise.resolve(doc),
                then: (resolve) => resolve(doc),
            };
        };

        User.findById = (id) => {
            const idStr = String(id);
            if (idStr === String(userAliceId)) {
                return makeQueryDoc(mockAlice);
            }
            if (idStr === String(userBobId)) {
                return makeQueryDoc(mockBob);
            }
            return makeQueryDoc(null);
        };

        User.findOne = (query) => {
            if (query && query._id) {
                return User.findById(query._id);
            }
            return makeQueryDoc(null);
        };
    });

    afterEach(() => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;
    });

    // -------------------------------------------------------------
    // Scenario 1: Upload authorization for unauthenticated request (401)
    // -------------------------------------------------------------
    describe("Scenario 1: Upload authorization for unauthenticated request (401)", () => {
        it("rejects POST /profile/photo/upload-url without auth token with 401", async () => {
            const res = await request(app)
                .post("/api/v1/users/profile/photo/upload-url")
                .send({
                    filename: "photo.jpg",
                    contentType: "image/jpeg",
                    fileSize: 102400,
                });

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
        });

        it("rejects POST /profile/photo/confirm without auth token with 401", async () => {
            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .send({
                    key: "profile-photos/mock/fake.jpg",
                    uploadToken: "fake.token",
                });

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
        });

        it("rejects DELETE /profile/photo/:photoIndex without auth token with 401", async () => {
            const res = await request(app)
                .delete("/api/v1/users/profile/photo/0");

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
        });
    });

    // -------------------------------------------------------------
    // Scenario 2: Authorization requested for wrong user or key manipulation
    // -------------------------------------------------------------
    describe("Scenario 2: Authorization requested for wrong user or key manipulation", () => {
        it("rejects confirmation when uploadToken belongs to a different user account", async () => {
            const aliceToken = makeToken({ id: userAliceId.toString() });
            const bobToken = makeToken({ id: userBobId.toString() });

            // Generate upload token specifically authorized for Alice
            const targetKey = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadTokenForAlice = createUploadToken({
                userId: userAliceId,
                key: targetKey,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            // Bob tries to confirm using Alice's uploadToken
            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${bobToken}`)
                .send({
                    key: targetKey,
                    uploadToken: uploadTokenForAlice,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /not authorized for this user/i);
        });

        it("rejects confirmation when client modifies key to target another object key", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const authorizedKey = generatePhotoKey(userAliceId, "image/jpeg");
            const manipulatedKey = `profile-photos/${userAliceId}/manipulated-file.jpg`;

            const uploadToken = createUploadToken({
                userId: userAliceId,
                key: authorizedKey,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key: manipulatedKey,
                    uploadToken,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /not authorized for the specified object key/i);
        });

        it("rejects token with tampered HMAC signature", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");

            const validToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            const [payloadPart] = validToken.split(".");
            const tamperedToken = `${payloadPart}.tamperedSignature1234567890`;

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken: tamperedToken,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /signature/i);
        });
    });

    // -------------------------------------------------------------
    // Scenario 3: Expired and malformed signed upload requests
    // -------------------------------------------------------------
    describe("Scenario 3: Expired and malformed signed upload requests", () => {
        it("rejects upload token that has expired", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");

            // Create expired token (expiresAt 10 seconds ago)
            const expiredToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
                expiresAt: Date.now() - 10000,
            });

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken: expiredToken,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /expired/i);
        });

        it("rejects completely malformed upload token strings", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken: "not-a-valid-token-at-all",
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /malformed/i);
        });
    });

    // -------------------------------------------------------------
    // Scenario 4: Invalid or unapproved storage host rejection
    // -------------------------------------------------------------
    describe("Scenario 4: Invalid or unapproved storage host rejection", () => {
        it("rejects profile photo updates with unapproved third-party domains", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            const res = await request(app)
                .put("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    photos: [
                        "https://untrusted-host.evil.org/malicious.jpg",
                    ],
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /not on the approved storage domain list/i);
        });

        it("rejects arbitrary scheme protocols such as ftp, file, or data URI", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            for (const badUrl of [
                "ftp://images.unsplash.com/photo.jpg",
                "file:///etc/passwd",
                "javascript:alert(1)",
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            ]) {
                const res = await request(app)
                    .put("/api/v1/users/profile/me")
                    .set("Authorization", `Bearer ${aliceAuthToken}`)
                    .send({ photos: [badUrl] });

                assert.equal(res.status, 400);
                assert.equal(res.body.success, false);
            }
        });
    });

    // -------------------------------------------------------------
    // Scenario 5: Oversized (>5MB) and unsupported formats rejected
    // -------------------------------------------------------------
    describe("Scenario 5: Oversized (>5MB) and unsupported formats rejected", () => {
        it("rejects upload URL request with declared size > 5MB", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            const res = await request(app)
                .post("/api/v1/users/profile/photo/upload-url")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    filename: "huge.jpg",
                    contentType: "image/jpeg",
                    fileSize: 6 * 1024 * 1024, // 6 MB
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /exceeds maximum allowed limit/i);
        });

        it("rejects upload URL request with unsupported MIME types (SVG, PDF, HTML, EXE)", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            for (const badMime of [
                "image/svg+xml",
                "application/pdf",
                "text/html",
                "application/x-msdownload",
                "image/gif",
            ]) {
                const res = await request(app)
                    .post("/api/v1/users/profile/photo/upload-url")
                    .set("Authorization", `Bearer ${aliceAuthToken}`)
                    .send({
                        filename: "test.file",
                        contentType: badMime,
                        fileSize: 50000,
                    });

                assert.equal(res.status, 400);
                assert.equal(res.body.success, false);
                assert.match(res.body.message, /unsupported content type/i);
            }
        });

        it("rejects binary buffer exceeding 5MB during payload upload", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            // Create 5.5MB mock buffer
            const oversizedBuffer = Buffer.alloc(5.5 * 1024 * 1024);

            const res = await request(app)
                .put(`/api/v1/users/profile/photo/upload-payload/${encodeURIComponent(key)}?token=${encodeURIComponent(uploadToken)}`)
                .set("Content-Type", "application/octet-stream")
                .send(oversizedBuffer);

            // Either express raw limit rejects (413) or validation rejects (422)
            assert.ok(res.status === 413 || res.status === 422 || res.status === 400);
        });
    });

    // -------------------------------------------------------------
    // Scenario 6: Malformed image content & MIME-type spoofing
    // -------------------------------------------------------------
    describe("Scenario 6: Malformed image content & MIME-type spoofing", () => {
        it("rejects text file or script disguised as image/jpeg (magic bytes check)", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            const fakePayload = Buffer.from("<html><script>alert('xss')</script></html>");

            const res = await request(app)
                .put(`/api/v1/users/profile/photo/upload-payload/${encodeURIComponent(key)}?token=${encodeURIComponent(uploadToken)}`)
                .set("Content-Type", "image/jpeg")
                .send(fakePayload);

            assert.equal(res.status, 422);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /unsupported image format/i);
        });

        it("rejects image smaller than minimum required dimensions (100x100px)", () => {
            // PNG with width 50, height 50
            const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            const ihdrLen = Buffer.alloc(4);
            ihdrLen.writeUInt32BE(13, 0);
            const ihdrData = Buffer.alloc(13);
            ihdrData.writeUInt32BE(50, 0); // width 50
            ihdrData.writeUInt32BE(50, 4); // height 50
            ihdrData.writeUInt8(8, 8);
            ihdrData.writeUInt8(2, 9);
            const ihdrChunk = Buffer.concat([ihdrLen, Buffer.from("IHDR", "ascii"), ihdrData, Buffer.alloc(4)]);
            const smallPng = Buffer.concat([sig, ihdrChunk]);

            const validation = validateImageBuffer(smallPng);
            assert.equal(validation.valid, false);
            assert.match(validation.error, /too small/i);
        });

        it("detectMimeType strictly enforces magic bytes", () => {
            assert.equal(detectMimeType(Buffer.from("not an image")), null);
            assert.equal(detectMimeType(Buffer.from([0x00, 0x01, 0x02])), null);
            assert.equal(detectMimeType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01])), "image/jpeg");
            assert.equal(detectMimeType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D])), "image/png");
        });
    });

    // -------------------------------------------------------------
    // Scenario 7: Metadata stripping (APP1 EXIF & GPS stripped)
    // -------------------------------------------------------------
    describe("Scenario 7: Metadata stripping (APP1 EXIF & GPS stripped)", () => {
        it("strips APP1 EXIF segment containing GPS coordinates from JPEG", () => {
            const rawJpeg = createMockJpegWithExif();

            // Verify raw JPEG contains GPS metadata
            assert.ok(rawJpeg.includes(Buffer.from("GPSLatitude=28.6139", "ascii")));
            assert.ok(rawJpeg.includes(Buffer.from([0xFF, 0xE1]))); // APP1 marker

            // Strip metadata
            const sanitized = stripMetadata(rawJpeg, "image/jpeg");

            // Verify GPS metadata and APP1 marker are completely removed
            assert.ok(!sanitized.includes(Buffer.from("GPSLatitude", "ascii")));
            assert.ok(!sanitized.includes(Buffer.from([0xFF, 0xE1])));

            // Verify JPEG header and image dimensions are still intact
            assert.equal(detectMimeType(sanitized), "image/jpeg");
            const dims = extractDimensions(sanitized, "image/jpeg");
            assert.ok(dims);
            assert.equal(dims.width, 100);
            assert.equal(dims.height, 100);
        });

        it("strips tEXt metadata chunk containing GPS location from PNG", () => {
            const rawPng = createMockPngWithMetadata();

            // Verify raw PNG contains location metadata
            assert.ok(rawPng.includes(Buffer.from("Lat=28.6139", "ascii")));
            assert.ok(rawPng.includes(Buffer.from("tEXt", "ascii")));

            // Strip metadata
            const sanitized = stripMetadata(rawPng, "image/png");

            // Verify tEXt chunk and location data are stripped
            assert.ok(!sanitized.includes(Buffer.from("Lat=28.6139", "ascii")));
            assert.ok(!sanitized.includes(Buffer.from("tEXt", "ascii")));

            // Verify PNG signature and IHDR chunks are preserved
            assert.equal(detectMimeType(sanitized), "image/png");
            const dims = extractDimensions(sanitized, "image/png");
            assert.ok(dims);
            assert.equal(dims.width, 100);
            assert.equal(dims.height, 100);
        });

        it("strips EXIF chunk and clears VP8X EXIF/XMP feature flags from WebP", () => {
            const rawWebp = createMockWebPWithExif();

            // Verify raw WebP contains EXIF tag, GPS latitude, and VP8X flags byte with bit 3 (0x08)
            assert.ok(rawWebp.includes(Buffer.from("EXIF", "ascii")));
            assert.ok(rawWebp.includes(Buffer.from("GPSLatitude=28.6139", "ascii")));
            assert.equal(rawWebp.toString("ascii", 12, 16), "VP8X");
            const rawFlags = rawWebp.readUInt8(20);
            assert.equal(rawFlags & 0x08, 0x08, "Raw WebP should have EXIF bit set in VP8X header");

            // Strip metadata
            const sanitized = stripMetadata(rawWebp, "image/webp");

            // Verify GPS text and EXIF tag are removed
            assert.ok(!sanitized.includes(Buffer.from("GPSLatitude", "ascii")));
            assert.ok(!sanitized.includes(Buffer.from("EXIF", "ascii")));

            // Verify VP8X header flags have EXIF bit (0x08) and XMP bit (0x04) cleared
            assert.equal(sanitized.toString("ascii", 12, 16), "VP8X");
            const sanitizedFlags = sanitized.readUInt8(20);
            assert.equal(sanitizedFlags & 0x0C, 0, "Stripped WebP VP8X header must have EXIF and XMP flags cleared");

            // Verify WebP signature and dimensions are preserved
            assert.equal(detectMimeType(sanitized), "image/webp");
            const dims = extractDimensions(sanitized, "image/webp");
            assert.ok(dims);
            assert.equal(dims.width, 100);
            assert.equal(dims.height, 100);
        });
    });

    // -------------------------------------------------------------
    // Scenario 8: Photo replacement and removal lifecycle
    // -------------------------------------------------------------
    describe("Scenario 8: Photo replacement and removal lifecycle", () => {
        it("handles full lifecycle: upload, replace photo at targetIndex, and remove", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            // 1. Request upload authorization
            const reqUrlRes = await request(app)
                .post("/api/v1/users/profile/photo/upload-url")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    filename: "avatar.png",
                    contentType: "image/png",
                    fileSize: 15000,
                });

            assert.equal(reqUrlRes.status, 200);
            assert.equal(reqUrlRes.body.success, true);
            const { key, uploadToken, uploadUrl } = reqUrlRes.body;
            assert.ok(key.startsWith(`profile-photos/${userAliceId}/`));
            assert.ok(uploadToken);

            // 2. Upload binary payload to dev/mock storage
            const rawPng = createMockPngWithMetadata();
            const uploadPayloadRes = await request(app)
                .put(`/api/v1/users/profile/photo/upload-payload/${encodeURIComponent(key)}?token=${encodeURIComponent(uploadToken)}`)
                .set("Content-Type", "image/png")
                .send(rawPng);

            assert.equal(uploadPayloadRes.status, 200);
            assert.equal(uploadPayloadRes.body.success, true);

            // 3. Confirm upload
            const confirmRes = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken,
                });

            assert.equal(confirmRes.status, 200);
            assert.equal(confirmRes.body.success, true);
            assert.equal(mockAlice.photos.length, 2);
            const addedPhotoUrl = confirmRes.body.publicUrl;

            // 4. Verify photo is publicly servable via media endpoint
            const mediaRes = await request(app)
                .get(`/api/v1/users/profile/photo/media/${encodeURIComponent(key)}`);
            assert.equal(mediaRes.status, 200);
            assert.equal(mediaRes.headers["content-type"], "image/png");

            // 5a. Verify confirming key2 before uploading payload fails with 400
            const key2 = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadToken2 = createUploadToken({
                userId: userAliceId,
                key: key2,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
                targetIndex: 0,
            });

            const prematureConfirm = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key: key2,
                    uploadToken: uploadToken2,
                    targetIndex: 0,
                });
            assert.equal(prematureConfirm.status, 400);
            assert.match(prematureConfirm.body.message, /not found in storage/i);

            // 5b. Upload key2 binary payload
            const rawJpeg = createMockJpegWithExif();
            const uploadPayload2Res = await request(app)
                .put(`/api/v1/users/profile/photo/upload-payload/${encodeURIComponent(key2)}?token=${encodeURIComponent(uploadToken2)}`)
                .set("Content-Type", "image/jpeg")
                .send(rawJpeg);
            assert.equal(uploadPayload2Res.status, 200);

            // 5c. Now confirm replacement succeeds
            const replaceRes = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key: key2,
                    uploadToken: uploadToken2,
                    targetIndex: 0,
                });

            assert.equal(replaceRes.status, 200);
            assert.equal(replaceRes.body.success, true);
            assert.ok(mockAlice.photos[0].includes(encodeURIComponent(key2)));
            // Photo at index 1 is preserved
            assert.equal(mockAlice.photos[1], addedPhotoUrl);

            // 6. Delete photo at index 1
            const deleteRes = await request(app)
                .delete("/api/v1/users/profile/photo/1")
                .set("Authorization", `Bearer ${aliceAuthToken}`);

            assert.equal(deleteRes.status, 200);
            assert.equal(deleteRes.body.success, true);
            assert.equal(mockAlice.photos.length, 1);
        });
    });

    // -------------------------------------------------------------
    // Scenario 9: Upload failure preserving previous profile photos
    // -------------------------------------------------------------
    describe("Scenario 9: Upload failure preserving previous profile photos", () => {
        it("preserves existing photos when confirm payload is invalid or rejected", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const initialPhotos = [...mockAlice.photos];

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key: "invalid-key-not-owned",
                    uploadToken: "invalid-token",
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            // Verify existing photos remain completely untouched
            assert.deepEqual(mockAlice.photos, initialPhotos);
        });
    });

    // -------------------------------------------------------------
    // Scenario 10: Prevention of arbitrary URL fetching and SSRF
    // -------------------------------------------------------------
    describe("Scenario 10: Prevention of arbitrary URL fetching and SSRF", () => {
        it("blocks cloud-metadata, private IPs, loopback, and embedded credentials", () => {
            const badUrls = [
                "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
                "http://10.0.0.1/internal-photo.png",
                "http://172.16.0.5/admin.jpg",
                "http://192.168.1.10/private.jpg",
                "https://user:password@images.unsplash.com/photo.jpg",
                "http://example.com/unencrypted.jpg",
            ];

            for (const url of badUrls) {
                const check = validatePublicPhotoUrl(url);
                assert.equal(check.valid, false, `Expected ${url} to be rejected`);
                assert.ok(check.error);
            }
        });
    });

    // -------------------------------------------------------------
    // Scenario 11: Compatibility with existing valid profile image URLs
    // -------------------------------------------------------------
    describe("Scenario 11: Compatibility with existing valid profile image URLs", () => {
        it("approves photos hosted on approved CDN domains (Unsplash, Google, Cloudinary)", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            const validUrls = [
                "https://images.unsplash.com/photo-1534528741775-53994a69daeb",
                "https://lh3.googleusercontent.com/a/ACg8ocIq8",
                "https://res.cloudinary.com/engaze/image/upload/v12345/avatar.jpg",
            ];

            for (const url of validUrls) {
                const check = validatePublicPhotoUrl(url);
                assert.equal(check.valid, true, `Expected ${url} to be valid`);
            }

            const res = await request(app)
                .put("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({ photos: validUrls });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(mockAlice.photos, validUrls);
        });
    });

    // -------------------------------------------------------------
    // Scenario 12: Production Environment Fail-Closed & Storage Unavailability
    // -------------------------------------------------------------
    describe("Scenario 12: Production Environment Fail-Closed & Storage Unavailability", () => {
        let savedNodeEnv;
        let savedJwtSecret;
        let savedStorageProvider;
        let savedS3Bucket;

        beforeEach(() => {
            savedNodeEnv = process.env.NODE_ENV;
            savedJwtSecret = process.env.JWT_SECRET;
            savedStorageProvider = process.env.STORAGE_PROVIDER;
            savedS3Bucket = process.env.AWS_S3_BUCKET;
            process.env.JWT_SECRET = "production_test_secret_key_minimum_32_characters_long!";
        });

        afterEach(() => {
            process.env.NODE_ENV = savedNodeEnv;
            process.env.JWT_SECRET = savedJwtSecret;
            process.env.STORAGE_PROVIDER = savedStorageProvider;
            process.env.AWS_S3_BUCKET = savedS3Bucket;
            setStorageAdapter(null);
        });

        it("never selects DevMockStorageAdapter in production when storage provider is unconfigured", () => {
            process.env.NODE_ENV = "production";
            delete process.env.STORAGE_PROVIDER;
            delete process.env.AWS_S3_BUCKET;
            setStorageAdapter(null);

            const adapter = getStorageAdapter();
            assert.equal(adapter.name, "unavailable");
            assert.ok(adapter instanceof StorageUnavailableAdapter);
            assert.ok(!(adapter instanceof DevMockStorageAdapter));
        });

        it("fails closed with 503 SERVICE_UNAVAILABLE on upload-url in production when unconfigured", async () => {
            process.env.NODE_ENV = "production";
            delete process.env.STORAGE_PROVIDER;
            delete process.env.AWS_S3_BUCKET;
            setStorageAdapter(null);

            const aliceAuthToken = makeToken({ id: userAliceId.toString() });

            const res = await request(app)
                .post("/api/v1/users/profile/photo/upload-url")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    filename: "avatar.jpg",
                    contentType: "image/jpeg",
                    fileSize: 50000,
                });

            assert.equal(res.status, 503);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "STORAGE_UNAVAILABLE");
            assert.match(res.body.message, /storage service is temporarily unavailable/i);
        });

        it("fails closed with 503 on confirm in production when unconfigured", async () => {
            process.env.NODE_ENV = "production";
            delete process.env.STORAGE_PROVIDER;
            delete process.env.AWS_S3_BUCKET;
            setStorageAdapter(null);

            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken,
                });

            assert.equal(res.status, 503);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "STORAGE_UNAVAILABLE");
        });

        it("disables dev mock upload and media endpoints in production with 404", async () => {
            process.env.NODE_ENV = "production";

            const resUpload = await request(app)
                .put("/api/v1/users/profile/photo/upload-payload/any-key?token=any")
                .send(Buffer.from("data"));
            assert.equal(resUpload.status, 404);

            const resMedia = await request(app)
                .get("/api/v1/users/profile/photo/media/any-key");
            assert.equal(resMedia.status, 404);
        });
    });

    // -------------------------------------------------------------
    // Scenario 13: Object Verification, Mismatched MIME/Size & Slot Binding
    // -------------------------------------------------------------
    describe("Scenario 13: Object Verification, Mismatched MIME/Size & Slot Binding", () => {
        beforeEach(() => {
            process.env.NODE_ENV = "development";
            setStorageAdapter(null);
        });

        it("rejects confirmation when object does not exist in storage", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            // Do not upload object
            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /not found in storage/i);
        });

        it("rejects confirmation when uploaded object content type does not match authorized MIME type", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            // Token authorized for image/jpeg
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            // Directly inject PNG into mock adapter to simulate MIME mismatch
            const adapter = getStorageAdapter();
            await adapter.putObject(key, Buffer.from("fake-png-buffer"), "image/png");

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /content type.*does not match/i);
        });

        it("rejects confirmation when token is bound to a different photo slot", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            // Token bound specifically to slot 2
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
                targetIndex: 2,
            });

            const adapter = getStorageAdapter();
            await adapter.putObject(key, Buffer.from("fake-jpg"), "image/jpeg");

            // Attempt to confirm for slot 0
            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken,
                    targetIndex: 0,
                });

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /different photo slot/i);
        });

        it("safely handles storage adapter errors/timeouts during object check and preserves photos", async () => {
            const aliceAuthToken = makeToken({ id: userAliceId.toString() });
            const key = generatePhotoKey(userAliceId, "image/jpeg");
            const uploadToken = createUploadToken({
                userId: userAliceId,
                key,
                expectedMime: "image/jpeg",
                maxSizeBytes: MAX_PHOTO_BYTES,
            });

            const initialPhotos = [...mockAlice.photos];

            // Injected faulty adapter that simulates timeout / connection error
            const faultyAdapter = {
                name: "mock",
                async objectExists() {
                    const timeoutErr = new Error("Storage provider connection timed out after 5000ms");
                    timeoutErr.statusCode = 503;
                    timeoutErr.code = "STORAGE_TIMEOUT";
                    throw timeoutErr;
                },
            };
            setStorageAdapter(faultyAdapter);

            const res = await request(app)
                .post("/api/v1/users/profile/photo/confirm")
                .set("Authorization", `Bearer ${aliceAuthToken}`)
                .send({
                    key,
                    uploadToken,
                });

            assert.equal(res.status, 503);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /timed out/i);
            // Verify existing photos remain completely preserved
            assert.deepEqual(mockAlice.photos, initialPhotos);

            // Restore normal adapter
            setStorageAdapter(null);
        });
    });
});
