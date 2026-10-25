import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import {
    getMongoConnectionOptions,
    parseIntegerOption,
    DEFAULT_MAX_POOL_SIZE,
    DEFAULT_MIN_POOL_SIZE,
    DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
} from "../src/config/database.js";
import { start, server, _resetShutdownForTesting } from "../src/app.js";

describe("Phase 2E.1: MongoDB Connection Pool Configuration & Validation Suite", () => {
    describe("1. Default Connection Pool Options", () => {
        it("returns standard defaults when environment variables are unset", () => {
            const options = getMongoConnectionOptions({});
            assert.deepStrictEqual(options, {
                maxPoolSize: DEFAULT_MAX_POOL_SIZE,
                minPoolSize: DEFAULT_MIN_POOL_SIZE,
                serverSelectionTimeoutMS: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
            });
            assert.strictEqual(options.maxPoolSize, 25);
            assert.strictEqual(options.minPoolSize, 0);
            assert.strictEqual(options.serverSelectionTimeoutMS, 30000);
        });

        it("returns standard defaults when environment variables are empty strings or whitespace", () => {
            const options = getMongoConnectionOptions({
                MONGO_MAX_POOL_SIZE: "   ",
                MONGO_MIN_POOL_SIZE: "",
                MONGO_SERVER_SELECTION_TIMEOUT_MS: " ",
            });
            assert.strictEqual(options.maxPoolSize, 25);
            assert.strictEqual(options.minPoolSize, 0);
            assert.strictEqual(options.serverSelectionTimeoutMS, 30000);
        });
    });

    describe("2. Valid Explicit Pool Configuration Parsing", () => {
        it("parses valid integer strings into numbers", () => {
            const options = getMongoConnectionOptions({
                MONGO_MAX_POOL_SIZE: "50",
                MONGO_MIN_POOL_SIZE: "10",
                MONGO_SERVER_SELECTION_TIMEOUT_MS: "15000",
            });
            assert.strictEqual(options.maxPoolSize, 50);
            assert.strictEqual(options.minPoolSize, 10);
            assert.strictEqual(options.serverSelectionTimeoutMS, 15000);
        });

        it("handles padded whitespace around numbers", () => {
            const options = getMongoConnectionOptions({
                MONGO_MAX_POOL_SIZE: " 30 ",
                MONGO_MIN_POOL_SIZE: " 5 ",
                MONGO_SERVER_SELECTION_TIMEOUT_MS: " 20000 ",
            });
            assert.strictEqual(options.maxPoolSize, 30);
            assert.strictEqual(options.minPoolSize, 5);
            assert.strictEqual(options.serverSelectionTimeoutMS, 20000);
        });

        it("allows minPoolSize to equal maxPoolSize (fixed-size pool)", () => {
            const options = getMongoConnectionOptions({
                MONGO_MAX_POOL_SIZE: "20",
                MONGO_MIN_POOL_SIZE: "20",
            });
            assert.strictEqual(options.maxPoolSize, 20);
            assert.strictEqual(options.minPoolSize, 20);
        });
    });

    describe("3. Rejection of Invalid Configuration Values", () => {
        it("rejects maxPoolSize = 0 (pool must allow at least 1 connection)", () => {
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_MAX_POOL_SIZE: "0" }),
                /MONGO_MAX_POOL_SIZE must be at least 1/
            );
        });

        it("rejects negative maxPoolSize", () => {
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_MAX_POOL_SIZE: "-10" }),
                /MONGO_MAX_POOL_SIZE must be at least 1/
            );
        });

        it("rejects floating-point numbers", () => {
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_MAX_POOL_SIZE: "25.5" }),
                /MONGO_MAX_POOL_SIZE must be an integer/
            );
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_MIN_POOL_SIZE: "2.1" }),
                /MONGO_MIN_POOL_SIZE must be an integer/
            );
        });

        it("rejects non-numeric alphanumeric values", () => {
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_MAX_POOL_SIZE: "25connections" }),
                /MONGO_MAX_POOL_SIZE must be an integer/
            );
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_SERVER_SELECTION_TIMEOUT_MS: "fast" }),
                /MONGO_SERVER_SELECTION_TIMEOUT_MS must be an integer/
            );
        });

        it("rejects negative minPoolSize", () => {
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_MIN_POOL_SIZE: "-1" }),
                /MONGO_MIN_POOL_SIZE must be at least 0/
            );
        });

        it("rejects serverSelectionTimeoutMS <= 0", () => {
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_SERVER_SELECTION_TIMEOUT_MS: "0" }),
                /MONGO_SERVER_SELECTION_TIMEOUT_MS must be at least 1/
            );
            assert.throws(
                () => getMongoConnectionOptions({ MONGO_SERVER_SELECTION_TIMEOUT_MS: "-5000" }),
                /MONGO_SERVER_SELECTION_TIMEOUT_MS must be at least 1/
            );
        });
    });

    describe("4. Cross-Field Boundary Validation", () => {
        it("rejects when minPoolSize exceeds maxPoolSize", () => {
            assert.throws(
                () =>
                    getMongoConnectionOptions({
                        MONGO_MAX_POOL_SIZE: "15",
                        MONGO_MIN_POOL_SIZE: "20",
                    }),
                /MONGO_MIN_POOL_SIZE \(20\) cannot exceed MONGO_MAX_POOL_SIZE \(15\)/
            );
        });
    });

    describe("5. Secret Sanitization in Configuration Errors", () => {
        it("configuration error messages do not disclose credentials or URI information", () => {
            try {
                getMongoConnectionOptions({
                    MONGO_URI: "mongodb+srv://adminUser:SecretPassword123@cluster0.abc.mongodb.net/prod_db",
                    MONGO_MAX_POOL_SIZE: "invalid_value",
                });
                assert.fail("Should have thrown");
            } catch (err) {
                assert.ok(!err.message.includes("adminUser"));
                assert.ok(!err.message.includes("SecretPassword123"));
                assert.ok(!err.message.includes("mongodb+srv"));
                assert.ok(err.message.includes("MONGO_MAX_POOL_SIZE must be an integer"));
            }
        });
    });

    describe("6. Integration With Server Startup & mongoose.connect", () => {
        const originalEnv = { ...process.env };
        const originalConnect = mongoose.connect;
        const originalExit = process.exit;
        const originalConsoleError = console.error;
        let capturedErrors = [];

        beforeEach(() => {
            process.env = { ...originalEnv };
            capturedErrors = [];
            console.error = (...args) => capturedErrors.push(args.join(" "));
            _resetShutdownForTesting();
        });

        afterEach(async () => {
            process.env = { ...originalEnv };
            mongoose.connect = originalConnect;
            process.exit = originalExit;
            console.error = originalConsoleError;
            _resetShutdownForTesting();
            if (server.listening) {
                await new Promise((resolve) => server.close(resolve));
            }
        });

        it("passes validated connection options to mongoose.connect during server start", async () => {
            process.env.MONGO_URI = "mongodb://127.0.0.1:27017/test_db";
            process.env.MONGO_MAX_POOL_SIZE = "35";
            process.env.MONGO_MIN_POOL_SIZE = "5";
            process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "25000";

            let passedUri = null;
            let passedOptions = null;

            mongoose.connect = async (uri, options) => {
                passedUri = uri;
                passedOptions = options;
                return {
                    connection: { host: "127.0.0.1" },
                };
            };

            const origListen = server.listen;
            server.listen = (port, cb) => {
                if (cb) cb();
                return server;
            };

            try {
                await start({ exitOnError: false });
            } finally {
                server.listen = origListen;
            }

            assert.strictEqual(passedUri, "mongodb://127.0.0.1:27017/test_db");
            assert.deepStrictEqual(passedOptions, {
                maxPoolSize: 35,
                minPoolSize: 5,
                serverSelectionTimeoutMS: 25000,
            });
        });

        it("fails startup and does not call mongoose.connect if pool configuration is invalid", async () => {
            process.env.MONGO_URI = "mongodb://127.0.0.1:27017/test_db";
            process.env.MONGO_MAX_POOL_SIZE = "invalid_number";

            let connectCalled = false;
            mongoose.connect = async () => {
                connectCalled = true;
                return { connection: { host: "127.0.0.1" } };
            };

            let exitCalled = false;
            let exitCode = null;
            process.exit = (code) => {
                exitCalled = true;
                exitCode = code;
            };

            await assert.rejects(
                async () => {
                    await start({ exitOnError: true });
                },
                /MONGO_MAX_POOL_SIZE must be an integer/
            );

            assert.strictEqual(connectCalled, false, "mongoose.connect must NOT be called on invalid pool config");
            assert.strictEqual(exitCalled, true, "process.exit(1) must be called on fatal startup configuration error");
            assert.strictEqual(exitCode, 1);
            assert.ok(capturedErrors.some((e) => e.includes("Fatal Startup Configuration Error")));
        });
    });
});

