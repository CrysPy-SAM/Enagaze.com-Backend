/**
 * Centralized CORS Configuration
 * Shared across Express REST API and Socket.IO server.
 * Replaces wildcard/suffix reflection with a strict, exact-origin allowlist.
 */

// Default trusted origins required for production and local development
const DEFAULT_ALLOWED_ORIGINS = [
    "https://engaze.date",
    "https://www.engaze.date",
    "https://engaze-com.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
];

/**
 * Computes the complete array of allowed origins from defaults and environment variables.
 * Trailing slashes are stripped for exact matching.
 *
 * @returns {string[]} Normalized list of allowed origins
 */
export const getAllowedOrigins = () => {
    const list = [...DEFAULT_ALLOWED_ORIGINS];

    if (process.env.CLIENT_URL) {
        list.push(process.env.CLIENT_URL.trim().replace(/\/+$/, ""));
    }

    if (process.env.ALLOWED_ORIGINS) {
        const custom = process.env.ALLOWED_ORIGINS.split(",")
            .map((o) => o.trim().replace(/\/+$/, ""))
            .filter(Boolean);
        list.push(...custom);
    }

    return Array.from(new Set(list));
};

/**
 * Validates whether an incoming HTTP Origin header is allowed.
 * - Non-browser or direct requests without an Origin header (e.g., server health checks, curl) are permitted.
 * - Browser cross-origin requests must match an exact origin in the allowlist.
 * - Arbitrary *.vercel.app origins are strictly disallowed.
 *
 * @param {string|undefined} origin - The Origin header from the request
 * @param {string[]} [customAllowlist] - Optional allowlist override for testing
 * @returns {boolean}
 */
export const isOriginAllowed = (origin, customAllowlist = null) => {
    // Requests with no Origin header (e.g. mobile apps, curl, server-to-server)
    if (!origin) {
        return true;
    }

    const normalizedOrigin = String(origin).trim().replace(/\/+$/, "");
    const allowed = customAllowlist || getAllowedOrigins();

    return allowed.includes(normalizedOrigin);
};

/**
 * Express CORS Middleware Options
 */
export const corsOptions = {
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
            return callback(null, true);
        }
        // Reject cross-origin by suppressing Access-Control-Allow-Origin header
        return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // 24-hour preflight cache
};

