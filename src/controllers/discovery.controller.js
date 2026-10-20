import httpStatus from "http-status";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Swipe } from "../models/swipe.model.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";
import { Conversation } from "../models/conversation.model.js";
import { getIO } from "./socketManager.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";
import { findOrCreateCanonicalMatchAndConversation } from "../services/matching.service.js";
import {
    createNotification,
    supersedeLikeNotifications,
} from "../services/notification.service.js";

// ==========================================
// 1. GET DISCOVERY PROFILES
// ==========================================
const getDiscoveryProfiles = async (req, res) => {
    try {
        const currentUser = req.user;

        // 1. Authoritative check: Viewing user must be 18+ and have a complete profile
        const viewerEligibility = checkUserEligibility(currentUser);
        if (!viewerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: viewerEligibility.code,
                message: viewerEligibility.reason,
                missingFields: viewerEligibility.missingFields,
            });
        }

        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const cursor = req.query.cursor;

        // 2. Fetch IDs of profiles the user has already swiped on, matched users, and blocked users
        let swipeQuery = Swipe.find({ fromUser: currentUser._id }).select("toUser");
        if (typeof swipeQuery.lean === "function") swipeQuery = swipeQuery.lean();

        let matchQuery = Match.find({ users: currentUser._id }).select("users");
        if (typeof matchQuery.lean === "function") matchQuery = matchQuery.lean();

        const [swipedRecords, existingMatches, blockedIds] = await Promise.all([
            swipeQuery,
            matchQuery,
            Block.getBlockedUserIds(currentUser._id),
        ]);
        const matchedUserIds = existingMatches.flatMap((m) =>
            m.users.filter((u) => u && u.toString() !== currentUser._id.toString())
        );
        const excludedIds = [
            currentUser._id,
            ...swipedRecords.map((s) => s.toUser),
            ...matchedUserIds,
            ...blockedIds,
        ];

        // 3. Candidate Age Boundaries based on UTC calendar dates
        // User must be at least 18 (or customized minAge) and at most 120 (or customized maxAge)
        const now = new Date();
        const prefMin = currentUser.datingPreferences?.ageRange?.min;
        const prefMax = currentUser.datingPreferences?.ageRange?.max;

        const effectiveMinAge = (typeof prefMin === "number" && prefMin >= 18) ? Math.min(prefMin, 120) : 18;
        const effectiveMaxAge = (typeof prefMax === "number" && prefMax >= 18) ? Math.min(Math.max(prefMax, effectiveMinAge), 120) : 120;

        const latestEligibleDob = new Date(Date.UTC(
            now.getUTCFullYear() - effectiveMinAge,
            now.getUTCMonth(),
            now.getUTCDate(),
            23, 59, 59, 999
        ));
        const earliestEligibleDob = new Date(Date.UTC(
            now.getUTCFullYear() - effectiveMaxAge - 1,
            now.getUTCMonth(),
            now.getUTCDate(),
            0, 0, 0, 0
        ));

        // 4. Base Discovery Query:
        // Candidates MUST strictly have isProfileComplete: true and an adult DOB within bounds.
        // Profiles with null DOB or missing DOB are completely excluded from adult discovery.
        const query = {
            isProfileComplete: true,
            dob: { $gte: earliestEligibleDob, $lte: latestEligibleDob },
        };

        if (cursor) {
            if (!mongoose.Types.ObjectId.isValid(cursor)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Invalid cursor format",
                });
            }
            query._id = {
                $nin: excludedIds,
                $lt: new mongoose.Types.ObjectId(cursor),
            };
        } else {
            query._id = { $nin: excludedIds };
        }

        // 5. Gender preference matching
        const interestedIn = currentUser.datingPreferences?.interestedIn;
        if (interestedIn && Array.isArray(interestedIn) && !interestedIn.includes("everyone") && interestedIn.length > 0) {
            query.gender = { $in: interestedIn };
        }

        // Mutual gender compatibility: target user must be interested in current user's gender or everyone
        if (currentUser.gender) {
            query.$and = query.$and || [];
            query.$and.push({
                $or: [
                    { "datingPreferences.interestedIn": { $in: [currentUser.gender, "everyone"] } },
                    { "datingPreferences.interestedIn": { $exists: false } },
                    { "datingPreferences.interestedIn": null },
                    { "datingPreferences.interestedIn": { $size: 0 } },
                ],
            });
        }

        // 6. Execute query with safe projection
        let page = 1;
        let findQuery = User.find(query)
            .select("name dob gender bio photos interests isProfileComplete")
            .sort({ _id: -1 })
            .limit(limit);

        if (!cursor) {
            page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const skip = (page - 1) * limit;
            findQuery = findQuery.skip(skip);
        }

        if (typeof findQuery.lean === "function") {
            findQuery = findQuery.lean();
        }

        const [total, profiles] = await Promise.all([
            User.countDocuments(query),
            findQuery,
        ]);
        const nextCursor = profiles.length === limit ? profiles[profiles.length - 1]._id : null;
        const hasMore = Boolean(nextCursor);

        return res.status(httpStatus.OK).json({
            success: true,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
            cursor: cursor || null,
            nextCursor: nextCursor || null,
            hasMore,
            profiles: profiles.map((p) => toPublicProfile(p)),
        });
    } catch (e) {
        console.error("Get discovery profiles error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to load discovery profiles",
        });
    }
};

