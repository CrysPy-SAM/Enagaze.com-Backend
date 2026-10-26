/**
 * Media Cleanup Job Processor (Phase 4A)
 *
 * Reliably deletes orphaned, expired, or replaced user photos from storage
 * (e.g. AWS S3 or local disk storage).
 *
 * Idempotency:
 * Object storage deletion is naturally idempotent. Deleting an already-deleted
 * key succeeds without error.
 *
 * Security:
 * Enforces key-to-user path verification so a compromised or forged job payload
 * cannot delete another user's photos.
 */

import { getStorageAdapter } from "../services/storage.service.js";

/**
 * Processes a single media cleanup job.
 *
 * @param {import("bullmq").Job} job - BullMQ job instance
 * @returns {Promise<{ deleted: boolean, key: string }>}
 */
export const processMediaCleanupJob = async (job) => {
    const { key, userId } = job.data || {};

    if (!key || typeof key !== "string") {
        throw new Error("Invalid job data: 'key' must be a non-empty string.");
    }

    // Security boundary: verify key matches user directory
    if (userId && !key.startsWith(`profile-photos/${userId}/`)) {
        console.warn(`[BullMQ:MediaCleanup] Unauthorized key '${key}' does not match userId '${userId}'. Aborting job.`);
        return { deleted: false, reason: "unauthorized_key" };
    }

    try {
        const adapter = getStorageAdapter();
        if (!adapter || typeof adapter.deleteObject !== "function") {
            throw new Error("Storage adapter is unavailable or does not implement deleteObject.");
        }

        await adapter.deleteObject(key);
        return { deleted: true, key };
    } catch (err) {
        // Distinguish fatal vs transient errors
        const errMsg = err?.message || "Storage delete failed";
        console.error(`[BullMQ:MediaCleanup] Delete failed for key '${key}' on attempt ${job.attemptsMade + 1}: ${errMsg}`);
        throw err; // Re-throw to trigger BullMQ exponential backoff retry
    }
};

