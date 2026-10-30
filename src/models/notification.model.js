import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
    {
        recipient: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        type: {
            type: String,
            enum: ["like", "match", "message", "match_request", "match_accepted", "missed_call"],
            required: true,
        },
        data: {
            callId: {
                type: String,
                default: null,
            },
            matchId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Match",
                default: null,
            },
            conversationId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Conversation",
                default: null,
            },
            requestId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "MatchRequest",
                default: null,
            },
        },
        read: {
            type: Boolean,
            default: false,
            index: true,
        },
    },
    {
        timestamps: true,
        bufferCommands: false,
    }
);

// Compound index for feed pagination
notificationSchema.index({ recipient: 1, createdAt: -1 });

// Compound index for unread count
notificationSchema.index({ recipient: 1, read: 1 });
// Compound index for unread count with sender/block filtering
notificationSchema.index({ recipient: 1, read: 1, sender: 1 });

// Partial unique compound index to deduplicate like, match, and request notifications
notificationSchema.index(
    { recipient: 1, sender: 1, type: 1 },
    {
        unique: true,
        partialFilterExpression: { type: { $in: ["like", "match", "match_request", "match_accepted"] } },
    }
);

export const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
