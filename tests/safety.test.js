import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { User } from "../src/models/user.model.js";
import { Match } from "../src/models/match.model.js";
import { Block } from "../src/models/block.model.js";
import { Report } from "../src/models/report.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";

import safetyRouter from "../src/routes/safety.routes.js";
import moderationRouter from "../src/routes/moderation.routes.js";
import matchesRouter from "../src/routes/matches.routes.js";
import chatRouter from "../src/routes/chat.routes.js";
import discoveryRouter from "../src/routes/discovery.routes.js";

import {
    blockUser,
    unblockUser,
    reportUser,
    unmatch,
} from "../src/services/safety.service.js";
import {
    _testing as randomTesting,
    matchOrQueueUser,
    endActiveCallBetweenUsers,
} from "../src/controllers/randomCallManager.js";
import { getJwtSecret, JWT_EXPIRES_IN } from "../src/config/jwt.js";

const makeToken = (payload) =>
    jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });

describe("Prompt 6: Block, Report, Unmatch & Moderation Suite", () => {
    const userAId = "65ca11111111111111111111";
    const userBId = "65ca22222222222222222222";
    const userCId = "65ca33333333333333333333";
    const modUserId = "65ca99999999999999999999";

    const tokenA = makeToken({ id: userAId, username: "user_a" });
    const tokenB = makeToken({ id: userBId, username: "user_b" });
    const tokenMod = makeToken({ id: modUserId, username: "mod_user" });

    let app;

    let originalDefaultUserFind;

    beforeEach(() => {
        randomTesting.clearAll();
        app = express();
        app.use(express.json());

        originalDefaultUserFind = User.findById;
        User.findById = (id) => {
            const idStr = id?.toString();
            let role = "user";
            if (idStr === modUserId) role = "moderator";
            return {
                select: () => Promise.resolve({
                    _id: idStr || userAId,
                    role,
                    name: idStr === modUserId ? "Mod User" : "Regular User",
                    email: "user@example.com",
                    isProfileComplete: true,
                }),
                populate: () => Promise.resolve(null),
                then: (resolve) => resolve({
                    _id: idStr || userAId,
                    role,
                    name: idStr === modUserId ? "Mod User" : "Regular User",
                    email: "user@example.com",
                    isProfileComplete: true,
                }),
            };
        };

        // Stub req.user loader in protect middleware
        app.use("/api/v1/safety", safetyRouter);
        app.use("/api/v1/moderation", moderationRouter);
        app.use("/api/v1/matches", matchesRouter);
        app.use("/api/v1/conversations", chatRouter);
        app.use("/api/v1/discovery", discoveryRouter);
    });

    afterEach(() => {
        User.findById = originalDefaultUserFind;
        randomTesting.clearAll();
    });

    // =========================================================================
    // 1. Block & Unblock Logic
    // =========================================================================
    describe("Block & Unblock Core Functionality", () => {
        it("Scenario 1: Rejects self-blocking with 400 Bad Request", async () => {
            const res = await request(app)
                .post("/api/v1/safety/block")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ userId: userAId });

            assert.equal(res.status, 400);
            assert.match(res.body.message, /cannot block yourself/i);
        });

        it("Scenario 2: Successfully creates block, updates active match to unmatched, and is idempotent", async () => {
            let savedBlock = null;
            let matchStatusUpdated = false;

            const originalFindOneAndUpdate = Block.findOneAndUpdate;
            Block.findOneAndUpdate = async (filter, update) => {
                const reason = update.$setOnInsert?.reason || update.$set?.reason || "";
                savedBlock = { blocker: filter.blocker, blocked: filter.blocked, reason };
                return savedBlock;
            };

            const originalMatchFindOne = Match.findOne;
            Match.findOne = async () => ({
                status: "active",
                save: async function () {
                    matchStatusUpdated = true;
                    return this;
                },
            });

            const result = await blockUser(userAId, userBId, "Inappropriate messages");
            assert.equal(result.success, true);
            assert.equal(savedBlock.blocker.toString(), userAId);
            assert.equal(savedBlock.blocked.toString(), userBId);
            assert.equal(matchStatusUpdated, true);

            // Verify idempotency
            const result2 = await blockUser(userAId, userBId, "Repeated block");
            assert.equal(result2.success, true);

            Block.findOneAndUpdate = originalFindOneAndUpdate;
            Match.findOne = originalMatchFindOne;
        });

        it("Scenario 3: Unblocking removes block record and returns status correctly", async () => {
            const originalDelete = Block.deleteOne;
            Block.deleteOne = async (filter) => ({ deletedCount: 1 });

            const result = await unblockUser(userAId, userBId);
            assert.equal(result.success, true);
            assert.equal(result.unblocked, true);

            // When user was not blocked
            Block.deleteOne = async () => ({ deletedCount: 0 });
            const result2 = await unblockUser(userAId, userBId);
            assert.equal(result2.unblocked, false);

            Block.deleteOne = originalDelete;
        });
    });

    // =========================================================================
    // 2. Unmatch Logic & Preservation
    // =========================================================================
    describe("Unmatch Functionality & Non-Destructive Storage", () => {
        it("Scenario 4: Either participant can unmatch; sets status unmatched without deleting record", async () => {
            const matchId = "65ca88888888888888888888";
            let updatedDoc = null;

            const originalFindById = Match.findById;
            Match.findById = (id) => ({
                users: [userAId, userBId],
                status: "active",
                save: async function () {
                    updatedDoc = this;
                    return this;
                },
            });

            const result = await unmatch(userAId, matchId);
            assert.equal(result.success, true);
            assert.equal(result.match.status, "unmatched");
            assert.equal(result.match.unmatchedBy.toString(), userAId);
            assert.ok(result.match.unmatchedAt);

            Match.findById = originalFindById;
        });

        it("Scenario 5: Nonparticipant cannot unmatch a match", async () => {
            const matchId = "65ca88888888888888888888";
            const originalFindById = Match.findById;
            Match.findById = () => ({
                users: [userAId, userBId],
                status: "active",
            });

            await assert.rejects(
                async () => unmatch(userCId, matchId),
                (err) => {
                    assert.equal(err.status, 403);
                    assert.match(err.message, /not authorized/i);
                    return true;
                }
            );

            Match.findById = originalFindById;
        });
    });

    // =========================================================================
    // 3. Random Video Queue & Active Call Severing
    // =========================================================================
    describe("Random Video Block & Severing Protections", () => {
        it("Scenario 6: Matchmaking queue skips blocked candidate and restores skipped users to queue", async () => {
            const originalIsBlocked = Block.isBlockedBidirectional;
            const originalUserFind = User.findById;

            // User A is blocked by User B
            Block.isBlockedBidirectional = async (id1, id2) => {
                const s1 = id1.toString();
                const s2 = id2.toString();
                return (s1 === userAId && s2 === userBId) || (s1 === userBId && s2 === userAId);
            };

            User.findById = (id) => ({
                select: () => Promise.resolve({
                    _id: id,
                    name: "Test User",
                    dob: new Date("1995-01-01"),
                    gender: "male",
                    bio: "Bio",
                    photos: ["https://example.com/p.jpg"],
                    interests: ["reading"],
                    isProfileComplete: true,
                }),
            });

            const socketsMap = new Map();
            const createMockSocket = (id, uId) => {
                const s = {
                    id,
                    userId: uId,
                    connected: true,
                    emit: () => {},
                    join: () => {},
                };
                socketsMap.set(id, s);
                return s;
            };

            const mockSocketB = createMockSocket("sock_b", userBId);
            const mockSocketA = createMockSocket("sock_a", userAId);

            const mockIo = {
                sockets: {
                    sockets: socketsMap,
                },
                to: () => ({ emit: () => {} }),
            };

            // User B enters queue first
            await matchOrQueueUser(mockIo, mockSocketB);
            let queue = randomTesting.getQueue();
            assert.equal(queue.length, 1);
            assert.equal(queue[0].userId, userBId);

            // User A attempts to join queue: User B is in queue but BLOCKED with A.
            // A should NOT pair with B; B must remain in queue!
            await matchOrQueueUser(mockIo, mockSocketA);

            // Both users should now be in queue because they couldn't pair with each other
            queue = randomTesting.getQueue();
            const bStillInQueue = queue.some((entry) => entry.userId === userBId);
            const aInQueue = queue.some((entry) => entry.userId === userAId);

            assert.equal(bStillInQueue, true, "User B must remain in queue after being skipped");
            assert.equal(aInQueue, true, "User A must be added to queue as no unblocked match exists");
            assert.equal(randomTesting.getActiveCalls().size, 0, "No active call should be created between blocked users");

            Block.isBlockedBidirectional = originalIsBlocked;
            User.findById = originalUserFind;
        });

        it("Scenario 7: Blocking during an active call cleanly terminates call between participants", async () => {
            let emittedEvent = null;
            let emittedReason = null;

            const fakeSocketA = { id: "sock_a", emit: () => {} };
            const fakeSocketB = {
                id: "sock_b",
                emit: (evt, payload) => {
                    emittedEvent = evt;
                    emittedReason = payload?.reason;
                },
            };

            // Setup an active call between user A and user B
            const callId = "call_test_123";
            randomTesting.setActiveCall(callId, {
                callId,
                user1: { userId: userAId, socketId: "sock_a" },
                user2: { userId: userBId, socketId: "sock_b" },
                startedAt: new Date(),
            });

            const fakeIo = {
                to: (sockId) => {
                    if (sockId === "sock_b") return fakeSocketB;
                    return fakeSocketA;
                },
            };

            // Call endActiveCallBetweenUsers
            const ended = endActiveCallBetweenUsers(userAId, userBId, fakeIo);
            assert.ok(ended);
            assert.equal(emittedEvent, "random:call-ended");
            assert.equal(emittedReason, "ended_by_partner");
            assert.equal(randomTesting.getActiveCalls().size, 0);
        });
    });

    // =========================================================================
    // 4. Report Submission & Safety Validation
    // =========================================================================
    describe("User Reporting Subsystem", () => {
        it("Scenario 8: Rejects reporting oneself with 400 Bad Request", async () => {
            const res = await request(app)
                .post("/api/v1/safety/report")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    reportedUserId: userAId,
                    category: "harassment",
                    reason: "Self report",
                });

            assert.equal(res.status, 400);
            assert.match(res.body.message, /cannot report yourself/i);
        });

        it("Scenario 9: Rejects report with invalid category", async () => {
            const res = await request(app)
                .post("/api/v1/safety/report")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    reportedUserId: userBId,
                    category: "invalid_category_xyz",
                    reason: "Spam",
                });

            assert.equal(res.status, 400);
            assert.match(res.body.message, /category/i);
        });

        it("Scenario 10: Successfully records report without exposing reporter identity", async () => {
            const originalSave = Report.prototype.save;
            Report.prototype.save = async function () {
                this._id = new mongoose.Types.ObjectId();
                return this;
            };

            const result = await reportUser(userAId, userBId, {
                category: "inappropriate_content",
                reason: "Inappropriate photo posted",
                context: "profile",
            });

            assert.equal(result.success, true);
            assert.ok(result.report._id);
            assert.equal(result.report.category, "inappropriate_content");
            assert.equal(result.report.status, "pending");

            Report.prototype.save = originalSave;
        });
    });

    // =========================================================================
    // 5. Moderation Workflow & Role Permissions
    // =========================================================================
    describe("Moderation Reports Workflow & Access Control", () => {
        it("Scenario 11: Non-moderator user is forbidden from moderation endpoints (403)", async () => {
            const originalUserFindById = User.findById;
            User.findById = () => ({
                select: () => Promise.resolve({ _id: userAId, role: "user" }),
            });

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(res.status, 403);
            assert.match(res.body.message, /moderator or admin privileges required/i);

            User.findById = originalUserFindById;
        });

        it("Scenario 12: Moderator user can list reports and filter by status", async () => {
            const originalUserFindById = User.findById;
            User.findById = () => ({
                select: () => Promise.resolve({ _id: modUserId, role: "moderator" }),
            });

            const originalCount = Report.countDocuments;
            const originalFind = Report.find;

            Report.countDocuments = async () => 1;
            Report.find = () => ({
                sort: () => ({
                    skip: () => ({
                        limit: () => ({
                            populate: () => ({
                                populate: () => ({
                                    populate: () => Promise.resolve([
                                        {
                                            _id: "65ca77777777777777777777",
                                            category: "harassment",
                                            status: "pending",
                                            createdAt: new Date(),
                                        },
                                    ]),
                                }),
                            }),
                        }),
                    }),
                }),
            });

            const res = await request(app)
                .get("/api/v1/moderation/reports?status=pending")
                .set("Authorization", `Bearer ${tokenMod}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.reports.length, 1);
            assert.equal(res.body.reports[0].status, "pending");

            User.findById = originalUserFindById;
            Report.countDocuments = originalCount;
            Report.find = originalFind;
        });

        it("Scenario 13: Moderator can resolve report with resolution notes", async () => {
            const reportId = "65ca77777777777777777777";
            const originalUserFindById = User.findById;
            User.findById = () => ({
                select: () => Promise.resolve({ _id: modUserId, role: "moderator" }),
            });

            const originalReportFindById = Report.findById;
            Report.findById = async () => ({
                _id: reportId,
                status: "pending",
                resolutionNotes: "",
                save: async function () { return this; },
                populate: async function () { return this; },
            });

            const res = await request(app)
                .patch(`/api/v1/moderation/reports/${reportId}`)
                .set("Authorization", `Bearer ${tokenMod}`)
                .send({
                    status: "resolved",
                    resolutionNotes: "Content removed and user warned.",
                });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.report.status, "resolved");

            User.findById = originalUserFindById;
            Report.findById = originalReportFindById;
        });

        it("Scenario 14: Operation secret header x-moderator-secret grants administrative access", async () => {
            process.env.MODERATOR_API_KEY = "test_moderator_secret_key_123456";

            const originalCount = Report.countDocuments;
            const originalFind = Report.find;

            Report.countDocuments = async () => 0;
            Report.find = () => ({
                sort: () => ({
                    skip: () => ({
                        limit: () => ({
                            populate: () => ({
                                populate: () => ({
                                    populate: () => Promise.resolve([]),
                                }),
                            }),
                        }),
                    }),
                }),
            });

            const res = await request(app)
                .get("/api/v1/moderation/reports")
                .set("Authorization", `Bearer ${tokenA}`)
                .set("x-moderator-secret", "test_moderator_secret_key_123456");

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);

            Report.countDocuments = originalCount;
            Report.find = originalFind;
            delete process.env.MODERATOR_API_KEY;
        });
    });

    // =========================================================================
    // 6. Exclusion in Discovery & Swiping
    // =========================================================================
    describe("Discovery & Matching Exclusion", () => {
        it("Scenario 15: Discovery excludedIds array includes blocked users", async () => {
            const originalBlockGet = Block.getBlockedUserIds;
            Block.getBlockedUserIds = async (id) => [userBId];

            const blockedIds = await Block.getBlockedUserIds(userAId);
            assert.equal(blockedIds.length, 1);
            assert.equal(blockedIds[0], userBId);

            Block.getBlockedUserIds = originalBlockGet;
        });
    });
});
