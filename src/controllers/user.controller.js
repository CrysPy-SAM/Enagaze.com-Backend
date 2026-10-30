import mongoose from "mongoose";
import { Match } from "../models/match.model.js";
import { getIO } from "./socketManager.js";
import { getPresenceForViewer } from "../services/presence.service.js";
import httpStatus from "http-status";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { User, evaluateAccountStatus } from "../models/user.model.js";
import { getJwtSecret, JWT_EXPIRES_IN } from "../config/jwt.js";
import { calculateExactAge, evaluateProfileCompleteness, checkUserEligibility } from "../services/eligibility.service.js";
import { validatePublicPhotoUrl } from "../services/imageValidation.service.js";
import { validateUsername, normalizeUsername, generateUsernameSuggestions } from "../utils/usernameValidator.js";

// Helper: Generate JWT token
const generateToken = (user) => {
    return jwt.sign(
        { id: user._id, username: user.username },
        getJwtSecret(),
        { expiresIn: JWT_EXPIRES_IN }
    );
};

// ==========================================
// 1. LOGIN
// ==========================================
const login = async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Username and password are required"
        });
    }

    try {
        const normalizedUsername = username.toLowerCase().trim();
        const trimmedUsername = username.trim();

        // Find user by normalized handle first (O(1) via unique index), fallback to direct username
        let user = await User.findOne({ normalizedUsername });
        if (!user) {
            user = await User.findOne({ username: trimmedUsername });
        }
        if (!user && trimmedUsername !== normalizedUsername) {
            user = await User.findOne({ username: normalizedUsername });
        }

        if (!user) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Invalid username or password"
            });
        }

        const isPasswordCorrect = await bcrypt.compare(password, user.password);
        if (!isPasswordCorrect) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Invalid username or password"
            });
        }

        // Enforce account moderation status on login
        const accountStatus = evaluateAccountStatus(user);
        if (!accountStatus.allowed) {
            const isBanned = accountStatus.status === "banned";
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                message: isBanned
                    ? "Your account has been permanently banned."
                    : `Your account is temporarily suspended until ${user.suspensionExpiresAt ? new Date(user.suspensionExpiresAt).toISOString() : "further notice"}. Reason: ${user.suspensionReason || "Policy violation"}`,
                code: isBanned ? "ACCOUNT_BANNED" : "ACCOUNT_SUSPENDED",
                reason: accountStatus.reason,
                expiresAt: accountStatus.expiresAt,
            });
        }

        if (accountStatus.wasExpired) {
            user.status = "active";
            user.suspensionExpiresAt = null;
            user.suspensionReason = null;
            await user.save();
        }

        const token = generateToken(user);

        return res.status(httpStatus.OK).json({
            success: true,
            token: token,
            user: user.toJSON()
        });
    } catch (e) {
        console.error("Login error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "An internal error occurred during login. Please try again."
        });
    }
};

// ==========================================
// 2. REGISTER
// ==========================================
const register = async (req, res) => {
    const { name, username, password, dob } = req.body;

    if (!name || !username || !password) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "All fields (name, username, password) are required"
        });
    }

    const trimmedName = name.trim();
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: usernameValidation.error
        });
    }
    const normalizedUsername = usernameValidation.normalized;

    if (trimmedName.length < 2 || trimmedName.length > 100) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Name must be between 2 and 100 characters"
        });
    }

    if (password.length < 6) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Password must be at least 6 characters long"
        });
    }

    // Optional DOB validation during registration if provided
    let parsedDob = undefined;
    if (dob !== undefined && dob !== null && dob !== "") {
        const parsed = new Date(dob);
        if (isNaN(parsed.getTime())) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Invalid date of birth format"
            });
        }
        const age = calculateExactAge(parsed);
        if (age === null || age < 18) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "You must be at least 18 years old to use Engaze."
            });
        }
        if (age > 120) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Please enter a valid date of birth."
            });
        }
        parsedDob = parsed;
    }

    try {
        const existingUser = await User.findOne({
            $or: [{ normalizedUsername }, { username: normalizedUsername }]
        });
        if (existingUser) {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "Username already exists. Please choose another."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            name: trimmedName,
            username: usernameValidation.trimmed,
            normalizedUsername,
            password: hashedPassword,
            dob: parsedDob,
            usernameSetupCompleted: true,
            usernameLastChangedAt: null,
            isProfileComplete: false
        });

        // Evaluate profile completion purely based on profile fields & age policy
        newUser.isProfileComplete = evaluateProfileCompleteness(newUser).isComplete;

        const token = generateToken(newUser);
        await newUser.save();

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: "User registered successfully",
            token: token,
            user: newUser.toJSON()
        });
    } catch (e) {
        console.error("Registration error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "An internal error occurred during registration. Please try again."
        });
    }
};

