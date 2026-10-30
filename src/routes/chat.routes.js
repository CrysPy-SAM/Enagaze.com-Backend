import { Router } from "express";
import {
    getConversations,
    getUnreadMessageCount,
    getOrCreateConversationByMatch,
    getMessages,
    markConversationAsRead,
    sendMessageRest,
} from "../controllers/chat.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { requireEligibility } from "../services/eligibility.service.js";

const router = Router();

// All conversation routes are protected by auth middleware and eligibility policy
router.use(protect);
router.use(requireEligibility);

router.route("/").get(getConversations);
router.route("/unread-count").get(getUnreadMessageCount);
router.route("/match/:matchId").get(getOrCreateConversationByMatch);
router.route("/:conversationId/messages")
    .get(getMessages)
    .post(sendMessageRest);
router.route("/:conversationId/read").put(markConversationAsRead);

export default router;

