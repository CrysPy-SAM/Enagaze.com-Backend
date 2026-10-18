import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";

import { validateJwtConfig, getJwtSecret, JWT_EXPIRES_IN } from "../src/config/jwt.js";
import { isOriginAllowed, corsOptions, getAllowedOrigins } from "../src/config/cors.js";
import { app } from "../src/app.js";

describe("Batch 1 Security Hardening Test Suite", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    // =========================================================================
    // 1. JWT Configuration & Production Startup Safeguards
    // =========================================================================
    describe("JWT Secrets & Startup Failsafe", () => {
        it("fails startup in production when JWT_SECRET is completely missing", () => {
            process.env.NODE_ENV = "production";
            delete process.env.JWT_SECRET;

            assert.throws(
                () => validateJwtConfig({ exitOnError: false }),
                /JWT_SECRET environment variable is required in production/
            );
        });

        it("fails startup in production when JWT_SECRET is empty or whitespace", () => {
            process.env.NODE_ENV = "production";
            process.env.JWT_SECRET = "   ";

            assert.throws(
                () => validateJwtConfig({ exitOnError: false }),
                /JWT_SECRET environment variable is required in production/
            );
        });

        it("fails startup in production when JWT_SECRET is shorter than 32 characters", () => {
            process.env.NODE_ENV = "production";
            process.env.JWT_SECRET = "too_short_secret_under_32";

            assert.throws(
                () => validateJwtConfig({ exitOnError: false }),
                /at least 32 characters long in production/
            );
        });

        it("fails startup in production when JWT_SECRET uses known insecure development placeholders", () => {
            process.env.NODE_ENV = "production";
            const placeholders = [
                "engaze_super_secret_jwt_key_2026_dev_secure",
                "your_jwt_secret_key_change_in_production",
                "secret",
                "dev_secret",
                "change_me",
            ];

            for (const placeholder of placeholders) {
                process.env.JWT_SECRET = placeholder;
                assert.throws(
                    () => validateJwtConfig({ exitOnError: false }),
                    /cannot use an insecure development placeholder in production/,
                    `Should reject placeholder: ${placeholder}`
                );
            }
        });

        it("succeeds in production when JWT_SECRET is a cryptographically strong >=32 char string", () => {
            process.env.NODE_ENV = "production";
            process.env.JWT_SECRET = "c0a80101b4c9e8d7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3";

            const result = validateJwtConfig({ exitOnError: false });
            assert.equal(result, true);
            assert.equal(getJwtSecret(), process.env.JWT_SECRET);
        });

        it("does NOT generate different random secrets across server restarts in development", () => {
            process.env.NODE_ENV = "development";
            delete process.env.JWT_SECRET;

            const secretCall1 = getJwtSecret();
            const secretCall2 = getJwtSecret();
            assert.equal(secretCall1, secretCall2);
            assert.ok(secretCall1.length > 0);
        });

        it("all JWT operations use consistent signing and verification", () => {
            process.env.NODE_ENV = "development";
            process.env.JWT_SECRET = "test_shared_secret_for_all_modules_2026_ok";

            const secret = getJwtSecret();
            const payload = { id: "user_123", username: "alice" };
            const token = jwt.sign(payload, secret, { expiresIn: JWT_EXPIRES_IN });

            const decoded = jwt.verify(token, getJwtSecret());
            assert.equal(decoded.id, "user_123");
            assert.equal(decoded.username, "alice");
        });
    });

    // =========================================================================
    // 2. Strict CORS & Origin Policy Consistency
    // =========================================================================
    describe("CORS Allowlist & Origin Policy", () => {
        it("allows legitimate production frontend origin", () => {
            assert.equal(isOriginAllowed("https://engaze-com.vercel.app"), true);
        });

        it("allows legitimate localhost development origins", () => {
            assert.equal(isOriginAllowed("http://localhost:3000"), true);
            assert.equal(isOriginAllowed("http://localhost:5173"), true);
            assert.equal(isOriginAllowed("http://127.0.0.1:3000"), true);
            assert.equal(isOriginAllowed("http://127.0.0.1:5173"), true);
        });

        it("allows custom CLIENT_URL and ALLOWED_ORIGINS when configured", () => {
            process.env.CLIENT_URL = "https://custom.engaze.com";
            process.env.ALLOWED_ORIGINS = "https://staging.engaze.com, https://admin.engaze.com";

            assert.equal(isOriginAllowed("https://custom.engaze.com"), true);
            assert.equal(isOriginAllowed("https://staging.engaze.com"), true);
            assert.equal(isOriginAllowed("https://admin.engaze.com"), true);
        });

        it("strictly REJECTS arbitrary *.vercel.app origins", () => {
            const forbiddenOrigins = [
                "https://attacker-fake-app.vercel.app",
                "https://engaze-phishing.vercel.app",
                "https://random-tenant.vercel.app",
                "https://evil.vercel.app",
            ];

            for (const origin of forbiddenOrigins) {
                assert.equal(
                    isOriginAllowed(origin),
                    false,
                    `Origin ${origin} should be rejected but was allowed`
                );
            }
        });

        it("strictly REJECTS untrusted, malicious and malformed origins", () => {
            const malformedOrigins = [
                "https://evil-hacker.com",
                "http://evil-attacker.org",
                "null",
                "file://",
                "javascript:void(0)",
                "http://localhost:8080",
                "https://engaze-com.vercel.app.attacker.com",
            ];

            for (const origin of malformedOrigins) {
                assert.equal(
                    isOriginAllowed(origin),
                    false,
                    `Origin ${origin} must be rejected`
                );
            }
        });

        it("allows requests with no Origin header (curl, mobile native apps, health monitors)", () => {
            assert.equal(isOriginAllowed(undefined), true);
            assert.equal(isOriginAllowed(""), true);
        });

        it("express app returns Access-Control-Allow-Origin only for allowed origins", async () => {
            // Allowed origin test
            const allowedRes = await request(app)
                .get("/api/v1/health")
                .set("Origin", "https://engaze-com.vercel.app");

            assert.equal(
                allowedRes.headers["access-control-allow-origin"],
                "https://engaze-com.vercel.app"
            );
            assert.equal(allowedRes.headers["access-control-allow-credentials"], "true");

            // Disallowed origin test
            const disallowedRes = await request(app)
                .get("/api/v1/health")
                .set("Origin", "https://malicious-attacker.com");

            assert.equal(
                disallowedRes.headers["access-control-allow-origin"],
                undefined,
                "Disallowed origin must NOT receive Access-Control-Allow-Origin header"
            );
        });
    });

    // =========================================================================
    // 3. Rate Limiting, Proxy Trust & IP Isolation
    // =========================================================================
    describe("Rate Limiting & Reverse-Proxy IP Resolution", () => {
        it("verifies Express has trust proxy: 1 configured for Render topology", () => {
            const trustProxySetting = app.get("trust proxy");
            assert.equal(
                trustProxySetting,
                1,
                "trust proxy must be configured to 1 for Render reverse-proxy topology"
            );
        });

        it("differentiates requests from separate client IPs behind the proxy", async () => {
            const testApp = express();
            testApp.set("trust proxy", 1);

            const testLimiter = rateLimit({
                windowMs: 60 * 1000,
                limit: 2,
                standardHeaders: "draft-7",
                legacyHeaders: false,
                handler: (_req, res) => res.status(429).json({ success: false, message: "Limit reached" }),
            });

            testApp.get("/test-ip-rate-limit", testLimiter, (req, res) => {
                res.status(200).json({ ip: req.ip });
            });

            // IP 1 sends 2 requests (reaches limit)
            const ip1 = "203.0.113.195";
            const res1 = await request(testApp).get("/test-ip-rate-limit").set("X-Forwarded-For", ip1);
            assert.equal(res1.status, 200);
            assert.equal(res1.body.ip, ip1);

            const res2 = await request(testApp).get("/test-ip-rate-limit").set("X-Forwarded-For", ip1);
            assert.equal(res2.status, 200);

            // IP 1 3rd request is blocked with 429
            const res3 = await request(testApp).get("/test-ip-rate-limit").set("X-Forwarded-For", ip1);
            assert.equal(res3.status, 429);
            assert.equal(res3.body.message, "Limit reached");

            // IP 2 is completely distinct and NOT blocked by IP 1's consumption
            const ip2 = "198.51.100.44";
            const resOtherIp = await request(testApp).get("/test-ip-rate-limit").set("X-Forwarded-For", ip2);
            assert.equal(
                resOtherIp.status,
                200,
                "Distinct client IP must have its own rate-limit bucket and not be blocked"
            );
            assert.equal(resOtherIp.body.ip, ip2);
        });

        it("returns standard RateLimit headers on rate-limited endpoints", async () => {
            const testApp = express();
            testApp.set("trust proxy", 1);

            const testLimiter = rateLimit({
                windowMs: 60 * 1000,
                limit: 5,
                standardHeaders: "draft-7",
                legacyHeaders: false,
            });

            testApp.post("/test-headers", testLimiter, (_req, res) => res.status(200).send("OK"));

            const res = await request(testApp).post("/test-headers");
            assert.ok(res.headers["ratelimit-limit"] !== undefined || res.headers["ratelimit"] !== undefined);
        });
    });

    // =========================================================================
    // 4. API Endpoints & Auth Middleware Verification
    // =========================================================================
    describe("API Health & Authentication Middleware", () => {
        it("GET / returns 200 without rate-limit interference", async () => {
            const res = await request(app).get("/");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "ok");
        });

        it("GET /api/v1/health returns 200 healthy status", async () => {
            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "healthy");
        });

        it("protected routes reject unauthenticated requests with HTTP 401", async () => {
            const res = await request(app).get("/api/v1/users/profile/me");
            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /Authentication required/i);
        });

        it("protected routes reject forged/invalid tokens with HTTP 401", async () => {
            const res = await request(app)
                .get("/api/v1/users/profile/me")
                .set("Authorization", "Bearer invalid.forged.jwt.token");

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.match(res.body.message, /Invalid authentication token/i);
        });
    });
});