// ==========================================
// 3. GET CURRENT USER PROFILE
// ==========================================
const getMyProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User profile not found"
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            profile: user.toJSON()
        });
    } catch (e) {
        console.error("Get profile error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve profile"
        });
    }
};

// ==========================================
// 4. UPDATE CURRENT USER PROFILE
// ==========================================
const updateMyProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found"
            });
        }

        // Explicit allowlist of editable profile fields
        const allowedFields = [
            "name",
            "dob",
            "gender",
            "datingPreferences",
            "bio",
            "photos",
            "interests"
        ];

        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        // Validate name if updated
        if (updates.name !== undefined) {
            const trimmed = String(updates.name).trim();
            if (trimmed.length < 2 || trimmed.length > 100) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Name must be between 2 and 100 characters"
                });
            }
            user.name = trimmed;
        }

        // Validate Date of Birth & 18+ requirement
        if (updates.dob !== undefined) {
            if (!updates.dob) {
                user.dob = undefined;
            } else {
                const parsedDate = new Date(updates.dob);
                if (isNaN(parsedDate.getTime())) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Invalid date of birth format"
                    });
                }

                const age = calculateExactAge(parsedDate);
                if (age === null || age < 18) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "You must be at least 18 years old to use Engaze."
                    });
                }
                if (age > 120) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Please enter a valid date of birth."
                    });
                }
                user.dob = parsedDate;
            }
        }

        // Validate Gender
        if (updates.gender !== undefined) {
            const validGenders = ["male", "female", "non-binary", "other"];
            if (updates.gender && !validGenders.includes(updates.gender)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: `Gender must be one of: ${validGenders.join(", ")}`
                });
            }
            user.gender = updates.gender || undefined;
        }

        // Validate Bio
        if (updates.bio !== undefined) {
            const bioStr = String(updates.bio).trim();
            if (bioStr.length > 500) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Bio cannot exceed 500 characters"
                });
            }
            user.bio = bioStr;
        }

        // Validate Photos array (URLs)
        if (updates.photos !== undefined) {
            if (!Array.isArray(updates.photos)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Photos must be an array of URL strings"
                });
            }
            if (updates.photos.length > 6) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "You can upload a maximum of 6 photos"
                });
            }
            // Sanitize and validate photo URLs
            const validPhotos = [];
            for (const item of updates.photos) {
                const url = String(item).trim();
                if (!url) continue;
                const check = validatePublicPhotoUrl(url);
                if (!check.valid) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: `Invalid photo URL: ${check.error}`
                    });
                }
                validPhotos.push(url);
            }

            user.photos = validPhotos;
        }

        // Validate Interests
        if (updates.interests !== undefined) {
            if (!Array.isArray(updates.interests)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Interests must be an array of strings"
                });
            }
            if (updates.interests.length > 15) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "You can select up to 15 interests"
                });
            }
            user.interests = updates.interests
                .map((item) => String(item).trim())
                .filter((item) => item.length > 0 && item.length <= 30);
        }

        // Validate Dating Preferences
        if (updates.datingPreferences !== undefined) {
            if (typeof updates.datingPreferences !== "object" || updates.datingPreferences === null || Array.isArray(updates.datingPreferences)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "Dating preferences must be an object"
                });
            }

            const validInterestedIn = ["male", "female", "non-binary", "everyone"];
            if (updates.datingPreferences.interestedIn !== undefined) {
                if (!Array.isArray(updates.datingPreferences.interestedIn)) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "interestedIn must be an array"
                    });
                }
                if (updates.datingPreferences.interestedIn.length === 0) {
                    user.datingPreferences.interestedIn = ["everyone"];
                } else {
                    for (const val of updates.datingPreferences.interestedIn) {
                        if (typeof val !== "string" || !validInterestedIn.includes(val)) {
                            return res.status(httpStatus.BAD_REQUEST).json({
                                success: false,
                                message: `Invalid interestedIn value: "${val}". Allowed values: ${validInterestedIn.join(", ")}`
                            });
                        }
                    }
                    user.datingPreferences.interestedIn = updates.datingPreferences.interestedIn;
                }
            }

            if (updates.datingPreferences.ageRange !== undefined) {
                if (typeof updates.datingPreferences.ageRange !== "object" || updates.datingPreferences.ageRange === null || Array.isArray(updates.datingPreferences.ageRange)) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "ageRange must be an object with min and/or max properties"
                    });
                }
                const { min, max } = updates.datingPreferences.ageRange;
                const currentMin = user.datingPreferences?.ageRange?.min ?? 18;
                const currentMax = user.datingPreferences?.ageRange?.max ?? 100;
                let targetMin = currentMin;
                let targetMax = currentMax;

                if (min !== undefined) {
                    const minAge = typeof min === "number" ? min : parseInt(min, 10);
                    if (isNaN(minAge) || !Number.isInteger(minAge) || minAge < 18 || minAge > 120) {
                        return res.status(httpStatus.BAD_REQUEST).json({
                            success: false,
                            message: "Minimum age preference must be an integer between 18 and 120"
                        });
                    }
                    targetMin = minAge;
                }

                if (max !== undefined) {
                    const maxAge = typeof max === "number" ? max : parseInt(max, 10);
                    if (isNaN(maxAge) || !Number.isInteger(maxAge) || maxAge < 18 || maxAge > 120) {
                        return res.status(httpStatus.BAD_REQUEST).json({
                            success: false,
                            message: "Maximum age preference must be an integer between 18 and 120"
                        });
                    }
                    targetMax = maxAge;
                }

                if (targetMin > targetMax) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: "Minimum age preference cannot exceed maximum age preference"
                    });
                }

                user.datingPreferences.ageRange = {
                    min: targetMin,
                    max: targetMax
                };
            }
        }

        // Automatic profile completion check evaluated purely from profile fields & age policy
        const completion = evaluateProfileCompleteness(user);
        user.isProfileComplete = completion.isComplete;

        await user.save();

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Profile updated successfully",
            profile: user.toJSON()
        });
    } catch (e) {
        console.error("Update profile error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to update profile. Please try again."
        });
    }
};

