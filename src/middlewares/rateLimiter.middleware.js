import rateLimit from "express-rate-limit";

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

/**
 * Global API rate limiter:
 * Protects against generic volumetric denial of service.
 * Allows 600 requests per 15 minutes per IP.
 */
export const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler("API request rate limit exceeded. Please slow down."),
    // Do not rate limit health check endpoints needed by Render monitors
    skip: (req) => req.path === "/" || req.path === "/api/v1/health",
});

/**
 * Strict IP-based login rate limiter:
 * Limits brute force password attempts to 10 attempts per 15 minutes per IP.
 */
export const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many login attempts from this network. Please try again after 15 minutes."
    ),
});

/**
 * Account-based login rate limiter:
 * Protects specific accounts from distributed brute force / password spraying across multiple IPs.
 * Normalizes username and avoids revealing whether the account exists in the database.
 */
export const loginAccountLimiter = rateLimit({
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
});

/**
 * Registration rate limiter:
 * Limits spam account creation to 10 accounts per hour per IP.
 */
export const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many registration attempts from this network. Please try again later."
    ),
});

/**
 * Google OAuth login rate limiter:
 * Prevents automated token submission hammering to 20 attempts per 15 minutes per IP.
 */
export const googleLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many Google sign-in attempts. Please try again later."
    ),
});

/**
 * Discovery feed retrieval rate limiter:
 * Allows up to 120 profile feed page fetches per minute per IP.
 */
export const discoveryLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many discovery feed requests. Please slow down."
    ),
});

/**
 * Swipe action rate limiter:
 * Prevents automated script-based swipe flooding.
 * Allows up to 60 swipe actions per minute per IP.
 */
export const swipeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "You are swiping too fast. Please take a moment and try again."
    ),
});

/**
 * Report submission rate limiter:
 * Prevents report harassment/spam. Max 10 reports per 10 minutes.
 */
export const reportLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many reports submitted. Please wait before submitting another report."
    ),
});

/**
 * Block/unblock rate limiter:
 * Max 30 block operations per 10 minutes.
 */
export const blockLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many block requests. Please wait a moment."
    ),
});

/**
 * Unmatch rate limiter:
 * Max 30 unmatch operations per 10 minutes.
 */
export const unmatchLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many unmatch requests. Please wait a moment."
    ),
});

/**
 * Photo upload intent and confirmation rate limiter:
 * Limits photo upload requests to 30 requests per 15 minutes per IP.
 */
export const photoUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: createRateLimitHandler(
        "Too many photo upload requests. Please wait a few minutes before trying again."
    ),
});
