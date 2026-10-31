import httpStatus from "http-status";
import mongoose from "mongoose";
import Call from "../models/call.model.js";
import { Notification } from "../models/notification.model.js";

const isCallDbReady = () => Boolean(mongoose.connection?.readyState === 1 || (Call.findOne && Call.findOne !== mongoose.Model.findOne));

/**
 * Persists initial call record when a direct 1-on-1 call is initiated.
 *
 * @param {object} params
 * @param {string} params.callId
 * @param {string|mongoose.Types.ObjectId} params.callerId
 * @param {string|mongoose.Types.ObjectId} params.calleeId
 * @param {string|mongoose.Types.ObjectId} [params.conversationId]
 * @param {string} [params.callType="video"]
 * @param {boolean} [params.receiverAlerted=false]
 * @returns {Promise<Call>}
 */
export const recordCallInitiated = async ({
    callId,
    callerId,
    calleeId,
    conversationId = null,
    callType = "video",
    receiverAlerted = false,
}) => {
    if (!isCallDbReady()) {
        return null;
    }
    try {
        const callerObjId = new mongoose.Types.ObjectId(callerId);
        const calleeObjId = new mongoose.Types.ObjectId(calleeId);

        const call = await Call.findOneAndUpdate(
            { callId },
            {
                $setOnInsert: {
                    callId,
                    caller: callerObjId,
                    receiver: calleeObjId,
                    participants: [callerObjId, calleeObjId],
                    conversationId: conversationId && mongoose.isValidObjectId(conversationId)
                        ? new mongoose.Types.ObjectId(conversationId)
                        : null,
                    callType: callType === "audio" ? "audio" : "video",
                    status: "ringing",
                    receiverAlerted: Boolean(receiverAlerted),
                    initiatedAt: new Date(),
                    seenBy: [callerObjId],
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return call;
    } catch (err) {
        console.error("Error recording call initiated:", err);
        return null;
    }
};

/**
 * Updates call status to connected when callee accepts.
 *
 * @param {object} params
 * @param {string} params.callId
 * @returns {Promise<Call|null>}
 */
export const recordCallAccepted = async ({ callId }) => {
    if (!isCallDbReady()) {
        return null;
    }
    try {
        const call = await Call.findOne({ callId });
        if (!call) return null;

        // Only transition from ringing to connected
        if (call.status === "ringing") {
            call.status = "connected";
            call.answeredAt = new Date();
            // Both caller and callee now know about the call
            if (!call.seenBy.includes(call.receiver)) {
                call.seenBy.push(call.receiver);
            }
            await call.save();
        }

        return call;
    } catch (err) {
        console.error("Error recording call accepted:", err);
        return null;
    }
};

/**
 * Idempotently finalizes a call outcome and records duration, timestamps, and missed notifications.
 *
 * @param {object} params
 * @param {string} params.callId
 * @param {string} [params.endReason="ended"] - "declined", "timeout", "cancelled", "ended_by_partner", "partner_disconnected"
 * @param {string|mongoose.Types.ObjectId} [params.endedByUserId]
 * @param {object} [io] - Optional Socket.IO server instance for real-time alerts
 * @returns {Promise<Call|null>}
 */
export const recordCallEnded = async ({ callId, endReason = "ended", endedByUserId = null, io = null }) => {
    if (!isCallDbReady()) {
        return null;
    }
    try {
        const call = await Call.findOne({ callId });
        if (!call) return null;

        const terminalStatuses = ["completed", "missed", "rejected", "cancelled", "no_answer"];
        if (terminalStatuses.includes(call.status)) {
            // Already finalized; return existing record to prevent overwriting
            return call;
        }

        const now = new Date();
        call.endedAt = now;
        call.endReason = endReason;

        if (call.status === "connected") {
            // Successfully connected call that is now ending
            call.status = "completed";
            const start = call.answeredAt ? new Date(call.answeredAt).getTime() : new Date(call.initiatedAt).getTime();
            call.duration = Math.max(0, Math.round((now.getTime() - start) / 1000));
            // Ensure callee has seen a connected call
            if (!call.seenBy.includes(call.receiver)) {
                call.seenBy.push(call.receiver);
            }
        } else if (call.status === "ringing") {
            call.duration = 0;

            if (endReason === "declined" || endReason === "declined_by_partner") {
                // Callee actively rejected the call
                call.status = "rejected";
                // Callee actively interacted, so they've seen it
                if (!call.seenBy.includes(call.receiver)) {
                    call.seenBy.push(call.receiver);
                }
            } else if (endReason === "timeout") {
                // Ringing timed out without answer
                if (call.receiverAlerted) {
                    call.status = "missed";
                } else {
                    call.status = "no_answer";
                }
            } else if (endReason === "cancelled" || endReason === "ended_by_partner") {
                // Caller hung up before callee answered
                if (call.receiverAlerted) {
                    // Receiver's phone was ringing, but caller hung up before answer -> Missed call for receiver
                    call.status = "missed";
                } else {
                    // Receiver was never alerted (offline/unreachable) -> Cancelled
                    call.status = "cancelled";
                }
            } else if (endReason === "partner_disconnected") {
                // Socket disconnected while ringing
                if (endedByUserId && endedByUserId.toString() === call.caller.toString()) {
                    // Caller disconnected
                    call.status = call.receiverAlerted ? "missed" : "cancelled";
                } else {
                    // Callee disconnected
                    call.status = "rejected";
                }
            } else {
                call.status = call.receiverAlerted ? "missed" : "no_answer";
            }
        }

        await call.save();

        // If the call was marked as missed, generate in-app Notification & Socket Alert
        if (call.status === "missed") {
            try {
                // Prevent duplicate missed call notifications
                const existingNotif = await Notification.findOne({
                    recipient: call.receiver,
                    "data.callId": call.callId,
                    type: "missed_call",
                });

                if (!existingNotif) {
                    await Notification.create({
                        recipient: call.receiver,
                        sender: call.caller,
                        type: "missed_call",
                        data: {
                            callId: call.callId,
                            conversationId: call.conversationId,
                        },
                        read: false,
                    });
                }
            } catch (notifErr) {
                console.warn("Failed to create missed call notification record:", notifErr?.message);
            }

            // Real-time Socket.IO emission to receiver
            if (io) {
                try {
                    const unseenCount = await getUnseenMissedCallsCount(call.receiver);
                    io.to(`user:${call.receiver.toString()}`).emit("call:missed-count", {
                        count: unseenCount,
                    });
                    io.to(`user:${call.receiver.toString()}`).emit("call:missed", {
                        callId: call.callId,
                        callerId: call.caller.toString(),
                        callType: call.callType,
                        createdAt: call.createdAt,
                    });
                } catch (socketErr) {
                    console.warn("Failed to emit socket missed call alert:", socketErr?.message);
                }
            }
        }

        return call;
    } catch (err) {
        console.error("Error recording call ended:", err);
        return null;
    }
};

/**
 * Counts unseen missed calls for a recipient.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<number>}
 */
export const getUnseenMissedCallsCount = async (userId) => {
    if (!userId || !isCallDbReady()) return 0;
    try {
        const userObjId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
        const allUserIds = [userObjId, userId.toString()];
        return await Call.countDocuments({
            receiver: userObjId,
            status: "missed",
            seenBy: { $ne: userObjId },
        });
    } catch (err) {
        console.error("Error calculating unseen missed calls:", err);
        return 0;
    }
};

/**
 * Controller: GET /api/v1/calls/history
 * Fetches paginated, filtered call history for the authenticated user.
 */
export const getCallHistory = async (req, res) => {
    if (!isCallDbReady()) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Database service unavailable",
        });
    }
    try {
        const userId = req.user._id;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        const { type, status } = req.query;

        // Base query: only calls where the authenticated user is a participant
        const query = { participants: userId };

        // Filter by callType (video vs audio)
        if (type && type !== "all") {
            if (type === "video" || type === "audio") {
                query.callType = type;
            }
        }

        // Filter by status
        if (status && status !== "all") {
            if (status === "missed") {
                // Only receiver sees missed calls
                query.receiver = userId;
                query.status = "missed";
            } else if (status === "completed") {
                query.status = "completed";
            } else if (status === "rejected") {
                query.status = "rejected";
            } else if (status === "cancelled") {
                query.status = { $in: ["cancelled", "no_answer"] };
            }
        }

        const [calls, totalCalls, unseenMissedCount] = await Promise.all([
            Call.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate("caller", "name username photos gender dob lastSeenAt")
                .populate("receiver", "name username photos gender dob lastSeenAt")
                .lean(),
            Call.countDocuments(query),
            getUnseenMissedCallsCount(userId),
        ]);

        const formattedCalls = calls.map((call) => {
            const isCaller = call.caller && call.caller._id.toString() === userId.toString();
            const partner = isCaller ? call.receiver : call.caller;
            const isMissed = !isCaller && call.status === "missed";
            const isSeen = Array.isArray(call.seenBy) && call.seenBy.some((id) => id.toString() === userId.toString());

            let displayStatus = call.status;
            if (call.status === "missed") {
                displayStatus = isCaller ? "no_answer" : "missed";
            }

            return {
                _id: call._id,
                callId: call.callId,
                callType: call.callType,
                direction: isCaller ? "outgoing" : "incoming",
                partner: partner
                    ? {
                          _id: partner._id,
                          name: partner.name || "User",
                          username: partner.username || "",
                          photos: partner.photos || [],
                          gender: partner.gender || "",
                          lastSeenAt: partner.lastSeenAt || null,
                      }
                    : null,
                status: displayStatus,
                duration: call.duration || 0,
                initiatedAt: call.initiatedAt,
                answeredAt: call.answeredAt,
                endedAt: call.endedAt,
                createdAt: call.createdAt,
                isMissed,
                isSeen,
            };
        });

        return res.status(httpStatus.OK).json({
            success: true,
            calls: formattedCalls,
            page,
            totalPages: Math.ceil(totalCalls / limit) || 1,
            totalCalls,
            unseenMissedCount,
        });
    } catch (err) {
        console.error("GET /api/v1/calls/history error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve call history",
        });
    }
};

