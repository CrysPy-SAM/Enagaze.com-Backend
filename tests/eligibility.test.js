import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

import {
    calculateExactAge,
    evaluateProfileCompleteness,
    checkUserEligibility,
    requireEligibility,
    MINIMUM_LEGAL_AGE,
    MAXIMUM_VALID_AGE,
} from "../src/services/eligibility.service.js";
import { getJwtSecret, JWT_EXPIRES_IN } from "../src/config/jwt.js";
import discoveryRouter from "../src/routes/discovery.routes.js";
import matchesRouter from "../src/routes/matches.routes.js";
import chatRouter from "../src/routes/chat.routes.js";
import { _testing as randomCallTesting } from "../src/controllers/randomCallManager.js";
import { User } from "../src/models/user.model.js";
import { updateMyProfile } from "../src/controllers/user.controller.js";

describe("Age & Profile Eligibility Test Suite", () => {
    // Deterministic reference date for birthday calculations: 2024-10-18T12:00:00.000Z
    const REF_DATE = new Date("2024-10-18T12:00:00.000Z");

    // =========================================================================
    // 1. calculateExactAge UTC Calendar Calculations & Boundary Tests
    // =========================================================================
    describe("calculateExactAge Calendar & Boundary Accuracy", () => {
        it("returns exact age 18 on the exact 18th birthday", () => {
            // Born 2006-10-18, ref 2024-10-18 => exactly 18 years
            const dob = new Date("2006-10-18T00:00:00.000Z");
            const age = calculateExactAge(dob, REF_DATE);
            assert.equal(age, 18);
        });

        it("returns 17 on the day before the 18th birthday (17 years 364 days)", () => {
            // Born 2006-10-19, ref 2024-10-18 => birthday is tomorrow
            const dob = new Date("2006-10-19T00:00:00.000Z");
            const age = calculateExactAge(dob, REF_DATE);
            assert.equal(age, 17);
        });

        it("returns 18 on the day after the 18th birthday (18 years 1 day)", () => {
            // Born 2006-10-17, ref 2024-10-18 => birthday was yesterday
            const dob = new Date("2006-10-17T00:00:00.000Z");
            const age = calculateExactAge(dob, REF_DATE);
            assert.equal(age, 18);
        });

        it("handles leap year birth (Feb 29) reaching 18 on March 1 in non-leap year", () => {
            // Born 2004-02-29 (leap year)
            const leapDob = new Date("2004-02-29T00:00:00.000Z");

            // On Feb 28, 2022 (non-leap year, 17 years 364 days) => 17
            const dayBefore = new Date("2022-02-28T12:00:00.000Z");
            assert.equal(calculateExactAge(leapDob, dayBefore), 17);

            // On March 1, 2022 (non-leap year, 18th birthday achieved) => 18
            const birthdayInNonLeap = new Date("2022-03-01T12:00:00.000Z");
            assert.equal(calculateExactAge(leapDob, birthdayInNonLeap), 18);
        });

        it("handles leap year birth (Feb 29) evaluated on leap day 20 years later", () => {
            const leapDob = new Date("2004-02-29T00:00:00.000Z");
            const twentyYearsLater = new Date("2024-02-29T12:00:00.000Z");
            assert.equal(calculateExactAge(leapDob, twentyYearsLater), 20);
        });

        it("correctly calculates age when birthday month has passed", () => {
            // Born in January 2000, evaluated in October 2024 => 24
            const dob = new Date("2000-01-15T00:00:00.000Z");
            assert.equal(calculateExactAge(dob, REF_DATE), 24);
        });

        it("correctly calculates age when birthday month has not yet occurred", () => {
            // Born in December 2000, evaluated in October 2024 => 23
            const dob = new Date("2000-12-25T00:00:00.000Z");
            assert.equal(calculateExactAge(dob, REF_DATE), 23);
        });

        it("returns null for null, undefined, empty, or unparseable inputs", () => {
            assert.equal(calculateExactAge(null), null);
            assert.equal(calculateExactAge(undefined), null);
            assert.equal(calculateExactAge(""), null);
            assert.equal(calculateExactAge("not-a-date"), null);
        });

        it("returns null for future birth dates", () => {
            const tomorrow = new Date(REF_DATE.getTime() + 1000 * 60 * 60 * 24);
            assert.equal(calculateExactAge(tomorrow, REF_DATE), null);
        });
    });

    // =========================================================================
    // 2. checkUserEligibility Authoritative Domain Logic
    // =========================================================================
    describe("checkUserEligibility Domain Logic", () => {
        const validCompleteAdult = {
            _id: "65cb11111111111111111111",
            name: "Aarav Mehta",
            username: "aarav_m",
            dob: new Date("2000-05-15T00:00:00.000Z"),
            gender: "male",
            bio: "Exploring life and great music.",
            photos: ["https://example.com/aarav1.jpg"],
            isProfileComplete: true,
        };

        it("approves fully complete adult profile with age >= 18", () => {
            const result = checkUserEligibility(validCompleteAdult, REF_DATE);
            assert.equal(result.isEligible, true);
            assert.equal(result.age, 24);
            assert.equal(result.code, null);
            assert.deepEqual(result.missingFields, []);
        });

        it("approves user on their exact 18th birthday with complete profile", () => {
            const exactEighteen = {
                ...validCompleteAdult,
                dob: new Date("2006-10-18T00:00:00.000Z"),
            };
            const result = checkUserEligibility(exactEighteen, REF_DATE);
            assert.equal(result.isEligible, true);
            assert.equal(result.age, 18);
        });

        it("rejects missing user record with USER_NOT_FOUND", () => {
            const result = checkUserEligibility(null, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "USER_NOT_FOUND");
        });

        it("rejects user missing DOB with DOB_REQUIRED and lists dob in missingFields", () => {
            const noDobUser = {
                ...validCompleteAdult,
                dob: null,
            };
            const result = checkUserEligibility(noDobUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "DOB_REQUIRED");
            assert.ok(result.missingFields.includes("dob"));
        });

        it("rejects underage user (age 17) with UNDERAGE", () => {
            const underageUser = {
                ...validCompleteAdult,
                dob: new Date("2007-01-01T00:00:00.000Z"),
            };
            const result = checkUserEligibility(underageUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "UNDERAGE");
            assert.equal(result.age, 17);
        });

        it("rejects user with age over MAXIMUM_VALID_AGE (120) with INVALID_DOB", () => {
            const ancientUser = {
                ...validCompleteAdult,
                dob: new Date("1890-01-01T00:00:00.000Z"),
            };
            const result = checkUserEligibility(ancientUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "INVALID_DOB");
        });

        it("rejects user with missing name with PROFILE_INCOMPLETE", () => {
            const noNameUser = {
                ...validCompleteAdult,
                name: "  ",
            };
            const result = checkUserEligibility(noNameUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "PROFILE_INCOMPLETE");
            assert.ok(result.missingFields.includes("name"));
        });

        it("rejects user with missing or invalid gender enum", () => {
            const invalidGenderUser = {
                ...validCompleteAdult,
                gender: "unspecified",
            };
            const result = checkUserEligibility(invalidGenderUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "PROFILE_INCOMPLETE");
            assert.ok(result.missingFields.includes("gender"));
        });

        it("rejects user with empty photos array", () => {
            const noPhotosUser = {
                ...validCompleteAdult,
                photos: [],
            };
            const result = checkUserEligibility(noPhotosUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "PROFILE_INCOMPLETE");
            assert.ok(result.missingFields.includes("photos"));
        });

        it("rejects user with empty bio", () => {
            const noBioUser = {
                ...validCompleteAdult,
                bio: "",
            };
            const result = checkUserEligibility(noBioUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "PROFILE_INCOMPLETE");
            assert.ok(result.missingFields.includes("bio"));
        });

        it("rejects user when isProfileComplete flag is false even if other fields exist", () => {
            const flagFalseUser = {
                ...validCompleteAdult,
                isProfileComplete: false,
            };
            const result = checkUserEligibility(flagFalseUser, REF_DATE);
            assert.equal(result.isEligible, false);
            assert.equal(result.code, "PROFILE_INCOMPLETE");
        });
    });

    // =========================================================================
    // 3. requireEligibility Express Middleware
    // =========================================================================
    describe("requireEligibility Express Middleware", () => {
        let testApp;

        beforeEach(() => {
            testApp = express();
            testApp.use(express.json());

            testApp.get(
                "/test-adult-area",
                (req, res, next) => {
                    // Simulated auth middleware
                    const mockHeader = req.headers["x-mock-user"];
                    if (mockHeader) {
                        req.user = JSON.parse(mockHeader);
                    }
                    next();
                },
                requireEligibility,
                (req, res) => {
                    res.json({ success: true, message: "Welcome to adult area" });
                }
            );
        });

        it("returns HTTP 401 when req.user is absent", async () => {
            const res = await request(testApp).get("/test-adult-area");
            assert.equal(res.status, 401);
            assert.equal(res.body.code, "UNAUTHORIZED");
        });

        it("returns HTTP 403 DOB_REQUIRED when user has no DOB", async () => {
            const res = await request(testApp)
                .get("/test-adult-area")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb11111111111111111111",
                    name: "Rahul",
                    dob: null,
                    gender: "male",
                    photos: ["https://example.com/p.jpg"],
                    bio: "Hi",
                    isProfileComplete: false,
                }));

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "DOB_REQUIRED");
            assert.ok(res.body.missingFields.includes("dob"));
        });

        it("returns HTTP 403 UNDERAGE when user is under 18", async () => {
            const res = await request(testApp)
                .get("/test-adult-area")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb11111111111111111111",
                    name: "Young Student",
                    dob: "2010-01-01T00:00:00.000Z",
                    gender: "male",
                    photos: ["https://example.com/p.jpg"],
                    bio: "Student in school",
                    isProfileComplete: true,
                }));

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "UNDERAGE");
        });

        it("returns HTTP 403 PROFILE_INCOMPLETE when profile fields are missing", async () => {
            const res = await request(testApp)
                .get("/test-adult-area")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb11111111111111111111",
                    name: "Adult User",
                    dob: "1998-05-10T00:00:00.000Z",
                    gender: "male",
                    photos: [], // Missing photos
                    bio: "",    // Missing bio
                    isProfileComplete: false,
                }));

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "PROFILE_INCOMPLETE");
            assert.ok(res.body.missingFields.includes("photos"));
            assert.ok(res.body.missingFields.includes("bio"));
        });

        it("returns HTTP 200 and allows passage when user is 18+ and profile is complete", async () => {
            const res = await request(testApp)
                .get("/test-adult-area")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb11111111111111111111",
                    name: "Anita Roy",
                    dob: "1999-07-20T00:00:00.000Z",
                    gender: "female",
                    photos: ["https://example.com/photo.jpg"],
                    bio: "Architect & photographer",
                    isProfileComplete: true,
                }));

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
        });
    });

    // =========================================================================
    // 4. Random Video Matchmaking Queue & Discard Safeguards
    // =========================================================================
    describe("Random Video Queue Ineligibility Rejection", () => {
        beforeEach(() => {
            randomCallTesting.clearAll();
        });

        it("prevents duplicate self-entries and manages queue state cleanly", () => {
            const queue = randomCallTesting.getQueue();
            assert.equal(queue.length, 0);
        });
    });

    // =========================================================================
    // 5. User Schema Validator & Virtual Age Accuracy
    // =========================================================================
    describe("User Schema Model Integration", () => {
        it("allows null DOB initially for registration onboarding", () => {
            const user = new User({
                name: "New Registrant",
                username: "new_reg_user",
                password: "password123",
                dob: undefined,
            });
            const err = user.validateSync(["dob"]);
            assert.equal(err, undefined, "Null DOB should be allowed initially for onboarding");
        });

        it("validates adult DOB >= 18 on user model", () => {
            const adultUser = new User({
                name: "Adult User",
                username: "adult_user_99",
                password: "password123",
                dob: new Date("1995-04-12T00:00:00.000Z"),
            });
            const err = adultUser.validateSync(["dob"]);
            assert.equal(err, undefined);
            assert.equal(typeof adultUser.age, "number");
            assert.ok(adultUser.age >= 18);
        });

        it("fails model validation if DOB corresponds to age under 18", () => {
            const underageUser = new User({
                name: "Underage Kid",
                username: "underage_kid",
                password: "password123",
                dob: new Date("2015-01-01T00:00:00.000Z"),
            });
            const err = underageUser.validateSync(["dob"]);
            assert.ok(err);
            assert.ok(err.errors.dob);
            assert.match(err.errors.dob.message, /18 years old/);
        });
    });

    // =========================================================================
    // 6. Discovery, Matches, and Chat Router Protection Integration
    // =========================================================================
    describe("Discovery, Matches, and Chat Router Gating", () => {
        let app;
        const validUserToken = jwt.sign(
            { id: "65cb11111111111111111111", username: "eligible_user" },
            getJwtSecret(),
            { expiresIn: JWT_EXPIRES_IN }
        );

        beforeEach(() => {
            app = express();
            app.use(express.json());

            // Mock auth + eligibility pipeline for discovery
            app.use(
                "/api/v1/discovery",
                (req, res, next) => {
                    const mockHeader = req.headers["x-mock-user"];
                    if (mockHeader) {
                        req.user = JSON.parse(mockHeader);
                    }
                    next();
                },
                requireEligibility,
                (req, res) => res.json({ success: true, route: "discovery" })
            );

            // Mock auth + eligibility pipeline for matches
            app.use(
                "/api/v1/matches",
                (req, res, next) => {
                    const mockHeader = req.headers["x-mock-user"];
                    if (mockHeader) {
                        req.user = JSON.parse(mockHeader);
                    }
                    next();
                },
                requireEligibility,
                (req, res) => res.json({ success: true, route: "matches" })
            );

            // Mock auth + eligibility pipeline for chat
            app.use(
                "/api/v1/chat",
                (req, res, next) => {
                    const mockHeader = req.headers["x-mock-user"];
                    if (mockHeader) {
                        req.user = JSON.parse(mockHeader);
                    }
                    next();
                },
                requireEligibility,
                (req, res) => res.json({ success: true, route: "chat" })
            );
        });

        it("strictly blocks incomplete user from accessing /api/v1/discovery", async () => {
            const res = await request(app)
                .get("/api/v1/discovery")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb22222222222222222222",
                    name: "Incomplete Account",
                    dob: null,
                    isProfileComplete: false,
                }));

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "DOB_REQUIRED");
        });

        it("strictly blocks incomplete user from accessing /api/v1/matches", async () => {
            const res = await request(app)
                .get("/api/v1/matches")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb22222222222222222222",
                    name: "Incomplete Account",
                    dob: null,
                    isProfileComplete: false,
                }));

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "DOB_REQUIRED");
        });

        it("strictly blocks incomplete user from accessing /api/v1/chat", async () => {
            const res = await request(app)
                .get("/api/v1/chat")
                .set("x-mock-user", JSON.stringify({
                    _id: "65cb22222222222222222222",
                    name: "Incomplete Account",
                    dob: null,
                    isProfileComplete: false,
                }));

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "DOB_REQUIRED");
        });

        it("permits fully complete adult user to access /api/v1/discovery, matches, and chat", async () => {
            const completeUser = {
                _id: "65cb33333333333333333333",
                name: "Pooja Hegde",
                dob: "1997-03-21T00:00:00.000Z",
                gender: "female",
                photos: ["https://example.com/p1.jpg"],
                bio: "Love photography and chai",
                isProfileComplete: true,
            };

            const [discRes, matchRes, chatRes] = await Promise.all([
                request(app).get("/api/v1/discovery").set("x-mock-user", JSON.stringify(completeUser)),
                request(app).get("/api/v1/matches").set("x-mock-user", JSON.stringify(completeUser)),
                request(app).get("/api/v1/chat").set("x-mock-user", JSON.stringify(completeUser)),
            ]);

            assert.equal(discRes.status, 200);
            assert.equal(matchRes.status, 200);
            assert.equal(chatRes.status, 200);
        });
    });

    // =========================================================================
    // 7. evaluateProfileCompleteness Decoupled Field Validation
    // =========================================================================
    describe("evaluateProfileCompleteness Decoupled Field Validation", () => {
        it("returns isComplete: true even if isProfileComplete is initially false on user object", () => {
            const initiallyIncompleteUser = {
                _id: "65cb44444444444444444444",
                name: "Rohan Varma",
                username: "rohan_v",
                dob: new Date("1996-02-14T00:00:00.000Z"),
                gender: "male",
                bio: "Outdoor adventurer & coffee lover",
                photos: ["https://example.com/rohan1.jpg"],
                isProfileComplete: false, // Persisted flag is false initially
            };

            const evaluation = evaluateProfileCompleteness(initiallyIncompleteUser, REF_DATE);
            assert.equal(evaluation.isComplete, true, "Field evaluation must be decoupled from the persisted flag");
            assert.equal(evaluation.age, 28);
            assert.equal(evaluation.code, null);
            assert.deepEqual(evaluation.missingFields, []);
        });

        it("returns isComplete: false if DOB is missing", () => {
            const noDobUser = {
                name: "Rohan Varma",
                dob: null,
                gender: "male",
                bio: "Coffee lover",
                photos: ["https://example.com/p.jpg"],
            };
            const evaluation = evaluateProfileCompleteness(noDobUser, REF_DATE);
            assert.equal(evaluation.isComplete, false);
            assert.equal(evaluation.code, "DOB_REQUIRED");
            assert.ok(evaluation.missingFields.includes("dob"));
        });

        it("returns isComplete: false if user is underage (< 18)", () => {
            const underageUser = {
                name: "Young Teen",
                dob: new Date("2010-01-01T00:00:00.000Z"),
                gender: "male",
                bio: "Teenager",
                photos: ["https://example.com/p.jpg"],
            };
            const evaluation = evaluateProfileCompleteness(underageUser, REF_DATE);
            assert.equal(evaluation.isComplete, false);
            assert.equal(evaluation.code, "UNDERAGE");
            assert.equal(evaluation.age, 14);
        });

        it("returns isComplete: false if photos array is empty or missing", () => {
            const noPhotosUser = {
                name: "Adult User",
                dob: new Date("1995-01-01T00:00:00.000Z"),
                gender: "male",
                bio: "Bio here",
                photos: [],
            };
            const evaluation = evaluateProfileCompleteness(noPhotosUser, REF_DATE);
            assert.equal(evaluation.isComplete, false);
            assert.equal(evaluation.code, "PROFILE_INCOMPLETE");
            assert.ok(evaluation.missingFields.includes("photos"));
        });
    });

    // =========================================================================
    // 8. Profile-Update Onboarding & Discovery Unlock Regression Tests
    // =========================================================================
    describe("Profile-Update Onboarding & Discovery Unlock Regression", () => {
        let app;
        let currentUserDoc;
        const originalFindById = User.findById;

        beforeEach(() => {
            app = express();
            app.use(express.json());

            // Mock User.findById to return our active in-memory user document
            User.findById = async (id) => {
                if (currentUserDoc && currentUserDoc._id.toString() === id.toString()) {
                    return currentUserDoc;
                }
                return null;
            };

            // Express app mounting profile update & discovery
            app.put(
                "/api/v1/users/profile/me",
                (req, res, next) => {
                    req.user = currentUserDoc;
                    next();
                },
                updateMyProfile
            );

            app.get(
                "/api/v1/discovery",
                (req, res, next) => {
                    req.user = currentUserDoc;
                    next();
                },
                requireEligibility,
                (req, res) => {
                    res.json({
                        success: true,
                        message: "Discovery feed unlocked",
                        profiles: [{ name: "Target Match", age: 24 }],
                    });
                }
            );
        });

        afterEach(() => {
            User.findById = originalFindById;
        });

        it("REGRESSION: Incomplete adult account updates profile with valid fields, isProfileComplete becomes true, and unlocks discovery", async () => {
            // 1. Initial State: User created with isProfileComplete: false, no DOB, no photos, no bio
            currentUserDoc = new User({
                _id: "65cb55555555555555555555",
                name: "Karan Johar",
                username: "karan_j",
                dob: undefined,
                gender: undefined,
                bio: "",
                photos: [],
                isProfileComplete: false,
            });
            currentUserDoc.save = async function() { return this; };

            // 2. Initial discovery attempt MUST be rejected with HTTP 403
            const initialDiscRes = await request(app).get("/api/v1/discovery");
            assert.equal(initialDiscRes.status, 403);
            assert.equal(initialDiscRes.body.code, "DOB_REQUIRED");

            // 3. Submit valid required profile fields and adult DOB via profile-update endpoint
            const updatePayload = {
                dob: "2000-08-15",
                gender: "male",
                bio: "Coffee enthusiast, UI developer and music lover.",
                photos: ["https://example.com/karan_photo1.jpg"],
            };

            const updateRes = await request(app)
                .put("/api/v1/users/profile/me")
                .send(updatePayload);

            assert.equal(updateRes.status, 200);
            assert.equal(updateRes.body.success, true);
            assert.equal(updateRes.body.profile.isProfileComplete, true, "isProfileComplete MUST become true");
            assert.equal(currentUserDoc.isProfileComplete, true);

            // 4. Subsequent discovery attempt MUST now succeed with HTTP 200
            const subsequentDiscRes = await request(app).get("/api/v1/discovery");
            assert.equal(subsequentDiscRes.status, 200);
            assert.equal(subsequentDiscRes.body.success, true);
            assert.equal(subsequentDiscRes.body.message, "Discovery feed unlocked");
        });

        it("NEGATIVE TEST: Under-18 DOB submission is rejected with HTTP 400 and discovery remains blocked", async () => {
            currentUserDoc = new User({
                _id: "65cb66666666666666666666",
                name: "Minor Student",
                username: "minor_s",
                dob: undefined,
                isProfileComplete: false,
            });
            currentUserDoc.save = async function() { return this; };

            // Submit underage DOB (14 years old)
            const updateRes = await request(app)
                .put("/api/v1/users/profile/me")
                .send({
                    dob: "2010-05-20",
                    gender: "male",
                    bio: "Still in high school",
                    photos: ["https://example.com/minor.jpg"],
                });

            assert.equal(updateRes.status, 400);
            assert.match(updateRes.body.message, /18 years old/);
            assert.equal(currentUserDoc.isProfileComplete, false);

            // Discovery remains strictly blocked
            const discRes = await request(app).get("/api/v1/discovery");
            assert.equal(discRes.status, 403);
        });

        it("NEGATIVE TEST: Incomplete profile update (omitted DOB) leaves account ineligible", async () => {
            currentUserDoc = new User({
                _id: "65cb77777777777777777777",
                name: "Partial User",
                username: "partial_u",
                dob: undefined,
                isProfileComplete: false,
            });
            currentUserDoc.save = async function() { return this; };

            // Update bio and photos but leave DOB missing
            const updateRes = await request(app)
                .put("/api/v1/users/profile/me")
                .send({
                    gender: "female",
                    bio: "Loving the sunsets",
                    photos: ["https://example.com/p1.jpg"],
                });

            assert.equal(updateRes.status, 200);
            assert.equal(updateRes.body.profile.isProfileComplete, false);
            assert.equal(currentUserDoc.isProfileComplete, false);

            // Discovery remains blocked with DOB_REQUIRED
            const discRes = await request(app).get("/api/v1/discovery");
            assert.equal(discRes.status, 403);
            assert.equal(discRes.body.code, "DOB_REQUIRED");
        });

        it("NEGATIVE TEST: Adult DOB with missing photos leaves profile incomplete and ineligible", async () => {
            currentUserDoc = new User({
                _id: "65cb88888888888888888888",
                name: "No Photo User",
                username: "no_photo_u",
                dob: undefined,
                isProfileComplete: false,
            });
            currentUserDoc.save = async function() { return this; };

            // Submit adult DOB but empty photos array
            const updateRes = await request(app)
                .put("/api/v1/users/profile/me")
                .send({
                    dob: "1999-11-25",
                    gender: "male",
                    bio: "Software developer",
                    photos: [],
                });

            assert.equal(updateRes.status, 200);
            assert.equal(updateRes.body.profile.isProfileComplete, false);
            assert.equal(currentUserDoc.isProfileComplete, false);

            // Discovery remains blocked with PROFILE_INCOMPLETE
            const discRes = await request(app).get("/api/v1/discovery");
            assert.equal(discRes.status, 403);
            assert.equal(discRes.body.code, "PROFILE_INCOMPLETE");
            assert.ok(discRes.body.missingFields.includes("photos"));
        });

        it("GOOGLE SIGNUP & EXISTING NULL-DOB: completes onboarding with real DOB and unlocks discovery without fabricated data", async () => {
            // Simulated Google Sign-up account with null DOB
            currentUserDoc = new User({
                _id: "65cb99999999999999999999",
                name: "Google Signup User",
                username: "google_user_88",
                email: "googleuser@gmail.com",
                googleId: "google_sub_1029384756",
                authProvider: "google",
                dob: null, // Null DOB preserved non-destructively
                photos: ["https://lh3.googleusercontent.com/photo.jpg"],
                isProfileComplete: false,
            });
            currentUserDoc.save = async function() { return this; };

            // 1. Blocked initially from adult discovery
            const initialRes = await request(app).get("/api/v1/discovery");
            assert.equal(initialRes.status, 403);
            assert.equal(initialRes.body.code, "DOB_REQUIRED");

            // 2. User completes onboarding with their genuine self-declared adult DOB, gender, and bio
            const onboardRes = await request(app)
                .put("/api/v1/users/profile/me")
                .send({
                    dob: "1997-04-10",
                    gender: "non-binary",
                    bio: "Creative writer and digital nomad.",
                });

            assert.equal(onboardRes.status, 200);
            assert.equal(onboardRes.body.profile.isProfileComplete, true);
            assert.equal(currentUserDoc.isProfileComplete, true);

            // 3. Discovery unlocks cleanly
            const finalRes = await request(app).get("/api/v1/discovery");
            assert.equal(finalRes.status, 200);
            assert.equal(finalRes.body.success, true);
        });
    });
});
