import httpStatus from "http-status";

/**
 * ============================================================================
 * ENGAZE.COM - AGE & PROFILE ELIGIBILITY SERVICE
 * ============================================================================
 * 
 * DISCLAIMER & REGULATORY NOTICE:
 * Self-declared Date of Birth (DOB) collected via user input satisfies Engaze's
 * platform eligibility policy and age-gating baseline, but does NOT constitute
 * cryptographic, biometric, or government-ID-verified age assurance.
 * Full age verification / KYC requires dedicated identity document verification
 * or accredited third-party identity providers.
 * ============================================================================
 */

export const MINIMUM_LEGAL_AGE = 18;
export const MAXIMUM_VALID_AGE = 120;
export const VALID_GENDERS = ["male", "female", "non-binary", "other"];

/**
 * Calculate exact chronological age based on calendar dates using UTC.
 * 
 * Boundary handling:
 * - 17 years 364 days => 17
 * - Exact 18th birthday (00:00:00 UTC) => 18
 * - 18 years 1 day => 18
 * - Leap year births (e.g. Feb 29): Reaches 18 on March 1 in non-leap years.
 * - Future dates or invalid inputs => null
 * 
 * @param {Date|string|number} dob - Date of birth
 * @param {Date|string|number} [referenceDate=new Date()] - Deterministic reference instant (for testing)
 * @returns {number|null} Exact integer age in years, or null if invalid
 */
export function calculateExactAge(dob, referenceDate = new Date()) {
    if (!dob) return null;
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) return null;

    const ref = new Date(referenceDate);
    if (isNaN(ref.getTime())) return null;

    const birthYear = birthDate.getUTCFullYear();
    const birthMonth = birthDate.getUTCMonth();
    const birthDay = birthDate.getUTCDate();

    const refYear = ref.getUTCFullYear();
    const refMonth = ref.getUTCMonth();
    const refDay = ref.getUTCDate();

    let age = refYear - birthYear;
    const monthDiff = refMonth - birthMonth;

    if (monthDiff < 0 || (monthDiff === 0 && refDay < birthDay)) {
        age--;
    }

    if (age < 0) return null; // Future birth date
    return age;
}

/**
 * Authoritatively evaluate whether a user's profile fields and age satisfy
 * dating profile completeness requirements (18+, valid gender, photos, bio).
 * 
 * IMPORTANT: This function evaluates purely the profile field values and age policy.
 * It is deliberately decoupled from the persisted `isProfileComplete` flag to prevent
 * circular dependency during profile onboarding updates.
 * 
 * @param {Object} user - User document or plain object
 * @param {Date|string|number} [referenceDate=new Date()] - Reference instant
 * @returns {{ isComplete: boolean, age: number|null, code: string|null, reason: string|null, missingFields: string[] }}
 */
