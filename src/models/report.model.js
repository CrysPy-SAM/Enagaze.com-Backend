import mongoose, { Schema } from "mongoose";

export const REPORT_CATEGORIES = [
    "harassment",
    "inappropriate_content",
    "spam_or_scam",
    "underage",
    "fake_profile",
    "hate_speech",
    "other",
];

export const REPORT_CONTEXTS = ["profile", "chat", "call"];

export const REPORT_STATUSES = ["pending", "investigating", "resolved", "dismissed"];

const reportSchema = new Schema(
    {
        reporter: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Reporter ID is required"],
            index: true,
        },
        reportedUser: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Reported user ID is required"],
            index: true,
        },
        category: {
            type: String,
            required: [true, "Report category is required"],
            enum: {
                values: REPORT_CATEGORIES,
                message: "{VALUE} is not a supported report category",
            },
        },
        reason: {
            type: String,
            trim: true,
            maxlength: [1000, "Reason explanation cannot exceed 1000 characters"],
            default: "",
        },
        context: {
            type: String,
            required: [true, "Report context is required"],
            enum: {
                values: REPORT_CONTEXTS,
                message: "{VALUE} is not a valid report context",
            },
        },
        conversation: {
            type: Schema.Types.ObjectId,
            ref: "Conversation",
            default: null,
        },
        callId: {
            type: String,
            trim: true,
            maxlength: [100, "Call ID cannot exceed 100 characters"],
            default: null,
        },
        status: {
            type: String,
            enum: REPORT_STATUSES,
            default: "pending",
            index: true,
        },
        resolutionNotes: {
            type: String,
            trim: true,
            maxlength: [1000, "Resolution notes cannot exceed 1000 characters"],
            default: "",
        },
        reviewedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes for moderation triage and inspection
reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reportedUser: 1, status: 1 });
reportSchema.index({ reporter: 1, reportedUser: 1, createdAt: -1 });

const Report = mongoose.model("Report", reportSchema);

export { Report };