// ==========================================
// 2. SWIPE (LIKE / PASS) & MUTUAL MATCHING
// ==========================================
const swipe = async (req, res) => {
    const { targetUserId, action } = req.body;

    // 1. Validate targetUserId
    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid target user ID",
        });
    }

    // 0. Verify swiper eligibility
    const swiperEligibility = checkUserEligibility(req.user);
    if (!swiperEligibility.isEligible) {
        return res.status(httpStatus.FORBIDDEN).json({
            success: false,
            code: swiperEligibility.code,
            message: swiperEligibility.reason,
            missingFields: swiperEligibility.missingFields,
        });
    }

    // 2. Reject self-swiping
    if (targetUserId.toString() === req.user._id.toString()) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "You cannot swipe on your own profile",
        });
    }

    // 3. Validate swipe action
    if (!action || !["like", "pass"].includes(action)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Action must be either 'like' or 'pass'",
        });
    }

    try {
        // 4. Verify target user exists and is eligible
        const targetUser = await User.findById(targetUserId).select(
            "name dob gender bio photos interests isProfileComplete"
        );
        if (!targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Target profile not found",
            });
        }

        const targetEligibility = checkUserEligibility(targetUser);
        if (!targetEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "TARGET_INELIGIBLE",
                message: "Target profile is not eligible for discovery interactions.",
            });
        }

        // 4b. Enforce bidirectional block check
        const isBlocked = await Block.isBlockedBidirectional(req.user._id, targetUserId);
        if (isBlocked) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "BLOCKED_USER",
                message: "Interaction not permitted.",
            });
        }

        // 4c. Verify not previously unmatched
        const existingMatchRecord = await Match.findOne({
            userPair: Match.getCanonicalPair(req.user._id, targetUserId),
        });
        if (existingMatchRecord && existingMatchRecord.status === "unmatched") {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "MATCH_UNMATCHED",
                message: "This profile was previously unmatched.",
            });
        }

        // 5. Check if user has already swiped on targetUser
        const existingSwipe = await Swipe.findOne({
            fromUser: req.user._id,
            toUser: targetUserId,
        });

        if (existingSwipe) {
            // Idempotent duplicate retry if action matches
            if (existingSwipe.action === action) {
                if (action === "like") {
                    const userPair = Match.getCanonicalPair(req.user._id, targetUserId);
                    const activeMatch = await Match.findOne({ userPair, status: "active" });
                    if (activeMatch) {
                        const conversation = await Conversation.findOne({ match: activeMatch._id });
                        return res.status(httpStatus.OK).json({
                            success: true,
                            action,
                            isMatch: true,
                            duplicate: true,
                            match: {
                                _id: activeMatch._id,
                                matchedUser: toPublicProfile(targetUser),
                                conversationId: conversation?._id,
                                createdAt: activeMatch.createdAt,
                            },
                        });
                    }
                }
                return res.status(httpStatus.OK).json({
                    success: true,
                    action,
                    isMatch: false,
                    duplicate: true,
                });
            }

            // Conflicting action (e.g. was pass, now like)
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                code: "SWIPE_EXISTS",
                message: "You have already swiped on this profile",
                action: existingSwipe.action,
            });
        }

        // 6. Record swipe with duplicate-key recovery
        let newSwipe;
        try {
            newSwipe = await Swipe.create({
                fromUser: req.user._id,
                toUser: targetUserId,
                action,
            });
        } catch (e) {
            if (e.code === 11000) {
                // Concurrent duplicate swipe from same user
                const concurrentSwipe = await Swipe.findOne({
                    fromUser: req.user._id,
                    toUser: targetUserId,
                });
                if (concurrentSwipe) {
                    if (concurrentSwipe.action === action) {
                        if (action === "like") {
                            const userPair = Match.getCanonicalPair(req.user._id, targetUserId);
                            const activeMatch = await Match.findOne({ userPair, status: "active" });
                            if (activeMatch) {
                                const conversation = await Conversation.findOne({ match: activeMatch._id });
                                return res.status(httpStatus.OK).json({
                                    success: true,
                                    action,
                                    isMatch: true,
                                    duplicate: true,
                                    match: {
                                        _id: activeMatch._id,
                                        matchedUser: toPublicProfile(targetUser),
                                        conversationId: conversation?._id,
                                        createdAt: activeMatch.createdAt,
                                    },
                                });
                            }
                        }
                        return res.status(httpStatus.OK).json({
                            success: true,
                            action,
                            isMatch: false,
                            duplicate: true,
                        });
                    }
                    return res.status(httpStatus.CONFLICT).json({
                        success: false,
                        code: "SWIPE_EXISTS",
                        message: "A swipe record already exists for this profile",
                        action: concurrentSwipe.action,
                    });
                }
            }
            throw e;
        }

        // 7. Check for mutual match if action is "like"
        if (action === "like") {
            const reverseLike = await Swipe.findOne({
                fromUser: targetUserId,
                toUser: req.user._id,
                action: "like",
            });

            if (reverseLike) {
                // Mutual match found! Create or fetch canonical match and conversation
                const { match, conversation, isNewMatch } = await findOrCreateCanonicalMatchAndConversation(
                    req.user._id,
                    targetUserId
                );

                // Real-time socket notification and persistent match notifications
                const io = req.app?.get("io") || getIO();
                if (isNewMatch) {
                    if (io) {
                        const currentUserPublic = toPublicProfile(req.user);
                        const targetUserPublic = toPublicProfile(targetUser);

                        io.to(`user:${targetUserId.toString()}`).emit("match:new", {
                            match: {
                                _id: match._id,
                                matchedUser: currentUserPublic,
                                conversationId: conversation?._id,
                                createdAt: match.createdAt,
                            },
                        });

                        io.to(`user:${req.user._id.toString()}`).emit("match:new", {
                            match: {
                                _id: match._id,
                                matchedUser: targetUserPublic,
                                conversationId: conversation?._id,
                                createdAt: match.createdAt,
                            },
                        });
                    }

                    // Persist match notifications for both users and supersede any prior likes
                    await Promise.allSettled([
                        createNotification({
                            recipient: targetUserId,
                            sender: req.user._id,
                            type: "match",
                            data: { matchId: match._id, conversationId: conversation?._id },
                            io,
                        }),
                        createNotification({
                            recipient: req.user._id,
                            sender: targetUserId,
                            type: "match",
                            data: { matchId: match._id, conversationId: conversation?._id },
                            io,
                        }),
                        supersedeLikeNotifications(req.user._id, targetUserId),
                    ]);
                }

                return res.status(httpStatus.CREATED).json({
                    success: true,
                    action: "like",
                    isMatch: true,
                    match: {
                        _id: match._id,
                        matchedUser: toPublicProfile(targetUser),
                        conversationId: conversation?._id,
                        createdAt: match.createdAt,
                    },
                });
            }
        }

        // Unilateral like notification (when action is 'like' without mutual match yet)
        if (action === "like") {
            const io = req.app?.get("io") || getIO();
            await createNotification({
                recipient: targetUserId,
                sender: req.user._id,
                type: "like",
                io,
            });
        }

        // Either action was 'pass' or one-sided 'like' without a mutual like yet
        return res.status(httpStatus.OK).json({
            success: true,
            action,
            isMatch: false,
        });
    } catch (e) {
        console.error("Swipe processing error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to process swipe",
        });
    }
};

