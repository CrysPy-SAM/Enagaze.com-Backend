import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { getMongoConnectionOptions } from "../src/config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

/**
 * Approved Candidate Indexes for Phase 2D.1
 * Each index is strictly additive, supported by actual query patterns,
 * and carries a stable, explicit name.
 */
export const APPROVED_INDEXES = [
    {
        collection: "users",
        modelName: "User",
        spec: { email: 1 },
        options: {
            name: "email_1_sparse",
            sparse: true,
            background: true,
        },
        description: "Sparse equality index supporting Google OAuth account linking and lookups without collection scans",
        supportedQuery: "User.findOne({ email }) in src/controllers/user.controller.js",
    },
    {
        collection: "swipes",
        modelName: "Swipe",
        spec: { toUser: 1, action: 1, createdAt: -1, _id: -1 },
        options: {
            name: "toUser_1_action_1_createdAt_-1__id_-1",
            background: true,
        },
        description: "Compound equality and deterministic reverse-chronological sort index supporting incoming likes feeds without in-memory sorting",
        supportedQuery: "Swipe.find({ toUser, action: 'like' }).sort({ createdAt: -1, _id: -1 }) in src/controllers/discovery.controller.js",
    },
    {
        collection: "notifications",
        modelName: "Notification",
        spec: { recipient: 1, read: 1, createdAt: -1 },
        options: {
            name: "recipient_1_read_1_createdAt_-1",
            background: true,
        },
        description: "Compound index covering unread notifications and paginated feed retrieval",
        supportedQuery: "Notification.find({ recipient, read }).sort({ createdAt: -1 }) in src/controllers/notification.controller.js",
    },
];

/**
 * Username System Indexes (Phase 2D.2)
 * Managed cleanly alongside backfillUsernames.js
 */
export const USERNAME_INDEXES = [
    {
        collection: "users",
        modelName: "User",
        spec: { normalizedUsername: 1 },
        options: {
            name: "normalizedUsername_1_unique",
            unique: true,
            sparse: true,
            background: true,
        },
        description: "Unique index on normalized (lowercase) username for case-insensitive uniqueness and fast lookups",
        supportedQuery: "User.findOne({ normalizedUsername }) in src/controllers/user.controller.js",
    },
];

/**
 * Executes or previews additive index migrations.
 *
 * @param {Object} [options]
 * @param {boolean} [options.execute=false] - Whether to apply indexes (true) or preview (false)
 * @param {string} [options.mongoUri] - Database connection string
 * @param {Object} [options.dbClient] - Optional injected db client / connection for testing
 * @param {Object} [options.logger=console] - Logger interface
 * @returns {Promise<{ success: boolean, mode: string, results: Array<Object>, error?: string }>}
 */
