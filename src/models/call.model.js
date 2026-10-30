import mongoose, { Schema } from "mongoose";

const callSchema = new Schema(
    {
        callId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
        },
        caller: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        receiver: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        participants: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
                index: true,
            },
        ],
        conversationId: {
            type: Schema.Types.ObjectId,
            ref: "Conversation",
            default: null,
        },
        callType: {
            type: String,
            enum: ["video", "audio"],
            default: "video",
        },
        status: {
            type: String,
            enum: [
                "ringing",    // Call initiated, awaiting answer
                "connected",  // Answered, media active
                "completed",  // Successfully completed and ended
                "missed",     // Receiver was alerted but call was not answered
                "rejected",   // Receiver actively declined
                "cancelled",  // Caller hung up before answer (or receiver not alerted)
                "no_answer",  // Timed out or unreachable when receiver not alerted
            ],
            default: "ringing",
            index: true,
        },
        receiverAlerted: {
            type: Boolean,
            default: false,
        },
        initiatedAt: {
            type: Date,
            default: Date.now,
        },
        answeredAt: {
            type: Date,
            default: null,
        },
        endedAt: {
            type: Date,
            default: null,
        },
        duration: {
            type: Number, // In whole seconds
            default: 0,
            min: 0,
        },
        endReason: {
            type: String,
            default: null,
            trim: true,
        },
        seenBy: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
            },
        ],
    },
    {
        timestamps: true,
        bufferCommands: false,
    }
);

// Compound indexes for optimal queries
callSchema.index({ participants: 1, createdAt: -1 });
callSchema.index({ receiver: 1, status: 1, seenBy: 1 });
callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ receiver: 1, createdAt: -1 });

const Call = mongoose.model("Call", callSchema);

export default Call;
export { Call };
