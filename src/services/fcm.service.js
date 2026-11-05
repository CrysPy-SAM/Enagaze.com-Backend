import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { DeviceToken } from "../models/deviceToken.model.js";

let fcmApp = null;
let isInitialized = false;

/**
 * Initializes Firebase Admin SDK using environment variables or service account file.
 * Fails gracefully without crashing if credentials are not yet configured.
 */
export const initFirebaseAdmin = () => {
    if (isInitialized) return fcmApp;

    try {
        if (admin.apps && admin.apps.length > 0) {
            fcmApp = admin.apps[0];
            isInitialized = true;
            return fcmApp;
        }

        let credential = null;

        // 1. Check for raw JSON or Base64 JSON string in environment variable
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
        if (envKey && envKey.trim()) {
            let keyStr = envKey.trim();
            // Handle Base64 encoded JSON
            if (keyStr.startsWith("ey") && !keyStr.includes("{")) {
                try {
                    keyStr = Buffer.from(keyStr, "base64").toString("utf-8");
                } catch {
                    // Fall back to raw string
                }
            }
            try {
                const serviceAccount = JSON.parse(keyStr);
                credential = admin.credential.cert(serviceAccount);
            } catch (parseErr) {
                console.error("[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:", parseErr.message);
            }
        }

        // 2. Check for local file path (e.g. backend/serviceAccountKey.json or GOOGLE_APPLICATION_CREDENTIALS)
        if (!credential) {
            const possiblePaths = [
                process.env.FIREBASE_CREDENTIALS_PATH,
                process.env.GOOGLE_APPLICATION_CREDENTIALS,
                path.resolve(process.cwd(), "serviceAccountKey.json"),
                path.resolve(process.cwd(), "firebase-service-account.json"),
            ].filter(Boolean);

            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    try {
                        const fileContent = fs.readFileSync(p, "utf-8");
                        const serviceAccount = JSON.parse(fileContent);
                        credential = admin.credential.cert(serviceAccount);
                        console.log(`[FCM] Loaded credentials from file: ${p}`);
                        break;
                    } catch (fileErr) {
                        console.error(`[FCM] Error reading credential file ${p}:`, fileErr.message);
                    }
                }
            }
        }

        if (credential) {
            fcmApp = admin.initializeApp({ credential });
            isInitialized = true;
            console.log("[FCM] Firebase Admin SDK initialized successfully");
        } else {
            console.warn("[FCM] Firebase Admin credentials not found. Push notifications will be simulated.");
        }
    } catch (err) {
        console.error("[FCM] Initialization error:", err.message);
    }

    return fcmApp;
};

// Initialize immediately upon module load
initFirebaseAdmin();

/**
 * Clean up invalid or expired FCM registration tokens.
 */
const cleanupStaleTokens = async (tokens, responses) => {
    if (!Array.isArray(tokens) || !Array.isArray(responses)) return;
    const staleTokens = [];

    responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
            const code = resp.error.code;
            if (
                code === "messaging/registration-token-not-registered" ||
                code === "messaging/invalid-registration-token" ||
                code === "messaging/mismatched-credential"
            ) {
                staleTokens.push(tokens[idx]);
            }
        }
    });

    if (staleTokens.length > 0) {
        await Promise.allSettled(staleTokens.map((t) => DeviceToken.deactivateToken(t)));
        console.log(`[FCM] Deactivated ${staleTokens.length} stale registration tokens.`);
    }
};

/**
 * Sends a high-priority data-only push for an incoming direct 1-on-1 video/audio call.
 * This wakes up Android OS and native FirebaseMessagingService even if the app is swiped away.
 */
