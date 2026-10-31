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
import { MatchRequest } from "../src/models/matchRequest.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Block } from "../src/models/block.model.js";

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

describe("Matches, Likes You & Requests Synchronization Suite", () => {
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
    let inMemoryRequests = [];
    let inMemoryBlocks = [];

    const origUserFindById = User.findById;
    const origUserFind = User.find;
    const origBlockGetBlockedUserIds = Block.getBlockedUserIds;
    const origBlockIsBlockedBidirectional = Block.isBlockedBidirectional;
    const origSwipeFind = Swipe.find;
    const origSwipeFindOne = Swipe.findOne;
    const origSwipeCreate = Swipe.create;
    const origMatchFind = Match.find;
    const origMatchFindOne = Match.findOne;
    const origMatchCreate = Match.create;
    const origMatchGetCanonicalPair = Match.getCanonicalPair;
    const origConvFindOne = Conversation.findOne;
    const origConvCreate = Conversation.create;
    const origMatchReqFindOne = MatchRequest.findOne;
    const origMatchReqFindById = MatchRequest.findById;
    const origMatchReqFind = MatchRequest.find;
    const origMatchReqFindOneAndUpdate = MatchRequest.findOneAndUpdate;
    const origMatchReqCreate = MatchRequest.create;

    before(async () => {
        app = express();
        app.use(express.json());

        server = createServer(app);
        ioServer = connectToSocket(server);
        app.set("io", ioServer);

        app.use("/api/v1/discovery", discoveryRouter);
        app.use("/api/v1/matches", matchRouter);
        app.use("/api/v1/notifications", notificationRouter);

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                port = server.address().port;
                resolve();
            });
        });

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

        Block.isBlockedBidirectional = async (u1, u2) => {
            const s1 = u1?.toString();
            const s2 = u2?.toString();
            return inMemoryBlocks.some(
                (b) =>
                    (b.blocker.toString() === s1 && b.blocked.toString() === s2) ||
                    (b.blocker.toString() === s2 && b.blocked.toString() === s1)
            );
        };
    });

    after(async () => {
        User.findById = origUserFindById;
        User.find = origUserFind;
        Block.getBlockedUserIds = origBlockGetBlockedUserIds;
        Block.isBlockedBidirectional = origBlockIsBlockedBidirectional;
        Swipe.find = origSwipeFind;
        Swipe.findOne = origSwipeFindOne;
        Swipe.create = origSwipeCreate;
        Match.find = origMatchFind;
        Match.findOne = origMatchFindOne;
        Match.create = origMatchCreate;
        Match.getCanonicalPair = origMatchGetCanonicalPair;
        Conversation.findOne = origConvFindOne;
        Conversation.create = origConvCreate;
        MatchRequest.findOne = origMatchReqFindOne;
        MatchRequest.findById = origMatchReqFindById;
        MatchRequest.find = origMatchReqFind;
        MatchRequest.findOneAndUpdate = origMatchReqFindOneAndUpdate;
        MatchRequest.create = origMatchReqCreate;

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
        inMemoryRequests = [];
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
            return (
                inMemorySwipes.find((s) => {
                    if (filter.fromUser && s.fromUser.toString() !== filter.fromUser.toString()) return false;
                    if (filter.toUser && s.toUser.toString() !== filter.toUser.toString()) return false;
                    if (filter.action && s.action !== filter.action) return false;
                    return true;
                }) || null
            );
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
            if (filter.status) {
                res = res.filter((m) => m.status === filter.status);
            }
            return {
                select: () => Promise.resolve(res),
                populate: () => Promise.resolve(res),
                sort: () => ({
                    skip: () => ({
                        limit: () => Promise.resolve(res),
                    }),
                    select: () => Promise.resolve(res),
                    then: (resolve) => resolve(res),
                }),
                then: (resolve) => resolve(res),
            };
        };

        Match.findOne = async (filter) => {
            return (
                inMemoryMatches.find((m) => {
                    if (filter.userPair && m.userPair !== filter.userPair) return false;
                    if (filter.status && m.status !== filter.status) return false;
                    if (filter._id && m._id.toString() !== filter._id.toString()) return false;
                    return true;
                }) || null
            );
        };

        Match.create = async (docs) => {
            const arr = Array.isArray(docs) ? docs : [docs];
            const created = arr.map((d) => ({
                _id: new mongoose.Types.ObjectId(),
                status: "active",
                ...d,
                createdAt: new Date(),
                updatedAt: new Date(),
            }));
            inMemoryMatches.push(...created);
            return Array.isArray(docs) ? created : created[0];
        };

        Match.getCanonicalPair = (u1, u2) => {
            const [first, second] = [u1.toString(), u2.toString()].sort();
            return `${first}_${second}`;
        };

        Conversation.findOne = async (filter) => {
            return (
                inMemoryConversations.find((c) => {
                    if (filter.match && c.match.toString() !== filter.match.toString()) return false;
                    if (filter._id && c._id.toString() !== filter._id.toString()) return false;
                    return true;
                }) || null
            );
        };

        Conversation.create = async (docs) => {
            const arr = Array.isArray(docs) ? docs : [docs];
            const created = arr.map((d) => ({
                _id: new mongoose.Types.ObjectId(),
                ...d,
                createdAt: new Date(),
                updatedAt: new Date(),
            }));
            inMemoryConversations.push(...created);
            return Array.isArray(docs) ? created : created[0];
        };

        MatchRequest.findOne = (filter) => {
            const found = inMemoryRequests.find((r) => {
                if (filter.sender && r.sender.toString() !== filter.sender.toString()) return false;
                if (filter.recipient && r.recipient.toString() !== filter.recipient.toString()) return false;
                if (filter.status && r.status !== filter.status) return false;
                return true;
            });
            return {
                sort: () => Promise.resolve(found || null),
                then: (resolve) => resolve(found || null),
            };
        };

        MatchRequest.findById = (id) => {
            const found = inMemoryRequests.find((r) => r._id.toString() === id.toString());
            return {
                populate: () => {
                    if (!found) return Promise.resolve(null);
                    return Promise.resolve({
                        ...found,
                        sender: userMap[found.sender.toString()],
                        recipient: userMap[found.recipient.toString()],
                    });
                },
                then: (resolve) => resolve(found || null),
            };
        };

        MatchRequest.find = (filter) => {
            let res = [...inMemoryRequests];
            if (filter.recipient) {
                res = res.filter((r) => r.recipient.toString() === filter.recipient.toString());
            }
            if (filter.status) {
                res = res.filter((r) => r.status === filter.status);
            }
            return {
                sort: () => ({
                    populate: () => Promise.resolve(
                        res.map((r) => ({
                            ...r,
                            sender: userMap[r.sender.toString()],
                        }))
                    ),
                    then: (resolve) => resolve(res),
                }),
                then: (resolve) => resolve(res),
            };
        };

        MatchRequest.create = async (doc) => {
            const record = {
                _id: new mongoose.Types.ObjectId(),
                ...doc,
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
            Object.assign(found, update);
            return found;
        };
    });

    describe("1. Likes You Synchronization & Badge/Count Lifecycle", () => {
        it("User A likes User B: emits like:new, updates counts, and displays profile in Likes You", async () => {
            const { client: clientB } = await connectClient(port, tokenB);

            let likeNewReceived = null;
            let countsReceived = null;

            clientB.on("like:new", (data) => {
                likeNewReceived = data;
            });
            clientB.on("notification:counts", (data) => {
                countsReceived = data;
            });

            // User A likes User B
            const swipeRes = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            assert.equal(swipeRes.status, 200);
            assert.equal(swipeRes.body.action, "like");
            assert.equal(swipeRes.body.isMatch, false);

            await new Promise((r) => setTimeout(r, 150));

            // Verify real-time socket events
            assert.ok(likeNewReceived, "Expected like:new event on User B client");
            assert.equal(likeNewReceived.profile.name, "Sophia Martinez");
            assert.ok(countsReceived, "Expected notification:counts event");
            assert.equal(countsReceived.unreadLikesCount, 1);
            assert.equal(countsReceived.unreadCount, 1);

            // Verify User B queries unread count API
            const unreadRes = await request(app)
                .get("/api/v1/notifications/unread-count")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(unreadRes.status, 200);
            assert.equal(unreadRes.body.unreadCount, 1);
            assert.equal(unreadRes.body.unreadLikesCount, 1);

            // Verify User B queries Likes You API
            const likesYouRes = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(likesYouRes.status, 200);
            assert.equal(likesYouRes.body.profiles.length, 1);
            assert.equal(likesYouRes.body.profiles[0].name, "Sophia Martinez");

            clientB.disconnect();
        });

        it("Viewing Likes You clears unread badge but preserves pending profile in feed", async () => {
            // Seed a like from A to B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            // Mark likes as read (User B opens Likes You section)
            const readRes = await request(app)
                .patch("/api/v1/notifications/read-type/like")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(readRes.status, 200);
            assert.equal(readRes.body.unreadLikesCount, 0);

            // Unread count is now 0
            const unreadRes = await request(app)
                .get("/api/v1/notifications/unread-count")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(unreadRes.body.unreadCount, 0);
            assert.equal(unreadRes.body.unreadLikesCount, 0);

            // But the pending profile is still present in Likes You
            const likesRes = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(likesRes.body.profiles.length, 1);
            assert.equal(likesRes.body.profiles[0].name, "Sophia Martinez");
        });

        it("User B likes User A back: forms mutual match and removes profile from pending Likes You", async () => {
            const { client: clientA } = await connectClient(port, tokenA);
            const { client: clientB } = await connectClient(port, tokenB);

            let likeMatchedA = null;
            let likeMatchedB = null;
            clientA.on("like:matched", (d) => { likeMatchedA = d; });
            clientB.on("like:matched", (d) => { likeMatchedB = d; });

            // User A likes User B
            await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), action: "like" });

            // User B likes User A back
            const matchRes = await request(app)
                .post("/api/v1/discovery/swipe")
                .set("Authorization", `Bearer ${tokenB}`)
                .send({ targetUserId: mockUserA._id.toString(), action: "like" });

            assert.equal(matchRes.status, 201);
            assert.equal(matchRes.body.isMatch, true);

            await new Promise((r) => setTimeout(r, 150));

            assert.ok(likeMatchedA, "Expected like:matched event for User A");
            assert.ok(likeMatchedB, "Expected like:matched event for User B");
            assert.equal(likeMatchedB.matchedUserId, mockUserA._id.toString());

            // User B's Likes You list should now be empty (mutual match excluded)
            const likesRes = await request(app)
                .get("/api/v1/matches/likes-you")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(likesRes.body.profiles.length, 0);

            clientA.disconnect();
            clientB.disconnect();
        });
    });

    describe("2. Match Requests Synchronization & State Transitions", () => {
        it("User A sends Match Request to User B: emits match_request:new and increments unread count", async () => {
            const { client: clientB } = await connectClient(port, tokenB);

            let newRequestEvent = null;
            let countsEvent = null;
            clientB.on("match_request:new", (d) => { newRequestEvent = d; });
            clientB.on("notification:counts", (d) => { countsEvent = d; });

            const reqRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), message: "Hey Liam, let's connect!" });

            assert.equal(reqRes.status, 201);
            assert.equal(reqRes.body.request.status, "pending");

            await new Promise((r) => setTimeout(r, 150));

            assert.ok(newRequestEvent, "Expected match_request:new event");
            assert.equal(newRequestEvent.request.sender.name, "Sophia Martinez");
            assert.ok(countsEvent, "Expected notification:counts event");
            assert.equal(countsEvent.unreadRequestsCount, 1);

            // User B queries incoming requests
            const incomingRes = await request(app)
                .get("/api/v1/matches/requests/incoming")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(incomingRes.status, 200);
            assert.equal(incomingRes.body.requests.length, 1);
            assert.equal(incomingRes.body.requests[0].sender.name, "Sophia Martinez");

            clientB.disconnect();
        });

        it("Viewing Requests clears unread badge but preserves pending requests in list", async () => {
            await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), message: "Hello!" });

            // User B marks match_request notifications as read
            const readRes = await request(app)
                .patch("/api/v1/notifications/read-type/match_request")
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(readRes.status, 200);
            assert.equal(readRes.body.unreadRequestsCount, 0);

            // Incoming requests still list the pending request
            const incomingRes = await request(app)
                .get("/api/v1/matches/requests/incoming")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(incomingRes.body.requests.length, 1);
        });

        it("Accepting request establishes connection and removes pending card", async () => {
            const { client: clientB } = await connectClient(port, tokenB);

            let acceptedEvent = null;
            clientB.on("match_request:accepted", (d) => { acceptedEvent = d; });

            const sendRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), message: "Connect?" });

            const requestId = sendRes.body.request._id;

            // User B accepts
            const acceptRes = await request(app)
                .post(`/api/v1/matches/requests/${requestId}/accept`)
                .set("Authorization", `Bearer ${tokenB}`);

            assert.equal(acceptRes.status, 200);
            assert.equal(acceptRes.body.isConnected, true);

            await new Promise((r) => setTimeout(r, 150));

            assert.ok(acceptedEvent, "Expected match_request:accepted event");

            // Incoming requests list is now empty
            const incomingRes = await request(app)
                .get("/api/v1/matches/requests/incoming")
                .set("Authorization", `Bearer ${tokenB}`);
            assert.equal(incomingRes.body.requests.length, 0);

            clientB.disconnect();
        });

        it("Third party User C cannot accept User B's incoming request (403 Forbidden)", async () => {
            const sendRes = await request(app)
                .post("/api/v1/matches/requests")
                .set("Authorization", `Bearer ${tokenA}`)
                .send({ targetUserId: mockUserB._id.toString(), message: "Connect?" });

            const requestId = sendRes.body.request._id;

            const cRes = await request(app)
                .post(`/api/v1/matches/requests/${requestId}/accept`)
                .set("Authorization", `Bearer ${tokenC}`);

            assert.equal(cRes.status, 403);
            assert.equal(cRes.body.code, "UNAUTHORIZED_RECIPIENT");
        });
    });
});

