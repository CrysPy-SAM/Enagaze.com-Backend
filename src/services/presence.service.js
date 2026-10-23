/**
 * Presence Service for Engaze
 * 
 * Provides:
 * 1. Multi-tab / multi-device active socket connection tracking per user.
 * 2. Grace period on disconnect to prevent UI flicker on page reload / tab switch.
 * 3. WhatsApp-style reciprocal privacy evaluation for Last Seen and Online status.
 */

// In-memory mapping of active sockets: userId (string) -> Set<socketId>
const activeSocketsByUser = new Map();

// In-memory mapping of disconnect grace timers: userId (string) -> timerHandle
const disconnectTimers = new Map();

// Configurable grace period: 100ms in test environment, 5000ms in production
export const getDisconnectGraceMs = () => {
    if (process.env.PRESENCE_GRACE_MS) {
        const parsed = parseInt(process.env.PRESENCE_GRACE_MS, 10);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) {
        return 100;
    }
    return 5000;
};

/**
 * Reset all in-memory presence tracking state (used in unit/integration tests).
 */
export const _resetPresenceState = () => {
    for (const timer of disconnectTimers.values()) {
        clearTimeout(timer);
    }
    disconnectTimers.clear();
    activeSocketsByUser.clear();
};

/**
 * Records a user socket connection.
 * Cancels any pending disconnect grace timer for this user.
 * 
 * @param {string} userId - User ID string
 * @param {string} socketId - Socket ID string
 * @returns {boolean} wasOffline - True if the user had zero active sockets prior to this connection
 */
export const userConnected = (userId, socketId) => {
    if (!userId || !socketId) return false;
    const uid = userId.toString();

    // Cancel any pending disconnect grace timer
    if (disconnectTimers.has(uid)) {
        clearTimeout(disconnectTimers.get(uid));
        disconnectTimers.delete(uid);
    }

    let sockets = activeSocketsByUser.get(uid);
    const wasOffline = !sockets || sockets.size === 0;

    if (!sockets) {
        sockets = new Set();
        activeSocketsByUser.set(uid, sockets);
    }
    sockets.add(socketId);

    return wasOffline;
};

/**
 * Records a user socket disconnect.
 * If all sockets for this user are gone, schedules a grace timer before marking offline.
 * 
 * @param {string} userId - User ID string
 * @param {string} socketId - Socket ID string
 * @param {Function} [onGraceExpired] - Async callback invoked if the grace timer expires without reconnection
 * @returns {boolean} isGracePending - True if a grace timer was started
 */
export const userDisconnected = (userId, socketId, onGraceExpired) => {
    if (!userId || !socketId) return false;
    const uid = userId.toString();

    const sockets = activeSocketsByUser.get(uid);
    if (sockets) {
        sockets.delete(socketId);
        if (sockets.size === 0) {
            activeSocketsByUser.delete(uid);
        }
    }

    // If user has remaining sockets on another tab/device, do not start grace timer
    if (activeSocketsByUser.has(uid) && activeSocketsByUser.get(uid).size > 0) {
        return false;
    }

    // Clear any existing timer for safety
    if (disconnectTimers.has(uid)) {
        clearTimeout(disconnectTimers.get(uid));
        disconnectTimers.delete(uid);
    }

    const graceMs = getDisconnectGraceMs();
    const timer = setTimeout(async () => {
        disconnectTimers.delete(uid);

        // Verify that the user hasn't reconnected during the grace period
        const currentSockets = activeSocketsByUser.get(uid);
        if (!currentSockets || currentSockets.size === 0) {
            if (typeof onGraceExpired === "function") {
                try {
                    await onGraceExpired(new Date());
                } catch (err) {
                    console.error(`Error in presence grace expiration handler for user ${uid}:`, err);
                }
            }
        }
    }, graceMs);

    // Unref timer in Node so it doesn't prevent process exit
    if (typeof timer.unref === "function") {
        timer.unref();
    }

    disconnectTimers.set(uid, timer);
    return true;
};

/**
 * Checks whether a user is currently considered online (has at least 1 active socket).
 * Note: A user in their disconnect grace period is still considered offline for new checks,
 * or online until grace expires. Since grace is pending, they have 0 active sockets.
 * 
 * @param {string} userId
 * @returns {boolean}
 */
export const isUserOnline = (userId) => {
    if (!userId) return false;
    const uid = userId.toString();
    const sockets = activeSocketsByUser.get(uid);
    return Boolean(sockets && sockets.size > 0);
};

