import crypto from "crypto";

/**
 * RFC 3986 strict URI encoder for AWS SigV4 canonicalization.
 * Standard encodeURIComponent leaves !'()* unescaped; SigV4 requires them escaped.
 *
 * @param {string} str
 * @param {boolean} [encodeSlash=true]
 * @returns {string}
 */
export function uriEncode(str, encodeSlash = true) {
    if (typeof str !== "string") return "";
    let encoded = encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
    if (!encodeSlash) {
        encoded = encoded.replace(/%2F/gi, "/");
    }
    return encoded;
}

/**
 * Computes SHA256 hex digest of given string or buffer.
 *
 * @param {string|Buffer} data
 * @returns {string} hex digest
 */
export function sha256Hex(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Computes HMAC-SHA256 digest buffer.
 *
 * @param {string|Buffer} key
 * @param {string|Buffer} data
 * @returns {Buffer}
 */
export function hmacSha256(key, data) {
    return crypto.createHmac("sha256", key).update(data).digest();
}

/**
 * Derives AWS SigV4 signing key from secret, dateStamp, region, and service.
 *
 * @param {string} secretKey
 * @param {string} dateStamp YYYYMMDD
 * @param {string} region
 * @param {string} [service="s3"]
 * @returns {Buffer}
 */
export function getSignatureKey(secretKey, dateStamp, region, service = "s3") {
    const kDate = hmacSha256("AWS4" + secretKey, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, "aws4_request");
    return kSigning;
}

/**
 * Resolves endpoint protocol, host, and path for AWS S3 and S3-compatible providers (Cloudflare R2, MinIO).
 *
 * @param {object} config
 * @param {string} key Object key
 * @returns {{ protocol: string, host: string, path: string, url: string, isPathStyle: boolean }}
 */
export function resolveEndpoint(config, key) {
    const cleanKey = String(key || "").replace(/^\/+/, "");

    if (config.endpoint) {
        const parsed = new URL(config.endpoint);
        const protocol = parsed.protocol;
        const host = parsed.host;
        const basePath = parsed.pathname.replace(/\/+$/, "");

        // Path-style is standard for custom endpoints / Cloudflare R2 / MinIO
        const path = `${basePath}/${config.bucket}/${cleanKey}`;
        const url = `${protocol}//${host}${path}`;

        return {
            protocol,
            host,
            path,
            url,
            isPathStyle: true,
        };
    }

    // Standard AWS S3 virtual-hosted style
    const region = config.region || "us-east-1";
    const host =
        region === "us-east-1"
            ? `${config.bucket}.s3.amazonaws.com`
            : `${config.bucket}.s3.${region}.amazonaws.com`;
    const protocol = "https:";
    const path = `/${cleanKey}`;
    const url = `${protocol}//${host}${path}`;

    return {
        protocol,
        host,
        path,
        url,
        isPathStyle: false,
    };
}

/**
 * Generate an AWS SigV4 presigned PUT URL for direct browser-to-bucket upload.
 * Signs Content-Type and Host headers to prevent tampering with uploaded MIME type.
 *
 * @param {object} params
 * @param {object} params.config Validated storage config
 * @param {string} params.key Object key
 * @param {string} params.contentType Authorized MIME type (e.g. image/jpeg)
 * @param {number} [params.expiresInSeconds=300] URL TTL (default 5 minutes)
 * @param {Date} [params.date=new Date()]
 * @returns {string} Presigned upload URL
 */
export function generatePresignedPutUrl({
    config,
    key,
    contentType,
    expiresInSeconds = 300,
    date = new Date(),
}) {
    if (!config || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
        throw new Error("Cannot generate presigned upload URL: invalid or missing storage configuration");
    }
    if (!key) {
        throw new Error("Cannot generate presigned upload URL: missing object key");
    }
    if (!contentType) {
        throw new Error("Cannot generate presigned upload URL: missing contentType");
    }

    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);
    const region = config.region || "us-east-1";
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const { protocol, host, path } = resolveEndpoint(config, key);
    const canonicalUri = uriEncode(path, false);

    // Query parameters for presigning (must be sorted alphabetically by encoded key)
    const queryParams = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(expiresInSeconds),
        "X-Amz-SignedHeaders": "content-type;host",
    };

    const sortedKeys = Object.keys(queryParams).sort();
    const canonicalQueryString = sortedKeys
        .map((k) => `${uriEncode(k, true)}=${uriEncode(queryParams[k], true)}`)
        .join("&");

    const normalizedContentType = contentType.trim().toLowerCase();
    const normalizedHost = host.trim().toLowerCase();

    // Canonical headers must be sorted by lowercase name with trailing newline
    const canonicalHeaders = `content-type:${normalizedContentType}\nhost:${normalizedHost}\n`;
    const signedHeaders = "content-type;host";
    const payloadHash = "UNSIGNED-PAYLOAD";

    const canonicalRequest = [
        "PUT",
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const canonicalRequestHash = sha256Hex(canonicalRequest);

    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        canonicalRequestHash,
    ].join("\n");

    const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, region, "s3");
    const signature = crypto
        .createHmac("sha256", signingKey)
        .update(stringToSign)
        .digest("hex");

    return `${protocol}//${host}${path}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Generate an AWS SigV4 presigned GET URL for secure downloading/viewing from a private S3 bucket.
 *
 * @param {object} params
 * @param {object} params.config Validated storage config
 * @param {string} params.key Object key
 * @param {number} [params.expiresInSeconds=3600] URL TTL (default 1 hour)
 * @param {Date} [params.date=new Date()]
 * @returns {string} Presigned download URL
 */
export function generatePresignedGetUrl({
    config,
    key,
    expiresInSeconds = 3600,
    date = new Date(),
}) {
    if (!config || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
        throw new Error("Cannot generate presigned download URL: invalid or missing storage configuration");
    }
    if (!key) {
        throw new Error("Cannot generate presigned download URL: missing object key");
    }

    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);
    const region = config.region || "us-east-1";
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const { protocol, host, path } = resolveEndpoint(config, key);
    const canonicalUri = uriEncode(path, false);

    const queryParams = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(expiresInSeconds),
        "X-Amz-SignedHeaders": "host",
    };

    const sortedKeys = Object.keys(queryParams).sort();
    const canonicalQueryString = sortedKeys
        .map((k) => `${uriEncode(k, true)}=${uriEncode(queryParams[k], true)}`)
        .join("&");

    const normalizedHost = host.trim().toLowerCase();
    const canonicalHeaders = `host:${normalizedHost}\n`;
    const signedHeaders = "host";
    const payloadHash = "UNSIGNED-PAYLOAD";

    const canonicalRequest = [
        "GET",
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const canonicalRequestHash = sha256Hex(canonicalRequest);

    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        canonicalRequestHash,
    ].join("\n");

    const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, region, "s3");
    const signature = crypto
        .createHmac("sha256", signingKey)
        .update(stringToSign)
        .digest("hex");

    return `${protocol}//${host}${path}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Sign HTTP request headers for server-to-S3 REST API calls (HEAD, DELETE, GET).
 * Uses AWS SigV4 Authorization header scheme.
 *
 * @param {object} params
 * @param {object} params.config Validated storage config
 * @param {string} params.method HTTP method (HEAD, DELETE, GET)
 * @param {string} params.key Object key
 * @param {object} [params.headers={}] Additional HTTP headers
 * @param {string} [params.payloadHash] Payload SHA256 hex (defaults to empty string hash)
 * @param {Date} [params.date=new Date()]
 * @returns {{ url: string, headers: object }}
 */
