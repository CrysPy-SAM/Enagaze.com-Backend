import httpStatus from "http-status";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Match } from "../models/match.model.js";
import { MatchRequest } from "../models/matchRequest.model.js";
import { Block } from "../models/block.model.js";
import { Conversation } from "../models/conversation.model.js";
import { toSearchUserProfile } from "../serializers/profile.serializer.js";
import { safeLean } from "../utils/queryHelper.js";

/**
 * Escapes regex special characters to prevent ReDoS and regex injection.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
    return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

/**
 * Compute relevance score for a candidate user against a search term.
 * Higher score indicates greater relevance in search ranking:
 * 1. Exact username match (100)
 * 2. Exact display name match (80)
 * 3. Username starts with search term (70)
 * 4. Display name starts with search term (50)
 * 5. Username contains search term (40)
 * 6. Display name contains search term (30)
 * 7. Interests contain exact/partial match (25 / 15)
 * 8. Bio contains search term (10)
 *
 * @param {Object} user
 * @param {string} rawTerm
 * @returns {number}
 */
export function computeSearchRelevance(user, rawTerm) {
    const term = rawTerm.toLowerCase().trim();
    if (!term) return 0;

    const uname = (user.username || "").toLowerCase();
    const dname = (user.name || "").toLowerCase();
    const bio = (user.bio || "").toLowerCase();
    const interests = Array.isArray(user.interests)
        ? user.interests.map((i) => (typeof i === "string" ? i.toLowerCase() : ""))
        : [];

    let score = 0;

    // 1. Exact username match
    if (uname === term) {
        score += 100;
    } else if (uname.startsWith(term)) {
        // 2. Username prefix match
        score += 70;
    } else if (uname.includes(term)) {
        // 3. Username substring match
        score += 40;
    }

    // 4. Exact display name match
    if (dname === term) {
        score += 80;
    } else if (dname.startsWith(term)) {
        // 5. Display name prefix match
        score += 50;
    } else if (dname.includes(term)) {
        // 6. Display name substring match
        score += 30;
    }

    // 7. Interests match
    if (interests.some((i) => i === term)) {
        score += 25;
    } else if (interests.some((i) => i.includes(term))) {
        score += 15;
    }

    // 8. Bio match
    if (bio.includes(term)) {
        score += 10;
    }

    return score;
}

/**
 * GET /api/v1/users/search
 * Search people by username and display name with partial matching and relationship resolution.
 */
