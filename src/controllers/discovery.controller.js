import httpStatus from "http-status";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Swipe } from "../models/swipe.model.js";
import { Match } from "../models/match.model.js";

// ==========================================
// 1. GET DISCOVERY PROFILES
// ==========================================
const getDiscoveryProfiles = async (req, res) => {
    try {
        const currentUser = req.user;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (page - 1) * limit;

        // 1. Fetch IDs of profiles the user has already swiped on (liked or passed)
        const swipedRecords = await Swipe.find({ fromUser: currentUser._id }).select("toUser");
        const excludedIds = [currentUser._id, ...swipedRecords.map((s) => s.toUser)];

        // 2. Build discovery query
        const query = {
            _id: { $nin: excludedIds },
            isProfileComplete: true, // Only show completed profiles ready for matching
        };

        // 3. Gender preference matching
        const interestedIn = currentUser.datingPreferences?.interestedIn;
        if (interestedIn && Array.isArray(interestedIn) && !interestedIn.includes("everyone")) {
            query.gender = { $in: interestedIn };
        }

        // Mutual gender compatibility: target user must be interested in current user's gender or everyone
        if (currentUser.gender) {
            query["datingPreferences.interestedIn"] = { $in: [currentUser.gender, "everyone"] };
        }

        // 4. Age preference matching based on Date of Birth
        const ageRange = currentUser.datingPreferences?.ageRange;
        if (ageRange && ageRange.min && ageRange.max) {
            const now = new Date();
            // Earliest DOB: now minus (maxAge + 1) years
            const earliestDob = new Date(
                now.getFullYear() - ageRange.max - 1,
                now.getMonth(),
                now.getDate()
            );
            // Latest DOB: now minus minAge years
            const latestDob = new Date(
                now.getFullYear() - ageRange.min,
                now.getMonth(),
                now.getDate()
            );

            query.dob = { $gte: earliestDob, $lte: latestDob };
        }

        // 5. Execute query with safe projection
        const total = await User.countDocuments(query);
        const profiles = await User.find(query)
            .select("name username dob gender bio photos interests createdAt")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        return res.status(httpStatus.OK).json({
            success: true,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
            profiles: profiles.map((p) => p.toJSON()), // Virtuals like 'age' automatically included; passwords stripped
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
        // 4. Verify target user exists and has a complete profile
        const targetUser = await User.findById(targetUserId).select(
            "name username dob gender bio photos interests isProfileComplete"
        );
        if (!targetUser || !targetUser.isProfileComplete) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "Target profile not found or is incomplete",
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

                return res.status(httpStatus.CREATED).json({
                    success: true,
                    action: "like",
                    isMatch: true,
                    match: {
                        _id: match._id,
                        matchedUser: targetUser.toJSON(),
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
                select: "name username dob gender bio photos interests",
            });

        // Format each match with safe profile summary of the OTHER participant
        const formattedMatches = matches
            .map((m) => {
                const otherUser = m.users.find(
                    (u) => u && u._id.toString() !== req.user._id.toString()
                );
                if (!otherUser) return null;

                return {
                    _id: m._id,
                    matchedUser: otherUser.toJSON(),
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

export { getDiscoveryProfiles, swipe, getMatches };

