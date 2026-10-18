import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    calculateAge,
    toPublicProfile,
    toSenderProfile,
    toMessageDto,
} from "../src/serializers/profile.serializer.js";

describe("Public & Peer Profile Serializer Privacy Test Suite", () => {
    // =========================================================================
    // 1. calculateAge Tests
    // =========================================================================
    describe("calculateAge", () => {
        it("calculates exact integer age correctly for past birthdays", () => {
            const today = new Date();
            // Exactly 25 years ago
            const dob = new Date(today.getFullYear() - 25, today.getMonth(), today.getDate());
            assert.equal(calculateAge(dob), 25);
        });

        it("accounts for birthday not yet reached in current calendar year", () => {
            const today = new Date();
            // Birthday next month (not yet reached)
            const dob = new Date(today.getFullYear() - 20, today.getMonth() + 1, 15);
            assert.equal(calculateAge(dob), 19);
        });

        it("returns null for null, undefined, empty, or invalid dates", () => {
            assert.equal(calculateAge(null), null);
            assert.equal(calculateAge(undefined), null);
            assert.equal(calculateAge(""), null);
            assert.equal(calculateAge("invalid-date-string"), null);
        });

        it("returns null for impossible future dates", () => {
            const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
            assert.equal(calculateAge(future), null);
        });
    });

    // =========================================================================
    // 2. toPublicProfile Allowlist & Field Stripping
    // =========================================================================
    describe("toPublicProfile", () => {
        const fullInternalUser = {
            _id: "65cb1234567890abcdef1234",
            name: "Priya Sharma",
            username: "priya_secret_login_handle",
            dob: new Date("1999-05-15T00:00:00.000Z"),
            email: "priya.sharma@example.com",
            googleId: "google-oauth-1092837465",
            authProvider: "google",
            password: "$2a$10$hashedpasswordstringthatmustneverleak",
            token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummytoken",
            gender: "female",
            bio: "Exploring tech, art, and good coffee ☕",
            photos: [
                "https://images.unsplash.com/photo-1?auto=format&fit=crop&w=800",
                "https://images.unsplash.com/photo-2?auto=format&fit=crop&w=800",
            ],
            interests: ["Art", "Travel", "Coffee"],
            datingPreferences: {
                interestedIn: ["male"],
                ageRange: { min: 22, max: 30 },
            },
            isProfileComplete: true,
            createdAt: new Date("2026-01-01T12:00:00.000Z"),
            updatedAt: new Date("2026-01-02T12:00:00.000Z"),
            __v: 0,
        };

        it("strips ALL private credentials, login identifiers, and internal fields", () => {
            const serialized = toPublicProfile(fullInternalUser);

            // Required allowlist fields must be present
            assert.equal(serialized._id, "65cb1234567890abcdef1234");
            assert.equal(serialized.name, "Priya Sharma");
            assert.ok(typeof serialized.age === "number");
            assert.equal(serialized.gender, "female");
            assert.equal(serialized.bio, "Exploring tech, art, and good coffee ☕");
            assert.deepEqual(serialized.photos, fullInternalUser.photos);
            assert.deepEqual(serialized.interests, fullInternalUser.interests);
            assert.equal(serialized.isProfileComplete, true);

            // SENSITIVE FIELDS MUST BE STRICTLY UNDEFINED
            assert.equal(serialized.username, undefined, "Login username must never be exposed");
            assert.equal(serialized.dob, undefined, "Exact DOB must never be exposed");
            assert.equal(serialized.email, undefined, "Email must never be exposed");
            assert.equal(serialized.googleId, undefined, "Google ID must never be exposed");
            assert.equal(serialized.password, undefined, "Password hash must never be exposed");
            assert.equal(serialized.token, undefined, "JWT/session token must never be exposed");
            assert.equal(serialized.authProvider, undefined, "Auth provider must never be exposed");
            assert.equal(serialized.datingPreferences, undefined, "Dating preferences must never be exposed");
            assert.equal(serialized.__v, undefined, "__v must never be exposed");
            assert.equal(serialized.createdAt, undefined, "createdAt must never be exposed");
            assert.equal(serialized.updatedAt, undefined, "updatedAt must never be exposed");

            // Allowlist key count check
            const allowedKeys = new Set([
                "_id",
                "name",
                "age",
                "gender",
                "bio",
                "photos",
                "interests",
                "isProfileComplete",
            ]);
            for (const key of Object.keys(serialized)) {
                assert.ok(allowedKeys.has(key), `Key '${key}' is not in the public allowlist`);
            }
        });

        it("handles Google-created user records with missing DOB and auth metadata", () => {
            const googleUser = {
                _id: "65cb9999999999abcdef9999",
                name: "Rahul Verma",
                username: "rahul.verma_google",
                email: "rahul@gmail.com",
                googleId: "gid-9988776655",
                authProvider: "google",
                photos: ["https://lh3.googleusercontent.com/a/photo.jpg"],
                isProfileComplete: false,
                // No dob, no bio, no interests
            };

            const serialized = toPublicProfile(googleUser);

            assert.equal(serialized._id, "65cb9999999999abcdef9999");
            assert.equal(serialized.name, "Rahul Verma");
            assert.equal(serialized.age, null, "Age should be null when DOB is absent");
            assert.equal(serialized.bio, "");
            assert.deepEqual(serialized.interests, []);
            assert.equal(serialized.isProfileComplete, false);

            assert.equal(serialized.username, undefined);
            assert.equal(serialized.email, undefined);
            assert.equal(serialized.googleId, undefined);
            assert.equal(serialized.authProvider, undefined);
        });

        it("handles completely empty, null, and sparse optional fields safely", () => {
            const sparseUser = {
                _id: "65cb0000000000abcdef0000",
                name: null,
                bio: null,
                photos: null,
                interests: null,
                gender: null,
                dob: null,
            };

            const serialized = toPublicProfile(sparseUser);

            assert.equal(serialized._id, "65cb0000000000abcdef0000");
            assert.equal(serialized.name, "Engaze Member");
            assert.equal(serialized.age, null);
            assert.equal(serialized.gender, null);
            assert.equal(serialized.bio, "");
            assert.deepEqual(serialized.photos, []);
            assert.deepEqual(serialized.interests, []);
            assert.equal(serialized.isProfileComplete, false);
        });

        it("returns null when passed null or undefined", () => {
            assert.equal(toPublicProfile(null), null);
            assert.equal(toPublicProfile(undefined), null);
        });
    });

    // =========================================================================
    // 3. toSenderProfile & toMessageDto Tests
    // =========================================================================
    describe("toSenderProfile & toMessageDto", () => {
        const internalSender = {
            _id: "65cb1111111111abcdef1111",
            name: "Ananya Roy",
            username: "ananya_login_id",
            dob: new Date("1998-11-20T00:00:00.000Z"),
            email: "ananya@example.com",
            photos: ["https://images.unsplash.com/ananya.jpg"],
            password: "hashedpassword",
        };

        it("toSenderProfile returns only _id, name, photos", () => {
            const senderDto = toSenderProfile(internalSender);

            assert.equal(senderDto._id, "65cb1111111111abcdef1111");
            assert.equal(senderDto.name, "Ananya Roy");
            assert.deepEqual(senderDto.photos, ["https://images.unsplash.com/ananya.jpg"]);

            assert.equal(senderDto.username, undefined);
            assert.equal(senderDto.dob, undefined);
            assert.equal(senderDto.email, undefined);
            assert.equal(senderDto.password, undefined);
            assert.equal(Object.keys(senderDto).length, 3);
        });

        it("toMessageDto sanitizes embedded sender and message fields", () => {
            const rawMessage = {
                _id: "msg_123456",
                conversation: "conv_abcdef",
                sender: internalSender,
                content: "Hey, nice to match with you!",
                clientTempId: "temp_uuid_987",
                readBy: ["65cb1111111111abcdef1111"],
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const messageDto = toMessageDto(rawMessage);

            assert.equal(messageDto._id, "msg_123456");
            assert.equal(messageDto.conversation, "conv_abcdef");
            assert.equal(messageDto.content, "Hey, nice to match with you!");
            assert.equal(messageDto.clientTempId, "temp_uuid_987");

            // Sender check
            assert.ok(messageDto.sender);
            assert.equal(messageDto.sender._id, "65cb1111111111abcdef1111");
            assert.equal(messageDto.sender.name, "Ananya Roy");
            assert.equal(messageDto.sender.username, undefined, "Sender username must be stripped");
            assert.equal(messageDto.sender.email, undefined);
        });

        it("toMessageDto returns null on null/undefined input", () => {
            assert.equal(toMessageDto(null), null);
            assert.equal(toMessageDto(undefined), null);
        });
    });
});

