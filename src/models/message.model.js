import mongoose, { Schema } from "mongoose";

const messageSchema = new Schema(
    {
        conversation: {
            type: Schema.Types.ObjectId,
            ref: "Conversation",
            required: [true, "Conversation ID is required"],
            index: true,
        },
        sender: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Sender ID is required"],
            index: true,
        },
        content: {
            type: String,
            required: [true, "Message content cannot be empty"],
            trim: true,
            maxlength: [2000, "Message content cannot exceed 2000 characters"],
        },
        clientTempId: {
            type: String,
            trim: true,
        },
        readBy: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
            },
        ],
        deletedFor: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
            },
        ],
        isDeletedForEveryone: {
            type: Boolean,
            default: false,
        },
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes for chronological retrieval and message history
messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index({ conversation: 1, _id: -1 });
// Compound index for reverse-chronological and cursor-based message retrieval
messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
// Compound index for fast unread message counts and batch read-state updates
messageSchema.index({ conversation: 1, sender: 1, readBy: 1 });
messageSchema.index({ conversation: 1, deletedFor: 1 });
messageSchema.index({ conversation: 1, isDeletedForEveryone: 1 });

// Compound unique index with partialFilterExpression scoped to conversation, sender, and clientTempId.
// Using partialFilterExpression avoids compound sparse index collisions on null/missing clientTempId,
// and scoping by sender prevents cross-sender collisions when different clients generate the same temporary ID.
messageSchema.index(
    { conversation: 1, sender: 1, clientTempId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            clientTempId: { $type: "string" },
        },
    }
);

const Message = mongoose.model("Message", messageSchema);

export { Message };

