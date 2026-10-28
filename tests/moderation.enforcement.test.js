import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import express from "express";
import { createServer } from "http";
import { io as ioClient } from "socket.io-client";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { User, evaluateAccountStatus } from "../src/models/user.model.js";
import { Report, REPORT_ACTIONS } from "../src/models/report.model.js";
import { getJwtSecret } from "../src/config/jwt.js";
import {
    connectToSocket,
    revokeUserSessions,
    terminateUserActiveDirectCalls,
    _resetInMemoryDirectCalls,
} from "../src/controllers/socketManager.js";
import {
    getStorageAdapter,
    setStorageAdapter,
    DevMockStorageAdapter,
    createUploadToken,
    generatePhotoKey,
    confirmPhotoUpload,
} from "../src/services/storage.service.js";

function makeTestToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

function mockQuery(doc) {
    if (!doc) return Promise.resolve(null);
    doc.save = doc.save || (async function () { return this; });
    doc.toJSON = doc.toJSON || (function () {
        const copy = { ...this };
        delete copy.save;
        delete copy.toJSON;
        return copy;
    });

    return {
        select: function () {
            return Promise.resolve(doc);
        },
        then: function (resolve, reject) {
            return Promise.resolve(doc).then(resolve, reject);
        },
    };
}

function connectSocketClient(port, options = {}) {
    return new Promise((resolve) => {
        const client = ioClient(`http://127.0.0.1:${port}`, {
            transports: ["polling"],
            forceNew: true,
            reconnection: false,
            timeout: 3000,
            ...options,
        });

        client.once("connect", () => resolve({ client, error: null }));
        client.once("connect_error", (err) => resolve({ client, error: err }));
    });
}

// 100x100 minimal valid PNG buffer for byte validation tests
function createMinimal100x100Png() {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrChunk = Buffer.alloc(25);
    ihdrChunk.writeUInt32BE(13, 0); // length
    ihdrChunk.write("IHDR", 4, 4, "ascii");
    ihdrChunk.writeUInt32BE(100, 8); // width = 100
    ihdrChunk.writeUInt32BE(100, 12); // height = 100
    ihdrChunk[16] = 8; // bit depth
    ihdrChunk[17] = 2; // color type (RGB)
    ihdrChunk[18] = 0; // compression
    ihdrChunk[19] = 0; // filter
    ihdrChunk[20] = 0; // interlace
    ihdrChunk.writeUInt32BE(0, 21); // crc stub

    const iendChunk = Buffer.alloc(12);
    iendChunk.writeUInt32BE(0, 0);
    iendChunk.write("IEND", 4, 4, "ascii");
    iendChunk.writeUInt32BE(0xAE426082, 8);

    return Buffer.concat([signature, ihdrChunk, iendChunk]);
}

