import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";
import { getMongoConnectionOptions } from "../src/config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

/**
 * Migration & Backfill Strategy for Existing Users:
 * 1. Backfills `normalizedUsername` with lowercased, trimmed `username`.
 * 2. Backfills `usernameSetupCompleted: true` for existing accounts (so existing users are never locked into onboarding).
 * 3. Backfills `usernameLastChangedAt: null` (so existing users are not blocked by a 14-day cooldown on their first edit).
 */
export async function backfillLegacyUsers({ logger = console } = {}) {
    logger.log("🔍 Scanning for legacy users requiring username normalization and backfill...");

    const usersToUpdate = await User.find({
        $or: [
            { normalizedUsername: { $exists: false } },
            { normalizedUsername: null },
            { usernameSetupCompleted: { $exists: false } },
        ]
    }).select("_id username normalizedUsername usernameSetupCompleted usernameLastChangedAt");

    logger.log(`Found ${usersToUpdate.length} user records to backfill.`);

    let updatedCount = 0;
    for (const user of usersToUpdate) {
        let candidate = null;
        if (!user.normalizedUsername && user.username) {
            candidate = user.username.trim().toLowerCase();
            // Pre-flight collision check before saving normalized username
            const collision = await User.findOne({ normalizedUsername: candidate, _id: { $ne: user._id } }).select("_id").lean();
            if (collision) {
                candidate = `${candidate.slice(0, 14)}_${user._id.toString().slice(-4)}`;
                logger.warn(`⚠️ Normalized collision for user ${user._id} (${user.username}). Assigned resolved handle: ${candidate}`);
            }
            user.normalizedUsername = candidate;
        }
        const updateDoc = {};
        if (candidate) {
            updateDoc.normalizedUsername = candidate;
        }
        if (user.usernameSetupCompleted === undefined || user.usernameSetupCompleted === null) {
            updateDoc.usernameSetupCompleted = true;
        }
        if (user.usernameLastChangedAt === undefined) {
            updateDoc.usernameLastChangedAt = null;
        }

        if (Object.keys(updateDoc).length > 0) {
            await User.updateOne({ _id: user._id }, { $set: updateDoc });
            updatedCount++;
        }
    }

    logger.log(`✅ Backfill complete. Successfully updated ${updatedCount} user documents.`);
    return updatedCount;
}

// Direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error("MONGO_URI environment variable is missing.");
        process.exit(1);
    }

    mongoose.connect(mongoUri, getMongoConnectionOptions())
        .then(() => backfillLegacyUsers())
        .then(() => {
            console.log("Migration finished successfully.");
            process.exit(0);
        })
        .catch((err) => {
            console.error("Migration error:", err);
            process.exit(1);
        });
}