// Helper: Generate a unique, sanitized username for new Google users
const generateUniqueUsername = async (candidate) => {
    let clean = (candidate || "user")
        .toLowerCase()
        .replace(/[^a-zA-Z0-9_.-]/g, "")
        .replace(/^[^a-zA-Z0-9]+/, "")
        .slice(0, 20);

    if (clean.length < 3) {
        clean = `user_${Math.random().toString(36).substring(2, 7)}`;
    }

    let username = clean;
    let counter = 1;
    while (await User.findOne({ username })) {
        const suffix = `_${counter}`;
        username = `${clean.slice(0, 30 - suffix.length)}${suffix}`;
        counter++;
    }
    return username;
};

// ==========================================
// 6. GOOGLE AUTHENTICATION (LOGIN & SIGNUP)
// ==========================================
const googleLogin = async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Google ID token is required",
        });
    }

    const configuredClientId = process.env.GOOGLE_CLIENT_ID;
    if (!configuredClientId) {
        console.error("GOOGLE_CLIENT_ID is not configured in backend environment variables.");
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Google Authentication is not configured on the server",
        });
    }

    try {
        const client = new OAuth2Client(configuredClientId);
        const ticket = await client.verifyIdToken({
            idToken,
            audience: configuredClientId,
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.sub) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Invalid Google token payload",
            });
        }

        const googleId = payload.sub;
        const email = payload.email ? payload.email.toLowerCase().trim() : null;
        const name = payload.name || payload.given_name || "Google User";
        const picture = payload.picture || null;

        // 1. Check if user already exists with this verified googleId
        let user = await User.findOne({ googleId });

        if (user) {
            // Enforce account moderation status on Google login
            const accountStatus = evaluateAccountStatus(user);
            if (!accountStatus.allowed) {
                const isBanned = accountStatus.status === "banned";
                return res.status(httpStatus.FORBIDDEN).json({
                    success: false,
                    message: isBanned
                        ? "Your account has been permanently banned."
                        : `Your account is temporarily suspended until ${user.suspensionExpiresAt ? new Date(user.suspensionExpiresAt).toISOString() : "further notice"}. Reason: ${user.suspensionReason || "Policy violation"}`,
                    code: isBanned ? "ACCOUNT_BANNED" : "ACCOUNT_SUSPENDED",
                    reason: accountStatus.reason,
                    expiresAt: accountStatus.expiresAt,
                });
            }

            if (accountStatus.wasExpired) {
                user.status = "active";
                user.suspensionExpiresAt = null;
                user.suspensionReason = null;
                await user.save();
            }

            const token = generateToken(user);
            if ((!user.photos || user.photos.length === 0) && picture) {
                user.photos = [picture];
                await user.save();
            }

            const requiresUsernameSetup = user.usernameSetupCompleted === false;

            return res.status(httpStatus.OK).json({
                success: true,
                message: "Google authentication successful",
                token,
                requiresUsernameSetup,
                user: user.toJSON(),
            });
        }

        // 2. Safe account linking: prevent collision with existing password-based accounts
        if (email) {
            const existingEmailUser = await User.findOne({ email });
            if (existingEmailUser) {
                if (existingEmailUser.googleId && existingEmailUser.googleId !== googleId) {
                    return res.status(httpStatus.CONFLICT).json({
                        success: false,
                        message: "This email is associated with a different Google account.",
                    });
                }
                // Do not automatically link if account was registered with password
                if (!existingEmailUser.googleId) {
                    return res.status(httpStatus.CONFLICT).json({
                        success: false,
                        message: "An account with this email already exists using password sign-in. Please log in with your username and password.",
                    });
                }
            }
        }

        // 3. New Google User Signup: Create user record with usernameSetupCompleted: false
        // Generate a temporary unique handle until the user selects their preferred permanent username
        const tempHandle = `user_${googleId.slice(-6)}_${Math.random().toString(36).substring(2, 6)}`;
        const normalizedTemp = tempHandle.toLowerCase();

        const newUser = new User({
            name: name.slice(0, 100),
            username: tempHandle,
            normalizedUsername: normalizedTemp,
            email: email || undefined,
            googleId,
            authProvider: "google",
            photos: picture ? [picture] : [],
            isProfileComplete: false,
            usernameSetupCompleted: false,
            usernameLastChangedAt: null,
        });

        const token = generateToken(newUser);
        await newUser.save();

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: "Google account created successfully. Please choose your username.",
            token,
            isNewUser: true,
            requiresUsernameSetup: true,
            user: newUser.toJSON(),
        });
    } catch (err) {
        console.error("Google authentication error:", err.message);
        if (err.code === "ENOTFOUND" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
            return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
                success: false,
                message: "Unable to reach Google authentication servers. Please try again later.",
            });
        }

        return res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            message: "Google token verification failed or expired. Please try again.",
        });
    }
};

