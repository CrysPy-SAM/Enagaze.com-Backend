/**
 * Username Validation and Suggestion Utilities
 * 
 * Enforces Engaze username policy:
 * - Length: 3 to 20 characters
 * - Characters: alphanumeric (a-z, A-Z, 0-9), underscores (_), periods (.), hyphens (-)
 * - Must contain at least one alphanumeric character
 * - Cannot start or end with a period, underscore, or hyphen
 * - Cannot contain consecutive periods (..)
 * - Case-insensitive uniqueness
 * - Rejects reserved system usernames
 */

export const RESERVED_USERNAMES = new Set([
    "admin",
    "administrator",
    "mod",
    "moderator",
    "engaze",
    "engaze_official",
    "support",
    "help",
    "official",
    "system",
    "root",
    "staff",
    "security",
    "privacy",
    "terms",
    "safety",
    "api",
    "auth",
    "login",
    "signup",
    "register",
    "discovery",
    "matches",
    "chat",
    "random-video",
    "random-call",
    "profile",
    "settings",
    "explore",
    "search",
    "null",
    "undefined",
    "me",
    "everyone",
    "superuser",
    "test",
    "demo",
]);

/**
 * Normalizes a raw username string for consistent comparison and storage.
 * 
 * @param {string} username 
 * @returns {string} Lowercased and trimmed username
 */
export function normalizeUsername(username) {
    if (!username || typeof username !== "string") return "";
    return username.trim().toLowerCase();
}

/**
 * Validates a username against length, character, format, and reservation rules.
 * 
 * @param {string} rawUsername 
 * @returns {{ valid: boolean, error?: string, normalized?: string }}
 */
export function validateUsername(rawUsername) {
    if (!rawUsername || typeof rawUsername !== "string") {
        return { valid: false, error: "Username is required." };
    }

    const trimmed = rawUsername.trim();
    const normalized = trimmed.toLowerCase();

    if (trimmed.length < 3) {
        return { valid: false, error: "Username must be at least 3 characters long." };
    }

    if (trimmed.length > 20) {
        return { valid: false, error: "Username cannot exceed 20 characters." };
    }

    // Must only contain letters, numbers, underscores, dots, and hyphens
    const allowedCharsRegex = /^[a-zA-Z0-9_.-]+$/;
    if (!allowedCharsRegex.test(trimmed)) {
        return {
            valid: false,
            error: "Username can only contain letters, numbers, underscores (_), dots (.), and hyphens (-)."
        };
    }

    // Must contain at least one alphanumeric character
    if (!/[a-zA-Z0-9]/.test(trimmed)) {
        return { valid: false, error: "Username must contain at least one letter or number." };
    }

    // Cannot start or end with special characters (. _ -)
    if (/^[._-]/.test(trimmed) || /[._-]$/.test(trimmed)) {
        return { valid: false, error: "Username cannot start or end with a dot, underscore, or hyphen." };
    }

    // Cannot contain consecutive dots
    if (/\.{2,}/.test(trimmed)) {
        return { valid: false, error: "Username cannot contain consecutive dots." };
    }

    // Check reserved list
    if (RESERVED_USERNAMES.has(normalized)) {
        return { valid: false, error: "This username is reserved and cannot be claimed." };
    }

    return { valid: true, normalized, trimmed };
}

/**
 * Generates alternative suggestions for an unavailable username.
 * 
 * @param {string} baseUsername - Raw candidate requested by user
 * @param {Function} isAvailableFn - Async function returning boolean if candidate is free
 * @param {number} [maxSuggestions=4] - Target count of suggestions
 * @returns {Promise<string[]>}
 */
export async function generateUsernameSuggestions(baseUsername, isAvailableFn, maxSuggestions = 4) {
    const clean = normalizeUsername(baseUsername)
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 14);

    const base = clean.length >= 3 ? clean : "user";
    const candidates = [
        `${base}_official`,
        `${base}.${Math.floor(10 + Math.random() * 89)}`,
        `${base}_${Math.floor(100 + Math.random() * 899)}`,
        `the_${base}`,
        `real_${base}`,
        `${base}_vibe`,
        `${base}_date`,
        `${base}${Math.floor(10 + Math.random() * 89)}`,
    ];

    const results = [];
    for (const candidate of candidates) {
        if (results.length >= maxSuggestions) break;
        const validation = validateUsername(candidate);
        if (!validation.valid) continue;

        try {
            const available = await isAvailableFn(validation.normalized);
            if (available && !results.includes(candidate)) {
                results.push(candidate);
            }
        } catch (_) {
            // Ignore individual candidate check errors
        }
    }

    return results;
}

