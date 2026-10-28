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
import { User } from "../src/models/user.model.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { connectToSocket } from "../src/controllers/socketManager.js";

// Helper to generate a valid test token
function makeTestToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

// Helper to connect a test Socket.IO client
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

describe("Batch 1: JWT Handling & Authentication Transport Security Suite", () => {
    // =========================================================================
    // 1. User Schema & Serialization Tests (toJSON / toObject)
    // =========================================================================
    describe("1. User Model Schema & JSON Serialization", () => {
        it("new User instance does not define or persist a token field in schema", () => {
            const user = new User({
                name: "Rahul Mehta",
                username: "rahul_m",
                password: "hashedpassword123",
                dob: new Date("1998-04-12"),
            });

            assert.equal(user.token, undefined);
            const userObj = user.toObject();
            assert.equal(userObj.token, undefined);
            assert.equal(userObj.password, undefined); // password stripped
        });

        it("toJSON() transform strictly deletes legacy token property if present in raw document", () => {
            const user = new User({
                name: "Ananya Iyer",
                username: "ananya_i",
                password: "hashedpassword123",
                dob: new Date("1997-08-20"),
            });

            // Simulate a legacy document that still has a raw token property from MongoDB
            user.set("token", "legacy.persisted.jwt.token", { strict: false });

            const json = user.toJSON();
            assert.equal(json.token, undefined, "toJSON() MUST strip token property");
            assert.equal(json.password, undefined, "toJSON() MUST strip password");
            assert.equal(json.__v, undefined, "toJSON() MUST strip __v");
            assert.equal(json.username, "ananya_i");
        });

        it("toObject() transform strictly deletes legacy token property if present in raw document", () => {
            const user = new User({
                name: "Vikram Das",
                username: "vikram_d",
                password: "hashedpassword123",
                dob: new Date("1996-01-10"),
            });

            user.set("token", "legacy.persisted.jwt.token", { strict: false });

            const obj = user.toObject();
            assert.equal(obj.token, undefined, "toObject() MUST strip token property");
            assert.equal(obj.password, undefined, "toObject() MUST strip password");
            assert.equal(obj.__v, undefined, "toObject() MUST strip __v");
        });
    });

    // =========================================================================
    // 2. Registration & Login Authentication Response & State
    // =========================================================================
    describe("2. Auth Endpoints: Token Generation & Non-Persistence", () => {
        let originalFindOne;
        let originalSave;

        beforeEach(() => {
            originalFindOne = User.findOne;
            originalSave = User.prototype.save;
        });

        afterEach(() => {
            User.findOne = originalFindOne;
            User.prototype.save = originalSave;
        });

        it("POST /login returns valid token, returns user without token, and does NOT save token to DB", async () => {
            const hashedPassword = await bcrypt.hash("Password123!", 10);
            let savedFields = null;

            const mockUser = new User({
                _id: new mongoose.Types.ObjectId("65cb11111111111111111111"),
                name: "Test Login User",
                username: "test_login",
                password: hashedPassword,
                dob: new Date("1995-05-15"),
                isProfileComplete: true,
            });

            // Spy on save to verify no token assignment or write
            mockUser.save = async function () {
                savedFields = this.toObject();
                return this;
            };

            User.findOne = async (query) => {
                if (query.username === "test_login") {
                    return mockUser;
                }
                return null;
            };

            const res = await request(app)
                .post("/api/v1/users/login")
                .send({ username: "test_login", password: "Password123!" });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.ok(res.body.token, "Response must include bearer token");

            // Verify JWT payload
            const decoded = jwt.verify(res.body.token, getJwtSecret());
            assert.equal(decoded.id, mockUser._id.toString());
            assert.equal(decoded.username, "test_login");

            // Verify user object in response does NOT leak token
            assert.equal(res.body.user.token, undefined, "user object must not have token");
            assert.equal(res.body.user.password, undefined);

            // Verify user in memory/DB has no token
            assert.equal(mockUser.token, undefined);
        });

        it("POST /register returns valid token, returns user without token, and saves user without token", async () => {
            let savedUserDoc = null;

            User.findOne = async () => null; // No existing username collision

            User.prototype.save = async function () {
                savedUserDoc = this.toObject();
                this._id = new mongoose.Types.ObjectId("65cb22222222222222222222");
                return this;
            };

            const res = await request(app)
                .post("/api/v1/users/register")
                .send({
                    name: "New Registered User",
                    username: "new_reg_user",
                    password: "SecurePassword123!",
                });

            assert.equal(res.status, 201);
            assert.equal(res.body.success, true);
            assert.ok(res.body.token, "Response must return token");

            // Verify token in payload
            const decoded = jwt.verify(res.body.token, getJwtSecret());
            assert.equal(decoded.username, "new_reg_user");

            // Verify response user has no token
            assert.equal(res.body.user.token, undefined);

            // Verify database saved document had NO token field
            assert.ok(savedUserDoc, "User must have been saved");
            assert.equal(savedUserDoc.token, undefined, "Saved user doc must not have token");
        });
    });

    // =========================================================================
    // 3. Profile Endpoint Serialization & Legacy Field Shielding
    // =========================================================================
    describe("3. GET /profile/me Sanitization", () => {
        let originalFindById;

        beforeEach(() => {
            originalFindById = User.findById;
        });

        afterEach(() => {
            User.findById = originalFindById;
        });

        it("GET /profile/me returns profile without exposing token, even if document had legacy token", async () => {
            const userId = new mongoose.Types.ObjectId("65cb33333333333333333333");
            const token = makeTestToken({ id: userId.toString(), username: "legacy_user" });

            const legacyUserDoc = new User({
                _id: userId,
                name: "Legacy Profile User",
                username: "legacy_user",
                password: "hashedpassword123",
                dob: new Date("1997-03-22"),
                isProfileComplete: true,
            });

            // Simulate legacy persisted token in raw document
            legacyUserDoc.set("token", "legacy.stored.jwt.should.never.leak", { strict: false });

            User.findById = (id) => ({
                select: () => Promise.resolve(legacyUserDoc),
                then: (resolve) => resolve(legacyUserDoc),
            });

            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${token}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.ok(res.body.profile);
            assert.equal(res.body.profile.token, undefined, "profile MUST not expose token property");
            assert.equal(res.body.profile.password, undefined);
        });
    });

    // =========================================================================
    // 4. REST Transport Restrictions (Header-Only Enforcement)
    // =========================================================================
    describe("4. REST Authentication Header-Only Enforcement", () => {
        let originalFindById;
        const validUserId = new mongoose.Types.ObjectId("65cb44444444444444444444");
        let validToken;

        beforeEach(() => {
            validToken = makeTestToken({ id: validUserId.toString(), username: "header_test" });
            originalFindById = User.findById;

            const userDoc = new User({
                _id: validUserId,
                name: "Header Test User",
                username: "header_test",
                isProfileComplete: true,
            });

            User.findById = () => ({
                select: () => Promise.resolve(userDoc),
                then: (resolve) => resolve(userDoc),
            });
        });

        afterEach(() => {
            User.findById = originalFindById;
        });

        it("succeeds when valid token is provided in Authorization: Bearer <token> header", async () => {
            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${validToken}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
        });

        it("rejects request with 401 when token is passed ONLY via URL query string (?token=...)", async () => {
            const res = await request(app)
                .get(`/api/v1/users/profile/me?token=${validToken}`);

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /Authentication required/i);
        });

        it("rejects request with 401 when token is passed ONLY via request body ({ token: ... })", async () => {
            const res = await request(app)
                .put("/api/v1/users/profile/me")
                .send({ token: validToken, name: "Attacker Trying Body Token" });

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /Authentication required/i);
        });
    });

    // =========================================================================
    // 5. Socket.IO Handshake Transport Restrictions
    // =========================================================================
    describe("5. Socket.IO Handshake Auth Contract & Query Rejection", () => {
        let server;
        let ioServer;
        let port;
        const socketUserId = new mongoose.Types.ObjectId("65cb55555555555555555555");
        let validSocketToken;

        before(async () => {
            const expressApp = express();
            server = createServer(expressApp);
            ioServer = connectToSocket(server);
            await new Promise((res) => server.listen(0, "127.0.0.1", res));
            port = server.address().port;
            validSocketToken = makeTestToken({ id: socketUserId.toString(), username: "socket_tester" });
        });

        after(async () => {
            if (ioServer) ioServer.close();
            if (server) await new Promise((res) => server.close(res));
        });

        it("connects successfully when token is supplied in handshake auth.token (frontend contract)", async () => {
            const { client, error } = await connectSocketClient(port, {
                auth: { token: validSocketToken },
            });

            assert.equal(error, null, "auth.token must connect without error");
            assert.ok(client.connected);
            client.disconnect();
        });

        it("connects successfully when token is supplied in handshake headers.authorization", async () => {
            const { client, error } = await connectSocketClient(port, {
                extraHeaders: {
                    authorization: `Bearer ${validSocketToken}`,
                },
            });

            assert.equal(error, null, "Authorization header must connect without error");
            assert.ok(client.connected);
            client.disconnect();
        });

        it("strictly REJECTS socket connection with connect_error when token is passed ONLY in query string", async () => {
            const { client, error } = await connectSocketClient(port, {
                query: { token: validSocketToken },
                auth: {}, // Empty auth
            });

            assert.ok(error, "Handshake MUST reject connection when token is only in query string");
            assert.match(error.message, /Authentication error: Token required/i);
            client.disconnect();
        });

        it("strictly REJECTS socket connection when no token is provided at all", async () => {
            const { client, error } = await connectSocketClient(port, {
                auth: {},
            });

            assert.ok(error, "Handshake MUST reject connection without token");
            assert.match(error.message, /Authentication error: Token required/i);
            client.disconnect();
        });
    });
});
