import mongoose, { Schema } from "mongoose";

const deviceTokenSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        token: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
        },
        platform: {
            type: String,
            enum: ["android", "ios", "web"],
            default: "android",
        },
        deviceId: {
            type: String,
            default: null,
            trim: true,
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
        lastUsedAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        timestamps: true,
        bufferCommands: false,
    }
);

// Indexes for fast lookup by user and active status
deviceTokenSchema.index({ userId: 1, isActive: 1 });
deviceTokenSchema.index({ token: 1, isActive: 1 });

/**
 * Registers or updates a device push token for a user idempotently.
 */
deviceTokenSchema.statics.registerToken = async function ({ userId, token, platform = "android", deviceId = null }) {
    if (!userId || !token) return null;
    return this.findOneAndUpdate(
        { token: token.trim() },
        {
            $set: {
                userId,
                platform,
                deviceId,
                isActive: true,
                lastUsedAt: new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

/**
 * Deactivates a token (e.g. on logout or FCM 410 Unregistered error).
 */
deviceTokenSchema.statics.deactivateToken = async function (token) {
    if (!token) return null;
    return this.findOneAndUpdate(
        { token: token.trim() },
        { $set: { isActive: false } },
        { new: true }
    );
};

/**
 * Deactivates all tokens for a user (e.g. account logout from all devices).
 */
deviceTokenSchema.statics.deactivateUserTokens = async function (userId) {
    if (!userId) return null;
    return this.updateMany(
        { userId, isActive: true },
        { $set: { isActive: false } }
    );
};

/**
 * Retrieves all active token strings for a user.
 */
deviceTokenSchema.statics.getActiveTokensForUser = async function (userId) {
    if (!userId) return [];
    const records = await this.find({ userId, isActive: true }).select("token").lean();
    return records.map((r) => r.token).filter(Boolean);
};

export const DeviceToken = mongoose.model("DeviceToken", deviceTokenSchema);
export default DeviceToken;

