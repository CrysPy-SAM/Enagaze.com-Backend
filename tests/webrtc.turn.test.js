import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { io as ioClient } from "socket.io-client";

import {
    isValidIceUrl,
    parseIceUrls,
    generateEphemeralTurnCredentials,
    getIceServersConfig,
    DEFAULT_STUN_SERVERS,
} from "../src/config/webrtc.js";
import {
    sanitizeClientDiagnosticReport,
    _testing as webrtcTesting,
} from "../src/controllers/webrtc.controller.js";
import webrtcRoutes from "../src/routes/webrtc.routes.js";
import { connectToSocket } from "../src/controllers/socketManager.js";
import { _testing as randomTesting } from "../src/controllers/randomCallManager.js";
import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Block } from "../src/models/block.model.js";

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

describe("Prompt 10: WebRTC Instrumentation, Connection Reliability & TURN-Ready Suite", () => {
    let server;
    let ioServer;
    let port;
    let app;
    let originalFindById;

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
        bio: "Architect & nature lover",
        photos: ["https://example.com/bob.jpg"],
        isProfileComplete: true,
    };

    let originalIsBlocked;

    before(async () => {
        originalFindById = User.findById;
        originalIsBlocked = Block.isBlockedBidirectional;
        Block.isBlockedBidirectional = async () => false;
        User.findById = (id) => {
            const idStr = id?.toString?.() || String(id);
            let found = null;
            if (idStr === mockUserA._id) found = { ...mockUserA };
            if (idStr === mockUserB._id) found = { ...mockUserB };
            return {
                select: () => Promise.resolve(found),
                then: (resolve, reject) => Promise.resolve(found).then(resolve, reject),
            };
        };

        app = express();
        app.use(express.json());
        app.use("/api/v1/webrtc", webrtcRoutes);

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    after(async () => {
        User.findById = originalFindById;
        Block.isBlockedBidirectional = originalIsBlocked;
        randomTesting.clearAll();
        webrtcTesting.clearDiagnosticRecords();
        if (ioServer) {
            await new Promise((resolve) => ioServer.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        randomTesting.clearAll();
        webrtcTesting.clearDiagnosticRecords();
    });

    // =========================================================================
    // 1. Safe ICE & TURN Configuration Engine
    // =========================================================================
    describe("1. Safe ICE & TURN Configuration Engine", () => {
        it("returns default Google STUN servers with policy 'all' when TURN is unconfigured", () => {
            const config = getIceServersConfig("user_123", {});
            assert.equal(config.hasTurn, false);
            assert.equal(config.iceTransportPolicy, "all");
            assert.equal(config.iceServers.length, 1);
            assert.deepEqual(config.iceServers[0].urls, DEFAULT_STUN_SERVERS);
            assert.equal(config.iceServers[0].username, undefined);
            assert.equal(config.iceServers[0].credential, undefined);
        });

        it("parses static TURN credentials correctly and combines with STUN", () => {
            const mockEnv = {
                STUN_SERVER_URLS: "stun:custom.stun.example.com:3478",
                TURN_SERVER_URLS: "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp",
                TURN_USERNAME: "test-turn-user",
                TURN_CREDENTIAL: "test-turn-password",
                WEBRTC_ICE_TRANSPORT_POLICY: "all",
            };

            const config = getIceServersConfig("user_123", mockEnv);
            assert.equal(config.hasTurn, true);
            assert.equal(config.iceServers.length, 2);
            assert.deepEqual(config.iceServers[0].urls, ["stun:custom.stun.example.com:3478"]);

            const turnEntry = config.iceServers[1];
            assert.equal(turnEntry.urls.length, 2);
            assert.equal(turnEntry.username, "test-turn-user");
            assert.equal(turnEntry.credential, "test-turn-password");
        });

        it("generates time-limited ephemeral HMAC credentials when TURN_SECRET is configured", () => {
            const mockEnv = {
                TURN_SERVER_URLS: "turn:coturn.example.com:3478",
                TURN_SECRET: "super-secret-hmac-key",
                TURN_CREDENTIAL_TTL: "3600",
            };

            const config = getIceServersConfig("alice_456", mockEnv);
            assert.equal(config.hasTurn, true);
            assert.equal(config.iceServers.length, 2);

            const turnEntry = config.iceServers[1];
            assert.ok(turnEntry.username.includes(":alice_456"));
            assert.ok(typeof turnEntry.credential === "string" && turnEntry.credential.length > 10);

            // Verify expiry timestamp in username
            const [expiryStr] = turnEntry.username.split(":");
            const expiry = parseInt(expiryStr, 10);
            const now = Math.floor(Date.now() / 1000);
            assert.ok(expiry > now && expiry <= now + 3600);
        });

        it("filters out invalid or malformed ICE URLs safely", () => {
            assert.equal(isValidIceUrl("http://invalid.com"), false);
            assert.equal(isValidIceUrl("stun:"), false);
            assert.equal(isValidIceUrl("turn://"), false);
            assert.equal(isValidIceUrl("stun:stun.l.google.com:19302"), true);
            assert.equal(isValidIceUrl("turns:turn.example.com:5349?transport=tcp"), true);

            const parsed = parseIceUrls("invalid,stun:stun1.example.com:3478,http://bad,turn:turn.example.com:3478");
            assert.deepEqual(parsed, ["stun:stun1.example.com:3478", "turn:turn.example.com:3478"]);
        });

        it("respects WEBRTC_ICE_TRANSPORT_POLICY='relay' for forced-relay testing", () => {
            const mockEnv = {
                TURN_SERVER_URLS: "turn:turn.example.com:3478",
                TURN_USERNAME: "relay-user",
                TURN_CREDENTIAL: "relay-pass",
                WEBRTC_ICE_TRANSPORT_POLICY: "relay",
            };

            const config = getIceServersConfig("user_123", mockEnv);
            assert.equal(config.iceTransportPolicy, "relay");
        });

        it("fails closed/falls back to STUN when TURN URLs are provided without credentials", () => {
            const mockEnv = {
                TURN_SERVER_URLS: "turn:turn.example.com:3478",
                // No TURN_SECRET, no TURN_USERNAME
            };

            const config = getIceServersConfig("user_123", mockEnv);
            // Should not output unauthenticated TURN server
            assert.equal(config.hasTurn, false);
            assert.equal(config.iceServers.length, 1);
            assert.deepEqual(config.iceServers[0].urls, DEFAULT_STUN_SERVERS);
        });
    });

    // =========================================================================
    // 2. WebRTC REST API Authorization & Privacy
    // =========================================================================
    describe("2. WebRTC REST API Authorization & Privacy", () => {
        it("GET /api/v1/webrtc/ice-servers rejects unauthenticated requests with 401", async () => {
            const res = await request(server).get("/api/v1/webrtc/ice-servers");
            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
        });

        it("GET /api/v1/webrtc/ice-servers returns secure ICE configuration for authenticated user", async () => {
            const token = makeToken({ id: mockUserA._id });
            const res = await request(server)
                .get("/api/v1/webrtc/ice-servers")
                .set("Authorization", `Bearer ${token}`);
            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.ok(Array.isArray(res.body.iceServers));
            assert.equal(res.body.iceTransportPolicy, "all");
        });

        it("POST /api/v1/webrtc/diagnostics accepts low-cardinality metadata and stores safely", async () => {
            const token = makeToken({ id: mockUserA._id });
            const payload = {
                callId: "call_abc-123",
                outcome: "connected",
                queueWaitMs: 3500,
                timeToConnectedMs: 1200,
                callDurationSecs: 45,
                terminalConnectionState: "connected",
                terminalIceConnectionState: "connected",
                failureCategory: null,
                selectedCandidatePair: {
                    localCandidateType: "srflx",
                    remoteCandidateType: "srflx",
                    protocol: "udp",
                },
                iceRestartAttempts: 0,
            };

            const res = await request(server)
                .post("/api/v1/webrtc/diagnostics")
                .set("Authorization", `Bearer ${token}`)
                .send(payload);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);

            const records = webrtcTesting.getDiagnosticRecords();
            assert.equal(records.length, 1);
            assert.equal(records[0].callId, "call_abc-123");
            assert.equal(records[0].outcome, "connected");
            assert.equal(records[0].selectedCandidatePair.localCandidateType, "srflx");
        });

        it("POST /api/v1/webrtc/diagnostics strips and rejects sensitive PII (IPs, tokens, SDP)", async () => {
            const sanitized = sanitizeClientDiagnosticReport({
                callId: "call_def-456",
                outcome: "192.168.1.50", // SENSITIVE IP - MUST BE DROPPED/FALLBACK
                queueWaitMs: 2000,
                selectedCandidatePair: {
                    localCandidateType: "candidate:12345 1 udp 2122260223 10.0.0.1 50000 typ host", // SENSITIVE SDP STRING
                    remoteCandidateType: "srflx",
                    protocol: "udp",
                },
                secretApiKey: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", // UNAPPROVED KEY
            });

            assert.notEqual(sanitized, null);
            assert.equal(sanitized.callId, "call_def-456");
            assert.equal(sanitized.outcome, "unknown"); // Dropped sensitive IP
            assert.equal(sanitized.selectedCandidatePair.localCandidateType, "unknown"); // Dropped raw SDP
            assert.equal(sanitized.secretApiKey, undefined); // Dropped unapproved field
        });
    });

    // =========================================================================
    // 3. WebRTC Signaling, Lifecycle & Consent Invariants
    // =========================================================================
    describe("3. WebRTC Signaling, Lifecycle & Consent Invariants", () => {
        let clientA;
        let clientB;

        afterEach(() => {
            if (clientA) {
                clientA.disconnect();
                clientA = null;
            }
            if (clientB) {
                clientB.disconnect();
                clientB = null;
            }
        });

        it("signaling remains strictly blocked until both peers consent and finish media setup", async () => {
            const tokenA = makeToken({ id: mockUserA._id });
            const tokenB = makeToken({ id: mockUserB._id });

            const connA = await connectClient(port, { auth: { token: tokenA } });
            const connB = await connectClient(port, { auth: { token: tokenB } });
            clientA = connA.client;
            clientB = connB.client;

            // Pair A and B
            const matchAPromise = new Promise((resolve) => clientA.once("random:matched", resolve));
            const matchBPromise = new Promise((resolve) => clientB.once("random:matched", resolve));

            await new Promise((resolve) => clientA.emit("random:join-queue", {}, resolve));
            await new Promise((resolve) => clientB.emit("random:join-queue", {}, resolve));
            const [matchData] = await Promise.all([matchAPromise, matchBPromise]);
            const callId = matchData.callId;

            // Attempt premature signaling before consent
            const signalAck = await new Promise((resolve) => {
                clientA.emit("random:signal", {
                    callId,
                    signalData: { type: "offer", sdp: { type: "offer", sdp: "dummy" } },
                }, resolve);
            });

            assert.equal(signalAck.success, false);
            assert.equal(signalAck.code, "SIGNAL_GATE_RESTRICTED");
            clientA.disconnect();
            clientB.disconnect();
        });

        it("discards signals and candidates belonging to stale or ended callId", async () => {
            const tokenA = makeToken({ id: mockUserA._id });
            const connA = await connectClient(port, { auth: { token: tokenA } });
            clientA = connA.client;

            const errAck = await new Promise((resolve) => {
                clientA.emit("random:signal", {
                    callId: "call_00000000-0000-0000-0000-000000000000",
                    signalData: { type: "ice-candidate", candidate: { candidate: "dummy" } },
                }, resolve);
            });

            assert.equal(errAck.success, false);
            assert.ok(errAck.message.includes("not found") || errAck.message.includes("ended"));
            clientA.disconnect();
        });

        it("forwards bounded ICE restart offer safely when media is ready", async () => {
            const tokenA = makeToken({ id: mockUserA._id });
            const tokenB = makeToken({ id: mockUserB._id });

            const connA = await connectClient(port, { auth: { token: tokenA } });
            const connB = await connectClient(port, { auth: { token: tokenB } });
            clientA = connA.client;
            clientB = connB.client;

            const matchAPromise = new Promise((resolve) => clientA.once("random:matched", resolve));
            const matchBPromise = new Promise((resolve) => clientB.once("random:matched", resolve));

            await new Promise((resolve) => clientA.emit("random:join-queue", {}, resolve));
            await new Promise((resolve) => clientB.emit("random:join-queue", {}, resolve));
            const [matchData] = await Promise.all([matchAPromise, matchBPromise]);
            const callId = matchData.callId;

            // Both consent
            const bothConsentedPromise = new Promise((resolve) => {
                clientA.once("random:both-consented", resolve);
            });
            clientA.emit("random:consent", { callId, consent: true });
            clientB.emit("random:consent", { callId, consent: true });
            await bothConsentedPromise;

            // Both signal media-ready
            const mediaStartPromise = new Promise((resolve) => {
                clientA.once("random:media-start", resolve);
            });
            clientA.emit("random:media-ready", { callId });
            clientB.emit("random:media-ready", { callId });
            await mediaStartPromise;

            // Peer A emits an ICE restart offer
            const partnerReceivedSignal = new Promise((resolve) => {
                clientB.once("random:signal", resolve);
            });

            const ack = await new Promise((resolve) => {
                clientA.emit("random:signal", {
                    callId,
                    signalData: {
                        type: "offer",
                        sdp: { type: "offer", sdp: "v=0\r\no=alice" },
                        iceRestart: true,
                    },
                }, resolve);
            });

            assert.equal(ack.success, true);
            const received = await partnerReceivedSignal;
            assert.equal(received.callId, callId);
            assert.equal(received.signalData.iceRestart, true);
            clientA.disconnect();
            clientB.disconnect();
        });
    });
});
