import mongoose, { Schema } from "mongoose";

const blockSchema = new Schema(
    {
        blocker: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Blocker ID is required"],
            index: true,
        },
        blocked: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Blocked user ID is required"],
            index: true,
        },
        reason: {
            type: String,
            trim: true,
            maxlength: [500, "Block reason cannot exceed 500 characters"],
            default: "",
        },
    },
    {
        timestamps: true,
    }
);

// Compound unique index prevents duplicate active block relationships
blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocked: 1 });

/**
 * Check whether either user has blocked the other (bidirectional)
 */
blockSchema.statics.isBlockedBidirectional = async function (userIdA, userIdB) {
    if (!userIdA || !userIdB) return false;
    if (userIdA.toString() === userIdB.toString()) return false;
    if (mongoose.connection.readyState === 0) return false;

    const exists = await this.exists({
        $or: [
            { blocker: userIdA, blocked: userIdB },
            { blocker: userIdB, blocked: userIdA },
        ],
    });
    return Boolean(exists);
};

/**
 * Retrieve all user IDs blocked by or blocking a given user (as array)
 */
blockSchema.statics.getBlockedUserIds = async function (userId) {
    if (!userId || mongoose.connection.readyState === 0) return [];

    const records = await this.find({
        $or: [{ blocker: userId }, { blocked: userId }],
    }).select("blocker blocked");

    const idSet = new Set();
    const currentIdStr = userId.toString();

    for (const record of records) {
        if (record.blocker && record.blocker.toString() !== currentIdStr) {
            idSet.add(record.blocker.toString());
        }
        if (record.blocked && record.blocked.toString() !== currentIdStr) {
            idSet.add(record.blocked.toString());
        }
    }

    return Array.from(idSet);
};

const Block = mongoose.model("Block", blockSchema);

export { Block };
