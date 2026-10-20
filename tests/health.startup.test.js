import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import mongoose from "mongoose";
import http from "node:http";
import jwt from "jsonwebtoken";
import { io as ioc } from "socket.io-client";

import { app, server, start, gracefulShutdown, formatSafeDatabaseError, _resetShutdownForTesting } from "../src/app.js";
import { getJwtSecret } from "../src/config/jwt.js";

describe("Prompt 11.1: Backend Startup, Health, Liveness & Readiness Suite", () => {
    const originalEnv = { ...process.env };
    let originalReadyState;

    beforeEach(() => {
        process.env = { ...originalEnv };
        originalReadyState = mongoose.connection.readyState;
        _resetShutdownForTesting();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        _resetShutdownForTesting();
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

        it("simulated parse error containing credentials logs sanitized category and does NOT leak credentials", async () => {
            const fakeUser = "leaky_test_user_999";
            const fakePass = "super_secret_raw_pass_888";
            const simulatedError = new Error(`Protocol and host list are required in "mongodb://${fakeUser}:${fakePass}@"`);
            simulatedError.name = "MongoParseError";

            const origConnect = mongoose.connect;
            const origConsoleError = console.error;
            const capturedLogs = [];
            console.error = (...args) => {
                capturedLogs.push(args.join(" "));
            };

            const originalExit = process.exit;
            let exitCalled = false;
            let exitCode = null;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            mongoose.connect = async () => {
                throw simulatedError;
            };

            try {
                await assert.rejects(async () => {
                    await start({ exitOnError: true });
                });

                assert.equal(exitCalled, true);
                assert.equal(exitCode, 1);

                const allLogText = capturedLogs.join("\n");
                assert.ok(!allLogText.includes(fakeUser), "Username must never appear in logs");
                assert.ok(!allLogText.includes(fakePass), "Password must never appear in logs");
                assert.ok(!allLogText.includes("mongodb://"), "Raw URI scheme must never appear in logs");
                assert.ok(allLogText.includes("Fatal MongoDB Startup Connection Error"), "Safe category must be logged");
                assert.ok(allLogText.includes("MongoParseError"), "Safe error name must be preserved");
            } finally {
                mongoose.connect = origConnect;
                console.error = origConsoleError;
                process.exit = originalExit;
            }
        });

        it("formatSafeDatabaseError uses strict allowlist and suppresses arbitrary or tainted error properties", () => {
            const maliciousErr = {
                name: "mongodb://admin:secretPassword123@cluster.mongodb.net",
                code: "raw_secret_leak_code",
                message: "arbitrary message with secret",
            };

            const safeOutput = formatSafeDatabaseError(maliciousErr);
            assert.ok(!safeOutput.includes("secretPassword123"), "Malicious name must not leak");
            assert.ok(!safeOutput.includes("raw_secret_leak_code"), "Malicious code must not leak");
            assert.ok(!safeOutput.includes("cluster.mongodb.net"), "Host must not leak");
            assert.ok(safeOutput.includes("(DatabaseConnectionError)"), "Falls back to safe static name");

            // Legitimate error objects
            const parseErr = formatSafeDatabaseError({ name: "MongoParseError" });
            assert.ok(parseErr.includes("(MongoParseError)"), "Preserves safe name");

            const codeErr = formatSafeDatabaseError({ name: "MongoServerError", code: 18 });
            assert.ok(codeErr.includes("(MongoServerError [code: 18])"), "Preserves integer code");

            const sysErr = formatSafeDatabaseError({ name: "MongoNetworkError", code: "ECONNREFUSED" });
            assert.ok(sysErr.includes("(MongoNetworkError [code: ECONNREFUSED])"), "Preserves safe system code");
        });

        it("correctly classifies HTTP server listen/bind failure (EADDRINUSE) and does not label as MongoDB error", async () => {
            process.env.MONGO_URI = "mongodb://127.0.0.1:27017/test_db";

            const origConnect = mongoose.connect;
            const origDisconnect = mongoose.disconnect;
            const origListen = server.listen;
            const origConsoleError = console.error;
            const capturedLogs = [];
            console.error = (...args) => {
                capturedLogs.push(args.join(" "));
            };

            const originalExit = process.exit;
            let exitCalled = false;
            let exitCode = null;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            let disconnectCalled = false;
            mongoose.connect = async () => {
                Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
                return { connection: { host: "127.0.0.1" } };
            };
            mongoose.disconnect = async () => {
                disconnectCalled = true;
                Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true, writable: true });
            };

            // Simulate EADDRINUSE on server.listen
            server.listen = (port, cb) => {
                const err = new Error("listen EADDRINUSE: address already in use :::8000");
                err.code = "EADDRINUSE";
                server.emit("error", err);
            };

            try {
                await assert.rejects(async () => {
                    await start({ exitOnError: true });
                }, /EADDRINUSE/);

                assert.equal(exitCalled, true);
                assert.equal(exitCode, 1);
                assert.equal(disconnectCalled, true, "Mongoose must be disconnected if server listen fails");

                const allLogText = capturedLogs.join("\n");
                assert.ok(allLogText.includes("Fatal HTTP Server Listen Error: [EADDRINUSE]"), "Must log as HTTP Listen Error");
                assert.ok(!allLogText.includes("Fatal MongoDB Startup Connection Error: listen EADDRINUSE"), "Must NOT label as MongoDB error");
            } finally {
                mongoose.connect = origConnect;
                mongoose.disconnect = origDisconnect;
                server.listen = origListen;
                console.error = origConsoleError;
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

        it("gracefulShutdown ignores duplicate signals while shutdown is in progress", async () => {
            const origConsoleLog = console.log;
            const logs = [];
            console.log = (...args) => logs.push(args.join(" "));

            try {
                const firstPromise = gracefulShutdown("SIGTERM", { exit: false });
                await gracefulShutdown("SIGINT", { exit: false });
                await firstPromise;

                const allLogText = logs.join("\n");
                assert.ok(allLogText.includes("Shutdown already in progress. Ignoring duplicate SIGINT signal."));
            } finally {
                console.log = origConsoleLog;
            }
        });

        it("gracefulShutdown forces exit with 1 when shutdown timeout is exceeded", async () => {
            const origConsoleError = console.error;
            const errLogs = [];
            console.error = (...args) => errLogs.push(args.join(" "));

            const originalExit = process.exit;
            let exitCalled = false;
            let exitCode = null;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            const origClose = server.close;
            const origListening = server.listening;
            Object.defineProperty(server, "listening", { value: true, configurable: true });
            server.close = (cb) => {
                // Intentionally delay invoking callback longer than timeoutMs (50ms) to simulate stall
                if (typeof cb === "function") setTimeout(cb, 150);
            };

            try {
                // Launch shutdown without awaiting so test execution can advance while server.close hangs
                const shutdownPromise = gracefulShutdown("SIGTERM", { exit: true, timeoutMs: 50 });
                await new Promise((res) => setTimeout(res, 90));

                assert.equal(exitCalled, true, "Force exit must be called on timeout");
                assert.equal(exitCode, 1, "Exit code must be 1 on timeout");
                const allErrText = errLogs.join("\n");
                assert.ok(allErrText.includes("Graceful shutdown timed out after 50ms. Forcing exit."));
                // Allow simulated server.close to settle while process.exit remains mocked
                await shutdownPromise;
            } finally {
                server.close = origClose;
                Object.defineProperty(server, "listening", { value: origListening, configurable: true });
                console.error = origConsoleError;
                process.exit = originalExit;
                _resetShutdownForTesting();
            }
        });

        it("gracefulShutdown drains active Socket.IO WebSocket connection without waiting for fallback timeout", async () => {
            app.set("port", 0);
            process.env.MONGO_URI = "mongodb://127.0.0.1:27017/test_db";

            const origConnect = mongoose.connect;
            const origDisconnect = mongoose.disconnect;
            let mongooseDisconnected = false;

            mongoose.connect = async () => {
                Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });
                return { connection: { host: "127.0.0.1" } };
            };
            mongoose.disconnect = async () => {
                mongooseDisconnected = true;
                Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true, writable: true });
            };

            const started = await start({ exitOnError: false });
            const port = started.server.address().port;

            const testToken = jwt.sign(
                { id: new mongoose.Types.ObjectId().toString(), username: "test_ws_user" },
                getJwtSecret(),
                { expiresIn: "1h" }
            );

            // Connect real Socket.IO client using WebSocket transport
            const client = ioc(`http://127.0.0.1:${port}`, {
                transports: ["websocket"],
                reconnection: false,
                auth: { token: testToken },
            });

            await new Promise((resolve, reject) => {
                client.on("connect", resolve);
                client.on("connect_error", reject);
            });

            assert.equal(client.connected, true, "Socket.IO client must be connected");

            let clientDisconnected = false;
            const disconnectPromise = new Promise((resolve) => {
                client.on("disconnect", () => {
                    clientDisconnected = true;
                    resolve(true);
                });
            });

            // Initiate gracefulShutdown with a large timeout (4000ms)
            const startTime = Date.now();
            await gracefulShutdown("SIGTERM", { exit: false, timeoutMs: 4000 });
            const elapsedMs = Date.now() - startTime;
            await Promise.race([
                disconnectPromise,
                new Promise((res) => setTimeout(res, 200)),
            ]);

            // Assert:
            // 1. Shutdown completed promptly (< 500ms) without blocking on 4000ms fallback timeout
            assert.ok(elapsedMs < 500, `Shutdown took ${elapsedMs}ms; must complete without waiting for fallback timeout`);
            // 2. Client received disconnect event
            assert.equal(clientDisconnected, true, "Socket client must receive disconnect during shutdown");
            // 3. HTTP server is no longer listening
            assert.equal(started.server.listening, false, "HTTP server must be closed");
            // 4. Mongoose was disconnected after network shutdown
            assert.equal(mongooseDisconnected, true, "Mongoose must be disconnected after network drain");

            client.close();
            mongoose.connect = origConnect;
            mongoose.disconnect = origDisconnect;
        });
    });
});

