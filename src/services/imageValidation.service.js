/**
 * Image Validation & Privacy Service
 * Enforces strict raster format allowlists, magic-number inspection, dimension bounds,
 * binary metadata/EXIF stripping, and SSRF-safe URL validation.
 */

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
export const MIN_DIMENSION_PX = 100;
export const MAX_DIMENSION_PX = 4096;

export const ALLOWED_MIME_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

export const DEFAULT_APPROVED_HOSTS = Object.freeze([
    "images.unsplash.com",
    "lh3.googleusercontent.com",
    "res.cloudinary.com",
    "example.com",
]);

/**
 * Detect image MIME type using strict magic bytes inspection.
 * Never trusts file extensions or client-supplied Content-Type headers.
 *
 * @param {Buffer} buffer
 * @returns {string|null} Detected MIME type or null if unsupported
 */
export function detectMimeType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return null;
    }

    // JPEG: 0xFF, 0xD8, 0xFF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return "image/jpeg";
    }

    // PNG: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4E &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0D &&
        buffer[5] === 0x0A &&
        buffer[6] === 0x1A &&
        buffer[7] === 0x0A
    ) {
        return "image/png";
    }

    // WebP: 'RIFF' at 0..3 and 'WEBP' at 8..11
    if (
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        return "image/webp";
    }

    return null;
}

/**
 * Extract image dimensions (width, height) directly from binary stream without external dependencies.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {{ width: number, height: number }|null}
 */
export function extractDimensions(buffer, mimeType) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
        return null;
    }

    try {
        if (mimeType === "image/png") {
            // PNG IHDR chunk is located at byte 8 (length: 4, type 'IHDR': 4, width: 4, height: 4)
            if (buffer.length >= 24 && buffer.toString("ascii", 12, 16) === "IHDR") {
                const width = buffer.readUInt32BE(16);
                const height = buffer.readUInt32BE(20);
                return { width, height };
            }
        } else if (mimeType === "image/jpeg") {
            // Walk JPEG markers to find SOF (Start of Frame)
            let offset = 2; // skip SOI (0xFFD8)
            while (offset < buffer.length - 8) {
                if (buffer[offset] !== 0xFF) {
                    offset++;
                    continue;
                }
                const marker = buffer[offset + 1];
                // Standalone markers without length: RST, SOI, EOI, TEM
                if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
                    offset += 2;
                    continue;
                }
                const segmentLength = buffer.readUInt16BE(offset + 2);
                // SOF markers: 0xC0 (SOF0 baseline), 0xC1, 0xC2 (progressive), 0xC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF
                const isSof = (marker >= 0xC0 && marker <= 0xC3) ||
                              (marker >= 0xC5 && marker <= 0xC7) ||
                              (marker >= 0xC9 && marker <= 0xCB) ||
                              (marker >= 0xCD && marker <= 0xCF);

                if (isSof && offset + 9 <= buffer.length) {
                    const height = buffer.readUInt16BE(offset + 5);
                    const width = buffer.readUInt16BE(offset + 7);
                    return { width, height };
                }

                // Stop if SOS (Start of Scan) is reached without SOF
                if (marker === 0xDA) {
                    break;
                }

                offset += 2 + segmentLength;
            }
        } else if (mimeType === "image/webp") {
            // Check for VP8 / VP8L / VP8X chunk
            let offset = 12;
            while (offset < buffer.length - 8) {
                const chunkHeader = buffer.toString("ascii", offset, offset + 4);
                const chunkSize = buffer.readUInt32LE(offset + 4);
                const chunkDataOffset = offset + 8;

                if (chunkHeader === "VP8 " && buffer.length >= chunkDataOffset + 10) {
                    // Lossy VP8
                    const width = buffer.readUInt16LE(chunkDataOffset + 6) & 0x3fff;
                    const height = buffer.readUInt16LE(chunkDataOffset + 8) & 0x3fff;
                    return { width, height };
                } else if (chunkHeader === "VP8L" && buffer.length >= chunkDataOffset + 5) {
                    // Lossless VP8L
                    const b0 = buffer[chunkDataOffset + 1];
                    const b1 = buffer[chunkDataOffset + 2];
                    const b2 = buffer[chunkDataOffset + 3];
                    const b3 = buffer[chunkDataOffset + 4];
                    const width = 1 + (((b1 & 0x3F) << 8) | b0);
                    const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
                    return { width, height };
                } else if (chunkHeader === "VP8X" && buffer.length >= chunkDataOffset + 10) {
                    // Extended VP8X: 24-bit width-1, 24-bit height-1
                    const width = 1 + (buffer[chunkDataOffset + 4] | (buffer[chunkDataOffset + 5] << 8) | (buffer[chunkDataOffset + 6] << 16));
                    const height = 1 + (buffer[chunkDataOffset + 7] | (buffer[chunkDataOffset + 8] << 8) | (buffer[chunkDataOffset + 9] << 16));
                    return { width, height };
                }

                // Advance by chunk header (8) + chunk size (padded to 2-byte boundary)
                offset += 8 + chunkSize + (chunkSize % 2);
            }
        }
    } catch {
        return null;
    }

    return null;
}

