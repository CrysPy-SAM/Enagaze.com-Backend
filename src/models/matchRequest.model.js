import mongoose from "mongoose";

const matchRequestSchema = new mongoose.Schema(
    {
        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        recipient: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        userPair: {
            type: String,
            required: true,
            index: true,
        },
        status: {
            type: String,
            enum: ["pending", "accepted", "declined", "cancelled"],
            default: "pending",
            index: true,
        },
        message: {
            type: String,
            trim: true,
            maxlength: 200,
            default: "",
        },
        respondedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        bufferCommands: false,
    }
);

// Compound unique index: only ONE pending request per sender -> recipient
matchRequestSchema.index(
    { sender: 1, recipient: 1 },
    {
        unique: true,
        partialFilterExpression: { status: "pending" },
    }
);

// Compound index for recipient queries
matchRequestSchema.index({ recipient: 1, status: 1, createdAt: -1 });

// Compound index for sender queries
matchRequestSchema.index({ sender: 1, status: 1, createdAt: -1 });

// Compound index for userPair queries
matchRequestSchema.index({ userPair: 1, status: 1 });

/**
 * Deterministically sort two user IDs to produce a single canonical pair string
 *
 * @param {string|mongoose.Types.ObjectId} user1
 * @param {string|mongoose.Types.ObjectId} user2
 * @returns {string}
 */
matchRequestSchema.statics.getCanonicalPair = function (user1, user2) {
    const id1 = user1.toString();
    const id2 = user2.toString();
    return id1 < id2 ? `${id1}_${id2}` : `${id2}_${id1}`;
};

export const MatchRequest = mongoose.model("MatchRequest", matchRequestSchema);

