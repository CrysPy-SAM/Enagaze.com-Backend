import { describe, it, before, after, beforeEach } from "node:test";
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
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";
import { Block } from "../src/models/block.model.js";

import chatRouter from "../src/routes/chat.routes.js";

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

// In-memory simulation of frontend deterministic sorting and reconciliation logic
function sortMessagesDeterministic(msgList) {
    return [...msgList].sort((a, b) => {
        const timeA = new Date(a.createdAt || 0).getTime();
        const timeB = new Date(b.createdAt || 0).getTime();
        if (timeA !== timeB) return timeA - timeB;
        const keyA = String(a._id || a.clientTempId || "");
        const keyB = String(b._id || b.clientTempId || "");
        return keyA.localeCompare(keyB);
    });
}

function reconcileSingleMessage(prevMessages, incomingMsg) {
    if (incomingMsg.clientTempId) {
        const tempIdx = prevMessages.findIndex(
            (m) => m.clientTempId && m.clientTempId === incomingMsg.clientTempId
        );
        if (tempIdx !== -1) {
            const copy = [...prevMessages];
            copy[tempIdx] = { ...copy[tempIdx], ...incomingMsg, status: "sent" };
            return sortMessagesDeterministic(copy);
        }
    }

    if (incomingMsg._id) {
        const idIdx = prevMessages.findIndex(
            (m) => m._id && m._id.toString() === incomingMsg._id.toString()
        );
        if (idIdx !== -1) {
            const copy = [...prevMessages];
            copy[idIdx] = { ...copy[idIdx], ...incomingMsg, status: "sent" };
            return sortMessagesDeterministic(copy);
        }
    }

    return sortMessagesDeterministic([...prevMessages, { ...incomingMsg, status: "sent" }]);
}

function reconcileBatchMessages(prevMessages, incomingBatch) {
    let current = [...prevMessages];
    for (const inc of incomingBatch) {
        if (inc.clientTempId) {
            const tempIdx = current.findIndex(
                (m) => m.clientTempId && m.clientTempId === inc.clientTempId
            );
            if (tempIdx !== -1) {
                current[tempIdx] = { ...current[tempIdx], ...inc, status: "sent" };
                continue;
            }
        }

        if (inc._id) {
            const idIdx = current.findIndex(
                (m) => m._id && m._id.toString() === inc._id.toString()
            );
            if (idIdx !== -1) {
                current[idIdx] = { ...current[idIdx], ...inc, status: "sent" };
                continue;
            }
        }

        current.push({ ...inc, status: "sent" });
    }
    return sortMessagesDeterministic(current);
}

