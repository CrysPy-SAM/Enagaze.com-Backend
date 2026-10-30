import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { connectToSocket } from "../src/controllers/socketManager.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";
import { Block } from "../src/models/block.model.js";

import chatRouter from "../src/routes/chat.routes.js";
import { calculateUserUnreadCount } from "../src/controllers/chat.controller.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

describe("Phase 1: Persistent Unread Message Tracking & Unread Count API Suite", () => {
    let server;
    let ioServer;
    let app;

    let originalUserFindById;
    let originalUserFindOne;
    let originalIsBlocked;
    let originalGetBlocked;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65ca11111111111111111111"),
        name: "Alice Active",
        username: "alice_active",
        dob: new Date("1996-03-12"),
        gender: "female",
        bio: "Photography and hiking",
        photos: ["https://example.com/alice.jpg"],
        isProfileComplete: true,
        age: 28,
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65ca22222222222222222222"),
        name: "Bob Partner",
        username: "bob_partner",
        dob: new Date("1994-07-21"),
        gender: "male",
        bio: "Music producer",
        photos: ["https://example.com/bob.jpg"],
        isProfileComplete: true,
        age: 30,
    };

    const tokenA = makeToken({ id: mockUserA._id.toString(), username: mockUserA.username });
    const tokenB = makeToken({ id: mockUserB._id.toString(), username: mockUserB.username });

    const userMap = {
        [mockUserA._id.toString()]: { ...mockUserA },
        [mockUserB._id.toString()]: { ...mockUserB },
    };

    let inMemoryMatches = [];
    let inMemoryConversations = [];
    let inMemoryMessages = [];

    before(async () => {
        app = express();
        app.use(express.json());

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        app.use("/api/v1/conversations", chatRouter);

        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;
        originalIsBlocked = Block.isBlockedBidirectional;
        originalGetBlocked = Block.getBlockedUserIds;

        User.findById = (id) => {
            const found = userMap[id?.toString()] || null;
            return {
                select: () => ({
                    populate: () => Promise.resolve(found),
                    then: (resolve) => resolve(found),
                }),
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
        Block.getBlockedUserIds = async () => [];

        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
    });

    after(async () => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;
        Block.isBlockedBidirectional = originalIsBlocked;
        Block.getBlockedUserIds = originalGetBlocked;

        if (ioServer) {
            await new Promise((resolve) => ioServer.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    let conv1Id;
    let match1Id;

    beforeEach(async () => {
        inMemoryMatches = [];
        inMemoryConversations = [];
        inMemoryMessages = [];

        match1Id = new mongoose.Types.ObjectId();
        conv1Id = new mongoose.Types.ObjectId();

        const matchDoc = {
            _id: match1Id,
            users: [mockUserA._id, mockUserB._id],
            status: "active",
            createdAt: new Date(),
        };
        inMemoryMatches.push(matchDoc);

        const convDoc = {
            _id: conv1Id,
            match: matchDoc,
            participants: [mockUserA._id, mockUserB._id],
            lastMessage: null,
            lastMessageAt: new Date(),
            createdAt: new Date(),
        };
        inMemoryConversations.push(convDoc);

        // Mock Conversation queries
        Conversation.find = (filter) => {
            const found = inMemoryConversations.filter((c) => {
                if (filter.participants && !c.participants.some((p) => p.toString() === filter.participants.toString())) {
                    return false;
                }
                return true;
            });
            return {
                select: () => ({
                    populate: () => Promise.resolve(found),
                    then: (resolve) => resolve(found),
                }),
                populate: () => ({
                    populate: () => Promise.resolve(found),
                    then: (resolve) => resolve(found),
                }),
                sort: () => ({
                    populate: () => ({
                        populate: () => Promise.resolve(found),
                        then: (resolve) => resolve(found),
                    }),
                }),
                then: (resolve) => resolve(found),
            };
        };

        Conversation.findById = (id) => {
            const found = inMemoryConversations.find((c) => c._id.toString() === id.toString()) || null;
            return {
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        // Mock Match queries
        Match.find = () => ({
            select: () => Promise.resolve(inMemoryMatches),
            then: (resolve) => resolve(inMemoryMatches),
        });
        Match.findById = (id) => {
            const found = inMemoryMatches.find((m) => m._id.toString() === id.toString()) || null;
            return {
                select: () => Promise.resolve(found),
                populate: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        // Mock Message queries
        Message.find = (filter) => {
            const found = inMemoryMessages.filter((m) => {
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) return false;
                return true;
            });
            return {
                sort: () => ({
                    limit: () => Promise.resolve(found),
                    then: (resolve) => resolve(found),
                }),
                then: (resolve) => resolve(found),
            };
        };

        Message.countDocuments = async (filter) => {
            return inMemoryMessages.filter((m) => {
                if (filter.conversation) {
                    if (filter.conversation.$in) {
                        const inIds = filter.conversation.$in.map((id) => id.toString());
                        if (!inIds.includes(m.conversation.toString())) return false;
                    } else if (m.conversation.toString() !== filter.conversation.toString()) {
                        return false;
                    }
                }
                if (filter.sender && filter.sender.$ne) {
                    if (m.sender.toString() === filter.sender.$ne.toString()) return false;
                }
                if (filter.readBy && filter.readBy.$ne) {
                    if (m.readBy.some((r) => r.toString() === filter.readBy.$ne.toString())) return false;
                }
                return true;
            }).length;
        };

        Message.aggregate = async (pipeline) => {
            const matchStage = pipeline.find((p) => p.$match)?.$match;
            if (!matchStage) return [];

            const filtered = inMemoryMessages.filter((m) => {
                if (matchStage.conversation?.$in) {
                    const validIds = matchStage.conversation.$in.map((id) => id.toString());
                    if (!validIds.includes(m.conversation.toString())) return false;
                }
                if (matchStage.sender?.$ne && m.sender.toString() === matchStage.sender.$ne.toString()) {
                    return false;
                }
                if (matchStage.readBy?.$ne && m.readBy.some((r) => r.toString() === matchStage.readBy.$ne.toString())) {
                    return false;
                }
                return true;
            });

            const groups = {};
            for (const m of filtered) {
                const cId = m.conversation.toString();
                groups[cId] = (groups[cId] || 0) + 1;
            }

            return Object.entries(groups).map(([cId, count]) => ({ _id: new mongoose.Types.ObjectId(cId), count }));
        };

        Message.updateMany = async (filter, update) => {
            let modifiedCount = 0;
            for (const m of inMemoryMessages) {
                let matches = true;
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) {
                    matches = false;
                }
                if (filter.sender?.$ne && m.sender.toString() === filter.sender.$ne.toString()) {
                    matches = false;
                }
                if (filter.readBy?.$ne && m.readBy.some((r) => r.toString() === filter.readBy.$ne.toString())) {
                    matches = false;
                }
                if (matches) {
                    if (update.$addToSet?.readBy) {
                        const reader = update.$addToSet.readBy;
                        if (!m.readBy.some((r) => r.toString() === reader.toString())) {
                            m.readBy.push(reader);
                            modifiedCount++;
                        }
                    }
                }
            }
            return { modifiedCount };
        };
    });

    it("1. GET /api/v1/conversations/unread-count rejects unauthenticated requests (HTTP 401)", async () => {
        const res = await request(app).get("/api/v1/conversations/unread-count");
        assert.equal(res.status, 401);
    });

    it("2. GET /api/v1/conversations/unread-count returns 0 when no messages exist", async () => {
        const res = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.unreadCount, 0);
        assert.equal(res.body.unreadConversationsCount, 0);
    });

    it("3. Correctly calculates unread count when partner sends messages to User A", async () => {
        // Partner B sends 3 messages to User A
        for (let i = 1; i <= 3; i++) {
            inMemoryMessages.push({
                _id: new mongoose.Types.ObjectId(),
                conversation: conv1Id,
                sender: mockUserB._id,
                content: `Message ${i} from Bob`,
                readBy: [mockUserB._id], // Only sender has read
                createdAt: new Date(Date.now() + i * 1000),
            });
        }

        const resA = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(resA.status, 200);
        assert.equal(resA.body.unreadCount, 3);
        assert.equal(resA.body.unreadConversationsCount, 1);
        assert.equal(resA.body.conversationsUnread[conv1Id.toString()], 3);
    });

    it("4. Does NOT count sender's own sent messages as unread for the sender", async () => {
        // Partner B sends 2 messages, User A sends 1 message
        inMemoryMessages.push(
            {
                _id: new mongoose.Types.ObjectId(),
                conversation: conv1Id,
                sender: mockUserB._id,
                content: "Hey Alice!",
                readBy: [mockUserB._id],
                createdAt: new Date(),
            },
            {
                _id: new mongoose.Types.ObjectId(),
                conversation: conv1Id,
                sender: mockUserA._id,
                content: "Hey Bob, I see you!",
                readBy: [mockUserA._id],
                createdAt: new Date(),
            }
        );

        // Sender A should only have 1 unread message (from Bob), NOT their own message
        const resA = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(resA.status, 200);
        assert.equal(resA.body.unreadCount, 1);

        // Sender B should have 1 unread message (from Alice), NOT their own message
        const resB = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenB}`);

        assert.equal(resB.status, 200);
        assert.equal(resB.body.unreadCount, 1);
    });

    it("5. Marking a conversation as read clears unread state in both controller and database", async () => {
        inMemoryMessages.push(
            {
                _id: new mongoose.Types.ObjectId(),
                conversation: conv1Id,
                sender: mockUserB._id,
                content: "Message 1",
                readBy: [mockUserB._id],
                createdAt: new Date(),
            },
            {
                _id: new mongoose.Types.ObjectId(),
                conversation: conv1Id,
                sender: mockUserB._id,
                content: "Message 2",
                readBy: [mockUserB._id],
                createdAt: new Date(),
            }
        );

        // Verify initially 2 unread
        const beforeRes = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenA}`);
        assert.equal(beforeRes.body.unreadCount, 2);

        // User A marks conversation as read
        const markRes = await request(app)
            .put(`/api/v1/conversations/${conv1Id}/read`)
            .set("Authorization", `Bearer ${tokenA}`);
        assert.equal(markRes.status, 200);
        assert.equal(markRes.body.success, true);
        assert.equal(markRes.body.modifiedCount, 2);

        // Verify unread count is now 0
        const afterRes = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenA}`);
        assert.equal(afterRes.body.unreadCount, 0);
        assert.equal(afterRes.body.unreadConversationsCount, 0);
    });

    it("6. Multi-conversation aggregation: accurate total and per-conversation breakdown", async () => {
        const conv2Id = new mongoose.Types.ObjectId();
        const mockUserC = {
            _id: new mongoose.Types.ObjectId("65ca33333333333333333333"),
            name: "Carol Third",
            username: "carol_t",
            dob: new Date("1997-09-01"),
            gender: "female",
            bio: "Traveler",
            photos: [],
            isProfileComplete: true,
            age: 27,
        };
        userMap[mockUserC._id.toString()] = mockUserC;

        const match2Doc = {
            _id: new mongoose.Types.ObjectId(),
            users: [mockUserA._id, mockUserC._id],
            status: "active",
            createdAt: new Date(),
        };
        inMemoryMatches.push(match2Doc);
        inMemoryConversations.push({
            _id: conv2Id,
            match: match2Doc,
            participants: [mockUserA._id, mockUserC._id],
            lastMessage: null,
            lastMessageAt: new Date(),
            createdAt: new Date(),
        });

        // Conv 1 has 2 unread from Bob
        inMemoryMessages.push(
            { _id: new mongoose.Types.ObjectId(), conversation: conv1Id, sender: mockUserB._id, content: "M1", readBy: [mockUserB._id], createdAt: new Date() },
            { _id: new mongoose.Types.ObjectId(), conversation: conv1Id, sender: mockUserB._id, content: "M2", readBy: [mockUserB._id], createdAt: new Date() }
        );

        // Conv 2 has 3 unread from Carol
        inMemoryMessages.push(
            { _id: new mongoose.Types.ObjectId(), conversation: conv2Id, sender: mockUserC._id, content: "C1", readBy: [mockUserC._id], createdAt: new Date() },
            { _id: new mongoose.Types.ObjectId(), conversation: conv2Id, sender: mockUserC._id, content: "C2", readBy: [mockUserC._id], createdAt: new Date() },
            { _id: new mongoose.Types.ObjectId(), conversation: conv2Id, sender: mockUserC._id, content: "C3", readBy: [mockUserC._id], createdAt: new Date() }
        );

        const res = await request(app)
            .get("/api/v1/conversations/unread-count")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(res.status, 200);
        assert.equal(res.body.unreadCount, 5); // 2 + 3 = 5
        assert.equal(res.body.unreadConversationsCount, 2);
        assert.equal(res.body.conversationsUnread[conv1Id.toString()], 2);
        assert.equal(res.body.conversationsUnread[conv2Id.toString()], 3);
    });
});
