import { Router } from "express";
import {
    getConversations,
    getOrCreateConversationByMatch,
    getMessages,
    markConversationAsRead,
    sendMessageRest,
} from "../controllers/chat.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// All conversation routes are protected by auth middleware
router.use(protect);

router.route("/").get(getConversations);
router.route("/match/:matchId").get(getOrCreateConversationByMatch);
router.route("/:conversationId/messages")
    .get(getMessages)
    .post(sendMessageRest);
router.route("/:conversationId/read").put(markConversationAsRead);

export default router;