export const searchUsers = async (req, res) => {
    try {
        const currentUserId = req.user?._id;
        if (!currentUserId) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Authentication required",
            });
        }

        const rawQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

        // If query is empty, return empty list gracefully without throwing an error
        if (!rawQuery) {
            return res.status(httpStatus.OK).json({
                success: true,
                users: [],
                pagination: {
                    page,
                    limit,
                    total: 0,
                    hasMore: false,
                },
            });
        }

        // Limit query length to 50 characters to prevent ReDoS / excessive execution
        const sanitizedTerm = rawQuery.slice(0, 50);
        const escapedTerm = escapeRegex(sanitizedTerm);
        const searchRegex = new RegExp(escapedTerm, "i");

        // Bidirectional blocked users filter
        const blockedIds = await Block.getBlockedUserIds(currentUserId);
        const excludedIds = [currentUserId, ...blockedIds];

        // Query candidates: only complete profiles, excluding self and blocked accounts
        const candidates = await User.find({
            _id: { $nin: excludedIds },
            isProfileComplete: true,
            $or: [
                { username: { $regex: searchRegex } },
                { name: { $regex: searchRegex } },
                { bio: { $regex: searchRegex } },
                { interests: { $regex: searchRegex } },
            ],
        })
            .select("_id name username bio photos interests dob gender isProfileComplete")
            .lean();

        // Score candidates and sort by relevance descending
        const scoredCandidates = candidates.map((user) => ({
            user,
            score: computeSearchRelevance(user, sanitizedTerm),
        }));

        scoredCandidates.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return (a.user.name || "").localeCompare(b.user.name || "");
        });

        const total = scoredCandidates.length;
        const startIndex = (page - 1) * limit;
        const pageCandidates = scoredCandidates
            .slice(startIndex, startIndex + limit)
            .map((item) => item.user);

        // If no candidates on this page, return early
        if (pageCandidates.length === 0) {
            return res.status(httpStatus.OK).json({
                success: true,
                users: [],
                pagination: {
                    page,
                    limit,
                    total,
                    hasMore: false,
                },
            });
        }

        // Resolve relationship states for this page of users
        const targetIds = pageCandidates.map((u) => u._id);
        const userPairs = targetIds.map((tId) => Match.getCanonicalPair(currentUserId, tId));

        // 1. Concurrently check for active canonical connections and pending MatchRequests
        const [activeMatches, pendingRequests] = await Promise.all([
            safeLean(
                Match.find({
                    userPair: { $in: userPairs },
                    status: "active",
                })
            ),
            safeLean(
                MatchRequest.find({
                    $or: [
                        { sender: currentUserId, recipient: { $in: targetIds }, status: "pending" },
                        { recipient: currentUserId, sender: { $in: targetIds }, status: "pending" },
                    ],
                })
            ),
        ]);

        const matchIdMap = new Map(); // canonicalPair -> match._id
        const activeMatchIds = [];
        for (const m of activeMatches) {
            matchIdMap.set(m.userPair, m._id);
            activeMatchIds.push(m._id);
        }

        // Fetch corresponding conversations for connected users
        const conversations = activeMatchIds.length > 0
            ? await safeLean(Conversation.find({ match: { $in: activeMatchIds } }).select("_id match"))
            : [];
        const matchToConvMap = new Map();
        for (const conv of conversations) {
            matchToConvMap.set(conv.match.toString(), conv._id.toString());
        }

        const outgoingReqMap = new Map(); // recipientId -> requestId
        const incomingReqMap = new Map(); // senderId -> requestId

        for (const reqItem of pendingRequests) {
            if (reqItem.sender.toString() === currentUserId.toString()) {
                outgoingReqMap.set(reqItem.recipient.toString(), reqItem._id.toString());
            } else if (reqItem.recipient.toString() === currentUserId.toString()) {
                incomingReqMap.set(reqItem.sender.toString(), reqItem._id.toString());
            }
        }

        // Format each user with their resolved relationship
        const formattedUsers = pageCandidates.map((user) => {
            const userIdStr = user._id.toString();
            const pair = Match.getCanonicalPair(currentUserId, user._id);

            let relationship = { status: "none", requestId: null, conversationId: null };

            if (matchIdMap.has(pair)) {
                const matchId = matchIdMap.get(pair);
                const convId = matchToConvMap.get(matchId.toString()) || null;
                relationship = { status: "connected", requestId: null, conversationId: convId };
            } else if (outgoingReqMap.has(userIdStr)) {
                relationship = { status: "outgoing_request", requestId: outgoingReqMap.get(userIdStr), conversationId: null };
            } else if (incomingReqMap.has(userIdStr)) {
                relationship = { status: "incoming_request", requestId: incomingReqMap.get(userIdStr), conversationId: null };
            }

            return toSearchUserProfile(user, relationship);
        });

        return res.status(httpStatus.OK).json({
            success: true,
            users: formattedUsers,
            pagination: {
                page,
                limit,
                total,
                hasMore: startIndex + limit < total,
            },
        });
    } catch (err) {
        console.error("User search error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to search users. Please try again.",
        });
    }
};

/**
 * GET /api/v1/users/profile/public/:userId
 * Fetch public profile details with relationship resolution.
 */
export const getPublicUserProfile = async (req, res) => {
    try {
        const currentUserId = req.user?._id;
        const targetUserId = req.params.userId;

        if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Invalid user ID format",
            });
        }

        // Concurrently check block status and fetch target user profile
        const [isBlocked, targetUser] = await Promise.all([
            Block.isBlockedBidirectional(currentUserId, targetUserId),
            safeLean(
                User.findById(targetUserId)
                    .select("_id name username bio photos interests dob gender isProfileComplete")
            ),
        ]);

        if (isBlocked || !targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User profile not found",
            });
        }

        // Compute relationship
        let relationship = { status: "none", requestId: null, conversationId: null };

        if (currentUserId.toString() === targetUserId.toString()) {
            relationship = { status: "self", requestId: null, conversationId: null };
        } else {
            const pair = Match.getCanonicalPair(currentUserId, targetUserId);
            const activeMatch = await Match.findOne({ userPair: pair, status: "active" }).lean();

            if (activeMatch) {
                const conversation = await Conversation.findOne({ match: activeMatch._id }).select("_id").lean();
                relationship = {
                    status: "connected",
                    requestId: null,
                    conversationId: conversation?._id?.toString() || null,
                };
            } else {
                const pendingRequest = await MatchRequest.findOne({
                    $or: [
                        { sender: currentUserId, recipient: targetUserId, status: "pending" },
                        { recipient: currentUserId, sender: targetUserId, status: "pending" },
                    ],
                }).lean();

                if (pendingRequest) {
                    if (pendingRequest.sender.toString() === currentUserId.toString()) {
                        relationship = {
                            status: "outgoing_request",
                            requestId: pendingRequest._id.toString(),
                            conversationId: null,
                        };
                    } else {
                        relationship = {
                            status: "incoming_request",
                            requestId: pendingRequest._id.toString(),
                            conversationId: null,
                        };
                    }
                }
            }
        }

        return res.status(httpStatus.OK).json({
            success: true,
            profile: toSearchUserProfile(targetUser, relationship),
        });
    } catch (err) {
        console.error("Get public profile error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to fetch user profile",
        });
    }
};

