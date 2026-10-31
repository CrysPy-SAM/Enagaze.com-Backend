import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { MatchRequest } from "../src/models/matchRequest.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Block } from "../src/models/block.model.js";
import userRouter from "../src/routes/users.routes.js";
import { computeSearchRelevance } from "../src/controllers/userSearch.controller.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

describe("Instagram-Inspired Search and People Discovery Suite", () => {
    let server;
    let app;

    // Test Users
    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65df11111111111111111111"),
        name: "Alice Adams",
        username: "alice_a",
        dob: new Date("1996-03-15"),
        gender: "female",
        bio: "Photographer & coffee lover",
        photos: ["https://example.com/alice.jpg"],
        interests: ["photography", "coffee"],
        isProfileComplete: true,
        email: "alice@private.com",
        password: "hashed_secret_password",
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65df22222222222222222222"),
        name: "Ben Baker",
        username: "ben_baker",
        dob: new Date("1994-07-22"),
        gender: "male",
        bio: "Indie game developer and rock climber",
        photos: ["https://example.com/ben.jpg"],
        interests: ["gaming", "climbing"],
        isProfileComplete: true,
        email: "ben@private.com",
    };

    const mockUserC = {
        _id: new mongoose.Types.ObjectId("65df33333333333333333333"),
        name: "Charlie Cox",
        username: "charlie_c",
        dob: new Date("1995-10-10"),
        gender: "male",
        bio: "Photography and travel enthusiast",
        photos: ["https://example.com/charlie.jpg"],
        interests: ["travel", "photography"],
        isProfileComplete: true,
        email: "charlie@private.com",
    };

    const mockUserD = {
        _id: new mongoose.Types.ObjectId("65df44444444444444444444"),
        name: "Diana Prince",
        username: "diana_p",
        dob: new Date("1993-01-01"),
        gender: "female",
        bio: "Historian and museum curator",
        photos: ["https://example.com/diana.jpg"],
        interests: ["history", "art"],
        isProfileComplete: true,
        email: "diana@private.com",
    };

    const mockUserIncomplete = {
        _id: new mongoose.Types.ObjectId("65df55555555555555555555"),
        name: "Incomplete Ian",
        username: "ian_incomplete",
        dob: new Date("1998-05-05"),
        gender: "male",
        bio: "Just joined",
        photos: [],
        interests: [],
        isProfileComplete: false,
        email: "ian@private.com",
    };

    const mockUserBlocked = {
        _id: new mongoose.Types.ObjectId("65df66666666666666666666"),
        name: "Blocked Bob",
        username: "bob_blocked",
        dob: new Date("1992-04-04"),
        gender: "male",
        bio: "Should not appear in search",
        photos: ["https://example.com/bob.jpg"],
        interests: ["climbing"],
        isProfileComplete: true,
        email: "bob@private.com",
    };

    const allUsers = [mockUserA, mockUserB, mockUserC, mockUserD, mockUserIncomplete, mockUserBlocked];
    const userMap = {};
    for (const u of allUsers) {
        userMap[u._id.toString()] = { ...u };
    }

    const tokenA = makeToken({ id: mockUserA._id.toString(), username: mockUserA.username });

    let inMemoryRequests = [];
    let inMemoryMatches = [];
    let inMemoryConversations = [];
    let inMemoryBlockedIds = [];

    const origBlockGetBlockedUserIds = Block.getBlockedUserIds;
    const origBlockIsBlockedBidirectional = Block.isBlockedBidirectional;
    const origUserFindById = User.findById;
    const origUserFind = User.find;
    const origMatchReqFind = MatchRequest.find;
    const origMatchFind = Match.find;
    const origMatchFindOne = Match.findOne;
    const origConvFind = Conversation.find;

    before(async () => {
        app = express();
        app.use(express.json());
        app.use("/api/v1/users", userRouter);

        server = createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

        // Mock Block
        Block.getBlockedUserIds = async (userId) => {
            return inMemoryBlockedIds.map((id) => id.toString());
        };
        Block.isBlockedBidirectional = async (u1, u2) => {
            const s1 = u1?.toString();
            const s2 = u2?.toString();
            return inMemoryBlockedIds.some((id) => id.toString() === s1 || id.toString() === s2);
        };

        function createQuery(data) {
            const result = data ? { ...data } : null;
            return {
                select: () => createQuery(data),
                lean: () => Promise.resolve(result),
                populate: () => createQuery(data),
                then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
            };
        }

        // Mock User
        User.findById = (id) => {
            const found = userMap[id?.toString()];
            return createQuery(found);
        };

        User.find = (query) => {
            let filtered = allUsers.filter((u) => {
                if (query.isProfileComplete !== undefined && u.isProfileComplete !== query.isProfileComplete) {
                    return false;
                }
                if (query._id?.$nin) {
                    const ninStrings = query._id.$nin.map((id) => id.toString());
                    if (ninStrings.includes(u._id.toString())) {
                        return false;
                    }
                }
                if (query.$or) {
                    const matchesAny = query.$or.some((clause) => {
                        if (clause.username?.$regex && clause.username.$regex.test(u.username)) return true;
                        if (clause.name?.$regex && clause.name.$regex.test(u.name)) return true;
                        if (clause.bio?.$regex && clause.bio.$regex.test(u.bio)) return true;
                        if (clause.interests?.$regex && Array.isArray(u.interests) && u.interests.some((i) => clause.interests.$regex.test(i))) return true;
                        return false;
                    });
                    if (!matchesAny) return false;
                }
                return true;
            });

            const arrayResult = filtered.map((u) => ({ ...u }));
            return {
                select: () => ({
                    lean: () => Promise.resolve(arrayResult),
                    then: (resolve, reject) => Promise.resolve(arrayResult).then(resolve, reject),
                }),
                lean: () => Promise.resolve(arrayResult),
                then: (resolve, reject) => Promise.resolve(arrayResult).then(resolve, reject),
            };
        };

        // Mock Match
        Match.find = (query) => {
            let results = [...inMemoryMatches];
            if (query.userPair?.$in) {
                results = results.filter((m) => query.userPair.$in.includes(m.userPair));
            }
            if (query.status) {
                results = results.filter((m) => m.status === query.status);
            }
            return {
                lean: () => Promise.resolve(results.map((r) => ({ ...r }))),
            };
        };

        Match.findOne = (query) => {
            let found = inMemoryMatches.find((m) => {
                if (query.userPair && m.userPair !== query.userPair) return false;
                if (query.status && m.status !== query.status) return false;
                return true;
            });
            return {
                lean: () => Promise.resolve(found ? { ...found } : null),
            };
        };

        // Mock MatchRequest
        MatchRequest.find = (query) => {
            let results = [...inMemoryRequests];
            if (query.$or) {
                results = results.filter((r) => {
                    return query.$or.some((clause) => {
                        let sMatch = true;
                        if (clause.sender?.$in) {
                            sMatch = clause.sender.$in.map((id) => id.toString()).includes(r.sender.toString());
                        } else if (clause.sender) {
                            sMatch = r.sender.toString() === clause.sender.toString();
                        }
                        let rMatch = true;
                        if (clause.recipient?.$in) {
                            rMatch = clause.recipient.$in.map((id) => id.toString()).includes(r.recipient.toString());
                        } else if (clause.recipient) {
                            rMatch = r.recipient.toString() === clause.recipient.toString();
                        }
                        const statusMatch = clause.status ? r.status === clause.status : true;
                        return sMatch && rMatch && statusMatch;
                    });
                });
            }
            return {
                lean: () => Promise.resolve(results.map((r) => ({ ...r }))),
            };
        };

        MatchRequest.findOne = (query) => {
            let found = inMemoryRequests.find((r) => {
                if (query.$or) {
                    return query.$or.some((clause) => {
                        const sMatch = clause.sender ? r.sender.toString() === clause.sender.toString() : true;
                        const rMatch = clause.recipient ? r.recipient.toString() === clause.recipient.toString() : true;
                        const statusMatch = clause.status ? r.status === clause.status : true;
                        return sMatch && rMatch && statusMatch;
                    });
                }
                return true;
            });
            return {
                lean: () => Promise.resolve(found ? { ...found } : null),
            };
        };

        // Mock Conversation
        Conversation.find = (query) => {
            let results = [...inMemoryConversations];
            if (query.match?.$in) {
                results = results.filter((c) => query.match.$in.map((id) => id.toString()).includes(c.match.toString()));
            }
            return {
                select: () => ({
                    lean: () => Promise.resolve(results.map((r) => ({ ...r }))),
                }),
                lean: () => Promise.resolve(results.map((r) => ({ ...r }))),
            };
        };

        Conversation.findOne = (query) => {
            let found = inMemoryConversations.find((c) => {
                if (query.match && c.match.toString() !== query.match.toString()) return false;
                return true;
            });
            return {
                select: () => ({
                    lean: () => Promise.resolve(found ? { ...found } : null),
                }),
                lean: () => Promise.resolve(found ? { ...found } : null),
            };
        };
    });

    after(async () => {
        Block.getBlockedUserIds = origBlockGetBlockedUserIds;
        Block.isBlockedBidirectional = origBlockIsBlockedBidirectional;
        User.findById = origUserFindById;
        User.find = origUserFind;
        MatchRequest.find = origMatchReqFind;
        Match.find = origMatchFind;
        Match.findOne = origMatchFindOne;
        Conversation.find = origConvFind;

        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        inMemoryRequests = [];
        inMemoryMatches = [];
        inMemoryConversations = [];
        inMemoryBlockedIds = [];
    });

    describe("1. Search Query Matching & Case-Insensitivity", () => {
        it("finds users by exact username match", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=ben_baker")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.users.length, 1);
            assert.equal(res.body.users[0].username, "ben_baker");
            assert.equal(res.body.users[0].name, "Ben Baker");
        });

        it("finds users by partial / prefix username with case-insensitivity", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=BEN")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.ok(res.body.users.some((u) => u.username === "ben_baker"));
        });

        it("finds users by display name partial match", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=Charlie")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.ok(res.body.users.some((u) => u.name === "Charlie Cox"));
        });

        it("finds users by interests", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=climbing")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.ok(res.body.users.some((u) => u.username === "ben_baker"));
        });

        it("finds users by bio keywords", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=curator")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.users.length, 1);
            assert.equal(res.body.users[0].username, "diana_p");
        });
    });

    describe("2. Relevance Ranking Engine", () => {
        it("ranks exact username match higher than bio or interest partial matches", async () => {
            const userExact = { username: "travel", name: "Bob", bio: "hello", interests: [] };
            const userPartial = { username: "alex", name: "Alex", bio: "loves to travel", interests: ["travel"] };

            const scoreExact = computeSearchRelevance(userExact, "travel");
            const scorePartial = computeSearchRelevance(userPartial, "travel");

            assert.ok(scoreExact > scorePartial, `Exact score (${scoreExact}) should be greater than partial score (${scorePartial})`);
        });

        it("ranks username prefix match higher than name substring match", () => {
            const userPrefix = { username: "charles_99", name: "Chuck", bio: "", interests: [] };
            const userSubstring = { username: "richard", name: "Sir Charles", bio: "", interests: [] };

            const scorePrefix = computeSearchRelevance(userPrefix, "charles");
            const scoreSubstring = computeSearchRelevance(userSubstring, "charles");

            assert.ok(scorePrefix > scoreSubstring);
        });
    });

    describe("3. Empty State, Pagination & Bounds", () => {
        it("returns empty results array when search query is blank without error", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=   ")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.users, []);
            assert.equal(res.body.pagination.total, 0);
            assert.equal(res.body.pagination.hasMore, false);
        });

        it("returns empty array when no users match query", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=nonexistent_xyz_999")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.users, []);
            assert.equal(res.body.pagination.total, 0);
        });

        it("handles pagination limit and page parameters correctly", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=a&page=1&limit=1")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.users.length, 1);
            assert.equal(res.body.pagination.page, 1);
            assert.equal(res.body.pagination.limit, 1);
            assert.ok(res.body.pagination.total >= 1);
        });
    });

    describe("4. Privacy & Sensitive Field Sanitization", () => {
        it("never leaks password, email, phone, exact DOB, googleId, or token in search results", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=ben")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.ok(res.body.users.length > 0);
            for (const user of res.body.users) {
                assert.equal(user.password, undefined);
                assert.equal(user.email, undefined);
                assert.equal(user.phone, undefined);
                assert.equal(user.dob, undefined); // age is provided, exact dob never leaked
                assert.equal(user.googleId, undefined);
                assert.equal(user.token, undefined);
                assert.equal(user.datingPreferences, undefined);
                assert.ok(typeof user.age === "number" || user.age === null);
                assert.ok(typeof user.username === "string");
                assert.ok(typeof user.name === "string");
            }
        });
    });

    describe("5. Self, Incomplete & Blocked User Exclusion", () => {
        it("excludes the searching user themselves from search results", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=alice")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.ok(!res.body.users.some((u) => u._id === mockUserA._id.toString()));
        });

        it("excludes incomplete profiles from search results", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=incomplete")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.ok(!res.body.users.some((u) => u.username === "ian_incomplete"));
        });

        it("excludes blocked users from search results bidirectionally", async () => {
            inMemoryBlockedIds = [mockUserBlocked._id];

            const res = await request(app)
                .get("/api/v1/users/search?q=bob")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.ok(!res.body.users.some((u) => u.username === "bob_blocked"));
        });
    });

    describe("6. Relationship State Resolution", () => {
        it("resolves relationship as 'none' when no match or pending request exists", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=diana")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            const diana = res.body.users.find((u) => u.username === "diana_p");
            assert.ok(diana);
            assert.equal(diana.relationship, "none");
            assert.equal(diana.requestId, null);
            assert.equal(diana.conversationId, null);
        });

        it("resolves relationship as 'outgoing_request' when current user has a pending request to target", async () => {
            const mockReqId = new mongoose.Types.ObjectId("65df99999999999999999999");
            inMemoryRequests.push({
                _id: mockReqId,
                sender: mockUserA._id,
                recipient: mockUserB._id,
                status: "pending",
            });

            const res = await request(app)
                .get("/api/v1/users/search?q=ben")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            const ben = res.body.users.find((u) => u.username === "ben_baker");
            assert.ok(ben);
            assert.equal(ben.relationship, "outgoing_request");
            assert.equal(ben.requestId, mockReqId.toString());
        });

        it("resolves relationship as 'incoming_request' when target user sent a pending request to current user", async () => {
            const mockReqId = new mongoose.Types.ObjectId("65df88888888888888888888");
            inMemoryRequests.push({
                _id: mockReqId,
                sender: mockUserC._id,
                recipient: mockUserA._id,
                status: "pending",
            });

            const res = await request(app)
                .get("/api/v1/users/search?q=charlie")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            const charlie = res.body.users.find((u) => u.username === "charlie_c");
            assert.ok(charlie);
            assert.equal(charlie.relationship, "incoming_request");
            assert.equal(charlie.requestId, mockReqId.toString());
        });

        it("resolves relationship as 'connected' and returns conversationId when an active match exists", async () => {
            const canonicalPair = Match.getCanonicalPair(mockUserA._id, mockUserB._id);
            const mockMatchId = new mongoose.Types.ObjectId("65df77777777777777777777");
            const mockConvId = new mongoose.Types.ObjectId("65df66666666666666666666");

            inMemoryMatches.push({
                _id: mockMatchId,
                userPair: canonicalPair,
                status: "active",
            });
            inMemoryConversations.push({
                _id: mockConvId,
                match: mockMatchId,
            });

            const res = await request(app)
                .get("/api/v1/users/search?q=ben")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            const ben = res.body.users.find((u) => u.username === "ben_baker");
            assert.ok(ben);
            assert.equal(ben.relationship, "connected");
            assert.equal(ben.conversationId, mockConvId.toString());
        });
    });

    describe("7. ReDoS & Regex Injection Resilience", () => {
        it("escapes regex meta-characters without crashing or timing out", async () => {
            const dangerousQueries = [
                "alex+*",
                "(a|b|c)*",
                "test.*",
                "[[[[[",
                "a{1000}",
                "\\\\\\\\",
            ];

            for (const q of dangerousQueries) {
                const res = await request(app)
                    .get(`/api/v1/users/search?q=${encodeURIComponent(q)}`)
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                assert.equal(res.body.success, true);
                assert.ok(Array.isArray(res.body.users));
            }
        });
    });

    describe("8. Public User Profile Endpoint", () => {
        it("returns sanitized public profile for a valid user ID", async () => {
            const res = await request(app)
                .get(`/api/v1/users/profile/public/${mockUserB._id}`)
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.profile.username, "ben_baker");
            assert.equal(res.body.profile.name, "Ben Baker");
            assert.equal(res.body.profile.email, undefined);
            assert.equal(res.body.profile.password, undefined);
            assert.equal(res.body.profile.relationship, "none");
        });

        it("returns 404 if target user is blocked", async () => {
            inMemoryBlockedIds = [mockUserBlocked._id];

            await request(app)
                .get(`/api/v1/users/profile/public/${mockUserBlocked._id}`)
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(404);
        });

        it("returns 400 for invalid ObjectId format", async () => {
            await request(app)
                .get("/api/v1/users/profile/public/not-a-valid-id")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(400);
        });

        it("returns relationship: 'self' when requesting own profile", async () => {
            const res = await request(app)
                .get(`/api/v1/users/profile/public/${mockUserA._id}`)
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.profile.relationship, "self");
        });
    });

    describe("9. Authentication Enforcement", () => {
        it("rejects search requests without auth token with 401", async () => {
            await request(app)
                .get("/api/v1/users/search?q=ben")
                .expect(401);
        });

        it("rejects public profile requests without auth token with 401", async () => {
            await request(app)
                .get(`/api/v1/users/profile/public/${mockUserB._id}`)
                .expect(401);
        });
    });

    describe("10. Phase 2F.2: Bounded Memory, Cursor Streaming & Deterministic Ranking Suite", () => {
        it("handles large candidate sets (1,000+ records) and returns exact top-K relevance ranking and exact total", async () => {
            const originalUserFind = User.find;
            const LARGE_COUNT = 1000;
            const syntheticUsers = [];

            // Seed 1,000 synthetic candidates:
            // - 10 exact username matches: "test_dev" (score 100)
            // - 20 username prefix matches: "test_dev_prefix_..." (score 70)
            // - 30 display name prefix matches: "Test Developer ..." (score 50)
            // - 940 bio keyword matches: bio contains "test_dev" (score 10)
            for (let i = 1; i <= LARGE_COUNT; i++) {
                let username;
                let name;
                let bio = "Casual user";

                if (i <= 10) {
                    username = "test_dev";
                    name = `Exact Dev ${String(i).padStart(3, "0")}`;
                } else if (i <= 30) {
                    username = `test_dev_prefix_${String(i).padStart(3, "0")}`;
                    name = `Prefix User ${String(i).padStart(3, "0")}`;
                } else if (i <= 60) {
                    username = `user_${String(i).padStart(4, "0")}`;
                    name = `Test_Dev User ${String(i).padStart(3, "0")}`;
                } else {
                    username = `unrelated_${String(i).padStart(4, "0")}`;
                    name = `Regular User ${String(i).padStart(3, "0")}`;
                    bio = `Experienced test_dev engineer and programmer`;
                }

                syntheticUsers.push({
                    _id: new mongoose.Types.ObjectId(`65df00000000000000${String(i).padStart(6, "0")}`),
                    name,
                    username,
                    dob: new Date("1995-01-01"),
                    gender: "male",
                    bio,
                    photos: [`https://example.com/photo_${i}.jpg`],
                    interests: ["coding"],
                    isProfileComplete: true,
                });
            }

            try {
                User.find = () => ({
                    select: () => ({
                        lean: () => Promise.resolve(syntheticUsers),
                    }),
                });

                // Request page 1 with limit 20
                const res1 = await request(app)
                    .get("/api/v1/users/search?q=test_dev&page=1&limit=20")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                assert.equal(res1.body.success, true);
                assert.equal(res1.body.users.length, 20);
                assert.equal(res1.body.pagination.total, 1000, "Exact total must be 1,000 matching users");
                assert.equal(res1.body.pagination.page, 1);
                assert.equal(res1.body.pagination.limit, 20);
                assert.equal(res1.body.pagination.hasMore, true);

                // Top 10 must be the exact username matches (score 100)
                for (let i = 0; i < 10; i++) {
                    assert.equal(res1.body.users[i].username, "test_dev");
                }
                // Next 10 (indices 10..19) must be prefix matches (score 70)
                for (let i = 10; i < 20; i++) {
                    assert.ok(res1.body.users[i].username.startsWith("test_dev_prefix_"));
                }

                // Request page 2 with limit 20
                const res2 = await request(app)
                    .get("/api/v1/users/search?q=test_dev&page=2&limit=20")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                assert.equal(res2.body.users.length, 20);
                assert.equal(res2.body.pagination.page, 2);
                assert.equal(res2.body.pagination.total, 1000);
                assert.equal(res2.body.pagination.hasMore, true);

                // Page 2 should have the remaining 10 prefix matches (indices 0..9)
                for (let i = 0; i < 10; i++) {
                    assert.ok(res2.body.users[i].username.startsWith("test_dev_prefix_"));
                }
                // And the first 10 display name prefix matches (indices 10..19)
                for (let i = 10; i < 20; i++) {
                    assert.ok(res2.body.users[i].name.startsWith("Test_Dev User"));
                }

                // Verify zero overlap between page 1 and page 2
                const page1Ids = new Set(res1.body.users.map((u) => u._id));
                for (const u of res2.body.users) {
                    assert.ok(!page1Ids.has(u._id), `User ${u._id} must not appear on both page 1 and page 2`);
                }
            } finally {
                User.find = originalUserFind;
            }
        });

        it("preserves deterministic tie-breaking using user ID when relevance scores and display names are identical", async () => {
            const originalUserFind = User.find;
            const tiedUsers = [];

            for (let i = 1; i <= 30; i++) {
                tiedUsers.push({
                    _id: new mongoose.Types.ObjectId(`65df00000000000000${String(i).padStart(6, "0")}`),
                    name: "Identical Name",
                    username: `identical_user_${String(i).padStart(3, "0")}`,
                    dob: new Date("1995-01-01"),
                    gender: "male",
                    bio: "Identical Bio",
                    photos: [],
                    interests: ["music"],
                    isProfileComplete: true,
                });
            }

            try {
                User.find = () => ({
                    select: () => ({
                        lean: () => Promise.resolve(tiedUsers),
                    }),
                });

                const res1 = await request(app)
                    .get("/api/v1/users/search?q=identical&page=1&limit=20")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                const res2 = await request(app)
                    .get("/api/v1/users/search?q=identical&page=2&limit=20")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                assert.equal(res1.body.users.length, 20);
                assert.equal(res2.body.users.length, 10);
                assert.equal(res2.body.pagination.hasMore, false);

                // Zero duplicate IDs across consecutive pages
                const p1Ids = new Set(res1.body.users.map((u) => u._id));
                for (const u of res2.body.users) {
                    assert.ok(!p1Ids.has(u._id), "Deterministic tie-breaking must prevent overlaps across pages");
                }
            } finally {
                User.find = originalUserFind;
            }
        });

        it("safely streams candidates using MongoDB cursor and ensures cursor.close() is called on completion", async () => {
            const originalUserFind = User.find;
            let cursorClosed = false;

            const cursorUsers = [
                {
                    _id: new mongoose.Types.ObjectId("65df00000000000000000001"),
                    name: "Streamed User 1",
                    username: "stream_one",
                    dob: new Date("1995-01-01"),
                    gender: "female",
                    bio: "streaming tester",
                    photos: [],
                    interests: [],
                    isProfileComplete: true,
                },
                {
                    _id: new mongoose.Types.ObjectId("65df00000000000000000002"),
                    name: "Streamed User 2",
                    username: "stream_two",
                    dob: new Date("1996-01-01"),
                    gender: "male",
                    bio: "streaming tester",
                    photos: [],
                    interests: [],
                    isProfileComplete: true,
                },
            ];

            try {
                User.find = () => ({
                    select: () => ({
                        lean: () => ({
                            cursor: () => ({
                                async *[Symbol.asyncIterator]() {
                                    for (const u of cursorUsers) {
                                        yield u;
                                    }
                                },
                                close: async () => {
                                    cursorClosed = true;
                                },
                            }),
                        }),
                    }),
                });

                const res = await request(app)
                    .get("/api/v1/users/search?q=stream&page=1&limit=20")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                assert.equal(res.body.success, true);
                assert.equal(res.body.users.length, 2);
                assert.equal(res.body.pagination.total, 2);
                assert.equal(cursorClosed, true, "cursor.close() must be invoked on stream completion");
            } finally {
                User.find = originalUserFind;
            }
        });

        it("ensures cursor.close() is called in finally block even when processing throws a database error", async () => {
            const originalUserFind = User.find;
            let cursorClosed = false;

            try {
                User.find = () => ({
                    select: () => ({
                        lean: () => ({
                            cursor: () => ({
                                async *[Symbol.asyncIterator]() {
                                    yield { _id: new mongoose.Types.ObjectId(), name: "First" };
                                    throw new Error("Simulated MongoDB stream read error");
                                },
                                close: async () => {
                                    cursorClosed = true;
                                },
                            }),
                        }),
                    }),
                });

                const res = await request(app)
                    .get("/api/v1/users/search?q=errortest")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(500);

                assert.equal(res.body.success, false);
                assert.equal(res.body.message, "Failed to search users. Please try again.");
                assert.equal(cursorClosed, true, "cursor.close() must be called in finally block during errors");
            } finally {
                User.find = originalUserFind;
            }
        });

        it("sanitizes control characters and null bytes safely without crashing", async () => {
            const res = await request(app)
                .get("/api/v1/users/search?q=%00%08%00")
                .set("Authorization", `Bearer ${tokenA}`)
                .expect(200);

            assert.equal(res.body.success, true);
            assert.equal(res.body.users.length, 0);
            assert.equal(res.body.pagination.total, 0);
        });

        it("measures synthetic benchmark on 1,000 candidate records and logs runtime and memory metrics", async () => {
            const originalUserFind = User.find;
            const BENCHMARK_COUNT = 1000;
            const benchmarkUsers = [];

            for (let i = 1; i <= BENCHMARK_COUNT; i++) {
                benchmarkUsers.push({
                    _id: new mongoose.Types.ObjectId(`65df00000000000000${String(i).padStart(6, "0")}`),
                    name: `Benchmarker ${i}`,
                    username: `bench_user_${i}`,
                    dob: new Date("1995-01-01"),
                    gender: "male",
                    bio: `Bio description with benchmark_term keyword for user ${i}`,
                    photos: [`https://example.com/p_${i}.jpg`],
                    interests: ["benchmarking", "testing"],
                    isProfileComplete: true,
                });
            }

            try {
                User.find = () => ({
                    select: () => ({
                        lean: () => Promise.resolve(benchmarkUsers),
                    }),
                });

                if (global.gc) {
                    global.gc();
                }
                const heapBefore = process.memoryUsage().heapUsed;
                const startTime = performance.now();

                const res = await request(app)
                    .get("/api/v1/users/search?q=benchmark_term&page=1&limit=20")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .expect(200);

                const endTime = performance.now();
                const heapAfter = process.memoryUsage().heapUsed;
                const durationMs = Math.round(endTime - startTime);
                const heapDeltaKb = Math.round((heapAfter - heapBefore) / 1024);

                assert.equal(res.body.success, true);
                assert.equal(res.body.users.length, 20);
                assert.equal(res.body.pagination.total, 1000);

                console.log(`[Phase2F2-Benchmark] datasetSize=${BENCHMARK_COUNT} returnedPage=20 runtimeMs=${durationMs} heapDeltaKb=${heapDeltaKb}`);
            } finally {
                User.find = originalUserFind;
            }
        });
    });
});