export const sendIncomingCallPush = async ({
    calleeId,
    caller,
    callId,
    callType = "video",
    conversationId = null,
}) => {
    try {
        if (!calleeId || !callId) return { sentCount: 0 };
        if (mongoose.connection?.readyState !== 1) return { sentCount: 0, dbNotReady: true };
        const tokens = await DeviceToken.getActiveTokensForUser(calleeId);
        if (!tokens || tokens.length === 0) return { sentCount: 0, noTokens: true };

        const callerId = caller?._id?.toString() || caller?.id?.toString() || "";
        const callerName = caller?.name || caller?.username || "Engaze Match";
        const callerPhoto = caller?.photos?.[0] || caller?.photo || "";

        const payload = {
            tokens,
            data: {
                type: "incoming_call",
                callId: String(callId),
                callerId: String(callerId),
                callerName: String(callerName),
                callerPhoto: String(callerPhoto),
                callType: String(callType),
                conversationId: conversationId ? String(conversationId) : "",
                timestamp: String(Date.now()),
            },
            android: {
                priority: "high",
                ttl: 45 * 1000, // 45 seconds TTL matching call ringing timeout
            },
        };

        if (!isInitialized || !fcmApp) {
            console.log(`[FCM Mock] Incoming call push dispatched to ${tokens.length} token(s) for call ${callId}`);
            return { sentCount: tokens.length, mocked: true };
        }

        const response = await admin.messaging().sendEachForMulticast(payload);
        if (response.failureCount > 0) {
            cleanupStaleTokens(tokens, response.responses).catch(() => {});
        }

        return {
            sentCount: response.successCount,
            failureCount: response.failureCount,
        };
    } catch (err) {
        console.error("[FCM] Error sending incoming call push:", err);
        return { sentCount: 0, error: err.message };
    }
};

/**
 * Sends a high-priority cancellation signal to dismiss the incoming call notification
 * if the caller hangs up before the receiver answers.
 */
export const sendCallCancelledPush = async ({ calleeId, callId, reason = "cancelled" }) => {
    try {
        if (!calleeId || !callId) return { sentCount: 0 };
        if (mongoose.connection?.readyState !== 1) return { sentCount: 0, dbNotReady: true };
        const tokens = await DeviceToken.getActiveTokensForUser(calleeId);
        if (!tokens || tokens.length === 0) return { sentCount: 0 };

        const payload = {
            tokens,
            data: {
                type: "call_cancelled",
                callId: String(callId),
                reason: String(reason),
                timestamp: String(Date.now()),
            },
            android: {
                priority: "high",
                ttl: 15 * 1000,
            },
        };

        if (!isInitialized || !fcmApp) {
            console.log(`[FCM Mock] Call cancellation push dispatched to ${tokens.length} token(s) for call ${callId}`);
            return { sentCount: tokens.length, mocked: true };
        }

        const response = await admin.messaging().sendEachForMulticast(payload);
        if (response.failureCount > 0) {
            cleanupStaleTokens(tokens, response.responses).catch(() => {});
        }

        return { sentCount: response.successCount };
    } catch (err) {
        console.error("[FCM] Error sending call cancelled push:", err);
        return { sentCount: 0, error: err.message };
    }
};

/**
 * Sends a background chat message notification.
 */
export const sendChatMessagePush = async ({
    recipientId,
    sender,
    content,
    mediaUrl = null,
    conversationId,
}) => {
    try {
        if (!recipientId || !conversationId) return { sentCount: 0 };
        if (mongoose.connection?.readyState !== 1) return { sentCount: 0, dbNotReady: true };
        const tokens = await DeviceToken.getActiveTokensForUser(recipientId);
        if (!tokens || tokens.length === 0) return { sentCount: 0, noTokens: true };

        const senderName = sender?.name || sender?.username || "Someone";
        const messageText = content || (mediaUrl ? "Sent a photo 📷" : "Sent a message");

        const payload = {
            tokens,
            data: {
                type: "chat_message",
                conversationId: String(conversationId),
                senderId: String(sender?._id || sender?.id || ""),
                senderName: String(senderName),
                content: String(messageText),
                timestamp: String(Date.now()),
            },
            android: {
                priority: "high",
            },
        };

        if (!isInitialized || !fcmApp) {
            console.log(`[FCM Mock] Chat message push dispatched to ${tokens.length} token(s)`);
            return { sentCount: tokens.length, mocked: true };
        }

        const response = await admin.messaging().sendEachForMulticast(payload);
        if (response.failureCount > 0) {
            cleanupStaleTokens(tokens, response.responses).catch(() => {});
        }

        return { sentCount: response.successCount };
    } catch (err) {
        console.error("[FCM] Error sending chat message push:", err);
        return { sentCount: 0, error: err.message };
    }
};
