import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";

import { getLikesYou } from "../src/controllers/discovery.controller.js";
import { User } from "../src/models/user.model.js";
import { Swipe } from "../src/models/swipe.model.js";
import { Match } from "../src/models/match.model.js";
import { Block } from "../src/models/block.model.js";

describe("Phase 2F.1: Bounded Incoming Likes Query & Database Pagination Suite", () => {
    let app;
    const currentUserId = new mongoose.Types.ObjectId("65ce00000000000000000099");
    const mockCurrentUser = {
        _id: currentUserId,
        name: "Test Receiver",
        username: "receiver",
        dob: new Date("1995-01-01"),
        gender: "male",
        bio: "Test receiver bio",
        photos: ["https://example.com/receiver.jpg"],
        isProfileComplete: true,
    };

    // Helper to generate mock users and swipes
    const generateCandidate = (idNum, { isProfileComplete = true } = {}) => {
        const id = new mongoose.Types.ObjectId(`65ce000000000000000000${String(idNum).padStart(2, "0")}`);
        return {
            user: {
                _id: id,
                name: `Candidate ${idNum}`,
                username: `candidate_${idNum}`,
                dob: new Date("1998-05-10"),
                gender: "female",
                bio: `Bio for candidate ${idNum}`,
                photos: [`https://example.com/photo${idNum}.jpg`],
                interests: ["music", "hiking"],
                isProfileComplete,
            },
            swipe: {
                _id: new mongoose.Types.ObjectId(`65cf000000000000000000${String(idNum).padStart(2, "0")}`),
                fromUser: id,
                toUser: currentUserId,
                action: "like",
                createdAt: new Date(Date.now() - idNum * 60000), // idNum 1 is newest
            },
        };
    };

    let mockSwipes = [];
    let mockUsers = new Map();
    let mockBlockedIds = [];
    let mockMySwipes = [];
    let mockMatches = [];
    let capturedSwipeFindCalls = [];

    beforeEach(() => {
        mockSwipes = [];
        mockUsers = new Map();
        mockBlockedIds = [];
        mockMySwipes = [];
        mockMatches = [];
        capturedSwipeFindCalls = [];

        app = express();
        app.use(express.json());

        // Attach mock authenticated eligible user
        app.use((req, res, next) => {
            req.user = { ...mockCurrentUser };
            next();
        });

        app.get("/api/v1/discovery/likes-you", getLikesYou);

        // Mock Swipe methods
        Swipe.find = (filter = {}) => {
            const callRecord = { filter, sortArgs: null, skipArgs: null, limitArgs: null, selectArgs: null };
            capturedSwipeFindCalls.push(callRecord);

            const queryObj = {
                sort: (s) => {
                    callRecord.sortArgs = s;
                    return queryObj;
                },
                skip: (sk) => {
                    callRecord.skipArgs = sk;
                    return queryObj;
                },
                limit: (lim) => {
                    callRecord.limitArgs = lim;
                    return queryObj;
                },
                select: (sel) => {
                    callRecord.selectArgs = sel;
                    return queryObj;
                },
                then: (resolve) => {
                    let results = [...mockSwipes];

                    if (filter.fromUser) {
                        results = mockMySwipes;
                    } else if (filter.toUser) {
                        results = results.filter((s) => s.toUser.toString() === filter.toUser.toString());
                        if (filter.action) {
                            results = results.filter((s) => s.action === filter.action);
                        }
                    }

                    // Sort
                    if (callRecord.sortArgs?.createdAt === -1) {
                        results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                    }

                    // Apply skip & limit if chained
                    const skip = callRecord.skipArgs || 0;
                    const limit = callRecord.limitArgs !== null ? callRecord.limitArgs : results.length;
                    const sliced = results.slice(skip, skip + limit);

                    resolve(sliced);
                },
            };
            return queryObj;
        };

        Swipe.countDocuments = async (filter = {}) => {
            let results = [...mockSwipes];
            if (filter.toUser) {
                results = results.filter((s) => s.toUser.toString() === filter.toUser.toString());
                if (filter.action) {
                    results = results.filter((s) => s.action === filter.action);
                }
            }
            return results.length;
        };

        // Mock Match.find
        Match.find = () => ({
            select: () => Promise.resolve(mockMatches),
            then: (resolve) => resolve(mockMatches),
        });

        // Mock Block.getBlockedUserIds
        Block.getBlockedUserIds = async () => mockBlockedIds;

        // Mock User.find
        User.find = (filter = {}) => ({
            select: () => ({
                then: (resolve) => {
                    let list = Array.from(mockUsers.values());
                    if (filter._id?.$in) {
                        const idSet = new Set(filter._id.$in.map((i) => i.toString()));
                        list = list.filter((u) => idSet.has(u._id.toString()));
                    }
                    if (filter.isProfileComplete !== undefined) {
                        list = list.filter((u) => u.isProfileComplete === filter.isProfileComplete);
                    }
                    resolve(list);
                },
            }),
            then: (resolve) => resolve(Array.from(mockUsers.values())),
        });
    });

    describe("1. Input Sanitization & Default Pagination", () => {
        it("uses default page = 1 and limit = 20 when parameters are omitted", async () => {
            // Seed 25 candidates
            for (let i = 1; i <= 25; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.pagination.page, 1);
            assert.strictEqual(res.body.pagination.limit, 20);
            assert.strictEqual(res.body.pagination.total, 25);
            assert.strictEqual(res.body.pagination.totalPages, 2);
            assert.strictEqual(res.body.profiles.length, 20);
        });

        it("sanitizes invalid and excessive limit inputs", async () => {
            for (let i = 1; i <= 5; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Case A: Excessive limit (150) capped at 50
            const resExcess = await request(app).get("/api/v1/discovery/likes-you?limit=150");
            assert.strictEqual(resExcess.status, 200);
            assert.strictEqual(resExcess.body.pagination.limit, 50);

            // Case B: Negative limit defaults to 20
            const resNeg = await request(app).get("/api/v1/discovery/likes-you?limit=-5");
            assert.strictEqual(resNeg.status, 200);
            assert.strictEqual(resNeg.body.pagination.limit, 20);

            // Case C: Non-numeric limit defaults to 20
            const resAlpha = await request(app).get("/api/v1/discovery/likes-you?limit=invalid");
            assert.strictEqual(resAlpha.status, 200);
            assert.strictEqual(resAlpha.body.pagination.limit, 20);

            // Case D: Negative page defaults to 1
            const resNegPage = await request(app).get("/api/v1/discovery/likes-you?page=-10");
            assert.strictEqual(resNegPage.status, 200);
            assert.strictEqual(resNegPage.body.pagination.page, 1);
        });
    });

    describe("2. Database Query Bounding & Deterministic Sorting", () => {
        it("applies bounded limit and skip in database queries instead of loading entire collection", async () => {
            // Seed 50 candidates
            for (let i = 1; i <= 50; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=10");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 10);

            // Verify that Swipe.find was called with a bounded limit, not unbounded
            const incomingQueryCalls = capturedSwipeFindCalls.filter((c) => c.filter?.toUser);
            assert.ok(incomingQueryCalls.length > 0, "Must execute bounded query on Swipe");

            for (const call of incomingQueryCalls) {
                assert.ok(call.limitArgs !== null, "Query must have an explicit limit argument");
                assert.ok(call.limitArgs <= 100, `Batch limit (${call.limitArgs}) must be bounded`);
            }
        });

        it("enforces deterministic sorting with createdAt: -1 and _id: -1 tie-breaker", async () => {
            const { user, swipe } = generateCandidate(1);
            mockUsers.set(user._id.toString(), user);
            mockSwipes.push(swipe);

            const res = await request(app).get("/api/v1/discovery/likes-you");
            assert.strictEqual(res.status, 200);

            const incomingCall = capturedSwipeFindCalls.find((c) => c.filter?.toUser);
            assert.ok(incomingCall, "Must execute query on incoming likes");
            assert.deepStrictEqual(incomingCall.sortArgs, { createdAt: -1, _id: -1 });
        });
    });

    describe("3. Privacy, Blocking, Matching & Eligibility Enforcement", () => {
        it("excludes users who are already matched, swiped, or blocked", async () => {
            const c1 = generateCandidate(1); // Normal candidate
            const c2 = generateCandidate(2); // Blocked candidate
            const c3 = generateCandidate(3); // Already swiped by currentUser
            const c4 = generateCandidate(4); // Already matched with currentUser

            for (const c of [c1, c2, c3, c4]) {
                mockUsers.set(c.user._id.toString(), c.user);
                mockSwipes.push(c.swipe);
            }

            mockBlockedIds = [c2.user._id];
            mockMySwipes = [{ toUser: c3.user._id }];
            mockMatches = [{ users: [currentUserId, c4.user._id] }];

            const res = await request(app).get("/api/v1/discovery/likes-you");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 1);
            assert.strictEqual(res.body.profiles[0]._id, c1.user._id.toString());
        });

        it("excludes candidates with incomplete profiles", async () => {
            const c1 = generateCandidate(1, { isProfileComplete: true });
            const c2 = generateCandidate(2, { isProfileComplete: false }); // Incomplete

            mockUsers.set(c1.user._id.toString(), c1.user);
            mockUsers.set(c2.user._id.toString(), c2.user);
            mockSwipes.push(c1.swipe, c2.swipe);

            const res = await request(app).get("/api/v1/discovery/likes-you");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 1);
            assert.strictEqual(res.body.profiles[0]._id, c1.user._id.toString());
        });

        it("fills the requested page even when some candidates in the batch are filtered out", async () => {
            // Seed 15 candidates: odd IDs are complete, even IDs are incomplete
            for (let i = 1; i <= 15; i++) {
                const isComplete = i % 2 !== 0; // 8 complete, 7 incomplete
                const { user, swipe } = generateCandidate(i, { isProfileComplete: isComplete });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Request limit = 5 on page 1
            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=5");

            assert.strictEqual(res.status, 200);
            // Must return full 5 complete profiles despite incomplete profiles being interspersed
            assert.strictEqual(res.body.profiles.length, 5);
            assert.ok(res.body.profiles.every((p) => p.isProfileComplete === true));
        });
    });

    describe("4. Pagination Metadata & Boundary Conditions", () => {
        it("returns empty array when no incoming likes exist", async () => {
            const res = await request(app).get("/api/v1/discovery/likes-you");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 0);
            assert.strictEqual(res.body.pagination.total, 0);
            assert.strictEqual(res.body.pagination.totalPages, 1);
        });

        it("returns empty array and correct metadata when page exceeds available candidates", async () => {
            for (let i = 1; i <= 5; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you?page=10&limit=10");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 0);
            assert.strictEqual(res.body.pagination.page, 10);
            assert.strictEqual(res.body.pagination.total, 5);
        });

        it("correctly handles partial last page", async () => {
            for (let i = 1; i <= 25; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Page 2 with limit 20 should have 5 items
            const res = await request(app).get("/api/v1/discovery/likes-you?page=2&limit=20");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 5);
            assert.strictEqual(res.body.pagination.page, 2);
            assert.strictEqual(res.body.pagination.total, 25);
            assert.strictEqual(res.body.pagination.totalPages, 2);
        });

        it("deduplicates multiple likes from the same sender", async () => {
            const c1 = generateCandidate(1);
            mockUsers.set(c1.user._id.toString(), c1.user);

            // Add duplicate swipe from same sender with different timestamp
            const duplicateSwipe = {
                _id: new mongoose.Types.ObjectId(),
                fromUser: c1.user._id,
                toUser: currentUserId,
                action: "like",
                createdAt: new Date(Date.now() - 100000),
            };

            mockSwipes.push(c1.swipe, duplicateSwipe);

            const res = await request(app).get("/api/v1/discovery/likes-you");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 1, "Duplicate likes from same user must be deduplicated");
        });

        it("handles database errors safely and returns 500 without leaking secrets", async () => {
            Swipe.find = () => {
                throw new Error("Simulated database read timeout");
            };

            const res = await request(app).get("/api/v1/discovery/likes-you");

            assert.strictEqual(res.status, 500);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.message, "Failed to retrieve likes");
        });
    });
});
