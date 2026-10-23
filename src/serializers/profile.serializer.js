/**
 * Central Allowlist Serializers for Public and Peer Profiles
 * 
 * Enforces strict allowlisting of fields returned to external clients.
 * Never includes login identifiers (username), exact dates of birth, emails,
 * Google IDs, hashed passwords, auth tokens, or private preferences.
 */

import { calculateExactAge } from "../services/eligibility.service.js";

/**
 * Calculates integer age from a Date of Birth string or Date object.
 * Returns null if dob is missing, null, or invalid.
 *
 * @param {Date|string|null|undefined} dob 
 * @returns {number|null}
 */
export const calculateAge = (dob) => {
    return calculateExactAge(dob);
};

/**
 * Serializes a user record for public/peer viewing (discovery deck, matches,
 * conversation headers, random video partners, and socket notifications).
 * 
 * ALLOWLIST ONLY:
 * - _id: String
 * - name: String
 * - age: Number | null (calculated from DOB; exact DOB is never returned)
 * - gender: String | null
 * - bio: String
 * - photos: Array<String>
 * - interests: Array<String>
 * - isProfileComplete: Boolean
 * - isOnline: Boolean (optional, when presence is evaluated)
 * - lastSeenAt: Date | null (optional, when presence is evaluated)
 * 
 * FORBIDDEN (NEVER RETURNED):
 * - username (login identifier)
 * - dob (exact date of birth)
 * - email
 * - googleId
 * - password
 * - token
 * - datingPreferences
 * - authProvider
 * - privacySettings (internal privacy configuration)
 * 
 * @param {Object|null|undefined} user - Mongoose document or plain object
 * @param {Object|null} [presence=null] - Pre-evaluated presence info { isOnline, lastSeenAt }
 * @returns {Object|null}
 */
export const toPublicProfile = (user, presence = null) => {
    if (!user) return null;

    const doc = typeof user.toObject === "function"
        ? user.toObject({ virtuals: true })
        : (typeof user.toJSON === "function" ? user.toJSON() : user);

    const age = typeof doc.age === "number" && !isNaN(doc.age)
        ? doc.age
        : calculateAge(doc.dob);

    const result = {
        _id: doc._id ? doc._id.toString() : undefined,
        name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : "Engaze Member",
        age,
        gender: typeof doc.gender === "string" ? doc.gender : null,
        bio: typeof doc.bio === "string" ? doc.bio : "",
        photos: Array.isArray(doc.photos) ? doc.photos : [],
        interests: Array.isArray(doc.interests) ? doc.interests : [],
        isProfileComplete: Boolean(doc.isProfileComplete),
    };

    if (presence && typeof presence === "object") {
        result.isOnline = Boolean(presence.isOnline);
        result.lastSeenAt = presence.lastSeenAt || null;
    }

    return result;
};

/**
 * Serializes a user record for message sender preview in chat payloads.
 * 
 * @param {Object|null|undefined} sender - Mongoose document or plain object
 * @returns {Object|null}
 */
export const toSenderProfile = (sender) => {
    if (!sender) return null;

    // Handle plain string ID
    if (typeof sender === "string") {
        return {
            _id: sender.trim(),
            name: "Engaze Member",
            photos: [],
        };
    }

    // Handle MongoDB ObjectId directly
    if (sender._bsontype === "ObjectID" || (typeof sender.toHexString === "function")) {
        return {
            _id: sender.toString(),
            name: "Engaze Member",
            photos: [],
        };
    }

    const doc = typeof sender.toObject === "function"
        ? sender.toObject()
        : (typeof sender.toJSON === "function" ? sender.toJSON() : sender);

    // Extract ID safely from _id, id, or doc itself if doc is an ID string/object
    let senderId;
    if (doc._id) {
        senderId = doc._id.toString();
    } else if (doc.id) {
        senderId = doc.id.toString();
    } else if (typeof doc.toString === "function" && doc.toString() !== "[object Object]") {
        senderId = doc.toString().trim();
    }

    return {
        _id: senderId,
        name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : "Engaze Member",
        photos: Array.isArray(doc.photos) ? doc.photos : [],
    };
};

/**
 * Serializes a message document ensuring sender profile is sanitized.
 * 
 * @param {Object|null|undefined} message - Mongoose document or plain object
 * @returns {Object|null}
 */
export const toMessageDto = (message) => {
    if (!message) return null;

    const doc = typeof message.toObject === "function"
        ? message.toObject()
        : (typeof message.toJSON === "function" ? message.toJSON() : message);

    return {
        _id: doc._id ? doc._id.toString() : undefined,
        conversation: doc.conversation ? doc.conversation.toString() : undefined,
        sender: toSenderProfile(doc.sender),
        content: doc.content || "",
        clientTempId: doc.clientTempId || undefined,
        readBy: Array.isArray(doc.readBy) ? doc.readBy.map((id) => id?.toString() || id) : [],
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};

/**
 * Serializes a user record for Instagram-inspired search and people discovery.
 * Includes public username, display name, public bio, photos, age, interests,
 * and current relationship context with the requesting user.
 *
 * Strict allowlist guarantees that sensitive internal fields (passwords, emails,
 * phone numbers, exact DOBs, tokens, Google IDs, or dating preferences) are NEVER leaked.
 *
 * @param {Object|null|undefined} user - Mongoose document or plain object
 * @param {Object} [relationship={}] - Relationship context { status, requestId, conversationId }
 * @returns {Object|null}
 */
export const toSearchUserProfile = (user, relationship = {}) => {
    if (!user) return null;

    const doc = typeof user.toObject === "function"
        ? user.toObject({ virtuals: true })
        : (typeof user.toJSON === "function" ? user.toJSON() : user);

    const age = typeof doc.age === "number" && !isNaN(doc.age)
        ? doc.age
        : calculateAge(doc.dob);

    return {
        _id: doc._id ? doc._id.toString() : undefined,
        name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : "Engaze Member",
        username: typeof doc.username === "string" ? doc.username.trim() : "",
        age,
        gender: typeof doc.gender === "string" ? doc.gender : null,
        bio: typeof doc.bio === "string" ? doc.bio : "",
        photos: Array.isArray(doc.photos) ? doc.photos : [],
        interests: Array.isArray(doc.interests) ? doc.interests : [],
        isProfileComplete: Boolean(doc.isProfileComplete),
        relationship: relationship.status || "none",
        requestId: relationship.requestId ? relationship.requestId.toString() : null,
        conversationId: relationship.conversationId ? relationship.conversationId.toString() : null,
    };
};
