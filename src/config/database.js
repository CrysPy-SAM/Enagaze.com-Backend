/**
 * Centralized MongoDB Connection Pool & Client Configuration
 * Provides validated, configurable connection settings for scalable deployments.
 */

export const DEFAULT_MAX_POOL_SIZE = 25;
export const DEFAULT_MIN_POOL_SIZE = 0;
export const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 30000;

/**
 * Safely parses and validates an integer configuration option from environment variables.
 *
 * @param {any} rawVal - Raw value from process.env
 * @param {string} fieldName - Environment variable name for error reporting
 * @param {Object} options
 * @param {number} options.min - Minimum allowed value (inclusive)
 * @param {number} options.defaultValue - Fallback value if unset or empty
 * @returns {number}
 */
export function parseIntegerOption(rawVal, fieldName, { min = 0, defaultValue } = {}) {
    if (rawVal === undefined || rawVal === null || String(rawVal).trim() === "") {
        return defaultValue;
    }

    const str = String(rawVal).trim();

    // Reject non-integer strings (floats, scientific notation, alphanumeric suffix)
    if (!/^-?\d+$/.test(str)) {
        throw new Error(
            `Invalid MongoDB connection configuration: ${fieldName} must be an integer, received '${rawVal}'.`
        );
    }

    const num = Number(str);
    if (!Number.isSafeInteger(num)) {
        throw new Error(
            `Invalid MongoDB connection configuration: ${fieldName} must be a safe integer, received '${rawVal}'.`
        );
    }

    if (num < min) {
        throw new Error(
            `Invalid MongoDB connection configuration: ${fieldName} must be at least ${min}, received ${num}.`
        );
    }

    return num;
}

/**
 * Resolves and validates MongoDB connection options from the provided environment.
 * Ensures minPoolSize does not exceed maxPoolSize and all values are within safe boundaries.
 *
 * @param {Object} [env=process.env]
 * @returns {{ maxPoolSize: number, minPoolSize: number, serverSelectionTimeoutMS: number }}
 */
export function getMongoConnectionOptions(env = process.env) {
    const maxPoolSize = parseIntegerOption(env.MONGO_MAX_POOL_SIZE, "MONGO_MAX_POOL_SIZE", {
        min: 1,
        defaultValue: DEFAULT_MAX_POOL_SIZE,
    });

    const minPoolSize = parseIntegerOption(env.MONGO_MIN_POOL_SIZE, "MONGO_MIN_POOL_SIZE", {
        min: 0,
        defaultValue: DEFAULT_MIN_POOL_SIZE,
    });

    const serverSelectionTimeoutMS = parseIntegerOption(
        env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        "MONGO_SERVER_SELECTION_TIMEOUT_MS",
        {
            min: 1,
            defaultValue: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
        }
    );

    if (minPoolSize > maxPoolSize) {
        throw new Error(
            `Invalid MongoDB connection configuration: MONGO_MIN_POOL_SIZE (${minPoolSize}) cannot exceed MONGO_MAX_POOL_SIZE (${maxPoolSize}).`
        );
    }

    return {
        maxPoolSize,
        minPoolSize,
        serverSelectionTimeoutMS,
    };
}

