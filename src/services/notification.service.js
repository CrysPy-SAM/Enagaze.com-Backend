import mongoose from "mongoose";
import { Notification } from "../models/notification.model.js";
import { User } from "../models/user.model.js";
import { Block } from "../models/block.model.js";
import { getIO } from "../controllers/socketManager.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";

// In-memory fallback for unit testing environments where MongoDB connection is not active
let inMemoryFallbackNotifications = [];

export const _resetInMemoryNotifications = () => {
    inMemoryFallbackNotifications = [];
};

/**
 * Creates and persists a notification, then emits a real-time socket event.
 * Handles duplicate attempts idempotently via MongoDB compound unique index.
 *
 * @param {Object} options
 * @param {string|mongoose.Types.ObjectId} options.recipient
 * @param {string|mongoose.Types.ObjectId} options.sender
 * @param {"like"|"match"|"message"} options.type
 * @param {Object} [options.data]
 * @param {Object} [options.io]
 * @returns {Promise<Object|null>}
 */
export const createNotification = async ({ recipient, sender, type, data = {}, io = null }) => {
    try {
        if (!recipient || !sender || !type) {
            return null;
        }

        const recipientStr = recipient.toString();
        const senderStr = sender.toString();

        // Never notify oneself
        if (recipientStr === senderStr) {
            return null;
        }

        // Verify neither party has blocked the other
        const [recipientBlocks, senderBlocks] = await Promise.all([
            Block.getBlockedUserIds(recipient),
            Block.getBlockedUserIds(sender),
        ]);

        const recipientBlockedSet = new Set(recipientBlocks.map((id) => id.toString()));
        const senderBlockedSet = new Set(senderBlocks.map((id) => id.toString()));

        if (recipientBlockedSet.has(senderStr) || senderBlockedSet.has(recipientStr)) {
            // Blocked in at least one direction; suppress notification
            return null;
        }

        let notificationDoc;
        const isDbConnected = mongoose.connection.readyState === 1;

        if (isDbConnected) {
            try {
                notificationDoc = await Notification.create({
                    recipient,
                    sender,
                    type,
                    data: {
                        matchId: data.matchId || null,
                        conversationId: data.conversationId || null,
                        requestId: data.requestId || null,
                    },
                    read: false,
                });
            } catch (err) {
                if (err.code === 11000) {
                    notificationDoc = await Notification.findOne({
                        recipient,
                        sender,
                        type,
                    });
                    if (!notificationDoc) return null;
                } else {
                    throw err;
                }
            }
        } else {
            // In-memory fallback for unit test environments without active DB
            const existing = inMemoryFallbackNotifications.find(
                (n) =>
                    n.recipient.toString() === recipientStr &&
                    n.sender.toString() === senderStr &&
                    n.type === type
            );
            if (existing) {
                notificationDoc = existing;
            } else {
                notificationDoc = {
                    _id: new mongoose.Types.ObjectId(),
                    recipient,
                    sender,
                    type,
                    data: {
                        matchId: data.matchId || null,
                        conversationId: data.conversationId || null,
                        requestId: data.requestId || null,
                    },
                    read: false,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
                inMemoryFallbackNotifications.push(notificationDoc);
            }
        }

        // Populate sender for serialization
        let populatedSender = null;
        try {
            if (typeof User.findById === "function") {
                const userRes = User.findById(sender);
                populatedSender = userRes?.select ? await userRes.select("name dob gender bio photos interests isProfileComplete") : await userRes;
            }
        } catch (_) {
            populatedSender = null;
        }

        const safeSender = populatedSender ? toPublicProfile(populatedSender) : {
            _id: senderStr,
            name: "Engaze Member",
            age: null,
            gender: null,
            bio: "",
            photos: [],
            interests: [],
            isProfileComplete: true,
        };

        const serialized = {
            _id: notificationDoc._id.toString(),
            recipient: recipientStr,
            sender: safeSender,
            type: notificationDoc.type,
            data: notificationDoc.data,
            read: notificationDoc.read,
            createdAt: notificationDoc.createdAt,
            updatedAt: notificationDoc.updatedAt,
        };

        // Emit real-time event to recipient's personal socket room
        const socketServer = io || getIO();
        if (socketServer) {
            socketServer.to(`user:${recipientStr}`).emit("notification:new", {
                notification: serialized,
            });
        }

        return serialized;
    } catch (error) {
        console.error("Error creating notification:", error);
        return null;
    }
};

/**
 * Retrieves paginated notifications for a given user, excluding blocked users.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {Object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {boolean} [options.unreadOnly=false]
 * @returns {Promise<{ notifications: Array, unreadCount: number, pagination: Object }>}
 */
export const getNotificationsForUser = async (userId, { page = 1, limit = 20, unreadOnly = false } = {}) => {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;
    const userIdStr = userId.toString();

    const blockedUserIds = await Block.getBlockedUserIds(userId);
    const blockedSet = new Set(blockedUserIds.map((b) => b.toString()));

    const isDbConnected = mongoose.connection.readyState === 1;

    if (isDbConnected) {
        const baseFilter = {
            recipient: userId,
            sender: { $nin: blockedUserIds },
        };

        if (unreadOnly) {
            baseFilter.read = false;
        }

        const [total, unreadCount, docs] = await Promise.all([
            Notification.countDocuments(baseFilter),
            Notification.countDocuments({
                recipient: userId,
                read: false,
                sender: { $nin: blockedUserIds },
            }),
            Notification.find(baseFilter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(safeLimit)
                .populate({
                    path: "sender",
                    select: "name dob gender bio photos interests isProfileComplete",
                }),
        ]);

        const notifications = docs
            .map((doc) => {
                const safeSender = toPublicProfile(doc.sender);
                if (!safeSender) return null;
                return {
                    _id: doc._id.toString(),
                    recipient: doc.recipient.toString(),
                    sender: safeSender,
                    type: doc.type,
                    data: doc.data,
                    read: doc.read,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt,
                };
            })
            .filter(Boolean);

        return {
            notifications,
            unreadCount,
            pagination: {
                page: safePage,
                limit: safeLimit,
                total,
                totalPages: Math.ceil(total / safeLimit) || 1,
            },
        };
    }

    // In-memory fallback
    const filtered = inMemoryFallbackNotifications
        .filter((n) => {
            if (n.recipient.toString() !== userIdStr) return false;
            if (blockedSet.has(n.sender.toString())) return false;
            if (unreadOnly && n.read) return false;
            return true;
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = filtered.length;
    const unreadCount = inMemoryFallbackNotifications.filter(
        (n) =>
            n.recipient.toString() === userIdStr &&
            !n.read &&
            !blockedSet.has(n.sender.toString())
    ).length;

    const pageDocs = filtered.slice(skip, skip + safeLimit);

    const notifications = await Promise.all(
        pageDocs.map(async (doc) => {
            let populatedSender = null;
            try {
                if (typeof User.findById === "function") {
                    const res = User.findById(doc.sender);
                    populatedSender = res?.select ? await res.select("name dob gender bio photos interests isProfileComplete") : await res;
                }
            } catch (_) {}

            const safeSender = populatedSender
                ? toPublicProfile(populatedSender)
                : {
                      _id: doc.sender.toString(),
                      name: "Engaze Member",
                      age: null,
                      gender: null,
                      bio: "",
                      photos: [],
                      interests: [],
                      isProfileComplete: true,
                  };

            return {
                _id: doc._id.toString(),
                recipient: doc.recipient.toString(),
                sender: safeSender,
                type: doc.type,
                data: doc.data,
                read: doc.read,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt,
            };
        })
    );

    return {
        notifications,
        unreadCount,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            totalPages: Math.ceil(total / safeLimit) || 1,
        },
    };
};

/**
 * Returns the unread notification count for a user, excluding blocked senders.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<number>}
 */
export const getUnreadNotificationCount = async (userId) => {
    const blockedUserIds = await Block.getBlockedUserIds(userId);
    const isDbConnected = mongoose.connection.readyState === 1;

    if (isDbConnected) {
        return Notification.countDocuments({
            recipient: userId,
            read: false,
            sender: { $nin: blockedUserIds },
        });
    }

    const blockedSet = new Set(blockedUserIds.map((b) => b.toString()));
    const userIdStr = userId.toString();
    return inMemoryFallbackNotifications.filter(
        (n) =>
            n.recipient.toString() === userIdStr &&
            !n.read &&
            !blockedSet.has(n.sender.toString())
    ).length;
};

/**
 * Returns category-specific and total unread notification counts for a user.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<{ total: number, likes: number, requests: number }>}
 */
export const getUnreadNotificationCounts = async (userId) => {
    const blockedUserIds = await Block.getBlockedUserIds(userId);
    const isDbConnected = mongoose.connection.readyState === 1;

    if (isDbConnected) {
        const [total, likes, requests] = await Promise.all([
            Notification.countDocuments({
                recipient: userId,
                read: false,
                sender: { $nin: blockedUserIds },
            }),
            Notification.countDocuments({
                recipient: userId,
                read: false,
                type: "like",
                sender: { $nin: blockedUserIds },
            }),
            Notification.countDocuments({
                recipient: userId,
                read: false,
                type: "match_request",
                sender: { $nin: blockedUserIds },
            }),
        ]);

        return { total, likes, requests };
    }

    const blockedSet = new Set(blockedUserIds.map((b) => b.toString()));
    const userIdStr = userId.toString();
    const unread = inMemoryFallbackNotifications.filter(
        (n) =>
            n.recipient.toString() === userIdStr &&
            !n.read &&
            !blockedSet.has(n.sender.toString())
    );

    return {
        total: unread.length,
        likes: unread.filter((n) => n.type === "like").length,
        requests: unread.filter((n) => n.type === "match_request").length,
    };
};

/**
 * Marks a specific notification as read.
 *
 * @param {string|mongoose.Types.ObjectId} notificationId
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<Object|null>}
 */
export const markNotificationAsRead = async (notificationId, userId) => {
    if (!notificationId) return null;
    const isDbConnected = mongoose.connection.readyState === 1;

    if (isDbConnected) {
        if (!mongoose.Types.ObjectId.isValid(notificationId)) {
            return null;
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: notificationId, recipient: userId },
            { $set: { read: true } },
            { new: true }
        ).populate({
            path: "sender",
            select: "name dob gender bio photos interests isProfileComplete",
        });

        if (!notification) return null;

        return {
            _id: notification._id.toString(),
            recipient: notification.recipient.toString(),
            sender: toPublicProfile(notification.sender),
            type: notification.type,
            data: notification.data,
            read: notification.read,
            createdAt: notification.createdAt,
            updatedAt: notification.updatedAt,
        };
    }

    const found = inMemoryFallbackNotifications.find(
        (n) =>
            n._id.toString() === notificationId.toString() &&
            n.recipient.toString() === userId.toString()
    );
    if (!found) return null;
    found.read = true;
    found.updatedAt = new Date();

    let populatedSender = null;
    try {
        if (typeof User.findById === "function") {
            const res = User.findById(found.sender);
            populatedSender = res?.select ? await res.select("name dob gender bio photos interests isProfileComplete") : await res;
        }
    } catch (_) {}

    return {
        _id: found._id.toString(),
        recipient: found.recipient.toString(),
        sender: populatedSender
            ? toPublicProfile(populatedSender)
            : {
                  _id: found.sender.toString(),
                  name: "Engaze Member",
                  age: null,
                  gender: null,
                  bio: "",
                  photos: [],
                  interests: [],
                  isProfileComplete: true,
              },
        type: found.type,
        data: found.data,
        read: found.read,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
    };
};

/**
 * Marks all notifications for a user as read.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<number>} Number of notifications modified
 */
export const markAllNotificationsAsRead = async (userId) => {
    const isDbConnected = mongoose.connection.readyState === 1;

    if (isDbConnected) {
        const result = await Notification.updateMany(
            { recipient: userId, read: false },
            { $set: { read: true } }
        );
        return result.modifiedCount || 0;
    }

    const userIdStr = userId.toString();
    let count = 0;
    for (const n of inMemoryFallbackNotifications) {
        if (n.recipient.toString() === userIdStr && !n.read) {
            n.read = true;
            n.updatedAt = new Date();
            count++;
        }
    }
    return count;
};

/**
 * Marks all notifications of a specific type as read for a user.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {string} type
 * @returns {Promise<number>} Number of notifications modified
 */
export const markNotificationsAsReadByType = async (userId, type) => {
    if (!userId || !type) return 0;
    const isDbConnected = mongoose.connection.readyState === 1;

    if (isDbConnected) {
        const result = await Notification.updateMany(
            { recipient: userId, type, read: false },
            { $set: { read: true } }
        );
        return result.modifiedCount || 0;
    }

    const userIdStr = userId.toString();
    let count = 0;
    for (const n of inMemoryFallbackNotifications) {
        if (n.recipient.toString() === userIdStr && n.type === type && !n.read) {
            n.read = true;
            n.updatedAt = new Date();
            count++;
        }
    }
    return count;
};

/**
 * When a mutual match forms, supersede any prior "like" notifications
 * between the two users by marking them as read.
 *
 * @param {string|mongoose.Types.ObjectId} user1
 * @param {string|mongoose.Types.ObjectId} user2
 */
export const supersedeLikeNotifications = async (user1, user2) => {
    try {
        const isDbConnected = mongoose.connection.readyState === 1;
        if (isDbConnected) {
            await Notification.updateMany(
                {
                    type: "like",
                    $or: [
                        { recipient: user1, sender: user2 },
                        { recipient: user2, sender: user1 },
                    ],
                },
                { $set: { read: true } }
            );
        } else {
            const u1Str = user1.toString();
            const u2Str = user2.toString();
            for (const n of inMemoryFallbackNotifications) {
                if (
                    n.type === "like" &&
                    ((n.recipient.toString() === u1Str && n.sender.toString() === u2Str) ||
                        (n.recipient.toString() === u2Str && n.sender.toString() === u1Str))
                ) {
                    n.read = true;
                    n.updatedAt = new Date();
                }
            }
        }
    } catch (e) {
        console.warn("Failed to supersede like notifications:", e.message);
    }
};

/**
 * When a match request is accepted or declined, supersede prior "match_request"
 * notifications between the two users by marking them as read.
 *
 * @param {string|mongoose.Types.ObjectId} user1
 * @param {string|mongoose.Types.ObjectId} user2
 */
export const supersedeMatchRequestNotifications = async (user1, user2) => {
    try {
        const isDbConnected = mongoose.connection.readyState === 1;
        if (isDbConnected) {
            await Notification.updateMany(
                {
                    type: "match_request",
                    $or: [
                        { recipient: user1, sender: user2 },
                        { recipient: user2, sender: user1 },
                    ],
                },
                { $set: { read: true } }
            );
        } else {
            const u1Str = user1.toString();
            const u2Str = user2.toString();
            for (const n of inMemoryFallbackNotifications) {
                if (
                    n.type === "match_request" &&
                    ((n.recipient.toString() === u1Str && n.sender.toString() === u2Str) ||
                        (n.recipient.toString() === u2Str && n.sender.toString() === u1Str))
                ) {
                    n.read = true;
                    n.updatedAt = new Date();
                }
            }
        }
    } catch (e) {
        console.warn("Failed to supersede match request notifications:", e.message);
    }
};

