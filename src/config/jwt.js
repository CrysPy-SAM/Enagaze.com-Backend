/**
 * Centralized JWT Configuration & Secret Validation
 * Ensures consistent signing, verification, and failsafe production startup.
 */

const DISALLOWED_PRODUCTION_SECRETS = new Set([
    "engaze_super_secret_jwt_key_2026_dev_secure",
    "engaze_local_dev_only_jwt_secret_never_use_in_production",
    "your_jwt_secret_key_change_in_production",
    "your_jwt_secret",
    "your_jwt_secret_here",
    "your_super_secret_jwt_key",
    "secret",
    "dev_secret",
    "development_secret",
    "change_me",
    "default_secret",
    "123456",
    "12345678",
    "password",
]);

// Deterministic dev-only secret so restarts during local testing don't invalidate tokens
const DEV_FALLBACK_SECRET = "engaze_local_dev_only_jwt_secret_never_use_in_production";

/**
 * Validates JWT configuration at server bootstrap or in test suites.
 * In production: terminates the process (or throws) if JWT_SECRET is missing, too short, or an insecure placeholder.
 * In development: logs a visible warning and permits local testing.
 *
 * @param {Object} options
 * @param {boolean} [options.exitOnError=true] - If true, calls process.exit(1) on failure.
 * @returns {boolean} - Returns true if validation passed.
 */
export const validateJwtConfig = ({ exitOnError = true } = {}) => {
    const isProduction = process.env.NODE_ENV === "production";
    const rawSecret = process.env.JWT_SECRET;
    const trimmed = rawSecret ? String(rawSecret).trim() : "";

    if (isProduction) {
        let failureReason = null;

        if (!trimmed) {
            failureReason = "JWT_SECRET environment variable is required in production.";
        } else if (trimmed.length < 32) {
            failureReason = "JWT_SECRET must be at least 32 characters long in production for cryptographic safety.";
        } else if (DISALLOWED_PRODUCTION_SECRETS.has(trimmed.toLowerCase())) {
            failureReason = "JWT_SECRET cannot use an insecure development placeholder in production.";
        }

        if (failureReason) {
            const fatalMsg = `❌ FATAL STARTUP CONFIGURATION ERROR: ${failureReason}`;
            console.error(fatalMsg);
            if (exitOnError) {
                process.exit(1);
            }
            throw new Error(fatalMsg);
        }
    } else {
        if (!trimmed) {
            console.warn(
                "⚠️ [DEV ONLY] Warning: JWT_SECRET is not configured in .env. Using development fallback key. Do NOT deploy with this configuration."
            );
        }
    }

    return true;
};

/**
 * Returns the centralized JWT secret.
 * All modules (auth middleware, user controller, socket manager) MUST use this function.
 *
 * @returns {string} The active JWT secret
 */
export const getJwtSecret = () => {
    const trimmed = process.env.JWT_SECRET ? String(process.env.JWT_SECRET).trim() : "";

    if (trimmed) {
        if (process.env.NODE_ENV === "production") {
            if (trimmed.length < 32 || DISALLOWED_PRODUCTION_SECRETS.has(trimmed.toLowerCase())) {
                throw new Error("FATAL: Insecure JWT_SECRET used in production environment.");
            }
        }
        return trimmed;
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("FATAL: JWT_SECRET environment variable is missing in production.");
    }

    return DEV_FALLBACK_SECRET;
};

export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