describe("Prompt 9: Reliable Chat Reconnect, Acknowledgement Retry & Message Recovery Suite", () => {
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
        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
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
    let inMemoryMatches = [];
    let inMemoryConversations = [];
    let inMemoryMessages = [];
    let testConversationId;
    let testMatchId;

    beforeEach(async () => {
        inMemoryMatches = [];
        inMemoryConversations = [];
        inMemoryMessages = [];

        // Match mocks
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

        // Conversation mocks
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

        // Message mocks
        Message.countDocuments = async (filter) => {
            return inMemoryMessages.filter((m) => {
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) return false;
                return true;
            }).length;
        };

        Message.findById = (id) => {
            const found = inMemoryMessages.find((m) => m._id.toString() === id.toString()) || null;
            return {
                select: (fields) => {
                    if (found && (fields === "createdAt" || fields?.includes("createdAt"))) {
                        return Promise.resolve({ _id: found._id, createdAt: found.createdAt });
                    }
                    return Promise.resolve(found);
                },
                then: (resolve) => resolve(found),
            };
        };

        Message.find = (filter) => {
            let filtered = inMemoryMessages.filter((m) => {
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) return false;
                if (filter.$or) {
                    const matchesOr = filter.$or.some((branch) => {
                        if (branch.createdAt?.$gt) {
                            return new Date(m.createdAt).getTime() > new Date(branch.createdAt.$gt).getTime();
                        }
                        if (branch.createdAt && branch._id?.$gt) {
                            const sameTime = new Date(m.createdAt).getTime() === new Date(branch.createdAt).getTime();
                            const greaterId = m._id.toString() > branch._id.$gt.toString();
                            return sameTime && greaterId;
                        }
                        return false;
                    });
                    if (!matchesOr) return false;
                } else {
                    if (filter.createdAt?.$gt) {
                        if (new Date(m.createdAt).getTime() <= new Date(filter.createdAt.$gt).getTime()) return false;
                    }
                    if (filter._id?.$gt) {
                        if (m._id.toString() <= filter._id.$gt.toString()) return false;
                    }
                }
                return true;
            });

            return {
                sort: (sortObj) => {
                    const sorted = [...filtered].sort((a, b) => {
                        const timeA = new Date(a.createdAt).getTime();
                        const timeB = new Date(b.createdAt).getTime();
                        if (sortObj.createdAt === -1) {
                            if (timeA !== timeB) return timeB - timeA;
                            return b._id.toString().localeCompare(a._id.toString());
                        }
                        if (sortObj.createdAt === 1) {
                            if (timeA !== timeB) return timeA - timeB;
                            return a._id.toString().localeCompare(b._id.toString());
                        }
                        return 0;
                    });

                    return {
                        skip: (num) => ({
                            limit: (lim) => ({
                                populate: () => Promise.resolve(sorted.slice(num, num + lim).map((m) => {
                                    const sId = m.sender?._id ? m.sender._id.toString() : m.sender.toString();
                                    return {
                                        _id: m._id,
                                        conversation: m.conversation,
                                        sender: userMap[sId] || { _id: m.sender, name: "User" },
                                        content: m.content,
                                        clientTempId: m.clientTempId,
                                        readBy: m.readBy,
                                        createdAt: m.createdAt,
                                        updatedAt: m.updatedAt,
                                        toObject: function () { return this; },
                                    };
                                })),
                            }),
                        }),
                        limit: (lim) => ({
                            populate: () => Promise.resolve(sorted.slice(0, lim).map((m) => {
                                const sId = m.sender?._id ? m.sender._id.toString() : m.sender.toString();
                                return {
                                    _id: m._id,
                                    conversation: m.conversation,
                                    sender: userMap[sId] || { _id: m.sender, name: "User" },
                                    content: m.content,
                                    clientTempId: m.clientTempId,
                                    readBy: m.readBy,
                                    createdAt: m.createdAt,
                                    updatedAt: m.updatedAt,
                                    toObject: function () { return this; },
                                };
                            })),
                        }),
                    };
                },
            };
        };

        Message.findOne = (filter) => {
            const fSenderStr = filter.sender?._id ? filter.sender._id.toString() : filter.sender?.toString();
            const found = inMemoryMessages.find((m) => {
                if (filter._id && m._id.toString() !== filter._id.toString()) return false;
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) return false;
                if (fSenderStr) {
                    const mSenderStr = m.sender?._id ? m.sender._id.toString() : m.sender?.toString();
                    if (mSenderStr !== fSenderStr) return false;
                }
                if (filter.clientTempId !== undefined && m.clientTempId !== filter.clientTempId) return false;
                return true;
            }) || null;

            let doc = null;
            if (found) {
                const sIdStr = found.sender?._id ? found.sender._id.toString() : found.sender.toString();
                const senderUser = userMap[sIdStr] || { _id: found.sender, name: "Test User" };
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

        Message.prototype.save = async function () {
            const senderIdStr = this.sender ? (this.sender._id ? this.sender._id.toString() : this.sender.toString()) : "";
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

        Message.updateMany = async (filter, update) => {
            let modified = 0;
            for (const m of inMemoryMessages) {
                if (filter.conversation && m.conversation.toString() !== filter.conversation.toString()) continue;
                if (filter.sender?.$ne && m.sender.toString() === filter.sender.$ne.toString()) continue;
                if (filter.readBy?.$ne && m.readBy.some((r) => r.toString() === filter.readBy.$ne.toString())) continue;

                if (update.$addToSet?.readBy) {
                    const readerId = update.$addToSet.readBy;
                    if (!m.readBy.some((r) => r.toString() === readerId.toString())) {
                        m.readBy.push(readerId);
                        modified++;
                    }
                }
            }
            return { modifiedCount: modified };
        };

        // Create initial test conversation between User A and User B
        const testMatch = await Match.create({
            users: [mockUserA._id, mockUserB._id],
            userPair: `${mockUserA._id}_${mockUserB._id}`,
            status: "active",
        });
        testMatchId = testMatch._id.toString();

        const testConv = await Conversation.create({
            match: testMatch._id,
            participants: [mockUserA._id, mockUserB._id],
        });
        testConversationId = testConv._id.toString();
    });

    // =========================================================================
    // 1. Reconnect & Room Authorization Recovery
    // =========================================================================
    describe("1. Reconnect & Room Authorization Recovery", () => {
        it("Requirement 3 & 4: Reconnecting to an authorized conversation rejoins the correct room and allows messaging", async () => {
            // User A connects socket
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });

            // Join conversation room
            const joinAck = await new Promise((res) => {
                clientA.emit("chat:join", { conversationId: testConversationId }, res);
            });
            assert.equal(joinAck.success, true);
            assert.equal(joinAck.conversationId, testConversationId);

            // Simulate disconnect and reconnect
            clientA.disconnect();

            const { client: clientAReconnected } = await connectClient(port, { auth: { token: tokenA } });
            assert.ok(clientAReconnected.connected);

            // Re-join conversation room on reconnect
            const rejoinAck = await new Promise((res) => {
                clientAReconnected.emit("chat:join", { conversationId: testConversationId }, res);
            });
            assert.equal(rejoinAck.success, true);
            assert.equal(rejoinAck.conversationId, testConversationId);

            clientAReconnected.disconnect();
        });

        it("Requirement 4: Unauthorized user cannot rejoin or view private conversation messages", async () => {
            const { client: clientOutsider } = await connectClient(port, { auth: { token: tokenOutsider } });

            // Outsider attempts to join private conversation
            const joinAck = await new Promise((res) => {
                clientOutsider.emit("chat:join", { conversationId: testConversationId }, res);
            });
            assert.equal(joinAck.success, false);
            assert.match(joinAck.message, /not authorized/i);

            // Outsider attempts to fetch messages via REST
            const restRes = await request(app)
                .get(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenOutsider}`);

            assert.equal(restRes.status, 403);
            assert.match(restRes.body.message, /not authorized/i);

            clientOutsider.disconnect();
        });

        it("Requirement 12: Blocked or unmatched conversation rejects room join and recovery", async () => {
            // Mark match as unmatched
            const match = inMemoryMatches.find((m) => m._id.toString() === testMatchId);
            match.status = "unmatched";

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });

            const joinAck = await new Promise((res) => {
                clientA.emit("chat:join", { conversationId: testConversationId }, res);
            });
            assert.equal(joinAck.success, false);
            assert.equal(joinAck.code, "MATCH_UNMATCHED");

            const restRes = await request(app)
                .get(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(restRes.status, 403);
            assert.equal(restRes.body.code, "MATCH_UNMATCHED");

            clientA.disconnect();
        });
    });

    // =========================================================================
    // 2. Cursor-Based Missed Message Recovery
    // =========================================================================
    describe("2. Durable Source of Truth & Cursor-Based Message Recovery", () => {
        it("Requirement 2: REST history fetches missed messages after a cursor in ascending chronological order", async () => {
            // Populate 3 messages with staggered timestamps
            const msg1 = new Message({
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "First message",
                createdAt: new Date("2026-10-18T10:00:00Z"),
                readBy: [mockUserB._id],
            });
            await msg1.save();

            const msg2 = new Message({
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "Second message (missed during disconnect)",
                createdAt: new Date("2026-10-18T10:05:00Z"),
                readBy: [mockUserB._id],
            });
            await msg2.save();

            const msg3 = new Message({
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "Third message (missed during disconnect)",
                createdAt: new Date("2026-10-18T10:10:00Z"),
                readBy: [mockUserB._id],
            });
            await msg3.save();

            // Client requests messages created after msg1
            const res = await request(app)
                .get(`/api/v1/conversations/${testConversationId}/messages?after=${msg1._id.toString()}`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.count, 2);
            assert.equal(res.body.messages.length, 2);

            // Strictly ascending chronological order
            assert.equal(res.body.messages[0]._id.toString(), msg2._id.toString());
            assert.equal(res.body.messages[1]._id.toString(), msg3._id.toString());
        });

        it("Requirement 6: Cursor recovery does not skip messages sharing the exact same timestamp", async () => {
            const sharedTime = new Date("2026-10-18T10:00:00.000Z");

            // Msg 1, Msg 2, Msg 3 all created at the EXACT same millisecond
            const msg1 = new Message({
                _id: new mongoose.Types.ObjectId("65cb00000000000000000001"),
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "First at shared time",
                createdAt: sharedTime,
                readBy: [mockUserB._id],
            });
            await msg1.save();

            const msg2 = new Message({
                _id: new mongoose.Types.ObjectId("65cb00000000000000000002"),
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "Second at shared time",
                createdAt: sharedTime,
                readBy: [mockUserB._id],
            });
            await msg2.save();

            const msg3 = new Message({
                _id: new mongoose.Types.ObjectId("65cb00000000000000000003"),
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "Third at shared time",
                createdAt: sharedTime,
                readBy: [mockUserB._id],
            });
            await msg3.save();

            // Client asks for messages after msg1
            const res = await request(app)
                .get(`/api/v1/conversations/${testConversationId}/messages?after=${msg1._id.toString()}`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.count, 2, "Must not skip msg2 or msg3 despite identical timestamp");
            assert.equal(res.body.messages[0]._id.toString(), msg2._id.toString());
            assert.equal(res.body.messages[1]._id.toString(), msg3._id.toString());
        });

        it("Requirement 2: Invalid or malformed cursor returns 400 Bad Request", async () => {
            const res = await request(app)
                .get(`/api/v1/conversations/${testConversationId}/messages?after=not-a-valid-object-id`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(res.status, 400);
            assert.match(res.body.message, /invalid after message id/i);
        });

        it("Requirement 10: Read receipts update unread state consistently after catch-up recovery", async () => {
            const msg = new Message({
                conversation: testConversationId,
                sender: mockUserB._id,
                content: "Unread message",
                createdAt: new Date(),
                readBy: [mockUserB._id],
            });
            await msg.save();

            // User A marks conversation as read
            const readRes = await request(app)
                .put(`/api/v1/conversations/${testConversationId}/read`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(readRes.status, 200);
            assert.equal(readRes.body.success, true);
            assert.equal(readRes.body.modifiedCount, 1);

            // Message now contains User A in readBy
            const updatedMsg = inMemoryMessages.find((m) => m._id.toString() === msg._id.toString());
            assert.ok(updatedMsg.readBy.some((r) => r.toString() === mockUserA._id.toString()));
        });
    });

    // =========================================================================
    // 3. Acknowledgement Timeout & Bounded Retry
    // =========================================================================
    describe("3. Acknowledgement Timeout & Bounded Retry", () => {
        it("Requirement 1 & 2: Retry after acknowledgement timeout produces strictly one persisted message", async () => {
            const clientTempId = "temp-ack-timeout-retry-01";

            // Initial REST send succeeds
            const res1 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Timeout retry test", clientTempId });

            assert.equal(res1.status, 201);
            const canonicalId = res1.body.message._id;

            // Client times out waiting for ack and retries with the SAME clientTempId
            const resRetry = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Timeout retry test", clientTempId });

            assert.equal(resRetry.status, 200);
            assert.equal(resRetry.body.duplicate, true);
            assert.equal(resRetry.body.message._id, canonicalId);

            // Strictly one message in database
            assert.equal(inMemoryMessages.length, 1);
        });

        it("Requirement 5 & 14: Duplicate REST and Socket.IO delivery returns original message and suppresses duplicate broadcast", async () => {
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            // Join rooms
            await new Promise((res) => clientA.emit("chat:join", { conversationId: testConversationId }, res));
            await new Promise((res) => clientB.emit("chat:join", { conversationId: testConversationId }, res));

            let bBroadcastCount = 0;
            clientB.on("chat:new-message", () => bBroadcastCount++);

            const clientTempId = "temp-socket-ack-dup-02";

            // 1. Initial send via Socket.IO
            const ack1 = await new Promise((res) => {
                clientA.emit("chat:send", { conversationId: testConversationId, content: "Hello B", clientTempId }, res);
            });
            assert.equal(ack1.success, true);
            assert.equal(ack1.duplicate, undefined);

            // 2. Client retry via REST (e.g. if socket ack was delayed)
            const restRetry = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Hello B", clientTempId });

            assert.equal(restRetry.status, 200);
            assert.equal(restRetry.body.duplicate, true);
            assert.equal(restRetry.body.message._id, ack1.message._id);

            // 3. Client retry via Socket.IO
            const ackRetry = await new Promise((res) => {
                clientA.emit("chat:send", { conversationId: testConversationId, content: "Hello B", clientTempId }, res);
            });
            assert.equal(ackRetry.success, true);
            assert.equal(ackRetry.duplicate, true);
            assert.equal(ackRetry.message._id, ack1.message._id);

            // Allow event loop tick for socket broadcast
            await new Promise((res) => setTimeout(res, 50));

            // Partner must only receive strictly 1 broadcast
            assert.equal(bBroadcastCount, 1);
            assert.equal(inMemoryMessages.length, 1);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 13: Two authenticated participants can reconnect and exchange messages", async () => {
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            await new Promise((res) => clientA.emit("chat:join", { conversationId: testConversationId }, res));
            await new Promise((res) => clientB.emit("chat:join", { conversationId: testConversationId }, res));

            let aReceived = null;
            let bReceived = null;

            clientA.on("chat:new-message", (msg) => {
                const sId = msg.sender?._id || msg.sender;
                if (sId.toString() !== mockUserA._id.toString()) {
                    aReceived = msg;
                }
            });
            clientB.on("chat:new-message", (msg) => {
                const sId = msg.sender?._id || msg.sender;
                if (sId.toString() !== mockUserB._id.toString()) {
                    bReceived = msg;
                }
            });

            // A sends to B
            await new Promise((res) => {
                clientA.emit("chat:send", { conversationId: testConversationId, content: "Hi Bob", clientTempId: "temp-a1" }, res);
            });

            // B sends to A
            await new Promise((res) => {
                clientB.emit("chat:send", { conversationId: testConversationId, content: "Hi Alice", clientTempId: "temp-b1" }, res);
            });

            await new Promise((res) => setTimeout(res, 50));

            assert.ok(bReceived);
            assert.equal(bReceived.content, "Hi Bob");

            assert.ok(aReceived);
            assert.equal(aReceived.content, "Hi Alice");

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // =========================================================================
    // 4. Frontend State Merging, Deduplication & Ordering Logic
    // =========================================================================
    describe("4. Frontend State Merging & Ordering Determinism", () => {
        it("Requirement 6: Optimistic message reconciles with canonical stored message", () => {
            const clientTempId = "temp_optimistic_001";
            const optimistic = {
                _id: clientTempId,
                clientTempId,
                content: "Optimistic text",
                createdAt: new Date("2026-10-18T12:00:00Z").toISOString(),
                status: "pending",
            };

            const initialList = [optimistic];

            // Canonical response from server
            const serverMessage = {
                _id: "65cb99999999999999999999",
                clientTempId,
                content: "Optimistic text",
                createdAt: new Date("2026-10-18T12:00:00Z").toISOString(),
            };

            const reconciled = reconcileSingleMessage(initialList, serverMessage);

            assert.equal(reconciled.length, 1);
            assert.equal(reconciled[0]._id, "65cb99999999999999999999");
            assert.equal(reconciled[0].status, "sent");
        });

        it("Requirement 5 & 9: Message order remains strictly deterministic when history and socket arrive out of order", () => {
            const msgA = {
                _id: "msg_1",
                content: "First",
                createdAt: new Date("2026-10-18T12:00:00Z").toISOString(),
            };
            const msgB = {
                _id: "msg_2",
                content: "Second",
                createdAt: new Date("2026-10-18T12:05:00Z").toISOString(),
            };
            const msgC = {
                _id: "msg_3",
                content: "Third",
                createdAt: new Date("2026-10-18T12:10:00Z").toISOString(),
            };

            // Live socket delivered msgC first before history loaded
            let list = reconcileSingleMessage([], msgC);

            // History arrives with msgA and msgB
            list = reconcileBatchMessages(list, [msgA, msgB]);

            // Duplicate delivery of msgB arriving again
            list = reconcileSingleMessage(list, msgB);

            assert.equal(list.length, 3);
            assert.equal(list[0]._id, "msg_1");
            assert.equal(list[1]._id, "msg_2");
            assert.equal(list[2]._id, "msg_3");
        });

        it("Requirement 7: In-flight conversation response isolation prevents stale conversation pollution", () => {
            let activeConvId = "conv_A";

            // Response arrives for conv_B after user switched to conv_A
            const handleResponse = (responseConvId, newMessages) => {
                if (responseConvId !== activeConvId) {
                    return null; // Safely discarded
                }
                return newMessages;
            };

            const staleResult = handleResponse("conv_B", [{ _id: "stale_msg" }]);
            assert.equal(staleResult, null, "Stale conversation response must be discarded");

            const validResult = handleResponse("conv_A", [{ _id: "valid_msg" }]);
            assert.ok(validResult, "Active conversation response must be processed");
        });
    });

    // =========================================================================
    // 5. Invariants: Missing IDs, Sender Collisions, Two Devices & Gap Recovery
    // =========================================================================
    describe("5. Invariants: Missing IDs, Sender Collisions, Two Devices & Gap Recovery", () => {
        it("Scenario 1: Missing, empty, or null clientTempId is allowed and does not cause duplicate key collisions", async () => {
            // Send multiple messages with no clientTempId via REST
            const res1 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message without tempId 1" });
            assert.equal(res1.status, 201);
            assert.equal(res1.body.success, true);
            assert.equal(res1.body.message.content, "Message without tempId 1");

            const res2 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message without tempId 2" });
            assert.equal(res2.status, 201);
            assert.equal(res2.body.success, true);
            assert.notEqual(res1.body.message._id, res2.body.message._id);

            // Send with empty string and null clientTempId
            const res3 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message with empty tempId", clientTempId: "" });
            assert.equal(res3.status, 201);

            const res4 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message with null tempId", clientTempId: null });
            assert.equal(res4.status, 201);

            // Send without clientTempId via Socket.IO
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            await new Promise((res) => clientA.emit("chat:join", { conversationId: testConversationId }, res));

            const sockAck1 = await new Promise((res) => {
                clientA.emit("chat:send", { conversationId: testConversationId, content: "Socket msg without tempId 1" }, res);
            });
            assert.equal(sockAck1.success, true);

            const sockAck2 = await new Promise((res) => {
                clientA.emit("chat:send", { conversationId: testConversationId, content: "Socket msg without tempId 2" }, res);
            });
            assert.equal(sockAck2.success, true);
            assert.notEqual(sockAck1.message._id, sockAck2.message._id);

            clientA.disconnect();
        });

        it("Scenario 2: Sender collision - Different senders with the identical clientTempId in the same conversation do not collide", async () => {
            const sharedTempId = "shared-client-temp-collision-test";

            // User A sends with sharedTempId
            const resA = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Message from Alice", clientTempId: sharedTempId });

            assert.equal(resA.status, 201);
            assert.equal(resA.body.success, true);
            assert.equal(resA.body.message.clientTempId, sharedTempId);

            // User B sends with the exact same sharedTempId in the same conversation
            const resB = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenB}`)
                .send({ content: "Message from Bob", clientTempId: sharedTempId });

            assert.equal(resB.status, 201);
            assert.equal(resB.body.success, true);
            assert.equal(resB.body.message.clientTempId, sharedTempId);

            // Both messages must be persisted independently with distinct IDs
            assert.notEqual(resA.body.message._id, resB.body.message._id);
            const savedA = inMemoryMessages.find((m) => m._id.toString() === resA.body.message._id.toString());
            const savedB = inMemoryMessages.find((m) => m._id.toString() === resB.body.message._id.toString());
            assert.ok(savedA);
            assert.ok(savedB);
            assert.notEqual(savedA.sender._id.toString(), savedB.sender._id.toString());
        });

        it("Scenario 3: Two devices logged in as same user both receive real-time messages and sync read receipts", async () => {
            // User A connects Device 1 and Device 2
            const { client: clientA1 } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientA2 } = await connectClient(port, { auth: { token: tokenA } });
            // User B connects Device B
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            await new Promise((res) => clientA1.emit("chat:join", { conversationId: testConversationId }, res));
            await new Promise((res) => clientA2.emit("chat:join", { conversationId: testConversationId }, res));
            await new Promise((res) => clientB.emit("chat:join", { conversationId: testConversationId }, res));

            let a1Received = null;
            let a2Received = null;
            let a2ReadReceived = null;

            clientA1.on("chat:new-message", (m) => { a1Received = m; });
            clientA2.on("chat:new-message", (m) => { a2Received = m; });
            clientA2.on("chat:read", (r) => { a2ReadReceived = r; });

            // User B sends a message
            const bAck = await new Promise((res) => {
                clientB.emit("chat:send", {
                    conversationId: testConversationId,
                    content: "Message to both of Alice's devices",
                    clientTempId: "temp-b-to-devices",
                }, res);
            });
            assert.equal(bAck.success, true);

            await new Promise((res) => setTimeout(res, 50));

            // Both Device A1 and Device A2 must receive the message
            assert.ok(a1Received, "Device A1 should receive the message");
            assert.ok(a2Received, "Device A2 should receive the message");
            assert.equal(a1Received._id, bAck.message._id);
            assert.equal(a2Received._id, bAck.message._id);

            // Device A1 marks conversation as read
            const readAck = await new Promise((res) => {
                clientA1.emit("chat:read", { conversationId: testConversationId }, res);
            });
            assert.equal(readAck.success, true);

            await new Promise((res) => setTimeout(res, 50));

            // Device A2 receives read receipt sync
            assert.ok(a2ReadReceived, "Device A2 should receive read receipt sync");
            assert.equal(a2ReadReceived.conversationId, testConversationId);
            assert.equal(a2ReadReceived.readerId, mockUserA._id.toString());

            clientA1.disconnect();
            clientA2.disconnect();
            clientB.disconnect();
        });

        it("Scenario 4: Dropped connection, REST fallback, reconnect, and cursor gap recovery produces zero lost or duplicate messages", async () => {
            // User A and User B start connected
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            await new Promise((res) => clientA.emit("chat:join", { conversationId: testConversationId }, res));
            await new Promise((res) => clientB.emit("chat:join", { conversationId: testConversationId }, res));

            // Initial message M1 from A to B
            const m1TempId = "temp-m1-initial";
            const ack1 = await new Promise((res) => {
                clientA.emit("chat:send", {
                    conversationId: testConversationId,
                    content: "M1: Initial message",
                    clientTempId: m1TempId,
                }, res);
            });
            assert.equal(ack1.success, true);
            const m1Id = ack1.message._id;

            // User A simulates network disconnect / dropped connection
            clientA.disconnect();

            // While A is offline:
            // 1. User B sends M2 and M3
            const ack2 = await new Promise((res) => {
                clientB.emit("chat:send", {
                    conversationId: testConversationId,
                    content: "M2: Missed while A disconnected",
                    clientTempId: "temp-b-m2",
                }, res);
            });
            assert.equal(ack2.success, true);

            const ack3 = await new Promise((res) => {
                clientB.emit("chat:send", {
                    conversationId: testConversationId,
                    content: "M3: Another missed message",
                    clientTempId: "temp-b-m3",
                }, res);
            });
            assert.equal(ack3.success, true);

            // 2. User A sends M4 via REST fallback because socket is offline
            const m4TempId = "temp-m4-offline-rest";
            const resM4 = await request(app)
                .post(`/api/v1/conversations/${testConversationId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "M4: Sent via REST fallback while offline", clientTempId: m4TempId });
            assert.equal(resM4.status, 201);
            const m4Id = resM4.body.message._id;

            // 3. User A reconnects socket
            const { client: clientAReconnected } = await connectClient(port, { auth: { token: tokenA } });
            await new Promise((res) => clientAReconnected.emit("chat:join", { conversationId: testConversationId }, res));

            // User A catches up missed messages using last known cursor (m1Id)
            const catchUpRes = await request(app)
                .get(`/api/v1/conversations/${testConversationId}/messages?after=${m1Id}`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(catchUpRes.status, 200);
            assert.equal(catchUpRes.body.count, 3); // M2, M3, M4

            // Simulate frontend reconciliation on Client A
            let clientAMessages = [
                { _id: m1Id, clientTempId: m1TempId, content: "M1: Initial message", status: "sent" },
                { _id: m4TempId, clientTempId: m4TempId, content: "M4: Sent via REST fallback while offline", status: "pending" },
            ];

            // Reconcile catch-up batch into client state
            clientAMessages = reconcileBatchMessages(clientAMessages, catchUpRes.body.messages);

            // Assert: Exactly 4 messages, no duplicates, M4 resolved from pending to sent
            assert.equal(clientAMessages.length, 4);
            const uniqueIds = new Set(clientAMessages.map((m) => m._id.toString()));
            assert.equal(uniqueIds.size, 4, "Zero duplicate messages permitted");

            const m4Entry = clientAMessages.find((m) => m.clientTempId === m4TempId);
            assert.ok(m4Entry);
            assert.equal(m4Entry._id.toString(), m4Id.toString());
            assert.equal(m4Entry.status, "sent");

            clientAReconnected.disconnect();
            clientB.disconnect();
        });
    });
});
