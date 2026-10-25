import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runIndexMigration, APPROVED_INDEXES } from "../scripts/migrateIndexes.js";

describe("Phase 2D.1: Additive Index Migration Specification & Safety Suite", () => {
    describe("1. Approved Candidate Index Specifications", () => {
        it("defines exactly 3 approved candidate indexes", () => {
            assert.strictEqual(APPROVED_INDEXES.length, 3);
        });

        it("Candidate A (User.email): defines sparse, non-unique index with stable name", () => {
            const emailIdx = APPROVED_INDEXES.find((i) => i.collection === "users");
            assert.ok(emailIdx, "Candidate A (User) must be defined");
            assert.deepStrictEqual(emailIdx.spec, { email: 1 });
            assert.strictEqual(emailIdx.options.name, "email_1_sparse");
            assert.strictEqual(emailIdx.options.sparse, true);
            assert.strictEqual(emailIdx.options.background, true);
            assert.strictEqual(emailIdx.options.unique, undefined, "Strict safety: unique: true must NOT be defined in Phase 2D.1");
        });

        it("Candidate B (Swipe.likes): defines compound equality and deterministic reverse-chronological sort index", () => {
            const swipeIdx = APPROVED_INDEXES.find((i) => i.collection === "swipes");
            assert.ok(swipeIdx, "Candidate B (Swipe) must be defined");
            assert.deepStrictEqual(swipeIdx.spec, { toUser: 1, action: 1, createdAt: -1, _id: -1 });
            assert.strictEqual(swipeIdx.options.name, "toUser_1_action_1_createdAt_-1__id_-1");
            assert.strictEqual(swipeIdx.options.background, true);
            assert.strictEqual(swipeIdx.options.unique, undefined);
        });

        it("Candidate C (Notification.unread): defines compound equality and reverse-chronological sort index", () => {
            const notifIdx = APPROVED_INDEXES.find((i) => i.collection === "notifications");
            assert.ok(notifIdx, "Candidate C (Notification) must be defined");
            assert.deepStrictEqual(notifIdx.spec, { recipient: 1, read: 1, createdAt: -1 });
            assert.strictEqual(notifIdx.options.name, "recipient_1_read_1_createdAt_-1");
            assert.strictEqual(notifIdx.options.background, true);
            assert.strictEqual(notifIdx.options.unique, undefined);
        });
    });

    describe("2. Dry-Run Mode & Safeguards", () => {
        it("defaults to dry-run mode without database connection or mutations", async () => {
            const logs = [];
            const mockLogger = {
                log: (msg) => logs.push(String(msg)),
                warn: (msg) => logs.push(String(msg)),
                error: (msg) => logs.push(String(msg)),
            };

            const result = await runIndexMigration({ execute: false, logger: mockLogger });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.mode, "DRY-RUN");
            assert.strictEqual(result.results.length, 3);
            assert.ok(result.results.every((r) => r.status === "PREVIEW_OK"));

            const combinedLogs = logs.join("\n");
            assert.ok(combinedLogs.includes("[DRY-RUN PREVIEW]"));
            assert.ok(combinedLogs.includes("No changes will be applied"));
            assert.ok(!combinedLogs.includes("Connecting to MongoDB"));
        });

        it("refuses to execute if execute is true but MONGO_URI is missing", async () => {
            const errors = [];
            const mockLogger = {
                log: () => {},
                warn: () => {},
                error: (msg) => errors.push(String(msg)),
            };

            const result = await runIndexMigration({
                execute: true,
                mongoUri: "",
                logger: mockLogger,
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.mode, "EXECUTE");
            assert.ok(result.error.includes("MONGO_URI"));
            assert.ok(errors.some((e) => e.includes("MONGO_URI environment variable is required")));
        });

        it("never leaks secret connection strings or credentials in error logs", async () => {
            const logs = [];
            const mockLogger = {
                log: (msg) => logs.push(String(msg)),
                warn: (msg) => logs.push(String(msg)),
                error: (msg) => logs.push(String(msg)),
            };

            const sensitiveUri = "mongodb+srv://adminUser:SuperSecretPassword123@cluster0.abcde.mongodb.net/engaze_prod";

            // Pass mock client that simulates failure during execution
            const mockDbClient = {
                collection: () => {
                    throw new Error("Simulated network timeout");
                },
            };

            const result = await runIndexMigration({
                execute: true,
                mongoUri: sensitiveUri,
                dbClient: mockDbClient,
                logger: mockLogger,
            });

            assert.strictEqual(result.success, false);
            const allLoggedOutput = logs.join(" ");
            assert.ok(!allLoggedOutput.includes("SuperSecretPassword123"), "Passwords must never appear in logs");
            assert.ok(!allLoggedOutput.includes("adminUser"), "Usernames must never appear in logs");
        });
    });

    describe("3. Additive Execution & Idempotency", () => {
        it("strictly uses additive createIndex and never drops or modifies existing indexes", async () => {
            const created = [];
            const dropped = [];

            const createMockCollection = (name) => ({
                indexes: async () => [],
                createIndex: async (spec, options) => {
                    created.push({ collection: name, spec, options });
                    return options.name;
                },
                dropIndex: async () => {
                    dropped.push(name);
                },
                dropIndexes: async () => {
                    dropped.push(name);
                },
            });

            const mockDb = {
                collection: (name) => createMockCollection(name),
            };

            const mockLogger = {
                log: () => {},
                warn: () => {},
                error: () => {},
            };

            const result = await runIndexMigration({
                execute: true,
                mongoUri: "mock://localhost:27017/test",
                dbClient: mockDb,
                logger: mockLogger,
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.mode, "EXECUTE");
            assert.strictEqual(result.results.length, 3);
            assert.ok(result.results.every((r) => r.status === "CREATED"));

            // Verify createIndex calls
            assert.strictEqual(created.length, 3);
            assert.strictEqual(dropped.length, 0, "Migration must NEVER drop indexes");

            assert.strictEqual(created[0].collection, "users");
            assert.deepStrictEqual(created[0].spec, { email: 1 });
            assert.strictEqual(created[0].options.name, "email_1_sparse");
            assert.strictEqual(created[0].options.sparse, true);

            assert.strictEqual(created[1].collection, "swipes");
            assert.deepStrictEqual(created[1].spec, { toUser: 1, action: 1, createdAt: -1, _id: -1 });

            assert.strictEqual(created[2].collection, "notifications");
            assert.deepStrictEqual(created[2].spec, { recipient: 1, read: 1, createdAt: -1 });
        });

        it("is idempotent: skips indexes that already exist without error", async () => {
            const created = [];

            const createMockCollection = (name) => ({
                indexes: async () => [
                    { name: "_id_", key: { _id: 1 } },
                    { name: "email_1_sparse", key: { email: 1 } }, // users already has this
                ],
                createIndex: async (spec, options) => {
                    created.push({ collection: name, spec, options });
                    return options.name;
                },
            });

            const mockDb = {
                collection: (name) => createMockCollection(name),
            };

            const mockLogger = {
                log: () => {},
                warn: () => {},
                error: () => {},
            };

            const result = await runIndexMigration({
                execute: true,
                mongoUri: "mock://localhost:27017/test",
                dbClient: mockDb,
                logger: mockLogger,
            });

            assert.strictEqual(result.success, true);

            const userResult = result.results.find((r) => r.collection === "users");
            assert.strictEqual(userResult.status, "ALREADY_EXISTS");

            const swipeResult = result.results.find((r) => r.collection === "swipes");
            assert.strictEqual(swipeResult.status, "CREATED");

            const notifResult = result.results.find((r) => r.collection === "notifications");
            assert.strictEqual(notifResult.status, "CREATED");

            // Only swipes and notifications had createIndex called
            assert.strictEqual(created.length, 2);
        });
    });
});

