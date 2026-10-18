import mongoose, { Schema } from "mongoose";

const matchSchema = new Schema(
    {
        users: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
                required: true
            }
        ],
        userPair: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        status: {
            type: String,
            enum: ["active", "unmatched"],
            default: "active",
            index: true
        },
        unmatchedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        unmatchedAt: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// Index on users array for fast lookup of a user's matches
matchSchema.index({ users: 1 });

// Static helper to create a deterministic, canonical user pair string
matchSchema.statics.getCanonicalPair = function (userId1, userId2) {
    const id1 = userId1.toString();
    const id2 = userId2.toString();
    return id1 < id2 ? `${id1}_${id2}` : `${id2}_${id1}`;
};

const Match = mongoose.model("Match", matchSchema);

export { Match };

