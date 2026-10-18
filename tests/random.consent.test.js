import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { io as ioClient } from "socket.io-client";

import { connectToSocket } from "../src/controllers/socketManager.js";
import { _testing as randomTesting } from "../src/controllers/randomCallManager.js";
import { _testingRateLimits } from "../src/utils/socketValidator.js";
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

describe("Prompt 7: Random Video Consent, Readiness & Media Exposure Gate Suite", () => {
    let server;
    let ioServer;
    let port;
    let originalFindById;
    let originalIsBlocked;

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

    const mockUserOutsider = {
        _id: "65cb33333333333333333333",
        name: "Charlie Outsider",
        username: "charlie_o",
        dob: new Date("1990-01-01"),
        gender: "male",
        bio: "Observer",
        photos: ["https://example.com/charlie.jpg"],
        isProfileComplete: true,
    };

    before(async () => {
        const app = express();
        server = createServer(app);
        ioServer = connectToSocket(server);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });

        originalFindById = User.findById;
        User.findById = (id) => {
            const idStr = id ? id.toString() : "";
            let found = null;
            if (idStr === mockUserA._id) found = { ...mockUserA };
            else if (idStr === mockUserB._id) found = { ...mockUserB };
            else if (idStr === mockUserOutsider._id) found = { ...mockUserOutsider };

            return {
                select: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        originalIsBlocked = Block.isBlockedBidirectional;
        Block.isBlockedBidirectional = async () => false;
    });

    after(async () => {
        User.findById = originalFindById;
        Block.isBlockedBidirectional = originalIsBlocked;
        if (ioServer) {
            await new Promise((resolve) => ioServer.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        randomTesting.clearAll();
        if (_testingRateLimits && typeof _testingRateLimits.clear === "function") {
            _testingRateLimits.clear();
        }
    });

    afterEach(() => {
        randomTesting.clearAll();
        if (_testingRateLimits && typeof _testingRateLimits.clear === "function") {
            _testingRateLimits.clear();
        }
    });

    // -------------------------------------------------------------
    // 1. Initial Match & Consent Gating
    // -------------------------------------------------------------
    describe("Match Initialization & Server-Authoritative Consent State", () => {
        it("Requirement 1 & 2: Matchmaking initializes call in 'consent_pending' state; immediate signaling is gated", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            const matchBPromise = new Promise((res) => clientB.once("random:matched", res));

            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));

            const [matchA, matchB] = await Promise.all([matchAPromise, matchBPromise]);
            assert.equal(matchA.callId, matchB.callId);
            assert.equal(matchA.requiresConsent, true);
            assert.equal(matchB.requiresConsent, true);

            // Server-side call state must be 'consent_pending'
            assert.equal(randomTesting.getCallState(matchA.callId), "consent_pending");

            // Attempting WebRTC signaling immediately must be blocked by server gate
            const prematureSignalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: matchA.callId,
                    signalData: { type: "offer", sdp: "v=0\r\no=alice" },
                }, res);
            });

            assert.equal(prematureSignalAck.success, false);
            assert.equal(prematureSignalAck.code, "SIGNAL_GATE_RESTRICTED");
            assert.match(prematureSignalAck.message, /both participants must consent/i);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 3: Single user consent does not transition call to active signaling; partner is notified", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            const waitingPromise = new Promise((res) => clientA.once("random:waiting-for-partner-consent", res));
            const partnerConsentedPromise = new Promise((res) => clientB.once("random:partner-consented", res));

            const consentAck = await new Promise((res) => {
                clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res);
            });

            assert.equal(consentAck.success, true);
            assert.equal(consentAck.status, "waiting_for_partner");

            const [waitingData, partnerConsentedData] = await Promise.all([waitingPromise, partnerConsentedPromise]);
            assert.equal(waitingData.callId, matchA.callId);
            assert.equal(partnerConsentedData.callId, matchA.callId);

            // State is still consent_pending
            assert.equal(randomTesting.getCallState(matchA.callId), "consent_pending");

            // Signaling still blocked
            const signalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: matchA.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalAck.success, false);
            assert.equal(signalAck.code, "SIGNAL_GATE_RESTRICTED");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 4: Outsider cannot submit consent to an active call", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });
            const tokenOutsider = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });
            const { client: clientOutsider } = await connectClient(port, { auth: { token: tokenOutsider } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            const outsiderAck = await new Promise((res) => {
                clientOutsider.emit("random:consent", { callId: matchA.callId, consent: true }, res);
            });

            assert.equal(outsiderAck.success, false);
            assert.match(outsiderAck.message, /not an active call participant/i);

            clientA.disconnect();
            clientB.disconnect();
            clientOutsider.disconnect();
        });

        it("Requirement 5: Malformed consent payloads are rejected safely", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });

            const ack1 = await new Promise((res) => clientA.emit("random:consent", "not-an-object", res));
            assert.equal(ack1.success, false);
            assert.match(ack1.message, /plain object expected/i);

            const ack2 = await new Promise((res) => clientA.emit("random:consent", { callId: "invalid_id", consent: true }, res));
            assert.equal(ack2.success, false);
            assert.match(ack2.message, /Invalid call ID format/i);

            const ack3 = await new Promise((res) => clientA.emit("random:consent", { callId: "call_12345678-1234-1234-1234-1234567890ab", consent: "yes" }, res));
            assert.equal(ack3.success, false);
            assert.match(ack3.message, /boolean expected/i);

            clientA.disconnect();
        });
    });

    // -------------------------------------------------------------
    // 2. Decline Flow & Clean Termination
    // -------------------------------------------------------------
    describe("Decline & Rejection Flow", () => {
        it("Requirement 6: User declining consent terminates session cleanly with 'declined_by_partner'", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            const partnerEndedPromise = new Promise((res) => clientA.once("random:call-ended", res));
            const userEndedPromise = new Promise((res) => clientB.once("random:call-ended", res));

            // User B declines
            const declineAck = await new Promise((res) => {
                clientB.emit("random:consent", { callId: matchA.callId, consent: false }, res);
            });

            assert.equal(declineAck.success, true);
            assert.equal(declineAck.status, "declined");

            const [partnerEnded, userEnded] = await Promise.all([partnerEndedPromise, userEndedPromise]);
            assert.equal(partnerEnded.reason, "declined_by_partner");
            assert.equal(userEnded.reason, "declined_by_user");

            // Active calls map must be completely purged
            assert.equal(randomTesting.getActiveCalls().size, 0);

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // -------------------------------------------------------------
    // 3. Media Setup & Readiness Gate
    // -------------------------------------------------------------
    describe("Media Setup & Readiness Gate", () => {
        it("Requirement 7 & 8: Both consenting transitions call to 'media_setup'; premature media-ready or signal is blocked", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            // Before consenting, media-ready must be rejected
            const earlyMediaReadyAck = await new Promise((res) => {
                clientA.emit("random:media-ready", { callId: matchA.callId }, res);
            });
            assert.equal(earlyMediaReadyAck.success, false);
            assert.match(earlyMediaReadyAck.message, /Mutual consent required before media setup/i);

            // Both users provide consent
            const bothConsentedA = new Promise((res) => clientA.once("random:both-consented", res));
            const bothConsentedB = new Promise((res) => clientB.once("random:both-consented", res));

            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchA.callId, consent: true }, res));

            await Promise.all([bothConsentedA, bothConsentedB]);
            assert.equal(randomTesting.getCallState(matchA.callId), "media_setup");

            // Even though both consented, media is NOT yet verified -> signaling still blocked
            const signalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: matchA.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalAck.success, false);
            assert.equal(signalAck.code, "SIGNAL_GATE_RESTRICTED");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 9: Single media-ready leaves call in 'media_setup' waiting for partner", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchA.callId, consent: true }, res));

            const waitingMediaPromise = new Promise((res) => clientA.once("random:waiting-for-partner-media", res));
            const mediaReadyAckA = await new Promise((res) => {
                clientA.emit("random:media-ready", { callId: matchA.callId }, res);
            });

            assert.equal(mediaReadyAckA.success, true);
            assert.equal(mediaReadyAckA.status, "waiting_for_partner");

            const waitingData = await waitingMediaPromise;
            assert.equal(waitingData.callId, matchA.callId);

            // Call state remains media_setup
            assert.equal(randomTesting.getCallState(matchA.callId), "media_setup");

            // Signaling still blocked
            const signalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: matchA.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalAck.success, false);
            assert.equal(signalAck.code, "SIGNAL_GATE_RESTRICTED");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 10 & 11: Both media-ready transitions call to 'media_ready' and permits signaling", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            // Consent
            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchA.callId, consent: true }, res));

            // Media readiness
            const mediaStartAPromise = new Promise((res) => clientA.once("random:media-start", res));
            const mediaStartBPromise = new Promise((res) => clientB.once("random:media-start", res));

            await new Promise((res) => clientA.emit("random:media-ready", { callId: matchA.callId }, res));
            const mediaReadyAckB = await new Promise((res) => clientB.emit("random:media-ready", { callId: matchA.callId }, res));

            assert.equal(mediaReadyAckB.success, true);
            assert.equal(mediaReadyAckB.status, "media_ready");

            const [startA, startB] = await Promise.all([mediaStartAPromise, mediaStartBPromise]);
            assert.equal(startA.callId, matchA.callId);
            assert.equal(startB.callId, matchA.callId);
            assert.equal(startA.isInitiator, true);
            assert.equal(startB.isInitiator, false);

            assert.equal(randomTesting.getCallState(matchA.callId), "media_ready");

            // Signaling is now permitted
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

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 12: Media failure terminates session with 'partner_media_failed' and cleans up state", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchA.callId, consent: true }, res));

            // User A reports media failure (e.g. denied microphone or camera)
            const partnerEndedPromise = new Promise((res) => clientB.once("random:call-ended", res));
            const userEndedPromise = new Promise((res) => clientA.once("random:call-ended", res));

            const failAck = await new Promise((res) => {
                clientA.emit("random:media-failed", { callId: matchA.callId, reason: "permission_denied" }, res);
            });

            assert.equal(failAck.success, true);
            assert.equal(failAck.status, "media_failed");

            const [partnerEnded, userEnded] = await Promise.all([partnerEndedPromise, userEndedPromise]);
            assert.equal(partnerEnded.reason, "partner_media_failed");
            assert.equal(userEnded.reason, "media_failed");

            assert.equal(randomTesting.getActiveCalls().size, 0);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Requirement 13: Outsider cannot emit media-ready or media-failed", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });
            const tokenOutsider = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });
            const { client: clientOutsider } = await connectClient(port, { auth: { token: tokenOutsider } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchA.callId, consent: true }, res));

            const outsiderReadyAck = await new Promise((res) => {
                clientOutsider.emit("random:media-ready", { callId: matchA.callId }, res);
            });
            assert.equal(outsiderReadyAck.success, false);
            assert.match(outsiderReadyAck.message, /not an active call participant/i);

            const outsiderFailedAck = await new Promise((res) => {
                clientOutsider.emit("random:media-failed", { callId: matchA.callId }, res);
            });
            assert.equal(outsiderFailedAck.success, false);
            assert.match(outsiderFailedAck.message, /not an active call participant/i);

            clientA.disconnect();
            clientB.disconnect();
            clientOutsider.disconnect();
        });

        it("Requirement 14: Disconnecting during consent or setup ends call and purges state", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            const partnerEndedPromise = new Promise((res) => clientB.once("random:call-ended", res));

            // User A disconnects while in consent_pending
            clientA.disconnect();

            const partnerEnded = await partnerEndedPromise;
            assert.equal(partnerEnded.reason, "partner_disconnected");
            assert.equal(randomTesting.getActiveCalls().size, 0);

            clientB.disconnect();
        });

        it("Requirement 15: Re-searching after ended call creates a fresh session with reset consent", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            // Session 1: matched and declined
            const match1Promise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const match1 = await match1Promise;

            await new Promise((res) => clientA.emit("random:consent", { callId: match1.callId, consent: false }, res));
            assert.equal(randomTesting.getActiveCalls().size, 0);

            // Session 2: Search again
            const match2APromise = new Promise((res) => clientA.once("random:matched", res));
            const match2BPromise = new Promise((res) => clientB.once("random:matched", res));

            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));

            const [match2A, match2B] = await Promise.all([match2APromise, match2BPromise]);
            assert.notEqual(match2A.callId, match1.callId, "New session must have fresh unique callId");
            assert.equal(randomTesting.getCallState(match2A.callId), "consent_pending");

            // Signaling in new session is strictly blocked until both consent and setup
            const signalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match2A.callId,
                    signalData: { type: "offer" },
                }, res);
            });
            assert.equal(signalAck.success, false);
            assert.equal(signalAck.code, "SIGNAL_GATE_RESTRICTED");

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // -------------------------------------------------------------
    // 4. Prompt 7.1: Stale Session Mapping & Call-Transition Isolation
    // -------------------------------------------------------------
    describe("Prompt 7.1: Stale Session Mapping & Call-Transition Isolation", () => {
        it("Scenario 16: Attempting random:media-ready, random:signal, or random:consent on an ended call fails closed", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            // User A ends the call cleanly
            await new Promise((res) => clientA.emit("random:end-call", { callId: matchA.callId }, res));

            // Attempts to emit media-ready, signal, or consent on ended callId must fail closed
            const readyAck = await new Promise((res) => clientA.emit("random:media-ready", { callId: matchA.callId }, res));
            assert.equal(readyAck.success, false);
            assert.match(readyAck.message, /not found or has ended/i);

            const signalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: matchA.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalAck.success, false);
            assert.match(signalAck.message, /not found or has ended/i);

            const consentAck = await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            assert.equal(consentAck.success, false);
            assert.match(consentAck.message, /not found or has ended/i);

            clientA.disconnect();
            clientB.disconnect();
        });

        it("Scenario 17: User transitioning via random:next cannot emit stale operations on the prior callId", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });
            const tokenOutsider = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });
            const { client: clientC } = await connectClient(port, { auth: { token: tokenOutsider } });

            // Call 1: A and B match
            const match1Promise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const match1 = await match1Promise;

            // A and B consent in Call 1
            await new Promise((res) => clientA.emit("random:consent", { callId: match1.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: match1.callId, consent: true }, res));

            // User A presses next: Call 1 ends, User A re-enters queue
            await new Promise((res) => clientA.emit("random:next", { callId: match1.callId }, res));

            // User C joins queue -> User A and User C match in Call 2
            const match2APromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientC.emit("random:join-queue", {}, res));
            const match2A = await match2APromise;

            assert.notEqual(match2A.callId, match1.callId);

            // User A attempting media-ready or signal on Call 1 must be rejected
            const staleReadyAck = await new Promise((res) => clientA.emit("random:media-ready", { callId: match1.callId }, res));
            assert.equal(staleReadyAck.success, false);

            const staleSignalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match1.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(staleSignalAck.success, false);

            const staleConsentAck = await new Promise((res) => clientA.emit("random:consent", { callId: match1.callId, consent: true }, res));
            assert.equal(staleConsentAck.success, false);

            clientA.disconnect();
            clientB.disconnect();
            clientC.disconnect();
        });

        it("Scenario 18: Media readiness in Call 1 cannot authorize WebRTC signaling in Call 2; Call 2 requires fresh mutual consent & readiness", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });
            const tokenOutsider = makeToken({ id: mockUserOutsider._id, username: mockUserOutsider.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });
            const { client: clientC } = await connectClient(port, { auth: { token: tokenOutsider } });

            // Call 1: Full consent + media readiness reached
            const match1Promise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const match1 = await match1Promise;

            await new Promise((res) => clientA.emit("random:consent", { callId: match1.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: match1.callId, consent: true }, res));

            await new Promise((res) => clientA.emit("random:media-ready", { callId: match1.callId }, res));
            await new Promise((res) => clientB.emit("random:media-ready", { callId: match1.callId }, res));

            assert.equal(randomTesting.getCallState(match1.callId), "media_ready");

            // User A skips to Next match
            await new Promise((res) => clientA.emit("random:next", { callId: match1.callId }, res));

            // User C joins -> Call 2 matched
            const match2APromise = new Promise((res) => clientA.once("random:matched", res));
            const match2CPromise = new Promise((res) => clientC.once("random:matched", res));
            await new Promise((res) => clientC.emit("random:join-queue", {}, res));
            const [match2A, match2C] = await Promise.all([match2APromise, match2CPromise]);

            // Call 2 starts fresh in consent_pending
            assert.equal(randomTesting.getCallState(match2A.callId), "consent_pending");

            // Attempting signaling on Call 2 immediately must be gated
            const prematureSignal2 = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match2A.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(prematureSignal2.success, false);
            assert.equal(prematureSignal2.code, "SIGNAL_GATE_RESTRICTED");

            // User A consents for Call 2; User C has not consented yet -> signaling still gated
            await new Promise((res) => clientA.emit("random:consent", { callId: match2A.callId, consent: true }, res));
            const signalAfterSingleConsent = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match2A.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalAfterSingleConsent.success, false);
            assert.equal(signalAfterSingleConsent.code, "SIGNAL_GATE_RESTRICTED");

            // User C consents -> Call 2 transitions to media_setup. Signaling still gated!
            await new Promise((res) => clientC.emit("random:consent", { callId: match2A.callId, consent: true }, res));
            assert.equal(randomTesting.getCallState(match2A.callId), "media_setup");

            const signalInMediaSetup = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match2A.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalInMediaSetup.success, false);
            assert.equal(signalInMediaSetup.code, "SIGNAL_GATE_RESTRICTED");

            // User A confirms media-ready for Call 2 -> still waiting for C
            await new Promise((res) => clientA.emit("random:media-ready", { callId: match2A.callId }, res));
            const signalWaitingForPartner = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match2A.callId,
                    signalData: { type: "offer", sdp: "v=0" },
                }, res);
            });
            assert.equal(signalWaitingForPartner.success, false);
            assert.equal(signalWaitingForPartner.code, "SIGNAL_GATE_RESTRICTED");

            // User C confirms media-ready -> Call 2 transitions to media_ready
            const mediaStartAPromise = new Promise((res) => clientA.once("random:media-start", res));
            const readyAckC = await new Promise((res) => clientC.emit("random:media-ready", { callId: match2A.callId }, res));
            assert.equal(readyAckC.success, true);
            assert.equal(readyAckC.status, "media_ready");
            await mediaStartAPromise;

            assert.equal(randomTesting.getCallState(match2A.callId), "media_ready");

            // Signaling is now authorized on Call 2
            const signalCReceive = new Promise((res) => clientC.once("random:signal", res));
            const finalSignalAck = await new Promise((res) => {
                clientA.emit("random:signal", {
                    callId: match2A.callId,
                    signalData: { type: "offer", sdp: "v=0\r\no=alice2" },
                }, res);
            });
            assert.equal(finalSignalAck.success, true);
            const received = await signalCReceive;
            assert.equal(received.signalData.type, "offer");

            clientA.disconnect();
            clientB.disconnect();
            clientC.disconnect();
        });

        it("Scenario 19: Idempotency of consent and media-ready prevents duplicate state transitions", async () => {
            const tokenA = makeToken({ id: mockUserA._id, username: mockUserA.username });
            const tokenB = makeToken({ id: mockUserB._id, username: mockUserB.username });

            const { client: clientA } = await connectClient(port, { auth: { token: tokenA } });
            const { client: clientB } = await connectClient(port, { auth: { token: tokenB } });

            const matchAPromise = new Promise((res) => clientA.once("random:matched", res));
            await new Promise((res) => clientA.emit("random:join-queue", {}, res));
            await new Promise((res) => clientB.emit("random:join-queue", {}, res));
            const matchA = await matchAPromise;

            let bothConsentedCount = 0;
            clientA.on("random:both-consented", () => bothConsentedCount++);
            clientB.on("random:both-consented", () => bothConsentedCount++);

            await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            await new Promise((res) => clientB.emit("random:consent", { callId: matchA.callId, consent: true }, res));

            // Wait a tick for events to settle
            await new Promise((res) => setTimeout(res, 30));
            assert.equal(bothConsentedCount, 2); // 1 for clientA, 1 for clientB

            // User A submits consent again: should return idempotently without duplicate both-consented
            const dupConsentAck = await new Promise((res) => clientA.emit("random:consent", { callId: matchA.callId, consent: true }, res));
            assert.equal(dupConsentAck.success, true);
            await new Promise((res) => setTimeout(res, 30));
            assert.equal(bothConsentedCount, 2);

            let mediaStartCount = 0;
            clientA.on("random:media-start", () => mediaStartCount++);
            clientB.on("random:media-start", () => mediaStartCount++);

            await new Promise((res) => clientA.emit("random:media-ready", { callId: matchA.callId }, res));
            await new Promise((res) => clientB.emit("random:media-ready", { callId: matchA.callId }, res));

            await new Promise((res) => setTimeout(res, 30));
            assert.equal(mediaStartCount, 2);

            // User A submits media-ready again: should return idempotently without duplicate media-start
            const dupMediaReadyAck = await new Promise((res) => clientA.emit("random:media-ready", { callId: matchA.callId }, res));
            assert.equal(dupMediaReadyAck.success, true);
            assert.equal(dupMediaReadyAck.status, "media_ready");
            await new Promise((res) => setTimeout(res, 30));
            assert.equal(mediaStartCount, 2);

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    // -------------------------------------------------------------
    // 5. Prompt 7.1: Frontend Asynchronous Media Lifecycle & Race Guard Simulation
    // -------------------------------------------------------------
    describe("Prompt 7.1: Frontend Asynchronous Media Lifecycle & Race Guard Simulation", () => {
        function createMockTrack(kind = "video") {
            let stopped = false;
            return {
                kind,
                stop: () => { stopped = true; },
                isStopped: () => stopped,
            };
        }

        function createMockStream() {
            const videoTrack = createMockTrack("video");
            const audioTrack = createMockTrack("audio");
            const tracks = [videoTrack, audioTrack];
            return {
                active: true,
                getTracks: () => tracks,
                getVideoTracks: () => [videoTrack],
                getAudioTracks: () => [audioTrack],
                areAllTracksStopped: () => tracks.every((t) => t.isStopped()),
            };
        }

        function createLifecycleHarness() {
            let mediaSessionToken = 0;
            let activeCallId = null;
            let localStream = null;
            const emittedEvents = [];

            const mockSocket = {
                emit: (event, payload) => emittedEvents.push({ event, payload }),
            };

            function stopLocalMedia() {
                if (localStream) {
                    localStream.getTracks().forEach((t) => t.stop());
                    localStream = null;
                }
            }

            function cleanupPeerConnection() {
                activeCallId = null;
            }

            async function initializeMedia(expectedCallId, getUserMediaPromise) {
                const sessionToken = mediaSessionToken;
                const targetCallId = expectedCallId || activeCallId;

                try {
                    if (localStream && localStream.active) {
                        return localStream;
                    }

                    const stream = await getUserMediaPromise;

                    // Race condition guard matching randomVideo.jsx
                    const isStale = (
                        sessionToken !== mediaSessionToken ||
                        !activeCallId ||
                        (targetCallId && activeCallId !== targetCallId)
                    );

                    if (isStale) {
                        if (stream) {
                            stream.getTracks().forEach((track) => {
                                try { track.stop(); } catch (e) {}
                            });
                        }
                        return null;
                    }

                    localStream = stream;
                    return stream;
                } catch (err) {
                    if (sessionToken !== mediaSessionToken || !activeCallId) {
                        return null;
                    }
                    throw err;
                }
            }

            async function handleBothConsented(consentedCallId, getUserMediaPromise) {
                if (!consentedCallId || consentedCallId !== activeCallId) {
                    return;
                }
                const currentToken = mediaSessionToken;
                const stream = await initializeMedia(consentedCallId, getUserMediaPromise);

                // Guard matching randomVideo.jsx line 519
                if (currentToken !== mediaSessionToken || activeCallId !== consentedCallId) {
                    return;
                }

                if (!stream) {
                    if (activeCallId === consentedCallId) {
                        mockSocket.emit("random:media-failed", {
                            callId: consentedCallId,
                            reason: "permission_denied",
                        });
                    }
                    return;
                }

                if (activeCallId === consentedCallId) {
                    mockSocket.emit("random:media-ready", { callId: consentedCallId });
                }
            }

            function handleMatched(newCallId) {
                mediaSessionToken += 1;
                stopLocalMedia();
                cleanupPeerConnection();
                activeCallId = newCallId;
            }

            function handleDeclineConsent() {
                mediaSessionToken += 1;
                stopLocalMedia();
                cleanupPeerConnection();
            }

            function handleNextMatch() {
                mediaSessionToken += 1;
                stopLocalMedia();
                cleanupPeerConnection();
            }

            function handleCallEnded() {
                mediaSessionToken += 1;
                stopLocalMedia();
                cleanupPeerConnection();
            }

            function handleUnmount() {
                mediaSessionToken += 1;
                stopLocalMedia();
                cleanupPeerConnection();
            }

            return {
                getToken: () => mediaSessionToken,
                getActiveCallId: () => activeCallId,
                getLocalStream: () => localStream,
                getEmittedEvents: () => emittedEvents,
                initializeMedia,
                handleBothConsented,
                handleMatched,
                handleDeclineConsent,
                handleNextMatch,
                handleCallEnded,
                handleUnmount,
            };
        }

        it("Scenario 20: User declines while getUserMedia() is pending; late resolution stops all tracks and suppresses media-ready", async () => {
            const harness = createLifecycleHarness();
            const callId = "call_test-1111";
            harness.handleMatched(callId);

            let resolveMedia;
            const pendingGUM = new Promise((resolve) => { resolveMedia = resolve; });

            // Both users consent -> starts media request
            const consentAction = harness.handleBothConsented(callId, pendingGUM);

            // While GUM is pending, user clicks Decline
            harness.handleDeclineConsent();
            assert.equal(harness.getActiveCallId(), null);

            // Late media resolves
            const mockStream = createMockStream();
            resolveMedia(mockStream);
            await consentAction;

            // Tracks must be stopped immediately
            assert.equal(mockStream.areAllTracksStopped(), true);
            // No local stream retained
            assert.equal(harness.getLocalStream(), null);
            // No media-ready or media-failed emitted to socket
            assert.deepEqual(harness.getEmittedEvents(), []);
        });

        it("Scenario 21: User clicks Next while getUserMedia() is pending; late resolution stops all tracks and suppresses media-ready", async () => {
            const harness = createLifecycleHarness();
            const callId = "call_test-2222";
            harness.handleMatched(callId);

            let resolveMedia;
            const pendingGUM = new Promise((resolve) => { resolveMedia = resolve; });

            const consentAction = harness.handleBothConsented(callId, pendingGUM);

            // User clicks Next while camera prompt pending
            harness.handleNextMatch();

            const mockStream = createMockStream();
            resolveMedia(mockStream);
            await consentAction;

            assert.equal(mockStream.areAllTracksStopped(), true);
            assert.equal(harness.getLocalStream(), null);
            assert.deepEqual(harness.getEmittedEvents(), []);
        });

        it("Scenario 22: Active call ends or partner disconnects while getUserMedia() is pending; late resolution stops all tracks", async () => {
            const harness = createLifecycleHarness();
            const callId = "call_test-3333";
            harness.handleMatched(callId);

            let resolveMedia;
            const pendingGUM = new Promise((resolve) => { resolveMedia = resolve; });

            const consentAction = harness.handleBothConsented(callId, pendingGUM);

            // Partner disconnects or declines -> random:call-ended received
            harness.handleCallEnded();

            const mockStream = createMockStream();
            resolveMedia(mockStream);
            await consentAction;

            assert.equal(mockStream.areAllTracksStopped(), true);
            assert.equal(harness.getLocalStream(), null);
            assert.deepEqual(harness.getEmittedEvents(), []);
        });

        it("Scenario 23: New partner is matched before previous getUserMedia() resolves; old tracks are stopped and new call is not contaminated", async () => {
            const harness = createLifecycleHarness();
            const call1Id = "call_test-4444";
            const call2Id = "call_test-5555";

            harness.handleMatched(call1Id);

            let resolveMedia1;
            const pendingGUM1 = new Promise((resolve) => { resolveMedia1 = resolve; });

            const consentAction1 = harness.handleBothConsented(call1Id, pendingGUM1);

            // Call 1 skipped, Call 2 matched immediately
            harness.handleMatched(call2Id);
            assert.equal(harness.getActiveCallId(), call2Id);

            // Call 1 GUM resolves late
            const mockStream1 = createMockStream();
            resolveMedia1(mockStream1);
            await consentAction1;

            // Call 1 tracks stopped immediately
            assert.equal(mockStream1.areAllTracksStopped(), true);
            // Local stream in harness must NOT be set to Call 1 stream
            assert.equal(harness.getLocalStream(), null);
            // Call 1 must not emit media-ready or media-failed for Call 1 or Call 2
            assert.deepEqual(harness.getEmittedEvents(), []);
        });

        it("Scenario 24: Component unmounts while getUserMedia() is pending; late resolution stops all acquired tracks", async () => {
            const harness = createLifecycleHarness();
            const callId = "call_test-6666";
            harness.handleMatched(callId);

            let resolveMedia;
            const pendingGUM = new Promise((resolve) => { resolveMedia = resolve; });

            const consentAction = harness.handleBothConsented(callId, pendingGUM);

            // User navigates away / unmounts
            harness.handleUnmount();

            const mockStream = createMockStream();
            resolveMedia(mockStream);
            await consentAction;

            assert.equal(mockStream.areAllTracksStopped(), true);
            assert.equal(harness.getLocalStream(), null);
            assert.deepEqual(harness.getEmittedEvents(), []);
        });
    });
});