// ==========================================
// 6. GET USER PRIVACY SETTINGS
// ==========================================
const getPrivacySettings = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select("privacySettings");
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found",
            });
        }

        const defaultSettings = {
            lastSeen: "everyone",
            lastSeenExceptions: [],
            online: "everyone",
        };

        const privacySettings = {
            lastSeen: user.privacySettings?.lastSeen || defaultSettings.lastSeen,
            lastSeenExceptions: user.privacySettings?.lastSeenExceptions || defaultSettings.lastSeenExceptions,
            online: user.privacySettings?.online || defaultSettings.online,
        };

        return res.status(httpStatus.OK).json({
            success: true,
            privacySettings,
        });
    } catch (e) {
        console.error("Get privacy settings error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to load privacy settings",
        });
    }
};

// ==========================================
// 7. UPDATE USER PRIVACY SETTINGS
// ==========================================
const updatePrivacySettings = async (req, res) => {
    try {
        const { lastSeen, lastSeenExceptions, online } = req.body;

        const allowedLastSeen = ["everyone", "matches", "matches_except", "nobody"];
        const allowedOnline = ["everyone", "same_as_last_seen"];

        if (lastSeen !== undefined && !allowedLastSeen.includes(lastSeen)) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: `lastSeen must be one of: ${allowedLastSeen.join(", ")}`,
            });
        }

        if (online !== undefined && !allowedOnline.includes(online)) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: `online must be one of: ${allowedOnline.join(", ")}`,
            });
        }

        let validatedExceptions = undefined;
        if (lastSeenExceptions !== undefined) {
            if (!Array.isArray(lastSeenExceptions)) {
                return res.status(httpStatus.BAD_REQUEST).json({
                    success: false,
                    message: "lastSeenExceptions must be an array of user IDs",
                });
            }

            for (const id of lastSeenExceptions) {
                if (!mongoose.Types.ObjectId.isValid(id)) {
                    return res.status(httpStatus.BAD_REQUEST).json({
                        success: false,
                        message: `Invalid user ID in lastSeenExceptions: ${id}`,
                    });
                }
            }
            validatedExceptions = lastSeenExceptions;
        }

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found",
            });
        }

        if (!user.privacySettings) {
            user.privacySettings = {
                lastSeen: "everyone",
                lastSeenExceptions: [],
                online: "everyone",
            };
        }

        if (lastSeen !== undefined) user.privacySettings.lastSeen = lastSeen;
        if (validatedExceptions !== undefined) user.privacySettings.lastSeenExceptions = validatedExceptions;
        if (online !== undefined) user.privacySettings.online = online;

        await user.save();

        // Broadcast updated presence to active matches if socket IO is available
        try {
            const io = getIO();
            if (io) {
                const userMatches = await Match.find({ users: user._id, status: "active" }).populate("users", "privacySettings lastSeenAt");
                for (const match of userMatches) {
                    const partner = match.users.find((u) => u && u._id.toString() !== user._id.toString());
                    if (partner) {
                        const presence = await getPresenceForViewer(user, partner, true);
                        io.to(`user:${partner._id.toString()}`).emit("presence:update", {
                            userId: user._id.toString(),
                            isOnline: presence.isOnline,
                            lastSeenAt: presence.lastSeenAt,
                        });
                    }
                }
            }
        } catch (socketErr) {
            console.error("Error broadcasting privacy setting update to sockets:", socketErr);
        }

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Privacy settings updated successfully",
            privacySettings: user.privacySettings,
        });
    } catch (e) {
        console.error("Update privacy settings error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to update privacy settings",
        });
    }
};