/**
 * Determines whether viewerUser has permission to see targetUser's lastSeenAt.
 * 
 * Enforces WhatsApp reciprocity:
 * - If viewer's own lastSeen setting is "nobody", viewer cannot see ANY other user's lastSeenAt.
 * - If target's lastSeen setting is "nobody", target's lastSeenAt is hidden from everyone (except self).
 * - If target's lastSeen is "everyone", visible to everyone (unless viewer has "nobody").
 * - If target's lastSeen is "matches", visible only to active mutual matches.
 * - If target's lastSeen is "matches_except", visible to matches who are NOT in target's exceptions list.
 * 
 * @param {Object} targetUser - Target user document or object
 * @param {Object} viewerUser - Viewer user document or object
 * @param {boolean} [isMatch=false] - Whether target and viewer are active mutual matches
 * @returns {boolean}
 */
export const canViewerSeeLastSeen = (targetUser, viewerUser, isMatch = false) => {
    if (!targetUser || !viewerUser) return false;

    const targetId = targetUser._id ? targetUser._id.toString() : targetUser.id?.toString() || targetUser.toString();
    const viewerId = viewerUser._id ? viewerUser._id.toString() : viewerUser.id?.toString() || viewerUser.toString();

    // User can always see their own last seen
    if (targetId === viewerId) return true;

    const viewerPrivacy = viewerUser.privacySettings || {};
    const viewerLastSeenSetting = viewerPrivacy.lastSeen || "everyone";

    // WhatsApp Reciprocal Rule: If viewer sets their last seen to 'nobody',
    // viewer is not permitted to see other users' last seen.
    if (viewerLastSeenSetting === "nobody") {
        return false;
    }

    const targetPrivacy = targetUser.privacySettings || {};
    const targetLastSeenSetting = targetPrivacy.lastSeen || "everyone";

    switch (targetLastSeenSetting) {
        case "nobody":
            return false;
        case "everyone":
            return true;
        case "matches":
            return Boolean(isMatch);
        case "matches_except": {
            if (!isMatch) return false;
            const exceptions = Array.isArray(targetPrivacy.lastSeenExceptions)
                ? targetPrivacy.lastSeenExceptions.map((id) => (id?._id || id).toString())
                : [];
            return !exceptions.includes(viewerId);
        }
        default:
            return true;
    }
};

/**
 * Determines whether viewerUser has permission to see targetUser's Online indicator.
 * 
 * WhatsApp Rule:
 * - "everyone": Visible to everyone.
 * - "same_as_last_seen": Evaluates against target's lastSeen permission rules for viewer.
 * 
 * @param {Object} targetUser - Target user document or object
 * @param {Object} viewerUser - Viewer user document or object
 * @param {boolean} [isMatch=false] - Whether target and viewer are active mutual matches
 * @returns {boolean}
 */
export const canViewerSeeOnline = (targetUser, viewerUser, isMatch = false) => {
    if (!targetUser || !viewerUser) return false;

    const targetId = targetUser._id ? targetUser._id.toString() : targetUser.id?.toString() || targetUser.toString();
    const viewerId = viewerUser._id ? viewerUser._id.toString() : viewerUser.id?.toString() || viewerUser.toString();

    // User can always see their own online status
    if (targetId === viewerId) return true;

    const targetPrivacy = targetUser.privacySettings || {};
    const targetOnlineSetting = targetPrivacy.online || "everyone";

    if (targetOnlineSetting === "everyone") {
        return true;
    }

    if (targetOnlineSetting === "same_as_last_seen") {
        return canViewerSeeLastSeen(targetUser, viewerUser, isMatch);
    }

    return true;
};

/**
 * Calculates sanitized presence data for targetUser as seen by viewerUser.
 * 
 * @param {Object} targetUser - Target user document or object (must include privacySettings, lastSeenAt)
 * @param {Object} viewerUser - Viewer user document or object (must include privacySettings)
 * @param {boolean} [isMatch=false] - Whether they are active mutual matches
 * @returns {{ isOnline: boolean, lastSeenAt: Date|null }}
 */
export const getPresenceForViewer = (targetUser, viewerUser, isMatch = false) => {
    if (!targetUser) {
        return { isOnline: false, lastSeenAt: null };
    }

    const targetId = targetUser._id ? targetUser._id.toString() : targetUser.id?.toString() || targetUser.toString();
    const online = isUserOnline(targetId);

    const canSeeOnline = online && canViewerSeeOnline(targetUser, viewerUser, isMatch);
    const canSeeLastSeen = canViewerSeeLastSeen(targetUser, viewerUser, isMatch);

    return {
        isOnline: Boolean(canSeeOnline),
        lastSeenAt: canSeeLastSeen ? (targetUser.lastSeenAt || null) : null,
    };
};
