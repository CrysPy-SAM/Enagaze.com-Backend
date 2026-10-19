import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import mongoose from "mongoose";
import http from "node:http";

import { app, server, start, gracefulShutdown } from "../src/app.js";

describe("Prompt 11.1: Backend Startup, Health, Liveness & Readiness Suite", () => {
    const originalEnv = { ...process.env };
    let originalReadyState;

    beforeEach(() => {
        process.env = { ...originalEnv };
        originalReadyState = mongoose.connection.readyState;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        Object.defineProperty(mongoose.connection, "readyState", {
            value: originalReadyState,
            configurable: true,
            writable: true,
        });
    });

    // =========================================================================
    // 1. Health, Liveness, and Readiness Semantics
    // =========================================================================
    describe("1. Liveness & Readiness Endpoints", () => {
        it("Liveness probe (GET /) returns 200 OK with service metadata regardless of DB state", async () => {
            // Force DB state to disconnected (0)
            Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true, writable: true });

            const res = await request(app).get("/");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "ok");
            assert.equal(res.body.service, "Engaze.com Backend API");
            assert.equal(typeof res.body.uptime, "number");
            assert.ok(res.body.timestamp);
        });

        it("Liveness probe (GET /api/v1/health/live) returns 200 alive status", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true, writable: true });

            const res = await request(app).get("/api/v1/health/live");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "alive");
            assert.equal(typeof res.body.uptime, "number");
            assert.ok(res.body.timestamp);
        });

        it("Readiness probe (GET /api/v1/health) succeeds with 200 when database is connected (readyState === 1)", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "healthy");
            assert.equal(res.body.ready, true);
            assert.equal(res.body.database, "connected");
            assert.equal(typeof res.body.uptime, "number");
            assert.ok(res.body.timestamp);
        });

        it("Readiness probe (GET /api/v1/health/ready) succeeds with 200 when database is connected", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

            const res = await request(app).get("/api/v1/health/ready");
            assert.equal(res.status, 200);
            assert.equal(res.body.status, "healthy");
            assert.equal(res.body.ready, true);
            assert.equal(res.body.database, "connected");
        });

        it("Readiness probe (GET /api/v1/health) fails with 503 Service Unavailable when DB is disconnected (readyState === 0)", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true, writable: true });

            const res = await request(app).get("/api/v1/health");
            assert.equal(res.status, 503);
            assert.equal(res.body.status, "unhealthy");
            assert.equal(res.body.ready, false);
            assert.equal(res.body.database, "disconnected");
        });

        it("Readiness probe (GET /api/v1/health/ready) fails with 503 when DB is connecting (readyState === 2)", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 2, configurable: true, writable: true });

            const res = await request(app).get("/api/v1/health/ready");
            assert.equal(res.status, 503);
            assert.equal(res.body.status, "unhealthy");
            assert.equal(res.body.ready, false);
            assert.equal(res.body.database, "disconnected");
        });

        it("Liveness and readiness semantics are strictly distinct when DB is disconnected", async () => {
            Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true, writable: true });

            // Liveness must report process is alive (200)
            const livenessRes = await request(app).get("/api/v1/health/live");
            assert.equal(livenessRes.status, 200);
            assert.equal(livenessRes.body.status, "alive");

            // Readiness must report service cannot accept traffic (503)
            const readinessRes = await request(app).get("/api/v1/health/ready");
            assert.equal(readinessRes.status, 503);
            assert.equal(readinessRes.body.ready, false);
        });

        it("Health responses never expose connection strings, passwords, or credentials", async () => {
            const secretMarker = "super_secret_db_password_12345";
            process.env.MONGO_URI = `mongodb+srv://admin:${secretMarker}@cluster.example.net/engaze`;

            const endpoints = ["/", "/api/v1/health", "/api/v1/health/live", "/api/v1/health/ready"];

            for (const ep of endpoints) {
                const res = await request(app).get(ep);
                const rawText = JSON.stringify(res.body);

                assert.ok(!rawText.includes(secretMarker), `${ep} leaked password`);
                assert.ok(!rawText.includes("mongodb+srv://"), `${ep} leaked connection string scheme`);
                assert.ok(!rawText.includes("cluster.example.net"), `${ep} leaked cluster host`);
            }
        });
    });

    // =========================================================================
    // 2. Startup Failure & Process Lifecycle Handling
    // =========================================================================
    describe("2. Startup Failure & Process Lifecycle", () => {
        it("fails startup immediately if MONGO_URI is missing or empty", async () => {
            delete process.env.MONGO_URI;

            let exitCalled = false;
            let exitCode = null;
            const originalExit = process.exit;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            try {
                await assert.rejects(
                    async () => {
                        await start({ exitOnError: true });
                    },
                    /MONGO_URI environment variable is required to start the server/i
                );

                assert.equal(exitCalled, true, "process.exit must be called when MONGO_URI is missing");
                assert.equal(exitCode, 1, "Exit code must be 1 on missing MONGO_URI");
            } finally {
                process.exit = originalExit;
            }
        });

        it("initial MongoDB connection failure logs safe error, does not listen, and exits with 1", async () => {
            process.env.MONGO_URI = "mongodb://127.0.0.1:27017/nonexistent_test_db";

            const origConnect = mongoose.connect;
            let exitCalled = false;
            let exitCode = null;
            const originalExit = process.exit;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            // Simulate connection failure
            mongoose.connect = async () => {
                throw new Error("MongooseServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017");
            };

            try {
                await assert.rejects(
                    async () => {
                        await start({ exitOnError: true });
                    },
                    /MongooseServerSelectionError/i
                );

                assert.equal(exitCalled, true, "process.exit must be called on initial DB connection failure");
                assert.equal(exitCode, 1, "Exit code must be 1 on connection failure");
                assert.equal(server.listening, false, "Server must not be listening after connection failure");
            } finally {
                mongoose.connect = origConnect;
                process.exit = originalExit;
            }
        });

        it("successful startup waits for database connection before listening and returns server and connection", async () => {
            process.env.MONGO_URI = "mongodb://127.0.0.1:27017/test_db";
            app.set("port", 0); // Dynamic available port for testing

            const origConnect = mongoose.connect;
            let connectCalled = false;

            mongoose.connect = async () => {
                connectCalled = true;
                return {
                    connection: {
                        host: "127.0.0.1",
                    },
                };
            };

            try {
                const result = await start({ exitOnError: false });
                assert.equal(connectCalled, true, "mongoose.connect must be called");
                assert.ok(result.server.listening, "Server must be listening upon successful start");

                // Cleanly stop test listening server
                await new Promise((res) => result.server.close(res));
            } finally {
                mongoose.connect = origConnect;
                if (server.listening) {
                    await new Promise((res) => server.close(res));
                }
            }
        });

        it("gracefulShutdown cleanly closes connections and terminates with exit 0", async () => {
            let exitCalled = false;
            let exitCode = null;
            const originalExit = process.exit;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            try {
                await gracefulShutdown("SIGTERM", { exit: true });
                assert.equal(exitCalled, true);
                assert.equal(exitCode, 0);
            } finally {
                process.exit = originalExit;
            }
        });
    });
});