/**
 * Validates an image buffer against byte-size, magic bytes, and dimensions.
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @returns {{ valid: boolean, mimeType?: string, width?: number, height?: number, sizeBytes?: number, error?: string }}
 */
export function validateImageBuffer(buffer, options = {}) {
    const maxBytes = options.maxSizeBytes || MAX_PHOTO_BYTES;
    const minDim = options.minDimension || MIN_DIMENSION_PX;
    const maxDim = options.maxDimension || MAX_DIMENSION_PX;

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { valid: false, error: "Empty or invalid image payload" };
    }

    if (buffer.length > maxBytes) {
        return {
            valid: false,
            error: `Image size exceeds the maximum limit of ${Math.round(maxBytes / (1024 * 1024))}MB`,
        };
    }

    const mimeType = detectMimeType(buffer);
    if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
        return {
            valid: false,
            error: "Unsupported image format. Only JPEG, PNG, and WebP are allowed",
        };
    }

    const dimensions = extractDimensions(buffer, mimeType);
    if (!dimensions) {
        return {
            valid: false,
            error: "Malformed image content. Unable to decode image dimensions",
        };
    }

    const { width, height } = dimensions;
    if (width < minDim || height < minDim) {
        return {
            valid: false,
            error: `Image dimensions (${width}x${height}) are too small. Minimum required: ${minDim}x${minDim}px`,
        };
    }

    if (width > maxDim || height > maxDim) {
        return {
            valid: false,
            error: `Image dimensions (${width}x${height}) exceed the maximum permitted size of ${maxDim}x${maxDim}px`,
        };
    }

    return {
        valid: true,
        mimeType,
        width,
        height,
        sizeBytes: buffer.length,
    };
}

/**
 * Strips EXIF metadata, GPS coordinates, device info, and ancillary comments from binary image buffer.
 *
 * @param {Buffer} buffer
 * @param {string} [mimeType]
 * @returns {Buffer} Sanitized buffer
 */
export function stripMetadata(buffer, mimeType) {
    if (!Buffer.isBuffer(buffer)) {
        return buffer;
    }

    const detectedMime = mimeType || detectMimeType(buffer);

    try {
        if (detectedMime === "image/jpeg") {
            // Strip APP1 (EXIF / GPS) and APP2 segments
            const chunks = [];
            chunks.push(buffer.subarray(0, 2)); // SOI: 0xFF, 0xD8
            let offset = 2;

            while (offset < buffer.length - 1) {
                if (buffer[offset] !== 0xFF) {
                    offset++;
                    continue;
                }
                const marker = buffer[offset + 1];

                // Standalone markers (RST, SOI, EOI)
                if (marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
                    chunks.push(buffer.subarray(offset, offset + 2));
                    offset += 2;
                    continue;
                }

                // If SOS reached, everything else to EOF is image scan data
                if (marker === 0xDA) {
                    chunks.push(buffer.subarray(offset));
                    break;
                }

                if (offset + 4 > buffer.length) break;
                const segmentLen = buffer.readUInt16BE(offset + 2);

                // Skip APP1 (0xE1: EXIF / GPS) and APP2 (0xE2: FlashPix/ICC)
                if (marker === 0xE1 || marker === 0xE2) {
                    offset += 2 + segmentLen;
                    continue;
                }

                // Copy all other safe segments (APP0 JFIF, DQT, DHT, SOF)
                chunks.push(buffer.subarray(offset, offset + 2 + segmentLen));
                offset += 2 + segmentLen;
            }

            return Buffer.concat(chunks);
        } else if (detectedMime === "image/png") {
            // Strip metadata chunks: tEXt, zTXt, iTXt, eXIf
            const strippedChunks = [];
            strippedChunks.push(buffer.subarray(0, 8)); // PNG signature
            let offset = 8;

            while (offset < buffer.length - 8) {
                const chunkLen = buffer.readUInt32BE(offset);
                const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
                const totalChunkLen = 12 + chunkLen;

                if (offset + totalChunkLen > buffer.length) {
                    break;
                }

                const isMetadata = ["tEXt", "zTXt", "iTXt", "eXIf"].includes(chunkType);
                if (!isMetadata) {
                    strippedChunks.push(buffer.subarray(offset, offset + totalChunkLen));
                }

                offset += totalChunkLen;
                if (chunkType === "IEND") {
                    break;
                }
            }

            return Buffer.concat(strippedChunks);
        } else if (detectedMime === "image/webp") {
            // Strip EXIF and XMP chunks from WebP RIFF
            const chunks = [];
            chunks.push(buffer.subarray(0, 12)); // RIFF header + WEBP
            let offset = 12;

            while (offset < buffer.length - 8) {
                const tag = buffer.toString("ascii", offset, offset + 4);
                const size = buffer.readUInt32LE(offset + 4);
                const totalChunkSize = 8 + size + (size % 2);

                if (offset + totalChunkSize > buffer.length) {
                    break;
                }

                // Skip EXIF / XMP chunks
                if (tag !== "EXIF" && tag !== "XMP ") {
                    chunks.push(buffer.subarray(offset, offset + totalChunkSize));
                }

                offset += totalChunkSize;
            }

            const combined = Buffer.concat(chunks);
            // Re-write total RIFF length at offset 4..7
            if (combined.length >= 8) {
                combined.writeUInt32LE(combined.length - 8, 4);
            }

            // In extended WebP (VP8X), clear EXIF (bit 3: 0x08) and XMP (bit 2: 0x04) feature flags
            // VP8X chunk header is at offset 12..16, flags byte is at byte 20 (offset 12 + 8)
            if (combined.length >= 21 && combined.toString("ascii", 12, 16) === "VP8X") {
                const flags = combined.readUInt8(20);
                combined.writeUInt8(flags & ~(0x08 | 0x04), 20);
            }

            return combined;
        }
    } catch {
        // Fallback to original buffer if stripping encounters non-fatal parse anomaly
        return buffer;
    }

    return buffer;
}

