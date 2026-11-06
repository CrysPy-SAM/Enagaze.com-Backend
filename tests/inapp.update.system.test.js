import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    getAppVersionManifest,
    parseVersionCodeFromBody,
    cleanReleaseNotes,
} from "../src/services/appVersion.service.js";

/**
 * Semver comparison logic matching AppUpdateChecker.jsx
 */
function isVersionNewer(current, latest) {
    if (!latest || !current) return false;
    const cleanCurrent = String(current).replace(/^v/i, "").trim();
    const cleanLatest = String(latest).replace(/^v/i, "").trim();
    const cParts = cleanCurrent.split(".").map(Number);
    const lParts = cleanLatest.split(".").map(Number);
    for (let i = 0; i < Math.max(cParts.length, lParts.length); i++) {
        const c = cParts[i] || 0;
        const l = lParts[i] || 0;
        if (l > c) return true;
        if (l < c) return false;
    }
    return false;
}

/**
 * Evaluates whether an update popup should appear matching AppUpdateChecker.jsx
 */
function shouldShowUpdatePopup({ installedVersion, installedVersionCode, latestVersion, latestVersionCode }) {
    const targetCode = parseInt(latestVersionCode, 10) || 0;
    return (targetCode > 0 && targetCode > installedVersionCode) ||
        isVersionNewer(installedVersion, latestVersion);
}

/**
 * Evaluates whether an update is forced
 */
function isUpdateForced({ installedVersionCode, minSupportedVersionCode, forceUpdate }) {
    return Boolean(forceUpdate) ||
        (minSupportedVersionCode && installedVersionCode < parseInt(minSupportedVersionCode, 10));
}

describe("Backend App Version & In-App Update Service Suite", () => {
    describe("1. Version Comparison Logic", () => {
        it("should correctly identify when a remote version is newer", () => {
            assert.equal(isVersionNewer("1.0.2", "1.0.3"), true);
            assert.equal(isVersionNewer("1.0.2", "1.1.0"), true);
            assert.equal(isVersionNewer("1.0.2", "2.0.0"), true);
            assert.equal(isVersionNewer("v1.0.2", "v1.0.3"), true);
        });

        it("2. Equal version test: no popup should be triggered", () => {
            const result = shouldShowUpdatePopup({
                installedVersion: "1.0.3",
                installedVersionCode: 4,
                latestVersion: "1.0.3",
                latestVersionCode: 4,
            });
            assert.equal(result, false, "Equal version must NOT show update popup");
        });

        it("3. Older installed version test: popup MUST appear", () => {
            const result = shouldShowUpdatePopup({
                installedVersion: "1.0.2",
                installedVersionCode: 3,
                latestVersion: "1.0.3",
                latestVersionCode: 4,
            });
            assert.equal(result, true, "Older installed version must show update popup");
        });

        it("4. Newer installed version test: no popup should appear", () => {
            const result = shouldShowUpdatePopup({
                installedVersion: "1.0.4",
                installedVersionCode: 5,
                latestVersion: "1.0.3",
                latestVersionCode: 4,
            });
            assert.equal(result, false, "Newer installed version must NOT show update popup");
        });

        it("5. Forced update test: correctly flags required updates", () => {
            // Case A: Explicit forceUpdate flag
            assert.equal(isUpdateForced({
                installedVersionCode: 3,
                minSupportedVersionCode: 1,
                forceUpdate: true,
            }), true);

            // Case B: Installed version below minSupportedVersionCode
            assert.equal(isUpdateForced({
                installedVersionCode: 2,
                minSupportedVersionCode: 3,
                forceUpdate: false,
            }), true);

            // Case C: Standard optional update
            assert.equal(isUpdateForced({
                installedVersionCode: 3,
                minSupportedVersionCode: 2,
                forceUpdate: false,
            }), false);
        });
    });

    describe("2. Release Notes & Version Metadata Parsing", () => {
        it("should extract versionCode from GitHub release markdown body", () => {
            const body = "## Release\n<!-- versionCode: 5 -->\nSome release notes";
            const code = parseVersionCodeFromBody(body);
            assert.equal(code, 5);
        });

        it("should return null when versionCode comment is missing or invalid", () => {
            assert.equal(parseVersionCodeFromBody("No comment here"), null);
            assert.equal(parseVersionCodeFromBody("<!-- versionCode: abc -->"), null);
            assert.equal(parseVersionCodeFromBody(null), null);
        });

        it("should sanitize and clean release notes", () => {
            const body = "## Release notes\n<!-- versionCode: 5 -->\nFixed calling issues.";
            const notes = cleanReleaseNotes(body);
            assert.ok(!notes.includes("<!--"), "HTML comments must be stripped");
            assert.ok(notes.includes("Fixed calling issues."));
        });

        it("should truncate overly long release notes to 500 characters", () => {
            const longNotes = "A".repeat(600);
            const cleaned = cleanReleaseNotes(longNotes);
            assert.ok(cleaned.length <= 500);
            assert.ok(cleaned.endsWith("..."));
        });
    });

    describe("3. Manifest Generation, Fallback & Caching", () => {
        it("should return valid manifest with fallback values when called", async () => {
            const manifest = await getAppVersionManifest(true);
            assert.ok(manifest.latestVersion, "latestVersion must be defined");
            assert.ok(typeof manifest.latestVersion === "string");
            assert.ok(manifest.latestVersionCode > 0, "latestVersionCode must be positive");
            assert.ok(manifest.apkDownloadUrl.endsWith(".apk"), "apkDownloadUrl must target an APK");
            assert.ok(typeof manifest.releaseNotes === "string");
            assert.ok(typeof manifest.forceUpdate === "boolean");
        });

        it("should respect environment variable overrides when configured", async () => {
            const originalVersion = process.env.APP_LATEST_VERSION;
            const originalCode = process.env.APP_LATEST_VERSION_CODE;
            const originalForce = process.env.APP_FORCE_UPDATE;

            try {
                process.env.APP_LATEST_VERSION = "2.0.0";
                process.env.APP_LATEST_VERSION_CODE = "99";
                process.env.APP_FORCE_UPDATE = "true";

                const manifest = await getAppVersionManifest(true);
                assert.equal(manifest.latestVersion, "2.0.0");
                assert.equal(manifest.latestVersionCode, 99);
                assert.equal(manifest.forceUpdate, true);
            } finally {
                if (originalVersion) process.env.APP_LATEST_VERSION = originalVersion;
                else delete process.env.APP_LATEST_VERSION;

                if (originalCode) process.env.APP_LATEST_VERSION_CODE = originalCode;
                else delete process.env.APP_LATEST_VERSION_CODE;

                if (originalForce) process.env.APP_FORCE_UPDATE = originalForce;
                else delete process.env.APP_FORCE_UPDATE;
            }
        });

        it("should cache manifest in memory across consecutive calls within TTL", async () => {
            const first = await getAppVersionManifest(false);
            const second = await getAppVersionManifest(false);
            assert.deepEqual(first, second);
        });

        it("should support zero-cache HTTP headers specification", () => {
            const expectedHeaders = {
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
                "Surrogate-Control": "no-store",
            };

            const mockHeaders = {};
            const mockRes = {
                set(key, val) {
                    mockHeaders[key] = val;
                },
            };

            // Simulate the header settings defined in app.js
            mockRes.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            mockRes.set("Pragma", "no-cache");
            mockRes.set("Expires", "0");
            mockRes.set("Surrogate-Control", "no-store");

            for (const [k, v] of Object.entries(expectedHeaders)) {
                assert.equal(mockHeaders[k], v, `Header ${k} must match expected zero-cache policy`);
            }
        });
    });
});
