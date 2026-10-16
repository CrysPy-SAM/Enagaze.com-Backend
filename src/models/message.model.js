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
    },
    {
        timestamps: true,
    }
);

// Indexes for chronological retrieval and message history
messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index({ conversation: 1, _id: -1 });

// Sparse unique index on clientTempId within a conversation to guarantee idempotent retries
messageSchema.index(
    { conversation: 1, clientTempId: 1 },
    { unique: true, sparse: true }
);

const Message = mongoose.model("Message", messageSchema);

export { Message };