// ==========================================
// 7. CHECK USERNAME AVAILABILITY
// ==========================================
const checkUsernameAvailability = async (req, res) => {
    try {
        const rawUsername = req.query.username;
        if (!rawUsername) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                available: false,
                message: "Username parameter is required.",
            });
        }

        const validation = validateUsername(rawUsername);
        if (!validation.valid) {
            return res.status(httpStatus.OK).json({
                success: true,
                available: false,
                message: validation.error,
            });
        }

        // If user is authenticated and checking their own username
        if (req.user && req.user.normalizedUsername === validation.normalized) {
            return res.status(httpStatus.OK).json({
                success: true,
                available: true,
                isCurrent: true,
                message: "This is your current username.",
            });
        }

        const existing = await User.findOne({ normalizedUsername: validation.normalized }).select("_id").lean();
        if (existing) {
            const suggestions = await generateUsernameSuggestions(validation.trimmed, async (candidateNormalized) => {
                const found = await User.findOne({ normalizedUsername: candidateNormalized }).select("_id").lean();
                return !found;
            });

            return res.status(httpStatus.OK).json({
                success: true,
                available: false,
                message: "Username is already taken.",
                suggestions,
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            available: true,
            message: "Username is available!",
        });
    } catch (err) {
        console.error("Check username availability error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to check username availability.",
        });
    }
};

// ==========================================
// 8. SETUP INITIAL USERNAME (FIRST-TIME USERS)
// ==========================================
const setupInitialUsername = async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Username is required.",
            });
        }

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User account not found.",
            });
        }

        // If already completed initial setup, reject redundant setup calls
        if (user.usernameSetupCompleted) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Initial username setup has already been completed.",
                user: user.toJSON(),
            });
        }

        const validation = validateUsername(username);
        if (!validation.valid) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: validation.error,
            });
        }

        const existing = await User.findOne({
            normalizedUsername: validation.normalized,
            _id: { $ne: user._id },
        }).select("_id").lean();

        if (existing) {
            const suggestions = await generateUsernameSuggestions(validation.trimmed, async (candidateNormalized) => {
                const found = await User.findOne({ normalizedUsername: candidateNormalized }).select("_id").lean();
                return !found;
            });

            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "Username is already taken.",
                suggestions,
            });
        }

        user.username = validation.trimmed;
        user.normalizedUsername = validation.normalized;
        user.usernameSetupCompleted = true;
        user.usernameSetupCompletedAt = new Date();
        user.usernameLastChangedAt = null; // First subsequent change remains unlocked!
        await user.save();

        const token = generateToken(user);

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Username configured successfully!",
            token,
            user: user.toJSON(),
        });
    } catch (err) {
        console.error("Setup initial username error:", err);
        if (err.code === 11000) {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "Username is already taken. Please choose another.",
            });
        }
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to set up username. Please try again.",
        });
    }
};

