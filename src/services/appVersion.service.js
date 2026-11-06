/**
 * App Version & In-App Update Manifest Service
 *
 * Provides synchronized release metadata to Android clients:
 * - Checks GitHub Releases public API for the latest published APK.
 * - Extracts version name, version code, and release notes dynamically.
 * - Enforces zero-caching HTTP headers.
 * - Caches GitHub metadata in-memory (5 min TTL) to stay well within GitHub rate limits.
 * - Gracefully falls back to environment variables and safe defaults if GitHub is unreachable.
 */

let cachedManifest = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const parseVersionCodeFromBody = (body) => {
    if (!body || typeof body !== "string") return null;
    const match = body.match(/<!--\s*versionCode:\s*(\d+)\s*-->/i);
    if (match && match[1]) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
};

export const cleanReleaseNotes = (body) => {
    if (!body || typeof body !== "string") return "Performance enhancements, bug fixes, and reliability improvements.";
    // Strip HTML comments like <!-- versionCode: 4 -->
    let cleaned = body.replace(/<!--[\s\S]*?-->/g, "").trim();
    // Return first 500 characters if overly long
    if (cleaned.length > 500) {
        cleaned = cleaned.substring(0, 497) + "...";
    }
    return cleaned || "Performance enhancements, bug fixes, and reliability improvements.";
};

export const getAppVersionManifest = async (forceRefresh = false) => {
    const now = Date.now();

    // 1. Return fresh in-memory cache if within TTL
    if (!forceRefresh && cachedManifest && now - lastFetchTime < CACHE_TTL_MS) {
        return { ...cachedManifest };
    }

    const envVersion = process.env.APP_LATEST_VERSION;
    const envVersionCode = parseInt(process.env.APP_LATEST_VERSION_CODE || "0", 10);

    // Default baseline fallback
    const fallbackManifest = {
        latestVersion: envVersion || "1.0.3",
        latestVersionCode: envVersionCode > 0 ? envVersionCode : 4,
        minSupportedVersion: process.env.APP_MIN_VERSION || "1.0.0",
        minSupportedVersionCode: parseInt(process.env.APP_MIN_VERSION_CODE || "1", 10),
        apkDownloadUrl: process.env.APP_APK_DOWNLOAD_URL || "https://github.com/CrysPy-SAM/Engaze.com-frontend/releases/latest/download/Engaze.apk",
        releaseNotes: process.env.APP_RELEASE_NOTES || "WhatsApp-style call and message push notifications, custom brand icon, and performance improvements.",
        forceUpdate: process.env.APP_FORCE_UPDATE === "true",
    };

    // 2. Query GitHub Releases API first to detect newly published releases
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const ghResponse = await fetch("https://api.github.com/repos/CrysPy-SAM/Engaze.com-frontend/releases/latest", {
            headers: {
                "User-Agent": "Engaze-Backend-Version-Checker",
                "Accept": "application/vnd.github.v3+json",
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (ghResponse.ok) {
            const release = await ghResponse.json();

            // Verify that Engaze.apk asset was actually published
            const hasApkAsset = Array.isArray(release.assets) &&
                release.assets.some((asset) => asset.name === "Engaze.apk" || asset.name.endsWith(".apk"));

            if (hasApkAsset) {
                const rawTag = release.tag_name || "";
                const cleanTag = rawTag.replace(/^v/i, "").trim() || fallbackManifest.latestVersion;
                const parsedCode = parseVersionCodeFromBody(release.body);

                // Find direct asset download URL if available
                const apkAsset = release.assets.find((a) => a.name === "Engaze.apk") || release.assets[0];
                const downloadUrl = apkAsset?.browser_download_url || fallbackManifest.apkDownloadUrl;

                const ghCode = parsedCode || 0;
                // Prefer GitHub release if it is newer or equal to env var, preventing stale Render env vars from hiding releases
                if (ghCode >= envVersionCode || !envVersionCode) {
                    cachedManifest = {
                        latestVersion: cleanTag,
                        latestVersionCode: ghCode || fallbackManifest.latestVersionCode,
                        minSupportedVersion: fallbackManifest.minSupportedVersion,
                        minSupportedVersionCode: fallbackManifest.minSupportedVersionCode,
                        apkDownloadUrl: downloadUrl,
                        releaseNotes: cleanReleaseNotes(release.body),
                        forceUpdate: fallbackManifest.forceUpdate,
                    };
                    lastFetchTime = now;
                    return { ...cachedManifest };
                }
            }
        }
    } catch {
        // Fall back gracefully to environment variables without crashing
    }

    cachedManifest = fallbackManifest;
    lastFetchTime = now;
    return { ...fallbackManifest };
};

