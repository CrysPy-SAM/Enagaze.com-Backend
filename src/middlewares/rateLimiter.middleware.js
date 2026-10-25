import rateLimit from "express-rate-limit";
import { isRateLimitRedisEnabled, formatSafeRedisError } from "../config/redis.js";
import { createRedisStore } from "../services/rateLimitRedis.service.js";

/**
 * Standard 429 response handler returning consistent JSON format
 */
const createRateLimitHandler = (customMessage) => (req, res, _next, options) => {
    const retryAfter = Math.ceil(options.windowMs / 1000);
    return res.status(429).json({
        success: false,
        message: customMessage || "Too many requests. Please try again later.",
        retryAfterSeconds: retryAfter,
    });
};

// Registry of created adaptive rate limiters for test resets
const activeLimiters = [];

/**
 * Creates an adaptive rate limiter that uses process-local memory by default,
 * or Redis-backed distributed counters when RATE_LIMIT_REDIS_ENABLED is true.
 *
 * @param {Object} options - express-rate-limit configuration
 * @param {string} policyName - unique namespace for policy keys
 * @returns {Function} Express middleware
 */
export const createAdaptiveRateLimiter = (options, policyName) => {
    const memLimiter = rateLimit({
        ...options,
        validate: { default: true, creationStack: false },
    });
    let redisLimiter = null;

    const middleware = (req, res, next) => {
        if (!isRateLimitRedisEnabled()) {
            return memLimiter(req, res, next);
        }

        if (!redisLimiter) {
            try {
                const store = createRedisStore(policyName);
                redisLimiter = rateLimit({
                    ...options,
                    store,
                    validate: { default: true, creationStack: false, unsharedStore: false },
                });
            } catch (storeInitErr) {
                const safeMsg = formatSafeRedisError(storeInitErr);
                console.error(`[RateLimit:${policyName}] Store init error: ${safeMsg}`);
                return res.status(503).json({
                    success: false,
                    status: "service_unavailable",
                    message: "Rate limiting service temporarily unavailable. Please retry shortly.",
                });
            }
        }

        return redisLimiter(req, res, (err) => {
            if (err) {
                const safeMsg = formatSafeRedisError(err);
                console.error(`[RateLimit:${policyName}] Store error: ${safeMsg}`);
                return res.status(503).json({
                    success: false,
                    status: "service_unavailable",
                    message: "Rate limiting service temporarily unavailable. Please retry shortly.",
                });
            }
            next();
        });
    };

    middleware._resetForTesting = () => {
        redisLimiter = null;
    };

    activeLimiters.push(middleware);
    return middleware;
};

/**
 * Resets all cached adaptive limiter instances (used in unit tests).
 */
export const _resetRateLimitersForTesting = () => {
    for (const lim of activeLimiters) {
        if (typeof lim._resetForTesting === "function") {
            lim._resetForTesting();
        }
    }
};

/**
 * Global API rate limiter:
 * Protects against generic volumetric denial of service.
 * Allows 600 requests per 15 minutes per IP.
 */
export const globalApiLimiter = createAdaptiveRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler("API request rate limit exceeded. Please slow down."),
    // Do not rate limit health check endpoints needed by Render monitors
    skip: (req) =>
        req.path === "/" ||
        req.path === "/health" ||
        req.path === "/livez" ||
        req.path === "/readyz" ||
        req.path.startsWith("/api/v1/health"),
}, "global");

/**
 * Strict IP-based login rate limiter:
 * Limits brute force password attempts to 10 attempts per 15 minutes per IP.
 */
export const loginIpLimiter = createAdaptiveRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many login attempts from this network. Please try again after 15 minutes."
    ),
}, "login_ip");

/**
 * Account-based login rate limiter:
 * Protects specific accounts from distributed brute force / password spraying across multiple IPs.
 * Normalizes username and avoids revealing whether the account exists in the database.
 */
export const loginAccountLimiter = createAdaptiveRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
        const username = typeof req.body?.username === "string" ? req.body.username.toLowerCase().trim() : "";
        return username ? `account:${username}` : `ip:${req.ip}`;
    },
    handler: createRateLimitHandler(
        "Too many login attempts for this account. Please try again after 15 minutes."
    ),
}, "login_account");

/**
 * Registration rate limiter:
 * Limits spam account creation to 10 accounts per hour per IP.
 */
export const registerLimiter = createAdaptiveRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many registration attempts from this network. Please try again later."
    ),
}, "register");

/**
 * Google OAuth login rate limiter:
 * Prevents automated token submission hammering to 20 attempts per 15 minutes per IP.
 */
export const googleLoginLimiter = createAdaptiveRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many Google sign-in attempts. Please try again later."
    ),
}, "google_login");

/**
 * Discovery feed retrieval rate limiter:
 * Allows up to 120 profile feed page fetches per minute per IP.
 */
export const discoveryLimiter = createAdaptiveRateLimiter({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many discovery feed requests. Please slow down."
    ),
}, "discovery");

/**
 * Swipe action rate limiter:
 * Prevents automated script-based swipe flooding.
 * Allows up to 60 swipe actions per minute per IP.
 */
export const swipeLimiter = createAdaptiveRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "You are swiping too fast. Please take a moment and try again."
    ),
}, "swipe");

/**
 * Report submission rate limiter:
 * Prevents report harassment/spam. Max 10 reports per 10 minutes.
 */
export const reportLimiter = createAdaptiveRateLimiter({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many reports submitted. Please wait before submitting another report."
    ),
}, "report");

/**
 * Block/unblock rate limiter:
 * Max 30 block operations per 10 minutes.
 */
export const blockLimiter = createAdaptiveRateLimiter({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many block requests. Please wait a moment."
    ),
}, "block");

/**
 * Unmatch rate limiter:
 * Max 30 unmatch operations per 10 minutes.
 */
export const unmatchLimiter = createAdaptiveRateLimiter({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many unmatch requests. Please wait a moment."
    ),
}, "unmatch");

/**
 * Photo upload intent and confirmation rate limiter:
 * Limits photo upload requests to 30 requests per 15 minutes per IP.
 */
export const photoUploadLimiter = createAdaptiveRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many photo upload requests. Please wait a few minutes before trying again."
    ),
}, "photo_upload");

/**
 * User search rate limiter:
 * Allows up to 60 search requests per minute per IP to accommodate debounced typing
 * while preventing scraping and abusive query volumes.
 */
export const userSearchLimiter = createAdaptiveRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    handler: createRateLimitHandler(
        "Too many search requests. Please slow down."
    ),
}, "user_search");