export function evaluateProfileCompleteness(user, referenceDate = new Date()) {
    if (!user) {
        return {
            isComplete: false,
            age: null,
            code: "USER_NOT_FOUND",
            reason: "User account was not found.",
            missingFields: [],
        };
    }

    const missingFields = [];

    // 1. Name validation
    if (!user.name || typeof user.name !== "string" || user.name.trim().length < 2) {
        missingFields.push("name");
    }

    // 2. Date of birth & age validation
    if (!user.dob) {
        missingFields.push("dob");
    }

    const age = user.dob ? calculateExactAge(user.dob, referenceDate) : null;

    if (user.dob) {
        if (age === null) {
            return {
                isComplete: false,
                age: null,
                code: "INVALID_DOB",
                reason: "Please provide a valid date of birth.",
                missingFields: ["dob"],
            };
        }

        if (age < MINIMUM_LEGAL_AGE) {
            return {
                isComplete: false,
                age,
                code: "UNDERAGE",
                reason: `You must be at least ${MINIMUM_LEGAL_AGE} years old to use Engaze.`,
                missingFields: [],
            };
        }

        if (age > MAXIMUM_VALID_AGE) {
            return {
                isComplete: false,
                age,
                code: "INVALID_DOB",
                reason: "Please provide a valid date of birth.",
                missingFields: ["dob"],
            };
        }
    }

    // 3. Gender validation
    if (!user.gender || !VALID_GENDERS.includes(user.gender)) {
        missingFields.push("gender");
    }

    // 4. Photos validation (at least one valid photo URL)
    if (!Array.isArray(user.photos) || user.photos.length === 0 || !user.photos.some((p) => typeof p === "string" && p.trim().length > 0)) {
        missingFields.push("photos");
    }

    // 5. Bio validation
    if (!user.bio || typeof user.bio !== "string" || user.bio.trim().length === 0) {
        missingFields.push("bio");
    }

    // If DOB was missing
    if (!user.dob) {
        return {
            isComplete: false,
            age: null,
            code: "DOB_REQUIRED",
            reason: "Date of birth is required to verify age eligibility (18+).",
            missingFields,
        };
    }

    // If any required profile fields are missing
    if (missingFields.length > 0) {
        return {
            isComplete: false,
            age,
            code: "PROFILE_INCOMPLETE",
            reason: "Please complete your dating profile to access this feature.",
            missingFields,
        };
    }

    return {
        isComplete: true,
        age,
        code: null,
        reason: null,
        missingFields: [],
    };
}

/**
 * Authoritative check of a user's eligibility for adult dating surfaces
 * (Discovery, Swipe, Matches, Chat, Random Video).
 * 
 * An account is eligible if:
 * 1. Its profile fields and age satisfy completeness policy (evaluateProfileCompleteness).
 * 2. Its persisted `isProfileComplete` flag is true (or not explicitly false).
 * 
 * @param {Object} user - User document or plain object
 * @param {Date|string|number} [referenceDate=new Date()] - Reference instant
 * @param {Object} [options={}]
 * @param {boolean} [options.requirePersistedFlag=true] - Whether to require user.isProfileComplete === true
 * @returns {{ isEligible: boolean, age: number|null, code: string|null, reason: string|null, missingFields: string[] }}
 */
export function checkUserEligibility(user, referenceDate = new Date(), options = {}) {
    if (!user) {
        return {
            isEligible: false,
            age: null,
            code: "USER_NOT_FOUND",
            reason: "User account was not found.",
            missingFields: [],
        };
    }

    if (user.usernameSetupCompleted === false) {
        return {
            isEligible: false,
            age: null,
            code: "USERNAME_SETUP_REQUIRED",
            reason: "Please choose your username before accessing this feature.",
            missingFields: ["username"],
        };
    }

    const evaluation = evaluateProfileCompleteness(user, referenceDate);
    if (!evaluation.isComplete) {
        return {
            isEligible: false,
            age: evaluation.age,
            code: evaluation.code,
            reason: evaluation.reason,
            missingFields: evaluation.missingFields,
        };
    }

    // Gating adult surfaces requires the account's persisted completion flag to be true
    if (options.requirePersistedFlag !== false && user.isProfileComplete === false) {
        return {
            isEligible: false,
            age: evaluation.age,
            code: "PROFILE_INCOMPLETE",
            reason: "Please complete your dating profile to access this feature.",
            missingFields: ["isProfileComplete"],
        };
    }

    return {
        isEligible: true,
        age: evaluation.age,
        code: null,
        reason: null,
        missingFields: [],
    };
}

/**
 * Express middleware to enforce authoritative age & profile eligibility
 * on REST routes.
 */
export const requireEligibility = (req, res, next) => {
    if (!req.user) {
        return res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            code: "UNAUTHORIZED",
            message: "Authentication required to access this resource.",
        });
    }

    const eligibility = checkUserEligibility(req.user);
    if (!eligibility.isEligible) {
        return res.status(httpStatus.FORBIDDEN).json({
            success: false,
            code: eligibility.code,
            message: eligibility.reason,
            missingFields: eligibility.missingFields,
            age: eligibility.age,
        });
    }

    next();
};

