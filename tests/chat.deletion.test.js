import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { User } from "../src/models/user.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";
import { Block } from "../src/models/block.model.js";

import {
    getConversations,
    getMessages,
    markConversationAsRead,
    calculateUserUnreadCount,
    deleteMessageForMe,
    deleteMessageForEveryone,
    clearChat,
    deleteChat,
} from "../src/controllers/chat.controller.js";

function createMockRes() {
    return {
        statusCode: 200,
        data: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.data = body;
            return this;
        },
    };
}

describe("WhatsApp-Inspired Chat & Message Deletion Test Suite", () => {
    let originalUserFindById;
    let originalUserFindOne;
    let originalIsBlocked;
    let originalGetBlocked;

    let originalConvFind;
    let originalConvFindById;
    let originalConvInsertMany;

    let originalMatchFind;
    let originalMatchFindById;

    let originalMsgFind;
    let originalMsgFindOne;
    let originalMsgFindById;
    let originalMsgUpdateMany;
    let originalMsgUpdateOne;
    let originalMsgCountDocuments;
    let originalMsgAggregate;

    const mockUserA = {
        _id: new mongoose.Types.ObjectId("65ca11111111111111111111"),
        name: "Alice Active",
        username: "alice_active",
        photos: ["https://example.com/alice.jpg"],
        isProfileComplete: true,
    };

    const mockUserB = {
        _id: new mongoose.Types.ObjectId("65ca22222222222222222222"),
        name: "Bob Partner",
        username: "bob_partner",
        photos: ["https://example.com/bob.jpg"],
        isProfileComplete: true,
    };

    const mockMatch = {
        _id: new mongoose.Types.ObjectId("65ca33333333333333333333"),
        users: [mockUserA._id, mockUserB._id],
        status: "active",
        createdAt: new Date("2026-01-01"),
    };

    let inMemoryConversations = [];
    let inMemoryMessages = [];
    let originalReadyStateDescriptor;

    before(async () => {
        originalReadyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

        originalUserFindById = User.findById;
        originalUserFindOne = User.findOne;
        originalIsBlocked = Block.isBlockedBidirectional;
        originalGetBlocked = Block.getBlockedUserIds;

        originalConvFind = Conversation.find;
        originalConvFindById = Conversation.findById;
        originalConvInsertMany = Conversation.insertMany;
        Conversation.insertMany = async () => [];

        originalMatchFind = Match.find;
        originalMatchFindById = Match.findById;

        Match.find = () => {
            const chain = {
                select: () => chain,
                lean: () => Promise.resolve([mockMatch]),
                then: (resolve) => resolve([mockMatch]),
            };
            return chain;
        };
        Match.findById = () => {
            const chain = {
                select: () => chain,
                then: (resolve) => resolve(mockMatch),
            };
            return chain;
        };

        originalMsgFind = Message.find;
        originalMsgFindOne = Message.findOne;
        originalMsgFindById = Message.findById;
        originalMsgUpdateMany = Message.updateMany;
        originalMsgUpdateOne = Message.updateOne;
        originalMsgCountDocuments = Message.countDocuments;
        originalMsgAggregate = Message.aggregate;

        Block.getBlockedUserIds = async () => [];
        Block.isBlockedBidirectional = async () => false;

        // Mock Conversation
        Conversation.find = (query) => {
            const userTarget = query.participants ? (query.participants._id || query.participants).toString() : null;
            const hiddenTarget = query.hiddenFor?.$ne ? (query.hiddenFor.$ne._id || query.hiddenFor.$ne).toString() : null;

            const filtered = inMemoryConversations.filter((c) => {
                if (userTarget && !c.participants.some((p) => (p?._id || p).toString() === userTarget)) {
                    return false;
                }
                if (hiddenTarget) {
                    const isHidden = c.hiddenFor && c.hiddenFor.some((id) => (id?._id || id).toString() === hiddenTarget);
                    if (isHidden) return false;
                }
                return true;
            });

            // Deep clone and populate participant profiles
            const populated = filtered.map((c) => ({
                ...c,
                participants: c.participants.map((p) => {
                    const pid = (p?._id || p).toString();
                    if (pid === mockUserA._id.toString()) return { ...mockUserA };
                    if (pid === mockUserB._id.toString()) return { ...mockUserB };
                    return p;
                }),
                match: c.match || mockMatch,
            }));

            const chain = {
                sort: () => chain,
                populate: () => chain,
                select: () => chain,
                lean: () => Promise.resolve(populated),
                then: (resolve) => resolve(populated),
            };
            return chain;
        };

        Conversation.findById = async (id) => {
            const found = inMemoryConversations.find((c) => c._id.toString() === id.toString());
            if (!found) return null;
            return {
                ...found,
                save: async function () {
                    const idx = inMemoryConversations.findIndex((c) => c._id.toString() === this._id.toString());
                    if (idx !== -1) inMemoryConversations[idx] = this;
                    return this;
                },
            };
        };

        // Mock Message
        Message.find = (query) => {
            const convTarget = query.conversation ? (query.conversation._id || query.conversation).toString() : null;
            const delForNe = query.deletedFor?.$ne ? (query.deletedFor.$ne._id || query.deletedFor.$ne).toString() : null;

            const filtered = inMemoryMessages.filter((m) => {
                if (convTarget && m.conversation.toString() !== convTarget) {
                    return false;
                }
                if (delForNe && m.deletedFor) {
                    const isDel = m.deletedFor.some((id) => (id?._id || id).toString() === delForNe);
                    if (isDel) return false;
                }
                if (query.createdAt && query.createdAt.$gt) {
                    if (new Date(m.createdAt) <= new Date(query.createdAt.$gt)) return false;
                }
                return true;
            });

            const chain = {
                sort: () => chain,
                skip: () => chain,
                limit: () => chain,
                populate: () => chain,
                lean: () => Promise.resolve(filtered),
                then: (resolve) => resolve(filtered),
            };
            return chain;
        };

        Message.findOne = async (query) => {
            const found = inMemoryMessages.find((m) => {
                if (query._id && m._id.toString() !== (query._id._id || query._id).toString()) return false;
                if (query.conversation && m.conversation.toString() !== (query.conversation._id || query.conversation).toString()) return false;
                return true;
            });
            if (!found) return null;
            return {
                ...found,
                save: async function () {
                    const idx = inMemoryMessages.findIndex((m) => m._id.toString() === this._id.toString());
                    if (idx !== -1) inMemoryMessages[idx] = this;
                    return this;
                },
            };
        };

        Message.updateMany = async (filter, update) => {
            let count = 0;
            const convTarget = filter.conversation ? (filter.conversation._id || filter.conversation).toString() : null;
            const senderNe = filter.sender?.$ne ? (filter.sender.$ne._id || filter.sender.$ne).toString() : null;
            const readByNe = filter.readBy?.$ne ? (filter.readBy.$ne._id || filter.readBy.$ne).toString() : null;

            for (const m of inMemoryMessages) {
                if (convTarget && m.conversation.toString() !== convTarget) continue;
                if (senderNe && m.sender.toString() === senderNe) continue;
                if (readByNe && m.readBy.some((id) => (id?._id || id).toString() === readByNe)) continue;

                if (update.$addToSet) {
                    if (update.$addToSet.readBy) {
                        const idToAdd = (update.$addToSet.readBy._id || update.$addToSet.readBy).toString();
                        if (!m.readBy.some((id) => (id?._id || id).toString() === idToAdd)) {
                            m.readBy.push(update.$addToSet.readBy);
                            count++;
                        }
                    }
                    if (update.$addToSet.deletedFor) {
                        const idToAdd = (update.$addToSet.deletedFor._id || update.$addToSet.deletedFor).toString();
                        if (!m.deletedFor) m.deletedFor = [];
                        if (!m.deletedFor.some((id) => (id?._id || id).toString() === idToAdd)) {
                            m.deletedFor.push(update.$addToSet.deletedFor);
                            count++;
                        }
                    }
                }
            }
            return { modifiedCount: count };
        };

        Message.updateOne = async (filter, update) => {
            const m = inMemoryMessages.find((msg) => msg._id.toString() === (filter._id._id || filter._id).toString());
            if (m && update.$addToSet?.deletedFor) {
                if (!m.deletedFor) m.deletedFor = [];
                const idToAdd = (update.$addToSet.deletedFor._id || update.$addToSet.deletedFor).toString();
                if (!m.deletedFor.some((id) => (id?._id || id).toString() === idToAdd)) {
                    m.deletedFor.push(update.$addToSet.deletedFor);
                }
            }
            return { modifiedCount: 1 };
        };

        Message.countDocuments = async (query) => {
            const convTarget = query.conversation ? (query.conversation._id || query.conversation).toString() : null;
            const senderNe = query.sender?.$ne ? (query.sender.$ne._id || query.sender.$ne).toString() : null;
            const readByNe = query.readBy?.$ne ? (query.readBy.$ne._id || query.readBy.$ne).toString() : null;
            const delForNe = query.deletedFor?.$ne ? (query.deletedFor.$ne._id || query.deletedFor.$ne).toString() : null;

            return inMemoryMessages.filter((m) => {
                if (convTarget && m.conversation.toString() !== convTarget) return false;
                if (senderNe && m.sender.toString() === senderNe) return false;
                if (readByNe && m.readBy.some((id) => (id?._id || id).toString() === readByNe)) return false;
                if (delForNe && m.deletedFor && m.deletedFor.some((id) => (id?._id || id).toString() === delForNe)) return false;
                if (query.isDeletedForEveryone && m.isDeletedForEveryone) return false;
                if (query.createdAt && query.createdAt.$gt && new Date(m.createdAt) <= new Date(query.createdAt.$gt)) return false;
                return true;
            }).length;
        };

        Message.aggregate = async (pipeline) => {
            const matchStage = pipeline.find((p) => p.$match)?.$match || {};
            const convIds = matchStage.conversation?.$in || [];
            const convIdStrs = new Set(convIds.map((id) => (id?._id || id).toString()));

            const senderNe = matchStage.sender?.$ne ? (matchStage.sender.$ne._id || matchStage.sender.$ne).toString() : null;
            const readByNe = matchStage.readBy?.$ne ? (matchStage.readBy.$ne._id || matchStage.readBy.$ne).toString() : null;
            const delForNe = matchStage.deletedFor?.$ne ? (matchStage.deletedFor.$ne._id || matchStage.deletedFor.$ne).toString() : null;

            const matched = inMemoryMessages.filter((m) => {
                if (!convIdStrs.has(m.conversation.toString())) return false;
                if (senderNe && m.sender.toString() === senderNe) return false;
                if (readByNe && m.readBy.some((id) => (id?._id || id).toString() === readByNe)) return false;
                if (delForNe && m.deletedFor && m.deletedFor.some((id) => (id?._id || id).toString() === delForNe)) return false;
                if (m.isDeletedForEveryone) return false;
                return true;
            });

            const grouped = {};
            for (const m of matched) {
                const cId = m.conversation.toString();
                grouped[cId] = (grouped[cId] || 0) + 1;
            }

            return Object.entries(grouped).map(([cId, count]) => ({
                _id: new mongoose.Types.ObjectId(cId),
                count,
            }));
        };
    });

    after(async () => {
        User.findById = originalUserFindById;
        User.findOne = originalUserFindOne;
        Block.isBlockedBidirectional = originalIsBlocked;
        Block.getBlockedUserIds = originalGetBlocked;

        Conversation.find = originalConvFind;
        Conversation.findById = originalConvFindById;
        Conversation.insertMany = originalConvInsertMany;

        Match.find = originalMatchFind;
        Match.findById = originalMatchFindById;

        Message.find = originalMsgFind;
        Message.findOne = originalMsgFindOne;
        Message.findById = originalMsgFindById;
        Message.updateMany = originalMsgUpdateMany;
        Message.updateOne = originalMsgUpdateOne;
        Message.countDocuments = originalMsgCountDocuments;
        Message.aggregate = originalMsgAggregate;

        if (originalReadyStateDescriptor) {
            Object.defineProperty(mongoose.connection, "readyState", originalReadyStateDescriptor);
        } else {
            delete mongoose.connection.readyState;
        }
    });

    beforeEach(async () => {
        inMemoryConversations = [
            {
                _id: new mongoose.Types.ObjectId("65ca44444444444444444444"),
                match: mockMatch,
                participants: [mockUserA._id, mockUserB._id],
                hiddenFor: [],
                clearedAt: [],
                lastMessage: null,
                lastMessageAt: new Date("2026-01-01"),
            },
        ];

        inMemoryMessages = [];
    });

    // -------------------------------------------------------------
    // PART 1: FIX STUCK UNREAD BADGE
    // -------------------------------------------------------------
    it("1. Unread count starts at 0 and increments accurately when incoming messages arrive", async () => {
        const conv = inMemoryConversations[0];
        let unreadA = await calculateUserUnreadCount(mockUserA._id);
        assert.equal(unreadA.totalUnreadCount, 0);

        // Bob sends 2 messages to Alice
        const m1 = {
            _id: new mongoose.Types.ObjectId(),
            conversation: conv._id,
            sender: mockUserB._id,
            content: "Hey Alice!",
            readBy: [mockUserB._id],
            deletedFor: [],
            isDeletedForEveryone: false,
            createdAt: new Date(),
        };
        const m2 = {
            _id: new mongoose.Types.ObjectId(),
            conversation: conv._id,
            sender: mockUserB._id,
            content: "Are you free?",
            readBy: [mockUserB._id],
            deletedFor: [],
            isDeletedForEveryone: false,
            createdAt: new Date(),
        };
        inMemoryMessages.push(m1, m2);

        unreadA = await calculateUserUnreadCount(mockUserA._id);
        assert.equal(unreadA.totalUnreadCount, 2);

        // Alice's unread count for Bob should be 0 because Bob sent them
        const unreadB = await calculateUserUnreadCount(mockUserB._id);
        assert.equal(unreadB.totalUnreadCount, 0);
    });

    it("2. Marking conversation as read clears unread badge reliably to exactly 0", async () => {
        const conv = inMemoryConversations[0];
        inMemoryMessages.push({
            _id: new mongoose.Types.ObjectId(),
            conversation: conv._id,
            sender: mockUserB._id,
            content: "Unread message",
            readBy: [mockUserB._id],
            deletedFor: [],
            isDeletedForEveryone: false,
            createdAt: new Date(),
        });

        let unreadA = await calculateUserUnreadCount(mockUserA._id);
        assert.equal(unreadA.totalUnreadCount, 1);

        // Alice marks conversation as read
        const req = { user: mockUserA, params: { conversationId: conv._id.toString() } };
        const res = createMockRes();
        await markConversationAsRead(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.data.success, true);

        // Authoritative unread count must now be 0
        unreadA = await calculateUserUnreadCount(mockUserA._id);
        assert.equal(unreadA.totalUnreadCount, 0);
    });

    // -------------------------------------------------------------
    // PART 2: WHATSAPP-INSPIRED MESSAGE DELETION
    // -------------------------------------------------------------
    it("3. Delete for Me hides message from requester view while partner still sees it", async () => {
        const conv = inMemoryConversations[0];
        const m1 = {
            _id: new mongoose.Types.ObjectId(),
            conversation: conv._id,
            sender: mockUserB._id,
            content: "Secret message",
            readBy: [mockUserB._id, mockUserA._id],
            deletedFor: [],
            isDeletedForEveryone: false,
            createdAt: new Date(),
        };
        inMemoryMessages.push(m1);

        // Alice deletes for me
        const reqA = { user: mockUserA, params: { conversationId: conv._id.toString(), messageId: m1._id.toString() } };
        const resA = createMockRes();
        await deleteMessageForMe(reqA, resA);

        assert.equal(resA.statusCode, 200);
        assert.equal(resA.data.deleteType, "me");

        // Alice views messages: should be empty
        const getReqA = { user: mockUserA, params: { conversationId: conv._id.toString() }, query: {} };
        const getResA = createMockRes();
        await getMessages(getReqA, getResA);
        assert.equal(getResA.data.messages.length, 0);

        // Bob views messages: m1 is still visible
        const getReqB = { user: mockUserB, params: { conversationId: conv._id.toString() }, query: {} };
        const getResB = createMockRes();
        await getMessages(getReqB, getResB);
        assert.equal(getResB.data.messages.length, 1);
        assert.equal(getResB.data.messages[0].content, "Secret message");
    });

    it("4. Delete for Everyone replaces message with 'This message was deleted' and forbids non-sender", async () => {
        const conv = inMemoryConversations[0];
        const m1 = {
            _id: new mongoose.Types.ObjectId(),
            conversation: conv._id,
            sender: mockUserA._id,
            content: "Oops sent by mistake",
            readBy: [mockUserA._id],
            deletedFor: [],
            isDeletedForEveryone: false,
            createdAt: new Date(),
        };
        inMemoryMessages.push(m1);

        // Bob tries to delete Alice's message for everyone -> Must return HTTP 403 Forbidden
        const reqB = { user: mockUserB, params: { conversationId: conv._id.toString(), messageId: m1._id.toString() } };
        const resB = createMockRes();
        await deleteMessageForEveryone(reqB, resB);
        assert.equal(resB.statusCode, 403);

        // Alice deletes her own message for everyone -> Allowed
        const reqA = { user: mockUserA, params: { conversationId: conv._id.toString(), messageId: m1._id.toString() } };
        const resA = createMockRes();
        await deleteMessageForEveryone(reqA, resA);
        assert.equal(resA.statusCode, 200);
        assert.equal(resA.data.deleteType, "everyone");
        assert.equal(resA.data.message.content, "This message was deleted");
        assert.equal(resA.data.message.isDeletedForEveryone, true);

        // Both Alice and Bob now see "This message was deleted"
        const getReqB = { user: mockUserB, params: { conversationId: conv._id.toString() }, query: {} };
        const getResB = createMockRes();
        await getMessages(getReqB, getResB);
        assert.equal(getResB.data.messages[0].content, "This message was deleted");
        assert.equal(getResB.data.messages[0].isDeletedForEveryone, true);
    });

    // -------------------------------------------------------------
    // PART 3: CLEAR CHAT AND DELETE CHAT
    // -------------------------------------------------------------
    it("5. Clear chat removes history for requester without affecting partner or breaking conversation", async () => {
        const conv = inMemoryConversations[0];
        inMemoryMessages.push(
            {
                _id: new mongoose.Types.ObjectId(),
                conversation: conv._id,
                sender: mockUserA._id,
                content: "Hello",
                readBy: [mockUserA._id, mockUserB._id],
                deletedFor: [],
                isDeletedForEveryone: false,
                createdAt: new Date("2026-01-02"),
            },
            {
                _id: new mongoose.Types.ObjectId(),
                conversation: conv._id,
                sender: mockUserB._id,
                content: "World",
                readBy: [mockUserA._id, mockUserB._id],
                deletedFor: [],
                isDeletedForEveryone: false,
                createdAt: new Date("2026-01-03"),
            }
        );

        // Alice clears chat
        const clearReq = { user: mockUserA, params: { conversationId: conv._id.toString() } };
        const clearRes = createMockRes();
        await clearChat(clearReq, clearRes);
        assert.equal(clearRes.statusCode, 200);

        // Alice's message list is now empty
        const getReqA = { user: mockUserA, params: { conversationId: conv._id.toString() }, query: {} };
        const getResA = createMockRes();
        await getMessages(getReqA, getResA);
        assert.equal(getResA.data.messages.length, 0);

        // Bob's message list is intact
        const getReqB = { user: mockUserB, params: { conversationId: conv._id.toString() }, query: {} };
        const getResB = createMockRes();
        await getMessages(getReqB, getResB);
        assert.equal(getResB.data.messages.length, 2);
    });

    it("6. Delete chat hides conversation from requester's list until new message arrives", async () => {
        const conv = inMemoryConversations[0];

        // Alice deletes chat
        const delReq = { user: mockUserA, params: { conversationId: conv._id.toString() } };
        const delRes = createMockRes();
        await deleteChat(delReq, delRes);
        assert.equal(delRes.statusCode, 200);

        // Alice's getConversations should NOT include this conversation
        const getConvsA = { user: mockUserA };
        const resConvsA = createMockRes();
        await getConversations(getConvsA, resConvsA);
        assert.equal(resConvsA.data.conversations.length, 0);

        // Bob's getConversations STILL includes this conversation
        const getConvsB = { user: mockUserB };
        const resConvsB = createMockRes();
        await getConversations(getConvsB, resConvsB);
        assert.equal(resConvsB.data.conversations.length, 1);
    });
    it("7. getMessages preserves exact conversation string ID and compound pagination cursor invariants", async () => {
        const conv = inMemoryConversations[0];
        const pivotId = new mongoose.Types.ObjectId("65cbc0000000000000000001");
        const pivotDate = new Date("2026-02-01T10:00:00Z");

        let capturedFindQuery = null;
        const originalFind = Message.find;
        const originalFindById = Message.findById;

        Message.findById = (id) => ({
            select: () => Promise.resolve({ _id: pivotId, createdAt: pivotDate }),
        });

        Message.find = (q) => {
            capturedFindQuery = q;
            return {
                sort: () => ({
                    limit: () => ({
                        populate: () => Promise.resolve([]),
                    }),
                }),
            };
        };

        const req = {
            user: mockUserA,
            params: { conversationId: conv._id.toString() },
            query: { before: pivotId.toString(), limit: "10" },
        };
        const res = createMockRes();
        await getMessages(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(capturedFindQuery);
        assert.strictEqual(capturedFindQuery.conversation, conv._id.toString());
        assert.ok(capturedFindQuery.$or);
        assert.deepStrictEqual(capturedFindQuery.$or[0], { createdAt: { $lt: pivotDate } });
        assert.deepStrictEqual(capturedFindQuery.$or[1], { createdAt: pivotDate, _id: { $lt: pivotId } });

        Message.find = originalFind;
        Message.findById = originalFindById;
    });
});
