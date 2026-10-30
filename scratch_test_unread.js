import mongoose from "mongoose";
import { Message } from "./src/models/message.model.js";
import { Conversation } from "./src/models/conversation.model.js";
import { Match } from "./src/models/match.model.js";
import { User } from "./src/models/user.model.js";
import { calculateUserUnreadCount } from "./src/controllers/chat.controller.js";

async function runTest() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB");

    const userObjId = new mongoose.Types.ObjectId();
    const partnerObjId = new mongoose.Types.ObjectId();
    const matchObjId = new mongoose.Types.ObjectId();
    const convObjId = new mongoose.Types.ObjectId();

    // Create match and conversation
    await Match.create({
        _id: matchObjId,
        users: [userObjId, partnerObjId],
        userPair: `${userObjId}_${partnerObjId}`,
        status: "active",
    });

    await Conversation.create({
        _id: convObjId,
        match: matchObjId,
        participants: [userObjId, partnerObjId],
    });

    // Create 1 message from partner to user, and mark it read by user!
    const msg = await Message.create({
        conversation: convObjId,
        sender: partnerObjId,
        content: "Hello there!",
        readBy: [userObjId], // Marked as read!
    });

    console.log("Created message with readBy:", msg.readBy);

    // Now test calculateUserUnreadCount with ObjectId
    const resWithObjectId = await calculateUserUnreadCount(userObjId);
    console.log("Result with ObjectId:", resWithObjectId);

    // Now test calculateUserUnreadCount with String (which is what socket.userId passes!)
    const resWithString = await calculateUserUnreadCount(userObjId.toString());
    console.log("Result with String:", resWithString);

    // Cleanup
    await Message.deleteMany({ conversation: convObjId });
    await Conversation.deleteOne({ _id: convObjId });
    await Match.deleteOne({ _id: matchObjId });
    await mongoose.disconnect();
}

runTest().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});

