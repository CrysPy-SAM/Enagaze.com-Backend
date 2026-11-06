import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { initializeApp, cert, deleteApp, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import {
    initFirebaseAdmin,
    sendIncomingCallPush,
    sendCallCancelledPush,
    sendChatMessagePush,
} from "../src/services/fcm.service.js";

describe("Firebase Admin SDK & FCM Service Unit Tests", () => {
    it("should verify that firebase-admin/app exports cert and initializeApp", () => {
        assert.equal(typeof cert, "function", "cert must be an exported function");
        assert.equal(typeof initializeApp, "function", "initializeApp must be an exported function");
        assert.equal(typeof getApps, "function", "getApps must be an exported function");
        assert.equal(typeof getMessaging, "function", "getMessaging must be an exported function");
    });

    it("should initialize Firebase Admin using cert() with a valid RSA service account object", async () => {
        const { privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });

        const serviceAccount = {
            project_id: "test-engaze-date",
            client_email: "firebase-adminsdk@test-engaze-date.iam.gserviceaccount.com",
            private_key: privateKey,
        };

        const credential = cert(serviceAccount);
        assert.ok(credential, "cert() must return a credential object");

        const appName = `test-app-${Date.now()}`;
        const app = initializeApp({ credential }, appName);
        assert.equal(app.name, appName);

        const messaging = getMessaging(app);
        assert.ok(messaging, "getMessaging must return a messaging instance");

        await deleteApp(app);
    });

    it("should support Base64-encoded service account JSON string", async () => {
        const { privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });

        const rawAccount = {
            project_id: "test-engaze-date-b64",
            client_email: "firebase-adminsdk@test-engaze-date.iam.gserviceaccount.com",
            private_key: privateKey,
        };

        const base64Str = Buffer.from(JSON.stringify(rawAccount)).toString("base64");

        // Simulate base64 decoding logic from fcm.service.js
        let decodedStr = base64Str.trim();
        if (!decodedStr.startsWith("{")) {
            decodedStr = Buffer.from(decodedStr, "base64").toString("utf-8");
        }
        assert.ok(decodedStr.startsWith("{"), "Decoded string must be JSON");

        const parsed = JSON.parse(decodedStr);
        assert.equal(parsed.project_id, "test-engaze-date-b64");

        const appName = `test-b64-app-${Date.now()}`;
        const app = initializeApp({ credential: cert(parsed) }, appName);
        assert.equal(app.name, appName);
        await deleteApp(app);
    });

    it("should correctly normalize escaped newlines (\\n) in private_key", () => {
        const fakeKeyWithEscapes = "-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\\n-----END PRIVATE KEY-----\\n";
        const normalized = fakeKeyWithEscapes.replace(/\\n/g, "\n");
        assert.ok(normalized.includes("\n"));
        assert.ok(!normalized.includes("\\n"));
    });

    it("should gracefully handle missing credentials and return fcmApp status without crashing", () => {
        const app = initFirebaseAdmin();
        // Without real credentials configured in test env, it should not throw and return null or existing app
        assert.ok(app === null || typeof app === "object");
    });

    it("should gracefully handle mock push dispatch when no active tokens exist", async () => {
        const resCall = await sendIncomingCallPush({
            calleeId: "507f1f77bcf86cd799439011",
            caller: { name: "Test Caller" },
            callId: "call_12345",
        });
        assert.equal(resCall.sentCount, 0);

        const resCancel = await sendCallCancelledPush({
            calleeId: "507f1f77bcf86cd799439011",
            callId: "call_12345",
        });
        assert.equal(resCancel.sentCount, 0);

        const resMsg = await sendChatMessagePush({
            recipientId: "507f1f77bcf86cd799439011",
            sender: { name: "Sender" },
            content: "Hello",
            conversationId: "conv_12345",
        });
        assert.equal(resMsg.sentCount, 0);
    });
});