export async function runIndexMigration({
    execute = false,
    mongoUri = process.env.MONGO_URI,
    dbClient = null,
    logger = console,
} = {}) {
    const mode = execute ? "EXECUTE" : "DRY-RUN";

    logger.log("================================================================================");
    logger.log(`  ENGAZE MONGODB ADDITIVE INDEX MIGRATION [${mode}]`);
    logger.log("================================================================================");
    logger.log(`Target Indexes Planned: ${APPROVED_INDEXES.length}`);

    // Dry-run mode: Return preview metadata without database connection
    if (!execute) {
        logger.log("\n[DRY-RUN PREVIEW] No database connection opened. No changes will be applied.\n");

        const previewResults = APPROVED_INDEXES.map((idx, index) => {
            logger.log(`  ${index + 1}. Collection: '${idx.collection}'`);
            logger.log(`     Index Name: '${idx.options.name}'`);
            logger.log(`     Key Spec:   ${JSON.stringify(idx.spec)}`);
            logger.log(`     Options:    ${JSON.stringify(idx.options)}`);
            logger.log(`     Supported:  ${idx.supportedQuery}`);
            logger.log(`     Purpose:    ${idx.description}\n`);

            return {
                collection: idx.collection,
                indexName: idx.options.name,
                spec: idx.spec,
                options: idx.options,
                status: "PREVIEW_OK",
            };
        });

        logger.log("================================================================================");
        logger.log("  DRY-RUN COMPLETE: 3 approved indexes ready for controlled deployment.");
        logger.log("  To apply to a target environment, invoke with --execute or INDEX_MIGRATION_EXECUTE=true.");
        logger.log("================================================================================");

        return {
            success: true,
            mode: "DRY-RUN",
            results: previewResults,
        };
    }

    // Execute mode: Requires explicit opt-in confirmation and MONGO_URI
    if (!mongoUri || !mongoUri.trim()) {
        const errorMsg = "Migration halted: MONGO_URI environment variable is required to execute index migrations.";
        logger.error(`❌ ${errorMsg}`);
        return {
            success: false,
            mode: "EXECUTE",
            results: [],
            error: errorMsg,
        };
    }

    let connectionToClose = null;
    const results = [];

    try {
        let db;
        if (dbClient && dbClient.collection) {
            // Injected db client (for mocks and unit testing)
            db = dbClient;
        } else {
            logger.log("Connecting to MongoDB database...");
            const mongoOptions = getMongoConnectionOptions();
            const mongooseConn = await mongoose.connect(mongoUri, mongoOptions);
            connectionToClose = mongooseConn;
            db = mongooseConn.connection.db;
            logger.log("Connected successfully. Verifying and creating approved indexes...");
        }

        for (const idx of APPROVED_INDEXES) {
            const collection = db.collection(idx.collection);
            logger.log(`\nProcessing collection '${idx.collection}' -> index '${idx.options.name}'...`);

            // Fetch existing indexes to ensure idempotency
            let existingIndexes = [];
            try {
                existingIndexes = await collection.indexes();
            } catch (listErr) {
                logger.warn(`Could not list indexes on collection '${idx.collection}' (${listErr.message}). Attempting createIndex...`);
            }

            const existingByName = existingIndexes.find((i) => i.name === idx.options.name);
            if (existingByName) {
                logger.log(`  ℹ️ Index '${idx.options.name}' already exists. Skipping (idempotent).`);
                results.push({
                    collection: idx.collection,
                    indexName: idx.options.name,
                    status: "ALREADY_EXISTS",
                });
                continue;
            }

            // Pre-flight check: ensure no duplicate values exist before attempting unique index build
            if (idx.options.unique) {
                const keyField = Object.keys(idx.spec)[0];
                if (typeof collection.aggregate === "function") {
                    try {
                        const duplicates = await collection.aggregate([
                            { $match: { [keyField]: { $ne: null, $exists: true } } },
                            { $group: { _id: `$${keyField}`, count: { $sum: 1 } } },
                            { $match: { count: { $gt: 1 } } },
                            { $limit: 5 }
                        ]).toArray();

                        if (duplicates && duplicates.length > 0) {
                            const sample = duplicates.map((d) => `"${d._id}" (${d.count}x)`).join(", ");
                            const msg = `Cannot create unique index '${idx.options.name}': found duplicate values for field '${keyField}': [${sample}].`;
                            logger.error(`  ❌ ${msg}`);
                            results.push({
                                collection: idx.collection,
                                indexName: idx.options.name,
                                status: "DUPLICATES_DETECTED",
                                error: msg,
                            });
                            continue;
                        }
                    } catch (aggErr) {
                        logger.warn(`  ⚠️ Pre-flight aggregation skipped (${aggErr.message}).`);
                    }
                }
            }

            // Create index additively
            const createdIndexName = await collection.createIndex(idx.spec, idx.options);
            logger.log(`  ✅ Successfully created index '${createdIndexName}' on '${idx.collection}'.`);
            results.push({
                collection: idx.collection,
                indexName: createdIndexName,
                status: "CREATED",
            });
        }

        logger.log("\n================================================================================");
        logger.log(`  MIGRATION COMPLETE: ${results.length} indexes processed successfully.`);
        logger.log("================================================================================");

        return {
            success: true,
            mode: "EXECUTE",
            results,
        };
    } catch (err) {
        const safeError = err?.message ? err.message : "Unknown database error";
        logger.error(`❌ Index migration failed: ${safeError}`);
        return {
            success: false,
            mode: "EXECUTE",
            results,
            error: safeError,
        };
    } finally {
        if (connectionToClose) {
            try {
                await connectionToClose.disconnect();
                logger.log("MongoDB connection closed cleanly.");
            } catch (_) {}
        }
    }
}

// CLI Execution Entry Point
const isMainModule = Boolean(
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMainModule) {
    const args = process.argv.slice(2);
    const hasExecuteFlag = args.includes("--execute") || args.includes("--apply");
    const hasExecuteEnv = process.env.INDEX_MIGRATION_EXECUTE === "true" || process.env.APPLY_INDEX_MIGRATION === "true";
    const execute = hasExecuteFlag || hasExecuteEnv;

    runIndexMigration({ execute })
        .then((result) => {
            process.exit(result.success ? 0 : 1);
        })
        .catch((err) => {
            console.error("Fatal migration runner error:", err.message);
            process.exit(1);
        });
}

