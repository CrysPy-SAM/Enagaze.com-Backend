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
import { MatchRequest } from "../src/models/matchRequest.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";
import { Block } from "../src/models/block.model.js";
import { Notification } from "../src/models/notification.model.js";

import matchRouter from "../src/routes/matches.routes.js";
import chatRouter from "../src/routes/chat.routes.js";
import notificationRouter from "../src/routes/notification.routes.js";
import webrtcRouter from "../src/routes/webrtc.routes.js";
import { _resetInMemoryNotifications } from "../src/services/notification.service.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

function connectClient(port, token) {
    return new Promise((resolve) => {
        const client = ioClient(`http://127.0.0.1:${port}`, {
            transports: ["polling"],
            forceNew: true,
            reconnection: false,
            timeout: 3000,
            auth: { token },
        });

        client.once("connect", () => resolve({ client, error: null }));
        client.once("connect_error", (err) => resolve({ client, error: err }));
    });
}

describe("Prompt 10: Consent-Based Match Requests, Connections, Chat & Video Calling Suite", () => {
    let server;
    let ioServer;
    let port;
    let app;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65cf11111111111111111111"),
        name: "Alice Adams",
        username: "alice_a",
        dob: new Date("1996-03-15"),
        gender: "female",
        bio: "Photographer & coffee enthusiast",
        photos: ["https://example.com/alice.jpg"],
        interests: ["photography", "coffee"],
        isProfileComplete: true,
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65cf22222222222222222222"),
        name: "Ben Baker",
        username: "ben_b",
        dob: new Date("1994-07-22"),
        gender: "male",
        bio: "Hiker & musician",
        photos: ["https://example.com/ben.jpg"],
        interests: ["hiking", "music"],
        isProfileComplete: true,
    };

    const mockUserC = {
        _id: new mongoose.Types.ObjectId("65cf33333333333333333333"),
        name: "Chloe Clark",
        username: "chloe_c",
        dob: new Date("1997-11-05"),
        gender: "female",
        bio: "Designer & traveler",
        photos: ["https://example.com/chloe.jpg"],
        interests: ["design", "travel"],
        isProfileComplete: true,
    };

    const tokenA = makeToken({ id: mockUserA._id.toString(), username: mockUserA.username });
    const tokenB = makeToken({ id: mockUserB._id.toString(), username: mockUserB.username });
    const tokenC = makeToken({ id: mockUserC._id.toString(), username: mockUserC.username });

    const userMap = {
        [mockUserA._id.toString()]: { ...mockUserA },
        [mockUserB._id.toString()]: { ...mockUserB },
        [mockUserC._id.toString()]: { ...mockUserC },
    };

    let inMemoryRequests = [];
    let inMemoryMatches = [];
    let inMemoryConversations = [];
    let inMemoryMessages = [];
    let inMemoryBlocks = [];

    before(async () => {
        app = express();
        app.use(express.json());

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        // Mount API routes
        app.use("/api/v1/matches", matchRouter);
        app.use("/api/v1/conversations", chatRouter);
        app.use("/api/v1/notifications", notificationRouter);
        app.use("/api/v1/webrtc", webrtcRouter);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });

        // Setup User and Block mocks
        User.findById = (id) => {
            const found = userMap[id?.toString()];
            return {
                select: () => Promise.resolve(found ? { ...found } : null),
                populate: () => Promise.resolve(found ? { ...found } : null),
                then: (resolve) => resolve(found ? { ...found } : null),
            };
        };

        User.find = (filter) => {
            let list = Object.values(userMap);
            if (filter?._id?.$in) {
                const idSet = new Set(filter._id.$in.map((i) => i.toString()));
                list = list.filter((u) => idSet.has(u._id.toString()));
            }
            return {
                select: () => Promise.resolve(list.map((u) => ({ ...u }))),
                then: (resolve) => resolve(list.map((u) => ({ ...u }))),
            };
        };

        Block.getBlockedUserIds = async (userId) => {
            const uStr = userId?.toString();
            const blocked = [];
            for (const b of inMemoryBlocks) {
                if (b.blocker.toString() === uStr) blocked.push(b.blocked);
                if (b.blocked.toString() === uStr) blocked.push(b.blocker);
            }
            return blocked;
        };

        Block.isBlockedBidirectional = async (u1, u2) => {
            const s1 = u1?.toString();
            const s2 = u2?.toString();
            return inMemoryBlocks.some(
                (b) => (b.blocker.toString() === s1 && b.blocked.toString() === s2) ||
                       (b.blocker.toString() === s2 && b.blocked.toString() === s1)
            );
        };
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        inMemoryRequests = [];
        inMemoryMatches = [];
        inMemoryConversations = [];
        inMemoryMessages = [];
        inMemoryBlocks = [];
        _resetInMemoryNotifications();

        // Mock MatchRequest
        MatchRequest.find = (filter = {}) => {
            let res = [...inMemoryRequests];
            if (filter.recipient) {
                res = res.filter((r) => r.recipient.toString() === filter.recipient.toString());
            }
            if (filter.sender) {
                res = res.filter((r) => r.sender.toString() === filter.sender.toString());
            }
            if (filter.status) {
                res = res.filter((r) => r.status === filter.status);
            }
            return {
                sort: () => ({
                    populate: () => Promise.resolve(res.map((r) => ({
                        ...r,
                        sender: userMap[r.sender.toString()],
                        recipient: userMap[r.recipient.toString()],
                    }))),
                    then: (resolve) => resolve(res),
                }),
                then: (resolve) => resolve(res),
            };
        };

        MatchRequest.findById = (id) => {
            const found = inMemoryRequests.find((r) => r._id.toString() === id?.toString());
            return {
                populate: () => Promise.resolve(found ? {
                    ...found,
                    sender: userMap[found.sender.toString()],
                    recipient: userMap[found.recipient.toString()],
                } : null),
                then: (resolve) => resolve(found ? { ...found } : null),
            };
        };

        MatchRequest.findOne = (filter = {}) => {
            const findRecord = () => {
                const matches = inMemoryRequests.filter((r) => {
                    if (filter.sender && r.sender.toString() !== filter.sender.toString()) return false;
                    if (filter.recipient && r.recipient.toString() !== filter.recipient.toString()) return false;
                    if (filter.status && r.status !== filter.status) return false;
                    if (filter.userPair && r.userPair !== filter.userPair) return false;
                    return true;
                });
                return matches.length > 0 ? { ...matches[matches.length - 1] } : null;
            };

            return {
                sort: () => ({
                    then: (resolve) => resolve(findRecord()),
                }),
                then: (resolve) => resolve(findRecord()),
            };
        };

        MatchRequest.create = async (doc) => {
            const exists = inMemoryRequests.some(
                (r) => r.sender.toString() === doc.sender.toString() &&
                       r.recipient.toString() === doc.recipient.toString() &&
                       r.status === "pending"
            );
            if (exists) {
                const err = new Error("E11000 duplicate key error");
                err.code = 11000;
                throw err;
            }
            const record = {
                _id: new mongoose.Types.ObjectId(),
                sender: doc.sender,
                recipient: doc.recipient,
                userPair: doc.userPair || MatchRequest.getCanonicalPair(doc.sender, doc.recipient),
                status: doc.status || "pending",
                message: doc.message || "",
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            inMemoryRequests.push(record);
            return record;
        };

        MatchRequest.findOneAndUpdate = async (filter, update) => {
            const found = inMemoryRequests.find((r) => {
                if (filter._id && r._id.toString() !== filter._id.toString()) return false;
                if (filter.recipient && r.recipient.toString() !== filter.recipient.toString()) return false;
                if (filter.status && r.status !== filter.status) return false;
                return true;
            });
            if (!found) return null;
            if (update.status) found.status = update.status;
            if (update.respondedAt) found.respondedAt = update.respondedAt;
            found.updatedAt = new Date();
            return { ...found };
        };

        // Mock Match
        Match.find = (filter = {}) => {
            let res = [...inMemoryMatches];
            if (filter.users) {
                let targetId = filter.users;
                if (filter.users.$all) {
                    targetId = filter.users.$all[0];
                }
                const targetStr = targetId.toString();
                res = res.filter((m) => m.users.some((u) => u.toString() === targetStr));
            }
            if (filter.status) {
                res = res.filter((m) => m.status === filter.status);
            }
            const populated = res.map((m) => ({
                ...m,
                users: m.users.map((u) => userMap[u.toString()] || u),
            }));
            return {
                sort: () => ({
                    skip: () => ({
                        limit: () => ({
                            populate: () => Promise.resolve(populated),
                            then: (resolve) => resolve(populated),
                        }),
                    }),
                }),
                select: () => Promise.resolve(populated),
                then: (resolve) => resolve(populated),
            };
        };

        Match.findById = (id) => {
            const found = inMemoryMatches.find((m) => m._id.toString() === id?.toString());
            return {
                select: () => Promise.resolve(found ? { ...found } : null),
                populate: () => Promise.resolve(found ? {
                    ...found,
                    users: found.users.map((u) => userMap[u.toString()]),
                } : null),
                then: (resolve) => resolve(found ? { ...found } : null),
            };
        };

        Match.findOne = async (filter = {}) => {
            return inMemoryMatches.find((m) => {
                if (filter._id && m._id.toString() !== filter._id.toString()) return false;
                if (filter.userPair && m.userPair !== filter.userPair) return false;
                if (filter.status && m.status !== filter.status) return false;
                return true;
            }) || null;
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

        Match.countDocuments = async () => inMemoryMatches.length;

        // Mock Conversation
        Conversation.find = (filter = {}) => {
            let res = [...inMemoryConversations];
            if (filter.participants) {
                const pStr = filter.participants.toString();
                res = res.filter((c) => c.participants.some((p) => p.toString() === pStr));
            }
            return {
                sort: () => ({
                    populate: () => ({
                        populate: () => ({
                            populate: () => Promise.resolve(res.map((c) => ({
                                ...c,
                                match: inMemoryMatches.find((m) => m._id.toString() === c.match?.toString()),
                                participants: c.participants.map((p) => userMap[p.toString()]),
                            }))),
                        }),
                    }),
                }),
                select: () => Promise.resolve(res),
                then: (resolve) => resolve(res),
            };
        };

        Conversation.findById = (id) => {
            const found = inMemoryConversations.find((c) => c._id.toString() === id?.toString());
            return Promise.resolve(found ? { ...found } : null);
        };

        Conversation.findOne = async (filter = {}) => {
            const found = inMemoryConversations.find((c) => {
                if (filter.match && c.match.toString() !== filter.match.toString()) return false;
                return true;
            });
            return found ? { ...found, save: async () => found } : null;
        };

        Conversation.create = async (doc) => {
            const record = {
                _id: new mongoose.Types.ObjectId(),
                match: doc.match,
                participants: doc.participants,
                lastMessage: null,
                lastMessageAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                save: async () => record,
            };
            inMemoryConversations.push(record);
            return record;
        };

        // Mock Message prototype and class methods
        Message.countDocuments = async () => inMemoryMessages.length;
        Message.find = () => ({
            sort: () => ({
                limit: () => ({
                    populate: () => Promise.resolve(inMemoryMessages),
                }),
                skip: () => ({
                    limit: () => ({
                        populate: () => Promise.resolve(inMemoryMessages),
                    }),
                }),
            }),
        });
        Message.findOne = async () => null;

        Message.prototype.populate = async function () {
            const senderIdStr = this.sender ? (this.sender._id ? this.sender._id.toString() : this.sender.toString()) : "";
            this.sender = userMap[senderIdStr] || { _id: this.sender, name: "Test User" };
            return this;
        };

        Message.prototype.save = async function () {
            this._id = this._id || new mongoose.Types.ObjectId();
            this.createdAt = this.createdAt || new Date();
            inMemoryMessages.push(this);
            return this;
        };
    });

    // =========================================================================
    // 1. MATCH REQUEST CREATION & NOTIFICATIONS
    // =========================================================================
    describe("1. Match Request Creation, Notifications & Deduplication", () => {
        it("Requirement 1: User A sends Match Request to User B; B receives real-time event and persistent notification", async () => {
            const { client: clientB } = await connectClient(port, tokenB);

            const bRequestEvents = [];
            const bNotifEvents = [];

            clientB.on("match_request:new", (data) => bRequestEvents.push(data));
            clientB.on("notification:new", (data) => bNotifEvents.push(data));

            // User A sends match request to User B
            const res = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    recipientId: mockUserB._id.toString(),
                    message: "Hey Ben, love your music tastes!",
                });

            assert.equal(res.status, 201);
            assert.equal(res.body.success, true);
            assert.equal(res.body.request.status, "pending");
            assert.ok(res.body.request._id);

            // Verify strictly 1 pending MatchRequest created
            assert.equal(inMemoryRequests.length, 1);
            assert.equal(inMemoryRequests[0].status, "pending");
            assert.equal(inMemoryRequests[0].sender.toString(), mockUserA._id.toString());
            assert.equal(inMemoryRequests[0].recipient.toString(), mockUserB._id.toString());

            // Inactive match check: NO active Match or Conversation should exist before acceptance!
            assert.equal(inMemoryMatches.length, 0);
            assert.equal(inMemoryConversations.length, 0);

            await new Promise((r) => setTimeout(r, 80));

            // Verify real-time socket events delivered to B
            assert.equal(bRequestEvents.length, 1);
            assert.equal(bRequestEvents[0].request.sender._id, mockUserA._id.toString());
            assert.equal(bNotifEvents.length, 1);
            assert.equal(bNotifEvents[0].notification.type, "match_request");

            // Verify persistent in-app notification in B's notifications endpoint
            const notifRes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(notifRes.status, 200);
            const reqNotif = notifRes.body.notifications.find((n) => n.type === "match_request");
            assert.ok(reqNotif, "User B must have persistent match_request notification");
            assert.equal(reqNotif.sender._id, mockUserA._id.toString());

            clientB.disconnect();
        });

        it("Requirement 8 & 9: Reject self-requests, unauthorized requests, and invalid target users", async () => {
            // Self-request
            const selfRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ recipientId: mockUserA._id.toString() });

            assert.equal(selfRes.status, 400);
            assert.match(selfRes.body.message, /yourself/i);

            // Unauthorized request
            const noAuthRes = await request(app)
                .post("/api/v1/matches/requests")
                .send({ recipientId: mockUserB._id.toString() });

            assert.equal(noAuthRes.status, 401);

            // Nonexistent target
            const fakeId = new mongoose.Types.ObjectId().toString();
            const notFoundRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ recipientId: fakeId });

            assert.equal(notFoundRes.status, 404);
        });

        it("Requirement 10: Duplicate pending requests are handled idempotently without duplicating records", async () => {
            // First request
            await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ recipientId: mockUserB._id.toString() });

            assert.equal(inMemoryRequests.length, 1);

            // Duplicate attempt
            const dupRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ recipientId: mockUserB._id.toString() });

            assert.equal(dupRes.status, 200);
            assert.equal(dupRes.body.duplicate, true);
            assert.equal(inMemoryRequests.length, 1, "Must not create duplicate request record");
        });
    });

    // =========================================================================
    // 2. PRE-ACCEPTANCE GATING: CHAT & VIDEO CALL STRICT LOCK
    // =========================================================================
    describe("2. Pre-Acceptance Gating: Chat and Video Calls Strictly Prohibited", () => {
        let pendingRequestId;

        beforeEach(async () => {
            const reqDoc = await MatchRequest.create({
                sender: mockUserA._id,
                recipient: mockUserB._id,
                status: "pending",
            });
            pendingRequestId = reqDoc._id.toString();
        });

        it("Requirement 6: Before acceptance, neither user can send messages or access private conversation", async () => {
            // A tries to fetch conversations
            const aConvs = await request(app)
                .get("/api/v1/conversations")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(aConvs.status, 200);
            assert.equal(aConvs.body.conversations.length, 0, "No conversations before acceptance");

            // B tries to fetch conversations
            const bConvs = await request(app)
                .get("/api/v1/conversations")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(bConvs.status, 200);
            assert.equal(bConvs.body.conversations.length, 0);

            // Fabricate attempt to get messages on non-existent or unaccepted match
            const fakeConvId = new mongoose.Types.ObjectId().toString();
            const msgFetchRes = await request(app)
                .get(`/api/v1/conversations/${fakeConvId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(msgFetchRes.status, 404);

            // Socket attempt to join conversation
            const { client: clientA } = await connectClient(port, tokenA);
            const joinAck = await new Promise((res) => {
                clientA.emit("chat:join", { conversationId: fakeConvId }, res);
            });
            assert.equal(joinAck.success, false);

            clientA.disconnect();
        });

        it("Requirement 7: Before acceptance, neither user can initiate or join a video call", async () => {
            // REST call access verification
            const verifyResA = await request(app)
                .get(`/api/v1/webrtc/verify-access/${mockUserB._id.toString()}`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(verifyResA.status, 403);
            assert.equal(verifyResA.body.code, "CALL_UNAUTHORIZED");

            const verifyResB = await request(app)
                .get(`/api/v1/webrtc/verify-access/${mockUserA._id.toString()}`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(verifyResB.status, 403);
            assert.equal(verifyResB.body.code, "CALL_UNAUTHORIZED");

            // Socket call:initiate attempt by A
            const { client: clientA } = await connectClient(port, tokenA);
            const callAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(callAck.success, false);
            assert.equal(callAck.code, "CALL_UNAUTHORIZED");

            // Socket call:signal attempt by B
            const signalAck = await new Promise((res) => {
                clientA.emit("call:signal", {
                    callId: "call_test123",
                    targetUserId: mockUserB._id.toString(),
                    signal: { type: "offer", sdp: "dummy" },
                }, res);
            });

            assert.equal(signalAck.success, false);
            assert.equal(signalAck.code, "CALL_UNAUTHORIZED");

            clientA.disconnect();
        });
    });

    // =========================================================================
    // 3. ACCEPTANCE WORKFLOW & CONNECTION ESTABLISHMENT
    // =========================================================================
    describe("3. Acceptance Workflow, Connection Creation & Access Unlocking", () => {
        let pendingRequestId;

        beforeEach(async () => {
            const reqDoc = await MatchRequest.create({
                sender: mockUserA._id,
                recipient: mockUserB._id,
                status: "pending",
            });
            pendingRequestId = reqDoc._id.toString();
        });

        it("Requirement 9: Third-party User C cannot accept User B's request (403 Forbidden)", async () => {
            const acceptRes = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/accept`)
                .set("Authorization", `Bearer ${tokenC}`);

            assert.equal(acceptRes.status, 403);
            assert.equal(acceptRes.body.code, "UNAUTHORIZED_RECIPIENT");
            assert.equal(inMemoryMatches.length, 0);
        });

        it("Requirement 2 & 3: User B accepts; connection established, A receives acceptance notification, both see active connection", async () => {
            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            const aAcceptEvents = [];
            const aMatchEvents = [];
            const bMatchEvents = [];

            clientA.on("match:accepted", (d) => aAcceptEvents.push(d));
            clientA.on("match:new", (d) => aMatchEvents.push(d));
            clientB.on("match:new", (d) => bMatchEvents.push(d));

            // User B accepts User A's request
            const acceptRes = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/accept`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(acceptRes.status, 200);
            assert.equal(acceptRes.body.success, true);
            assert.equal(acceptRes.body.isConnected, true);
            assert.ok(acceptRes.body.match._id);
            assert.ok(acceptRes.body.match.conversationId);

            // Exactly 1 canonical Match and 1 canonical Conversation created
            assert.equal(inMemoryMatches.length, 1);
            assert.equal(inMemoryMatches[0].status, "active");
            assert.equal(inMemoryConversations.length, 1);

            await new Promise((r) => setTimeout(r, 80));

            // Verify real-time socket events delivered
            assert.equal(aAcceptEvents.length, 1);
            assert.equal(aAcceptEvents[0].partner._id, mockUserB._id.toString());
            assert.equal(aMatchEvents.length, 1);
            assert.equal(bMatchEvents.length, 1);

            // Verify acceptance notification persisted for A
            const notifResA = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenA}`);

            const acceptNotif = notifResA.body.notifications.find((n) => n.type === "match_accepted");
            assert.ok(acceptNotif, "User A must receive persistent match_accepted notification");
            assert.equal(acceptNotif.sender._id, mockUserB._id.toString());

            // Requirement 3: Both users see the exact same active connection in /api/v1/matches
            const matchesA = await request(app)
                .get("/api/v1/matches")
                .set("Authorization", `Bearer ${tokenA}`);

            const matchesB = await request(app)
                .get("/api/v1/matches")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(matchesA.body.matches.length, 1);
            assert.equal(matchesB.body.matches.length, 1);
            assert.equal(matchesA.body.matches[0]._id, matchesB.body.matches[0]._id);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 4 & 5: After acceptance, both users can chat and video call", async () => {
            // First accept request to establish connection
            const acceptRes = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/accept`)
                .set("Authorization", `Bearer ${tokenB}`);

            const convId = acceptRes.body.match.conversationId;
            assert.ok(convId);

            // 1. Both can chat via REST
            const sendMsgRes = await request(app)
                .post(`/api/v1/conversations/${convId}/messages`)
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ content: "Hello Ben! Glad we connected." });

            assert.equal(sendMsgRes.status, 201);
            assert.equal(sendMsgRes.body.success, true);

            // 2. Verify REST call access permission is now allowed
            const verifyRes = await request(app)
                .get(`/api/v1/webrtc/verify-access/${mockUserB._id.toString()}`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(verifyRes.status, 200);
            assert.equal(verifyRes.body.allowed, true);

            // 3. Socket call:initiate and signaling succeed
            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let incomingCallData = null;
            clientB.on("call:incoming", (data) => {
                incomingCallData = data;
            });

            const callAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(callAck.success, true);
            assert.ok(callAck.callId);

            await new Promise((r) => setTimeout(r, 60));
            assert.ok(incomingCallData);
            assert.equal(incomingCallData.caller._id, mockUserA._id.toString());

            // Callee joins and signals
            const joinCallAck = await new Promise((res) => {
                clientB.emit("call:join", { callId: callAck.callId, targetUserId: mockUserA._id.toString() }, res);
            });
            assert.equal(joinCallAck.success, true);

            const signalAck = await new Promise((res) => {
                clientA.emit("call:signal", {
                    callId: callAck.callId,
                    targetUserId: mockUserB._id.toString(),
                    signal: { type: "offer", sdp: "dummy_sdp" },
                }, res);
            });
            assert.equal(signalAck.success, true);

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // =========================================================================
    // 4. DECLINE WORKFLOW & LOCK PRESERVATION
    // =========================================================================
    describe("4. Decline Workflow: Locks Preserved", () => {
        let pendingRequestId;

        beforeEach(async () => {
            const reqDoc = await MatchRequest.create({
                sender: mockUserA._id,
                recipient: mockUserB._id,
                status: "pending",
            });
            pendingRequestId = reqDoc._id.toString();
        });

        it("Requirement 9: User C cannot decline User B's request", async () => {
            const decRes = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/decline`)
                .set("Authorization", `Bearer ${tokenC}`);

            assert.equal(decRes.status, 403);
            assert.equal(decRes.body.code, "UNAUTHORIZED_RECIPIENT");
        });

        it("Requirement 11: User B declines; request removed from pending list, chat & calls remain strictly locked", async () => {
            // User B declines
            const decRes = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/decline`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(decRes.status, 200);
            assert.equal(decRes.body.success, true);

            // B's incoming pending list is now empty
            const incomingRes = await request(app)
                .get("/api/v1/matches/requests/incoming")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(incomingRes.body.requests.length, 0);

            // NO connection or conversation created
            assert.equal(inMemoryMatches.length, 0);
            assert.equal(inMemoryConversations.length, 0);

            // Video calls remain blocked
            const verifyCallRes = await request(app)
                .get(`/api/v1/webrtc/verify-access/${mockUserB._id.toString()}`)
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(verifyCallRes.status, 403);
            assert.equal(verifyCallRes.body.code, "CALL_UNAUTHORIZED");

            // Repeated decline is idempotent
            const repeatDec = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/decline`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(repeatDec.status, 200);
            assert.equal(repeatDec.body.duplicate, true);

            // Cannot accept a declined request
            const acceptAfterDec = await request(app)
                .post(`/api/v1/matches/requests/${pendingRequestId}/accept`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(acceptAfterDec.status, 409);
            assert.equal(acceptAfterDec.body.code, "INVALID_STATE_TRANSITION");
        });
    });

    // =========================================================================
    // 5. RECIPROCAL REQUESTS & SAFETY INVARIANTS
    // =========================================================================
    describe("5. Reciprocal Requests & Safety Invariants", () => {
        it("Reciprocal request: When B sends request to A while A's request to B is pending, establishes connection", async () => {
            // A sends to B
            await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ recipientId: mockUserB._id.toString() });

            // B sends to A (reciprocal intent)
            const recipRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenB}`)
                .send({ recipientId: mockUserA._id.toString() });

            assert.equal(recipRes.status, 200);
            assert.equal(recipRes.body.isConnected, true);
            assert.equal(recipRes.body.isMatch, true);
            assert.equal(inMemoryMatches.length, 1);
        });

        it("Blocked user cannot send match requests or be notified", async () => {
            inMemoryBlocks.push({
                blocker: mockUserB._id,
                blocked: mockUserA._id,
            });

            const reqRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ recipientId: mockUserB._id.toString() });

            assert.equal(reqRes.status, 403);
            assert.equal(reqRes.body.code, "BLOCKED_USER");
            assert.equal(inMemoryRequests.length, 0);
        });
    });
});
