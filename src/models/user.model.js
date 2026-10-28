import mongoose, { Schema } from "mongoose";
import { calculateExactAge } from "../services/eligibility.service.js";

const userSchema = new Schema(
    {
        name: { 
            type: String, 
            required: [true, "Name is required"],
            trim: true,
            maxlength: [100, "Name cannot exceed 100 characters"]
        },
        username: { 
            type: String, 
            required: [true, "Username is required"], 
            unique: true,
            trim: true,
            lowercase: true,
            minlength: [3, "Username must be at least 3 characters"],
            maxlength: [30, "Username cannot exceed 30 characters"],
            match: [/^[a-zA-Z0-9_.-]+$/, "Username can only contain alphanumeric characters, dots, underscores, and dashes"]
        },
        email: {
            type: String,
            sparse: true,
            trim: true,
            lowercase: true,
        },
        googleId: {
            type: String,
            sparse: true,
            unique: true,
        },
        authProvider: {
            type: String,
            enum: ["local", "google"],
            default: "local",
        },
        password: { 
            type: String, 
            required: [
                function() {
                    return !this.googleId && this.authProvider !== "google";
                },
                "Password is required"
            ],
            minlength: [6, "Password must be at least 6 characters"]
        },
        dob: {
            type: Date,
            validate: {
                validator: function(value) {
                    if (!value) return true; // Optional initially until onboarding profile setup
                    const age = calculateExactAge(value);
                    return age !== null && age >= 18 && age <= 120;
                },
                message: "You must be at least 18 years old to use Engaze."
            }
        },
        gender: {
            type: String,
            enum: {
                values: ["male", "female", "non-binary", "other"],
                message: "{VALUE} is not a valid gender option"
            }
        },
        datingPreferences: {
            interestedIn: {
                type: [String],
                enum: ["male", "female", "non-binary", "everyone"],
                default: ["everyone"]
            },
            ageRange: {
                min: { type: Number, default: 18, min: 18 },
                max: { type: Number, default: 100, max: 120 }
            }
        },
        bio: {
            type: String,
            maxlength: [500, "Bio cannot exceed 500 characters"],
            default: ""
        },
        photos: {
            type: [String],
            default: []
        },
        interests: {
            type: [String],
            default: []
        },
        isProfileComplete: {
            type: Boolean,
            default: false
        },
        role: {
            type: String,
            enum: ["user", "moderator", "admin"],
            default: "user",
        },
        lastSeenAt: {
            type: Date,
            default: null,
        },
        privacySettings: {
            lastSeen: {
                type: String,
                enum: ["everyone", "matches", "matches_except", "nobody"],
                default: "everyone",
            },
            lastSeenExceptions: [
                {
                    type: Schema.Types.ObjectId,
                    ref: "User",
                },
            ],
            online: {
                type: String,
                enum: ["everyone", "same_as_last_seen"],
                default: "everyone",
            },
        },
        status: {
            type: String,
            enum: ["active", "suspended", "banned"],
            default: "active",
            index: true,
        },
        suspensionExpiresAt: {
            type: Date,
            default: null,
        },
        suspensionReason: {
            type: String,
            maxlength: [500, "Suspension reason cannot exceed 500 characters"],
            default: null,
        },
        bannedAt: {
            type: Date,
            default: null,
        },
        banReason: {
            type: String,
            maxlength: [500, "Ban reason cannot exceed 500 characters"],
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: { 
            virtuals: true,
            transform: function(doc, ret) {
                delete ret.password;
                delete ret.token;
                delete ret.__v;
                return ret;
            }
        },
        toObject: { 
            virtuals: true,
            transform: function(doc, ret) {
                delete ret.password;
                delete ret.token;
                delete ret.__v;
                return ret;
            }
        }
    }
);

// Virtual property to calculate age from dob dynamically
userSchema.virtual("age").get(function() {
    if (!this.dob) return undefined;
    const calculated = calculateExactAge(this.dob);
    return calculated !== null ? calculated : undefined;
});

// Indexes for People Discovery and Instagram-style search performance
userSchema.index({ name: 1 });
userSchema.index({ isProfileComplete: 1, username: 1 });
userSchema.index({ isProfileComplete: 1, name: 1 });

// High-performance compound indexes for adult discovery feed filtering and cursor pagination
userSchema.index({ isProfileComplete: 1, dob: 1, _id: -1 });
userSchema.index({ isProfileComplete: 1, gender: 1, dob: 1, _id: -1 });

const User = mongoose.model("User", userSchema);

/**
 * Evaluates account status and handles automatic expiration of temporary suspensions.
 *
 * @param {object} user - User document or user object
 * @param {Date} [referenceDate=new Date()] - Reference timestamp for expiration check
 * @returns {{ allowed: boolean, status: string, reason?: string, expiresAt?: Date, wasExpired?: boolean }}
 */
export function evaluateAccountStatus(user, referenceDate = new Date()) {
    if (!user) {
        return { allowed: false, status: "unknown", reason: "User not found" };
    }

    if (user.status === "banned") {
        return {
            allowed: false,
            status: "banned",
            reason: user.banReason || "Your account has been permanently banned.",
            bannedAt: user.bannedAt || null,
        };
    }

    if (user.status === "suspended") {
        if (user.suspensionExpiresAt && new Date(user.suspensionExpiresAt).getTime() <= referenceDate.getTime()) {
            return {
                allowed: true,
                status: "active",
                wasExpired: true,
            };
        }
        return {
            allowed: false,
            status: "suspended",
            reason: user.suspensionReason || "Your account has been temporarily suspended.",
            expiresAt: user.suspensionExpiresAt || null,
        };
    }

    return {
        allowed: true,
        status: user.status || "active",
    };
}

export { User };