// ==========================================
// 3. GET MATCHES
// ==========================================
const getMatches = async (req, res) => {
    try {
        const viewerEligibility = checkUserEligibility(req.user);
        if (!viewerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: viewerEligibility.code,
                message: viewerEligibility.reason,
                missingFields: viewerEligibility.missingFields,
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        const blockedUserIds = await Block.getBlockedUserIds(req.user._id);
        const blockedIdStrings = new Set(blockedUserIds.map((id) => id.toString()));

        const filter = {
            users: blockedUserIds.length > 0 ? { $all: [req.user._id], $nin: blockedUserIds } : req.user._id,
            status: "active",
        };
        const total = await Match.countDocuments(filter);

        const matches = await Match.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: "users",
                select: "name dob gender bio photos interests isProfileComplete",
            });

        // Fetch corresponding conversation IDs for these matches
        const matchIds = matches.map((m) => m._id);
        const conversations = await Conversation.find({ match: { $in: matchIds } }).select("_id match");
        const matchToConvMap = new Map(conversations.map((c) => [c.match.toString(), c._id]));

        // Format each match with safe profile summary of the OTHER participant and its conversationId
        const formattedMatches = matches
            .map((m) => {
                const otherUser = m.users.find(
                    (u) => u && u._id.toString() !== req.user._id.toString()
                );
                if (!otherUser) return null;
                if (blockedIdStrings.has(otherUser._id.toString())) return null;

                const otherEligibility = checkUserEligibility(otherUser);
                if (!otherEligibility.isEligible) return null;

                return {
                    _id: m._id,
                    conversationId: matchToConvMap.get(m._id.toString()) || null,
                    matchedUser: toPublicProfile(otherUser),
                    createdAt: m.createdAt,
                };
            })
            .filter(Boolean);

        return res.status(httpStatus.OK).json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            matches: formattedMatches,
        });
    } catch (e) {
        console.error("Get matches error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to load matches",
        });
    }
};

