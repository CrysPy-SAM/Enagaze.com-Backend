import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { validateUsername, normalizeUsername, RESERVED_USERNAMES } from "../src/utils/usernameValidator.js";
import { backfillLegacyUsers } from "../scripts/backfillUsernames.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

describe("Username Management & 14-Day Cooldown Policy Test Suite", () => {
    let userGoogleNew;
    let tokenGoogleNew;
    let userStandard;
    let tokenStandard;
    let userExistingGoogle;
    let tokenExistingGoogle;

    before(async () => {
        // Connect to in-memory/test MongoDB or existing mongoose connection
        if (mongoose.connection.readyState !== 1) {
            const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/engaze_test";
            await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
        }
    });

    beforeEach(async () => {
        // Clean up test users
        await User.deleteMany({
            $or: [
                { username: { $in: [
                    "test_alice", "test_bob", "test_charlie", "temp_g1", "alice_new",
                    "taken_user", "satyam", "satyam_test", "Satyam_Test", "cooldown_user", "legacy_user", "larry_new", "Legacy_Larry"
                ] } },
                { normalizedUsername: { $in: [
                    "test_alice", "test_bob", "test_charlie", "temp_g1", "alice_new",
                    "taken_user", "satyam", "satyam_test", "cooldown_user", "legacy_user", "larry_new", "legacy_larry"
                ] } },
            ]
        });
        await User.deleteMany({ googleId: { $in: ["g_test_123", "g_test_456"] } });
        await User.deleteMany({ email: { $in: ["gnew@example.com", "gexist@example.com"] } });

        // 1. First-time Google user (provisional username, usernameSetupCompleted: false)
        userGoogleNew = new User({
            name: "New Google User",
            username: "temp_g1",
            normalizedUsername: "temp_g1",
            googleId: "g_test_123",
            email: "gnew@example.com",
            authProvider: "google",
            usernameSetupCompleted: false,
            usernameLastChangedAt: null,
            isProfileComplete: false,
        });
        await userGoogleNew.save();
        tokenGoogleNew = makeToken({ id: userGoogleNew._id.toString(), username: userGoogleNew.username });

        // 2. Standard user who chose username at registration (usernameSetupCompleted: true)
        const passwordHash = await bcrypt.hash("password123", 10);
        userStandard = new User({
            name: "Standard User",
            username: "test_alice",
            normalizedUsername: "test_alice",
            password: passwordHash,
            authProvider: "local",
            usernameSetupCompleted: true,
            usernameLastChangedAt: null, // First change is free!
            isProfileComplete: true,
            dob: new Date("1995-05-15"),
            gender: "female",
            photos: ["https://example.com/alice.jpg"],
        });
        await userStandard.save();
        tokenStandard = makeToken({ id: userStandard._id.toString(), username: userStandard.username });

        // 3. Pre-existing Google user who already completed setup
        userExistingGoogle = new User({
            name: "Existing Google User",
            username: "test_bob",
            normalizedUsername: "test_bob",
            googleId: "g_test_456",
            email: "gexist@example.com",
            authProvider: "google",
            usernameSetupCompleted: true,
            usernameLastChangedAt: null,
            isProfileComplete: true,
            dob: new Date("1993-02-10"),
            gender: "male",
            photos: ["https://example.com/bob.jpg"],
        });
        await userExistingGoogle.save();
        tokenExistingGoogle = makeToken({ id: userExistingGoogle._id.toString(), username: userExistingGoogle.username });
    });

    after(async () => {
        if (mongoose.connection.readyState !== 0) {
            await User.deleteMany({
                $or: [
                    { username: { $in: [
                        "test_alice", "test_bob", "test_charlie", "temp_g1", "alice_new",
                        "taken_user", "satyam", "satyam_test", "Satyam_Test", "cooldown_user", "legacy_user", "larry_new", "Legacy_Larry"
                    ] } },
                    { normalizedUsername: { $in: [
                        "test_alice", "test_bob", "test_charlie", "temp_g1", "alice_new",
                        "taken_user", "satyam", "satyam_test", "cooldown_user", "legacy_user", "larry_new", "legacy_larry"
                    ] } },
                ]
            });
            await User.deleteMany({ googleId: { $in: ["g_test_123", "g_test_456"] } });
            await User.deleteMany({ email: { $in: ["gnew@example.com", "gexist@example.com"] } });
            await mongoose.disconnect();
        }
    });

    // =========================================================================
    // 1. Username Validation & Formatting Unit Tests
    // =========================================================================
    describe("1. Username Validation & Normalization Rules", () => {
        it("normalizes uppercase and whitespace correctly", () => {
            assert.equal(normalizeUsername("  Satyam_123  "), "satyam_123");
        });

        it("accepts valid usernames meeting policy", () => {
            const validCandidates = ["satyam", "alex.dev", "john_doe", "cool-girl99", "user_123"];
            for (const cand of validCandidates) {
                const res = validateUsername(cand);
                assert.equal(res.valid, true, `Expected ${cand} to be valid`);
            }
        });

        it("rejects usernames that are too short (< 3 chars)", () => {
            const res = validateUsername("ab");
            assert.equal(res.valid, false);
            assert.match(res.error, /at least 3 characters/i);
        });

        it("rejects usernames that are too long (> 20 chars)", () => {
            const res = validateUsername("abcdefghijklmnopqrstu_extra");
            assert.equal(res.valid, false);
            assert.match(res.error, /cannot exceed 20 characters/i);
        });

        it("rejects invalid characters (spaces, symbols)", () => {
            const invalidCandidates = ["user name", "satyam@123", "cool#girl", "alex!"];
            for (const cand of invalidCandidates) {
                const res = validateUsername(cand);
                assert.equal(res.valid, false, `Expected ${cand} to be rejected`);
            }
        });

        it("rejects starting or ending with dots, underscores, or hyphens", () => {
            const edgeCandidates = [".satyam", "satyam.", "_alex", "alex_", "-john", "john-"];
            for (const cand of edgeCandidates) {
                const res = validateUsername(cand);
                assert.equal(res.valid, false, `Expected ${cand} to be rejected`);
            }
        });

        it("rejects consecutive dots (..)", () => {
            const res = validateUsername("satyam..mishra");
            assert.equal(res.valid, false);
            assert.match(res.error, /consecutive dots/i);
        });

        it("rejects reserved system usernames (admin, support, engaze, api, etc.)", () => {
            const reserved = ["admin", "engaze", "support", "official", "privacy", "terms"];
            for (const cand of reserved) {
                const res = validateUsername(cand);
                assert.equal(res.valid, false, `Expected ${cand} to be reserved`);
                assert.match(res.error, /reserved/i);
            }
        });
    });

    // =========================================================================
    // 2. Real-Time Availability & Case-Insensitive Uniqueness
    // =========================================================================
    describe("2. Username Availability & Case-Insensitive Uniqueness", () => {
        it("returns available: true for an unclaimed valid username", async () => {
            const res = await request(app)
                .get("/api/v1/users/check-username?username=unclaimed_vibe")
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.available, true);
            assert.match(res.body.message, /available/i);
        });

        it("enforces case-insensitive uniqueness (Satyam vs satyam vs SATYAM)", async () => {
            // Create user with 'satyam_test'
            const user = new User({
                name: "Satyam M",
                username: "Satyam_Test",
                normalizedUsername: "satyam_test",
                authProvider: "local",
                password: "password123",
            });
            await user.save();

            // Check lowercase 'satyam_test'
            const resLower = await request(app)
                .get("/api/v1/users/check-username?username=satyam_test")
                .expect(200);
            assert.equal(resLower.body.available, false);
            assert.ok(Array.isArray(resLower.body.suggestions));

            // Check uppercase 'SATYAM_TEST'
            const resUpper = await request(app)
                .get("/api/v1/users/check-username?username=SATYAM_TEST")
                .expect(200);
            assert.equal(resUpper.body.available, false);
            assert.ok(Array.isArray(resUpper.body.suggestions));
        });

        it("returns isCurrent: true when authenticated user checks their own username", async () => {
            const res = await request(app)
                .get("/api/v1/users/check-username?username=test_alice")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.available, true);
            assert.equal(res.body.isCurrent, true);
        });

        it("returns validation error message when checking an invalid format", async () => {
            const res = await request(app)
                .get("/api/v1/users/check-username?username=a")
                .expect(200);

            assert.equal(res.body.available, false);
            assert.match(res.body.message, /at least 3 characters/i);
        });
    });

    // =========================================================================
    // 3. First-Time Setup vs Existing Users
    // =========================================================================
    describe("3. Initial Username Setup for First-Time Users", () => {
        it("allows first-time user to set their preferred username without cooldown lock", async () => {
            const res = await request(app)
                .post("/api/v1/users/setup-username")
                .set("Authorization", `Bearer ${tokenGoogleNew}`)
                .send({ username: "alice_new" })
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.user.username, "alice_new");
            assert.equal(res.body.user.usernameSetupCompleted, true);
            assert.equal(res.body.user.usernameLastChangedAt, null); // Cooldown is NOT triggered!

            // Verify in DB
            const updated = await User.findById(userGoogleNew._id);
            assert.equal(updated.username, "alice_new");
            assert.equal(updated.normalizedUsername, "alice_new");
            assert.equal(updated.usernameSetupCompleted, true);
            assert.equal(updated.usernameLastChangedAt, null);
        });

        it("rejects setup-username if user already completed initial setup", async () => {
            // userStandard already has usernameSetupCompleted: true
            const res = await request(app)
                .post("/api/v1/users/setup-username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "another_name" })
                .expect(400);

            assert.equal(res.body.success, false);
            assert.match(res.body.message, /already been completed/i);
        });

        it("rejects initial setup if requested username is taken, returning suggestions", async () => {
            const res = await request(app)
                .post("/api/v1/users/setup-username")
                .set("Authorization", `Bearer ${tokenGoogleNew}`)
                .send({ username: "test_alice" }) // Already taken by userStandard
                .expect(409);

            assert.equal(res.body.success, false);
            assert.match(res.body.message, /already taken/i);
            assert.ok(Array.isArray(res.body.suggestions));
            assert.ok(res.body.suggestions.length > 0);
        });
    });

    // =========================================================================
    // 4. 14-Day Cooldown Enforcement (Subsequent Changes)
    // =========================================================================
    describe("4. 14-Day Cooldown Enforcement", () => {
        it("allows user to change username when usernameLastChangedAt is null", async () => {
            const res = await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "test_charlie" })
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.username, "test_charlie");
            assert.ok(res.body.nextEligibleAt);

            // DB now records usernameLastChangedAt
            const updated = await User.findById(userStandard._id);
            assert.equal(updated.username, "test_charlie");
            assert.equal(updated.normalizedUsername, "test_charlie");
            assert.ok(updated.usernameLastChangedAt instanceof Date);
        });

        it("rejects another username change before 14 days have elapsed (HTTP 429)", async () => {
            // First change succeeds
            await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "test_charlie" })
                .expect(200);

            // Immediate second change attempt within 14 days
            const res = await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "test_david" })
                .expect(429);

            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "USERNAME_COOLDOWN_ACTIVE");
            assert.match(res.body.message, /once every 14 days/i);
            assert.ok(res.body.remainingDays >= 13);
            assert.ok(res.body.nextEligibleAt);
        });

        it("allows username change after 14-day cooldown period has elapsed", async () => {
            // Set user's last changed timestamp to 15 days ago
            const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
            userStandard.usernameLastChangedAt = fifteenDaysAgo;
            await userStandard.save();

            const res = await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "test_charlie" })
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.username, "test_charlie");
        });

        it("failed attempts (validation or duplicate) do NOT reset or extend the cooldown timestamp", async () => {
            const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
            userStandard.usernameLastChangedAt = tenDaysAgo;
            await userStandard.save();

            // Try invalid username
            await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "ab" })
                .expect(400);

            // Verify timestamp unchanged in DB
            const userAfterFail = await User.findById(userStandard._id);
            assert.equal(userAfterFail.usernameLastChangedAt.getTime(), tenDaysAgo.getTime());
        });

        it("returns accurate eligibility status via GET /username-eligibility", async () => {
            // 1. Initial state (can change)
            const resInitial = await request(app)
                .get("/api/v1/users/username-eligibility")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .expect(200);

            assert.equal(resInitial.body.canChange, true);
            assert.equal(resInitial.body.cooldownDaysRemaining, 0);

            // 2. After change (in cooldown)
            await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "test_charlie" })
                .expect(200);

            const resCooldown = await request(app)
                .get("/api/v1/users/username-eligibility")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .expect(200);

            assert.equal(resCooldown.body.canChange, false);
            assert.ok(resCooldown.body.cooldownDaysRemaining >= 13);
            assert.ok(resCooldown.body.nextEligibleAt);
        });

        it("prevents changing to one's own current username", async () => {
            const res = await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "test_alice" })
                .expect(400);

            assert.equal(res.body.success, false);
            assert.match(res.body.message, /must be different from your current username/i);
        });

        it("cannot bypass cooldown by attempting to update username via PUT /profile/me", async () => {
            // Ensure PUT /profile/me ignores any 'username' field in req.body
            const res = await request(app)
                .put("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${tokenStandard}`)
                .send({ username: "hacked_name", bio: "Updated bio" })
                .expect(200);

            const user = await User.findById(userStandard._id);
            assert.equal(user.username, "test_alice"); // Username remained unchanged!
            assert.equal(user.bio, "Updated bio");
        });
    });

    // =========================================================================
    // 5. Protected Route Gating Before Username Setup
    // =========================================================================
    describe("5. Protected Route Access Gating", () => {
        it("blocks user with usernameSetupCompleted: false from accessing discovery feed (HTTP 403)", async () => {
            const res = await request(app)
                .get("/api/v1/discovery")
                .set("Authorization", `Bearer ${tokenGoogleNew}`)
                .expect(403);

            assert.equal(res.body.code, "USERNAME_SETUP_REQUIRED");
            assert.match(res.body.message, /choose your username/i);
        });

        it("blocks user with usernameSetupCompleted: false from accessing user search (HTTP 403)", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=alice")
                .set("Authorization", `Bearer ${tokenGoogleNew}`)
                .expect(403);

            assert.equal(res.body.code, "USERNAME_SETUP_REQUIRED");
        });

        it("allows user with usernameSetupCompleted: false to fetch their own profile to inspect status", async () => {
            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${tokenGoogleNew}`)
                .expect(200);

            assert.equal(res.body.profile.usernameSetupCompleted, false);
        });
    });

    // =========================================================================
    // 6. Legacy Migration & Backfill Strategy
    // =========================================================================
    describe("6. Legacy Migration & Backfill Strategy", () => {
        it("backfills legacy users without breaking or locking them into cooldown", async () => {
            // Create simulated legacy user without normalizedUsername or usernameSetupCompleted
            const legacyUser = new User({
                name: "Legacy Larry",
                username: "Legacy_Larry",
                password: "password123",
                authProvider: "local",
            });
            await legacyUser.save();

            // Strip fields directly via MongoDB update to simulate unmigrated record
            await User.collection.updateOne(
                { _id: legacyUser._id },
                { $unset: { normalizedUsername: "", usernameSetupCompleted: "", usernameLastChangedAt: "" } }
            );

            // Execute backfill
            const updatedCount = await backfillLegacyUsers({ logger: { log: () => {} } });
            assert.ok(updatedCount >= 1);

            // Verify backfill result
            const backfilled = await User.findById(legacyUser._id);
            assert.equal(backfilled.normalizedUsername, "legacy_larry");
            assert.equal(backfilled.usernameSetupCompleted, true); // NOT locked into onboarding!
            assert.equal(backfilled.usernameLastChangedAt, null); // Can immediately edit!

            // Verify user can now edit username without cooldown
            const tokenLegacy = makeToken({ id: legacyUser._id.toString(), username: legacyUser.username });
            const res = await request(app)
                .put("/api/v1/users/username")
                .set("Authorization", `Bearer ${tokenLegacy}`)
                .send({ username: "larry_new" })
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.username, "larry_new");

            // Clean up
            await User.deleteOne({ _id: legacyUser._id });
        });
    });
});
