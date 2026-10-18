import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app } from "../src/app.js";
import { Meeting } from "../src/models/meeting.model.js";

describe("Prompt 5: Legacy VideoMeet & Meeting-Room Subsystem Retirement Suite", () => {
    describe("REST API Endpoints Retirement", () => {
        it("POST /api/v1/users/add_to_activity returns 404 (route retired)", async () => {
            const res = await request(app)
                .post("/api/v1/users/add_to_activity")
                .send({ meeting_code: "test-code-123" });

            assert.equal(res.status, 404, "Retired meeting endpoint must respond with 404 Not Found");
        });

        it("GET /api/v1/users/get_all_activity returns 404 (route retired)", async () => {
            const res = await request(app)
                .get("/api/v1/users/get_all_activity");

            assert.equal(res.status, 404, "Retired meeting activity endpoint must respond with 404 Not Found");
        });

        it("Active supported auth and profile endpoints remain registered and operational", async () => {
            // Unauthenticated request to protected profile endpoint correctly returns 401
            const resProfile = await request(app)
                .get("/api/v1/users/profile/me");
            assert.equal(resProfile.status, 401, "Protected profile endpoint must remain active and require auth");

            // Empty login attempt correctly returns 400 Bad Request
            const resLogin = await request(app)
                .post("/api/v1/users/login")
                .send({});
            assert.equal(resLogin.status, 400, "Login endpoint must remain active and validate inputs");
        });
    });

    describe("Database & Model Preservation", () => {
        it("Meeting model exists and preserves schema without dropping collection", () => {
            assert.ok(Meeting, "Meeting model must remain imported and defined");
            assert.equal(typeof Meeting.find, "function", "Meeting.find must remain available for historic data reading");
            assert.equal(typeof Meeting.findOne, "function", "Meeting.findOne must remain available");

            const schema = Meeting.schema;
            assert.ok(schema.path("user_id"), "user_id path must remain in Meeting schema");
            assert.ok(schema.path("meetingCode"), "meetingCode path must remain in Meeting schema");
            assert.ok(schema.path("date"), "date path must remain in Meeting schema");
        });
    });
});

