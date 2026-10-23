import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
    userConnected,
    userDisconnected,
    isUserOnline,
    canViewerSeeLastSeen,
    canViewerSeeOnline,
    getPresenceForViewer,
    _resetPresenceState,
} from "../src/services/presence.service.js";
import { toPublicProfile } from "../src/serializers/profile.serializer.js";

describe("Presence & WhatsApp-Style Privacy Test Suite", () => {
    beforeEach(() => {
        _resetPresenceState();
    });

    afterEach(() => {
        _resetPresenceState();
    });

    // =========================================================================
    // 1. Connection Tracking & Multi-Tab Lifecycle
    // =========================================================================
    describe("Connection Tracking & Multi-Tab Lifecycle", () => {
        const userId = "65cb1234567890abcdef1001";

        it("detects user coming online from offline state", () => {
            assert.equal(isUserOnline(userId), false);
            const wasOffline = userConnected(userId, "socket-1");
            assert.equal(wasOffline, true);
            assert.equal(isUserOnline(userId), true);
        });

        it("tracks multiple tabs without reporting wasOffline on second tab", () => {
            const first = userConnected(userId, "tab-1");
            assert.equal(first, true);

            const second = userConnected(userId, "tab-2");
            assert.equal(second, false);
            assert.equal(isUserOnline(userId), true);

            // Disconnect first tab: user should remain online because tab-2 is still connected
            const gracePending = userDisconnected(userId, "tab-1");
            assert.equal(gracePending, false);
            assert.equal(isUserOnline(userId), true);

            // Disconnect second tab: grace period should start
            const secondGracePending = userDisconnected(userId, "tab-2");
            assert.equal(secondGracePending, true);
            assert.equal(isUserOnline(userId), false);
        });

        it("reconnection within grace period aborts offline transition", async () => {
            userConnected(userId, "socket-old");
            let expiredCalled = false;

            userDisconnected(userId, "socket-old", async () => {
                expiredCalled = true;
            });

            // Reconnect immediately with a new socket before grace expires
            const wasOffline = userConnected(userId, "socket-new");
            // Since active sockets were empty, wasOffline is true, but grace was cleared
            assert.equal(wasOffline, true);
            assert.equal(isUserOnline(userId), true);

            // Wait 150ms (test grace period is 100ms)
            await new Promise((resolve) => setTimeout(resolve, 150));

            // Grace callback must NOT have run or user remains online
            assert.equal(isUserOnline(userId), true);
        });

        it("grace expiration triggers callback when no reconnection occurs", async () => {
            userConnected(userId, "socket-leave");
            let callbackTime = null;

            userDisconnected(userId, "socket-leave", async (timestamp) => {
                callbackTime = timestamp;
            });

            assert.equal(isUserOnline(userId), false);

            // Wait 150ms for grace to expire
            await new Promise((resolve) => setTimeout(resolve, 150));

            assert.ok(callbackTime instanceof Date);
            assert.equal(isUserOnline(userId), false);
        });
    });

    // =========================================================================
    // 2. WhatsApp-Style Last Seen Privacy Rules
    // =========================================================================
    describe("canViewerSeeLastSeen", () => {
        const alice = {
            _id: "65cb1234567890abcdef0001",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };
        const bob = {
            _id: "65cb1234567890abcdef0002",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };

        it("always allows a user to see their own last seen", () => {
            assert.equal(canViewerSeeLastSeen(alice, alice, false), true);
        });

        it("allows viewing when both have 'everyone'", () => {
            assert.equal(canViewerSeeLastSeen(alice, bob, false), true);
            assert.equal(canViewerSeeLastSeen(bob, alice, false), true);
        });

        it("enforces WhatsApp reciprocity: viewer with lastSeen 'nobody' cannot view others", () => {
            const secretiveViewer = {
                _id: "65cb1234567890abcdef0003",
                privacySettings: { lastSeen: "nobody", online: "everyone" },
            };

            // Even though Alice shares with 'everyone', the secretive viewer hides theirs, so they cannot see Alice's
            assert.equal(canViewerSeeLastSeen(alice, secretiveViewer, true), false);
        });

        it("hides last seen if target has set lastSeen to 'nobody'", () => {
            const targetNobody = {
                _id: "65cb1234567890abcdef0004",
                privacySettings: { lastSeen: "nobody", online: "everyone" },
            };

            assert.equal(canViewerSeeLastSeen(targetNobody, bob, true), false);
        });

        it("enforces 'matches' setting (visible only to mutual matches)", () => {
            const matchesOnly = {
                _id: "65cb1234567890abcdef0005",
                privacySettings: { lastSeen: "matches", online: "everyone" },
            };

            assert.equal(canViewerSeeLastSeen(matchesOnly, bob, false), false);
            assert.equal(canViewerSeeLastSeen(matchesOnly, bob, true), true);
        });

        it("enforces 'matches_except' setting (excludes specific user IDs)", () => {
            const matchesExcept = {
                _id: "65cb1234567890abcdef0006",
                privacySettings: {
                    lastSeen: "matches_except",
                    lastSeenExceptions: [bob._id],
                    online: "everyone",
                },
            };
            const charlie = {
                _id: "65cb1234567890abcdef0007",
                privacySettings: { lastSeen: "everyone", online: "everyone" },
            };

            // Bob is excluded in exceptions
            assert.equal(canViewerSeeLastSeen(matchesExcept, bob, true), false);
            // Charlie is a match and NOT excluded
            assert.equal(canViewerSeeLastSeen(matchesExcept, charlie, true), true);
            // Charlie is NOT a match
            assert.equal(canViewerSeeLastSeen(matchesExcept, charlie, false), false);
        });
    });

    // =========================================================================
    // 3. Online Visibility Rules
    // =========================================================================
    describe("canViewerSeeOnline", () => {
        const alice = {
            _id: "65cb1234567890abcdef0001",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };
        const bob = {
            _id: "65cb1234567890abcdef0002",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };

        it("allows viewing when online setting is 'everyone'", () => {
            assert.equal(canViewerSeeOnline(alice, bob, false), true);
        });

        it("evaluates 'same_as_last_seen' against target's lastSeen rules", () => {
            const targetSameAsLastSeen = {
                _id: "65cb1234567890abcdef0010",
                privacySettings: { lastSeen: "matches", online: "same_as_last_seen" },
            };

            // Non-match cannot see online
            assert.equal(canViewerSeeOnline(targetSameAsLastSeen, bob, false), false);
            // Mutual match can see online
            assert.equal(canViewerSeeOnline(targetSameAsLastSeen, bob, true), true);
        });

        it("blocks online visibility if target lastSeen is nobody and online is same_as_last_seen", () => {
            const targetGhost = {
                _id: "65cb1234567890abcdef0011",
                privacySettings: { lastSeen: "nobody", online: "same_as_last_seen" },
            };

            assert.equal(canViewerSeeOnline(targetGhost, bob, true), false);
        });
    });

    // =========================================================================
    // 4. Combined getPresenceForViewer & Serializer Integration
    // =========================================================================
    describe("getPresenceForViewer & Serializer Integration", () => {
        const pastDate = new Date("2026-10-21T18:00:00.000Z");
        const target = {
            _id: "65cb1234567890abcdef0020",
            name: "Dev Patel",
            lastSeenAt: pastDate,
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };
        const viewer = {
            _id: "65cb1234567890abcdef0021",
            name: "Ananya Roy",
            privacySettings: { lastSeen: "everyone", online: "everyone" },
        };

        it("returns offline presence with lastSeenAt when target is offline", () => {
            const presence = getPresenceForViewer(target, viewer, true);
            assert.equal(presence.isOnline, false);
            assert.equal(presence.lastSeenAt.toISOString(), pastDate.toISOString());

            const publicProfile = toPublicProfile(target, presence);
            assert.equal(publicProfile.isOnline, false);
            assert.equal(publicProfile.lastSeenAt.toISOString(), pastDate.toISOString());
            // Internal privacy settings must NEVER leak
            assert.equal(publicProfile.privacySettings, undefined);
        });

        it("returns online presence when target has active socket", () => {
            userConnected(target._id, "sock-online");
            const presence = getPresenceForViewer(target, viewer, true);
            assert.equal(presence.isOnline, true);
            assert.equal(presence.lastSeenAt.toISOString(), pastDate.toISOString());

            const publicProfile = toPublicProfile(target, presence);
            assert.equal(publicProfile.isOnline, true);
        });

        it("redacts lastSeenAt when viewer is blocked by reciprocity or target settings", () => {
            const secretiveViewer = {
                _id: "65cb1234567890abcdef0022",
                privacySettings: { lastSeen: "nobody", online: "everyone" },
            };

            const presence = getPresenceForViewer(target, secretiveViewer, true);
            assert.equal(presence.lastSeenAt, null);

            const publicProfile = toPublicProfile(target, presence);
            assert.equal(publicProfile.lastSeenAt, null);
        });
    });
});
