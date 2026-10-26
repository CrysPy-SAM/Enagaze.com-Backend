# Engaze.com — Backend Docker Development & Deployment Guide (Phase 5A)

This guide documents the containerized local development and deployment parity setup for Engaze's Express API and BullMQ background worker.

---

## 1. Prerequisites

1. **Docker Engine & Docker Compose**:
   - Docker Desktop or Docker Engine 24+ with Compose v2+.
   - Verify: `docker --version` and `docker compose version`.
2. **Node.js (Optional for host testing)**:
   - Node.js LTS (v20+ or v22+).
   - npm v10+.
3. **MongoDB Connection**:
   - A reachable development MongoDB Atlas cluster or local MongoDB instance connection string.

---

## 2. Architecture & Image Parity

Both the **Express API** and the **BullMQ Background Worker** share the exact same multi-stage Docker image built from [Dockerfile](file:///d:/code/Engaze.com/backend/Dockerfile):

```
+------------------------------------------------------------------------+
| Stage 1: dependencies (node:22-alpine)                                 |
| - npm ci --omit=dev --ignore-scripts (reproducible production modules) |
+-----------------------------------v------------------------------------+
| Stage 2: runner (node:22-alpine)                                       |
| - USER node (non-root unprivileged execution)                          |
| - Production node_modules + src/                                      |
+-------------------+--------------------------------+-------------------+
                    |                                |
                    v                                v
       [engaze-dev-api]                     [engaze-dev-worker]
       CMD: ["node", "src/app.js"]          CMD: ["npm", "run", "worker"]
       Listens on: 127.0.0.1:8000           Headless background job processor
```

---

## 3. Environment Variables

Copy [.env.docker.example](file:///d:/code/Engaze.com/backend/.env.docker.example) to `.env` if not already present:

```bash
cp .env.docker.example .env
```

Key environment configurations:
- `MONGO_URI`: Your development MongoDB connection URI.
- `JWT_SECRET`: Secret key for JWT verification (defaults to local dev key).
- `REDIS_ENABLED=true`: Enables Redis connection within the Docker network.
- `REDIS_URL=redis://redis:6379`: Points to the dedicated Compose Redis service.
- `BULLMQ_ENABLED=true`: Enables BullMQ queue producers and background workers.
- `DEV_REDIS_PORT=6382`: Host loopback port mapped to the dev Redis instance (prevents collision with local Redis on 6379).

---

## 4. Commands & Workflow

### 4.1 Build the Image
To build the backend image standalone:
```bash
docker build -t engaze-backend:latest .
```

### 4.2 Start Development Services
Start the API, Worker, and Redis services in the background:
```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### 4.3 Check Service Status & Logs
View status and healthcheck results:
```bash
docker compose -f docker-compose.dev.yml ps
```

Stream logs from all services:
```bash
docker compose -f docker-compose.dev.yml logs -f
```

Stream logs for a single service:
```bash
# API logs
docker compose -f docker-compose.dev.yml logs -f api

# Background worker logs
docker compose -f docker-compose.dev.yml logs -f worker

# Redis logs
docker compose -f docker-compose.dev.yml logs -f redis
```

### 4.4 Stop Services
Stop and remove **only** the containers and network created by this configuration:
```bash
docker compose -f docker-compose.dev.yml down
```
*(This leaves any unrelated containers, such as host databases, completely undisturbed).*

---

## 5. Verification & Health Probes

### 5.1 Verify Express API Health
- **Liveness probe** (verifies HTTP listener is active):
  ```bash
  curl http://127.0.0.1:8000/health
  # Response: {"status":"ok","service":"Engaze.com Backend API",...}
  ```
- **Readiness probe** (verifies MongoDB, Redis, and BullMQ):
  ```bash
  curl http://127.0.0.1:8000/api/v1/health
  # Response: {"status":"healthy","ready":true,"database":"connected","redis":"connected","bullmq":"connected",...}
  ```

### 5.2 Verify Background Worker
Inspect the worker logs to confirm the BullMQ worker processor registered and connected to Redis:
```bash
docker compose -f docker-compose.dev.yml logs worker
```
Expected output:
```
✅ [BullMQ:Worker] Worker process started for queue 'media-cleanup' (concurrency: 5).
```

### 5.3 Verify Redis Connectivity
Ping the development Redis container from the host:
```bash
# If redis-cli is installed:
redis-cli -p 6382 ping
# Or via docker exec:
docker exec -it engaze-dev-redis redis-cli ping
# Response: PONG
```

---

## 6. Running Tests

### 6.1 Unit & Regression Tests
Run the standard test suite on the host:
```bash
npm test
```

### 6.2 Opt-In Real Redis & BullMQ Integration Tests
To run the live Redis integration suite against the development Redis container on host port 6382:
```bash
# PowerShell:
$env:RUN_REDIS_INTEGRATION_TESTS = "1"
$env:TEST_REDIS_URL = "redis://127.0.0.1:6382"
npm run test:redis-integration

# Bash:
RUN_REDIS_INTEGRATION_TESTS=1 TEST_REDIS_URL=redis://127.0.0.1:6382 npm run test:redis-integration
```

---

## 7. Troubleshooting

| Issue | Cause | Resolution |
|---|---|---|
| `Port 8000 is already in use` | Another process is listening on host port 8000. | Set `PORT=8001` in your `.env` or shell. |
| `Port 6382 is already in use` | Another service is using port 6382. | Set `DEV_REDIS_PORT=6383` in your `.env`. |
| API container shows `unhealthy` | MongoDB connection timed out or `MONGO_URI` is unset. | Ensure `MONGO_URI` in `.env` is set to a reachable MongoDB Atlas or local instance. Check logs with `docker compose -f docker-compose.dev.yml logs api`. |
| Worker exits immediately with code 1 | `BULLMQ_ENABLED` or `REDIS_ENABLED` is `false`. | Ensure both `REDIS_ENABLED=true` and `BULLMQ_ENABLED=true` are configured in `docker-compose.dev.yml` (already defaulted). |
| Docker permission denied | User not in docker group or Docker daemon not running. | Verify Docker Desktop / Docker daemon is active: `docker info`. |

