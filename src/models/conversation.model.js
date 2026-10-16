import mongoose, { Schema } from "mongoose";

const conversationSchema = new Schema(
    {
        match: {
            type: Schema.Types.ObjectId,
            ref: "Match",
            required: [true, "Match reference is required"],
            unique: true, // Guarantees strictly 1 conversation record per mutual match
            index: true,
        },
        participants: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
                required: true,
            },
        ],
        lastMessage: {
            type: Schema.Types.ObjectId,
            ref: "Message",
            default: null,
        },
        lastMessageAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

// Compound index on participants and lastMessageAt for fast sorted conversation feeds
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

const Conversation = mongoose.model("Conversation", conversationSchema);

export { Conversation };

