import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Swipe } from "../src/models/swipe.model.js";
import { Match } from "../src/models/match.model.js";
import { Block } from "../src/models/block.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";

import discoveryRouter from "../src/routes/discovery.routes.js";
import usersRouter from "../src/routes/users.routes.js";
import chatRouter from "../src/routes/chat.routes.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

describe("Prompt 12: Persistent Discovery Preferences & Stable Pagination Suite", () => {
    let server;
    let app;

    let originalUserFindById;
    let originalUserFindOne;
    let originalUserFind;
    let originalUserCountDocuments;
    let originalSwipeFind;
    let originalMatchFind;
    let originalBlockGetBlockedUserIds;
    let originalBlockIsBlockedBidirectional;
    let originalConvFindById;
    let originalMsgFind;
    let originalMsgFindById;
    let originalMsgCount;

    // Test Users
    const userAId = new mongoose.Types.ObjectId("65cb11111111111111111111");
    const userBId = new mongoose.Types.ObjectId("65cb22222222222222222222");
    const userUnderageId = new mongoose.Types.ObjectId("65cb33333333333333333333");
    const userIncompleteId = new mongoose.Types.ObjectId("65cb44444444444444444444");

    const mockUserA = {
        _id: userAId,
        name: "Alice Active",
        username: "alice_active",
        dob: new Date("1996-06-15"), // ~30 years old
        gender: "female",
        bio: "Coffee and photography enthusiast",
        photos: ["https://example.com/alice.jpg"],
        interests: ["hiking", "music", "art"],
        isProfileComplete: true,
        datingPreferences: {
            interestedIn: ["male"],
            ageRange: { min: 25, max: 40 },
        },
        save: async function () { return this; },
        toJSON: function () {
            const copy = { ...this };
            delete copy.save;
            delete copy.toJSON;
            return copy;
        },
    };

    const mockUserB = {
        _id: userBId,
        name: "Bob Builder",
        username: "bob_builder",
        dob: new Date("1994-03-20"), // ~32 years old
        gender: "male",
        bio: "Architect and runner",
        photos: ["https://example.com/bob.jpg"],
        interests: ["architecture", "running", "coffee"],
        isProfileComplete: true,
        datingPreferences: {
            interestedIn: ["female"],
            ageRange: { min: 20, max: 35 },
        },
        save: async function () { return this; },
        toJSON: function () {
            const copy = { ...this };
            delete copy.save;
            delete copy.toJSON;
            return copy;
        },
    };

    const tokenA = makeToken({ id: userAId.toString(), username: mockUserA.username });
    const tokenB = makeToken({ id: userBId.toString(), username: mockUserB.username });

    let inMemoryUsers = {};
    let inMemorySwipes = [];
    let inMemoryMatches = [];
    let inMemoryBlocked = [];

    before(async () => {
        app = express();
        app.use(express.json());

        // Mount routes under test
        app.use("/api/v1/discovery", discoveryRouter);
        app.use("/api/v1/users", usersRouter);
        app.use("/api/v1/conversations", chatRouter);

        server = createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

        // Save original Mongoose methods
        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;
        originalUserFind = User.find;
        originalUserCountDocuments = User.countDocuments;
        originalSwipeFind = Swipe.find;
        originalMatchFind = Match.find;
        originalBlockGetBlockedUserIds = Block.getBlockedUserIds;
        originalBlockIsBlockedBidirectional = Block.isBlockedBidirectional;
        originalConvFindById = Conversation.findById;
        originalMsgFind = Message.find;
        originalMsgFindById = Message.findById;
        originalMsgCount = Message.countDocuments;
    });

    after(async () => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;
        User.find = originalUserFind;
        User.countDocuments = originalUserCountDocuments;
        Swipe.find = originalSwipeFind;
        Match.find = originalMatchFind;
        Block.getBlockedUserIds = originalBlockGetBlockedUserIds;
        Block.isBlockedBidirectional = originalBlockIsBlockedBidirectional;
        Conversation.findById = originalConvFindById;
        Message.find = originalMsgFind;
        Message.findById = originalMsgFindById;
        Message.countDocuments = originalMsgCount;

        await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
        inMemoryUsers = {
            [userAId.toString()]: { ...mockUserA, datingPreferences: { interestedIn: ["male"], ageRange: { min: 25, max: 40 } } },
            [userBId.toString()]: { ...mockUserB, datingPreferences: { interestedIn: ["female"], ageRange: { min: 20, max: 35 } } },
        };
        inMemorySwipes = [];
        inMemoryMatches = [];
        inMemoryBlocked = [];

        User.findById = (id) => {
            const idStr = id?.toString();
            const u = inMemoryUsers[idStr];
            if (!u) {
                return {
                    select: () => Promise.resolve(null),
                    then: (resolve) => resolve(null),
                };
            }
            const doc = {
                ...u,
                save: async function () {
                    inMemoryUsers[idStr] = { ...this };
                    return this;
                },
                toJSON: function () {
                    const copy = { ...this };
                    delete copy.save;
                    delete copy.toJSON;
                    return copy;
                },
            };
            return {
                select: (fields) => Promise.resolve(doc),
                then: (resolve) => resolve(doc),
            };
        };

        User.findOne = (query) => {
            const idStr = query?._id?.toString();
            const u = inMemoryUsers[idStr];
            return Promise.resolve(u || null);
        };

        Swipe.find = () => ({
            select: () => Promise.resolve(inMemorySwipes),
            then: (resolve) => resolve(inMemorySwipes),
        });

        Match.find = () => ({
            select: () => Promise.resolve(inMemoryMatches),
            then: (resolve) => resolve(inMemoryMatches),
        });

        Block.getBlockedUserIds = () => Promise.resolve(inMemoryBlocked);
        Block.isBlockedBidirectional = () => Promise.resolve(false);
    });

    describe("1. Preference Persistence & Restoration Across Sessions", () => {
        it("persists valid ageRange and interestedIn to authenticated user datingPreferences", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    interestedIn: ["female", "non-binary"],
                    ageRange: { min: 22, max: 38 },
                });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.deepStrictEqual(res.body.datingPreferences.interestedIn, ["female", "non-binary"]);
            assert.strictEqual(res.body.datingPreferences.ageRange.min, 22);
            assert.strictEqual(res.body.datingPreferences.ageRange.max, 38);
        });

        it("restores updated preferences on GET /discovery/preferences (simulated page refresh / new session)", async () => {
            // First update
            await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    interestedIn: ["male"],
                    ageRange: { min: 28, max: 36 },
                });

            // Simulated refresh/re-fetch
            const getRes = await request(app)
                .get("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(getRes.status, 200);
            assert.strictEqual(getRes.body.success, true);
            assert.deepStrictEqual(getRes.body.datingPreferences.interestedIn, ["male"]);
            assert.strictEqual(getRes.body.datingPreferences.ageRange.min, 28);
            assert.strictEqual(getRes.body.datingPreferences.ageRange.max, 36);
        });

        it("persists across simulated logout and re-login (GET /users/profile/me contains persisted preferences)", async () => {
            await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    interestedIn: ["everyone"],
                    ageRange: { min: 19, max: 45 },
                });

            // New session / profile reload
            const profileRes = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(profileRes.status, 200);
            assert.deepStrictEqual(profileRes.body.profile.datingPreferences.interestedIn, ["everyone"]);
            assert.strictEqual(profileRes.body.profile.datingPreferences.ageRange.min, 19);
            assert.strictEqual(profileRes.body.profile.datingPreferences.ageRange.max, 45);
        });
    });

    describe("2. Rejection of Invalid Preference Values and Malformed Partial Updates", () => {
        it("rejects min age < 18 with 400 Bad Request", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { min: 17, max: 30 } });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /18 and 120/i);
        });

        it("rejects max age > 120 with 400 Bad Request", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { min: 20, max: 125 } });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /18 and 120/i);
        });

        it("rejects min age > max age with 400 Bad Request", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { min: 45, max: 30 } });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /cannot exceed/i);
        });

        it("rejects non-integer age values with 400 Bad Request", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { min: 21.5, max: 35 } });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /integer/i);
        });

        it("rejects partial update attempting to set min > current max", async () => {
            // User A current max is 40
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { min: 45 } }); // 45 > currentMax(40)

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /cannot exceed/i);
        });

        it("rejects partial update attempting to set max < current min", async () => {
            // User A current min is 25
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { max: 22 } }); // 22 < currentMin(25)

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /cannot exceed/i);
        });

        it("rejects invalid gender preference enum with 400 Bad Request", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ interestedIn: ["unknown_gender", "male"] });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /Invalid interestedIn/i);
        });

        it("rejects malformed update payload on updateMyProfile as well", async () => {
            const res = await request(app)
                .put("/api/v1/users/profile/me")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    datingPreferences: {
                        ageRange: { min: 55, max: 30 },
                    },
                });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /cannot exceed/i);
        });
    });

    describe("3. Authorization & Privacy Invariants", () => {
        it("rejects unauthenticated GET /discovery/preferences with 401 Unauthorized", async () => {
            const res = await request(app).get("/api/v1/discovery/preferences");
            assert.strictEqual(res.status, 401);
        });

        it("rejects unauthenticated PUT /discovery/preferences with 401 Unauthorized", async () => {
            const res = await request(app)
                .put("/api/v1/discovery/preferences")
                .send({ ageRange: { min: 20, max: 30 } });
            assert.strictEqual(res.status, 401);
        });

        it("isolates preference modifications: User A cannot affect User B's preferences", async () => {
            // User A updates preferences
            await request(app)
                .put("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ ageRange: { min: 21, max: 29 }, interestedIn: ["male"] });

            // User B's preferences remain intact
            const userBRes = await request(app)
                .get("/api/v1/discovery/preferences")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.strictEqual(userBRes.status, 200);
            assert.strictEqual(userBRes.body.datingPreferences.ageRange.min, 20);
            assert.strictEqual(userBRes.body.datingPreferences.ageRange.max, 35);
            assert.deepStrictEqual(userBRes.body.datingPreferences.interestedIn, ["female"]);
        });
    });

    describe("4. Server-Side Discovery Eligibility & Restriction Enforcement", () => {
        it("strictly enforces viewer eligibility: incomplete profile is rejected with 403 Forbidden", async () => {
            const incompleteUser = {
                _id: userIncompleteId,
                name: "Incomplete User",
                username: "incomplete_u",
                dob: new Date("1995-01-01"),
                gender: "male",
                bio: "",
                photos: [], // Missing photos
                interests: [],
                isProfileComplete: false,
                datingPreferences: { interestedIn: ["everyone"], ageRange: { min: 18, max: 50 } },
            };
            inMemoryUsers[userIncompleteId.toString()] = incompleteUser;
            const incompleteToken = makeToken({ id: userIncompleteId.toString(), username: incompleteUser.username });

            const res = await request(app)
                .get("/api/v1/discovery")
                .set("Authorization", `Bearer ${incompleteToken}`);

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.code, "PROFILE_INCOMPLETE");
        });

        it("server-side discovery query strictly excludes self, swiped, matched, and blocked IDs", async () => {
            let capturedQuery = null;
            User.countDocuments = (q) => {
                capturedQuery = q;
                return Promise.resolve(0);
            };
            User.find = (q) => {
                capturedQuery = q;
                return {
                    select: () => ({
                        sort: () => ({
                            limit: () => ({
                                skip: () => Promise.resolve([]),
                                then: (resolve) => resolve([]),
                            }),
                        }),
                    }),
                };
            };

            const swipedTargetId = new mongoose.Types.ObjectId("65cb99999999999999999999");
            const matchedTargetId = new mongoose.Types.ObjectId("65cb88888888888888888888");
            const blockedTargetId = new mongoose.Types.ObjectId("65cb77777777777777777777");

            inMemorySwipes = [{ toUser: swipedTargetId }];
            inMemoryMatches = [{ users: [userAId, matchedTargetId] }];
            inMemoryBlocked = [blockedTargetId];

            await request(app)
                .get("/api/v1/discovery")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.ok(capturedQuery);
            assert.strictEqual(capturedQuery.isProfileComplete, true);
            const excluded = capturedQuery._id.$nin.map((id) => id.toString());
            assert.ok(excluded.includes(userAId.toString()), "Self must be excluded");
            assert.ok(excluded.includes(swipedTargetId.toString()), "Swiped user must be excluded");
            assert.ok(excluded.includes(matchedTargetId.toString()), "Matched user must be excluded");
            assert.ok(excluded.includes(blockedTargetId.toString()), "Blocked user must be excluded");
        });

        it("enforces mutual gender preference compatibility in the database query", async () => {
            let capturedQuery = null;
            User.countDocuments = (q) => {
                capturedQuery = q;
                return Promise.resolve(0);
            };
            User.find = (q) => {
                capturedQuery = q;
                return {
                    select: () => ({
                        sort: () => ({
                            limit: () => ({
                                skip: () => Promise.resolve([]),
                                then: (resolve) => resolve([]),
                            }),
                        }),
                    }),
                };
            };

            // User A is female and interested in male
            await request(app)
                .get("/api/v1/discovery")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.ok(capturedQuery);
            // Candidate gender must match User A's interestedIn
            assert.deepStrictEqual(capturedQuery.gender, { $in: ["male"] });

            // Mutual match condition: Candidate must be interested in User A's gender ("female") or "everyone"
            assert.ok(capturedQuery.$and);
            const mutualCondition = capturedQuery.$and[0];
            assert.ok(mutualCondition.$or);
            const matchClause = mutualCondition.$or.find(
                (c) => c["datingPreferences.interestedIn"]?.$in
            );
            assert.ok(matchClause);
            assert.ok(matchClause["datingPreferences.interestedIn"].$in.includes("female"));
            assert.ok(matchClause["datingPreferences.interestedIn"].$in.includes("everyone"));
        });
    });

    describe("5. Discovery Stable Cursor Pagination", () => {
        it("returns nextCursor, cursor, and hasMore metadata in discovery response", async () => {
            const candidate1 = {
                _id: new mongoose.Types.ObjectId("65cbaa000000000000000003"),
                name: "Candidate 1",
                dob: new Date("1995-01-01"),
                gender: "male",
                bio: "Bio 1",
                photos: ["https://example.com/1.jpg"],
                interests: ["art"],
                isProfileComplete: true,
                createdAt: new Date("2026-01-03"),
            };
            const candidate2 = {
                _id: new mongoose.Types.ObjectId("65cbaa000000000000000002"),
                name: "Candidate 2",
                dob: new Date("1995-01-01"),
                gender: "male",
                bio: "Bio 2",
                photos: ["https://example.com/2.jpg"],
                interests: ["music"],
                isProfileComplete: true,
                createdAt: new Date("2026-01-02"),
            };

            User.countDocuments = () => Promise.resolve(2);
            User.find = () => ({
                select: () => ({
                    sort: () => ({
                        limit: () => ({
                            skip: () => Promise.resolve([candidate1, candidate2]),
                            then: (resolve) => resolve([candidate1, candidate2]),
                        }),
                    }),
                }),
            });

            const res = await request(app)
                .get("/api/v1/discovery?limit=2")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.profiles.length, 2);
            assert.strictEqual(res.body.limit, 2);
            assert.strictEqual(res.body.nextCursor, candidate2._id.toString());
            assert.strictEqual(res.body.hasMore, true);
        });

        it("applies cursor filter strictly with _id: { $lt: cursor } and prevents page drift", async () => {
            let capturedQuery = null;
            const cursorId = "65cbaa000000000000000002";

            User.countDocuments = (q) => {
                capturedQuery = q;
                return Promise.resolve(1);
            };
            User.find = (q) => {
                capturedQuery = q;
                return {
                    select: () => ({
                        sort: () => ({
                            limit: () => Promise.resolve([]),
                        }),
                    }),
                };
            };

            const res = await request(app)
                .get(`/api/v1/discovery?cursor=${cursorId}&limit=10`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 200);
            assert.ok(capturedQuery);
            assert.strictEqual(capturedQuery._id.$lt.toString(), cursorId);
        });

        it("rejects malformed cursor format with 400 Bad Request", async () => {
            const res = await request(app)
                .get("/api/v1/discovery?cursor=invalid_cursor_id")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /invalid cursor/i);
        });

        it("maintains backward compatibility: page & skip pagination supported when cursor is omitted", async () => {
            let skipCalledWith = null;

            User.countDocuments = () => Promise.resolve(20);
            User.find = () => ({
                select: () => ({
                    sort: () => ({
                        limit: () => ({
                            skip: (n) => {
                                skipCalledWith = n;
                                return Promise.resolve([]);
                            },
                        }),
                    }),
                }),
            });

            const res = await request(app)
                .get("/api/v1/discovery?page=3&limit=5")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.page, 3);
            assert.strictEqual(res.body.limit, 5);
            assert.strictEqual(skipCalledWith, 10, "Page 3 with limit 5 must skip 10");
        });
    });

    describe("6. Chat Message History Stable Pagination", () => {
        const convId = new mongoose.Types.ObjectId("65cbc0000000000000000001");
        const mockConv = {
            _id: convId,
            participants: [userAId, userBId],
        };

        beforeEach(() => {
            Conversation.findById = () => Promise.resolve(mockConv);
        });

        it("rejects malformed before parameter with 400 Bad Request", async () => {
            const res = await request(app)
                .get(`/api/v1/conversations/${convId}/messages?before=invalid_msg_id`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /invalid before message id/i);
        });

        it("returns nextBeforeCursor on initial message fetch for historical scrolling", async () => {
            const msg1 = {
                _id: new mongoose.Types.ObjectId("65cbe0000000000000000001"),
                conversation: convId,
                sender: mockUserB,
                content: "First message",
                createdAt: new Date("2026-02-01T10:00:00Z"),
            };
            const msg2 = {
                _id: new mongoose.Types.ObjectId("65cbe0000000000000000002"),
                conversation: convId,
                sender: mockUserA,
                content: "Second message",
                createdAt: new Date("2026-02-01T10:05:00Z"),
            };

            Message.countDocuments = () => Promise.resolve(2);
            Message.find = () => ({
                sort: () => ({
                    skip: () => ({
                        limit: () => ({
                            populate: () => Promise.resolve([msg2, msg1]), // Descending
                        }),
                    }),
                }),
            });

            const res = await request(app)
                .get(`/api/v1/conversations/${convId}/messages?limit=2`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.messages.length, 2);
            // Reverse of [msg2, msg1] is [msg1, msg2]
            assert.strictEqual(res.body.messages[0].content, "First message");
            assert.strictEqual(res.body.nextBeforeCursor, msg1._id.toString());
        });

        it("queries older messages strictly with compound cursor { createdAt: { $lt }, _id: { $lt } }", async () => {
            const pivotMsgId = new mongoose.Types.ObjectId("65cbe0000000000000000002");
            const pivotDate = new Date("2026-02-01T10:05:00Z");

            Message.findById = (id) => ({
                select: () => Promise.resolve({ _id: pivotMsgId, createdAt: pivotDate }),
            });

            let capturedQuery = null;
            Message.find = (q) => {
                capturedQuery = q;
                return {
                    sort: () => ({
                        limit: () => ({
                            populate: () => Promise.resolve([]),
                        }),
                    }),
                };
            };

            const res = await request(app)
                .get(`/api/v1/conversations/${convId}/messages?before=${pivotMsgId}&limit=10`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.strictEqual(res.status, 200);
            assert.ok(capturedQuery);
            assert.strictEqual(capturedQuery.conversation, convId.toString());
            assert.ok(capturedQuery.$or, "Must use compound cursor with timestamp and tie-breaker");
            assert.deepStrictEqual(capturedQuery.$or[0], { createdAt: { $lt: pivotDate } });
            assert.deepStrictEqual(capturedQuery.$or[1], { createdAt: pivotDate, _id: { $lt: pivotMsgId } });
        });
    });
});