/**
 * Validates a profile photo URL against approved storage hosts, protocols, and SSRF rules.
 *
 * @param {string} urlString
 * @param {object} [options]
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePublicPhotoUrl(urlString, options = {}) {
    if (typeof urlString !== "string" || urlString.trim().length === 0) {
        return { valid: false, error: "Photo URL cannot be empty" };
    }

    const trimmed = urlString.trim();

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return { valid: false, error: "Malformed URL syntax" };
    }

    const isDev = process.env.NODE_ENV !== "production";

    // Enforce HTTPS in production. In development/testing, allow localhost HTTP.
    if (parsed.protocol !== "https:") {
        if (!isDev || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
            return { valid: false, error: "Photo URL must use secure HTTPS protocol" };
        }
        if (isDev && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
            return { valid: false, error: "Photo URL must use secure HTTPS protocol" };
        }
    }

    // Reject embedded credentials (e.g. https://user:pass@evil.com/...)
    if (parsed.username || parsed.password) {
        return { valid: false, error: "Photo URLs must not contain embedded user credentials" };
    }

    const host = parsed.hostname.toLowerCase();

    // Block SSRF / Private IP addresses
    const isIpV4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
    if (isIpV4) {
        const parts = host.split(".").map(Number);
        const isLoopback = parts[0] === 127;
        const isPrivateA = parts[0] === 10;
        const isPrivateB = parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
        const isPrivateC = parts[0] === 192 && parts[1] === 168;
        const isLinkLocal = parts[0] === 169 && parts[1] === 254; // AWS/Cloud metadata service

        if (!isDev && isLoopback) {
            return { valid: false, error: "Loopback IP addresses are not permitted" };
        }
        if (isPrivateA || isPrivateB || isPrivateC || isLinkLocal) {
            return { valid: false, error: "Private or cloud-metadata IP addresses are forbidden" };
        }
    }

    // Build approved host set from environment and defaults
    const approvedHosts = new Set(DEFAULT_APPROVED_HOSTS);

    if (process.env.STORAGE_PUBLIC_BASE_URL) {
        try {
            approvedHosts.add(new URL(process.env.STORAGE_PUBLIC_BASE_URL).hostname.toLowerCase());
        } catch { /* ignore invalid env URL */ }
    }
    if (process.env.CLOUDFLARE_R2_PUBLIC_URL) {
        try {
            approvedHosts.add(new URL(process.env.CLOUDFLARE_R2_PUBLIC_URL).hostname.toLowerCase());
        } catch { /* ignore */ }
    }
    if (process.env.AWS_S3_PUBLIC_URL) {
        try {
            approvedHosts.add(new URL(process.env.AWS_S3_PUBLIC_URL).hostname.toLowerCase());
        } catch { /* ignore */ }
    }
    if (options.additionalApprovedHosts && Array.isArray(options.additionalApprovedHosts)) {
        for (const h of options.additionalApprovedHosts) {
            approvedHosts.add(h.toLowerCase());
        }
    }

    // In dev or test environments, allow localhost
    if (isDev) {
        approvedHosts.add("localhost");
        approvedHosts.add("127.0.0.1");
    }

    // Host matching: allow exact match or subdomain match for approved CDN domains (e.g. *.unsplash.com)
    let isApproved = false;
    for (const approved of approvedHosts) {
        if (host === approved || host.endsWith(`.${approved}`)) {
            isApproved = true;
            break;
        }
    }

    if (!isApproved) {
        return {
            valid: false,
            error: `Host "${host}" is not on the approved storage domain list`,
        };
    }

    return { valid: true };
}
