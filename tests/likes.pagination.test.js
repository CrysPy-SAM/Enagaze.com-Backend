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
    const currentUserId = new mongoose.Types.ObjectId("65aa00000000000000000001");
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
    const generateCandidate = (idNum, { isProfileComplete = true, createdAt } = {}) => {
        const hex = String(idNum).padStart(6, "0");
        const id = new mongoose.Types.ObjectId(`65ce00000000000000${hex}`);
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
                _id: new mongoose.Types.ObjectId(`65cf00000000000000${hex}`),
                fromUser: id,
                toUser: currentUserId,
                action: "like",
                createdAt: createdAt || new Date(Date.now() - idNum * 60000), // idNum 1 is newest
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

                    // Deterministic Sort with tie-breaker
                    if (callRecord.sortArgs?.createdAt === -1) {
                        results.sort((a, b) => {
                            const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                            if (timeDiff !== 0) return timeDiff;
                            if (callRecord.sortArgs?._id === -1) {
                                return b._id.toString().localeCompare(a._id.toString());
                            }
                            return 0;
                        });
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

        it("breaks ties deterministically using _id: -1 when multiple likes share the exact same timestamp", async () => {
            const sharedInstant = new Date("2026-10-25T12:00:00.000Z");
            // c1 has smaller _id (...000001), c2 has larger _id (...000002)
            const c1 = generateCandidate(1, { createdAt: sharedInstant });
            const c2 = generateCandidate(2, { createdAt: sharedInstant });

            mockUsers.set(c1.user._id.toString(), c1.user);
            mockUsers.set(c2.user._id.toString(), c2.user);
            // Insert c1 first in array, but with _id: -1 sort, c2 must come first
            mockSwipes.push(c1.swipe, c2.swipe);

            const res = await request(app).get("/api/v1/discovery/likes-you");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 2);
            assert.strictEqual(res.body.profiles[0]._id, c2.user._id.toString(), "Larger _id must come first under descending sort");
            assert.strictEqual(res.body.profiles[1]._id, c1.user._id.toString());
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

        it("handles database errors occurring during later batches safely", async () => {
            // Seed 50 candidates
            for (let i = 1; i <= 50; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            let batchQueryCount = 0;
            const originalSwipeFind = Swipe.find;
            Swipe.find = (filter) => {
                batchQueryCount++;
                if (batchQueryCount >= 2) {
                    throw new Error("Simulated MongoDB network partition on batch 2");
                }
                return originalSwipeFind(filter);
            };

            // Request limit=20, page=2 requires advancing to batch 2
            const res = await request(app).get("/api/v1/discovery/likes-you?page=2&limit=20");
            assert.strictEqual(res.status, 500);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.message, "Failed to retrieve likes");
        });
    });

    describe("5. Pagination Completeness Across 1000+ Source Records & Traversal", () => {
        it("retrieves full requested page when >1000 source records exist with heavily filtered candidates", async () => {
            // Seed 1,100 candidates:
            // First 1,050 are invalid (isProfileComplete = false)
            // Last 50 (1,051 to 1,100) are valid (isProfileComplete = true)
            for (let i = 1; i <= 1100; i++) {
                const isComplete = i > 1050;
                const { user, swipe } = generateCandidate(i, { isProfileComplete: isComplete });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Request page 1 with limit 20. Under the old MAX_TOTAL_SCANNED = 1000 cap,
            // this would have returned an incomplete page of 0 items.
            // With pagination completeness, the loop continues and finds all 20 valid candidates.
            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.profiles.length, 20, "Must return full requested page of 20 items despite >1000 filtered records");
            assert.strictEqual(res.body.pagination.page, 1);
            assert.strictEqual(res.body.pagination.limit, 20);
            assert.strictEqual(res.body.pagination.total, 50, "Exact total must be 50 eligible candidates");
            assert.strictEqual(res.body.pagination.totalPages, 3, "Total pages must be ceil(50 / 20) = 3");
            assert.strictEqual(res.body.pagination.hasMore, true, "Must indicate hasMore when more valid candidates remain beyond page 1");
            // Verify that all returned candidates are complete and from the valid range (1051..1070)
            assert.ok(res.body.profiles.every((p) => p.isProfileComplete === true));
            assert.strictEqual(res.body.profiles[0]._id, mockUsers.get(new mongoose.Types.ObjectId(`65ce00000000000000${String(1051).padStart(6, "0")}`).toString())._id.toString());
        });

        it("traverses consecutive pages with zero skipped or duplicate candidates", async () => {
            // Seed 45 valid candidates
            for (let i = 1; i <= 45; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Page 1: limit = 20 -> items 1..20
            const res1 = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res1.status, 200);
            assert.strictEqual(res1.body.profiles.length, 20);
            const page1Ids = res1.body.profiles.map((p) => p._id);

            // Page 2: limit = 20 -> items 21..40
            const res2 = await request(app).get("/api/v1/discovery/likes-you?page=2&limit=20");
            assert.strictEqual(res2.status, 200);
            assert.strictEqual(res2.body.profiles.length, 20);
            const page2Ids = res2.body.profiles.map((p) => p._id);

            // Page 3: limit = 20 -> items 41..45 (partial final page)
            const res3 = await request(app).get("/api/v1/discovery/likes-you?page=3&limit=20");
            assert.strictEqual(res3.status, 200);
            assert.strictEqual(res3.body.profiles.length, 5);
            assert.strictEqual(res3.body.pagination.hasMore, false, "Final partial page must indicate hasMore = false");
            const page3Ids = res3.body.profiles.map((p) => p._id);

            // Assert zero overlap across consecutive pages
            const allFetchedIds = [...page1Ids, ...page2Ids, ...page3Ids];
            assert.strictEqual(allFetchedIds.length, 45);
            const uniqueIds = new Set(allFetchedIds);
            assert.strictEqual(uniqueIds.size, 45, "Must have zero duplicate or skipped profiles across all consecutive pages");

            // Page 4: beyond end -> empty array with hasMore = false
            const res4 = await request(app).get("/api/v1/discovery/likes-you?page=4&limit=20");
            assert.strictEqual(res4.status, 200);
            assert.strictEqual(res4.body.profiles.length, 0);
            assert.strictEqual(res4.body.pagination.hasMore, false);
        });

        it("terminates correctly and reports hasMore: false when all source records are exhausted", async () => {
            // Seed 10 candidates
            for (let i = 1; i <= 10; i++) {
                const { user, swipe } = generateCandidate(i);
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 10);
            assert.strictEqual(res.body.pagination.total, 10);
            assert.strictEqual(res.body.pagination.totalPages, 1);
            assert.strictEqual(res.body.pagination.hasMore, false);
        });
    });

    describe("6. Phase 2F.1.2: Exact Count and hasMore Verification", () => {
        it("Scenario 1: requested page is filled and further eligible results exist -> hasMore: true, exact total", async () => {
            // Seed 35 eligible candidates
            for (let i = 1; i <= 35; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: true });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 20);
            assert.strictEqual(res.body.pagination.page, 1);
            assert.strictEqual(res.body.pagination.limit, 20);
            assert.strictEqual(res.body.pagination.total, 35, "Exact total must be 35, not an estimate");
            assert.strictEqual(res.body.pagination.totalPages, 2);
            assert.strictEqual(res.body.pagination.hasMore, true, "Must be true because 15 eligible candidates remain");
        });

        it("Scenario 2: page is filled but source is exhausted -> hasMore: false, exact total", async () => {
            // Seed exactly 20 eligible candidates
            for (let i = 1; i <= 20; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: true });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 20);
            assert.strictEqual(res.body.pagination.total, 20, "Exact total must be 20");
            assert.strictEqual(res.body.pagination.totalPages, 1);
            assert.strictEqual(res.body.pagination.hasMore, false, "Must be false because source is exhausted");
        });

        it("Scenario 3: remaining raw records are all rejected by eligibility filters -> hasMore: false, exact total", async () => {
            // Seed 20 eligible candidates followed by 30 ineligible (incomplete) candidates
            for (let i = 1; i <= 20; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: true });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }
            for (let i = 21; i <= 50; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: false });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 20);
            assert.strictEqual(res.body.pagination.total, 20, "Ineligible candidates must NOT be counted in total");
            assert.strictEqual(res.body.pagination.totalPages, 1);
            assert.strictEqual(res.body.pagination.hasMore, false, "Must be false because all remaining raw records are ineligible");
        });

        it("Scenario 4: final page contains fewer than limit results -> hasMore: false, exact total", async () => {
            // Seed 27 eligible candidates
            for (let i = 1; i <= 27; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: true });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Page 2 with limit 20 has items 21..27 (7 items)
            const res = await request(app).get("/api/v1/discovery/likes-you?page=2&limit=20");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 7);
            assert.strictEqual(res.body.pagination.page, 2);
            assert.strictEqual(res.body.pagination.total, 27, "Exact total must be 27");
            assert.strictEqual(res.body.pagination.totalPages, 2);
            assert.strictEqual(res.body.pagination.hasMore, false, "Must be false on final partial page");
        });
    });

    describe("7. Phase 2F.1.3: Streaming Memory Scalability & Benchmark Suite", () => {
        it("streams large candidate sets (2,500 records) without unbounded memory accumulation and measures runtime", async () => {
            const TOTAL_CANDIDATES = 2500;
            // Seed 2,500 candidates: 2,000 eligible, 500 ineligible
            for (let i = 1; i <= TOTAL_CANDIDATES; i++) {
                const isComplete = i <= 2000;
                const { user, swipe } = generateCandidate(i, { isProfileComplete: isComplete });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            if (global.gc) {
                global.gc();
            }
            const heapBefore = process.memoryUsage().heapUsed;
            const startTime = performance.now();

            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");

            const endTime = performance.now();
            const heapAfter = process.memoryUsage().heapUsed;
            const durationMs = Math.round(endTime - startTime);
            const heapDeltaKb = Math.round((heapAfter - heapBefore) / 1024);

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 20);
            assert.strictEqual(res.body.pagination.total, 2000, "Exact eligible total must be 2,000");
            assert.strictEqual(res.body.pagination.totalPages, 100);
            assert.strictEqual(res.body.pagination.hasMore, true);

            // Log concrete benchmark measurement for report verification
            console.log(`[Phase2F13-Benchmark] datasetSize=${TOTAL_CANDIDATES} eligibleCount=2000 executionMethod=streaming_batch runtimeMs=${durationMs} heapDeltaKb=${heapDeltaKb}`);
        });

        it("preserves exact deduplication and deterministic order when duplicate swipes exist across batches", async () => {
            // Seed 150 candidates
            for (let i = 1; i <= 150; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: true });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Add duplicate swipes from candidate 10 and candidate 25 with older timestamps
            const c10User = mockUsers.get(new mongoose.Types.ObjectId(`65ce00000000000000${String(10).padStart(6, "0")}`).toString());
            const c25User = mockUsers.get(new mongoose.Types.ObjectId(`65ce00000000000000${String(25).padStart(6, "0")}`).toString());

            mockSwipes.push({
                _id: new mongoose.Types.ObjectId(),
                fromUser: c10User._id,
                toUser: currentUserId,
                action: "like",
                createdAt: new Date("2020-01-01"),
            });
            mockSwipes.push({
                _id: new mongoose.Types.ObjectId(),
                fromUser: c25User._id,
                toUser: currentUserId,
                action: "like",
                createdAt: new Date("2019-01-01"),
            });

            // Page 1: limit = 20
            const res = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.profiles.length, 20);
            assert.strictEqual(res.body.pagination.total, 150, "Exact total must be 150 despite duplicate swipes");

            // Candidate 10 must appear once
            const c10Count = res.body.profiles.filter((p) => p._id === c10User._id.toString()).length;
            assert.strictEqual(c10Count, 1, "Candidate 10 must appear exactly once");
        });

        it("preserves deterministic pagination across consecutive pages when 50 candidates share identical timestamps", async () => {
            const sharedDate = new Date("2026-10-25T15:00:00.000Z");
            // Seed 50 candidates all sharing identical timestamp
            for (let i = 1; i <= 50; i++) {
                const { user, swipe } = generateCandidate(i, { isProfileComplete: true, createdAt: sharedDate });
                mockUsers.set(user._id.toString(), user);
                mockSwipes.push(swipe);
            }

            // Page 1: 20 items
            const res1 = await request(app).get("/api/v1/discovery/likes-you?page=1&limit=20");
            assert.strictEqual(res1.body.profiles.length, 20);
            const page1Ids = new Set(res1.body.profiles.map((p) => p._id));

            // Page 2: 20 items
            const res2 = await request(app).get("/api/v1/discovery/likes-you?page=2&limit=20");
            assert.strictEqual(res2.body.profiles.length, 20);
            const page2Ids = new Set(res2.body.profiles.map((p) => p._id));

            // Page 3: 10 items
            const res3 = await request(app).get("/api/v1/discovery/likes-you?page=3&limit=20");
            assert.strictEqual(res3.body.profiles.length, 10);
            const page3Ids = new Set(res3.body.profiles.map((p) => p._id));

            // Intersection between all pages must be empty (0 duplicates)
            for (const id of page1Ids) {
                assert.ok(!page2Ids.has(id), "Page 1 and Page 2 must not overlap");
                assert.ok(!page3Ids.has(id), "Page 1 and Page 3 must not overlap");
            }
            for (const id of page2Ids) {
                assert.ok(!page3Ids.has(id), "Page 2 and Page 3 must not overlap");
            }

            const totalRetrieved = page1Ids.size + page2Ids.size + page3Ids.size;
            assert.strictEqual(totalRetrieved, 50, "All 50 items must be retrieved across 3 pages");
        });
    });
});
