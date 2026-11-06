import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

describe("In-App Update System Comprehensive Test Suite", () => {
    describe("1. Version Comparison Unit Tests", () => {
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

    describe("6. Backend Version API Manifest & Zero-Cache Tests", () => {
        it("should extract versionCode from GitHub release markdown body", () => {
            const body = "## Release\n<!-- versionCode: 5 -->\nSome release notes";
            const code = parseVersionCodeFromBody(body);
            assert.equal(code, 5);
        });

        it("should sanitize and clean release notes", () => {
            const body = "## Release notes\n<!-- versionCode: 5 -->\nFixed calling issues.";
            const notes = cleanReleaseNotes(body);
            assert.ok(!notes.includes("<!--"), "HTML comments must be stripped");
            assert.ok(notes.includes("Fixed calling issues."));
        });

        it("should return valid manifest with fallback and zero-cache compatibility", async () => {
            const manifest = await getAppVersionManifest(true);
            assert.ok(manifest.latestVersion, "latestVersion must be defined");
            assert.ok(manifest.latestVersionCode > 0, "latestVersionCode must be positive");
            assert.ok(manifest.apkDownloadUrl.endsWith(".apk"), "apkDownloadUrl must target an APK");
            assert.ok(typeof manifest.releaseNotes === "string");
        });
    });

    describe("7. Metadata & Single Source of Truth Verification", () => {
        it("should verify version.json single source of truth exists and is valid", () => {
            const rootVersionPath = path.resolve(process.cwd(), "../frontend/version.json");
            assert.ok(fs.existsSync(rootVersionPath), "frontend/version.json must exist");
            const data = JSON.parse(fs.readFileSync(rootVersionPath, "utf-8"));
            assert.equal(data.versionCode, 4);
            assert.equal(data.versionName, "1.0.3");
        });

        it("11. Package ID verification: Gradle output-metadata.json matches com.engaze.date", () => {
            const metadataPath = path.resolve(process.cwd(), "../frontend/android/app/build/outputs/apk/debug/output-metadata.json");
            assert.ok(fs.existsSync(metadataPath), "output-metadata.json must exist");
            const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
            assert.equal(metadata.applicationId, "com.engaze.date");
            assert.equal(metadata.elements[0].versionCode, 4);
            assert.equal(metadata.elements[0].versionName, "1.0.3");
        });

        it("10. Android debug APK exists and has valid size (> 10MB)", () => {
            const apkPath = path.resolve(process.cwd(), "../frontend/android/app/build/outputs/apk/debug/app-debug.apk");
            assert.ok(fs.existsSync(apkPath), "app-debug.apk must exist");
            const stat = fs.statSync(apkPath);
            assert.ok(stat.size > 10 * 1024 * 1024, `APK size (${stat.size} bytes) should be > 10MB`);
        });

        it("8. Android debug APK is signed with the permanent Engaze certificate SHA-256", () => {
            const apkPath = path.resolve(process.cwd(), "../frontend/android/app/build/outputs/apk/debug/app-debug.apk");
            assert.ok(fs.existsSync(apkPath), "app-debug.apk must exist");
            const buf = fs.readFileSync(apkPath);
            const EXPECTED_SHA256 = "04:CA:D7:6B:10:14:E3:34:F9:26:88:5A:D1:12:78:BA:21:04:6D:A1:52:16:5B:29:D0:68:7C:9A:43:77:F9:D1";
            let actualSha256 = null;

            for (let i = 0; i < buf.length - 1000; i++) {
                if (buf[i] === 0x30 && buf[i+1] === 0x82) {
                    const len = (buf[i+2] << 8) | buf[i+3];
                    if (len > 300 && len < 2500) {
                        try {
                            const certDer = buf.subarray(i, i + 4 + len);
                            const x509 = new crypto.X509Certificate(certDer);
                            if (x509.fingerprint256.toUpperCase().trim() === EXPECTED_SHA256) {
                                actualSha256 = x509.fingerprint256.toUpperCase().trim();
                                break;
                            }
                        } catch (e) {}
                    }
                }
            }
            assert.equal(actualSha256, EXPECTED_SHA256, "Compiled APK must match permanent SHA-256 fingerprint");
        });
    });
});

