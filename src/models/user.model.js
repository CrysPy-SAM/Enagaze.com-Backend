import mongoose, { Schema } from "mongoose";

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
        password: { 
            type: String, 
            required: [true, "Password is required"],
            minlength: [6, "Password must be at least 6 characters"]
        },
        token: { 
            type: String 
        },
        dob: {
            type: Date,
            validate: {
                validator: function(value) {
                    if (!value) return true; // Optional initially until profile setup
                    const today = new Date();
                    let age = today.getFullYear() - value.getFullYear();
                    const m = today.getMonth() - value.getMonth();
                    if (m < 0 || (m === 0 && today.getDate() < value.getDate())) {
                        age--;
                    }
                    return age >= 18;
                },
                message: "You must be at least 18 years old."
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
        }
    },
    {
        timestamps: true,
        toJSON: { 
            virtuals: true,
            transform: function(doc, ret) {
                delete ret.password;
                delete ret.__v;
                return ret;
            }
        },
        toObject: { 
            virtuals: true,
            transform: function(doc, ret) {
                delete ret.password;
                delete ret.__v;
                return ret;
            }
        }
    }
);

// Virtual property to calculate age from dob dynamically
userSchema.virtual("age").get(function() {
    if (!this.dob) return undefined;
    const today = new Date();
    let age = today.getFullYear() - this.dob.getFullYear();
    const m = today.getMonth() - this.dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < this.dob.getDate())) {
        age--;
    }
    return age;
});

const User = mongoose.model("User", userSchema);

export { User };