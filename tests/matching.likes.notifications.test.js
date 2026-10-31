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
import { Swipe } from "../src/models/swipe.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Block } from "../src/models/block.model.js";
import { Notification } from "../src/models/notification.model.js";

import discoveryRouter from "../src/routes/discovery.routes.js";
import matchRouter from "../src/routes/matches.routes.js";
import notificationRouter from "../src/routes/notification.routes.js";
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

describe("Prompt 10: Complete Matching, Likes, Notifications & Real-Time Chat Suite", () => {
    let server;
    let ioServer;
    let port;
    let app;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65ce11111111111111111111"),
        name: "Sophia Martinez",
        username: "sophia_m",
        dob: new Date("1996-04-12"),
        gender: "female",
        bio: "Traveler and espresso enthusiast",
        photos: ["https://example.com/sophia1.jpg"],
        interests: ["hiking", "coffee", "art"],
        isProfileComplete: true,
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65ce22222222222222222222"),
        name: "Liam Walker",
        username: "liam_w",
        dob: new Date("1994-09-18"),
        gender: "male",
        bio: "Rock climber and software dev",
        photos: ["https://example.com/liam1.jpg"],
        interests: ["climbing", "tech", "music"],
        isProfileComplete: true,
    };

    const mockUserC = {
        _id: new mongoose.Types.ObjectId("65ce33333333333333333333"),
        name: "Emma Watson",
        username: "emma_w",
        dob: new Date("1997-01-25"),
        gender: "female",
        bio: "Bookworm & photography",
        photos: ["https://example.com/emma1.jpg"],
        interests: ["books", "photography"],
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

    let inMemorySwipes = [];
    let inMemoryMatches = [];
    let inMemoryConversations = [];
    let inMemoryBlocks = [];

    const origUserFindById = User.findById;
    const origUserFind = User.find;
    const origBlockGetBlockedUserIds = Block.getBlockedUserIds;
    const origSwipeFind = Swipe.find;
    const origSwipeFindOne = Swipe.findOne;
    const origSwipeCreate = Swipe.create;
    const origMatchFind = Match.find;
    const origMatchFindOne = Match.findOne;
    const origMatchCreate = Match.create;
    const origMatchGetCanonicalPair = Match.getCanonicalPair;
    const origConvFindOne = Conversation.findOne;
    const origConvCreate = Conversation.create;

    before(async () => {
        app = express();
        app.use(express.json());

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        // Mount API routes
        app.use("/api/v1/discovery", discoveryRouter);
        app.use("/api/v1/matches", matchRouter);
        app.use("/api/v1/notifications", notificationRouter);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });

        // Setup model mocks
        User.findById = (id) => {
            const found = userMap[id?.toString()];
            return {
                select: () => Promise.resolve(found ? { ...found } : null),
                then: (resolve) => resolve(found ? { ...found } : null),
            };
        };

        User.find = (filter) => {
            let list = Object.values(userMap);
            if (filter?._id?.$in) {
                const idSet = new Set(filter._id.$in.map((i) => i.toString()));
                list = list.filter((u) => idSet.has(u._id.toString()));
            }
            if (filter?.isProfileComplete !== undefined) {
                list = list.filter((u) => u.isProfileComplete === filter.isProfileComplete);
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
    });

    after(async () => {
        User.findById = origUserFindById;
        User.find = origUserFind;
        Block.getBlockedUserIds = origBlockGetBlockedUserIds;
        Swipe.find = origSwipeFind;
        Swipe.findOne = origSwipeFindOne;
        Swipe.create = origSwipeCreate;
        Match.find = origMatchFind;
        Match.findOne = origMatchFindOne;
        Match.create = origMatchCreate;
        Match.getCanonicalPair = origMatchGetCanonicalPair;
        Conversation.findOne = origConvFindOne;
        Conversation.create = origConvCreate;

        if (ioServer) {
            await new Promise((resolve) => ioServer.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        inMemorySwipes = [];
        inMemoryMatches = [];
        inMemoryConversations = [];
        inMemoryBlocks = [];
        _resetInMemoryNotifications();

        Swipe.find = (filter = {}) => {
            let res = [...inMemorySwipes];
            if (filter.toUser) {
                res = res.filter((s) => s.toUser.toString() === filter.toUser.toString());
            }
            if (filter.fromUser) {
                res = res.filter((s) => s.fromUser.toString() === filter.fromUser.toString());
            }
            if (filter.action) {
                res = res.filter((s) => s.action === filter.action);
            }
            return {
                sort: () => ({
                    select: () => Promise.resolve(res),
                    then: (resolve) => resolve(res),
                }),
                select: () => Promise.resolve(res),
                then: (resolve) => resolve(res),
            };
        };

        Swipe.findOne = async (filter) => {
            return inMemorySwipes.find((s) => {
                if (filter.fromUser && s.fromUser.toString() !== filter.fromUser.toString()) return false;
                if (filter.toUser && s.toUser.toString() !== filter.toUser.toString()) return false;
                if (filter.action && s.action !== filter.action) return false;
                return true;
            }) || null;
        };

        Swipe.create = async (doc) => {
            const exists = inMemorySwipes.some(
                (s) => s.fromUser.toString() === doc.fromUser.toString() && s.toUser.toString() === doc.toUser.toString()
            );
            if (exists) {
                const err = new Error("E11000 duplicate key error");
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

        Match.find = (filter) => {
            let res = [...inMemoryMatches];
            if (filter.users) {
                const target = filter.users.toString();
                res = res.filter((m) => m.users.some((u) => u.toString() === target));
            }
            return {
                sort: () => ({
                    skip: () => ({
                        limit: () => ({
                            populate: () => Promise.resolve(res),
                            then: (resolve) => resolve(res),
                        }),
                    }),
                }),
                select: () => Promise.resolve(res),
                then: (resolve) => resolve(res),
            };
        };

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

        Conversation.findOne = (filter) => {
            const found = inMemoryConversations.find((c) => {
                if (filter.match && c.match.toString() !== filter.match.toString()) return false;
                return true;
            }) || null;
            return {
                select: () => Promise.resolve(found),
                then: (resolve) => resolve(found),
            };
        };

        Conversation.find = () => ({
            select: () => Promise.resolve(inMemoryConversations),
            then: (resolve) => resolve(inMemoryConversations),
        });

        Conversation.create = async (doc) => {
            const record = {
                _id: new mongoose.Types.ObjectId(),
                participants: doc.participants,
                match: doc.match,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            inMemoryConversations.push(record);
            return record;
        };
    });

    describe("1. Unilateral Like & In-App Notification Delivery", () => {
        it("User A likes User B: creates swipe record, emits real-time notification, and increments unread count", async () => {
            // Connect User B's socket
            const { client: clientB } = await connectClient(port, tokenB);

            const receivedNotifications = [];
            clientB.on("notification:new", (data) => {
                receivedNotifications.push(data);
            });

            // User A likes User B via POST /api/v1/discovery/swipe
            const res = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.action, "like");
            assert.equal(res.body.isMatch, false);

            // Wait brief moment for socket delivery
            await new Promise((r) => setTimeout(r, 80));

            // Verify User B received real-time socket event
            assert.equal(receivedNotifications.length, 1);
            const eventPayload = receivedNotifications[0].notification;
            assert.equal(eventPayload.type, "like");
            assert.equal(eventPayload.recipient, mockUserB._id.toString());
            assert.equal(eventPayload.sender._id, mockUserA._id.toString());
            assert.equal(eventPayload.sender.name, mockUserA.name);
            assert.equal(eventPayload.sender.username, undefined, "Username must never be exposed");
            assert.equal(eventPayload.sender.dob, undefined, "DOB must never be exposed");

            // Verify User B unread notification count
            const unreadRes = await request(app)
                .get("/api/v1/notifications/unread-count")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(unreadRes.status, 200);
            assert.equal(unreadRes.body.unreadCount, 1);

            // Verify User B notifications feed
            const notifFeedRes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(notifFeedRes.status, 200);
            assert.equal(notifFeedRes.body.notifications.length, 1);
            assert.equal(notifFeedRes.body.notifications[0].type, "like");
            assert.equal(notifFeedRes.body.notifications[0].read, false);

            clientB.disconnect();
        });

        it("User A appears in User B's 'Likes You' feed with accurate public profile and timestamp", async () => {
            // User A likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            // User B queries GET /api/v1/matches/likes-you
            const likesYouRes = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(likesYouRes.status, 200);
            assert.equal(likesYouRes.body.success, true);
            assert.equal(likesYouRes.body.profiles.length, 1);

            const profile = likesYouRes.body.profiles[0];
            assert.equal(profile._id, mockUserA._id.toString());
            assert.equal(profile.name, mockUserA.name);
            assert.ok(profile.age > 0, "Age should be calculated");
            assert.ok(profile.likedAt !== undefined, "likedAt timestamp must be present");
            assert.equal(profile.username, undefined, "Sensitive username excluded");
            assert.equal(profile.dob, undefined, "Sensitive DOB excluded");

            // User A queries their own 'Likes You' feed: User A must NOT appear
            const aLikesYouRes = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenA}`);

            assert.equal(aLikesYouRes.status, 200);
            assert.equal(aLikesYouRes.body.profiles.length, 0);
        });
    });

    describe("2. Mutual Match Creation, Dual Notifications & Conversation Generation", () => {
        it("User B likes User A back: forms mutual match, creates canonical conversation, emits match events and dual notifications", async () => {
            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            const aMatchEvents = [];
            const bMatchEvents = [];
            const aNotifEvents = [];
            const bNotifEvents = [];

            clientA.on("match:new", (data) => aMatchEvents.push(data));
            clientB.on("match:new", (data) => bMatchEvents.push(data));
            clientA.on("notification:new", (data) => aNotifEvents.push(data));
            clientB.on("notification:new", (data) => bNotifEvents.push(data));

            // Step 1: User A likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            // Step 2: User B likes User A (reciprocal swipe)
            const matchRes = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenB}`)
                .send({
                    targetUserId: mockUserA._id.toString(),
                    action: "like",
                });

            assert.equal(matchRes.status, 201);
            assert.equal(matchRes.body.success, true);
            assert.equal(matchRes.body.isMatch, true);
            assert.ok(matchRes.body.match._id);
            assert.ok(matchRes.body.match.conversationId);

            // Exactly 1 canonical Match and 1 canonical Conversation created
            assert.equal(inMemoryMatches.length, 1);
            assert.equal(inMemoryConversations.length, 1);

            await new Promise((r) => setTimeout(r, 80));

            // Verify real-time socket events
            assert.equal(aMatchEvents.length, 1);
            assert.equal(bMatchEvents.length, 1);
            assert.equal(aMatchEvents[0].match.matchedUser._id, mockUserB._id.toString());
            assert.equal(bMatchEvents[0].match.matchedUser._id, mockUserA._id.toString());

            // Verify both users received a match notification
            const notifARes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenA}`);

            const notifBRes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenB}`);

            const aMatchNotif = notifARes.body.notifications.find((n) => n.type === "match");
            const bMatchNotif = notifBRes.body.notifications.find((n) => n.type === "match");

            assert.ok(aMatchNotif, "User A must have received match notification");
            assert.ok(bMatchNotif, "User B must have received match notification");
            assert.equal(aMatchNotif.sender._id, mockUserB._id.toString());
            assert.equal(bMatchNotif.sender._id, mockUserA._id.toString());

            // User A is now matched with User B, so User A must disappear from User B's 'Likes You' feed
            const bLikesYou = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(bLikesYou.body.profiles.length, 0, "Matched users must no longer appear in Likes You");

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    describe("3. Notification Read & Management APIs", () => {
        it("marks single notification as read and marks all notifications as read", async () => {
            // User A likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            // User C likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenC}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            // User B should have 2 unread notifications
            const countRes1 = await request(app)
                .get("/api/v1/notifications/unread-count")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(countRes1.body.unreadCount, 2);

            // Fetch notifications
            const feedRes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(feedRes.body.notifications.length, 2);

            const firstId = feedRes.body.notifications[0]._id;

            // Mark first notification as read
            const readRes = await request(app)
                .patch(`/api/v1/notifications/${firstId}/read`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(readRes.status, 200);
            assert.equal(readRes.body.success, true);
            assert.equal(readRes.body.notification.read, true);

            // Unread count should now be 1
            const countRes2 = await request(app)
                .get("/api/v1/notifications/unread-count")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(countRes2.body.unreadCount, 1);

            // Mark all remaining notifications as read
            const readAllRes = await request(app)
                .patch("/api/v1/notifications/read-all")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(readAllRes.status, 200);
            assert.equal(readAllRes.body.success, true);

            // Unread count should now be 0
            const countRes3 = await request(app)
                .get("/api/v1/notifications/unread-count")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(countRes3.body.unreadCount, 0);
        });

        it("unauthorized user cannot mark another user's notification as read", async () => {
            // User A likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            const feedRes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenB}`);

            const notifId = feedRes.body.notifications[0]._id;

            // User C tries to mark User B's notification read
            const unauthorizedRead = await request(app)
                .patch(`/api/v1/notifications/${notifId}/read`)
                .set("Authorization", `Bearer ${tokenC}`);

            assert.equal(unauthorizedRead.status, 404);
        });
    });

    describe("4. Safety, Privacy & Block Protections", () => {
        it("suppresses notifications and hides profile from 'Likes You' when sender is blocked", async () => {
            // User A likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({
                    targetUserId: mockUserB._id.toString(),
                    action: "like",
                });

            // User B blocks User A
            inMemoryBlocks.push({
                blocker: mockUserB._id,
                blocked: mockUserA._id,
            });

            // User B views Likes You: User A must be excluded
            const likesYouRes = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(likesYouRes.body.profiles.length, 0);

            // User B views notifications: User A's notification must be hidden
            const notifRes = await request(app)
                .get("/api/v1/notifications")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(notifRes.body.notifications.length, 0);
            assert.equal(notifRes.body.unreadCount, 0);
        });

        it("requires authentication for notification and likes-you endpoints", async () => {
            const res1 = await request(app).get("/api/v1/notifications");
            assert.equal(res1.status, 401);

            const res2 = await request(app).get("/api/v1/notifications/unread-count");
            assert.equal(res2.status, 401);

            const res3 = await request(app).get("/api/v1/matches/likes-you");
            assert.equal(res3.status, 401);
        });
    });
});

