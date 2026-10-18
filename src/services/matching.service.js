import mongoose from "mongoose";
import { Match } from "../models/match.model.js";
import { Conversation } from "../models/conversation.model.js";

/**
 * Idempotently find or create a canonical Match and Conversation for two users.
 * 
 * Invariants:
 * - Deterministic user ordering guarantees single canonical Match per user pair.
 * - Handles race conditions via duplicate-key (E11000) recovery on both Match (userPair) and Conversation (match).
 * - Flags `isNewMatch: true` strictly for the initial creator thread to prevent duplicate notifications.
 *
 * @param {string|mongoose.Types.ObjectId} userId1
 * @param {string|mongoose.Types.ObjectId} userId2
 * @returns {Promise<{ match: Object, conversation: Object, isNewMatch: boolean }>}
 */
export async function findOrCreateCanonicalMatchAndConversation(userId1, userId2) {
    if (!userId1 || !userId2) {
        throw new Error("Both user IDs are required to create a match");
    }

    const id1 = userId1.toString();
    const id2 = userId2.toString();

    if (id1 === id2) {
        throw new Error("Cannot match a user with themselves");
    }

    const userPair = Match.getCanonicalPair(userId1, userId2);
    const canonicalUsers = id1 < id2 ? [userId1, userId2] : [userId2, userId1];

    let match = null;
    let isNewMatch = false;

    // 1. Look for existing match first
    match = await Match.findOne({ userPair });

    if (!match) {
        try {
            match = await Match.create({
                users: canonicalUsers,
                userPair,
                status: "active",
            });
            isNewMatch = true;
        } catch (err) {
            if (err.code === 11000) {
                // Duplicate key: Another thread created this match concurrently
                match = await Match.findOne({ userPair });
                if (!match) {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    }

    // 2. Ensure canonical conversation exists for this match
    let conversation = await Conversation.findOne({ match: match._id });

    if (!conversation) {
        try {
            conversation = await Conversation.create({
                match: match._id,
                participants: match.users,
                lastMessageAt: match.createdAt || new Date(),
            });
        } catch (err) {
            if (err.code === 11000) {
                // Duplicate key: Another thread created conversation concurrently
                conversation = await Conversation.findOne({ match: match._id });
                if (!conversation) {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    }

    return { match, conversation, isNewMatch };
}