describe("Security Phases 2-4: Account Moderation, Enforcement & Image Validation Suite", () => {
    // =========================================================================
    // 1. User Model Schema & Account Status Evaluation Unit Tests
    // =========================================================================
    describe("1. User Model Schema & evaluateAccountStatus()", () => {
        it("defaults new user to status: 'active'", () => {
            const user = new User({
                name: "Kavita Rao",
                username: "kavita_r",
                password: "password123",
            });
            assert.equal(user.status, "active");
            assert.equal(user.suspensionExpiresAt, null);
            assert.equal(user.bannedAt, null);
        });

        it("evaluateAccountStatus reports allowed: true for active account", () => {
            const user = { status: "active" };
            const result = evaluateAccountStatus(user);
            assert.equal(result.allowed, true);
            assert.equal(result.status, "active");
        });

        it("evaluateAccountStatus reports allowed: false for banned account", () => {
            const user = {
                status: "banned",
                banReason: "Severe terms violation",
                bannedAt: new Date(),
            };
            const result = evaluateAccountStatus(user);
            assert.equal(result.allowed, false);
            assert.equal(result.status, "banned");
            assert.equal(result.reason, "Severe terms violation");
        });

        it("evaluateAccountStatus reports allowed: false for unexpired temporary suspension", () => {
            const future = new Date(Date.now() + 24 * 3600 * 1000);
            const user = {
                status: "suspended",
                suspensionExpiresAt: future,
                suspensionReason: "Harassment complaint",
            };
            const result = evaluateAccountStatus(user);
            assert.equal(result.allowed, false);
            assert.equal(result.status, "suspended");
            assert.equal(result.reason, "Harassment complaint");
            assert.equal(result.expiresAt, future);
        });

        it("evaluateAccountStatus reports allowed: true and wasExpired: true for expired suspension", () => {
            const past = new Date(Date.now() - 3600 * 1000); // 1 hour ago
            const user = {
                status: "suspended",
                suspensionExpiresAt: past,
                suspensionReason: "Temporary timeout",
            };
            const result = evaluateAccountStatus(user);
            assert.equal(result.allowed, true);
            assert.equal(result.status, "active");
            assert.equal(result.wasExpired, true);
        });
    });

    // =========================================================================
    // 2. REST Authentication Enforcement (protect middleware)
    // =========================================================================
    describe("2. REST API Account Status Enforcement", () => {
        let originalFindById;

        beforeEach(() => {
            originalFindById = User.findById;
        });

        afterEach(() => {
            User.findById = originalFindById;
        });

        it("allows active user to access protected /profile/me with 200 OK", async () => {
            const userId = new mongoose.Types.ObjectId("65cb00000000000000000001");
            const token = makeTestToken({ id: userId.toString(), username: "active_user" });

            User.findById = (id) => mockQuery({
                _id: userId,
                name: "Active User",
                username: "active_user",
                status: "active",
            });

            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${token}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
        });

        it("denies banned user access to /profile/me with 403 Forbidden and ACCOUNT_BANNED code", async () => {
            const userId = new mongoose.Types.ObjectId("65cb00000000000000000002");
            const token = makeTestToken({ id: userId.toString(), username: "banned_user" });

            User.findById = (id) => mockQuery({
                _id: userId,
                name: "Banned User",
                username: "banned_user",
                status: "banned",
                banReason: "Permanent ban for hate speech",
                bannedAt: new Date(),
            });

            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${token}`);

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "ACCOUNT_BANNED");
            assert.match(res.body.message, /permanently banned/i);
        });

        it("denies unexpired suspended user with 403 Forbidden and ACCOUNT_SUSPENDED code", async () => {
            const userId = new mongoose.Types.ObjectId("65cb00000000000000000003");
            const token = makeTestToken({ id: userId.toString(), username: "suspended_user" });
            const future = new Date(Date.now() + 48 * 3600 * 1000);

            User.findById = (id) => mockQuery({
                _id: userId,
                name: "Suspended User",
                username: "suspended_user",
                status: "suspended",
                suspensionExpiresAt: future,
                suspensionReason: "Under investigation",
            });

            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${token}`);

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "ACCOUNT_SUSPENDED");
            assert.match(res.body.message, /temporarily suspended/i);
        });

        it("automatically reinstates expired suspended user and permits access with 200 OK", async () => {
            const userId = new mongoose.Types.ObjectId("65cb00000000000000000004");
            const token = makeTestToken({ id: userId.toString(), username: "expired_suspension_user" });
            const past = new Date(Date.now() - 3600 * 1000);
            let saved = false;

            const userState = {
                _id: userId,
                name: "Expired Suspended User",
                username: "expired_suspension_user",
                status: "suspended",
                suspensionExpiresAt: past,
                suspensionReason: "1 hour timeout",
                save: async function () {
                    saved = true;
                    return this;
                },
            };

            User.findById = (id) => mockQuery(userState);

            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${token}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(userState.status, "active", "User status must be reinstated to 'active'");
            assert.equal(userState.suspensionExpiresAt, null);
        });
    });

    // =========================================================================
    // 3. Login Enforcement
    // =========================================================================
    describe("3. Login Authentication Account Status Enforcement", () => {
        let originalFindOne;

        beforeEach(() => {
            originalFindOne = User.findOne;
        });

        afterEach(() => {
            User.findOne = originalFindOne;
        });

        it("denies login to banned user with 403 Forbidden", async () => {
            const hashedPassword = await bcrypt.hash("password123", 10);
            User.findOne = async () => ({
                _id: new mongoose.Types.ObjectId(),
                username: "banned_login",
                password: hashedPassword,
                status: "banned",
                banReason: "Permanent violation",
            });

            const res = await request(app)
                .post("/api/v1/users/login")
                .send({
                    username: "banned_login",
                    password: "password123",
                });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "ACCOUNT_BANNED");
        });

        it("denies login to active suspension with 403 Forbidden", async () => {
            const hashedPassword = await bcrypt.hash("password123", 10);
            const future = new Date(Date.now() + 24 * 3600 * 1000);
            User.findOne = async () => ({
                _id: new mongoose.Types.ObjectId(),
                username: "suspended_login",
                password: hashedPassword,
                status: "suspended",
                suspensionExpiresAt: future,
                suspensionReason: "24 hour timeout",
            });

            const res = await request(app)
                .post("/api/v1/users/login")
                .send({
                    username: "suspended_login",
                    password: "password123",
                });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "ACCOUNT_SUSPENDED");
        });

        it("permits login and auto-reinstates expired suspension with 200 OK", async () => {
            const hashedPassword = await bcrypt.hash("password123", 10);
            const past = new Date(Date.now() - 3600 * 1000);
            let saved = false;

            const mockUser = {
                _id: new mongoose.Types.ObjectId(),
                username: "expired_login",
                password: hashedPassword,
                status: "suspended",
                suspensionExpiresAt: past,
                save: async function () {
                    saved = true;
                    return this;
                },
                toJSON: function () {
                    return { _id: this._id, username: this.username, status: this.status };
                },
            };

            User.findOne = async () => mockUser;

            const res = await request(app)
                .post("/api/v1/users/login")
                .send({
                    username: "expired_login",
                    password: "password123",
                });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(mockUser.status, "active");
            assert.equal(saved, true);
        });
    });

    // =========================================================================
    // 4. Socket.IO Handshake Account Status Enforcement
    // =========================================================================
    describe("4. Socket.IO Handshake Account Status Enforcement", () => {
        let server;
        let ioServer;
        let port;
        let originalFindById;

        before(async () => {
            const expressApp = express();
            server = createServer(expressApp);
            ioServer = connectToSocket(server);
            await new Promise((res) => server.listen(0, "127.0.0.1", res));
            port = server.address().port;
            originalFindById = User.findById;
        });

        after(async () => {
            User.findById = originalFindById;
            if (ioServer) ioServer.close();
            if (server) await new Promise((res) => server.close(res));
        });

        it("rejects socket connection during handshake when user is banned", async () => {
            const bannedId = new mongoose.Types.ObjectId("65cb11111111111111111111");
            const token = makeTestToken({ id: bannedId.toString(), username: "banned_socket" });

            // Mock database query during handshake
            const originalReadyState = mongoose.connection.readyState;
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });

            User.findById = () => ({
                select: () => Promise.resolve({
                    _id: bannedId,
                    status: "banned",
                    banReason: "Permanent ban",
                }),
            });

            const { client, error } = await connectSocketClient(port, {
                auth: { token },
            });

            Object.defineProperty(mongoose.connection, "readyState", { value: originalReadyState, configurable: true });

            assert.ok(error, "Handshake MUST reject connection for banned account");
            assert.match(error.message, /Authentication error: Account banned/i);
            if (client) client.disconnect();
        });

        it("rejects socket connection during handshake when user is suspended", async () => {
            const suspendedId = new mongoose.Types.ObjectId("65cb22222222222222222222");
            const token = makeTestToken({ id: suspendedId.toString(), username: "suspended_socket" });
            const future = new Date(Date.now() + 24 * 3600 * 1000);

            const originalReadyState = mongoose.connection.readyState;
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });

            User.findById = () => ({
                select: () => Promise.resolve({
                    _id: suspendedId,
                    status: "suspended",
                    suspensionExpiresAt: future,
                    suspensionReason: "Active suspension",
                }),
            });

            const { client, error } = await connectSocketClient(port, {
                auth: { token },
            });

            Object.defineProperty(mongoose.connection, "readyState", { value: originalReadyState, configurable: true });

            assert.ok(error, "Handshake MUST reject connection for suspended account");
            assert.match(error.message, /Authentication error: Account suspended/i);
            if (client) client.disconnect();
        });
    });

    // =========================================================================
    // 5. Moderation Reports & Account Action Enforcement
    // =========================================================================
    describe("5. Moderation Reports & Account Action Enforcement", () => {
        let originalReportFindById;
        let originalUserFindById;
        const modUserId = "65ca88888888888888888888";
        const modToken = makeTestToken({ id: modUserId, username: "moderator_staff" });

        beforeEach(() => {
            originalReportFindById = Report.findById;
            originalUserFindById = User.findById;
        });

        afterEach(() => {
            Report.findById = originalReportFindById;
            User.findById = originalUserFindById;
        });

        it("resolving report with action: 'ban' updates user status to 'banned' and records audit fields", async () => {
            const targetUserId = new mongoose.Types.ObjectId("65cb33333333333333333333");
            const reportId = new mongoose.Types.ObjectId("65cb44444444444444444444");

            const mockTargetUser = {
                _id: targetUserId,
                username: "abusive_user",
                role: "user",
                status: "active",
                save: async function () { return this; },
            };

            const mockReport = {
                _id: reportId,
                reportedUser: targetUserId,
                status: "pending",
                resolutionNotes: "",
                save: async function () { return this; },
                populate: async function () { return this; },
            };

            Report.findById = async () => mockReport;
            User.findById = (id) => {
                if (String(id) === modUserId) {
                    return mockQuery({ _id: id, role: "moderator", name: "Staff Mod", status: "active" });
                }
                return mockQuery(mockTargetUser);
            };

            const res = await request(app)
                .patch(`/api/v1/moderation/reports/${reportId}`)
                .set("Authorization", `Bearer ${modToken}`)
                .send({
                    status: "resolved",
                    action: "ban",
                    actionReason: "Verified abusive behavior in video chat",
                });

            assert.equal(res.status, 200);
            assert.equal(mockTargetUser.status, "banned");
            assert.equal(mockTargetUser.banReason, "Verified abusive behavior in video chat");
            assert.ok(mockTargetUser.bannedAt);
            assert.equal(mockReport.action, "ban");
            assert.equal(mockReport.status, "resolved");
        });

        it("resolving report with action: 'suspend' sets suspensionExpiresAt and updates user", async () => {
            const targetUserId = new mongoose.Types.ObjectId("65cb55555555555555555555");
            const reportId = new mongoose.Types.ObjectId("65cb66666666666666666666");

            const mockTargetUser = {
                _id: targetUserId,
                username: "spam_user",
                role: "user",
                status: "active",
                save: async function () { return this; },
            };

            const mockReport = {
                _id: reportId,
                reportedUser: targetUserId,
                status: "pending",
                save: async function () { return this; },
                populate: async function () { return this; },
            };

            Report.findById = async () => mockReport;
            User.findById = (id) => {
                if (String(id) === modUserId) {
                    return mockQuery({ _id: id, role: "moderator", name: "Staff Mod", status: "active" });
                }
                return mockQuery(mockTargetUser);
            };

            const res = await request(app)
                .patch(`/api/v1/moderation/reports/${reportId}`)
                .set("Authorization", `Bearer ${modToken}`)
                .send({
                    status: "resolved",
                    action: "suspend",
                    suspensionDurationHours: 48,
                    actionReason: "Spamming match requests",
                });

            assert.equal(res.status, 200);
            assert.equal(mockTargetUser.status, "suspended");
            assert.equal(mockTargetUser.suspensionReason, "Spamming match requests");
            assert.ok(mockTargetUser.suspensionExpiresAt);
            assert.equal(mockReport.action, "suspend");
            assert.equal(mockReport.suspensionDurationHours, 48);
        });

        it("anti-escalation: prevents moderator from banning or suspending an admin account (403)", async () => {
            const adminTargetId = new mongoose.Types.ObjectId("65cb77777777777777777777");
            const reportId = new mongoose.Types.ObjectId("65cb88888888888888888888");

            const mockAdminTarget = {
                _id: adminTargetId,
                username: "system_admin",
                role: "admin", // Admin cannot be banned by moderator
                status: "active",
                save: async function () { return this; },
            };

            const mockReport = {
                _id: reportId,
                reportedUser: adminTargetId,
                status: "pending",
                save: async function () { return this; },
            };

            Report.findById = async () => mockReport;
            User.findById = (id) => {
                if (String(id) === modUserId) {
                    return mockQuery({ _id: id, role: "moderator", name: "Staff Mod", status: "active" });
                }
                return mockQuery(mockAdminTarget);
            };

            const res = await request(app)
                .patch(`/api/v1/moderation/reports/${reportId}`)
                .set("Authorization", `Bearer ${modToken}`)
                .send({
                    status: "resolved",
                    action: "ban",
                    actionReason: "Unauthorized attempt to ban admin",
                });

            assert.equal(res.status, 403);
            assert.match(res.body.message, /cannot enforce moderation actions against other staff members/i);
            assert.equal(mockAdminTarget.status, "active", "Admin account must remain active");
        });
    });

    // =========================================================================
    // 6. Direct User Moderation Endpoints
    // =========================================================================
    describe("6. Direct User Moderation Endpoints", () => {
        let originalUserFindById;
        const adminId = "65ca99999999999999999999";
        const adminToken = makeTestToken({ id: adminId, username: "admin_superuser" });

        beforeEach(() => {
            originalUserFindById = User.findById;
        });

        afterEach(() => {
            User.findById = originalUserFindById;
        });

        it("POST /moderation/users/:id/ban directly bans user", async () => {
            const targetId = new mongoose.Types.ObjectId("65cb99999999999999999999");
            const mockUser = {
                _id: targetId,
                username: "direct_ban_target",
                role: "user",
                status: "active",
                save: async function () { return this; },
            };

            User.findById = (id) => {
                if (String(id) === adminId) return mockQuery({ _id: id, role: "admin", name: "Admin", status: "active" });
                return mockQuery(mockUser);
            };

            const res = await request(app)
                .post(`/api/v1/moderation/users/${targetId}/ban`)
                .set("Authorization", `Bearer ${adminToken}`)
                .send({ reason: "Emergency ban" });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(mockUser.status, "banned");
            assert.equal(mockUser.banReason, "Emergency ban");
        });

        it("POST /moderation/users/:id/reinstate restores user to active status", async () => {
            const targetId = new mongoose.Types.ObjectId("65cbaaaaaaaaaaaaaaaa0001");
            const mockUser = {
                _id: targetId,
                username: "reinstated_target",
                role: "user",
                status: "banned",
                banReason: "Old ban",
                save: async function () { return this; },
            };

            User.findById = (id) => {
                if (String(id) === adminId) return mockQuery({ _id: id, role: "admin", name: "Admin", status: "active" });
                return mockQuery(mockUser);
            };

            const res = await request(app)
                .post(`/api/v1/moderation/users/${targetId}/reinstate`)
                .set("Authorization", `Bearer ${adminToken}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(mockUser.status, "active");
            assert.equal(mockUser.banReason, null);
            assert.equal(mockUser.bannedAt, null);
        });
    });

    // =========================================================================
    // 7. Image-Byte Validation & EXIF Stripping on Upload Confirmation
    // =========================================================================
    describe("7. Image-Byte Validation & EXIF Stripping on S3/Storage Confirmation", () => {
        let adapter;

        beforeEach(() => {
            adapter = new DevMockStorageAdapter();
            setStorageAdapter(adapter);
        });

        afterEach(() => {
            adapter.clearAll();
        });

        it("rejects confirmation when storage object contains disguised non-image data (magic byte failure)", async () => {
            const userId = new mongoose.Types.ObjectId("65cbbbbbbbbbbbbbbbbb0001");
            const key = generatePhotoKey(userId, "image/png");
            const uploadToken = createUploadToken({
                userId,
                key,
                expectedMime: "image/png",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            // Put fake non-image binary payload (e.g. script/text disguised with image/png MIME)
            const fakePayload = Buffer.from("<script>alert('xss')</script> This is not a real PNG image.");
            await adapter.putObject(key, fakePayload, "image/png");

            await assert.rejects(
                async () => {
                    await confirmPhotoUpload(userId, { key, uploadToken });
                },
                (err) => {
                    assert.match(err.message, /not a valid image/i);
                    assert.equal(err.statusCode, 400);
                    return true;
                }
            );

            // Verify the malicious/invalid object was deleted from storage
            const stillExists = await adapter.objectExists(key);
            assert.equal(stillExists, false, "Invalid object MUST be deleted from storage");
        });

        it("successfully confirms upload when binary bytes contain valid PNG magic bytes and dimensions", async () => {
            const userId = new mongoose.Types.ObjectId("65cbbbbbbbbbbbbbbbbb0002");
            const key = generatePhotoKey(userId, "image/png");
            const uploadToken = createUploadToken({
                userId,
                key,
                expectedMime: "image/png",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            // Store valid 100x100 PNG
            const validPng = createMinimal100x100Png();
            await adapter.putObject(key, validPng, "image/png");

            let originalFindById = User.findById;
            User.findById = async () => ({
                _id: userId,
                photos: [],
                save: async function () { return this; },
            });

            try {
                const result = await confirmPhotoUpload(userId, { key, uploadToken });
                assert.equal(result.success, true);
                assert.ok(result.publicUrl.includes(encodeURIComponent(key)));
            } finally {
                User.findById = originalFindById;
            }
        });

        it("strips ancillary metadata chunk and overwrites stored object before user profile persistence", async () => {
            const userId = new mongoose.Types.ObjectId("65cbbbbbbbbbbbbbbbbb0003");
            const key = generatePhotoKey(userId, "image/png");
            const uploadToken = createUploadToken({
                userId,
                key,
                expectedMime: "image/png",
                maxSizeBytes: 5 * 1024 * 1024,
            });

            // Create valid PNG with tEXt chunk containing GPS coordinates
            const basePng = createMinimal100x100Png();
            const textData = Buffer.from("location\0lat=37.7749;lon=-122.4194");
            const textChunk = Buffer.alloc(12 + textData.length);
            textChunk.writeUInt32BE(textData.length, 0);
            textChunk.write("tEXt", 4, 4, "ascii");
            textData.copy(textChunk, 8);
            textChunk.writeUInt32BE(0x12345678, 8 + textData.length); // crc stub

            // Insert tEXt before IEND chunk
            const pngWithMetadata = Buffer.concat([
                basePng.subarray(0, basePng.length - 12),
                textChunk,
                basePng.subarray(basePng.length - 12),
            ]);

            assert.ok(pngWithMetadata.includes(Buffer.from("lat=37.7749")), "Pre-condition: must contain GPS string");

            await adapter.putObject(key, pngWithMetadata, "image/png");

            let originalFindById = User.findById;
            User.findById = async () => ({
                _id: userId,
                photos: [],
                save: async function () { return this; },
            });

            try {
                const result = await confirmPhotoUpload(userId, { key, uploadToken });
                assert.equal(result.success, true);

                // Verify stored object in storage now has the metadata stripped
                const sanitizedObj = await adapter.getObject(key);
                assert.ok(sanitizedObj, "Sanitized object must remain in storage");
                assert.ok(!sanitizedObj.buffer.includes(Buffer.from("lat=37.7749")), "GPS metadata MUST be purged from stored object");
                assert.ok(sanitizedObj.buffer.length < pngWithMetadata.length, "Sanitized object size must be smaller after chunk removal");
            } finally {
                User.findById = originalFindById;
            }
        });
    });
});