// ==========================================
// 9. GET USERNAME CHANGE ELIGIBILITY
// ==========================================
const getUsernameEligibility = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select("username normalizedUsername usernameLastChangedAt usernameSetupCompleted");
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found.",
            });
        }

        const serverTime = new Date();
        const COOLDOWN_DAYS = 14;
        const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

        let canChange = true;
        let nextEligibleAt = null;
        let cooldownDaysRemaining = 0;
        let cooldownHoursRemaining = 0;

        if (user.usernameLastChangedAt) {
            const lastChanged = new Date(user.usernameLastChangedAt).getTime();
            const elapsedMs = serverTime.getTime() - lastChanged;
            if (elapsedMs < COOLDOWN_MS) {
                canChange = false;
                nextEligibleAt = new Date(lastChanged + COOLDOWN_MS);
                const remainingMs = nextEligibleAt.getTime() - serverTime.getTime();
                cooldownDaysRemaining = Math.max(0, Math.floor(remainingMs / (24 * 60 * 60 * 1000)));
                cooldownHoursRemaining = Math.max(0, Math.ceil((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)));
            }
        }

        return res.status(httpStatus.OK).json({
            success: true,
            username: user.username,
            canChange,
            usernameLastChangedAt: user.usernameLastChangedAt || null,
            nextEligibleAt,
            cooldownDaysRemaining,
            cooldownHoursRemaining,
            serverTime,
        });
    } catch (err) {
        console.error("Get username eligibility error:", err);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve username eligibility.",
        });
    }
};

// ==========================================
// 10. UPDATE EXISTING USERNAME (14-DAY COOLDOWN)
// ==========================================
const updateUsername = async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "New username is required.",
            });
        }

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({
                success: false,
                message: "User not found.",
            });
        }

        const validation = validateUsername(username);
        if (!validation.valid) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: validation.error,
            });
        }

        // Must differ from current username
        if (user.normalizedUsername === validation.normalized) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "New username must be different from your current username.",
            });
        }

        // Check if taken by another user
        const existing = await User.findOne({
            normalizedUsername: validation.normalized,
            _id: { $ne: user._id },
        }).select("_id").lean();

        if (existing) {
            const suggestions = await generateUsernameSuggestions(validation.trimmed, async (candidateNormalized) => {
                const found = await User.findOne({ normalizedUsername: candidateNormalized }).select("_id").lean();
                return !found;
            });

            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "Username is already taken.",
                suggestions,
            });
        }

        const serverTime = new Date();
        const COOLDOWN_DAYS = 14;
        const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
        const fourteenDaysAgo = new Date(serverTime.getTime() - COOLDOWN_MS);

        // Atomic check-and-update enforcing 14-day cooldown
        const updatedUser = await User.findOneAndUpdate(
            {
                _id: user._id,
                $or: [
                    { usernameLastChangedAt: null },
                    { usernameLastChangedAt: { $exists: false } },
                    { usernameLastChangedAt: { $lte: fourteenDaysAgo } },
                ],
            },
            {
                $set: {
                    username: validation.trimmed,
                    normalizedUsername: validation.normalized,
                    usernameLastChangedAt: serverTime,
                    usernameSetupCompleted: true,
                },
            },
            { new: true, runValidators: true }
        );

        if (!updatedUser) {
            const lastChanged = new Date(user.usernameLastChangedAt).getTime();
            const nextEligibleAt = new Date(lastChanged + COOLDOWN_MS);
            const remainingMs = Math.max(0, nextEligibleAt.getTime() - serverTime.getTime());
            const remainingDays = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));

            return res.status(httpStatus.TOO_MANY_REQUESTS).json({
                success: false,
                code: "USERNAME_COOLDOWN_ACTIVE",
                message: `You can only change your username once every 14 days. You can change it again in ${remainingDays} day(s).`,
                nextEligibleAt,
                remainingDays,
                serverTime,
            });
        }

        const token = generateToken(updatedUser);

        return res.status(httpStatus.OK).json({
            success: true,
            message: "Username updated successfully!",
            username: updatedUser.username,
            nextEligibleAt: new Date(serverTime.getTime() + COOLDOWN_MS),
            token,
            user: updatedUser.toJSON(),
        });
    } catch (err) {
        console.error("Update username error:", err);
        if (err.code === 11000) {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "Username is already taken. Please choose another.",
            });
        }
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to update username. Please try again.",
        });
    }
};

export {
    login,
    register,
    getMyProfile,
    updateMyProfile,
    googleLogin,
    getPrivacySettings,
    updatePrivacySettings,
    checkUsernameAvailability,
    setupInitialUsername,
    getUsernameEligibility,
    updateUsername,
};