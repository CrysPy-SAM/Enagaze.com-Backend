# Engaze.com — Complete Full Stack Architecture & Technical Interview Guide

> **Target Audience**: Full Stack Developer & Backend Software Engineer Interviews  
> **Repository Roots**: Frontend (`D:\code\Engaze.com\frontend`), Backend (`D:\code\Engaze.com\backend`)  
> **Live Production Deployments**:  
> - Frontend: [`https://www.engaze.date/`](https://www.engaze.date/) (Vercel Edge Network)  
> - Backend API: [`https://enagaze-com-backend.onrender.com/`](https://enagaze-com-backend.onrender.com/) (Render Web Service)  
> - Database: MongoDB Atlas (Managed Replica Set)  
> - Media Storage: AWS S3 Presigned Direct Upload  

---

## Table of Contents
1. [Part 1: Technology Stack & Architectural Rationale](#part-1-technology-stack--architectural-rationale)
2. [Part 2: Complete Architecture Mermaid Diagrams](#part-2-complete-architecture-mermaid-diagrams)
3. [Part 3: Comprehensive Source-Code Traceability Table](#part-3-comprehensive-source-code-traceability-table)
4. [Part 4: Database & API Architecture](#part-4-database--api-architecture)
5. [Part 5: Production Deployment vs. Local Docker Architecture](#part-5-production-deployment-vs-local-docker-architecture)
6. [Part 6: 70 Deep-Dive Technical Interview Questions & Answers](#part-6-70-deep-dive-technical-interview-questions--answers)
   - [Section A: Architecture & System Design (15 Questions)](#section-a-architecture--system-design-15-questions)
   - [Section B: Backend, API & Node.js Deep-Dive (15 Questions)](#section-b-backend-api--nodejs-deep-dive-15-questions)
   - [Section C: MongoDB & Database Engineering (10 Questions)](#section-c-mongodb--database-engineering-10-questions)
   - [Section D: Real-Time Chat, WebRTC & Socket.IO (10 Questions)](#section-d-real-time-chat-webrtc--socketio-10-questions)
   - [Section E: Security, Rate Limiting & Reliability (10 Questions)](#section-e-security-rate-limiting--reliability-10-questions)
   - [Section F: Deployment, Testing & Scaling (10 Questions)](#section-f-deployment-testing--scaling-10-questions)
7. [Part 7: Interview Defense Summary & Critical Watchouts](#part-7-interview-defense-summary--critical-watchouts)
   - [Top 10 Things You Must Explain Without Hesitation](#top-10-things-you-must-explain-without-hesitation)
   - [Top 10 Riskiest Interviewer Follow-Ups](#top-10-riskiest-interviewer-follow-ups)
   - [Codebase Inconsistencies & Honest Disclosures](#codebase-inconsistencies--honest-disclosures)

---

## Part 1: Technology Stack & Architectural Rationale

Every technology choice in Engaze was selected to solve a concrete dating app engineering requirement: low latency, high concurrency, data isolation, and user safety.

```
+---------------------------------------------------------------------------------------+
|                                    FRONTEND CLIENT                                    |
| React 18 SPA | React Router 6 | Material-UI (MUI v5) | Socket.IO Client | WebRTC API  |
+-------------------------------------------+-------------------------------------------+
                                            | HTTPS / WSS
                                            v
+---------------------------------------------------------------------------------------+
|                                   BACKEND APPLICATION                                 |
| Node.js 22 LTS | Express 4 (ESM) | Socket.IO Server | Mongoose 8 ODM | ioredis | BullMQ|
+---------------------+---------------------+---------------------+---------------------+
                      |                     |                     |
                      v                     v                     v
              +---------------+     +---------------+     +---------------+
              | MongoDB Atlas |     | Redis/Valkey  |     |    AWS S3     |
              | Document Store|     | Ephemeral/Queues    Presigned Media |
              +---------------+     +---------------+     +---------------+
```

### 1.1 Frontend Architecture
- **Framework & Runtime**: React 18.2 with functional components and React Hooks.
  - *Why*: Declarative component trees, fast reconciliation, and seamless integration with WebRTC stream bindings.
- **Routing**: `react-router-dom` v6 with client-side SPA routing (`/`, `/auth`, `/home`, `/chat`, `/matches`, `/profile`, `/search`, `/video`).
- **Component & Design System**: Material-UI (MUI v5 `@mui/material`, `@emotion/react`, Lucide icons).
  - *Why*: Responsive grid layout, accessible input primitives, modal dialogs, and consistent theme tokens.
- **State Management & Contexts**:
  - `AuthContext.jsx`: Holds authenticated user session, JWT storage in `localStorage`, and login/logout state.
  - `DirectCallContext.jsx`: Encapsulates 1-on-1 WebRTC video calling lifecycle, local/remote `MediaStream` management, incoming call modal triggers, and ICE candidate exchange.
- **Real-Time Client**: `socket.io-client` v4.8 attaching JWT Bearer auth to the handshake.
- **Build & Bundler**: Create React App (`react-scripts` with Webpack 5), optimized with route-level code splitting (`React.lazy` / `Suspense`) in `App.js`.

### 1.2 Backend Architecture
- **Runtime & Module System**: Node.js 22 LTS with pure ECMAScript Modules (`"type": "module"` in `package.json`).
  - *Why*: Native `import`/`export`, top-level `await`, modern V8 optimizations, and built-in `node:test` test runner.
- **Application Framework**: Express.js 4.18 with a unified HTTP server created via `node:http`.
- **Layered Architecture**:
  - `routes/`: Explicit URL path bindings with middleware chains (`protect`, `requireEligibility`, rate limiters).
  - `controllers/`: HTTP request validation, status code mapping, and response orchestration.
  - `services/`: Core domain logic (safety blocking, matching, presence calculation, S3 signing, image validation).
  - `models/`: Mongoose schemas with schema validations, static helpers, virtuals, and compound indexes.
- **Middleware Pipeline**:
  1. `trust proxy`: Configured to `1` hop to resolve client IPs through Render load balancers.
  2. `cors`: Strict allowlist validating exact origins (`https://engaze.date`, `https://www.engaze.date`, `https://engaze-com.vercel.app`).
  3. `express.json({ limit: "40kb" })`: Bounded JSON payload parser preventing memory-exhaustion attacks.
  4. Liveness (`/health`, `/livez`) & Readiness (`/api/v1/health`, `/readyz`) probes.
  5. Drain middleware: Returns 503 during server shutdown.
  6. Rate limiting (`globalApiLimiter`).
  7. Route routers (`/api/v1/users`, `/api/v1/discovery`, `/api/v1/matches`, `/api/v1/conversations`, etc.).

### 1.3 Database Architecture
- **Database Engine**: MongoDB 8 with Mongoose 8 ODM.
  - *Why*: Document model naturally supports variable dating profile fields (photos array, interests, dating preferences) and rapid schema evolution without heavy DDL locks.
- **Connection Pooling**: Centralized in `src/config/database.js` with `maxPoolSize: 25`, `minPoolSize: 0`, and `serverSelectionTimeoutMS: 30000`.

### 1.4 Authentication & Security
- **Authentication**: Stateless JSON Web Tokens (JWT) using `jsonwebtoken` with standard `7d` expiry.
- **Password Security**: `bcryptjs` (pure JavaScript, avoiding native compilation bugs on Alpine Linux containers).
- **Google OAuth 2.0**: Backend token verification via `google-auth-library` (`OAuth2Client.verifyIdToken()`). Automatically links accounts by verified Google email.
- **Age Verification Invariant**: Hard rule enforced across models and routes (`calculateExactAge(dob) >= 18`). Prevents underage access at the database validator level.

### 1.5 Media Upload Architecture
- **Zero-Server-Hop Upload**: The server **never** buffers large photo uploads.
  1. Client sends declared MIME and size to `POST /api/v1/users/profile/photo/upload-url`.
  2. Server validates constraints (max 5MB, JPEG/PNG/WebP), generates an S3 presigned PUT URL with an HMAC-signed upload token (`s3Signer.service.js`).
  3. Client uploads directly from browser to AWS S3.
  4. Client calls `POST /api/v1/users/profile/photo/confirm`.
  5. Server validates token, checks S3 object existence via `HeadObject`, updates the user profile, and queues old photo cleanup.

### 1.6 Real-Time Communication & WebRTC
- **Signaling Server**: Socket.IO 4.7 running on the shared Express HTTP server.
  - Handles presence leases, typing indicators, read receipts, and direct 1-on-1 WebRTC call negotiation.
- **WebRTC Peer-to-Peer**: Browsers exchange SDP offers/answers and ICE candidates through Socket.IO, but all audio/video media streams flow **directly P2P** between user devices, consuming zero server bandwidth.
- **STUN/TURN Configuration**: Configured via `src/config/webrtc.js`. Defaults to Google public STUN (`stun:stun.l.google.com:19302`) with RFC 5766 ephemeral HMAC TURN token generation when `TURN_SECRET` is provided.

### 1.7 Redis & BullMQ Architecture
- **Distributed Redis Foundation**: Centralized `ioredis` client wrapper (`src/config/redis.js`, `src/services/redis.service.js`).
- **Feature Flags**: Failsafe design: all Redis features default to `false`. When Redis is absent, presence, rate limiting, and matchmaking run in local process memory.
- **BullMQ Background Workers**: Asynchronous queue processing for media cleanup (`QUEUE_NAMES.MEDIA_CLEANUP = "media-cleanup"`). Bounded concurrency (5), exponential backoff with jitter, colon-free job IDs, and safe inline fallback if Redis is disabled.

---

## Part 2: Complete Architecture Mermaid Diagrams

### Diagram 1: High-Level System Architecture
```mermaid
flowchart TD
    subgraph Clients["Clients"]
        Browser["User Web Browser<br/>(React 18 SPA)"]
    end

    subgraph Edge["Vercel Edge Platform"]
        VercelCDN["Vercel CDN & Routing<br/>(engaze.date / www.engaze.date)"]
    end

    subgraph Compute["Render Cloud Platform"]
        ExpressAPI["Render Web Service<br/>Express API & Socket.IO<br/>(Node.js 22 LTS)"]
        Worker["Optional Render Worker<br/>BullMQ Media Processor<br/>(Node.js 22 LTS)"]
    end

    subgraph DataTier["Data & Storage Infrastructure"]
        MongoDB["MongoDB Atlas<br/>(Users, Swipes, Matches, Messages)"]
        Redis["Redis / Valkey<br/>(Presence, Queues, Rate Limits)"]
        S3["AWS S3 Bucket<br/>(Profile Photos & Media)"]
    end

    Browser -->|"HTTPS Static Assets"| VercelCDN
    Browser -->|"HTTPS REST Calls"| ExpressAPI
    Browser -->|"WSS Real-time Signaling"| ExpressAPI
    Browser -.->|"Direct S3 Upload (Presigned URL)"| S3
    Browser <===>|"WebRTC P2P Audio/Video"| Browser

    ExpressAPI -->|"Mongoose Queries"| MongoDB
    ExpressAPI -->|"ioredis Commands"| Redis
    ExpressAPI -->|"AWS SDK Presigning & HeadObject"| S3
    ExpressAPI -.->|"BullMQ Enqueue"| Redis

    Worker -.->|"BullMQ Dequeue"| Redis
    Worker -.->|"Delete Obsolete Media"| S3
```

---

### Diagram 2: Typical Frontend-to-Backend HTTP Request Flow
```mermaid
sequenceDiagram
    autonumber
    actor Client as React Client (Axios)
    participant RateLimit as Express Rate Limiter
    participant Auth as Auth Middleware (JWT)
    participant Route as Express Router
    participant Controller as Controller
    participant Service as Domain Service
    participant DB as MongoDB Atlas

    Client->>RateLimit: HTTP Request with Bearer Token
    alt Rate Limit Exceeded
        RateLimit-->>Client: 429 Too Many Requests (Retry-After header)
    end
    RateLimit->>Auth: Pass to auth middleware
    alt Token Missing or Invalid
        Auth-->>Client: 401 Unauthorized (JWT verification error)
    end
    Auth->>Route: Populate req.user & forward
    Route->>Controller: Route match (e.g., GET /api/v1/discovery)
    Controller->>Service: Call domain service (e.g., getDiscoveryProfiles)
    Service->>DB: Query with projection & lean() cursor
    DB-->>Service: Sanitized document batch
    Service-->>Controller: DTO profile results
    Controller-->>Client: 200 OK JSON { success: true, data: [...] }
```

---

### Diagram 3: Authentication & Google OAuth Login Flow
```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant Frontend as React Client
    participant AuthAPI as POST /api/v1/users/login (or google-login)
    participant Google as Google OAuth API
    participant UserDB as MongoDB Users Collection

    alt Local Email/Password Login
        User->>Frontend: Enters username/email & password
        Frontend->>AuthAPI: POST /login { username, password }
        AuthAPI->>UserDB: User.findOne({ username }).select("+password")
        AuthAPI->>AuthAPI: bcrypt.compare(password, user.password)
    else Google OAuth Login
        User->>Frontend: Clicks "Sign in with Google"
        Frontend->>Google: Google Identity Services credential response
        Google-->>Frontend: Google ID Token (JWT)
        Frontend->>AuthAPI: POST /google-login { idToken }
        AuthAPI->>Google: verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })
        Google-->>AuthAPI: Verified Payload (email, name, sub)
        AuthAPI->>UserDB: Upsert User by googleId or verified email
    end

    alt Credentials Valid
        AuthAPI->>AuthAPI: jwt.sign({ id: user._id, role }, JWT_SECRET, { expiresIn: '7d' })
        AuthAPI-->>Frontend: 200 OK { success: true, token, user }
        Frontend->>Frontend: Save token in localStorage & update AuthContext
    else Invalid Credentials
        AuthAPI-->>Frontend: 401 Unauthorized { success: false, message: 'Invalid credentials' }
    end
```

---

### Diagram 4: Direct-to-S3 Profile Photo Upload & Cleanup Flow
```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant Frontend as React Profile Page
    participant Server as Express Backend
    participant S3 as AWS S3 Storage
    participant Queue as Redis / BullMQ Queue

    User->>Frontend: Selects image file (<5MB)
    Frontend->>Frontend: Validate client-side (size, aspect ratio)
    Frontend->>Server: POST /profile/photo/upload-url { mimeType, targetIndex }
    Server->>Server: Validate MIME & create HMAC uploadToken
    Server->>S3: Generate S3 Presigned PUT URL
    Server-->>Frontend: 200 OK { uploadUrl, uploadToken, key }

    Frontend->>S3: Direct PUT image bytes to presigned uploadUrl
    S3-->>Frontend: 200 OK (Uploaded to S3)

    Frontend->>Server: POST /profile/photo/confirm { uploadToken, key }
    Server->>Server: Verify HMAC uploadToken integrity & user ID match
    Server->>S3: HeadObjectCommand(key) to confirm presence in bucket
    Server->>Server: Update User.photos[targetIndex] in MongoDB

    alt Photo Replaced Existing Photo
        alt BullMQ Enabled
            Server->>Queue: Enqueue media-cleanup job (deterministic custom ID)
            Queue-->>Server: Job Enqueued
        else BullMQ Disabled / Enqueue Failed
            Server->>S3: DeleteObjectCommand(oldKey) inline fallback
        end
    end

    Server-->>Frontend: 200 OK { success: true, photos: user.photos }
```

---

### Diagram 5: Discovery, Swipe, and Mutual Match Flow
```mermaid
sequenceDiagram
    autonumber
    actor UserA as User A
    actor UserB as User B
    participant API as Express Discovery API
    participant DB as MongoDB (Swipes & Matches)
    participant Socket as Socket.IO Server

    UserA->>API: POST /api/v1/discovery/swipe { toUser: UserB._id, action: 'like' }
    API->>API: requireEligibility (must be >= 18 & profile complete)
    API->>DB: Swipe.create({ fromUser: A, toUser: B, action: 'like' })

    API->>DB: Swipe.findOne({ fromUser: B, toUser: A, action: 'like' })
    alt User B has already liked User A (Mutual Match!)
        API->>API: Match.getCanonicalPair(A._id, B._id)
        API->>DB: Match.findOneAndUpdate({ userPair }, status: 'active', upsert: true)
        API->>DB: Conversation.create({ match: match._id, participants: [A, B] })
        API->>Socket: Emit 'match:created' to user:A and user:B
        Socket-->>UserA: 'match:created' event (Modal pops up)
        Socket-->>UserB: 'match:created' event (Modal pops up)
        API-->>UserA: 200 OK { matched: true, matchId: match._id }
    else Not Mutual Yet
        API-->>UserA: 200 OK { matched: false }
    end
```

---

### Diagram 6: Real-Time Chat & Idempotent Message Flow
```mermaid
sequenceDiagram
    autonumber
    actor Alice as Alice (Client A)
    participant Socket as Socket.IO Server
    participant DB as MongoDB Messages
    actor Bob as Bob (Client B)

    Alice->>Socket: emit("chat:join", { conversationId })
    Socket->>Socket: socket.join("conversation:" + conversationId)

    Alice->>Socket: emit("chat:send", { conversationId, content, clientTempId: "temp-123" })
    Socket->>Socket: Rate limit check & string sanitation
    Socket->>DB: Message.create({ conversation, sender: Alice, content, clientTempId })
    
    note over DB: Compound Unique Index on<br/>(conversation, sender, clientTempId)<br/>guarantees zero duplicate messages on retry!

    Socket->>Socket: emit to room "conversation:convId": "chat:message"
    Socket-->>Bob: "chat:message" { id, content, sender, clientTempId }
    Socket-->>Alice: ack callback { success: true, messageId, clientTempId }
    Alice->>Alice: Replace optimistic message with confirmed message

    Bob->>Socket: emit("chat:read", { conversationId })
    Socket->>DB: Message.updateMany({ conversationId, sender: Alice }, $addToSet: { readBy: Bob })
    Socket->>Alice: emit to Alice: "chat:read_receipt" { conversationId, readerId: Bob }
```

---

### Diagram 7: WebRTC Direct 1-on-1 Call Signaling & Media Flow
```mermaid
sequenceDiagram
    autonumber
    actor Caller as Caller Browser (React)
    participant Signal as Socket.IO Signaling Server
    actor Callee as Callee Browser (React)

    Caller->>Signal: emit("call:initiate", { targetUserId: Callee._id })
    Signal->>Signal: Verify mutual active match & not blocked
    Signal->>Callee: emit to room "user:Callee": "call:incoming" { callId, caller }
    Callee-->>Callee: DirectVideoCallModal displays with Ringtone

    alt Callee Accepts Call
        Callee->>Signal: emit("call:accept", { callId })
        Signal->>Caller: emit("call:accepted", { callId })
        
        note over Caller, Callee: Signaling Phase: Exchanging WebRTC Session Descriptions
        Caller->>Caller: createOffer() -> setLocalDescription()
        Caller->>Signal: emit("call:signal", { callId, signalData: offer })
        Signal->>Callee: emit("call:signal", { signalData: offer })
        Callee->>Callee: setRemoteDescription(offer) -> createAnswer() -> setLocalDescription()
        Callee->>Signal: emit("call:signal", { callId, signalData: answer })
        Signal->>Caller: emit("call:signal", { signalData: answer })
        Caller->>Caller: setRemoteDescription(answer)

        note over Caller, Callee: ICE Candidate Trickling via Socket.IO
        Caller->>Signal: emit("call:signal", { candidate })
        Signal->>Callee: emit("call:signal", { candidate })

        note over Caller, Callee: Direct Peer-to-Peer Media Channel Established!
        Caller <===> Callee: Direct P2P SRTP Audio / Video Stream (Zero Server Bandwidth!)
    else Callee Declines Call
        Callee->>Signal: emit("call:decline", { callId })
        Signal->>Caller: emit("call:declined", { callId })
    end
```

---

### Diagram 8: Background Media Cleanup Lifecycle
```mermaid
sequenceDiagram
    autonumber
    participant Controller as Photo Upload Controller
    participant Storage as Storage Service
    participant Producer as Queue Service (Producer)
    participant Redis as Redis / Valkey Service
    participant Worker as BullMQ Worker Process
    participant S3 as AWS S3 Storage

    Controller->>Storage: dispatchMediaCleanup({ key: "profile-photos/u1/photo.jpg", userId: "u1" })
    alt BULLMQ_ENABLED=true
        Storage->>Producer: enqueueMediaCleanup({ key, userId })
        Producer->>Producer: generateMediaCleanupJobId(key, userId)<br/>(Deterministic SHA-256 Colon-Free ID)
        Producer->>Redis: Queue.add("cleanup-object", data, { jobId, attempts: 3, backoff })
        Redis-->>Producer: Job Added
        
        note over Worker, Redis: Worker runs as independent process: npm run worker
        Worker->>Redis: Worker picks up next job from "engaze:bullmq:media-cleanup"
        Worker->>Worker: Validate key belongs to userId (profile-photos/userId/...)
        Worker->>S3: DeleteObjectCommand({ Bucket, Key })
        S3-->>Worker: Object Deleted
        Worker->>Redis: Mark Job Completed (Retained for 24h / 1,000 count limit)
    else BULLMQ_ENABLED=false (Current Production)
        Storage->>S3: DeleteObjectCommand({ Bucket, Key }) (Inline fallback)
        S3-->>Storage: Object Deleted
    end
```

---

### Diagram 9: Production Deployment Architecture
```mermaid
flowchart LR
    subgraph Vercel["Vercel Cloud (Frontend)"]
        VercelEdge["Vercel Edge Router<br/>SSL / CDN / Brotli"]
        CustomDomain["https://engaze.date<br/>https://www.engaze.date"]
        VercelApp["https://engaze-com.vercel.app"]
        ReactApp["React 18 Static Bundle<br/>(Cache-Control: immutable)"]

        CustomDomain --> VercelEdge
        VercelApp --> VercelEdge
        VercelEdge --> ReactApp
    end

    subgraph Render["Render Cloud (Backend)"]
        LoadBalancer["Render Reverse Proxy<br/>Load Balancer (Port 443/80)"]
        WebService["Render Web Service<br/>Enagaze.com-Backend-1<br/>(Node.js Native Runtime)"]
        
        LoadBalancer -->|"Proxy (Port 10000)"| WebService
    end

    subgraph DataServices["Managed Data Infrastructure"]
        Atlas["MongoDB Atlas Cluster<br/>(MongoDB 8 Replica Set)"]
        S3Bucket["AWS S3 Bucket<br/>(ap-southeast-2)"]
    end

    ReactApp -->|"REST API Calls (CORS Whitelisted)"| LoadBalancer
    ReactApp -->|"WSS Socket.IO Handshake"| LoadBalancer
    ReactApp -.->|"Direct S3 Upload"| S3Bucket

    WebService -->|"MongoDB Wire Protocol (Mongoose)"| Atlas
    WebService -->|"AWS SDK SigV4 Presign"| S3Bucket
```

---

## Part 3: Comprehensive Source-Code Traceability Table

| Feature / Capability | Frontend Entry / Component | Backend API Route | Controller / Handler | Service Layer | Model Involved | Infrastructure & Config | Key Functions & Responsibilities |
|---|---|---|---|---|---|---|---|
| **User Authentication** | `src/pages/authentication.jsx` | `POST /api/v1/users/login`<br/>`POST /api/v1/users/register` | `src/controllers/user.controller.js` | `src/config/jwt.js` | `User` (`src/models/user.model.js`) | `loginIpLimiter`, `loginAccountLimiter` | `login()`, `register()`, `validateJwtConfig()`, `bcrypt.compare()` |
| **Google OAuth** | `src/pages/authentication.jsx` | `POST /api/v1/users/google-login` | `src/controllers/user.controller.js` | `google-auth-library` | `User` | `googleLoginLimiter` | `googleLogin()`, `client.verifyIdToken()`, email auto-linking |
| **Profile Management** | `src/pages/profile.jsx` | `GET /api/v1/users/profile/me`<br/>`PUT /api/v1/users/profile/me` | `src/controllers/user.controller.js` | `src/services/eligibility.service.js` | `User` | `protect` middleware | `getMyProfile()`, `updateMyProfile()`, `calculateExactAge()` |
| **Direct S3 Photo Upload** | `src/pages/profile.jsx`, `src/utils/photoUpload.js` | `POST /profile/photo/upload-url`<br/>`POST /profile/photo/confirm` | `src/controllers/photoUpload.controller.js` | `src/services/s3Signer.service.js`, `src/services/storage.service.js` | `User` | `photoUploadLimiter`, AWS S3 SDK | `requestUploadUrl()`, `confirmUpload()`, `createUploadToken()`, `verifyUploadToken()` |
| **Photo Cleanup (BullMQ/Inline)** | `src/pages/profile.jsx` | `DELETE /profile/photo/:photoIndex` | `src/controllers/photoUpload.controller.js` | `src/services/queue.service.js`, `src/workers/mediaCleanup.worker.js` | `User` | BullMQ, Redis / S3 Client | `removePhoto()`, `dispatchMediaCleanup()`, `enqueueMediaCleanup()`, `processMediaCleanupJob()` |
| **Discovery Feed** | `src/pages/home.jsx` | `GET /api/v1/discovery` | `src/controllers/discovery.controller.js` | `src/services/eligibility.service.js`, `src/services/safety.service.js` | `User`, `Swipe`, `Block` | `discoveryLimiter`, compound indexes | `getDiscoveryProfiles()`, cursor pagination, blocked exclusion |
| **Swiping & Matching** | `src/pages/home.jsx` | `POST /api/v1/discovery/swipe` | `src/controllers/discovery.controller.js` | `src/services/matching.service.js` | `Swipe`, `Match`, `Conversation` | `swipeLimiter`, canonical user pairs | `swipe()`, `checkMutualMatch()`, `Match.getCanonicalPair()`, `Conversation.create()` |
| **Mutual Matches Feed** | `src/pages/matches.jsx` | `GET /api/v1/matches` | `src/controllers/discovery.controller.js` | `src/services/presence.service.js` | `Match`, `User` | Compound index on `{ users: 1, status: 1 }` | `getMatches()`, `getPresenceForViewer()` |
| **Real-Time Chat** | `src/pages/chat.jsx` | `GET /api/v1/conversations`<br/>`GET /api/v1/conversations/:id/messages` | `src/controllers/chat.controller.js`, `src/controllers/socketManager.js` | `src/utils/socketValidator.js` | `Conversation`, `Message` | Socket.IO room `conversation:<id>`, unique partial index | `chat:join`, `chat:send`, `chat:read`, `markConversationAsRead()`, `clientTempId` deduplication |
| **Online Presence** | `src/utils/presenceFormatters.js` | Socket event `presence:get` | `src/controllers/socketManager.js` | `src/services/presence.service.js` | `User` (privacy settings) | Grace timers, Redis sorted sets (when enabled) | `userConnected()`, `userDisconnected()`, `canViewerSeeOnline()`, `broadcastPresenceUpdate()` |
| **1-on-1 Video Calling** | `src/contexts/DirectCallContext.jsx`, `src/components/DirectVideoCallModal.jsx` | `GET /api/v1/webrtc/ice-servers` | `src/controllers/webrtc.controller.js`, `src/controllers/socketManager.js` | `src/config/webrtc.js` | `Match`, `Block` | WebRTC `RTCPeerConnection`, Google STUN / RFC 5766 TURN | `getIceServersConfig()`, `call:initiate`, `call:accept`, `call:signal`, `call:end` |
| **Random Matchmaking** | `src/pages/randomVideo.jsx` | Socket events `random:join-queue` | `src/controllers/randomCallManager.js` | `src/services/randomMatchmakingRedis.service.js` | In-memory queue / Redis ZSET | Lua script atomic match | `registerRandomCallHandlers()`, `random:consent`, `random:media-ready`, `random:signal` |
| **User Safety & Blocking** | `src/components/SafetyActionModal.jsx` | `POST /api/v1/safety/block`<br/>`POST /api/v1/safety/report` | `src/controllers/safety.controller.js` | `src/services/safety.service.js` | `Block`, `Report`, `Match` | `unmatchLimiter` | `blockUser()`, `reportUser()`, `isBlockedBidirectional()`, tearing down active calls & matches |

---

## Part 4: Database & API Architecture

### 4.1 MongoDB Models & Relationships
- **User (`src/models/user.model.js`)**:
  - Central identity document storing profile metadata, `password` (hashed with salt), `dob` (enforcing $\ge 18$), `photos` array (S3 URLs), `datingPreferences` (age range, interestedIn), and nested `privacySettings` (lastSeen, online visibility rules).
- **Swipe (`src/models/swipe.model.js`)**:
  - Records directional swipe actions (`action: 'like' | 'pass'`).
  - **Relational Integrity**: Compound unique index `{ fromUser: 1, toUser: 1 }` prevents duplicate swipes on the same target.
- **Match (`src/models/match.model.js`)**:
  - Represents a mutual connection. Contains `users: [ObjectId, ObjectId]` and a unique string `userPair`.
  - **Canonical Helper**: `Match.getCanonicalPair(idA, idB)` deterministically sorts ObjectIds (`idA < idB ? 'idA_idB' : 'idB_idA'`). Guarantees that racing mutual likes cannot create two duplicate match records.
- **Conversation (`src/models/conversation.model.js`)**:
  - Stores chat thread metadata. Has a 1-to-1 relationship with `Match` via `match: { type: ObjectId, unique: true }`.
  - Denormalizes `lastMessage` and `lastMessageAt` to support $O(1)$ sorting of the conversation inbox without unbounded `$lookup` aggregation joins.
- **Message (`src/models/message.model.js`)**:
  - Stores individual messages with `conversation`, `sender`, `content` (max 2000 chars), `clientTempId`, and `readBy` array.
  - **Partial Unique Index**: `{ conversation: 1, sender: 1, clientTempId: 1 }` with `partialFilterExpression: { clientTempId: { $type: "string" } }` enforces database-level idempotency on network retries.
- **Block (`src/models/block.model.js`)**:
  - Bidirectional safety relationship (`blocker`, `blocked`). Unique index `{ blocker: 1, blocked: 1 }`.
- **Report (`src/models/report.model.js`)**:
  - Moderation audit trail with structured categorization (`inappropriate_content`, `harassment`, `spam`, `underage_suspected`).

### 4.2 Query Patterns & Index Utilization Table

| Collection | Index Specification | Name | Supported Query in Code |
|---|---|---|---|
| `users` | `{ email: 1 }` (sparse) | `email_1_sparse` | `User.findOne({ email })` during Google OAuth login & duplicate checks |
| `users` | `{ isProfileComplete: 1, dob: 1, _id: -1 }` | `isProfileComplete_1_dob_1__id_-1` | Discovery feed filter by age range & cursor pagination |
| `users` | `{ isProfileComplete: 1, gender: 1, dob: 1, _id: -1 }` | `isProfileComplete_1_gender_1_dob_1__id_-1` | Discovery feed filter by gender preference, age range & cursor pagination |
| `users` | `{ isProfileComplete: 1, username: 1 }` | `isProfileComplete_1_username_1` | Instagram-style prefix search on usernames |
| `swipes` | `{ fromUser: 1, toUser: 1 }` (unique) | `fromUser_1_toUser_1` | Duplicate swipe prevention & mutual like checks |
| `swipes` | `{ toUser: 1, action: 1, createdAt: -1, _id: -1 }` | `toUser_1_action_1_createdAt_-1__id_-1` | "Likes You" feed: reverse-chronological list of incoming likes |
| `matches` | `{ users: 1, status: 1, createdAt: -1 }` | `users_1_status_1_createdAt_-1` | Active matches feed sorted by creation date |
| `matches` | `{ userPair: 1 }` (unique) | `userPair_1` | Deterministic race-condition prevention during mutual match creation |
| `conversations` | `{ participants: 1, lastMessageAt: -1 }` | `participants_1_lastMessageAt_-1` | Inbox list sorted by recent activity |
| `messages` | `{ conversation: 1, createdAt: -1, _id: -1 }` | `conversation_1_createdAt_-1__id_-1` | Reverse-chronological message history with cursor-based pagination |
| `messages` | `{ conversation: 1, sender: 1, clientTempId: 1 }` (partial) | `conversation_1_sender_1_clientTempId_1` | Idempotent message retry deduplication |
| `blocks` | `{ blocker: 1, blocked: 1 }` (unique) | `blocker_1_blocked_1` | Safety checks and discovery exclusion filters |

### 4.3 REST API Endpoints Reference

| Method | Endpoint | Auth | Rate Limited | Request Body / Query | Success Response |
|---|---|:---:|:---:|---|---|
| `POST` | `/api/v1/users/login` | Public | Yes (IP & Account) | `{ username, password }` | `200 OK { success, token, user }` |
| `POST` | `/api/v1/users/register` | Public | Yes | `{ name, username, password, email? }` | `201 Created { success, token, user }` |
| `POST` | `/api/v1/users/google-login` | Public | Yes | `{ idToken }` | `200 OK { success, token, user }` |
| `GET` | `/api/v1/users/profile/me` | JWT | No | Header: `Authorization: Bearer <jwt>` | `200 OK { success, user }` |
| `PUT` | `/api/v1/users/profile/me` | JWT | No | `{ name, bio, interests, dob, gender, datingPreferences }` | `200 OK { success, user }` |
| `GET` | `/api/v1/users/search` | JWT | Yes | `?query=john&limit=20&cursor=...` | `200 OK { users: [...], nextCursor }` |
| `POST` | `/api/v1/users/profile/photo/upload-url` | JWT | Yes | `{ mimeType: "image/jpeg", targetIndex: 0 }` | `200 OK { uploadUrl, uploadToken, key }` |
| `POST` | `/api/v1/users/profile/photo/confirm` | JWT | Yes | `{ uploadToken, key }` | `200 OK { success, photos: [...] }` |
| `DELETE`| `/api/v1/users/profile/photo/:photoIndex`| JWT | No | URL param `photoIndex` | `200 OK { success, photos: [...] }` |
| `GET` | `/api/v1/discovery` | JWT + 18+ | Yes | `?limit=20&cursor=...` | `200 OK { profiles: [...], nextCursor }` |
| `POST` | `/api/v1/discovery/swipe` | JWT + 18+ | Yes | `{ toUser: "<id>", action: "like"|"pass" }` | `200 OK { matched: boolean, matchId? }` |
| `GET` | `/api/v1/discovery/likes-you` | JWT + 18+ | No | `?limit=20&cursor=...` | `200 OK { likes: [...], nextCursor }` |
| `POST` | `/api/v1/discovery/reset` | JWT + 18+ | Yes | None | `200 OK { message: "Swipes reset" }` |
| `GET` | `/api/v1/matches` | JWT + 18+ | No | `?limit=20&cursor=...` | `200 OK { matches: [...], nextCursor }` |
| `POST` | `/api/v1/matches/:matchId/unmatch` | JWT | Yes | `{ reason? }` | `200 OK { success: true }` |
| `GET` | `/api/v1/conversations` | JWT + 18+ | No | None | `200 OK { conversations: [...] }` |
| `GET` | `/api/v1/conversations/:id/messages` | JWT + 18+ | No | `?limit=50&before=...` | `200 OK { messages: [...], hasMore }` |
| `PUT` | `/api/v1/conversations/:id/read` | JWT + 18+ | No | None | `200 OK { success: true }` |
| `GET` | `/api/v1/webrtc/ice-servers` | JWT | No | None | `200 OK { iceServers: [...], transportPolicy }` |
| `POST` | `/api/v1/safety/block` | JWT | Yes | `{ targetUserId, reason? }` | `200 OK { message: "User blocked" }` |
| `POST` | `/api/v1/safety/report` | JWT | Yes | `{ reportedUserId, category, description? }` | `201 Created { message: "Report submitted" }` |
| `GET` | `/health` | Public | No | None | `200 OK { status: "ok", uptime }` |
| `GET` | `/api/v1/health` | Public | No | None | `200 OK { status: "healthy", ready: true, database: "connected" }` |

---

## Part 5: Production Deployment vs. Local Docker Architecture

| Dimension | Live Production Deployment | Local Docker Development (`Phase 5A`) |
|---|---|---|
| **Frontend Host** | **Vercel** (`https://www.engaze.date`, `https://engaze-com.vercel.app`) | `http://localhost:3000` (Node/npm dev server or preview) |
| **Backend Host** | **Render Web Service** (`Enagaze.com-Backend-1`) | Local Docker container (`engaze-dev-api`) via `docker-compose.dev.yml` |
| **Backend Runtime** | **Native Node.js** (`npm install` / `npm start`) | **Multi-stage Docker container** (`node:22-alpine`, non-root user `node`) |
| **Backend Port** | Dynamic via `PORT` env (`10000` on Render) | `127.0.0.1:8000->8000/tcp` (Loopback only) |
| **MongoDB Target** | **MongoDB Atlas** Production Cluster | **MongoDB Atlas** Dev Cluster (injected via `MONGO_URI`) |
| **Redis / Valkey** | **Disabled** (`REDIS_ENABLED=false`) | **Active Container** (`engaze-dev-redis` on `127.0.0.1:6382`) |
| **Background Worker** | **Disabled** (No worker service on Render) | **Active Container** (`engaze-dev-worker`, `npm run worker`) |
| **Media Cleanup** | **Inline Fallback** via S3 `deleteObject` | **BullMQ Queue Processor** (`engaze:dev:bullmq:media-cleanup`) |
| **Presence Mode** | **Process-Local Memory** (Grace timer Map) | **Redis-backed or Local Memory** (Configurable) |
| **Rate Limiter Store**| **Express-Rate-Limit MemoryStore** | **RedisStore** via `rate-limit-redis` |
| **Monthly Extra Cost**| **$0** (Free Tier Web Service) | **$0** (Local Docker daemon) |

---

## Part 6: 70 Deep-Dive Technical Interview Questions & Answers

### Section A: Architecture & System Design (15 Questions)

#### Q1: Can you describe the high-level architecture of Engaze.com?
- **English Answer**: Engaze is a full-stack dating and real-time social application built on a decoupled architecture. The frontend is a React 18 Single Page Application deployed globally on Vercel's Edge Network, connected to our custom domain `engaze.date`. The backend is a Node.js Express service deployed on Render, communicating with MongoDB Atlas for persistent storage, AWS S3 for direct presigned photo storage, and Socket.IO for real-time signaling. WebRTC audio and video calls run peer-to-peer between client browsers, offloading media bandwidth from our application servers.
- **Hinglish**: Engaze ek decoupled architecture par bana hai. Frontend React 18 SPA hai jo Vercel par hosted hai aur custom domain `engaze.date` se chalta hai. Backend Express Node.js service hai jo Render par deployed hai. Database MongoDB Atlas hai, photos AWS S3 par presigned URLs ke through direct upload hoti hain, aur real-time chat/calling ke liye Socket.IO use hota hai. Video calling P2P WebRTC par chalti hai jisse server par video streaming ka koi load nahi padta.
- **Likely Follow-Up**: How does the frontend discover the backend API URL across development and production?
- **Code to Inspect**: [frontend/src/environment.js](file:///d:/code/Engaze.com/frontend/src/environment.js#L1-L28).

#### Q2: Why did you choose direct-to-S3 uploads with presigned URLs instead of multipart form uploads through the Express server?
- **English Answer**: Streaming media through an application server creates a major performance and memory bottleneck. Node.js is single-threaded; parsing multipart 5MB photo uploads in memory blocks the event loop and monopolizes server network bandwidth. With presigned URLs, our Express API only performs lightweight HMAC token generation and AWS SigV4 signing (~2ms). The heavy binary transfer occurs directly between the user's browser and AWS S3, allowing our API instances to scale independently of media traffic.
- **Hinglish**: Agar images pehle backend server par aati, toh 5MB ki multiple uploads single-threaded Node.js event loop aur RAM ko exhaust kar deti. Presigned URL se backend sirf ek cryptographic signature generate karta hai jo miliseconds me ho jata hai. Heavy binary upload direct browser se AWS S3 ke bucket me chali jaati hai, jisse hamare server ka bandwidth aur CPU dono save hote hain.
- **Likely Follow-Up**: What prevents a malicious user from using that presigned URL to upload a 50GB video or an executable script?
- **Code to Inspect**: [backend/src/services/s3Signer.service.js](file:///d:/code/Engaze.com/backend/src/services/s3Signer.service.js#L30-L75), [backend/src/services/imageValidation.service.js](file:///d:/code/Engaze.com/backend/src/services/imageValidation.service.js#L20-L60).

#### Q3: How do you handle mutual match race conditions when two users like each other simultaneously?
- **English Answer**: We prevent duplicate mutual matches at the database schema level using canonical user pairs. In `Match` (`match.model.js`), we define a `userPair` string field with a `unique: true` index. The static helper `Match.getCanonicalPair(id1, id2)` deterministically sorts the two ObjectIds (`id1 < id2 ? id1_id2 : id2_id1`). Even if User A and User B swipe right at the exact same millisecond across two concurrent server processes, the database enforces the unique constraint, and `findOneAndUpdate` with `upsert: true` guarantees exactly one match and one associated conversation thread.
- **Hinglish**: Jab do users ek hi time par ek dusre ko like karte hain, toh duplicate match create hone ka race condition ban sakta hai. Isko solve karne ke liye humne `match.model.js` me `userPair` field banaya hai with a unique index. Dono user IDs ko alphabetically sort karke canonical string banayi jaati hai (e.g. `UserA_UserB`). Agar dono request ek sath aati hain, toh MongoDB ka unique index duplicate entry ko block kar deta hai aur exactly ek hi match banta hai.
- **Likely Follow-Up**: What happens if the second request throws a duplicate key error (E11000)?
- **Code to Inspect**: [backend/src/models/match.model.js](file:///d:/code/Engaze.com/backend/src/models/match.model.js#L45-L50), [backend/src/services/matching.service.js](file:///d:/code/Engaze.com/backend/src/services/matching.service.js#L50-L90).

#### Q4: Why is WebRTC media peer-to-peer rather than routed through a Media Server (SFU/MCU)?
- **English Answer**: Engaze is designed for 1-on-1 dating interactions and speed dating. For two participants, P2P delivers the lowest possible latency because packets take the direct physical route between peers without an intermediate server hop. Furthermore, routing video through an SFU requires costly high-bandwidth cloud infrastructure. We use our backend solely as an un-opinionated signaling relay for SDP offers, answers, and ICE candidate trickling.
- **Hinglish**: Dating app me calling 1-on-1 hoti hai, group calls nahi hote. P2P se dono users ke beech lowest latency milti hai kyunki video packet direct travel karte hain. Agar hum SFU/MCU lagate toh bohot zyada cloud bandwidth aur server cost lagti. Hamara Express server sirf shuru me signaling (SDP offer/answer exchange) karwata hai, uske baad video direct dono users ke browser ke beech chalti hai.
- **Likely Follow-Up**: What happens when users are behind strict symmetric NATs or corporate firewalls that block direct UDP packets?
- **Code to Inspect**: [backend/src/config/webrtc.js](file:///d:/code/Engaze.com/backend/src/config/webrtc.js#L62-L115), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L600-L750).

#### Q5: What is the architectural role of BullMQ and Redis in Engaze?
- **English Answer**: BullMQ acts as our resilient background worker queue for non-critical, deferred asynchronous tasks—specifically media cleanup. When a user replaces an old profile photo, deleting the old S3 object is an asynchronous cleanup task. Instead of delaying the HTTP response, we enqueue a job into Redis. If Redis is down or BullMQ is disabled, our architecture gracefully falls back to an inline deletion without throwing an unhandled exception or breaking the user experience.
- **Hinglish**: BullMQ hamara background job queue hai jo Redis ke upar chalta hai. Iska primary use media cleanup ke liye hai—jab koi user photo badalta hai, toh puraani S3 photo delete karne ka kaam background worker ko de diya jaata hai. Isse user ko instant response milta hai. Agar Redis off bhi ho, toh hamara code safely inline fallback karta hai.
- **Likely Follow-Up**: Why is BullMQ disabled by default in production on Render?
- **Code to Inspect**: [backend/src/services/storage.service.js](file:///d:/code/Engaze.com/backend/src/services/storage.service.js#L610-L628), [backend/src/config/queue.js](file:///d:/code/Engaze.com/backend/src/config/queue.js#L1-L60).

#### Q6: How does the application maintain data isolation and prevent unauthorized photo deletion?
- **English Answer**: S3 keys follow a strict hierarchical convention: `profile-photos/${userId}/${cryptoRandomString}.webp`. In `photoUpload.controller.js` and `mediaCleanup.worker.js`, we enforce ownership verification before initiating any S3 delete command. The worker explicitly checks `key.startsWith('profile-photos/' + userId + '/')`. If an attacker manipulates a payload to target another user's key, the job is immediately aborted and logged as an authorization violation.
- **Hinglish**: Har user ki photo ka path `profile-photos/${userId}/...` hota hai. Jab bhi delete request aati hai, controller aur worker dono verify karte hain ki requested key authenticated user ke hi ID folder me hai ya nahi. Agar koi dusre user ki photo delete karne ki koshish karega, toh code turant usko abort kar dega.
- **Likely Follow-Up**: What prevents an attacker from passing a path traversal sequence like `../` in the key?
- **Code to Inspect**: [backend/src/workers/mediaCleanup.worker.js](file:///d:/code/Engaze.com/backend/src/workers/mediaCleanup.worker.js#L20-L45), [backend/src/services/storage.service.js](file:///d:/code/Engaze.com/backend/src/services/storage.service.js#L810-L825).

#### Q7: How does Engaze enforce its strict 18+ adult age policy?
- **English Answer**: Age verification is enforced as an architectural invariant across three layers:
  1. **Schema Layer**: `user.model.js` uses a custom validator on the `dob` field using `calculateExactAge(dob) >= 18`.
  2. **Route Middleware Layer**: The `requireEligibility` middleware (`eligibility.service.js`) guards all discovery, swiping, matching, and chat routes. It rejects unverified profiles or users under 18 with HTTP 403.
  3. **Discovery Query Layer**: Queries in `discovery.controller.js` compute maximum allowed birth dates and filter out any incomplete or underage documents directly in MongoDB.
- **Hinglish**: 18+ policy 3 layers me enforced hai: Pehla Mongoose schema validator jo 18 saal se kam dob save hi nahi hone deta; Doosra `requireEligibility` middleware jo swipe, match aur chat routes ko 403 Forbidden se block karta hai; aur teesra discovery query jo database level par hi underage profiles ko filter out karti hai.
- **Likely Follow-Up**: How do you calculate exact age taking leap years and specific birth dates into account without drift?
- **Code to Inspect**: [backend/src/services/eligibility.service.js](file:///d:/code/Engaze.com/backend/src/services/eligibility.service.js#L10-L60), [backend/src/models/user.model.js](file:///d:/code/Engaze.com/backend/src/models/user.model.js#L50-L60).

#### Q8: How does the application prevent duplicate message delivery during poor network conditions?
- **English Answer**: We implement client-side idempotency keys. When a user sends a chat message, the React client generates a unique `clientTempId` (UUID) and passes it over the `chat:send` Socket.IO event. In MongoDB, our `Message` schema features a compound unique index on `{ conversation: 1, sender: 1, clientTempId: 1 }` backed by a partial filter expression. If a mobile device loses connection, reconnects, and retries the emit, MongoDB rejects the duplicate insert with code 11000, and the socket controller returns the existing message without creating duplicate entries.
- **Hinglish**: Poor network me message duplicate hone se bachane ke liye frontend har message ke sath ek unique `clientTempId` bhejta hai. MongoDB me `(conversation, sender, clientTempId)` par unique partial index laga hai. Agar phone reconnect hoke wahi message dobara send karta hai, toh MongoDB duplicate entry reject kar deta hai aur chat me do baar message show nahi hota.
- **Likely Follow-Up**: Why did you use a partial filter expression instead of a simple sparse index?
- **Code to Inspect**: [backend/src/models/message.model.js](file:///d:/code/Engaze.com/backend/src/models/message.model.js#L47-L58), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L200-L260).

#### Q9: How is graceful shutdown handled in the backend?
- **English Answer**: In `src/app.js`, we intercept `SIGTERM` and `SIGINT` signals. The `gracefulShutdown` handler:
  1. Sets `isShuttingDown = true` to activate drain middleware (rejecting new incoming HTTP requests with 503).
  2. Broadcasts `server_restarting` to all connected Socket.IO clients and disconnects sockets cleanly.
  3. Stops the HTTP server listener and drains keep-alive connections.
  4. Flushes and closes BullMQ queue producers, Redis connections, and Mongoose connection pools.
  5. Features a bounded force-kill fallback timer (`SHUTDOWN_TIMEOUT_MS`, default 10s) to prevent container shutdown deadlocks.
- **Hinglish**: Deployment ke waqt zero-downtime restart ke liye hum `SIGTERM` ko handle karte hain. Server naye requests ko 503 deta hai, connected socket users ko restart notice bhejta hai, pending HTTP connections drain karta hai, aur Redis/MongoDB connections ko safely close karta hai. Ek 10 second ka safety timer hota hai taaki process kabhi hang na ho.
- **Likely Follow-Up**: What happens to in-flight database write queries when `mongoose.disconnect()` is called?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L588-L685).

#### Q10: How does the application scale horizontally if multiple backend instances are deployed?
- **English Answer**: The backend is architected for horizontal scalability through Redis:
  - **Socket.IO**: Uses `@socket.io/redis-adapter` with dedicated pub/sub Redis connections so broadcasts reach clients on any instance.
  - **Presence**: Migrated from local memory to Redis Sorted Sets with expiring socket leases.
  - **Rate Limiting**: Uses `rate-limit-redis` to share sliding-window request counters across instances.
  - **Matchmaking**: Employs Redis Sorted Sets and atomic Lua scripts for cross-instance candidate pairing.
  - Note: All distributed adapters are isolated behind feature flags and currently run in local single-instance mode in production.
- **Hinglish**: Horizontally scale karne ke liye Redis use hota hai: Socket.IO Redis adapter se cross-instance messaging hoti hai, Redis Sorted Sets se presence aur matchmaking sync hoti hai, aur Redis rate limiter shared counters maintain karta hai. Sabhi features feature flags ke peeche hain taaki single-instance me bina Redis ke bhi smoothly chale.
- **Likely Follow-Up**: What is the difference between `@socket.io/redis-adapter` and `@socket.io/redis-streams-adapter`?
- **Code to Inspect**: [backend/src/services/socketRedisAdapter.service.js](file:///d:/code/Engaze.com/backend/src/services/socketRedisAdapter.service.js#L1-L70), [backend/src/config/redis.js](file:///d:/code/Engaze.com/backend/src/config/redis.js#L24-L37).

#### Q11: Why is pagination in the discovery and likes-you feeds cursor-based rather than offset-based?
- **English Answer**: Offset pagination (`skip` + `limit`) degrades significantly at scale ($O(N)$ scan time) and causes duplicate or missing items when users swipe while browsing. Cursor pagination utilizes our compound indexes (`dob: 1, _id: -1` or `createdAt: -1, _id: -1`). The query filters directly using `$lt` or `$gt` on the indexed cursor fields, providing consistent $O(\log N)$ index seek performance and stable feeds regardless of concurrent inserts or deletes.
- **Hinglish**: `skip()` aur `limit()` se database ko shuru ke saare records scan karke discard karne padte hain jo large datasets me bohot slow hota hai ($O(N)$). Cursor pagination me hum last seen record ki date aur ID ko index seek ($O(\log N)$) ke liye use karte hain, jisse infinite scroll fast rehta hai aur naye swipes aane par duplicate profiles nahi dikhti.
- **Likely Follow-Up**: How do you tie-break cursor queries when multiple documents share the exact same timestamp?
- **Code to Inspect**: [backend/src/controllers/discovery.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/discovery.controller.js#L50-L120), [backend/src/utils/queryHelper.js](file:///d:/code/Engaze.com/backend/src/utils/queryHelper.js).

#### Q12: How do you handle user privacy regarding "Last Seen" and "Online" presence?
- **English Answer**: In `presence.service.js`, presence visibility is computed dynamically based on the target user's granular `privacySettings`:
  - `everyone`: Any user can view online status and last seen timestamp.
  - `matches`: Only active mutual matches can view presence.
  - `matches_except`: Active matches can view, excluding users listed in `lastSeenExceptions`.
  - `nobody`: Presence is hidden from all viewers.
  - We also enforce bidirectional reciprocity: if a viewer cannot be seen, they cannot see others.
- **Hinglish**: `presence.service.js` me WhatsApp jaisi granular privacy settings hain: `everyone`, `matches`, `matches_except`, aur `nobody`. Server real-time presence emit karne se pehle check karta hai ki viewer ko permission hai ya nahi, aur permission na hone par timestamp redact kar deta hai.
- **Likely Follow-Up**: How does the frontend handle rendering when `isOnline` is false and `lastSeenAt` is null?
- **Code to Inspect**: [backend/src/services/presence.service.js](file:///d:/code/Engaze.com/backend/src/services/presence.service.js#L120-L180), [frontend/src/utils/presenceFormatters.js](file:///d:/code/Engaze.com/frontend/src/utils/presenceFormatters.js#L1-L60).

#### Q13: What happens when a user blocks another user?
- **English Answer**: Blocking is immediate, permanent, and cascades across all subsystems:
  1. `Block.create({ blocker, blocked })` records the relationship.
  2. Any active mutual match in `Match` is updated to `status: 'unmatched'`.
  3. Any active 1-on-1 or speed-dating WebRTC call between the two users is terminated immediately via `endActiveCallBetweenUsers()`.
  4. Real-time socket events `user:blocked` and `match:unmatched` notify both clients.
  5. Discovery, search, and notification queries exclude blocked user IDs via `getBlockedUserIds()`.
- **Hinglish**: Jab User A User B ko block karta hai, toh `Block` record banta hai, mutual match break ho jata hai, agar koi call chal rahi ho toh turant cut ho jaati hai, socket ke through dono ko notify kiya jaata hai, aur discovery/search se dono ek dusre ke liye hamesha ke liye gayab ho jaate hain.
- **Likely Follow-Up**: How is bidirectional block checking optimized so it doesn't execute two separate database queries on every profile view?
- **Code to Inspect**: [backend/src/services/safety.service.js](file:///d:/code/Engaze.com/backend/src/services/safety.service.js#L25-L90), [backend/src/models/block.model.js](file:///d:/code/Engaze.com/backend/src/models/block.model.js#L30-L60).

#### Q14: How does the random speed-dating matchmaking queue work?
- **English Answer**: In `randomCallManager.js`, users enter the queue via `random:join-queue`. When two eligible users are queued:
  1. The server pairs them and emits `random:matched`.
  2. Both users must explicitly send `random:consent` within a strict timeout window.
  3. Once consent is verified, both clients probe local cameras and send `random:media-ready`.
  4. Only after mutual media readiness does WebRTC signaling begin via `random:signal`.
  5. If either party declines or leaves, the other user is immediately placed back in the front of the queue via `random:next`.
- **Hinglish**: Speed-dating matchmaking double-opt-in model par kaam karta hai: Match hone ke baad dono users ko `consent` dena padta hai. Phir dono ke device ka camera/mic ready hone ka check hota hai (`media-ready`). Uske baad hi video connect hoti hai. Agar ek user call cut karta hai, toh doosre user ko turant naye match ke liye queue me daal diya jaata hai.
- **Likely Follow-Up**: How do you prevent two server processes from popping the same candidate from the queue concurrently in multi-instance mode?
- **Code to Inspect**: [backend/src/controllers/randomCallManager.js](file:///d:/code/Engaze.com/backend/src/controllers/randomCallManager.js#L1-L150), [backend/src/services/randomMatchmakingRedis.service.js](file:///d:/code/Engaze.com/backend/src/services/randomMatchmakingRedis.service.js#L30-L90).

#### Q15: What is the purpose of the `/api/v1/health` and `/readyz` probes?
- **English Answer**: We distinguish between liveness and readiness:
  - **Liveness (`/health`, `/livez`)**: Confirms the Node.js event loop is running and accepting HTTP connections (returns 200). Used by Render orchestrators to detect process deadlocks.
  - **Readiness (`/api/v1/health`, `/readyz`)**: Confirms all downstream critical dependencies are healthy. It validates `mongoose.connection.readyState === 1`, and if Redis or BullMQ are enabled, verifies their connection status. If MongoDB is disconnected, it returns HTTP 503, signaling load balancers to halt traffic routing.
- **Hinglish**: Liveness probe (`/health`) check karta hai ki Node.js process alive hai ya crash ho gaya. Readiness probe (`/api/v1/health`) check karta hai ki database (MongoDB) aur Redis ready hain ya nahi. Agar MongoDB disconnect ho jaye, toh readiness 503 deta hai taaki Render us instance par traffic bhejna band kar de.
- **Likely Follow-Up**: Why does Render free tier take 30–50 seconds on cold start?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L101-L189).

---

### Section B: Backend, API & Node.js Deep-Dive (15 Questions)

#### Q16: Why did you configure `"type": "module"` in package.json and how does it affect Node.js execution?
- **English Answer**: Setting `"type": "module"` activates native ECMAScript Modules (ESM) in Node.js instead of legacy CommonJS (`require`). ESM provides static module resolution, enabling better tree-shaking, official asynchronous loading semantics, and top-level `await`. In our code, we use `import.meta.url` and `fileURLToPath` to derive directory paths (`__dirname`) safely in ESM mode.
- **Hinglish**: `"type": "module"` se Node.js native ES modules use karta hai jisme `import`/`export` syntax chalta hai. Isse modern tooling, tree-shaking aur top-level `await` ka support milta hai. ESM me `__dirname` direct available nahi hota, isliye hum `fileURLToPath(import.meta.url)` se path nikaalte hain.
- **Likely Follow-Up**: How do you dynamically import a module conditionally in ESM?
- **Code to Inspect**: [backend/package.json](file:///d:/code/Engaze.com/backend/package.json#L6), [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L65-L68).

#### Q17: Why did you choose `bcryptjs` over the native `bcrypt` library?
- **English Answer**: Native `bcrypt` compiles C++ binaries during `npm install` using `node-gyp` and Python. When developers build or run tests across Windows host machines and deploy to Alpine Linux containers or Render, differences in libc (glibc vs musl) frequently cause "invalid ELF header" fatal crashes. `bcryptjs` is pure JavaScript, ensuring 100% cross-platform reproducibility and container parity without system build dependencies.
- **Hinglish**: Native `bcrypt` me C++ code compile hota hai jo Windows aur Linux/Alpine ke beech "invalid ELF header" ka crash deta hai. `bcryptjs` pure JavaScript implementation hai, isliye ye bina kisi C++ build tools ke har platform aur Docker container me flawlessly chalta hai.
- **Likely Follow-Up**: What is the performance trade-off between native `bcrypt` and pure JS `bcryptjs`?
- **Code to Inspect**: [backend/package.json](file:///d:/code/Engaze.com/backend/package.json#L21), [backend/README.md](file:///d:/code/Engaze.com/backend/README.md#L642-L646).

#### Q18: What is the purpose of `app.set("trust proxy", 1)` in Express?
- **English Answer**: In production, Engaze runs behind Render's reverse proxy load balancer. By default, Express treats the incoming socket remote address as the client IP, which would register as Render's internal router IP for all users. Setting `"trust proxy", 1` instructs Express to trust the first hop of the `X-Forwarded-For` header, correctly resolving `req.ip` for rate limiting while preventing upstream IP spoofing.
- **Hinglish**: Production me Render ka load balancer requests ko forward karta hai. Agar hum `trust proxy: 1` set na karein, toh saare users ka IP Render ke proxy ka internal IP ban jaayega, aur rate limiting fail ho jaayegi. `trust proxy: 1` se Express first trusted hop se real user IP read karta hai.
- **Likely Follow-Up**: What happens if an attacker sends their own `X-Forwarded-For: 1.2.3.4` header from their client?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L90-L94).

#### Q19: How is brute-force protection implemented for the login endpoint?
- **English Answer**: We apply differentiated two-tier rate limiting via `express-rate-limit`:
  1. `loginIpLimiter`: Restricts requests per IP address (e.g., 20 attempts per 15 minutes) to block automated volumetric attacks.
  2. `loginAccountLimiter`: Restricts failed login attempts per username/account (5 attempts per 15 minutes) using a custom `keyGenerator`. This prevents distributed credential stuffing where an attacker rotates IP proxies targeting a single victim account.
- **Hinglish**: Login par do tarah ki rate limiting hai: IP limiter jo ek IP se zyada requests ko rokkta hai, aur Account limiter jo ek specific username par 5 se zyada wrong passwords aane par us account ko 15 minute ke liye block karta hai, chahe attacker alag-alag IP se request bhej raha ho.
- **Likely Follow-Up**: How does the rate limiter handle successful vs failed login attempts?
- **Code to Inspect**: [backend/src/middlewares/rateLimiter.middleware.js](file:///d:/code/Engaze.com/backend/src/middlewares/rateLimiter.middleware.js#L40-L95).

#### Q20: How does `imageValidation.service.js` inspect file types without trusting client extensions?
- **English Answer**: It inspects the binary buffer's "magic numbers" (the leading byte headers). A client can rename `malicious.exe` or `payload.svg` to `avatar.jpg`, but the underlying bytes do not change. We check:
  - JPEG: `0xFF 0xD8 0xFF`
  - PNG: `0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A`
  - WebP: `RIFF` at offset 0 and `WEBP` at offset 8.
  If the magic bytes don't match our allowlist, the file is rejected regardless of file extension or HTTP header.
- **Hinglish**: Extension ya `Content-Type` header par trust nahi karte kyunki attacker unhe asaani se spoof kar sakta hai. Hum file buffer ke pehle kuch bytes (magic numbers) check karte hain—jaise JPEG ke liye `0xFF 0xD8 0xFF`. Agar magic bytes allowlist se match nahi hote, toh file turant reject ho jaati hai.
- **Likely Follow-Up**: Why is SVG disallowed even though it is an image format?
- **Code to Inspect**: [backend/src/services/imageValidation.service.js](file:///d:/code/Engaze.com/backend/src/services/imageValidation.service.js#L21-L60).

#### Q21: What is the purpose of `express.json({ limit: "40kb" })`?
- **English Answer**: Express default JSON parser accepts up to 100kb, and unconfigured setups often accept unbounded payloads. Dating REST endpoints only exchange lightweight JSON objects (names, credentials, preferences). Setting a strict 40kb limit prevents memory exhaustion Denial of Service (DoS) attacks where malicious actors send megabytes of nested JSON to choke the parser.
- **Hinglish**: JSON body parser ka default limit restrict karke 40kb kar diya gaya hai. Hamare REST routes me sirf textual data aata hai. Agar koi attacker server ki RAM crash karne ke liye 100MB ka JSON bheje, toh Express use request shuru hone par hi 413 Payload Too Large fek kar reject kar deta hai.
- **Likely Follow-Up**: How do you upload 5MB profile photos if `express.json` is capped at 40kb?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L98-L99).

#### Q22: How does the Google OAuth verification verify token authenticity?
- **English Answer**: In `src/controllers/user.controller.js`, we initialize `OAuth2Client` with `GOOGLE_CLIENT_ID`. When the frontend sends `idToken`, we call `client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID })`. This cryptographically verifies Google's RSA signature using Google's public certificates, validates token expiration, and confirms the `aud` (audience) matches our application ID, preventing tokens minted for other apps from authenticating on Engaze.
- **Hinglish**: Backend Google ke public keys use karke JWT token ka RSA signature verify karta hai. Sath hi audience check hoti hai ki token hamare hi `GOOGLE_CLIENT_ID` ke liye issue hua hai ya kisi doosri app se churaya gaya hai. Verification ke baad verified email extract karke account link kiya jaata hai.
- **Likely Follow-Up**: What happens if a user signs up with local password first and later logs in with Google using the same email?
- **Code to Inspect**: [backend/src/controllers/user.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/user.controller.js#L140-L210).

#### Q23: Why do controllers return DTOs rather than raw Mongoose documents?
- **English Answer**: Raw Mongoose documents contain internal properties, virtuals, and sensitive fields like `password` hashes, internal tokens, and operational metadata. We use explicit serializers like `toPublicProfile` and `toMessageDto` (`src/serializers/profile.serializer.js`) or Mongoose `toJSON` transforms to ensure password hashes and internal version keys (`__v`) are never serialized to the client.
- **Hinglish**: Raw Mongoose document me password hash, token, aur private settings hoti hain. Serialization layer (DTO) se sirf safe public fields client ko bheji jaati hain taaki accidental data leak ya security vulnerability na ho.
- **Likely Follow-Up**: What is the performance impact of Mongoose document hydration vs `lean()` queries?
- **Code to Inspect**: [backend/src/serializers/profile.serializer.js](file:///d:/code/Engaze.com/backend/src/serializers/profile.serializer.js#L1-L60), [backend/src/models/user.model.js](file:///d:/code/Engaze.com/backend/src/models/user.model.js#L127-L143).

#### Q24: What is the purpose of `safeLean()` in `queryHelper.js`?
- **English Answer**: Standard Mongoose queries return heavy Mongoose Document instances with change-tracking and internal prototype chains. Using `.lean()` returns plain JavaScript objects, reducing memory allocation by ~70% and increasing query execution speed by ~3x for read-heavy feeds. Our `safeLean()` utility ensures that if a query is empty or malformed, it returns predictable plain objects without throwing unhandled prototype errors.
- **Hinglish**: Mongoose default me har document ke sath heavy methods attach karta hai jo RAM consume karte hain. `.lean()` use karne se database se direct lightweight plain JavaScript objects aate hain jo 3 guna fast hote hain aur read-heavy discovery feeds me memory bachaate hain.
- **Likely Follow-Up**: Can you call `.save()` on a document fetched with `.lean()`?
- **Code to Inspect**: [backend/src/utils/queryHelper.js](file:///d:/code/Engaze.com/backend/src/utils/queryHelper.js).

#### Q25: How does the backend prevent Server-Side Request Forgery (SSRF) during image URL handling?
- **English Answer**: In `imageValidation.service.js`, `validateExternalImageUrl` parses the URL, enforces `http:` or `https:` protocols, and validates the hostname against an approved host allowlist (`images.unsplash.com`, `lh3.googleusercontent.com`, `res.cloudinary.com`). It rejects internal IP ranges (`127.0.0.1`, `169.254.169.254` AWS metadata), private subnets (`10.0.0.0/8`, `192.168.0.0/16`), and non-standard ports.
- **Hinglish**: Agar backend kisi URL se photo fetch kare, toh attacker `http://169.254.169.254` daal kar cloud metadata ya internal network access kar sakta hai (SSRF). Hamara validator check karta hai ki domain sirf approved CDN allowlist me ho aur kisi bhi internal/private IP ko reject kar deta hai.
- **Likely Follow-Up**: What is DNS rebinding and how can it bypass simple hostname checks?
- **Code to Inspect**: [backend/src/services/imageValidation.service.js](file:///d:/code/Engaze.com/backend/src/services/imageValidation.service.js#L380-L450).

#### Q26: How does the application log database and system errors safely?
- **English Answer**: In `src/app.js`, `formatSafeDatabaseError` filters errors against an explicit allowlist of known safe error types (`MongoServerError`, `ValidationError`, `CastError`, etc.) and system error codes (`ECONNREFUSED`, `ETIMEDOUT`). It extracts only sanitized error names and messages, strictly preventing raw MongoDB Atlas connection strings containing database usernames and passwords from leaking into standard output or logging aggregators.
- **Hinglish**: Agar database connection fail ho, toh raw error me Atlas ka password print ho sakta hai. `formatSafeDatabaseError` sirf safe error codes aur messages allow karta hai aur database URL ya passwords ko logs me leak hone se rokkta hai.
- **Likely Follow-Up**: How does `formatSafeRedisError` achieve the same guarantee for Redis connection drops?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L223-L270), [backend/src/config/redis.js](file:///d:/code/Engaze.com/backend/src/config/redis.js#L384-L396).

#### Q27: How does JWT configuration validation fail closed in production?
- **English Answer**: In `src/config/jwt.js`, `validateJwtConfig` runs at server startup. In production (`NODE_ENV === "production"`), it checks that `JWT_SECRET` is defined, at least 32 characters long, and does not match a list of 16 disallowed default/insecure placeholders (like `"secret"`, `"password"`). If invalid, it logs a visible critical alert and calls `process.exit(1)`, refusing to boot with insecure cryptographic configuration.
- **Hinglish**: Server start hote hi `validateJwtConfig` check karta hai ki production me `JWT_SECRET` 32 characters se lamba ho aur koi default string na ho. Agar secret missing ya weak ho, toh server start hone se pehle hi `process.exit(1)` karke shutdown ho jata hai taaki insecure tokens na bane.
- **Likely Follow-Up**: Why is a dev fallback secret permitted when `NODE_ENV !== "production"`?
- **Code to Inspect**: [backend/src/config/jwt.js](file:///d:/code/Engaze.com/backend/src/config/jwt.js#L50-L100).

#### Q28: What is the purpose of the drain middleware in Express?
- **English Answer**: When a termination signal (`SIGTERM`) is received, the server enters a shutdown drain state. The drain middleware inspects every incoming request: if the request is not a health check probe (`/health`, `/livez`), it sets the `Connection: close` header and immediately responds with HTTP 503 (`status: "shutting_down"`). This signals reverse proxies and browsers not to reuse keep-alive sockets on an exiting instance.
- **Hinglish**: Server band hote waqt drain middleware active ho jata hai. Agar koi nayi request aati hai, toh server `Connection: close` ke sath 503 return kar deta hai, jisse load balancer ko pata chal jata hai ki is server par naye requests na bhejein.
- **Likely Follow-Up**: Why are health checks exempted from the 503 drain response during shutdown?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L190-L210).

#### Q29: How are unhandled promise rejections and uncaught exceptions handled?
- **English Answer**: In `server.listen()`, we bind `server.on("clientError")` to destroy malformed sockets. In direct execution modules, process-level signal listeners trap errors. In the BullMQ worker (`src/workers/index.js`), unhandled Redis client errors are caught and logged with sanitized strings, while fatal initialization errors invoke bounded worker teardown before terminating.
- **Hinglish**: Server sockets par `clientError` listener laga hai taaki corrupt HTTP requests process ko crash na karein. Worker me unhandled Redis errors par safe error formatting chalti hai aur crash hone se pehle graceful cleanup hota hai.
- **Likely Follow-Up**: Should a Node.js process continue running after an `uncaughtException` event?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L79-L85), [backend/src/workers/index.js](file:///d:/code/Engaze.com/backend/src/workers/index.js#L62-L68).

#### Q30: How does BullMQ ensure custom Job IDs do not violate Redis protocol delimiters?
- **English Answer**: BullMQ uses the colon character (`:`) internally as a key namespace separator. If custom job IDs contain colons, BullMQ's internal key parsing can corrupt job metadata keys. In Phase 4A.1, we introduced `generateMediaCleanupJobId(key, userId)` in `src/services/queue.service.js`. It computes a SHA-256 hash using `node:crypto` (`createHash("sha256").update(key + ":" + userId).digest("hex")`), yielding deterministic, colon-free IDs in the format `media-cleanup-[0-9a-f]{64}`.
- **Hinglish**: BullMQ Redis keys me namespace ke liye colon (`:`) use karta hai. Agar custom Job ID me colon ho toh Redis keys corrupt ho sakti hain. Isliye humne SHA-256 hash use karke colon-free deterministic ID banayi (`media-cleanup-<64hex>`), jo deduplication bhi karti hai aur delimiter bug ko bhi solve karti hai.
- **Likely Follow-Up**: How does a deterministic job ID enable deduplication in BullMQ?
- **Code to Inspect**: [backend/src/services/queue.service.js](file:///d:/code/Engaze.com/backend/src/services/queue.service.js#L40-L65).

---

### Section C: MongoDB & Database Engineering (10 Questions)

#### Q31: How is the MongoDB connection pool configured and why?
- **English Answer**: In `src/config/database.js`, we configure `maxPoolSize: 25`, `minPoolSize: 0`, and `serverSelectionTimeoutMS: 30000`. MongoDB drivers reuse a pool of TCP sockets. In serverless or containerized platforms like Render, setting `maxPoolSize: 25` prevents a cluster of 4 backend instances from exceeding Atlas M0/M10 connection quotas ($4 \times 25 = 100$ connections max). `minPoolSize: 0` allows idle sockets to close during inactivity.
- **Hinglish**: Connection pool database ke sath open sockets ka group hota hai. Humne `maxPoolSize: 25` rakha hai taaki agar multi-instances chal rahe hon, toh MongoDB Atlas ki total connection limit exhaust na ho. `minPoolSize: 0` idle connections ko release karke database resources bachaata hai.
- **Likely Follow-Up**: What is the danger of setting `maxPoolSize: 500` on a multi-instance deployment?
- **Code to Inspect**: [backend/src/config/database.js](file:///d:/code/Engaze.com/backend/src/config/database.js#L6-L89).

#### Q32: Explain the compound index on the Swipes collection and why order matters.
- **English Answer**: We have `{ toUser: 1, action: 1, createdAt: -1, _id: -1 }` on `swipes`. Index field ordering follows the **Equality, Sort, Range (ESR)** rule:
  1. Equality: `toUser: 1` (filter by current user receiving likes).
  2. Equality: `action: 1` (filter where action is `'like'`).
  3. Sort: `createdAt: -1, _id: -1` (deterministic reverse-chronological order).
  This index allows the "Likes You" feed to perform a pure index scan without loading unneeded rows or performing an expensive in-memory sort.
- **Hinglish**: Compound index me field order ESR rule (Equality, Sort, Range) follow karta hai. Pehle equality fields (`toUser`, `action`), phir sort fields (`createdAt`, `_id`). Is index ki wajah se database ko memory me sorting nahi karni padti, query directly B-Tree index se sorted data fetch karti hai.
- **Likely Follow-Up**: Why is `_id: -1` included in the sort alongside `createdAt: -1`?
- **Code to Inspect**: [backend/src/models/swipe.model.js](file:///d:/code/Engaze.com/backend/src/models/swipe.model.js#L30-L37), [backend/scripts/migrateIndexes.js](file:///d:/code/Engaze.com/backend/scripts/migrateIndexes.js#L30-L40).

#### Q33: How does the People Discovery search handle username and name queries efficiently?
- **English Answer**: Full regex searches like `.*term.*` cause un-indexed full collection scans. In `userSearch.controller.js`, we sanitize the search term, escape regex special characters, and anchor prefixes using `^term`. MongoDB can use the B-Tree index on `{ name: 1 }` and `{ isProfileComplete: 1, username: 1 }` for prefix matches (`^`), executing index range seeks rather than full scans.
- **Hinglish**: Agar search me bina anchor ke regex (`/term/`) lagayein toh database poora collection scan karta hai. Hum input ko sanitize karke prefix search (`^term`) banate hain. MongoDB B-Tree index prefix queries ke liye range scan use karta hai jo fast execute hota hai.
- **Likely Follow-Up**: When would you migrate to MongoDB Atlas Search (Lucene) instead of B-Tree indexes?
- **Code to Inspect**: [backend/src/controllers/userSearch.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/userSearch.controller.js#L1-L80), [backend/src/models/user.model.js](file:///d:/code/Engaze.com/backend/src/models/user.model.js#L153-L161).

#### Q34: What is a sparse index in MongoDB and where is it used in Engaze?
- **English Answer**: A sparse index only indexes documents that actually contain the indexed field, omitting documents where the field is null or missing. In `user.model.js`, `email` is indexed with `sparse: true`. Users signing up with username/password initially might not provide an email, or Google accounts might store emails. The sparse index prevents multiple null email documents from violating unique constraints and saves index memory.
- **Hinglish**: Sparse index sirf unhi documents ko index me rakhta hai jisme wo field exist karti hai. Humne `email` par sparse index lagaya hai taaki agar kisi user ka email missing/null ho, toh MongoDB use unique constraint violation na maane aur RAM bhi bache.
- **Likely Follow-Up**: What is the difference between a sparse index and a partial index with `partialFilterExpression`?
- **Code to Inspect**: [backend/src/models/user.model.js](file:///d:/code/Engaze.com/backend/src/models/user.model.js#L22-L27), [backend/scripts/migrateIndexes.js](file:///d:/code/Engaze.com/backend/scripts/migrateIndexes.js#L18-L28).

#### Q35: How does the application prevent duplicate swipes?
- **English Answer**: In `swipe.model.js`, we define a compound unique index: `swipeSchema.index({ fromUser: 1, toUser: 1 }, { unique: true })`. If a user spams swipe buttons or parallel requests arrive, MongoDB guarantees that User A can have at most one swipe record targeting User B.
- **Hinglish**: `swipes` collection par `{ fromUser: 1, toUser: 1 }` ka unique compound index hai. Agar user app par double click kare ya network lag ki wajah se 2 request chale jayein, toh database level par duplicate swipe insert nahi ho sakti.
- **Likely Follow-Up**: How does the "Reset Passes" feature work with this unique index?
- **Code to Inspect**: [backend/src/models/swipe.model.js](file:///d:/code/Engaze.com/backend/src/models/swipe.model.js#L31-L32), [backend/src/controllers/discovery.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/discovery.controller.js#L210-L245).

#### Q36: How does Mongoose virtual `age` work and why isn't age stored as a static field?
- **English Answer**: Storing a static `age` integer in the database is an anti-pattern because age increments yearly without database writes. Instead, we store static `dob` (Date of Birth) and compute a virtual getter `userSchema.virtual("age").get(function() { return calculateExactAge(this.dob); })`. Virtuals compute dynamically when documents are serialized to JSON without requiring database storage.
- **Hinglish**: Database me static age number store karna galat hai kyunki har saal birthday par background update chalana padega. Hum Date of Birth (`dob`) store karte hain aur Mongoose virtual se run-time par exact age calculate karke JSON response me inject karte hain.
- **Likely Follow-Up**: Can you query a collection directly using a virtual field in `find({ age: 25 })`?
- **Code to Inspect**: [backend/src/models/user.model.js](file:///d:/code/Engaze.com/backend/src/models/user.model.js#L146-L151).

#### Q37: How are unread message counts queried without unbounded full-collection scans?
- **English Answer**: In `conversationSchema`, we index `{ participants: 1, lastMessageAt: -1 }`. In `messageSchema`, we compound index `{ conversation: 1, sender: 1, readBy: 1 }`. When counting unread messages in a conversation, the query targets `Message.countDocuments({ conversation: convId, sender: { $ne: currentUserId }, readBy: { $ne: currentUserId } })`. The index directly satisfies the filter without reading message content strings.
- **Hinglish**: Unread count ke liye `{ conversation: 1, sender: 1, readBy: 1 }` par compound index laga hai. Query unread count nikaalne ke liye message ka content load nahi karti, balki index B-Tree se direct count nikaal leti hai.
- **Likely Follow-Up**: How would you optimize this if conversations have millions of messages?
- **Code to Inspect**: [backend/src/models/message.model.js](file:///d:/code/Engaze.com/backend/src/models/message.model.js#L44-L45).

#### Q38: Why do we denormalize `lastMessage` and `lastMessageAt` on the `Conversation` document?
- **English Answer**: In a normalized schema, displaying a user's inbox requires an aggregation pipeline that joins (`$lookup`) the `messages` collection for every conversation, finds the most recent message, and sorts by timestamp. By denormalizing `lastMessage` and `lastMessageAt` into `Conversation`, rendering the inbox requires a simple single-collection query `Conversation.find({ participants: userId }).sort({ lastMessageAt: -1 })`, which executes in sub-millisecond time.
- **Hinglish**: Agar hum denormalize na karein, toh inbox dikhane ke liye har conversation ke liye `$lookup` join chalana padega jo database ko slow kar dega. `lastMessageAt` ko `Conversation` me store karne se inbox listing ek simple indexed query se instant load ho jaati hai.
- **Likely Follow-Up**: What is the trade-off of denormalization when a message is deleted or updated?
- **Code to Inspect**: [backend/src/models/conversation.model.js](file:///d:/code/Engaze.com/backend/src/models/conversation.model.js#L19-L29), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L230-L245).

#### Q39: What index migration strategy was implemented in Phase 2D.1?
- **English Answer**: We designed a safe, additive, zero-downtime migration script in `scripts/migrateIndexes.js`. The script runs in dry-run mode by default, logging all planned indexes without opening database connections. When executed with `--execute`, it uses explicit names (e.g., `toUser_1_action_1_createdAt_-1__id_-1`) and creates indexes in the background (`background: true`) so MongoDB continues serving live client queries without table locks.
- **Hinglish**: Index migration ke liye safe additive script banaya gaya jo default me dry-run chalta hai. Execute hone par wo sabhi indexes ko explicit names deta hai aur `background: true` use karta hai taaki live database par table lock na lage aur users ka traffic uninterrupted rahe.
- **Likely Follow-Up**: How does MongoDB handle index builds in version 4.2+ vs older versions?
- **Code to Inspect**: [backend/scripts/migrateIndexes.js](file:///d:/code/Engaze.com/backend/scripts/migrateIndexes.js#L16-L100).

#### Q40: What happens if a database query times out during server load?
- **English Answer**: `MONGO_SERVER_SELECTION_TIMEOUT_MS` is set to 30,000ms. In query helpers and controllers, errors are caught by centralized Express error handlers. The handler detects `MongoTimeoutError`, formats a safe error without leaking connection strings via `formatSafeDatabaseError`, and responds with HTTP 503 (`STORAGE_UNAVAILABLE` or `SERVICE_UNAVAILABLE`), preventing thread hangs.
- **Hinglish**: Agar database respond na kare, toh 30 second me timeout trigger hota hai. Express ka error handler use catch karta hai aur user ko sanitized 503 error deta hai taaki server thread hang na rahe aur connection strings leak na hon.
- **Likely Follow-Up**: What is circuit breaking and how would you implement it for MongoDB queries?
- **Code to Inspect**: [backend/src/config/database.js](file:///d:/code/Engaze.com/backend/src/config/database.js#L68-L76), [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L223-L250).

---

### Section D: Real-Time Chat, WebRTC & Socket.IO (10 Questions)

#### Q41: How is Socket.IO authenticated and secured against unauthorized connection?
- **English Answer**: We use handshake middleware in `connectToSocket` (`socketManager.js`). When a socket connects, `io.use()` extracts the JWT from `socket.handshake.auth.token`, `headers.authorization`, or query parameters. The token is cryptographically verified against `JWT_SECRET`. If valid, the user's ObjectId is attached to `socket.userId` and the socket automatically joins an isolated user room: `socket.join("user:" + user._id)`. If missing or invalid, `next(new Error("Authentication error"))` rejects the connection before the WebSocket upgrade completes.
- **Hinglish**: Socket.IO connection ke time `io.use()` handshake middleware chalta hai. Ye handshake headers ya auth object se JWT token nikaal kar verify karta hai. Token valid hone par hi connection allow hota hai aur socket ko uske private room (`user:<id>`) me daal diya jaata hai. Invalid token turant disconnect ho jata hai.
- **Likely Follow-Up**: Why do we join `user:${userId}` room upon connection?
- **Code to Inspect**: [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L85-L135).

#### Q42: What is the sequence of events during a WebRTC 1-on-1 call setup?
- **English Answer**:
  1. Caller emits `call:initiate` over Socket.IO to signaling server.
  2. Server verifies mutual match, not blocked, and emits `call:incoming` to callee's socket room.
  3. Callee accepts and emits `call:accept`. Server notifies caller with `call:accepted`.
  4. Caller creates an SDP Offer via `RTCPeerConnection.createOffer()`, sets local description, and sends it via `call:signal`.
  5. Callee receives offer, sets remote description, creates SDP Answer, sets local description, and returns it via `call:signal`.
  6. Simultaneously, both clients trickle ICE candidates over `call:signal`.
  7. Once ICE connectivity checks complete, the P2P media stream binds directly to HTML5 `<video>` tags.
- **Hinglish**: 1. Caller `call:initiate` bhejta hai. 2. Server callee ko `call:incoming` emit karta hai. 3. Callee accept karta hai. 4. Caller WebRTC Offer banata hai aur Socket ke through callee ko bhejta hai. 5. Callee Answer bana kar wapas bhejta hai. 6. Dono ICE candidates exchange karte hain. 7. Browser to browser direct peer connection ban jaata hai aur video stream chalu ho jaati hai.
- **Likely Follow-Up**: What is the difference between an SDP Offer and an ICE Candidate?
- **Code to Inspect**: [frontend/src/contexts/DirectCallContext.jsx](file:///d:/code/Engaze.com/frontend/src/contexts/DirectCallContext.jsx#L100-L240), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L550-L680).

#### Q43: How are STUN and TURN servers used in Engaze?
- **English Answer**: WebRTC needs to discover public IP addresses and port mappings across NAT firewalls:
  - **STUN (Session Traversal Utilities for NAT)**: Resolves public reflex addresses for peers behind simple NATs. We configure Google public STUN servers by default.
  - **TURN (Traversal Using Relays around NAT)**: Acts as a fallback media relay when peers are behind symmetric NATs that block direct P2P UDP connections.
  - In `src/config/webrtc.js`, `getIceServersConfig` dynamically generates ephemeral HMAC credentials (RFC 5766) if `TURN_SECRET` is present. If unconfigured, it safely falls back to STUN-only mode.
- **Hinglish**: STUN server user ke router ka public IP nikaalne ke kaam aata hai taaki P2P connection ban sake. Lekin agar dono users strict firewall ya mobile 4G/5G par hon jahan P2P block ho, toh TURN server media relay ki tarah video packets forward karta hai. Code me Google public STUN default hai, aur TURN ke liye dynamic HMAC tokens bante hain.
- **Likely Follow-Up**: Why is running a TURN server expensive compared to a STUN server?
- **Code to Inspect**: [backend/src/config/webrtc.js](file:///d:/code/Engaze.com/backend/src/config/webrtc.js#L1-L105), [backend/src/controllers/webrtc.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/webrtc.controller.js#L90-L135).

#### Q44: How does socket rate limiting prevent message and event flooding?
- **English Answer**: In `src/utils/socketValidator.js`, `checkSocketRateLimit` implements an in-memory sliding token bucket per socket connection. High-frequency events (`chat:send`, `chat:typing`, `call:initiate`, `random:join-queue`) are capped (e.g., max 30 chat sends per minute). If a modified client spams events, the socket emits an error callback and drops the event without database write operations.
- **Hinglish**: HTTP ki tarah socket connections par bhi flooding attack ho sakta hai. `checkSocketRateLimit` har socket ke liye token bucket maintain karta hai. Agar koi script `chat:send` ya `call:initiate` flood kare, toh rate limiter use drop kar deta hai aur database par koi query nahi jaati.
- **Likely Follow-Up**: How does socket rate limiting adapt when running in a multi-instance cluster?
- **Code to Inspect**: [backend/src/utils/socketValidator.js](file:///d:/code/Engaze.com/backend/src/utils/socketValidator.js#L60-L120), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L180-L195).

#### Q45: How does the application prevent a user from participating in two calls simultaneously?
- **English Answer**: We maintain in-memory call session registries (`activeDirectCalls` map and `userToDirectCall` map in `socketManager.js`). When `call:initiate` is received, the server checks `userToDirectCall.has(callerId)` and `userToDirectCall.has(calleeId)`. If either user is already in an active or pending call, the initiation is rejected with `"User is currently in another call"`.
- **Hinglish**: Server memory me `userToDirectCall` map maintain karta hai. Jab bhi nayi call start hoti hai, server check karta hai ki caller ya callee pehle se kisi call me busy toh nahi hain. Agar busy hain, toh request reject ho jaati hai.
- **Likely Follow-Up**: What happens to the map if a server process crashes mid-call?
- **Code to Inspect**: [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L34-L45), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L480-L530).

#### Q46: How do typing indicators work without creating database overhead?
- **English Answer**: Typing indicators are ephemeral signals that bypass the database completely. When a user types in `chat.jsx`, the frontend throttles emits to `chat:typing { conversationId, isTyping: true }`. The backend validates room membership and broadcasts `chat:typing` directly to the `conversation:${conversationId}` socket room. Zero database reads or writes occur.
- **Hinglish**: Typing indicator ke liye koi database write nahi hota. Frontend socket event `chat:typing` bhejta hai, server room check karke conversation partner ko event forward kar deta hai. Ye purely in-memory broadcast hota hai.
- **Likely Follow-Up**: How does the frontend clear typing indicators if the user closes their browser without backspacing?
- **Code to Inspect**: [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L300-L330).

#### Q47: How does read-receipt synchronization work across devices?
- **English Answer**: When a user opens a conversation, the client emits `chat:read { conversationId }`. The server performs an atomic MongoDB `$addToSet` update: `Message.updateMany({ conversation: convId, sender: { $ne: userId } }, { $addToSet: { readBy: userId } })`. It then broadcasts `chat:read_receipt { conversationId, readerId: userId }` to the conversation room. The sender's client receives the receipt and updates message checkmarks from delivered to read in real time.
- **Hinglish**: Jab Bob chat kholta hai, client `chat:read` event bhejta hai. Backend MongoDB me Alice ke messages me Bob ki ID `$addToSet` kar deta hai aur room me `chat:read_receipt` emit karta hai. Alice ki screen par messages par green/blue double tick update ho jata hai.
- **Likely Follow-Up**: Why is `$addToSet` preferred over `$push` for read receipts?
- **Code to Inspect**: [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L265-L295).

#### Q48: How is presence grace-period timing implemented during brief network disconnections?
- **English Answer**: On mobile devices, switching between Wi-Fi and 5G causes transient socket disconnects. Instead of immediately broadcasting that a user went offline, `presence.service.js` initiates a grace timer (e.g., 30 seconds). If the user reconnects within the window, the timer is cleared and no offline broadcast is sent. If the timer expires, the user's `lastSeenAt` is updated in MongoDB and `presence:update { isOnline: false }` is broadcast to their matches.
- **Hinglish**: Mobile me Wi-Fi se cellular switch karte waqt 2 second ke liye connection toot jata hai. Agar hum turant offline announce karein, toh user baar-baar online/offline flash karega. Isliye `presence.service.js` 30 second ka grace timer chalata hai. Agar user timer khatam hone se pehle reconnect kar le, toh koi offline broadcast nahi jaata.
- **Likely Follow-Up**: How does the Redis-backed presence architecture handle this across multiple server instances?
- **Code to Inspect**: [backend/src/services/presence.service.js](file:///d:/code/Engaze.com/backend/src/services/presence.service.js#L40-L115).

#### Q49: What is the purpose of sanitized WebRTC diagnostic logging?
- **English Answer**: WebRTC connection issues are notoriously hard to debug in production. We created `POST /api/v1/webrtc/diagnostics` and `submitDiagnostics` in `webrtc.controller.js`. It accepts client-side connection metrics (time-to-connect, candidate types, packet loss) but enforces strict privacy scrubbing via `sanitizeClientDiagnosticReport`. It strips raw SDP strings, private IPv4/IPv6 addresses, and authorization headers, keeping a low-cardinality ring buffer of 100 records for production debugging without storing PII.
- **Hinglish**: WebRTC errors debug karne ke liye client metrics bhejta hai. Lekin SDP aur candidate strings me user ka private IP address hota hai. Hamara sanitizer sabhi IPs aur tokens ko redact kar deta hai aur sirf high-level diagnostic data (jaise connection state, failure category) ring buffer me rakhta hai.
- **Likely Follow-Up**: What regex patterns are used to detect and strip IPv4 and IPv6 addresses?
- **Code to Inspect**: [backend/src/controllers/webrtc.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/webrtc.controller.js#L11-L60).

#### Q50: How does the random call manager handle ICE restarts?
- **English Answer**: In speed dating, if network conditions change mid-call, peers may lose ICE connectivity. In `randomCallManager.js`, clients can initiate an ICE restart by emitting `random:signal` with an SDP offer containing `iceRestart: true`. The controller validates session state and forwards the restart offer to the peer to renegotiate candidate paths without terminating the session.
- **Hinglish**: Agar call ke beech me internet fluctuate ho, toh WebRTC ICE connection disconnected state me chala jata hai. Client ICE restart offer bhejta hai jisko server partner ko forward karta hai taaki call drop hue bina naya network route ban sake.
- **Likely Follow-Up**: How do you prevent endless ICE restart loops if a user is completely offline?
- **Code to Inspect**: [backend/src/controllers/randomCallManager.js](file:///d:/code/Engaze.com/backend/src/controllers/randomCallManager.js#L180-L240).

---

### Section E: Security, Rate Limiting & Reliability (10 Questions)

#### Q51: How does Engaze prevent Cross-Origin Resource Sharing (CORS) attacks?
- **English Answer**: In `src/config/cors.js`, we replace loose wildcard (`*`) or origin reflection with a strict, exact-origin allowlist. The allowlist contains only our verified production domains (`https://engaze.date`, `https://www.engaze.date`, `https://engaze-com.vercel.app`) and local development ports. Requests with arbitrary origins or spoofed `.vercel.app` preview URLs are rejected by suppressing the `Access-Control-Allow-Origin` response header.
- **Hinglish**: Wildcard CORS allow karna dangerous hota hai. `src/config/cors.js` me exact allowlist banayi gayi hai jo sirf hamare custom domain `https://engaze.date` aur official Vercel app ko allow karti hai. Koi doosri malicious website hamare backend API ko cross-origin access nahi kar sakti.
- **Likely Follow-Up**: Why are requests with no `Origin` header (like curl or mobile apps) allowed through CORS?
- **Code to Inspect**: [backend/src/config/cors.js](file:///d:/code/Engaze.com/backend/src/config/cors.js#L7-L79).

#### Q52: What is the security design of the HMAC upload token for profile photos?
- **English Answer**: In `src/services/s3Signer.service.js`, `createUploadToken` creates an HMAC-SHA256 signature containing `{ userId, key, expectedMime, maxSizeBytes, targetIndex, expiresAt }`. When the client attempts to confirm the photo upload via `confirmUpload`, `verifyUploadToken` re-computes the HMAC using the server's private secret. If the client tampered with the key, targeted another user's directory, or exceeded the TTL expiration, the token verification fails closed.
- **Hinglish**: Photo upload ke waqt server ek HMAC token generate karta hai jisme userId, key, aur expiry signed hote hain. Confirm karte waqt server signature recompute karke check karta hai. Agar client ne key badal kar kisi aur user ki photo overwrite karne ki koshish ki, toh HMAC match nahi hoga aur request 403 Forbidden se reject ho jaayegi.
- **Likely Follow-Up**: What secret key is used to sign the upload token and how is it validated in production?
- **Code to Inspect**: [backend/src/services/s3Signer.service.js](file:///d:/code/Engaze.com/backend/src/services/s3Signer.service.js#L80-L160).

#### Q53: How does the backend prevent NoSQL injection attacks?
- **English Answer**: In Mongoose, schema type casting acts as a first layer of defense. In controllers and validators (`socketValidator.js` and query helpers), user inputs are strictly validated. ObjectIds are validated via `isValidObjectId()`. Query filters never accept raw unescaped user objects directly into query operators (`$where`, `$gt`). Search terms undergo regex escaping to prevent ReDoS (Regular Expression Denial of Service).
- **Hinglish**: NoSQL injection se bachne ke liye user inputs ko directly query filter me pass nahi kiya jaata. `isValidObjectId` se check hota hai ki ID valid 24-character hex string hai. Search queries me user input ko regex escape kiya jaata hai taaki attacker `$ne` ya `$gt` jaise operators inject na kar sake.
- **Likely Follow-Up**: What is the danger of passing `req.body` directly into `User.findOne(req.body)`?
- **Code to Inspect**: [backend/src/utils/socketValidator.js](file:///d:/code/Engaze.com/backend/src/utils/socketValidator.js#L20-L40), [backend/src/controllers/userSearch.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/userSearch.controller.js#L20-L45).

#### Q54: How does EXIF metadata stripping protect user privacy?
- **English Answer**: Mobile phone cameras embed EXIF metadata inside JPEG and PNG headers, including exact GPS coordinates, camera model, and capture timestamp. If published, a stalker could extract the exact residential location of dating users. In `imageValidation.service.js`, we validate and strip EXIF metadata segments before images are stored in S3, ensuring privacy compliance.
- **Hinglish**: Phone se khichi hui photos me EXIF data hota hai jisme user ke ghar ke exact GPS latitude/longitude hote hain. Dating app me ye critical privacy risk hai. Hamara image validation service photo ke binary headers se EXIF data strip kar deta hai taaki koi user ki location trace na kar sake.
- **Likely Follow-Up**: At what stage is EXIF data stripped in a presigned upload flow?
- **Code to Inspect**: [backend/src/services/imageValidation.service.js](file:///d:/code/Engaze.com/backend/src/services/imageValidation.service.js#L1-L15).

#### Q55: How are security HTTP headers configured on Vercel and Render?
- **English Answer**: On Vercel (`vercel.json`), we configure explicit security headers on all routes:
  - `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing.
  - `X-Frame-Options: SAMEORIGIN`: Protects against clickjacking.
  - `Referrer-Policy: strict-origin-when-cross-origin`: Protects sensitive URL params.
  - `Permissions-Policy: camera=(self), microphone=(self)`: Restricts WebRTC camera/mic hardware access to our origin.
- **Hinglish**: `vercel.json` me standard security headers set hain. `Permissions-Policy` se camera aur microphone access sirf hamare verified origin ko milta hai, aur `X-Frame-Options` app ko kisi doosri site ke iframe me load hone se rokta hai (clickjacking defense).
- **Likely Follow-Up**: What is a Content Security Policy (CSP) and why is it important for WebRTC?
- **Code to Inspect**: [frontend/vercel.json](file:///d:/code/Engaze.com/frontend/vercel.json#L40-L60).

#### Q56: What is the purpose of differentiated rate limiters across API endpoints?
- **English Answer**: A single global rate limiter is inadequate for a complex application. We configure specialized tiers in `rateLimiter.middleware.js`:
  - `globalApiLimiter`: 100 req/min for general browsing.
  - `loginIpLimiter` & `loginAccountLimiter`: Strict limits (5-20 req/15min) on authentication to block brute force.
  - `swipeLimiter`: Bounded (60 swipes/min) to prevent bot auto-swiping scripts.
  - `photoUploadLimiter`: 10 uploads/15min to prevent S3 bucket flooding.
  - `userSearchLimiter`: 30 searches/min to prevent scraping user directories.
- **Hinglish**: Sabhi routes par ek jaisa rate limit nahi ho sakta. Login par strict limit hai brute force rokne ke liye, swipe route par limit hai taaki bots automation na karein, aur photo upload par limit hai taaki koi S3 bill na badha sake.
- **Likely Follow-Up**: How does `rate-limit-redis` handle Redis connection failure without taking down the API?
- **Code to Inspect**: [backend/src/middlewares/rateLimiter.middleware.js](file:///d:/code/Engaze.com/backend/src/middlewares/rateLimiter.middleware.js#L1-L120).

#### Q57: How does the application prevent credential leaks in error messages and logs?
- **English Answer**: Both `src/app.js` and `src/config/redis.js` implement sanitized error formatters (`formatSafeDatabaseError`, `formatSafeRedisError`). When errors are caught, they extract error names and safe codes. Raw URLs (`mongodb+srv://user:pass@cluster...` or `redis://default:pass@host...`) are never passed to `console.error` or HTTP response bodies.
- **Hinglish**: Agar MongoDB ya Redis crash ho jaye, toh unke connection string me username aur password hote hain. Hamare error formatters raw error object ko filter karke sirf generic message log karte hain, jisse passwords kabhi console logs me leak nahi hote.
- **Likely Follow-Up**: How do you sanitize error payloads sent to error monitoring tools like Sentry?
- **Code to Inspect**: [backend/src/config/redis.js](file:///d:/code/Engaze.com/backend/src/config/redis.js#L384-L396), [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L248-L270).

#### Q58: How is S3 credential exposure prevented on the client side?
- **English Answer**: The frontend client never possesses AWS Access Keys or Secret Keys. All AWS credentials reside strictly in the backend environment variables. The client only receives a temporary presigned URL generated via AWS SDK SigV4, valid for 15 minutes, with authorization scoped exclusively to a single S3 object key.
- **Hinglish**: Frontend ke paas AWS ki koi secret key nahi hoti. Backend apne secret se ek temporary signed URL banata hai jo 15 minute me expire ho jaata hai aur sirf ek specific file ko upload karne ki permission deta hai.
- **Likely Follow-Up**: What IAM permissions should the backend AWS IAM user have on the S3 bucket?
- **Code to Inspect**: [backend/src/services/storage.service.js](file:///d:/code/Engaze.com/backend/src/services/storage.service.js#L120-L180).

#### Q59: How does the moderation reporting system handle abuse?
- **English Answer**: In `safety.controller.js`, `reportUser` allows users to submit reports with categories (`inappropriate_content`, `harassment`, `fake_profile`, `underage_suspected`) and an optional description. Reports are recorded in MongoDB (`Report` model) linked to reporting and reported user IDs with timestamps. If an account accumulates multiple distinct reports within a bounded window, automated flags alert moderators for review.
- **Hinglish**: Safety ke liye `Report` collection hai jahan structured categories me abuse report hota hai. Agar koi user underage suspect ya harassment ke liye report hota hai, toh admin/moderator dashboard ke liye audit trail record ho jaata hai.
- **Likely Follow-Up**: How do you prevent malicious users from weaponizing fake reports against competitors?
- **Code to Inspect**: [backend/src/controllers/safety.controller.js](file:///d:/code/Engaze.com/backend/src/controllers/safety.controller.js#L50-L100), [backend/src/models/report.model.js](file:///d:/code/Engaze.com/backend/src/models/report.model.js#L1-L50).

#### Q60: How does the backend prevent Memory Leakage during Socket.IO operations?
- **English Answer**: On socket disconnect, we explicitly clean up all event listeners and active in-memory timer references. If a user disconnects mid-call, `_resetInMemoryDirectCalls` or the call timeout handler clears `clearTimeout(call.timeoutHandle)`. Unreferenced timers and dead socket references are removed from `activeDirectCalls` and `userToDirectCall` maps, preventing uncollected closures from retaining socket instances in heap memory.
- **Hinglish**: Disconnect hone par agar active timer clear na kiya jaye, toh closure memory me socket object ko pakad ke rakhta hai jisse memory leak hota hai. `socketManager.js` me disconnect par saare timers `clearTimeout` kiye jaate hain aur maps se reference delete kiya jaata hai.
- **Likely Follow-Up**: How would you detect a Node.js heap memory leak in production?
- **Code to Inspect**: [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L38-L45), [backend/src/controllers/socketManager.js](file:///d:/code/Engaze.com/backend/src/controllers/socketManager.js#L750-L800).

---

### Section F: Deployment, Testing & Scaling (10 Questions)

#### Q61: What is the current production deployment setup on Vercel and Render?
- **English Answer**: Engaze is deployed in a multi-cloud topology:
  - **Frontend**: Hosted on Vercel, building our React 18 SPA from GitHub repository `Engaze.com-frontend`. Vercel manages global CDN distribution, SSL certificates, and DNS routing for our custom domain `engaze.date`.
  - **Backend API**: Hosted on Render as a Web Service (`Enagaze.com-Backend-1`) running native Node.js (`npm install` / `npm start`). Render provides automatic TLS termination, DDoS filtering, and continuous deployment on push to `main`.
- **Hinglish**: Frontend Vercel par hosted hai jahan custom domain `engaze.date` connected hai. Backend Render par Web Service ki tarah chal raha hai native Node.js runtime me. Database MongoDB Atlas cloud par hai aur photos AWS S3 me hain.
- **Likely Follow-Up**: Why is Render preferred over AWS EC2 for this stage of the project?
- **Code to Inspect**: [frontend/vercel.json](file:///d:/code/Engaze.com/frontend/vercel.json#L1-L67), [backend/RENDER_DEPLOYMENT_RUNBOOK.md](file:///d:/code/Engaze.com/backend/RENDER_DEPLOYMENT_RUNBOOK.md#L1-L50).

#### Q62: How does the multi-stage Dockerfile optimize container size and security?
- **English Answer**: In `Dockerfile`:
  - **Stage 1 (`dependencies`)**: Uses `node:22-alpine` and runs `npm ci --omit=dev --ignore-scripts` to install only production dependencies without dev packages like nodemon or test runners.
  - **Stage 2 (`runner`)**: Starts from a fresh Alpine base, copies only the built `node_modules` and `src/` directory.
  - **Security**: Runs under the built-in unprivileged `USER node` (UID 1000) rather than root, and completely excludes secrets, `.env` files, tests, and documentation via `.dockerignore`.
- **Hinglish**: Multi-stage Dockerfile me pehla stage sirf production dependencies install karta hai (`--omit=dev`). Doosra final stage sirf zaroori code aur node_modules copy karta hai. Container root user ki jagah non-root `node` user par chalta hai taaki container breakout attack na ho sake.
- **Likely Follow-Up**: What is the size of the final production Alpine image?
- **Code to Inspect**: [backend/Dockerfile](file:///d:/code/Engaze.com/backend/Dockerfile#L1-L46), [backend/.dockerignore](file:///d:/code/Engaze.com/backend/.dockerignore#L1-L35).

#### Q63: How was local Docker development parity established in Phase 5A?
- **English Answer**: We authored `docker-compose.dev.yml` defining three coordinated services:
  1. `redis`: Containerized `redis:7-alpine` bound to loopback `127.0.0.1:6382` with healthcheck probes.
  2. `api`: Containerized Express API bound to `127.0.0.1:8000`.
  3. `worker`: Headless BullMQ worker running `npm run worker` under the same container image.
  Both processes communicate with Redis across an isolated bridge network `engaze-dev-net`, perfectly mirroring production multi-process architecture locally.
- **Hinglish**: Phase 5A me `docker-compose.dev.yml` banaya gaya jisme Express API, BullMQ worker aur Redis teeno containers me chalte hain. API aur Worker ek hi Docker image share karte hain, aur Redis ke through background jobs process karte hain.
- **Likely Follow-Up**: Why did you bind the dev Redis container to host port 6382 instead of default 6379?
- **Code to Inspect**: [backend/docker-compose.dev.yml](file:///d:/code/Engaze.com/backend/docker-compose.dev.yml#L1-L100), [backend/DOCKER.md](file:///d:/code/Engaze.com/backend/DOCKER.md).

#### Q64: What is the testing strategy for the backend?
- **English Answer**: We use Node's native test runner (`node:test`) and `node:assert/strict` with zero external runner bloat:
  - **Unit & Component Suites**: Validate Mongoose models, JWT validation, safety policies, and rate limiters.
  - **Mock Integration Suites**: Test S3 storage presigning and BullMQ job scheduling using mock storage adapters.
  - **Opt-In Real Redis Integration (`RUN_REDIS_INTEGRATION_TESTS=1`)**: Executes against a real Redis container, asserting real `Queue.add()`, real worker execution, deduplication, and connection teardown.
  - Total test count: **609 passing tests** across 189 test suites.
- **Hinglish**: Hamara backend Node 22 ke native `node:test` runner se test hota hai. Isme 609 passing tests hain jo auth, discovery, chat, rate limiting aur WebRTC ko verify karte hain. Ek opt-in real integration suite bhi hai jo live Redis container ke against BullMQ worker flow ko test karta hai.
- **Likely Follow-Up**: How long does the full backend test suite take to run?
- **Code to Inspect**: [backend/tests/bullmq.real.redis.integration.test.js](file:///d:/code/Engaze.com/backend/tests/bullmq.real.redis.integration.test.js#L1-L125), [backend/package.json](file:///d:/code/Engaze.com/backend/package.json#L12).

#### Q65: Why should you NOT provision a Render Background Worker or enable BullMQ in production right now?
- **English Answer**: For the current traffic level, it is premature over-engineering:
  1. Render Background Workers have **no free tier**; they require a paid Starter plan ($7/month).
  2. Render Free Redis is ephemeral (deleted after 30 days); persistent Valkey costs an additional $7/month ($14/mo total).
  3. Media cleanup is a low-frequency action that our resilient inline S3 deletion handles in sub-100ms without blocking.
  4. Introducing two new distributed services adds failure modes and maintenance burden without user benefit at this stage.
- **Hinglish**: Abhi production me Render Worker aur Redis lagana over-engineering hai. Render worker ka koi free tier nahi hota ($7/mo worker + $7/mo Redis = $14/mo extra cost). Hamara inline S3 deletion code pehle se resilient hai aur photo change hone par bina kisi issue ke chalta hai. Jab traffic scale hoga tabhi Redis worker deploy karna chahiye.
- **Likely Follow-Up**: At what scale or throughput would you justify activating the background worker?
- **Code to Inspect**: [backend/RENDER_DEPLOYMENT_RUNBOOK.md](file:///d:/code/Engaze.com/backend/RENDER_DEPLOYMENT_RUNBOOK.md#L90-L140).

#### Q66: How does the frontend handle Lighthouse performance optimization?
- **English Answer**: In Phase 6A, we analyzed the bundle and live performance:
  - Route-level code splitting using `React.lazy` and `Suspense` reduced the production JavaScript bundle from 166.71 kB to 130.25 kB gzipped.
  - `vercel.json` applies immutable caching (`max-age=31536000`) for hashed static bundles (`/static/*`) and revalidation rules for `index.html`.
  - Google Fonts are preloaded with `display=swap`.
  - Hero images use `decoding="async"`, responsive `srcset`, and modern AVIF/WebP formats.
- **Hinglish**: Frontend performance ke liye route-level code splitting kiya gaya jisse bundle size 166kB se ghat kar 130kB gzipped ho gaya. `vercel.json` me static assets ke liye 1-year immutable cache headers lagaye gaye, aur fonts me `display=swap` use hua taaki render blocking na ho.
- **Likely Follow-Up**: What is the Largest Contentful Paint (LCP) element on the live landing page and what drives its timing?
- **Code to Inspect**: [frontend/src/App.js](file:///d:/code/Engaze.com/frontend/src/App.js#L10-L30), [frontend/vercel.json](file:///d:/code/Engaze.com/frontend/vercel.json#L1-L35).

#### Q67: What is the zero-downtime rollback procedure if a deployment causes errors?
- **English Answer**: Because distributed features are gated behind environment variables:
  1. Instant Rollback: Set `BULLMQ_ENABLED=false` and `REDIS_ENABLED=false` in the Render dashboard. Render performs a rolling restart, and the API instantly reverts to local in-memory operation and inline S3 deletion without a code redeploy.
  2. Git Rollback: In Render Dashboard $\rightarrow$ Events $\rightarrow$ "Rollback to this deploy" to revert to the previous verified commit.
- **Hinglish**: Rollback ke do tareeqe hain: Pehla, Render dashboard me `REDIS_ENABLED=false` aur `BULLMQ_ENABLED=false` kar do, server turant purane in-memory mode me chala jaayega bina code redeploy kiye. Doosra, Render dashboard ke Events tab me jaakar previous successful build par "Rollback" click kar do.
- **Likely Follow-Up**: What happens to users actively in a video call during a rolling restart?
- **Code to Inspect**: [backend/RENDER_DEPLOYMENT_RUNBOOK.md](file:///d:/code/Engaze.com/backend/RENDER_DEPLOYMENT_RUNBOOK.md#L180-L210).

#### Q68: How do you verify health and readiness of the live backend from the command line?
- **English Answer**: Using curl against the live HTTPS endpoints:
  - Liveness: `curl -i https://enagaze-com-backend.onrender.com/health` $\rightarrow$ returns 200 OK `{"status":"ok", ...}`.
  - Readiness: `curl -i https://enagaze-com-backend.onrender.com/api/v1/health` $\rightarrow$ returns 200 OK `{"status":"healthy","ready":true,"database":"connected", ...}`.
- **Hinglish**: Command line se curl karke `/health` aur `/api/v1/health` check karte hain. Liveness batata hai ki server chal raha hai, aur readiness batata hai ki database connected hai aur request handle karne ke liye ready hai.
- **Likely Follow-Up**: What HTTP status code should a readiness check return when MongoDB disconnects?
- **Code to Inspect**: [backend/src/app.js](file:///d:/code/Engaze.com/backend/src/app.js#L130-L185).

#### Q69: How do you prevent host port collisions between different Docker projects on a development machine?
- **English Answer**: Different projects often default to host port 6379 for Redis or 5432 for PostgreSQL. In our `docker-compose.dev.yml`:
  1. We map Redis host ports to configurable loopback variables with non-conflicting defaults: `127.0.0.1:${DEV_REDIS_PORT:-6382}:6379`.
  2. We scope the Compose project name with `name: engaze-dev` and isolate containers on a private bridge network `engaze-dev-net`.
  This allows Engaze containers to run alongside existing services without port bind errors.
- **Hinglish**: Machine par doosre projects ka Redis (6379) chal sakta hai. Isliye hamare `docker-compose.dev.yml` me host port `6382` par map kiya gaya hai, aur internal network isolated bridge par chalta hai. Isse kabhi bhi "port already allocated" ka error nahi aata.
- **Likely Follow-Up**: Why is binding to `127.0.0.1` safer than binding to `0.0.0.0`?
- **Code to Inspect**: [backend/docker-compose.dev.yml](file:///d:/code/Engaze.com/backend/docker-compose.dev.yml#L20-L35).

#### Q70: What is the purpose of the `.dockerignore` file and what critical files must be listed?
- **English Answer**: `.dockerignore` prevents sensitive files, local development artifacts, and build bloat from being sent to the Docker daemon build context:
  - Secrets: `.env`, `.env.*` (prevents baking secrets into image layers).
  - Dependencies: `node_modules` (prevents host binaries compiled for Windows from polluting Linux Alpine containers).
  - Version control & docs: `.git`, `tests`, `docs`, `*.log`.
- **Hinglish**: `.dockerignore` se sensitive files Docker image me jaane se rukti hain: `.env` files (secrets leak na hon), host ka `node_modules` (Windows ke modules Linux me crash na karein), aur Git history ya logs jo image ka size badhaate hain.
- **Likely Follow-Up**: If a secret is copied in Stage 1 and deleted in Stage 2, can it still be extracted from the final image?
- **Code to Inspect**: [backend/.dockerignore](file:///d:/code/Engaze.com/backend/.dockerignore#L1-L35).

---

## Part 7: Interview Defense Summary & Critical Watchouts

### Top 10 Things You Must Explain Without Hesitation
1. **P2P WebRTC vs. Server Streaming**: The Express/Socket.IO backend is only a signaling relay for session exchange; audio/video tracks stream peer-to-peer between client browsers.
2. **Direct-to-S3 Presigned Uploads**: The server signs an HMAC token and returns an AWS S3 presigned PUT URL; the client uploads binary bytes directly to S3, bypassing server memory.
3. **Canonical Mutual Match Logic**: `Match.getCanonicalPair(idA, idB)` deterministically sorts ObjectIds so that concurrent mutual swipes cannot create duplicate match records.
4. **Idempotent Chat Messaging**: `clientTempId` backed by a partial unique index on `{ conversation: 1, sender: 1, clientTempId: 1 }` prevents duplicate messages on mobile network retries.
5. **Fail-Safe Feature Flags**: Redis, BullMQ, distributed presence, and distributed rate limiting default to `false`. The application operates as a single-instance service in memory.
6. **18+ Age Invariant**: Enforced at the schema validator layer (`dob`), route middleware layer (`requireEligibility`), and discovery query filter layer.
7. **Cursor Pagination vs. Offset Pagination**: Uses compound indexes (`dob: 1, _id: -1`) with `$lt`/`$gt` range seeks instead of slow $O(N)$ `skip()`.
8. **Decoupled Production Topology**: React 18 SPA on Vercel Edge (`https://www.engaze.date`) + Node.js Express API on Render (`https://enagaze-com-backend.onrender.com`).
9. **Graceful Process Shutdown**: Traps `SIGTERM`, drains keep-alive sockets with 503, notifies socket clients, disconnects Mongoose/Redis, with a 10s timeout.
10. **Sanitized Error Logging**: Passwords, connection strings, and sensitive PII are stripped via allowlist formatters before logging.

---

### Top 10 Riskiest Interviewer Follow-Ups

1. *"Why isn't a TURN server deployed if P2P fails for symmetric NATs?"*
   - **Answer**: In `src/config/webrtc.js`, we built RFC 5766 ephemeral HMAC credential generation for Coturn/Xirsys. However, for our early production phase, we rely on Google public STUN to avoid dedicated relay server costs until call completion metrics justify it.
2. *"What happens if MongoDB goes down while Socket.IO clients are connected?"*
   - **Answer**: Socket connections remain open, but database operations fail. Our `/api/v1/health` readiness probe detects `readyState !== 1` and returns 503, while controllers return sanitized 503 `STORAGE_UNAVAILABLE` responses.
3. *"If you don't use Redis in production right now, how does Socket.IO work?"*
   - **Answer**: Socket.IO uses its built-in in-memory adapter. Because Render currently runs a single Web Service instance, all connected sockets reside on that instance, so local in-memory rooms work properly.
4. *"Can a user fake their age by sending a forged date of birth during registration?"*
   - **Answer**: The backend does not trust client calculations. `calculateExactAge(dob)` runs server-side on the UTC timestamp, ensuring the exact calendar date satisfies the $\ge 18$ check.
5. *"What happens if an S3 upload succeeds but the client crashes before calling `/confirm`?"*
   - **Answer**: The image exists in S3 as an orphan object. Because S3 presigned keys are deterministic and timestamped, we can run periodic S3 lifecycle rules to expire unconfirmed objects older than 24 hours.
6. *"How do you prevent an attacker from spamming the `/swipe` endpoint with an automated script?"*
   - **Answer**: `swipeLimiter` enforces a sliding window cap (60 swipes per minute). Furthermore, swiping requires a complete profile and verified adult eligibility.
7. *"Why didn't you use WebSockets for everything instead of combining REST and WebSockets?"*
   - **Answer**: REST is ideal for cacheable, stateless operations (fetching static profiles, auth, search) and integrates naturally with HTTP CDNs, status codes, and rate limiters. WebSockets are reserved strictly for bi-directional real-time events.
8. *"How does the frontend handle token expiry while the user is actively using the app?"*
   - **Answer**: When Axios intercepts an HTTP 401, `AuthContext` clears `localStorage` and redirects the user to `/auth` with an informational notice.
9. *"What happens if two users block each other at the exact same moment?"*
   - **Answer**: `blockUser()` is idempotent. `Block.create()` handles duplicate key collisions gracefully, and subsequent queries treat either directional block as a mutual block.
10. *"If BullMQ is disabled, why is the code in the repository?"*
    - **Answer**: The BullMQ queue infrastructure was developed and verified locally in Phase 4A/5A to establish container parity and architectural readiness. It remains dormant behind `BULLMQ_ENABLED=false` until scale justifies running a dedicated paid worker instance on Render.

---

### Codebase Inconsistencies & Honest Disclosures

When speaking with interviewers, demonstrate maturity by pointing out real-world architectural realities rather than claiming perfection:

1. **Subdomain Typo in Initial Deployment**:
   - The live Render backend URL contains a minor spelling artifact: `enagaze-com-backend.onrender.com` (with an extra 'a'). [frontend/src/environment.js](file:///d:/code/Engaze.com/frontend/src/environment.js#L3) handles this explicitly as the fallback target.
2. **STUN-Only in Current Production**:
   - WebRTC is configured with STUN servers by default. Turn relay infrastructure is fully coded in `src/config/webrtc.js` but requires a provisioned Coturn server or commercial TURN service credentials to activate.
3. **Feature Flags are Off in Production**:
   - Be completely honest: Redis, BullMQ, and distributed presence were implemented, thoroughly unit-tested, and verified against real local Docker containers, but in live production on Render, they are currently disabled to keep cloud costs at zero on the single-instance tier.
4. **Photo Upload Client Verification**:
   - Full end-to-end photo uploading requires valid AWS IAM S3 credentials. In automated integration testing, the application uses `DevMockStorageAdapter` to avoid generating live S3 cloud billing.

