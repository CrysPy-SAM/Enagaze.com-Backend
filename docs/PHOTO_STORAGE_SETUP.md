# Engaze.com — Profile Photo Storage Setup & Configuration Guide

This guide details how to configure production-grade, S3-compatible object storage (AWS S3 or Cloudflare R2) for profile photo uploads in Engaze.com.

---

## 1. Architecture Overview

Engaze.com employs a secure, direct-to-bucket upload architecture:

```
[Browser / Client]
   │
   │ 1. POST /api/v1/users/profile/photo/upload-url (Auth, MIME, Size Check)
   ▼
[Engaze Backend] ──(Generates AWS SigV4 Presigned PUT URL + HMAC Upload Token)
   │
   │ 2. PUT (Binary Image Payload + Content-Type)
   ▼
[Object Storage: AWS S3 / Cloudflare R2]
   │
   │ 3. POST /api/v1/users/profile/photo/confirm (Object Existence & Size Verification)
   ▼
[Engaze Backend] ──(HEAD Object Verification ──> Saves CDN URL to MongoDB)
   │
   │ 4. Read Profile Photo via CDN
   ▼
[Public CDN / CloudFront / Cloudflare Custom Domain]
```

### Security Invariants
- **No Direct Secret Sharing**: S3/R2 access keys and secret keys **never** reach the frontend or client.
- **Fail-Closed by Design**: If cloud storage credentials are not configured, the backend returns `HTTP 503 Service Unavailable` with `STORAGE_UNAVAILABLE`. It never falls back to mock storage in production, and never writes invalid URLs to MongoDB.
- **Strict User & Key Binding**: Upload tokens are cryptographically signed with HMAC-SHA256 (`JWT_SECRET`). Users can only confirm uploads to their own server-generated key (`profile-photos/${userId}/${uuid}.${ext}`).
- **Authoritative Size & MIME Validation**: Upload confirmation performs an authenticated `HEAD` request to S3 to verify the actual byte size ($\le 5\text{MB}$) and MIME type before linking the photo to the profile. Oversized or spoofed objects are deleted immediately.

---

## 2. Environment Variables Specification

Configure these environment variables in your deployment environment (e.g. Render Dashboard, AWS ECS, or `.env`):

| Variable Name | Required | Secret? | Default | Description |
| :--- | :---: | :---: | :---: | :--- |
| `STORAGE_PROVIDER` | **Yes** | No | `s3` | Storage provider: `s3` (AWS S3) or `r2` (Cloudflare R2). In dev, omit or set to `dev-mock`. |
| `STORAGE_BUCKET` | **Yes** | No | — | S3 or R2 bucket name (e.g. `engaze-profile-photos`). Fallback: `AWS_S3_BUCKET`. |
| `STORAGE_REGION` | **Yes** | No | `us-east-1` (`auto` for R2) | AWS region (e.g. `us-east-1`, `eu-west-1`) or `auto` for Cloudflare R2. Fallback: `AWS_REGION`. |
| `STORAGE_ACCESS_KEY_ID` | **Yes** | No | — | IAM access key ID or R2 access key ID. Fallback: `AWS_ACCESS_KEY_ID`. |
| `STORAGE_SECRET_ACCESS_KEY` | **Yes** | **YES (SECRET)** | — | Secret access key. Never commit to Git or print in logs. Fallback: `AWS_SECRET_ACCESS_KEY`. |
| `STORAGE_PUBLIC_BASE_URL` | Optional | No | `null` | Public CDN or delivery base URL without trailing slash. When omitted, backend serves private bucket photos via `/api/v1/users/profile/photo/media/:key` with presigned redirects. |
| `STORAGE_ENDPOINT` | Optional | No | `null` | Custom S3 endpoint URL (Required for Cloudflare R2, MinIO, or LocalStack). |
| `STORAGE_FORCE_PATH_STYLE` | Optional | No | `auto` | `true` for path-style URLs (`/bucket/key`), `false` for virtual-hosted (`bucket.domain/key`). Auto-enabled when custom endpoint is set. |

---

## 3. Provider Setup Guides

### A. AWS S3 + Amazon CloudFront (Recommended for AWS)