// ==========================================
// 3b. GET LIKES YOU PROFILES
// ==========================================
const getLikesYou = async (req, res) => {
    try {
        const currentUser = req.user;

        // 1. Authoritative check: Viewing user must be 18+ and have a complete profile
        const viewerEligibility = checkUserEligibility(currentUser);
        if (!viewerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: viewerEligibility.code,
                message: viewerEligibility.reason,
                missingFields: viewerEligibility.missingFields,
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        // 2. Fetch incoming likes
        const incomingLikes = await Swipe.find({
            toUser: currentUser._id,
            action: "like",
        }).sort({ createdAt: -1 });

        if (incomingLikes.length === 0) {
            return res.status(httpStatus.OK).json({
                success: true,
                profiles: [],
                pagination: {
                    page,
                    limit,
                    total: 0,
                    totalPages: 1,
                },
            });
        }

        // 3. Exclude users already swiped by currentUser, existing matches, and blocked users
        const [mySwipes, existingMatches, blockedIds] = await Promise.all([
            Swipe.find({ fromUser: currentUser._id }).select("toUser"),
            Match.find({ users: currentUser._id }).select("users"),
            Block.getBlockedUserIds(currentUser._id),
        ]);

        const swipedUserIds = new Set(mySwipes.map((s) => s.toUser.toString()));
        const matchedUserIds = new Set(
            existingMatches.flatMap((m) =>
                m.users.filter((u) => u && u.toString() !== currentUser._id.toString()).map((u) => u.toString())
            )
        );
        const blockedSet = new Set(blockedIds.map((id) => id.toString()));

        // Filter and collect candidate user IDs and their like timestamps
        const candidateMap = new Map(); // userId -> likedAt
        for (const swipeRecord of incomingLikes) {
            const senderIdStr = swipeRecord.fromUser.toString();
            if (
                senderIdStr !== currentUser._id.toString() &&
                !swipedUserIds.has(senderIdStr) &&
                !matchedUserIds.has(senderIdStr) &&
                !blockedSet.has(senderIdStr) &&
                !candidateMap.has(senderIdStr)
            ) {
                candidateMap.set(senderIdStr, swipeRecord.createdAt);
            }
        }

        const allCandidateIds = Array.from(candidateMap.keys());
        const total = allCandidateIds.length;
        const pageCandidateIds = allCandidateIds.slice(skip, skip + limit);

        if (pageCandidateIds.length === 0) {
            return res.status(httpStatus.OK).json({
                success: true,
                profiles: [],
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit) || 1,
                },
            });
        }

        // 4. Fetch user records ensuring isProfileComplete: true
        const candidateUsers = await User.find({
            _id: { $in: pageCandidateIds },
            isProfileComplete: true,
        }).select("name dob gender bio photos interests isProfileComplete");

        // Preserve sort order from candidateMap
        const userMap = new Map(candidateUsers.map((u) => [u._id.toString(), u]));

        const profiles = pageCandidateIds
            .map((id) => {
                const user = userMap.get(id);
                if (!user) return null;
                const publicProfile = toPublicProfile(user);
                if (!publicProfile) return null;
                return {
                    ...publicProfile,
                    likedAt: candidateMap.get(id) || null,
                };
            })
            .filter(Boolean);

        return res.status(httpStatus.OK).json({
            success: true,
            profiles,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1,
            },
        });
    } catch (e) {
        console.error("Get likes you error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve likes",
        });
    }
};

