import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { io as ioClient } from "socket.io-client";

import { connectToSocket, _resetInMemoryDirectCalls } from "../src/controllers/socketManager.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Match } from "../src/models/match.model.js";
import { Block } from "../src/models/block.model.js";
import { Conversation } from "../src/models/conversation.model.js";

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

describe("Prompt 17: One-to-One Direct Video Calling for Established Connections Suite", () => {
    let server;
    let ioServer;
    let port;
    let app;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65ef11111111111111111111"),
        name: "Alice Adams",
        username: "alice_a",
        dob: new Date("1996-03-15"),
        gender: "female",
        bio: "Photographer",
        photos: ["https://example.com/alice.jpg"],
        interests: ["photography"],
        isProfileComplete: true,
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65ef22222222222222222222"),
        name: "Ben Baker",
        username: "ben_b",
        dob: new Date("1994-07-22"),
        gender: "male",
        bio: "Musician",
        photos: ["https://example.com/ben.jpg"],
        interests: ["music"],
        isProfileComplete: true,
    };

    const mockUserC = {
        _id: new mongoose.Types.ObjectId("65ef33333333333333333333"),
        name: "Charlie Cox",
        username: "charlie_c",
        dob: new Date("1995-10-10"),
        gender: "male",
        bio: "Traveler",
        photos: ["https://example.com/charlie.jpg"],
        interests: ["travel"],
        isProfileComplete: true,
    };

    const mockUserD = {
        _id: new mongoose.Types.ObjectId("65ef44444444444444444444"),
        name: "Diana Prince",
        username: "diana_p",
        dob: new Date("1993-01-01"),
        gender: "female",
        bio: "Curator",
        photos: ["https://example.com/diana.jpg"],
        interests: ["art"],
        isProfileComplete: true,
    };

    const userMap = {
        [mockUserA._id.toString()]: { ...mockUserA },
        [mockUserB._id.toString()]: { ...mockUserB },
        [mockUserC._id.toString()]: { ...mockUserC },
        [mockUserD._id.toString()]: { ...mockUserD },
    };

    const tokenA = makeToken({ id: mockUserA._id.toString(), username: mockUserA.username });
    const tokenB = makeToken({ id: mockUserB._id.toString(), username: mockUserB.username });
    const tokenC = makeToken({ id: mockUserC._id.toString(), username: mockUserC.username });
    const tokenD = makeToken({ id: mockUserD._id.toString(), username: mockUserD.username });

    let inMemoryMatches = [];
    let inMemoryBlockedPairs = new Set();
    let inMemoryConversations = [];

    const origUserFindById = User.findById;
    const origMatchFindOne = Match.findOne;
    const origBlockIsBlockedBidirectional = Block.isBlockedBidirectional;
    const origConvFindById = Conversation.findById;

    before(async () => {
        app = express();
        app.use(express.json());

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });

        // User mocks
        User.findById = (id) => {
            const found = userMap[id?.toString()];
            return {
                select: () => Promise.resolve(found ? { ...found } : null),
                then: (resolve) => resolve(found ? { ...found } : null),
            };
        };

        // Match mocks
        Match.findOne = (query) => {
            const found = inMemoryMatches.find((m) => {
                if (query.userPair && m.userPair !== query.userPair) return false;
                if (query.status && m.status !== query.status) return false;
                return true;
            });
            return Promise.resolve(found ? { ...found } : null);
        };

        // Block mocks
        Block.isBlockedBidirectional = (u1, u2) => {
            const pair1 = `${u1.toString()}_${u2.toString()}`;
            const pair2 = `${u2.toString()}_${u1.toString()}`;
            return Promise.resolve(inMemoryBlockedPairs.has(pair1) || inMemoryBlockedPairs.has(pair2));
        };

        // Conversation mocks
        Conversation.findById = (id) => {
            const found = inMemoryConversations.find((c) => c._id.toString() === id.toString());
            return Promise.resolve(found ? { ...found } : null);
        };
    });

    after(async () => {
        User.findById = origUserFindById;
        Match.findOne = origMatchFindOne;
        Block.isBlockedBidirectional = origBlockIsBlockedBidirectional;
        Conversation.findById = origConvFindById;

        if (ioServer) {
            await new Promise((resolve) => ioServer.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        _resetInMemoryDirectCalls();
        inMemoryMatches = [];
        inMemoryBlockedPairs.clear();
        inMemoryConversations = [];
    });

    describe("1. Connection Authorization on Call Initiation", () => {
        it("initiates direct call when A and B have an established active connection", async () => {
            const canonicalPair = Match.getCanonicalPair(mockUserA._id, mockUserB._id);
            inMemoryMatches.push({
                userPair: canonicalPair,
                status: "active",
                users: [mockUserA._id, mockUserB._id],
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let incomingData = null;
            clientB.on("call:incoming", (data) => {
                incomingData = data;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(initAck.success, true);
            assert.ok(initAck.callId);

            await new Promise((r) => setTimeout(r, 80));
            assert.ok(incomingData);
            assert.equal(incomingData.callId, initAck.callId);
            assert.equal(incomingData.caller._id, mockUserA._id.toString());
            assert.equal(incomingData.caller.name, "Alice Adams");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("rejects direct call between unconnected users with CALL_UNAUTHORIZED", async () => {
            // No match between A and B
            const { client: clientA } = await connectClient(port, tokenA);

            let errorEmitted = null;
            clientA.on("call:error", (err) => {
                errorEmitted = err;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(initAck.success, false);
            assert.equal(initAck.code, "CALL_UNAUTHORIZED");
            assert.ok(errorEmitted);
            assert.equal(errorEmitted.code, "CALL_UNAUTHORIZED");

            clientA.disconnect();
        });

        it("rejects direct call to oneself with SELF_CALL_PROHIBITED", async () => {
            const { client: clientA } = await connectClient(port, tokenA);

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserA._id.toString() }, res);
            });

            assert.equal(initAck.success, false);
            assert.equal(initAck.code, "SELF_CALL_PROHIBITED");

            clientA.disconnect();
        });

        it("rejects direct call between blocked users with BLOCKED_USER", async () => {
            const canonicalPair = Match.getCanonicalPair(mockUserA._id, mockUserB._id);
            inMemoryMatches.push({
                userPair: canonicalPair,
                status: "active",
                users: [mockUserA._id, mockUserB._id],
            });

            inMemoryBlockedPairs.add(`${mockUserA._id.toString()}_${mockUserB._id.toString()}`);

            const { client: clientA } = await connectClient(port, tokenA);

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(initAck.success, false);
            assert.equal(initAck.code, "BLOCKED_USER");

            clientA.disconnect();
        });
    });

    describe("2. Acceptance, Busy State & Decline Handling", () => {
        it("returns USER_BUSY when callee is already engaged in an active call", async () => {
            // Connect A & B, and B & C
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserC._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);
            const { client: clientC } = await connectClient(port, tokenC);

            // A calls B -> ringing
            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });
            assert.equal(initAck.success, true);

            // C attempts to call B concurrently
            let busyEvent = null;
            clientC.on("call:busy", (d) => {
                busyEvent = d;
            });

            const cAck = await new Promise((res) => {
                clientC.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(cAck.success, false);
            assert.equal(cAck.code, "USER_BUSY");

            clientA.disconnect();
            clientB.disconnect();
            clientC.disconnect();
        });

        it("allows recipient to accept, notifying caller via call:accepted", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let acceptedEvent = null;
            clientA.on("call:accepted", (d) => {
                acceptedEvent = d;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            const acceptAck = await new Promise((res) => {
                clientB.emit("call:accept", { callId: initAck.callId }, res);
            });

            assert.equal(acceptAck.success, true);

            await new Promise((r) => setTimeout(r, 60));
            assert.ok(acceptedEvent);
            assert.equal(acceptedEvent.callId, initAck.callId);
            assert.equal(acceptedEvent.calleeId, mockUserB._id.toString());

            clientA.disconnect();
            clientB.disconnect();
        });

        it("rejects unauthorized third-party from accepting the call", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);
            const { client: clientC } = await connectClient(port, tokenC);

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            // Charlie attempts to accept Alice's call intended for Ben
            const fakeAcceptAck = await new Promise((res) => {
                clientC.emit("call:accept", { callId: initAck.callId }, res);
            });

            assert.equal(fakeAcceptAck.success, false);
            assert.equal(fakeAcceptAck.code, "CALL_UNAUTHORIZED");

            clientA.disconnect();
            clientB.disconnect();
            clientC.disconnect();
        });

        it("allows recipient to decline, notifying caller via call:declined", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let declinedEvent = null;
            clientA.on("call:declined", (d) => {
                declinedEvent = d;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            const declineAck = await new Promise((res) => {
                clientB.emit("call:decline", { callId: initAck.callId, targetUserId: mockUserA._id.toString() }, res);
            });

            assert.equal(declineAck.success, true);

            await new Promise((r) => setTimeout(r, 60));
            assert.ok(declinedEvent);
            assert.equal(declinedEvent.reason, "declined_by_partner");

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    describe("3. WebRTC Signaling & Room Privacy", () => {
        it("forwards SDP and ICE candidate signals strictly between caller and callee", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let receivedSignalB = null;
            clientB.on("call:signal", (data) => {
                receivedSignalB = data;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            await new Promise((res) => {
                clientB.emit("call:accept", { callId: initAck.callId }, res);
            });

            const signalPayload = { type: "offer", sdp: "v=0\r\no=alice..." };
            const sigAck = await new Promise((res) => {
                clientA.emit("call:signal", {
                    callId: initAck.callId,
                    targetUserId: mockUserB._id.toString(),
                    signal: signalPayload,
                }, res);
            });

            assert.equal(sigAck.success, true);

            await new Promise((r) => setTimeout(r, 60));
            assert.ok(receivedSignalB);
            assert.equal(receivedSignalB.callId, initAck.callId);
            assert.equal(receivedSignalB.senderId, mockUserA._id.toString());
            assert.deepEqual(receivedSignalB.signal, signalPayload);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("prevents unauthorized third party from injecting signals or joining room", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);
            const { client: clientC } = await connectClient(port, tokenC);

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            // Third party C tries to join A and B's private direct call room
            const joinAck = await new Promise((res) => {
                clientC.emit("call:join", { callId: initAck.callId, targetUserId: mockUserA._id.toString() }, res);
            });

            assert.equal(joinAck.success, false);
            assert.equal(joinAck.code, "CALL_UNAUTHORIZED");

            // Third party C tries to send signal
            const fakeSigAck = await new Promise((res) => {
                clientC.emit("call:signal", {
                    callId: initAck.callId,
                    targetUserId: mockUserA._id.toString(),
                    signal: { type: "candidate" },
                }, res);
            });

            assert.equal(fakeSigAck.success, false);
            assert.equal(fakeSigAck.code, "CALL_UNAUTHORIZED");

            clientA.disconnect();
            clientB.disconnect();
            clientC.disconnect();
        });
    });

    describe("4. Call Termination & Disconnect Cleanup", () => {
        it("hangs up cleanly when caller or callee calls call:end", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let callEndedEvent = null;
            clientB.on("call:ended", (d) => {
                callEndedEvent = d;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            await new Promise((res) => {
                clientB.emit("call:accept", { callId: initAck.callId }, res);
            });

            const endAck = await new Promise((res) => {
                clientA.emit("call:end", { callId: initAck.callId, targetUserId: mockUserB._id.toString() }, res);
            });

            assert.equal(endAck.success, true);

            await new Promise((r) => setTimeout(r, 60));
            assert.ok(callEndedEvent);
            assert.equal(callEndedEvent.callId, initAck.callId);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("cleans up session and notifies partner if socket disconnects mid-call", async () => {
            inMemoryMatches.push({
                userPair: Match.getCanonicalPair(mockUserA._id, mockUserB._id),
                status: "active",
            });

            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let disconnectNotification = null;
            clientB.on("call:ended", (d) => {
                disconnectNotification = d;
            });

            const initAck = await new Promise((res) => {
                clientA.emit("call:initiate", { targetUserId: mockUserB._id.toString() }, res);
            });

            await new Promise((res) => {
                clientB.emit("call:accept", { callId: initAck.callId }, res);
            });

            // Caller A abruptly disconnects
            clientA.disconnect();

            await new Promise((r) => setTimeout(r, 80));
            assert.ok(disconnectNotification);
            assert.equal(disconnectNotification.reason, "partner_disconnected");

            clientB.disconnect();
        });
    });
});