1. **Create an S3 Bucket**:
   - Bucket name: e.g. `engaze-profile-photos`
   - Block **all** public access: **Enabled** (Keep the bucket private).
   - Object Ownership: Bucket owner enforced.
   - CORS Configuration:
     ```json
     [
       {
         "AllowedHeaders": ["content-type"],
         "AllowedMethods": ["PUT"],
         "AllowedOrigins": ["https://engaze.com", "https://engaze-com.vercel.app"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }
     ]
     ```

2. **Create CloudFront Distribution (Public Delivery)**:
   - Origin: Target the S3 bucket (`engaze-profile-photos.s3.amazonaws.com`).
   - Origin Access: Use **Origin Access Control (OAC)** (Restricts S3 access to CloudFront only).
   - Viewer Protocol Policy: Redirect HTTP to HTTPS.
   - Allowed HTTP Methods: `GET, HEAD`.
   - Custom Domain: e.g. `photos.engaze.com` (or CloudFront default `https://d123456abcdef8.cloudfront.net`).

3. **Backend Environment Variables**:
   ```env
   STORAGE_PROVIDER=s3
   STORAGE_BUCKET=engaze-profile-photos
   STORAGE_REGION=us-east-1
   STORAGE_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
   STORAGE_SECRET_ACCESS_KEY=your_aws_secret_access_key_here
   STORAGE_PUBLIC_BASE_URL=https://photos.engaze.com
   ```

---

### B. Cloudflare R2 (Cost-Effective, Zero Egress Fees)

1. **Create an R2 Bucket**:
   - Log into Cloudflare Dashboard $\rightarrow$ **R2** $\rightarrow$ **Create bucket** (e.g. `engaze-profile-photos`).
   - Bucket location: Automatic.

2. **Configure CORS**:
   - Go to Bucket Settings $\rightarrow$ **CORS Policy**:
     ```json
     [
       {
         "AllowedOrigins": ["https://engaze.com", "https://engaze-com.vercel.app"],
         "AllowedMethods": ["PUT"],
         "AllowedHeaders": ["content-type"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }
     ]
     ```

3. **Configure Public Access (Custom Domain or Managed R2.dev)**:
   - Under Settings $\rightarrow$ **Public Access**, connect a custom domain (e.g. `photos.engaze.com`) or enable `r2.dev` subdomain.

4. **Create API Tokens**:
   - Cloudflare Dashboard $\rightarrow$ R2 $\rightarrow$ **Manage R2 API Tokens** $\rightarrow$ **Create API Token**.
   - Permissions: **Object Read & Write**.
   - Apply to bucket: `engaze-profile-photos`.
   - Copy Access Key ID, Secret Access Key, and Endpoint URL.

5. **Backend Environment Variables**:
   ```env
   STORAGE_PROVIDER=r2
   STORAGE_BUCKET=engaze-profile-photos
   STORAGE_REGION=auto
   STORAGE_ENDPOINT=https://<your_account_id>.r2.cloudflarestorage.com
   STORAGE_ACCESS_KEY_ID=your_r2_access_key_id
   STORAGE_SECRET_ACCESS_KEY=your_r2_secret_access_key
   STORAGE_PUBLIC_BASE_URL=https://photos.engaze.com
   ```

---

## 4. Least-Privilege IAM Policy (AWS)

Create a dedicated IAM user or role for the backend with the following minimal policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowProfilePhotoOperations",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::engaze-profile-photos/profile-photos/*"
    }
  ]
}
```

> [!IMPORTANT]
> The backend only needs access to `profile-photos/*`. Do not grant wildcard `s3:*` or bucket deletion permissions.

---

## 5. Lifecycle Rules for Abandoned Uploads

Because presigned PUT uploads travel directly from browser to S3, a client might upload bytes to S3 but abandon the flow before calling `/confirm`.

To prevent orphaned storage consumption:
1. Configure an S3 / R2 Lifecycle Rule on prefix `profile-photos/`:
   - **Abort incomplete multipart uploads**: 7 days.
   - **Delete unconfirmed or expired objects**: Tag confirmed objects, or create a weekly cleanup job to prune unreferenced storage objects.

---

## 6. Running Tests Without Cloud Credentials

All unit tests in `tests/s3.storage.test.js` and `tests/photo.upload.test.js` are **100% self-contained**:
- Network operations are mocked in-memory using dependency injection (`fetchFn`).
- Tests do not connect to real AWS buckets, real credentials, or live databases.
- To execute storage tests locally:
  ```bash
  cd backend
  node --test tests/s3.storage.test.js
  ```
  Result: **35 passed, 0 failed**.
