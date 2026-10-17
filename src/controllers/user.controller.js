import httpStatus from "http-status";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { User } from "../models/user.model.js";
import { Meeting } from "../models/meeting.model.js";

const JWT_SECRET = process.env.JWT_SECRET || "engaze_super_secret_jwt_key_2026_dev_secure";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// Helper: Generate JWT token
const generateToken = (user) => {
    return jwt.sign(
        { id: user._id, username: user.username },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
};

// Helper: Calculate age from Date of Birth
const calculateAge = (dob) => {
    if (!dob) return null;
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) return null;

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
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
        const user = await User.findOne({ username: normalizedUsername });

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

        const token = generateToken(user);
        user.token = token;
        await user.save();

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
    const { name, username, password } = req.body;

    if (!name || !username || !password) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "All fields (name, username, password) are required"
        });
    }

    const trimmedName = name.trim();
    const normalizedUsername = username.toLowerCase().trim();

    if (trimmedName.length < 2 || trimmedName.length > 100) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Name must be between 2 and 100 characters"
        });
    }

    if (normalizedUsername.length < 3 || normalizedUsername.length > 30) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Username must be between 3 and 30 characters"
        });
    }

    const usernameRegex = /^[a-zA-Z0-9_.-]+$/;
    if (!usernameRegex.test(normalizedUsername)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Username can only contain alphanumeric characters, underscores, dots, and hyphens"
        });
    }

    if (password.length < 6) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Password must be at least 6 characters long"
        });
    }

    try {
        const existingUser = await User.findOne({ username: normalizedUsername });
        if (existingUser) {
            return res.status(httpStatus.CONFLICT).json({
                success: false,
                message: "Username already exists. Please choose another."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            name: trimmedName,
            username: normalizedUsername,
            password: hashedPassword
        });

        const token = generateToken(newUser);
        newUser.token = token;
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

                const age = calculateAge(parsedDate);
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
            const validPhotos = updates.photos
                .map((url) => String(url).trim())
                .filter((url) => url.length > 0);

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
            if (typeof updates.datingPreferences !== "object" || updates.datingPreferences === null) {
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
                const filtered = updates.datingPreferences.interestedIn.filter((val) =>
                    validInterestedIn.includes(val)
                );
                user.datingPreferences.interestedIn = filtered.length > 0 ? filtered : ["everyone"];
            }

            if (updates.datingPreferences.ageRange !== undefined) {
                const { min, max } = updates.datingPreferences.ageRange;
                if (min !== undefined) {
                    const minAge = parseInt(min, 10);
                    if (isNaN(minAge) || minAge < 18) {
                        return res.status(httpStatus.BAD_REQUEST).json({
                            success: false,
                            message: "Minimum age preference must be at least 18"
                        });
                    }
                    user.datingPreferences.ageRange.min = minAge;
                }
                if (max !== undefined) {
                    const maxAge = parseInt(max, 10);
                    if (isNaN(maxAge) || maxAge > 120 || maxAge < user.datingPreferences.ageRange.min) {
                        return res.status(httpStatus.BAD_REQUEST).json({
                            success: false,
                            message: "Maximum age preference must be greater than minimum age and valid"
                        });
                    }
                    user.datingPreferences.ageRange.max = maxAge;
                }
            }
        }

        // Automatic profile completion check
        const isComplete = Boolean(
            user.name &&
            user.dob &&
            user.gender &&
            user.bio &&
            user.photos &&
            user.photos.length > 0
        );
        user.isProfileComplete = isComplete;

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

// ==========================================
// 5. GET USER HISTORY (Protected)
// ==========================================
const getUserHistory = async (req, res) => {
    try {
        const meetings = await Meeting.find({ user_id: req.user.username }).sort({ date: -1 });
        return res.status(httpStatus.OK).json(meetings);
    } catch (e) {
        console.error("Get user history error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve meeting history"
        });
    }
};

// ==========================================
// 6. ADD TO HISTORY (Protected)
// ==========================================
const addToHistory = async (req, res) => {
    const { meeting_code } = req.body;

    if (!meeting_code || !String(meeting_code).trim()) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Meeting code is required"
        });
    }

    try {
        const newMeeting = new Meeting({
            user_id: req.user.username,
            meetingCode: String(meeting_code).trim()
        });

        await newMeeting.save();

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: "Added code to history",
            meeting: newMeeting
        });
    } catch (e) {
        console.error("Add to history error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to record meeting activity"
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
            const token = generateToken(user);
            user.token = token;
            if ((!user.photos || user.photos.length === 0) && picture) {
                user.photos = [picture];
            }
            await user.save();

            return res.status(httpStatus.OK).json({
                success: true,
                message: "Google authentication successful",
                token,
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

        // 3. New Google User Signup: Create user record
        const baseCandidate = email ? email.split("@")[0] : name;
        const username = await generateUniqueUsername(baseCandidate);

        const newUser = new User({
            name: name.slice(0, 100),
            username,
            email: email || undefined,
            googleId,
            authProvider: "google",
            photos: picture ? [picture] : [],
            isProfileComplete: false,
        });

        const token = generateToken(newUser);
        newUser.token = token;
        await newUser.save();

        return res.status(httpStatus.CREATED).json({
            success: true,
            message: "Google account created successfully",
            token,
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

export {
    login,
    register,
    getMyProfile,
    updateMyProfile,
    getUserHistory,
    addToHistory,
    googleLogin
};