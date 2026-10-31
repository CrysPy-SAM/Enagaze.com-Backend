import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { getJwtSecret } from "../src/config/jwt.js";
import { User } from "../src/models/user.model.js";
import { Call } from "../src/models/call.model.js";
import { Notification } from "../src/models/notification.model.js";
import callRouter from "../src/routes/call.routes.js";
import {
    recordCallInitiated,
    recordCallAccepted,
    recordCallEnded,
    getUnseenMissedCallsCount,
} from "../src/controllers/call.controller.js";

function makeToken(payload, options = {}) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: "1h", ...options });
}

describe("Phase 2: Persistent Call History & Missed Call Notifications Test Suite", () => {
    let server;
    let app;

    let originalUserFindById;
    let originalUserFindOne;

    let originalCallFindOneAndUpdate;
    let originalCallFindOne;
    let originalCallFind;
    let originalCallCountDocuments;
    let originalCallUpdateMany;

    let originalNotifFindOne;
    let originalNotifCreate;
    let originalNotifUpdateMany;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65ca11111111111111111111"),
        name: "Alice Caller",
        username: "alice_caller",
        dob: new Date("1996-03-12"),
        gender: "female",
        bio: "Photography and hiking",
        photos: ["https://example.com/alice.jpg"],
        isProfileComplete: true,
        age: 28,
        usernameSetupCompleted: true,
        accountStatus: "active",
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65ca22222222222222222222"),
        name: "Bob Receiver",
        username: "bob_receiver",
        dob: new Date("1994-07-21"),
        gender: "male",
        bio: "Coffee and guitar",
        photos: ["https://example.com/bob.jpg"],
        isProfileComplete: true,
        age: 30,
        usernameSetupCompleted: true,
        accountStatus: "active",
    };

    const mockUserC = {
        _id: new mongoose.Types.ObjectId("65ca33333333333333333333"),
        name: "Charlie ThirdParty",
        username: "charlie_third",
        dob: new Date("1995-05-15"),
        gender: "male",
        bio: "Running and tech",
        photos: ["https://example.com/charlie.jpg"],
        isProfileComplete: true,
        age: 29,
        usernameSetupCompleted: true,
        accountStatus: "active",
    };

    const userMap = {
        [mockUserA._id.toString()]: { ...mockUserA },
        [mockUserB._id.toString()]: { ...mockUserB },
        [mockUserC._id.toString()]: { ...mockUserC },
    };

    let inMemoryCalls = [];
    let inMemoryNotifications = [];
    let originalReadyStateDescriptor;

    before(async () => {
        originalReadyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;

        originalCallFindOneAndUpdate = Call.findOneAndUpdate;
        originalCallFindOne = Call.findOne;
        originalCallFind = Call.find;
        originalCallCountDocuments = Call.countDocuments;
        originalCallUpdateMany = Call.updateMany;

        originalNotifFindOne = Notification.findOne;
        originalNotifCreate = Notification.create;
        originalNotifUpdateMany = Notification.updateMany;

        User.findById = (id) => {
            const found = userMap[id?.toString()] || null;
            return {
                select: () => Promise.resolve(found),
                lean: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        User.findOne = (query) => {
            const found = query?._id ? userMap[query._id.toString()] : null;
            return {
                select: () => Promise.resolve(found),
                lean: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        // In-memory Call mock
        Call.findOneAndUpdate = async (filter, update, options) => {
            let doc = inMemoryCalls.find((c) => c.callId === filter.callId);
            if (!doc && options?.upsert) {
                const insertData = update.$setOnInsert || {};
                doc = {
                    _id: new mongoose.Types.ObjectId(),
                    ...insertData,
                    seenBy: insertData.seenBy ? [...insertData.seenBy] : [],
                    participants: insertData.participants ? [...insertData.participants] : [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    save: async function () {
                        this.updatedAt = new Date();
                        return this;
                    },
                };
                inMemoryCalls.push(doc);
            }
            return doc;
        };

        Call.findOne = async (filter) => {
            const doc = inMemoryCalls.find((c) => c.callId === filter.callId);
            if (!doc) return null;
            if (!doc.save) {
                doc.save = async function () {
                    this.updatedAt = new Date();
                    return this;
                };
            }
            return doc;
        };

        Call.countDocuments = async (query) => {
            return inMemoryCalls.filter((c) => {
                if (query.receiver && c.receiver.toString() !== query.receiver.toString()) return false;
                if (query.status && c.status !== query.status) return false;
                if (query.seenBy && query.seenBy.$ne) {
                    const hasSeen = c.seenBy && c.seenBy.some((id) => id.toString() === query.seenBy.$ne.toString());
                    if (hasSeen) return false;
                }
                if (query.participants) {
                    const hasParticipant = c.participants && c.participants.some((p) => p.toString() === query.participants.toString());
                    if (!hasParticipant) return false;
                }
                return true;
            }).length;
        };

        Call.updateMany = async (filter, update) => {
            let count = 0;
            for (const c of inMemoryCalls) {
                if (filter.receiver && c.receiver.toString() !== filter.receiver.toString()) continue;
                if (filter.status && c.status !== filter.status) continue;
                if (filter.seenBy && filter.seenBy.$ne) {
                    const hasSeen = c.seenBy && c.seenBy.some((id) => id.toString() === filter.seenBy.$ne.toString());
                    if (hasSeen) continue;
                }

                if (update.$addToSet && update.$addToSet.seenBy) {
                    const toAdd = update.$addToSet.seenBy;
                    if (!c.seenBy.some((id) => id.toString() === toAdd.toString())) {
                        c.seenBy.push(toAdd);
                        count++;
                    }
                }
            }
            return { modifiedCount: count };
        };

        Call.find = (query) => {
            const filtered = inMemoryCalls.filter((c) => {
                if (query.participants) {
                    const hasParticipant = c.participants && c.participants.some((p) => p.toString() === query.participants.toString());
                    if (!hasParticipant) return false;
                }
                if (query.callType && c.callType !== query.callType) return false;
                if (query.receiver && c.receiver.toString() !== query.receiver.toString()) return false;
                if (query.status) {
                    if (query.status.$in) {
                        if (!query.status.$in.includes(c.status)) return false;
                    } else if (c.status !== query.status) {
                        return false;
                    }
                }
                return true;
            });

            const chain = {
                sort: () => chain,
                skip: (n) => {
                    return chain;
                },
                limit: (n) => chain,
                populate: (field, select) => chain,
                lean: () => {
                    return Promise.resolve(
                        filtered.map((c) => ({
                            ...c,
                            caller: userMap[c.caller.toString()] || { _id: c.caller },
                            receiver: userMap[c.receiver.toString()] || { _id: c.receiver },
                        }))
                    );
                },
                then: (resolve) =>
                    resolve(
                        filtered.map((c) => ({
                            ...c,
                            caller: userMap[c.caller.toString()] || { _id: c.caller },
                            receiver: userMap[c.receiver.toString()] || { _id: c.receiver },
                        }))
                    ),
            };
            return chain;
        };

        // In-memory Notification mock
        Notification.findOne = async (filter) => {
            return inMemoryNotifications.find((n) => {
                if (filter.recipient && n.recipient.toString() !== filter.recipient.toString()) return false;
                if (filter["data.callId"] && n.data?.callId !== filter["data.callId"]) return false;
                if (filter.type && n.type !== filter.type) return false;
                return true;
            }) || null;
        };

        Notification.create = async (doc) => {
            const created = {
                _id: new mongoose.Types.ObjectId(),
                ...doc,
                createdAt: new Date(),
            };
            inMemoryNotifications.push(created);
            return created;
        };

        Notification.updateMany = async (filter, update) => {
            let count = 0;
            for (const n of inMemoryNotifications) {
                if (filter.recipient && n.recipient.toString() !== filter.recipient.toString()) continue;
                if (filter.type && n.type !== filter.type) continue;
                if (filter.read === false && n.read !== false) continue;

                if (update.$set) {
                    Object.assign(n, update.$set);
                    count++;
                }
            }
            return { modifiedCount: count };
        };

        app = express();
        app.use(express.json());
        app.use("/api/v1/calls", callRouter);

        server = createServer(app);
        await new Promise((resolve) => server.listen(0, resolve));
    });

    after(async () => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;

        Call.findOneAndUpdate = originalCallFindOneAndUpdate;
        Call.findOne = originalCallFindOne;
        Call.find = originalCallFind;
        Call.countDocuments = originalCallCountDocuments;
        Call.updateMany = originalCallUpdateMany;

        Notification.findOne = originalNotifFindOne;
        Notification.create = originalNotifCreate;
        Notification.updateMany = originalNotifUpdateMany;

        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }

        if (originalReadyStateDescriptor) {
            Object.defineProperty(mongoose.connection, "readyState", originalReadyStateDescriptor);
        } else {
            delete mongoose.connection.readyState;
        }
    });

    beforeEach(async () => {
        inMemoryCalls = [];
        inMemoryNotifications = [];
    });

    // -------------------------------------------------------------
    // 1. Successful Completed Call Lifecycle
    // -------------------------------------------------------------
    it("1. Correctly handles successful completed call with accurate duration and answer time", async () => {
        const callId = "call_test_completed_1";

        // Step 1: Initiate
        const initiatedCall = await recordCallInitiated({
            callId,
            callerId: mockUserA._id,
            calleeId: mockUserB._id,
            callType: "video",
            receiverAlerted: true,
        });
        assert.equal(initiatedCall.status, "ringing");
        assert.equal(initiatedCall.receiverAlerted, true);

        // Step 2: Accept
        const acceptedCall = await recordCallAccepted({ callId });
        assert.equal(acceptedCall.status, "connected");
        assert.ok(acceptedCall.answeredAt instanceof Date);

        // Manually adjust answeredAt to 45 seconds ago to verify exact duration calculation
        acceptedCall.answeredAt = new Date(Date.now() - 45000);

        // Step 3: End Call
        const endedCall = await recordCallEnded({
            callId,
            endReason: "ended_by_partner",
            endedByUserId: mockUserA._id,
        });

        assert.equal(endedCall.status, "completed");
        assert.ok(endedCall.duration >= 44 && endedCall.duration <= 46, `Expected ~45s duration, got ${endedCall.duration}`);
        assert.ok(endedCall.endedAt instanceof Date);
    });

    // -------------------------------------------------------------
    // 2. Missed Incoming Call (Receiver Alerted -> Timed out)
    // -------------------------------------------------------------
    it("2. Records missed call for alerted receiver on ringing timeout and increments unseen missed count", async () => {
        const callId = "call_test_missed_timeout";

        await recordCallInitiated({
            callId,
            callerId: mockUserA._id,
            calleeId: mockUserB._id,
            callType: "video",
            receiverAlerted: true,
        });

        // Ringing timed out after 35s
        const endedCall = await recordCallEnded({
            callId,
            endReason: "timeout",
        });

        assert.equal(endedCall.status, "missed");
        assert.equal(endedCall.duration, 0);

        // Check unseen count for Bob (receiver)
        const bobUnseen = await getUnseenMissedCallsCount(mockUserB._id);
        assert.equal(bobUnseen, 1);

        // Alice (caller) did not receive the missed call, so unseen count is 0
        const aliceUnseen = await getUnseenMissedCallsCount(mockUserA._id);
        assert.equal(aliceUnseen, 0);

        // Verify in-app Notification was created for Bob
        const notif = await Notification.findOne({ recipient: mockUserB._id, "data.callId": callId });
        assert.ok(notif, "Notification record should be created for receiver");
        assert.equal(notif.type, "missed_call");
    });

    // -------------------------------------------------------------
    // 3. Caller Cancels While Ringing (Receiver Alerted -> Missed)
    // -------------------------------------------------------------
    it("3. Records missed call for alerted receiver when caller cancels before answer", async () => {
        const callId = "call_test_caller_cancels";

        await recordCallInitiated({
            callId,
            callerId: mockUserA._id,
            calleeId: mockUserB._id,
            callType: "video",
            receiverAlerted: true,
        });

        // Caller hangs up while ringing
        const endedCall = await recordCallEnded({
            callId,
            endReason: "cancelled",
            endedByUserId: mockUserA._id,
        });

        assert.equal(endedCall.status, "missed");
        const bobUnseen = await getUnseenMissedCallsCount(mockUserB._id);
        assert.equal(bobUnseen, 1);
    });

    // -------------------------------------------------------------
    // 4. Receiver Never Alerted -> NOT Marked as Missed
    // -------------------------------------------------------------
    it("4. Does NOT mark call as missed when receiver was never alerted (offline/unreachable)", async () => {
        const callId = "call_test_receiver_offline";

        // Receiver has 0 sockets connected (receiverAlerted = false)
        await recordCallInitiated({
            callId,
            callerId: mockUserA._id,
            calleeId: mockUserB._id,
            callType: "video",
            receiverAlerted: false,
        });

        // Timeout or cancellation
        const endedCall = await recordCallEnded({
            callId,
            endReason: "timeout",
        });

        // Outcome must be "no_answer" or "cancelled", NEVER "missed"
        assert.equal(endedCall.status, "no_answer");

        // Receiver was never rung, so unseen missed count is 0
        const bobUnseen = await getUnseenMissedCallsCount(mockUserB._id);
        assert.equal(bobUnseen, 0);

        // No notification should be created
        const notif = await Notification.findOne({ recipient: mockUserB._id, "data.callId": callId });
        assert.equal(notif, null);
    });

    // -------------------------------------------------------------
    // 5. Rejected Call by Receiver
    // -------------------------------------------------------------
    it("5. Records rejected status when callee declines call and does NOT count as missed", async () => {
        const callId = "call_test_rejected";

        await recordCallInitiated({
            callId,
            callerId: mockUserA._id,
            calleeId: mockUserB._id,
            callType: "video",
            receiverAlerted: true,
        });

        // Callee declines
        const endedCall = await recordCallEnded({
            callId,
            endReason: "declined",
            endedByUserId: mockUserB._id,
        });

        assert.equal(endedCall.status, "rejected");
        assert.equal(endedCall.duration, 0);

        // Not counted as missed call
        const bobUnseen = await getUnseenMissedCallsCount(mockUserB._id);
        assert.equal(bobUnseen, 0);
    });

    // -------------------------------------------------------------
    // 6. Idempotency & Terminal Status Protection
    // -------------------------------------------------------------
    it("6. Idempotently prevents duplicate end events or disconnects from overwriting a completed call", async () => {
        const callId = "call_test_idempotent";

        await recordCallInitiated({
            callId,
            callerId: mockUserA._id,
            calleeId: mockUserB._id,
            receiverAlerted: true,
        });
        const accepted = await recordCallAccepted({ callId });

        // First end event: successfully completed with 60s duration
        accepted.answeredAt = new Date(Date.now() - 60000);

        const firstEnd = await recordCallEnded({
            callId,
            endReason: "ended_by_partner",
        });
        assert.equal(firstEnd.status, "completed");
        const originalDuration = firstEnd.duration;
        assert.ok(originalDuration >= 59);

        // Late duplicate disconnect event arrives
        const secondEnd = await recordCallEnded({
            callId,
            endReason: "partner_disconnected",
        });

        // Status and duration must remain intact
        assert.equal(secondEnd.status, "completed");
        assert.equal(secondEnd.duration, originalDuration);
    });

    // -------------------------------------------------------------
    // 7. REST API: GET /api/v1/calls/history
    // -------------------------------------------------------------
    it("7. GET /api/v1/calls/history returns paginated history for authenticated user only", async () => {
        // Create 2 calls between Alice and Bob
        await recordCallInitiated({ callId: "c1", callerId: mockUserA._id, calleeId: mockUserB._id, receiverAlerted: true });
        await recordCallEnded({ callId: "c1", endReason: "timeout" }); // Missed for Bob, Outgoing for Alice

        await recordCallInitiated({ callId: "c2", callerId: mockUserB._id, calleeId: mockUserA._id, receiverAlerted: true });
        await recordCallAccepted({ callId: "c2" });
        await recordCallEnded({ callId: "c2", endReason: "ended_by_partner" }); // Completed

        // Create 1 call between Charlie and Bob (Alice is NOT a participant)
        await recordCallInitiated({ callId: "c3", callerId: mockUserC._id, calleeId: mockUserB._id, receiverAlerted: true });
        await recordCallEnded({ callId: "c3", endReason: "timeout" });

        const aliceToken = makeToken({ id: mockUserA._id.toString() });

        // Unauthenticated request should fail (401)
        const unauthRes = await request(app).get("/api/v1/calls/history");
        assert.equal(unauthRes.status, 401);

        // Authenticated Alice request
        const res = await request(app)
            .get("/api/v1/calls/history")
            .set("Authorization", `Bearer ${aliceToken}`);

        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.calls.length, 2); // Only c1 and c2; c3 is excluded

        // Check call direction formatting
        const c1 = res.body.calls.find((c) => c.callId === "c1");
        assert.equal(c1.direction, "outgoing");
        assert.equal(c1.status, "no_answer"); // From caller perspective, it's no_answer
        assert.equal(c1.isMissed, false);

        const c2 = res.body.calls.find((c) => c.callId === "c2");
        assert.equal(c2.direction, "incoming");
        assert.equal(c2.status, "completed");

        // Authenticated Bob request
        const bobToken = makeToken({ id: mockUserB._id.toString() });
        const bobRes = await request(app)
            .get("/api/v1/calls/history")
            .set("Authorization", `Bearer ${bobToken}`);

        assert.equal(bobRes.status, 200);
        assert.equal(bobRes.body.calls.length, 3); // Bob was in c1, c2, c3

        const bobC1 = bobRes.body.calls.find((c) => c.callId === "c1");
        assert.equal(bobC1.direction, "incoming");
        assert.equal(bobC1.status, "missed");
        assert.equal(bobC1.isMissed, true);
    });

    // -------------------------------------------------------------
    // 8. REST API: GET /api/v1/calls/missed-count & POST /api/v1/calls/mark-seen
    // -------------------------------------------------------------
    it("8. Marks missed calls as seen without deleting call history records", async () => {
        // Bob receives 2 missed calls
        await recordCallInitiated({ callId: "m1", callerId: mockUserA._id, calleeId: mockUserB._id, receiverAlerted: true });
        await recordCallEnded({ callId: "m1", endReason: "timeout" });

        await recordCallInitiated({ callId: "m2", callerId: mockUserC._id, calleeId: mockUserB._id, receiverAlerted: true });
        await recordCallEnded({ callId: "m2", endReason: "timeout" });

        const bobToken = makeToken({ id: mockUserB._id.toString() });

        // Initial count check
        const countResBefore = await request(app)
            .get("/api/v1/calls/missed-count")
            .set("Authorization", `Bearer ${bobToken}`);

        assert.equal(countResBefore.status, 200);
        assert.equal(countResBefore.body.count, 2);

        // Mark as seen
        const markSeenRes = await request(app)
            .post("/api/v1/calls/mark-seen")
            .set("Authorization", `Bearer ${bobToken}`);

        assert.equal(markSeenRes.status, 200);
        assert.equal(markSeenRes.body.success, true);
        assert.equal(markSeenRes.body.markedCount, 2);

        // Subsequent count check should return 0
        const countResAfter = await request(app)
            .get("/api/v1/calls/missed-count")
            .set("Authorization", `Bearer ${bobToken}`);

        assert.equal(countResAfter.status, 200);
        assert.equal(countResAfter.body.count, 0);

        // Call history must still retain both calls
        const historyRes = await request(app)
            .get("/api/v1/calls/history")
            .set("Authorization", `Bearer ${bobToken}`);

        assert.equal(historyRes.status, 200);
        assert.equal(historyRes.body.calls.length, 2);
        assert.equal(historyRes.body.unseenMissedCount, 0);
    });
});
