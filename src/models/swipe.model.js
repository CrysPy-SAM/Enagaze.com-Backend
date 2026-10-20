import mongoose, { Schema } from "mongoose";

const swipeSchema = new Schema(
    {
        fromUser: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "fromUser is required"],
            index: true
        },
        toUser: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "toUser is required"],
            index: true
        },
        action: {
            type: String,
            enum: {
                values: ["like", "pass"],
                message: "{VALUE} is not a valid swipe action"
            },
            required: [true, "Action is required"]
        }
    },
    {
        timestamps: true
    }
);

// Compound unique index ensures a user cannot swipe twice on the same target
swipeSchema.index({ fromUser: 1, toUser: 1 }, { unique: true });
// Performance indexes for reset pass queries and incoming likes lookup
swipeSchema.index({ fromUser: 1, action: 1 });
swipeSchema.index({ toUser: 1, action: 1 });

const Swipe = mongoose.model("Swipe", swipeSchema);

export { Swipe };

