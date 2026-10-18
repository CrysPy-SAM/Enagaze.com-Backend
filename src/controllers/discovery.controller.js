import httpStatus from "http-status";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Swipe } from "../models/swipe.model.js";
import { Match } from "../models/match.model.js";
import { Conversation } from "../models/conversation.model.js";
import { getIO } from "./socketManager.js";
import { toPublicProfile } from "../serializers/profile.serializer.js";
import { checkUserEligibility } from "../services/eligibility.service.js";

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

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (page - 1) * limit;

        // 2. Fetch IDs of profiles the user has already swiped on (liked or passed) AND already matched users
        const [swipedRecords, existingMatches] = await Promise.all([
            Swipe.find({ fromUser: currentUser._id }).select("toUser"),
            Match.find({ users: currentUser._id }).select("users"),
        ]);
        const matchedUserIds = existingMatches.flatMap((m) =>
            m.users.filter((u) => u && u.toString() !== currentUser._id.toString())
        );
        const excludedIds = [
            currentUser._id,
            ...swipedRecords.map((s) => s.toUser),
            ...matchedUserIds,
        ];

        // 3. Candidate Age Boundaries based on UTC calendar dates
        // User must be at least 18 (or customized minAge) and at most 120 (or customized maxAge)
        const now = new Date();
        const prefMin = currentUser.datingPreferences?.ageRange?.min;
        const prefMax = currentUser.datingPreferences?.ageRange?.max;

        const effectiveMinAge = prefMin && prefMin > 18 ? prefMin : 18;
        const effectiveMaxAge = prefMax && prefMax < 100 ? prefMax : 120;

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
            _id: { $nin: excludedIds },
            isProfileComplete: true,
            dob: { $gte: earliestEligibleDob, $lte: latestEligibleDob },
        };

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
        const total = await User.countDocuments(query);
        const profiles = await User.find(query)
            .select("name dob gender bio photos interests isProfileComplete")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        return res.status(httpStatus.OK).json({
            success: true,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
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

        // 5. Check if user has already swiped on targetUser
        const existingSwipe = await Swipe.findOne({
            fromUser: req.user._id,
            toUser: targetUserId,
        });

        if (existingSwipe) {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "You have already swiped on this profile",
                action: existingSwipe.action,
            });
        }

        // 6. Record swipe
        const newSwipe = new Swipe({
            fromUser: req.user._id,
            toUser: targetUserId,
            action,
        });
        await newSwipe.save();

        // 7. Check for mutual match if action is "like"
        if (action === "like") {
            const reverseLike = await Swipe.findOne({
                fromUser: targetUserId,
                toUser: req.user._id,
                action: "like",
            });

            if (reverseLike) {
                // Mutual match found! Create or fetch canonical match
                const userPair = Match.getCanonicalPair(req.user._id, targetUserId);

                const match = await Match.findOneAndUpdate(
                    { userPair },
                    {
                        $setOnInsert: {
                            users: [req.user._id, targetUserId],
                            userPair,
                        },
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                // Atomically ensure conversation record exists for this mutual match
                const conversation = await Conversation.findOneAndUpdate(
                    { match: match._id },
                    {
                        $setOnInsert: {
                            match: match._id,
                            participants: [req.user._id, targetUserId],
                            lastMessageAt: match.createdAt || new Date(),
                        },
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                // Real-time socket notification to both matched users
                const io = req.app.get("io") || getIO();
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

        // Either action was 'pass' or one-sided 'like' without a mutual like yet
        return res.status(httpStatus.OK).json({
            success: true,
            action,
            isMatch: false,
        });
    } catch (e) {
        // Handle race conditions where compound index catches concurrent duplicate swipes
        if (e.code === 11000) {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "A swipe record already exists for this profile",
            });
        }

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

        const filter = { users: req.user._id };
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

export { getDiscoveryProfiles, swipe, getMatches, resetDiscoverySwipes };