// ==========================================
// 4. RESET DISCOVERY SWIPES (RE-DISCOVER)
// ==========================================
const resetDiscoverySwipes = async (req, res) => {
    try {
        const viewerEligibility = checkUserEligibility(req.user);
        if (!viewerEligibility.isEligible) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: viewerEligibility.code,
                message: viewerEligibility.reason,
                missingFields: viewerEligibility.missingFields,
            });
        }

        const userId = req.user._id;
        // Delete only 'pass' swipes so genuine mutual matches and likes are preserved
        const result = await Swipe.deleteMany({ fromUser: userId, action: "pass" });

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Passed profiles have been reset. You can explore them again!",
            resetCount: result.deletedCount,
        });
    } catch (e) {
        console.error("Reset discovery swipes error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to reset discovery swipes",
        });
    }
};

// ==========================================
// 5. GET DISCOVERY PREFERENCES
// ==========================================
const getDiscoveryPreferences = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select("datingPreferences");
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found",
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            datingPreferences: user.datingPreferences || {
                interestedIn: ["everyone"],
                ageRange: { min: 18, max: 100 },
            },
        });
    } catch (e) {
        console.error("Get discovery preferences error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve discovery preferences",
        });
    }
};

// ==========================================
// 6. UPDATE DISCOVERY PREFERENCES
// ==========================================
const updateDiscoveryPreferences = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found",
            });
        }

        const updates = req.body;
        if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Request body must be an object",
            });
        }

        // Initialize user datingPreferences if not present
        if (!user.datingPreferences) {
            user.datingPreferences = {
                interestedIn: ["everyone"],
                ageRange: { min: 18, max: 100 },
            };
        }

        const validInterestedIn = ["male", "female", "non-binary", "everyone"];

        // 1. Validate and update interestedIn
        if (updates.interestedIn !== undefined) {
            if (!Array.isArray(updates.interestedIn)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "interestedIn must be an array of valid preferences",
                });
            }
            if (updates.interestedIn.length === 0) {
                user.datingPreferences.interestedIn = ["everyone"];
            } else {
                for (const val of updates.interestedIn) {
                    if (typeof val !== "string" || !validInterestedIn.includes(val)) {
                        return res.status(httpStatus.BAD_REQUEST).json({
                            success: false,
                            message: `Invalid interestedIn value: "${val}". Allowed values: ${validInterestedIn.join(", ")}`,
                        });
                    }
                }
                user.datingPreferences.interestedIn = updates.interestedIn;
            }
        }

        // 2. Validate and update ageRange
        if (updates.ageRange !== undefined) {
            if (typeof updates.ageRange !== "object" || updates.ageRange === null || Array.isArray(updates.ageRange)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "ageRange must be an object with min and/or max properties",
                });
            }

            const { min, max } = updates.ageRange;
            const currentMin = user.datingPreferences?.ageRange?.min ?? 18;
            const currentMax = user.datingPreferences?.ageRange?.max ?? 100;

            let targetMin = currentMin;
            let targetMax = currentMax;

            if (min !== undefined) {
                const minAge = typeof min === "number" ? min : parseInt(min, 10);
                if (isNaN(minAge) || !Number.isInteger(minAge)) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Minimum age must be an integer",
                    });
                }
                if (minAge < 18 || minAge > 120) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Minimum age preference must be between 18 and 120",
                    });
                }
                targetMin = minAge;
            }

            if (max !== undefined) {
                const maxAge = typeof max === "number" ? max : parseInt(max, 10);
                if (isNaN(maxAge) || !Number.isInteger(maxAge)) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Maximum age must be an integer",
                    });
                }
                if (maxAge < 18 || maxAge > 120) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Maximum age preference must be between 18 and 120",
                    });
                }
                targetMax = maxAge;
            }

            if (targetMin > targetMax) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Minimum age preference cannot exceed maximum age preference",
                });
            }

            user.datingPreferences.ageRange = {
                min: targetMin,
                max: targetMax,
            };
        }

        await user.save();

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Discovery preferences updated successfully",
            datingPreferences: user.datingPreferences,
        });
    } catch (e) {
        console.error("Update discovery preferences error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to update discovery preferences",
        });
    }
};

export {
    getDiscoveryProfiles,
    swipe,
    getMatches,
    getLikesYou,
    resetDiscoverySwipes,
    getDiscoveryPreferences,
    updateDiscoveryPreferences,
};