/**
 * Controller: GET /api/v1/calls/missed-count
 * Returns authoritative count of unseen missed calls.
 */
export const getMissedCallCount = async (req, res) => {
    if (!isCallDbReady()) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Database service unavailable",
        });
    }
    try {
        const count = await getUnseenMissedCallsCount(req.user._id);
        return res.status(httpStatus.OK).json({
            success: true,
            count,
        });
    } catch (err) {
        console.error("GET /api/v1/calls/missed-count error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to calculate missed calls",
        });
    }
};

/**
 * Controller: POST /api/v1/calls/mark-seen
 * Marks all unseen missed calls as seen without deleting call history.
 */
export const markMissedCallsAsSeen = async (req, res) => {
    if (!isCallDbReady()) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Database service unavailable",
        });
    }
    try {
        const userId = req.user._id;

        const userObjId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
        const allUserIds = [userObjId, userId.toString()];
        const result = await Call.updateMany(
            {
                receiver: userObjId,
            status: "missed",
            seenBy: { $ne: userObjId },
            },
            {
                $addToSet: { seenBy: userObjId },
            }
        );

        // Also mark corresponding missed_call notifications as read
        await Notification.updateMany(
            {
                recipient: userId,
                type: "missed_call",
                read: false,
            },
            {
                $set: { read: true },
            }
        );

        // Emit updated count (0) via Socket.IO if available
        if (req.app.get("io")) {
            req.app.get("io").to(`user:${userId.toString()}`).emit("call:missed-count", {
                count: 0,
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Missed calls marked as seen",
            markedCount: result.modifiedCount,
        });
    } catch (err) {
        console.error("POST /api/v1/calls/mark-seen error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to mark missed calls as seen",
        });
    }
};
