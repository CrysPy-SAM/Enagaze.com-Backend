import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { io as ioClient } from "socket.io-client";

import { connectToSocket } from "../src/controllers/socketManager.js";
import { _testing as randomTesting } from "../src/controllers/randomCallManager.js";
import { _testingRateLimits } from "../src/utils/socketValidator.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";

// Helper to generate test JWT tokens
function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

// Helper to connect a test client and await connection or connect_error
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

describe("Batch 4 Socket.IO Security, Authorization & Abuse Prevention Suite", () => {
    let server;
    let ioServer;
    let port;
    let originalFindById;
    let originalConvFindById;
    let originalMsgFindOne;
    let originalMsgSave;
    let originalMsgUpdateMany;

    // Standard mock user data
    const mockUserA = {
        _id: "65cb11111111111111111111",
        name: "Alice Johnson",
        username: "alice_j",
        dob: new Date("1995-05-15"),
        gender: "female",
        bio: "Explorer and coffee lover",
        photos: ["https://example.com/alice.jpg"],
        isProfileComplete: true,
    };

    const mockUserB = {
        _id: "65cb22222222222222222222",
        name: "Bob Builder",
        username: "bob_b",
        dob: new Date("1993-08-20"),
        gender: "male",
        bio: "Architect & nature photographer",
        photos: ["https://example.com/bob.jpg"],
        isProfileComplete: true,
    };

    const mockUserOutsider = {
        _id: "65cb33333333333333333333",
        name: "Charlie Outsider",
        username: "charlie_o",
        dob: new Date("1990-01-01"),
        gender: "male",
        bio: "Not in this chat",
        photos: ["https://example.com/charlie.jpg"],
        isProfileComplete: true,
    };

    const mockUserIneligible = {
        _id: "65cb44444444444444444444",
        name: "Dave Ineligible",
        username: "dave_i",
        dob: new Date("2012-05-01"), // 14 years old
        gender: "male",
        bio: "Too young",
        photos: ["https://example.com/dave.jpg"],
        isProfileComplete: false,
    };

    const mockConversationAB = {
        _id: "65cb99999999999999999999",
        match: "65cb88888888888888888888",
        participants: [mockUserA._id, mockUserB._id],
        lastMessage: null,
        lastMessageAt: new Date(),
        save: async function() { return this; },
    };

    before(async () => {
        const app = express();
        server = createServer(app);
        ioServer = connectToSocket(server);
        await new Promise((res) => server.listen(0, "127.0.0.1", res));
        port = server.address().port;
    });

    after(async () => {
        if (ioServer) ioServer.close();
        if (server) await new Promise((res) => server.close(res));
    });

    beforeEach(() => {
        randomTesting.clearAll();
        _testingRateLimits.clearAll();

        // Stub User.findById
        originalFindById = User.findById;
        User.findById = (id) => {
            const idStr = id?.toString();
            let target = null;
            if (idStr === mockUserA._id) target = { ...mockUserA };
            else if (idStr === mockUserB._id) target = { ...mockUserB };
            else if (idStr === mockUserOutsider._id) target = { ...mockUserOutsider };
            else if (idStr === mockUserIneligible._id) target = { ...mockUserIneligible };

            return {
                select: () => Promise.resolve(target ? new User(target) : null),
                then: (resolve) => resolve(target ? new User(target) : null),
            };
        };

        // Stub Conversation.findById
        originalConvFindById = Conversation.findById;
        Conversation.findById = (id) => {
            const idStr = id?.toString();
            if (idStr === mockConversationAB._id) {
                return Promise.resolve({ ...mockConversationAB, save: async function() { return this; } });
            }
            return Promise.resolve(null);
        };

        // Stub Message.findOne
        originalMsgFindOne = Message.findOne;
        Message.findOne = () => ({
            populate: () => Promise.resolve(null),
        });

        // Stub Message.updateMany
        originalMsgUpdateMany = Message.updateMany;
        Message.updateMany = async () => ({ modifiedCount: 1 });

        // Stub Message.prototype.save
        originalMsgSave = Message.prototype.save;
        Message.prototype.save = async function() {
            this._id = this._id || new mongoose.Types.ObjectId();
            this.createdAt = new Date();
            return this;
        };
        Message.prototype.populate = async function() {
            this.sender = {
                _id: this.sender,
                name: "Sender Name",
                photos: ["https://example.com/p.jpg"],
            };
            return this;
        };
    });

    afterEach(() => {
        User.findById = originalFindById;
        Conversation.findById = originalConvFindById;
        Message.findOne = originalMsgFindOne;
        Message.updateMany = originalMsgUpdateMany;
        Message.prototype.save = originalMsgSave;
        randomTesting.clearAll();
        _testingRateLimits.clearAll();
    });

    // =========================================================================
    // 1. Socket Handshake Authentication (Scenarios 1 & 2)
    // =========================================================================
    describe("Handshake Authentication", () => {
        it("Scenario 1: Missing JWT is rejected with connect_error", async () => {
            const { client, error } = await connectClient(port, { auth: {} });
            assert.ok(error, "Handshake MUST reject connection without token");
            assert.match(error.message, /Authentication error: Token required/i);
            client.disconnect();
        });

        it("Scenario 2a: Invalid/malformed JWT is rejected with connect_error", async () => {
            const { client, error } = await connectClient(port, {
                auth: { token: "this.is.not.a.valid.jwt" },
            });
            assert.ok(error, "Handshake MUST reject connection with malformed token");
            assert.match(error.message, /Authentication error: Invalid or expired token/i);
            client.disconnect();
        });

        it("Scenario 2b: Expired JWT is rejected with connect_error", async () => {
            const expiredToken = makeToken({ id: mockUserA._id, username: mockUserA.username }, { expiresIn: "-10s" });
            const { client, error } = await connectClient(port, {
                auth: { token: expiredToken },
            });
            assert.ok(error, "Handshake MUST reject expired JWT");
            assert.match(error.message, /Authentication error: Invalid or expired token/i);
            client.disconnect();
        });

        it("Scenario 2c: Valid JWT connects successfully and derives identity from server-side token", async () => {
            const validToken = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client, error } = await connectClient(port, {
                auth: { token: validToken },
            });
            assert.equal(error, null, "Legitimate token MUST connect without error");
            assert.ok(client.connected);
            client.disconnect();
        });
    });

    // =========================================================================
    // 2. Conversation Authorization (Scenarios 3 & 4)
    // =========================================================================
    describe("Conversation Authorization", () => {
        it("Scenario 3: Authenticated nonparticipant cannot join a private conversation room", async () => {
            const outsiderToken = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });
            const { client } = await connectClient(port, { auth: { token: outsiderToken } });

            const ack = await new Promise((resolve) => {
                client.emit("chat:join", { conversationId: mockConversationAB._id }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /not authorized to join this conversation/i);
            client.disconnect();
        });

        it("Scenario 4a: Nonparticipant cannot send messages to an unauthorized conversation", async () => {
            const outsiderToken = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });
            const { client } = await connectClient(port, { auth: { token: outsiderToken } });

            const ack = await new Promise((resolve) => {
                client.emit("chat:send", {
                    conversationId: mockConversationAB._id,
                    content: "Attempting unauthorized message",
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /not authorized to send messages/i);
            client.disconnect();
        });

        it("Scenario 4b: Nonparticipant cannot emit read receipts for an unauthorized conversation", async () => {
            const outsiderToken = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });
            const { client } = await connectClient(port, { auth: { token: outsiderToken } });

            const ack = await new Promise((resolve) => {
                client.emit("chat:read", {
                    conversationId: mockConversationAB._id,
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /not authorized to access this conversation/i);
            client.disconnect();
        });

        it("Scenario 4c: Nonparticipant cannot emit typing events for an unauthorized conversation", async () => {
            const outsiderToken = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });
            const { client } = await connectClient(port, { auth: { token: outsiderToken } });

            const ack = await new Promise((resolve) => {
                client.emit("chat:typing", {
                    conversationId: mockConversationAB._id,
                    isTyping: true,
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /not authorized to emit typing/i);
            client.disconnect();
        });
    });

    // =========================================================================
    // 3. Payload Validation & Sanitization (Scenario 5)
    // =========================================================================
    describe("Payload Validation", () => {
        it("Scenario 5a: Rejects malformed payload types (arrays and primitives)", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            // Array payload rejected
            const ackArray = await new Promise((resolve) => {
                client.emit("chat:send", ["not", "an", "object"], (res) => resolve(res));
            });
            assert.equal(ackArray.success, false);
            assert.match(ackArray.message, /plain object expected/i);

            // Null/non-object payload rejected
            const ackNull = await new Promise((resolve) => {
                client.emit("chat:join", null, (res) => resolve(res));
            });
            assert.equal(ackNull.success, false);
            assert.match(ackNull.message, /plain object expected/i);

            client.disconnect();
        });

        it("Scenario 5b: Rejects invalid or non-hex conversation IDs", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            const ack = await new Promise((resolve) => {
                client.emit("chat:send", {
                    conversationId: "invalid-non-hex-id-12345",
                    content: "Hello",
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /Invalid conversation ID/i);
            client.disconnect();
        });

        it("Scenario 5c: Rejects oversized message content (> 2000 characters)", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            const oversizedContent = "A".repeat(2500);
            const ack = await new Promise((resolve) => {
                client.emit("chat:send", {
                    conversationId: mockConversationAB._id,
                    content: oversizedContent,
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /cannot be empty or exceed 2000 characters/i);
            client.disconnect();
        });

        it("Scenario 5d: Rejects oversized or malformed WebRTC signaling payloads", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            // Oversized signal payload (>64KB)
            const oversizedSignal = { sdp: "x".repeat(70000) };
            const ack = await new Promise((resolve) => {
                client.emit("random:signal", {
                    callId: "call_12345-6789",
                    signalData: oversizedSignal,
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /Invalid or oversized signaling payload/i);
            client.disconnect();
        });

        it("Scenario 5e: Rejects malformed random call ID format", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            const ack = await new Promise((resolve) => {
                client.emit("random:signal", {
                    callId: "arbitrary_bad_call_id",
                    signalData: { type: "offer" },
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.message, /Invalid call ID format/i);
            client.disconnect();
        });
    });

    // =========================================================================
    // 4. Identity Spoofing & Tamper Resistance (Scenarios 6 & 7)
    // =========================================================================
    describe("Anti-Spoofing & Identity Protections", () => {
        it("Scenario 6: Client-supplied sender identity is discarded; server derives sender from authenticated token", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            let capturedSenderId = null;
            const originalSave = Message.prototype.save;
            Message.prototype.save = async function() {
                capturedSenderId = this.sender?.toString();
                return this;
            };

            const ack = await new Promise((resolve) => {
                client.emit("chat:send", {
                    conversationId: mockConversationAB._id,
                    content: "Hello Bob",
                    // Spoofing attempt: Claiming to be Bob or an admin
                    sender: mockUserB._id,
                    senderId: mockUserB._id,
                    userId: mockUserB._id,
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, true);
            assert.equal(capturedSenderId, mockUserA._id, "Message sender MUST be Alice (derived from token), ignoring spoofed body");
            Message.prototype.save = originalSave;
            client.disconnect();
        });

        it("Scenario 7: Read receipts update strictly the authenticated caller's read state, not another user's", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client } = await connectClient(port, { auth: { token: tokenA } });

            let capturedUpdateFilter = null;
            let capturedUpdateDoc = null;
            Message.updateMany = async (filter, update) => {
                capturedUpdateFilter = filter;
                capturedUpdateDoc = update;
                return { modifiedCount: 1 };
            };

            const ack = await new Promise((resolve) => {
                client.emit("chat:read", {
                    conversationId: mockConversationAB._id,
                    // Spoofing attempt: Trying to mark messages read on behalf of Bob
                    readerId: mockUserB._id,
                    userId: mockUserB._id,
                }, (res) => resolve(res));
            });

            assert.equal(ack.success, true);
            assert.equal(ack.readerId, mockUserA._id, "Ack readerId must be Alice");
            assert.deepEqual(capturedUpdateDoc.$addToSet, { readBy: mockUserA._id }, "Database readBy MUST add Alice, never spoofed Bob");
            client.disconnect();
        });
    });

    // =========================================================================
    // 5. Random Video Matchmaking, Signaling & State Machine (Scenarios 8 - 11)
    // =========================================================================
    describe("Random Video Security & State Transitions", () => {
        it("Scenario 11: Ineligible user (under 18 or incomplete profile) cannot enter matchmaking queue", async () => {
            const tokenIneligible = makeToken({ id: mockUserIneligible._id, username: mockUserIneligible.username });
            const { client } = await connectClient(port, { auth: { token: tokenIneligible } });

            const ack = await new Promise((resolve) => {
                client.emit("random:join-queue", {}, (res) => resolve(res));
            });

            assert.equal(ack.success, false);
            assert.match(ack.code, /UNDERAGE|PROFILE_INCOMPLETE|DOB_REQUIRED/);
            assert.equal(randomTesting.getQueue().length, 0, "Ineligible user MUST NOT enter matchmaking queue");
            client.disconnect();
        });

        it("Scenario 8: Outsider cannot signal an active call", async () => {
            // Pair User A and User B into an active call
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });
            const tokenOutsider = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });
            const { client: clientOutsider } = await connectClient(port, { auth: { token: tokenOutsider } });

            // User A joins queue
            await new Promise((resolve) => clientA.emit("random:join-queue", {}, resolve));
            // User B joins queue, triggering match
            const matchedPromise = new Promise((resolve) => {
                clientA.once("random:matched", (matchData) => resolve(matchData));
            });
            await new Promise((resolve) => clientB.emit("random:join-queue", {}, resolve));
            const matchData = await matchedPromise;
            const callId = matchData.callId;

            // Outsider attempts to signal active call
            const ackOutsider = await new Promise((resolve) => {
                clientOutsider.emit("random:signal", {
                    callId,
                    signalData: { type: "offer", sdp: "fake-sdp" },
                }, (res) => resolve(res));
            });

            assert.equal(ackOutsider.success, false);
            assert.match(ackOutsider.message, /not an active call participant/i);

            clientA.disconnect();
            clientB.disconnect();
            clientOutsider.disconnect();
        });

        it("Scenario 9: Mismatched or stale call ID is rejected", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            await new Promise((resolve) => clientA.emit("random:join-queue", {}, resolve));
            await new Promise((resolve) => clientB.emit("random:join-queue", {}, resolve));

            // User A attempts to signal with a stale/nonexistent callId
            const ackMismatched = await new Promise((resolve) => {
                clientA.emit("random:signal", {
                    callId: "call_99999999-9999-9999-9999-999999999999",
                    signalData: { type: "offer" },
                }, (res) => resolve(res));
            });

            assert.equal(ackMismatched.success, false);
            assert.match(ackMismatched.message, /Active call session not found/i);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Scenario 10: Duplicate or invalid call-state transitions are handled safely", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            await new Promise((resolve) => clientA.emit("random:join-queue", {}, resolve));
            const matchedPromise = new Promise((resolve) => {
                clientA.once("random:matched", resolve);
            });
            await new Promise((resolve) => clientB.emit("random:join-queue", {}, resolve));
            const { callId } = await matchedPromise;

            // First end-call succeeds and ends the active call
            const ack1 = await new Promise((resolve) => {
                clientA.emit("random:end-call", { callId }, resolve);
            });
            assert.equal(ack1.success, true);
            assert.equal(ack1.wasActive, true);

            // Duplicate end-call handled safely and idempotently without crashing
            const ack2 = await new Promise((resolve) => {
                clientA.emit("random:end-call", { callId }, resolve);
            });
            assert.equal(ack2.success, true);
            assert.equal(ack2.wasActive, false);

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // =========================================================================
    // 6. Legitimate End-to-End Chat Operations (Scenario 12)
    // =========================================================================
    describe("Legitimate Chat Operations", () => {
        it("Scenario 12: Two eligible authenticated users complete chat operations (join, typing, send, read)", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            // 1. Both join room
            const joinA = await new Promise((res) => clientA.emit("chat:join", { conversationId: mockConversationAB._id }, res));
            const joinB = await new Promise((res) => clientB.emit("chat:join", { conversationId: mockConversationAB._id }, res));
            assert.equal(joinA.success, true);
            assert.equal(joinB.success, true);

            // 2. Typing indicator: User A types, User B receives typing event
            const typingPromise = new Promise((resolve) => {
                clientB.once("chat:typing", (data) => resolve(data));
            });
            clientA.emit("chat:typing", { conversationId: mockConversationAB._id, isTyping: true });
            const typingData = await typingPromise;
            assert.equal(typingData.conversationId, mockConversationAB._id);
            assert.equal(typingData.userId, mockUserA._id);
            assert.equal(typingData.isTyping, true);

            // 3. User A sends message, User B receives new message
            const messagePromise = new Promise((resolve) => {
                clientB.once("chat:new-message", (msg) => resolve(msg));
            });
            const sendAck = await new Promise((res) => {
                clientA.emit("chat:send", {
                    conversationId: mockConversationAB._id,
                    content: "Hello Bob, great to connect!",
                }, res);
            });
            assert.equal(sendAck.success, true);
            const receivedMsg = await messagePromise;
            assert.equal(receivedMsg.content, "Hello Bob, great to connect!");

            // 4. User B marks conversation as read, User A receives read receipt
            const readPromise = new Promise((resolve) => {
                clientA.once("chat:read", (receipt) => resolve(receipt));
            });
            clientB.emit("chat:read", { conversationId: mockConversationAB._id });
            const receipt = await readPromise;
            assert.equal(receipt.conversationId, mockConversationAB._id);
            assert.equal(receipt.readerId, mockUserB._id);

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // =========================================================================
    // 7. Legitimate End-to-End Random Video Matchmaking (Scenario 13)
    // =========================================================================
    describe("Legitimate Random Video Operations", () => {
        it("Scenario 13: Two eligible users pair, exchange WebRTC signals, and skip with next", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            const matchBPromise = new Promise((res) => clientB.once("random:matched", res));

            // User A enters queue
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            // User B enters queue, triggers match
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));

            const [matchA, matchB] = await Promise.all([matchAPromise, matchBPromise]);
            assert.equal(matchA.callId, matchB.callId);
            assert.equal(matchA.isInitiator, true);
            assert.equal(matchB.isInitiator, false);
            assert.equal(matchA.partner.name, mockUserB.name);
            assert.equal(matchB.partner.name, mockUserA.name);

            // Both participants provide explicit consent
            const bothConsentedA = new Promise((res) => clientA.once("random:both-consented", res));
            const bothConsentedB = new Promise((res) => clientB.once("random:both-consented", res));
            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchB.callId, consent: true }, res));
            await Promise.all([bothConsentedA, bothConsentedB]);

            // Both participants report local media ready
            const mediaStartA = new Promise((res) => clientA.once("random:media-start", res));
            const mediaStartB = new Promise((res) => clientB.once("random:media-start", res));
            await new Promise((res) => clientA.emit("random:media-ready", { callId: matchA.callId }, res));
            await new Promise((res) => clientB.emit("random:media-ready", { callId: matchB.callId }, res));
            await Promise.all([mediaStartA, mediaStartB]);

            // User A signals User B with WebRTC offer
            const signalBPromise = new Promise((res) => clientB.once("random:signal", res));
            const offerAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: matchA.callId,
                    signalData: { type: "offer", sdp: "v=0\r\no=alice" },
                }, res);
            });
            assert.equal(offerAck.success, true);
            const receivedOffer = await signalBPromise;
            assert.equal(receivedOffer.signalData.type, "offer");
            assert.equal(receivedOffer.senderId, mockUserA._id);

            // User B signals User A with WebRTC answer
            const signalAPromise = new Promise((res) => clientA.once("random:signal", res));
            const answerAck = await new Promise((res) => {
                clientB.emit("random:signal", {
                    callId: matchB.callId,
                    signalData: { type: "answer", sdp: "v=0\r\no=bob" },
                }, res);
            });
            assert.equal(answerAck.success, true);
            const receivedAnswer = await signalAPromise;
            assert.equal(receivedAnswer.signalData.type, "answer");
            assert.equal(receivedAnswer.senderId, mockUserB._id);

            // User A skips to next match, User B notified with skipped_by_partner
            const endBPromise = new Promise((res) => clientB.once("random:call-ended", res));
            clientA.emit("random:next", { callId: matchA.callId });
            const endNotification = await endBPromise;
            assert.equal(endNotification.reason, "skipped_by_partner");

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // =========================================================================
    // 8. Disconnect Cleanup & Stale Authorization Prevention (Scenario 14)
    // =========================================================================
    describe("Disconnect & Cleanup Security", () => {
        it("Scenario 14: Disconnect terminates active call, notifies partner, and purges state mappings", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchBPromise = new Promise((res) => clientB.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchB = await matchBPromise;

            assert.equal(randomTesting.getActiveCalls().size, 1);

            // Partner B awaits call-ended event
            const endBPromise = new Promise((res) => clientB.once("random:call-ended", res));

            // User A abruptly disconnects
            clientA.disconnect();

            const endNotification = await endBPromise;
            assert.equal(endNotification.reason, "partner_disconnected");

            // Verify server-side mappings are completely purged
            assert.equal(randomTesting.getActiveCalls().size, 0);
            assert.equal(randomTesting.getSocketToCall().size, 0);
            assert.equal(randomTesting.getUserToCall().size, 0);

            clientB.disconnect();
        });
    });

    // =========================================================================
    // 9. Check 1: Random Video Frontend Authentication Contract & Reconnects
    // =========================================================================
    describe("Check 1: Random Video Frontend Auth Contract", () => {
        it("connects using the exact frontend contract { auth: { token: authToken } }", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            // Exact frontend contract from randomVideo.jsx line 402: io(server, { auth: { token: authToken }, transports: ["websocket", "polling"] })
            const { client, error } = await connectClient(port, {
                auth: { token: tokenA },
                transports: ["websocket", "polling"],
            });

            assert.equal(error, null, "Frontend contract { auth: { token } } MUST be accepted");
            assert.ok(client.connected);

            // Verify queue join works under this contract
            const queueAck = await new Promise((res) => {
                client.emit("random:join-queue", {}, res);
            });
            assert.equal(queueAck.success, true);
            assert.equal(queueAck.status, "waiting");

            client.disconnect();
        });

        it("reconnects authenticate with the token contract and do not permit unauthenticated sessions", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const client = ioClient(`http://127.0.0.1:${port}`, {
                transports: ["polling"],
                auth: { token: tokenA },
                reconnection: true,
                reconnectionAttempts: 1,
            });

            await new Promise((resolve) => client.once("connect", resolve));
            assert.ok(client.connected);

            // Manually simulate reconnect by disconnecting transport and reconnecting
            client.io.engine.close();

            await new Promise((resolve) => client.once("connect", resolve));
            assert.ok(client.connected, "Reconnection MUST successfully authenticate with the auth token");

            client.disconnect();
        });
    });

    // =========================================================================
    // 10. Check 2: Legacy Meeting Room Subsystem Retirement & Inertness
    // =========================================================================
    describe("Check 2: Legacy Meeting Room Subsystem Retirement & Inertness", () => {
        it("legacy events ('join-call', 'signal', 'chat-message') are completely retired and produce no state or events", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            let receivedUserJoined = false;
            let receivedSignal = false;
            let receivedChatMessage = false;

            clientB.on("user-joined", () => { receivedUserJoined = true; });
            clientB.on("signal", () => { receivedSignal = true; });
            clientB.on("chat-message", () => { receivedChatMessage = true; });

            // Attempt to invoke legacy meeting events
            clientA.emit("join-call", "http://localhost:3000/room-alpha");
            clientB.emit("join-call", "http://localhost:3000/room-alpha");
            clientA.emit("signal", clientB.id, { type: "test-legacy-signal" });
            clientA.emit("chat-message", "legacy message", "UserA");

            await new Promise((r) => setTimeout(r, 80));

            assert.equal(receivedUserJoined, false, "Retired join-call must NOT broadcast user-joined");
            assert.equal(receivedSignal, false, "Retired legacy signal must NOT forward signals");
            assert.equal(receivedChatMessage, false, "Retired chat-message must NOT broadcast messages");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("unauthenticated sockets cannot establish connection to invoke any socket operations", async () => {
            const { client, error } = await connectClient(port, { auth: {} });
            assert.ok(error, "Handshake MUST reject unauthenticated client");
            client.disconnect();
        });
    });
});
