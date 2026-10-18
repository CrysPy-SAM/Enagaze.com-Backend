import crypto from "crypto";

export const DEFAULT_STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
];

const VALID_SCHEMES = new Set(["stun:", "stuns:", "turn:", "turns:"]);

/**
 * Validates a WebRTC ICE server URL string.
 * Must start with stun:, stuns:, turn:, or turns:.
 * 
 * @param {string} url
 * @returns {boolean}
 */
export function isValidIceUrl(url) {
    if (typeof url !== "string" || url.trim().length === 0) return false;
    const trimmed = url.trim().toLowerCase();
    for (const scheme of VALID_SCHEMES) {
        if (trimmed.startsWith(scheme)) {
            // Must have a non-empty host after scheme
            const rest = trimmed.slice(scheme.length);
            return rest.length > 0 && !rest.startsWith(":") && !rest.startsWith("/");
        }
    }
    return false;
}

/**
 * Parses a comma-separated list or JSON array of ICE server URLs.
 * 
 * @param {string|Array<string>} input
 * @returns {Array<string>}
 */
export function parseIceUrls(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.map((u) => String(u).trim()).filter(isValidIceUrl);
    }
    if (typeof input === "string") {
        const trimmed = input.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map((u) => String(u).trim()).filter(isValidIceUrl);
                }
            } catch {
                // Fall through to comma-separated parsing
            }
        }
        return trimmed
            .split(",")
            .map((u) => u.trim())
            .filter(isValidIceUrl);
    }
    return [];
}

/**
 * Generates an ephemeral TURN username and HMAC-SHA1 credential according to RFC 5766 / REST API.
 * 
 * @param {string} secret - Shared HMAC secret
 * @param {string} userId - User identifier
 * @param {number} ttlSeconds - Time-to-live in seconds
 * @returns {{ username: string, credential: string }}
 */
export function generateEphemeralTurnCredentials(secret, userId = "engaze-member", ttlSeconds = 86400) {
    const ttl = Number.isInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 86400;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const sanitizedUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, "");
    const username = `${expiry}:${sanitizedUserId || "engaze-member"}`;
    const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
    return { username, credential };
}

/**
 * Assembles a provider-neutral WebRTC ICE configuration.
 * 
 * Invariants:
 * 1. Never logs credentials.
 * 2. Uses ephemeral HMAC TURN credentials if TURN_SECRET is configured.
 * 3. Uses static TURN credentials if TURN_USERNAME & TURN_CREDENTIAL are configured.
 * 4. Falls back gracefully to default STUN servers if TURN is unconfigured or misconfigured.
 * 5. Respects WEBRTC_ICE_TRANSPORT_POLICY ('all' | 'relay').
 * 
 * @param {string} [userId]
 * @param {Object} [envOverride]
 * @returns {{ iceServers: Array<Object>, iceTransportPolicy: string, hasTurn: boolean }}
 */
export function getIceServersConfig(userId, envOverride = process.env) {
    const env = envOverride || {};

    // 1. STUN Servers (configured or defaults)
    const configuredStun = parseIceUrls(env.STUN_SERVER_URLS);
    const stunUrls = configuredStun.length > 0 ? configuredStun : DEFAULT_STUN_SERVERS;

    const iceServers = [
        {
            urls: stunUrls,
        },
    ];

    // 2. TURN Servers
    const turnUrls = parseIceUrls(env.TURN_SERVER_URLS);
    let hasTurn = false;

    if (turnUrls.length > 0) {
        if (env.TURN_SECRET) {
            const ttl = parseInt(env.TURN_CREDENTIAL_TTL, 10) || 86400;
            const { username, credential } = generateEphemeralTurnCredentials(
                env.TURN_SECRET,
                userId,
                ttl
            );
            iceServers.push({
                urls: turnUrls,
                username,
                credential,
            });
            hasTurn = true;
        } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
            iceServers.push({
                urls: turnUrls,
                username: String(env.TURN_USERNAME),
                credential: String(env.TURN_CREDENTIAL),
            });
            hasTurn = true;
        } else {
            // TURN URLs provided without credentials — invalid configuration.
            // Safe fallback: exclude unauthenticated TURN entry to prevent connection failure.
            console.warn(
                "[WebRTC Config] TURN_SERVER_URLS defined without TURN_SECRET or TURN_USERNAME/TURN_CREDENTIAL. Falling back to STUN-only."
            );
        }
    }

    // 3. Transport Policy: 'all' (default) or 'relay' (forced relay)
    const policy = env.WEBRTC_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";

    return {
        iceServers,
        iceTransportPolicy: policy,
        hasTurn,
    };
}

