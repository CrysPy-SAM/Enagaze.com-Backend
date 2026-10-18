import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { io as ioClient } from "socket.io-client";

import { connectToSocket } from "../src/controllers/socketManager.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Swipe } from "../src/models/swipe.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";
import { Block } from "../src/models/block.model.js";

import discoveryRouter from "../src/routes/discovery.routes.js";
import chatRouter from "../src/routes/chat.routes.js";
import { findOrCreateCanonicalMatchAndConversation } from "../src/services/matching.service.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

function connectClient(port, options = {}) {
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

describe("Prompt 8: Matching Correctness, Duplicate Recovery & clientTempId Suite", () => {
    let server;
    let ioServer;
    let port;
    let app;

    let originalUserFindById;
    let originalUserFindOne;
    let originalIsBlocked;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65cb11111111111111111111"),
        name: "Alice Johnson",
        username: "alice_j",
        dob: new Date("1995-05-15"),
        gender: "female",
        bio: "Explorer and coffee lover",
        photos: ["https://example.com/alice.jpg"],
        isProfileComplete: true,
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65cb22222222222222222222"),
        name: "Bob Builder",
        username: "bob_b",
        dob: new Date("1993-08-20"),
        gender: "male",
        bio: "Architect & nature photographer",
        photos: ["https://example.com/bob.jpg"],
        isProfileComplete: true,
    };

    const mockUserOutsider = {
        _id: new mongoose.Types.ObjectId("65cb33333333333333333333"),
        name: "Charlie Outsider",
        username: "charlie_o",
        dob: new Date("1990-01-01"),
        gender: "male",
        bio: "Observer",
        photos: ["https://example.com/charlie.jpg"],
        isProfileComplete: true,
    };

    const tokenA = makeToken({ id: mockUserA._id.toString(), username: mockUserA.username });
    const tokenB = makeToken({ id: mockUserB._id.toString(), username: mockUserB.username });
    const tokenOutsider = makeToken({ id: mockUserOutsider._id.toString(), username: mockUserOutsider.username });

    const userMap = {
        [mockUserA._id.toString()]: { ...mockUserA },
        [mockUserB._id.toString()]: { ...mockUserB },
        [mockUserOutsider._id.toString()]: { ...mockUserOutsider },
    };

    before(async () => {
        app = express();
        app.use(express.json());

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        // Mount authenticated routers
        app.use("/api/v1/discovery", discoveryRouter);
        app.use("/api/v1/conversations", chatRouter);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });

        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;
        originalIsBlocked = Block.isBlockedBidirectional;

        User.findById = (id) => {
            const idStr = id?.toString();
            const found = userMap[idStr] || null;
            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        User.findOne = (query) => {
            const found = query?._id ? userMap[query._id.toString()] : null;
            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        Block.isBlockedBidirectional = async () => false;
    });

    after(async () => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;
        Block.isBlockedBidirectional = originalIsBlocked;

        if (ioServer) {
            await new Promise((resolve) => ioServer.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // In-memory backing stores for simulated integration tests
    let inMemorySwipes = [];
    let inMemoryMatches = [];
    let inMemoryConversations = [];
    let inMemoryMessages = [];

    beforeEach(() => {
        inMemorySwipes = [];
        inMemoryMatches = [];
        inMemoryConversations = [];
        inMemoryMessages = [];

        // Swipe mocks with unique index simulation on { fromUser, toUser }
        Swipe.findOne = async (filter) => {
            return inMemorySwipes.find((s) => {
                let match = true;
                if (filter.fromUser && s.fromUser.toString() !== filter.fromUser.toString()) match = false;
                if (filter.toUser && s.toUser.toString() !== filter.toUser.toString()) match = false;
                if (filter.action && s.action !== filter.action) match = false;
                return match;
            }) || null;
        };

        Swipe.create = async (doc) => {
            const exists = inMemorySwipes.some(
                (s) => s.fromUser.toString() === doc.fromUser.toString() && s.toUser.toString() === doc.toUser.toString()
            );
            if (exists) {
                const err = new Error("E11000 duplicate key error collection: swipes");
                err.code = 11000;
                throw err;
            }
            const record = {
                _id: new mongoose.Types.ObjectId(),
                ...doc,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            inMemorySwipes.push(record);
            return record;
        };

        // Match mocks with unique index on userPair
        Match.findOne = (filter) => {
            const found = inMemoryMatches.find((m) => {
                if (filter._id && m._id.toString() !== filter._id.toString()) return false;
                if (filter.userPair && m.userPair !== filter.userPair) return false;
                if (filter.status && m.status !== filter.status) return false;
                return true;
            }) || null;

            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        Match.findById = (id) => {
            const found = inMemoryMatches.find((m) => m._id.toString() === id.toString()) || null;
            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        Match.create = async (doc) => {
            const exists = inMemoryMatches.some((m) => m.userPair === doc.userPair);
            if (exists) {
                const err = new Error("E11000 duplicate key error collection: matches");
                err.code = 11000;
                throw err;
            }
            const record = {
                _id: new mongoose.Types.ObjectId(),
                users: doc.users,
                userPair: doc.userPair,
                status: doc.status || "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            inMemoryMatches.push(record);
            return record;
        };

        // Conversation mocks with unique index on match
        Conversation.findOne = (filter) => {
            const found = inMemoryConversations.find((c) => {
                if (filter._id && c._id.toString() !== filter._id.toString()) return false;
                if (filter.match && c.match.toString() !== filter.match.toString()) return false;
                return true;
            }) || null;

            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        Conversation.findById = (id) => {
            const found = inMemoryConversations.find((c) => c._id.toString() === id.toString()) || null;
            if (found) {
                found.save = async function () { return this; };
            }
            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        Conversation.create = async (doc) => {
            const exists = inMemoryConversations.some((c) => c.match.toString() === doc.match.toString());
            if (exists) {
                const err = new Error("E11000 duplicate key error collection: conversations");
                err.code = 11000;
                throw err;
            }
            const record = {
                _id: new mongoose.Types.ObjectId(),
                match: doc.match,
                participants: doc.participants,
                lastMessage: null,
                lastMessageAt: doc.lastMessageAt || new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                save: async function () { return this; },
            };
            inMemoryConversations.push(record);
            return record;
        };

        // Message mocks with partial unique index on { conversation, sender, clientTempId }
        Message.findOne = (filter) => {
            const found = inMemoryMessages.find((m) => {
                if (filter._id && m._id.toString() !== filter._id.toString()) return false;
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) return false;
                if (filter.sender && m.sender.toString() !== filter.sender.toString()) return false;
                if (filter.clientTempId !== undefined && m.clientTempId !== filter.clientTempId) return false;
                return true;
            }) || null;

            let doc = null;
            if (found) {
                const senderIdStr = found.sender?._id ? found.sender._id.toString() : found.sender.toString();
                const senderUser = userMap[senderIdStr] || { _id: found.sender, name: "Test User" };
                doc = {
                    _id: found._id,
                    conversation: found.conversation,
                    sender: senderUser,
                    content: found.content,
                    clientTempId: found.clientTempId,
                    readBy: found.readBy,
                    createdAt: found.createdAt,
                    updatedAt: found.updatedAt,
                    toObject: function () { return this; },
                    toJSON: function () { return this; },
                    populate: async function () { return this; },
                };
            }

            return {
                populate: () => Promise.resolve(doc),
                then: (resolve) => resolve(doc),
            };
        };

        Message.prototype.populate = async function () {
            const senderIdStr = this.sender ? (this.sender._id ? this.sender._id.toString() : this.sender.toString()) : "";
            this.sender = userMap[senderIdStr] || { _id: this.sender, name: "Test User" };
            return this;
        };

        // Mock Message constructor and prototype.save
        Message.prototype.save = async function () {
            const senderIdStr = this.sender ? (this.sender._id ? this.sender._id.toString() : this.sender.toString()) : "";
            // Check uniqueness on { conversation, sender, clientTempId } only if clientTempId is a non-empty string
            if (typeof this.clientTempId === "string" && this.clientTempId.length > 0) {
                const exists = inMemoryMessages.some((m) => {
                    const mSenderStr = m.sender?._id ? m.sender._id.toString() : m.sender.toString();
                    return (
                        m.conversation.toString() === this.conversation.toString() &&
                        mSenderStr === senderIdStr &&
                        m.clientTempId === this.clientTempId
                    );
                });
                if (exists) {
                    const err = new Error("E11000 duplicate key error collection: messages");
                    err.code = 11000;
                    throw err;
                }
            }

            const newId = this._id || new mongoose.Types.ObjectId();
            this._id = newId;
            this.createdAt = this.createdAt || new Date();
            this.updatedAt = new Date();

            const sUser = userMap[senderIdStr] || { _id: this.sender, name: "Test User" };
            this.sender = sUser;

            if (this._doc) {
                this._doc._id = newId;
                this._doc.sender = sUser;
                this._doc.conversation = this.conversation;
                this._doc.content = this.content;
                this._doc.clientTempId = this.clientTempId;
                this._doc.readBy = this.readBy;
                this._doc.createdAt = this.createdAt;
                this._doc.updatedAt = this.updatedAt;
            }

            this.toObject = function () {
                return {
                    _id: this._id,
                    conversation: this.conversation,
                    sender: sUser,
                    content: this.content,
                    clientTempId: this.clientTempId,
                    readBy: this.readBy,
                    createdAt: this.createdAt,
                    updatedAt: this.updatedAt,
                };
            };
            this.toJSON = this.toObject;

            inMemoryMessages.push(this);
            return this;
        };
    });

    // =============================================================
    // 1. Matching Correctness Under Concurrency
    // =============================================================
    describe("1. Matching Correctness & Simultaneous Reciprocal Likes", () => {
        it("Requirement 1 & 2: Simultaneous reciprocal likes produce exactly one canonical Match and one Conversation", async () => {
            // Simulate User A and User B swiping 'like' at the exact same moment
            // Step 1: Pre-populate reciprocal swipe so both find reverseLike
            await Swipe.create({
                fromUser: mockUserA._id,
                toUser: mockUserB._id,
                action: "like",
            });
            await Swipe.create({
                fromUser: mockUserB._id,
                toUser: mockUserA._id,
                action: "like",
            });

            // Concurrently invoke findOrCreateCanonicalMatchAndConversation
            const [resA, resB] = await Promise.all([
                findOrCreateCanonicalMatchAndConversation(mockUserA._id, mockUserB._id),
                findOrCreateCanonicalMatchAndConversation(mockUserB._id, mockUserA._id),
            ]);

            // Both threads must return the exact same canonical match and conversation
            assert.equal(resA.match._id.toString(), resB.match._id.toString());
            assert.equal(resA.conversation._id.toString(), resB.conversation._id.toString());

            // Exactly ONE match and ONE conversation in database
            assert.equal(inMemoryMatches.length, 1);
            assert.equal(inMemoryConversations.length, 1);

            // Exactly one thread is flagged as isNewMatch: true
            const newMatchCount = (resA.isNewMatch ? 1 : 0) + (resB.isNewMatch ? 1 : 0);
            assert.equal(newMatchCount, 1, "Only the creating thread must have isNewMatch: true");
        });

        it("Requirement 1 & 2: Repeated simultaneous A→B and B→A requests cannot create duplicate Match or Conversation records under high concurrency", async () => {
            // Launch 10 concurrent requests (5 of A->B and 5 of B->A) simultaneously
            const concurrentCalls = [];
            for (let i = 0; i < 5; i++) {
                concurrentCalls.push(findOrCreateCanonicalMatchAndConversation(mockUserA._id, mockUserB._id));
                concurrentCalls.push(findOrCreateCanonicalMatchAndConversation(mockUserB._id, mockUserA._id));
            }

            const results = await Promise.all(concurrentCalls);

            // Assert exactly 1 match and 1 conversation in database
            assert.equal(inMemoryMatches.length, 1, "Must contain strictly 1 Match record");
            assert.equal(inMemoryConversations.length, 1, "Must contain strictly 1 Conversation record");

            const canonicalMatchId = inMemoryMatches[0]._id.toString();
            const canonicalConvId = inMemoryConversations[0]._id.toString();

            // Every result must point to the identical canonical IDs
            let newMatchCount = 0;
            for (const res of results) {
                assert.equal(res.match._id.toString(), canonicalMatchId);
                assert.equal(res.conversation._id.toString(), canonicalConvId);
                if (res.isNewMatch) newMatchCount++;
            }

            // Exactly ONE thread in the 10-way race was flagged as the creator
            assert.equal(newMatchCount, 1, "Exactly one caller across all 10 concurrent requests must be flagged as isNewMatch: true");
        });

        it("Requirement 1 & 2: Simultaneous A→B and B→A HTTP swipe requests produce mutual match without duplicate records", async () => {
            // Simultaneous reciprocal swipes sent via HTTP API
            const [resA, resB] = await Promise.all([
                request(app)
                    .post("/api/v1/discovery/swipe")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .send({ targetUserId: mockUserB._id.toString(), action: "like" }),
                request(app)
                    .post("/api/v1/discovery/swipe")
                    .set("Authorization", `Bearer ${tokenB}`)
                    .send({ targetUserId: mockUserA._id.toString(), action: "like" }),
            ]);

            // Both requests must succeed (status 200 or 201)
            assert.ok([200, 201].includes(resA.status), `resA status was ${resA.status}`);
            assert.ok([200, 201].includes(resB.status), `resB status was ${resB.status}`);

            // At least the second one (or both) detects mutual match
            assert.ok(resA.body.isMatch || resB.body.isMatch);

            // Assert database invariants: strictly 1 Match and strictly 1 Conversation
            assert.equal(inMemoryMatches.length, 1, "Must contain strictly 1 Match");
            assert.equal(inMemoryConversations.length, 1, "Must contain strictly 1 Conversation");
            assert.equal(inMemorySwipes.length, 2, "Must contain strictly 2 Swipes (A->B and B->A)");
        });

        it("Requirement 3: Prevent duplicate match notifications during concurrent match creation", async () => {
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            let matchNotifCountA = 0;
            let matchNotifCountB = 0;

            clientA.on("match:new", () => matchNotifCountA++);
            clientB.on("match:new", () => matchNotifCountB++);

            // User A likes User B
            const swipeResA = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            assert.equal(swipeResA.status, 200);
            assert.equal(swipeResA.body.isMatch, false);

            // User B likes User A (completing mutual match)
            const swipeResB = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenB}`)
                .send({ targetUserId: mockUserA._id.toString(), action: "like" });

            assert.equal(swipeResB.status, 201);
            assert.equal(swipeResB.body.isMatch, true);
            assert.ok(swipeResB.body.match);

            // Wait a tick for socket broadcast
            await new Promise((res) => setTimeout(res, 50));

            // Exactly one notification sent to each user
            assert.equal(matchNotifCountA, 1, "User A must receive exactly one match:new event");
            assert.equal(matchNotifCountB, 1, "User B must receive exactly one match:new event");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 2 & 4: Concurrent duplicate swipe requests return a stable documented result", async () => {
            // Two concurrent duplicate swipe requests from User A on User B
            const [res1, res2] = await Promise.all([
                request(app)
                    .post("/api/v1/discovery/swipe")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .send({ targetUserId: mockUserB._id.toString(), action: "like" }),
                request(app)
                    .post("/api/v1/discovery/swipe")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .send({ targetUserId: mockUserB._id.toString(), action: "like" }),
            ]);

            // Both requests must succeed (one fresh 200, one duplicate recovery 200)
            assert.equal(res1.status, 200);
            assert.equal(res2.status, 200);

            // Exactly one swipe stored in database
            assert.equal(inMemorySwipes.length, 1);

            // At least one reports duplicate: true
            const hasDuplicateFlag = res1.body.duplicate === true || res2.body.duplicate === true;
            assert.equal(hasDuplicateFlag, true);
        });

        it("Requirement 5: Duplicate-key recovery returns existing canonical records on retries", async () => {
            // First swipe + mutual like to form a match
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            const matchRes = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenB}`)
                .send({ targetUserId: mockUserA._id.toString(), action: "like" });

            assert.equal(matchRes.status, 201);
            const canonicalMatchId = matchRes.body.match._id;

            // User A retries the exact same swipe on User B
            const retryRes = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            assert.equal(retryRes.status, 200);
            assert.equal(retryRes.body.duplicate, true);
            assert.equal(retryRes.body.isMatch, true);
            assert.equal(retryRes.body.match._id, canonicalMatchId);

            // Assert database invariants: no duplicate match or conversation
            assert.equal(inMemoryMatches.length, 1);
            assert.equal(inMemoryConversations.length, 1);
        });

        it("Requirement 4: Conflicting swipe action on previously swiped profile returns 409 Conflict", async () => {
            // User A swiped like
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            // User A attempts to submit pass on same user
            const conflictRes = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "pass" });

            assert.equal(conflictRes.status, 409);
            assert.equal(conflictRes.body.code, "SWIPE_EXISTS");
            assert.equal(conflictRes.body.action, "like");
        });
    });

    // =============================================================
    // 2. Message Deduplication & clientTempId
    // =============================================================
    describe("2. Message Deduplication & clientTempId Scoping", () => {
        let testConversationId;

        beforeEach(async () => {
            // Create a test conversation between User A and User B
            const testMatch = await Match.create({
                users: [mockUserA._id, mockUserB._id],
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const testConv = await Conversation.create({
                match: testMatch._id,
                participants: [mockUserA._id, mockUserB._id],
            });

            testConversationId = testConv._id.toString();
        });

        it("Requirement 4: Retried REST message send returns original message without duplicate record", async () => {
            const clientTempId = "temp-uuid-rest-001";

            // Initial REST send
            const res1 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Hello Bob!", clientTempId });

            assert.equal(res1.status, 201);
            assert.equal(res1.body.success, true);
            const msgId = res1.body.message._id;

            // Retried REST send with same clientTempId
            const res2 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Hello Bob!", clientTempId });

            assert.equal(res2.status, 200);
            assert.equal(res2.body.success, true);
            assert.equal(res2.body.duplicate, true);
            assert.equal(res2.body.message._id, msgId);

            // Database must contain strictly one message
            assert.equal(inMemoryMessages.length, 1);
        });

        it("Requirement 4: Retried Socket.IO chat:send returns original message without duplicate broadcast", async () => {
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            let bReceivedCount = 0;
            clientB.on("chat:new-message", () => bReceivedCount++);

            const clientTempId = "temp-uuid-socket-002";

            // First emit
            const ack1 = await new Promise((res) => {
                clientA.emit("chat:send", {
                    conversationId: testConversationId,
                    content: "Hey from Socket!",
                    clientTempId,
                }, res);
            });

            assert.equal(ack1.success, true);
            assert.equal(ack1.duplicate, undefined);
            const firstMsgId = ack1.message._id;

            // Retry emit with same clientTempId
            const ack2 = await new Promise((res) => {
                clientA.emit("chat:send", {
                    conversationId: testConversationId,
                    content: "Hey from Socket!",
                    clientTempId,
                }, res);
            });

            assert.equal(ack2.success, true);
            assert.equal(ack2.duplicate, true);
            assert.equal(ack2.message._id, firstMsgId);

            // Wait a tick for socket broadcast
            await new Promise((res) => setTimeout(res, 50));

            // Partner must only receive ONE broadcast, not a duplicate
            assert.equal(bReceivedCount, 1);
            assert.equal(inMemoryMessages.length, 1);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 5: Two different senders can use the same clientTempId without collision", async () => {
            const sharedTempId = "common-temp-id-001";

            // User A sends with sharedTempId
            const resA = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Alice's message", clientTempId: sharedTempId });

            assert.equal(resA.status, 201);
            assert.equal(resA.body.success, true);

            // User B sends with identical sharedTempId in same conversation
            const resB = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenB}`)
                .send({ content: "Bob's message", clientTempId: sharedTempId });

            assert.equal(resB.status, 201);
            assert.equal(resB.body.success, true);

            // Both messages must be saved with their respective sender IDs
            assert.equal(inMemoryMessages.length, 2);
            assert.notEqual(resA.body.message._id, resB.body.message._id);
            assert.equal(resA.body.message.sender._id, mockUserA._id.toString());
            assert.equal(resB.body.message.sender._id, mockUserB._id.toString());
        });

        it("Requirement 6: Multiple messages without clientTempId succeed without partial index collisions", async () => {
            // First message without clientTempId
            const res1 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message without tempId 1" });

            assert.equal(res1.status, 201);

            // Second message without clientTempId by same sender in same conversation
            const res2 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message without tempId 2" });

            assert.equal(res2.status, 201);

            // Third message with empty string clientTempId (sanitized to undefined)
            const res3 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message with empty tempId", clientTempId: "   " });

            assert.equal(res3.status, 201);

            assert.equal(inMemoryMessages.length, 3);
        });

        it("Requirement 6: Malformed or oversized clientTempId is rejected with 400 Bad Request", async () => {
            // Array clientTempId
            const resArray = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Test", clientTempId: ["not", "string"] });

            assert.equal(resArray.status, 400);
            assert.match(resArray.body.message, /invalid clienttempid/i);

            // Oversized clientTempId (> 100 characters)
            const oversizedId = "a".repeat(101);
            const resOversized = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Test", clientTempId: oversizedId });

            assert.equal(resOversized.status, 400);
            assert.match(resOversized.body.message, /invalid clienttempid/i);
        });

        it("Requirement 8: Outsider cannot access or send messages to an unauthorized conversation", async () => {
            const res = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenOutsider}`)
                .send({ content: "Intruder!", clientTempId: "temp-intruder" });

            assert.equal(res.status, 403);
            assert.match(res.body.message, /not authorized/i);
            assert.equal(inMemoryMessages.length, 0);
        });

        it("Requirement 9: Blocked user cannot send messages or retry sends", async () => {
            Block.isBlockedBidirectional = async () => true;

            const res = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Blocked msg", clientTempId: "temp-blocked" });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "BLOCKED_USER");
            assert.equal(inMemoryMessages.length, 0);

            Block.isBlockedBidirectional = async () => false;
        });

        it("Requirement 9: Unmatched conversation blocks new messages and retries", async () => {
            // Update match to unmatched
            const match = inMemoryMatches.find((m) => m.users.some((u) => u.toString() === mockUserA._id.toString()));
            if (match) match.status = "unmatched";

            const res = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Post unmatch msg", clientTempId: "temp-unmatched" });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "MATCH_UNMATCHED");
            assert.equal(inMemoryMessages.length, 0);
        });
    });
});
