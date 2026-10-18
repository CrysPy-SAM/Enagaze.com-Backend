import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { User } from "../src/models/user.model.js";
import { Report } from "../src/models/report.model.js";
import userRoutes from "../src/routes/users.routes.js";
import moderationRoutes from "../src/routes/moderation.routes.js";
import { toPublicProfile } from "../src/serializers/profile.serializer.js";
import { getJwtSecret, JWT_EXPIRES_IN } from "../src/config/jwt.js";

const makeToken = (payload) =>
    jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });

describe("Prompt 6.1: Moderator Authorization & Privilege Escalation Security Suite", () => {
    const regularUserId = "65ca11111111111111111111";
    const modUserId = "65ca88888888888888888888";
    const adminUserId = "65ca99999999999999999999";
    const testReportId = "65ca77777777777777777777";

    const regularToken = makeToken({ id: regularUserId, username: "regular_user" });
    const modToken = makeToken({ id: modUserId, username: "moderator_user" });
    const adminToken = makeToken({ id: adminUserId, username: "admin_user" });

    let app;
    let originalUserFindById;
    let originalUserFindOne;
    let originalUserSave;
    let originalReportFind;
    let originalReportFindById;
    let originalReportCount;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use("/api/v1/users", userRoutes);
        app.use("/api/v1/moderation", moderationRoutes);

        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;
        originalUserSave = User.prototype.save;
        originalReportFind = Report.find;
        originalReportFindById = Report.findById;
        originalReportCount = Report.countDocuments;
    });

    afterEach(() => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;
        User.prototype.save = originalUserSave;
        Report.find = originalReportFind;
        Report.findById = originalReportFindById;
        Report.countDocuments = originalReportCount;
        delete process.env.MODERATOR_API_KEY;
    });

    // =========================================================================
    // 1. Privilege Escalation Prevention (Registration & Profile Update)
    // =========================================================================
    describe("Privilege Escalation Protections", () => {
        it("Scenario 1: Client attempting role elevation during registration defaults to 'user'", async () => {
            let capturedUserInstance = null;

            User.findOne = async () => null; // Username doesn't exist
            User.prototype.save = async function () {
                capturedUserInstance = this;
                this._id = new mongoose.Types.ObjectId(regularUserId);
                return this;
            };

            const res = await request(app)
                .post("/api/v1/users/register")
                .send({
                    name: "Attacker User",
                    username: "attacker_sec",
                    password: "password123",
                    role: "admin", // Malicious role injection attempt
                });

            assert.equal(res.status, 201);
            assert.equal(res.body.success, true);
            assert.ok(capturedUserInstance, "User record must have been created");
            assert.equal(
                capturedUserInstance.role,
                "user",
                "User role must strictly be 'user', ignoring client-supplied 'admin'"
            );
            assert.equal(res.body.user.role, "user");
        });

        it("Scenario 2: Client attempting role elevation to 'moderator' in registration is ignored", async () => {
            let capturedUserInstance = null;

            User.findOne = async () => null;
            User.prototype.save = async function () {
                capturedUserInstance = this;
                this._id = new mongoose.Types.ObjectId(regularUserId);
                return this;
            };

            const res = await request(app)
                .post("/api/v1/users/register")
                .send({
                    name: "Mod Candidate",
                    username: "mod_candidate",
                    password: "password123",
                    role: "moderator", // Malicious role injection attempt
                });

            assert.equal(res.status, 201);
            assert.equal(capturedUserInstance.role, "user");
            assert.equal(res.body.user.role, "user");
        });

        it("Scenario 3: Authenticated user attempting role elevation via profile update has role unchanged", async () => {
            const mockDbUser = {
                _id: regularUserId,
                name: "Standard User",
                username: "standard_user",
                role: "user",
                datingPreferences: { interestedIn: ["everyone"], ageRange: { min: 18, max: 100 } },
                save: async function () { return this; },
                toJSON: function () {
                    return { _id: this._id, name: this.name, role: this.role };
                },
            };

            User.findById = (id) => ({
                select: () => Promise.resolve(mockDbUser),
                then: (resolve) => resolve(mockDbUser),
            });

            const res = await request(app)
                .put("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${regularToken}`)
                .send({
                    bio: "Updated bio description",
                    role: "admin", // Attempted privilege escalation
                    admin: true,
                    isModerator: true,
                });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(
                mockDbUser.role,
                "user",
                "Existing role must not be mutated by profile update payload"
            );
            assert.equal(res.body.profile.role, "user");
        });
    });

    // =========================================================================
    // 2. Normal User Authorization Denial on Moderation Endpoints
    // =========================================================================
    describe("Normal User Access Denial (403 Forbidden)", () => {
        beforeEach(() => {
            User.findById = (id) => ({
                select: () => Promise.resolve({
                    _id: regularUserId,
                    role: "user", // Normal unprivileged role
                    name: "Regular Member",
                }),
            });
        });

        it("Scenario 4: Normal user cannot list moderation reports (GET /reports)", async () => {
            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("Authorization", `Bearer ${regularToken}`);

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /moderator or admin privileges required/i);
        });

        it("Scenario 5: Normal user cannot view specific report details (GET /reports/:id)", async () => {
            const res = await request(app)
                .get(`/api/v1/moderation/reports/${testReportId}`)
                .set("Authorization", `Bearer ${regularToken}`);

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /moderator or admin privileges required/i);
        });

        it("Scenario 6: Normal user cannot update moderation report status (PATCH /reports/:id)", async () => {
            const res = await request(app)
                .patch(`/api/v1/moderation/reports/${testReportId}`)
                .set("Authorization", `Bearer ${regularToken}`)
                .send({
                    status: "dismissed",
                    resolutionNotes: "Unauthorized dismissal",
                });

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /moderator or admin privileges required/i);
        });
    });

    // =========================================================================
    // 3. Missing, Malformed & Invalid Credentials Handling
    // =========================================================================
    describe("Missing & Invalid Credentials Rejection", () => {
        it("Scenario 7: Request with no token and no secret returns 401 Unauthorized", async () => {
            const res = await request(app)
                .get("/api/v1/moderation/reports");

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /authentication required/i);
        });

        it("Scenario 8: Request with invalid/tampered Bearer token returns 401 Unauthorized", async () => {
            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("Authorization", "Bearer invalid.tampered.token");

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /invalid authentication token/i);
        });

        it("Scenario 9: Request with invalid x-moderator-secret returns 403 Forbidden", async () => {
            process.env.MODERATOR_API_KEY = "super_secure_server_moderator_key_2026";

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("x-moderator-secret", "wrong_guessed_secret_key");

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /invalid moderator credentials/i);
        });

        it("Scenario 10: Request with x-moderator-secret fails closed when MODERATOR_API_KEY is not set", async () => {
            delete process.env.MODERATOR_API_KEY;

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("x-moderator-secret", "any_secret_attempt");

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /invalid moderator credentials/i);
        });

        it("Scenario 11: Request with empty x-moderator-secret fails closed (403)", async () => {
            process.env.MODERATOR_API_KEY = "super_secure_server_moderator_key_2026";

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("x-moderator-secret", "");

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
        });
    });

    // =========================================================================
    // 4. Authorized Moderator & Admin Access
    // =========================================================================
    describe("Authorized Moderator & Admin Operations", () => {
        beforeEach(() => {
            Report.countDocuments = async () => 1;
            Report.find = () => ({
                sort: () => ({
                    skip: () => ({
                        limit: () => ({
                            populate: () => ({
                                populate: () => ({
                                    populate: () => Promise.resolve([
                                        {
                                            _id: testReportId,
                                            category: "inappropriate_content",
                                            status: "pending",
                                            reporter: { name: "Reporter" },
                                            reportedUser: { name: "Reported" },
                                        },
                                    ]),
                                }),
                            }),
                        }),
                    }),
                }),
            });
            Report.findById = (id) => ({
                populate: () => ({
                    populate: () => ({
                        populate: () => Promise.resolve({
                            _id: id,
                            category: "inappropriate_content",
                            status: "pending",
                            save: async function () { return this; },
                        }),
                    }),
                }),
                then: (resolve) => resolve({
                    _id: id,
                    category: "inappropriate_content",
                    status: "pending",
                    save: async function () { return this; },
                    populate: async function () { return this; },
                }),
            });
        });

        it("Scenario 12: Authenticated user with role 'moderator' can list reports", async () => {
            User.findById = () => ({
                select: () => Promise.resolve({
                    _id: modUserId,
                    role: "moderator",
                    name: "Active Moderator",
                }),
            });

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("Authorization", `Bearer ${modToken}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.total, 1);
            assert.equal(res.body.reports[0]._id, testReportId);
        });

        it("Scenario 13: Authenticated user with role 'admin' can list reports", async () => {
            User.findById = () => ({
                select: () => Promise.resolve({
                    _id: adminUserId,
                    role: "admin",
                    name: "System Admin",
                }),
            });

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("Authorization", `Bearer ${adminToken}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.total, 1);
        });

        it("Scenario 14: Automated operational caller with only valid x-moderator-secret can list reports without user JWT", async () => {
            process.env.MODERATOR_API_KEY = "automation_cron_secret_key_888999";

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("x-moderator-secret", "automation_cron_secret_key_888999");

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.total, 1);
        });

        it("Scenario 15: Authorized moderator can inspect specific report and update its status", async () => {
            User.findById = () => ({
                select: () => Promise.resolve({
                    _id: modUserId,
                    role: "moderator",
                    name: "Active Moderator",
                }),
            });

            const getRes = await request(app)
                .get(`/api/v1/moderation/reports/${testReportId}`)
                .set("Authorization", `Bearer ${modToken}`);

            assert.equal(getRes.status, 200);
            assert.equal(getRes.body.success, true);
            assert.equal(getRes.body.report._id, testReportId);

            const patchRes = await request(app)
                .patch(`/api/v1/moderation/reports/${testReportId}`)
                .set("Authorization", `Bearer ${modToken}`)
                .send({
                    status: "resolved",
                    resolutionNotes: "Content moderated and account warned.",
                });

            assert.equal(patchRes.status, 200);
            assert.equal(patchRes.body.success, true);
        });
    });

    // =========================================================================
    // 5. Client DTO Data Privacy Verification
    // =========================================================================
    describe("DTO Data Privacy & Internal Role Concealment", () => {
        it("Scenario 16: toPublicProfile never exposes internal role or moderation fields", () => {
            const rawUser = {
                _id: new mongoose.Types.ObjectId(modUserId),
                name: "Moderator Jane",
                username: "jane_mod_login",
                role: "moderator", // Privileged role
                email: "jane@engaze.com",
                dob: new Date("1995-05-15"),
                gender: "female",
                bio: "Friendly community moderator",
                photos: ["https://example.com/jane.jpg"],
                interests: ["Reading", "Hiking"],
                isProfileComplete: true,
                reportsCount: 5,
                moderationNotes: "Highly trusted reviewer",
            };

            const serialized = toPublicProfile(rawUser);

            assert.equal(serialized.role, undefined, "Public profile must NEVER expose role");
            assert.equal(serialized.username, undefined, "Public profile must NEVER expose login username");
            assert.equal(serialized.email, undefined, "Public profile must NEVER expose email");
            assert.equal(serialized.dob, undefined, "Public profile must NEVER expose raw dob");
            assert.equal(serialized.reportsCount, undefined, "Public profile must NEVER expose moderation counts");
            assert.equal(serialized.moderationNotes, undefined, "Public profile must NEVER expose moderation notes");

            // Permitted fields
            assert.equal(serialized.name, "Moderator Jane");
            assert.equal(typeof serialized.age, "number");
            assert.equal(serialized.isProfileComplete, true);
        });
    });
});