export function signS3Request({
    config,
    method,
    key,
    headers = {},
    payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    date = new Date(),
}) {
    if (!config || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
        throw new Error("Cannot sign S3 request: invalid or missing storage configuration");
    }

    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);
    const region = config.region || "us-east-1";
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const { protocol, host, path, url } = resolveEndpoint(config, key);
    const canonicalUri = uriEncode(path, false);
    const canonicalQueryString = "";

    const requestHeaders = {
        ...headers,
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
    };

    const headerKeys = Object.keys(requestHeaders)
        .map((k) => k.toLowerCase())
        .sort();

    const canonicalHeaders = headerKeys
        .map((k) => {
            const originalKey = Object.keys(requestHeaders).find(
                (orig) => orig.toLowerCase() === k
            );
            return `${k}:${String(requestHeaders[originalKey]).trim()}\n`;
        })
        .join("");

    const signedHeaders = headerKeys.join(";");

    const canonicalRequest = [
        method.toUpperCase(),
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const canonicalRequestHash = sha256Hex(canonicalRequest);

    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        canonicalRequestHash,
    ].join("\n");

    const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, region, "s3");
    const signature = crypto
        .createHmac("sha256", signingKey)
        .update(stringToSign)
        .digest("hex");

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
        url,
        headers: {
            ...requestHeaders,
            Authorization: authorizationHeader,
        },
    };
}

