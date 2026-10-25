import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { connectToSocket } from "./controllers/socketManager.js";
import userRoutes from "./routes/users.routes.js";
import discoveryRoutes from "./routes/discovery.routes.js";
import matchRoutes from "./routes/matches.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import safetyRoutes from "./routes/safety.routes.js";
import moderationRoutes from "./routes/moderation.routes.js";
import webrtcRoutes from "./routes/webrtc.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import { validateJwtConfig } from "./config/jwt.js";
import { getMongoConnectionOptions } from "./config/database.js";
import {
  isRedisEnabled,
  validateRedisConfig,
  isSocketRedisAdapterEnabled,
  validateSocketRedisAdapterConfig,
  isPresenceRedisEnabled,
  validatePresenceRedisConfig,
  isMatchmakingRedisEnabled,
  validateMatchmakingRedisConfig,
} from "./config/redis.js";
import { initRedisClient, closeRedisClient, getRedisClient, getRedisStatus } from "./services/redis.service.js";
import {
  initPresenceService,
  closePresenceService,
  getPresenceStatus,
} from "./services/presence.service.js";
import {
  initSocketRedisAdapter,
  closeSocketRedisAdapter,
  getSocketRedisAdapterClients,
  getSocketRedisAdapterStatus,
} from "./services/socketRedisAdapter.service.js";
import {
  initMatchmakingRedisService,
  closeMatchmakingRedisService,
  getMatchmakingRedisStatus,
} from "./services/randomMatchmakingRedis.service.js";
import { corsOptions } from "./config/cors.js";
import { globalApiLimiter } from "./middlewares/rateLimiter.middleware.js";

// ✅ Ensure .env loads properly even in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env"), quiet: true });

// Ensure database URI is configured
if (!process.env.MONGO_URI) {
  console.warn("⚠️ Warning: MONGO_URI is not set in environment variables.");
}

// Validate JWT configuration (fails startup immediately in production if invalid)
validateJwtConfig({ exitOnError: true });

const app = express();
const server = createServer(app);
server.on("clientError", (err, socket) => {
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
});
const io = connectToSocket(server);
app.set("io", io);

app.set("port", process.env.PORT || 8000);

// Render deployment topology operates behind a reverse-proxy load balancer.
// Trusting the first proxy hop (1) ensures Express resolves req.ip from Render's X-Forwarded-For
// without blindly trusting arbitrary spoofed upstream client headers.
app.set("trust proxy", 1);

// Centralized CORS configuration with exact-origin allowlist
app.use(cors(corsOptions));

app.use(express.json({ limit: "40kb" }));
app.use(express.urlencoded({ limit: "40kb", extended: true }));

// Liveness check handler: confirms the Node.js process is running and accepting HTTP requests
const handleLivenessCheck = (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Engaze.com Backend API",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
};

// Root and standard liveness endpoints
app.get("/", handleLivenessCheck);
app.get("/health", handleLivenessCheck);
app.get("/livez", (req, res) => {
  res.status(200).json({
    status: "alive",
    service: "Engaze.com Backend API",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
app.get("/api/v1/health/live", (req, res) => {
  res.status(200).json({
    status: "alive",
    service: "Engaze.com Backend API",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Readiness check handler: confirms application dependencies (MongoDB, Redis, Socket.IO adapter if enabled) are ready to serve traffic
const handleReadinessCheck = (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  const redisStatus = getRedisStatus();
  const isRedisReady = !redisStatus.enabled || redisStatus.ready;
  const adapterStatus = getSocketRedisAdapterStatus();
  const isAdapterReady = !adapterStatus.enabled || adapterStatus.ready;
  const presenceStatus = getPresenceStatus();
  const isPresenceReady = !presenceStatus.enabled || presenceStatus.ready;
  const matchmakingStatus = getMatchmakingRedisStatus();
  const isMatchmakingReady = !matchmakingStatus.enabled || matchmakingStatus.ready;
  const isReady = isDbConnected && isRedisReady && isAdapterReady && isPresenceReady && isMatchmakingReady && !isShuttingDown;
  const statusCode = isReady ? 200 : 503;

  const payload = {
    status: isReady ? "healthy" : "unhealthy",
    ready: isReady,
    database: isDbConnected ? "connected" : "disconnected",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  if (redisStatus.enabled) {
    payload.redis = redisStatus.ready ? "connected" : "disconnected";
  }

  if (adapterStatus.enabled) {
    payload.socketAdapter = adapterStatus.ready ? "connected" : "disconnected";
  }

  if (presenceStatus.enabled) {
    payload.presence = presenceStatus.ready ? "connected" : "disconnected";
  }

  if (matchmakingStatus.enabled) {
    payload.matchmaking = matchmakingStatus.ready ? "connected" : "disconnected";
  }

  res.status(statusCode).json(payload);
};

// Backward-compatible primary health endpoint, Kubernetes readyz probe, and explicit readiness endpoints
app.get("/readyz", handleReadinessCheck);
app.get("/api/v1/health", handleReadinessCheck);
app.get("/api/v1/health/ready", handleReadinessCheck);
app.get("/api/v1/health/readyz", handleReadinessCheck);

// Drain middleware: reject incoming application traffic with 503 during graceful shutdown
app.use((req, res, next) => {
  if (isShuttingDown) {
    const p = req.path || "";
    const isHealthCheck =
      p === "/" ||
      p === "/health" ||
      p === "/livez" ||
      p === "/readyz" ||
      p.startsWith("/api/v1/health");
    if (!isHealthCheck) {
      res.set("Connection", "close");
      return res.status(503).json({
        status: "shutting_down",
        message: "Server is shutting down. Please retry shortly.",
      });
    }
  }
  next();
});

// Global rate limiting on API routes (bypassed for root and health/readiness probes above)
app.use("/api/v1", globalApiLimiter);

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/discovery", discoveryRoutes);
app.use("/api/v1/matches", matchRoutes);
app.use("/api/v1/conversations", chatRoutes);
app.use("/api/v1/safety", safetyRoutes);
app.use("/api/v1/moderation", moderationRoutes);
app.use("/api/v1/webrtc", webrtcRoutes);
app.use("/api/v1/notifications", notificationRoutes);

const KNOWN_SAFE_DB_ERRORS = new Set([
  "MongoParseError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoServerError",
  "MongoTimeoutError",
  "MongoTopologyClosedError",
  "MongooseServerSelectionError",
  "MongooseError",
  "CastError",
  "ValidationError",
  "DatabaseConnectionError",
  "Error",
]);

const KNOWN_SAFE_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Safely format a database error for logs using an explicit safe allowlist.
 * Ensures arbitrary or user-tainted error properties cannot leak credentials.
 *
 * @param {any} err
 * @returns {string} Safe log description
 */
const formatSafeDatabaseError = (err) => {
  const rawName = (err && typeof err.name === "string") ? err.name : "";
  const errName = KNOWN_SAFE_DB_ERRORS.has(rawName) ? rawName : "DatabaseConnectionError";

  let errCode = "";
  if (err) {
    if (typeof err.code === "number" && Number.isInteger(err.code)) {
      errCode = ` [code: ${err.code}]`;
    } else if (typeof err.code === "string" && KNOWN_SAFE_SYSTEM_CODES.has(err.code)) {
      errCode = ` [code: ${err.code}]`;
    }
  }

  return `Database connection failed (${errName}${errCode}). Please verify network reachability, database service status, and MONGO_URI configuration.`;
};

// Runtime database event listeners for resilience and visibility
mongoose.connection.on("disconnected", () => {
  if (!isShuttingDown) {
    console.warn("⚠️ Warning: MongoDB disconnected. Readiness probes will report 503 until reconnected.");
  }
});

mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB connection re-established.");
});

mongoose.connection.on("error", (err) => {
  if (!isShuttingDown) {
    const safeMsg = formatSafeDatabaseError(err);
    console.error(`❌ MongoDB Runtime Error: ${safeMsg}`);
  }
});

/**
 * Starts the HTTP and Socket.IO server after establishing required database connection.
 * On unrecoverable database connection failure:
 * - Logs a safe error message without credentials or raw connection strings.
 * - Does NOT start listening for traffic.
 * - Terminates process with exit code 1 if exitOnError is true.
 *
 * On HTTP server listen failure (e.g. EADDRINUSE):
 * - Correctly classifies as an HTTP listen error (not database failure).
 * - Disconnects Mongoose cleanly.
 * - Terminates process with exit code 1 if exitOnError is true.
 *
 * @param {Object} [options]
 * @param {boolean} [options.exitOnError=true]
 * @returns {Promise<{ app: Express, server: http.Server, connectionDb: mongoose.Connection }>}
 */
const start = async ({ exitOnError = true } = {}) => {
  // Validate JWT configuration before establishing database or starting network listeners
  validateJwtConfig({ exitOnError });

  // Initialize and verify Redis connection if enabled
  let redisClient = null;
  if (isRedisEnabled()) {
    try {
      validateRedisConfig();
      redisClient = await initRedisClient();
      console.log("✅ Redis connection established.");
    } catch (redisErr) {
      console.error(`❌ Fatal Redis Startup Error: ${redisErr.message}`);
      try {
        await closeRedisClient({ timeoutMs: 2000 });
      } catch (_) {}
      if (exitOnError) {
        process.exit(1);
      }
      throw redisErr;
    }
  }

  // Initialize and verify Socket.IO Redis adapter if enabled
  let socketAdapterClients = null;
  if (isSocketRedisAdapterEnabled()) {
    try {
      validateSocketRedisAdapterConfig();
      socketAdapterClients = await initSocketRedisAdapter(io);
      console.log("✅ Socket.IO Redis adapter attached.");
    } catch (adapterErr) {
      console.error(`❌ Fatal Socket.IO Redis Adapter Startup Error: ${adapterErr.message}`);
      try {
        await closeSocketRedisAdapter({ timeoutMs: 2000 });
      } catch (_) {}
      if (redisClient) {
        try {
          await closeRedisClient({ timeoutMs: 2000 });
        } catch (_) {}
      }
      if (exitOnError) {
        process.exit(1);
      }
      throw adapterErr;
    }
  }

  // Initialize and verify Redis-backed presence tracking if enabled
  if (isPresenceRedisEnabled()) {
    try {
      validatePresenceRedisConfig();
      await initPresenceService({ redisClient });
      console.log("✅ Redis-backed presence tracking initialized.");
    } catch (presenceErr) {
      console.error(`❌ Fatal Presence Service Startup Error: ${presenceErr.message}`);
      try {
        await closePresenceService({ timeoutMs: 2000 });
      } catch (_) {}
      if (socketAdapterClients) {
        try {
          await closeSocketRedisAdapter({ timeoutMs: 2000 });
        } catch (_) {}
      }
      if (redisClient) {
        try {
          await closeRedisClient({ timeoutMs: 2000 });
        } catch (_) {}
      }
      if (exitOnError) {
        process.exit(1);
      }
      throw presenceErr;
    }
  }

  // Initialize and verify Redis-backed random matchmaking if enabled
  if (isMatchmakingRedisEnabled()) {
    try {
      validateMatchmakingRedisConfig();
      await initMatchmakingRedisService({ redisClient });
      console.log("✅ Redis-backed random matchmaking initialized.");
    } catch (matchmakingErr) {
      console.error(`❌ Fatal Matchmaking Redis Startup Error: ${matchmakingErr.message}`);
      try {
        await closeMatchmakingRedisService();
      } catch (_) {}
      try {
        await closePresenceService({ timeoutMs: 2000 });
      } catch (_) {}
      if (socketAdapterClients) {
        try {
          await closeSocketRedisAdapter({ timeoutMs: 2000 });
        } catch (_) {}
      }
      if (redisClient) {
        try {
          await closeRedisClient({ timeoutMs: 2000 });
        } catch (_) {}
      }
      if (exitOnError) {
        process.exit(1);
      }
      throw matchmakingErr;
    }
  }

  if (!process.env.MONGO_URI || !process.env.MONGO_URI.trim()) {
    const errorMsg = "Fatal Startup Error: MONGO_URI environment variable is required to start the server.";
    console.error(`❌ ${errorMsg}`);
    if (socketAdapterClients) {
      try {
        await closeSocketRedisAdapter({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (redisClient) {
      try {
        await closeRedisClient({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (exitOnError) {
      process.exit(1);
    }
    throw new Error(errorMsg);
  }

  // Validate MongoDB connection configuration before establishing connection
  let mongoOptions;
  try {
    mongoOptions = getMongoConnectionOptions();
  } catch (configErr) {
    console.error(`❌ Fatal Startup Configuration Error: ${configErr.message}`);
    if (socketAdapterClients) {
      try {
        await closeSocketRedisAdapter({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (redisClient) {
      try {
        await closeRedisClient({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (exitOnError) {
      process.exit(1);
    }
    throw configErr;
  }

  // 1. Establish required database connection before opening network listener
  let connectionDb;
  try {
    connectionDb = await mongoose.connect(process.env.MONGO_URI, mongoOptions);
    console.log(`✅ MONGO Connected DB Host: ${connectionDb.connection.host}`);
  } catch (dbErr) {
    const safeMsg = formatSafeDatabaseError(dbErr);
    console.error(`❌ Fatal MongoDB Startup Connection Error: ${safeMsg}`);
    if (socketAdapterClients) {
      try {
        await closeSocketRedisAdapter({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (redisClient) {
      try {
        await closeRedisClient({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (exitOnError) {
      process.exit(1);
    }
    throw dbErr;
  }

  // 2. Open HTTP and Socket.IO server listener
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(app.get("port"), () => {
        console.log(`🚀 Listening on PORT ${app.get("port")}`);
        resolve();
      });
    });

    return { app, server, connectionDb, redisClient, socketAdapterClients };
  } catch (listenErr) {
    const listenCode = (listenErr && listenErr.code) ? ` [${listenErr.code}]` : "";
    console.error(`❌ Fatal HTTP Server Listen Error:${listenCode} Failed to bind port ${app.get("port")}.`);
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
      } catch (_) {}
    }
    if (socketAdapterClients) {
      try {
        await closeSocketRedisAdapter({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (redisClient) {
      try {
        await closeRedisClient({ timeoutMs: 2000 });
      } catch (_) {}
    }
    if (exitOnError) {
      process.exit(1);
    }
    throw listenErr;
  }
};

/**
 * Bounded graceful process shutdown handler for SIGTERM and SIGINT signals.
 * Drains HTTP connections, disconnects Socket.IO sockets, and disconnects Mongoose.
 * Bounded by a timeout (default 10s or SHUTDOWN_TIMEOUT_MS) to prevent hanging indefinitely.
 */
let isShuttingDown = false;
const gracefulShutdown = async (
  signal = "SIGTERM",
  { exit = true, timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000 } = {}
) => {
  if (isShuttingDown) {
    console.log(`Shutdown already in progress. Ignoring duplicate ${signal} signal.`);
    return;
  }
  isShuttingDown = true;
  console.log(`Received ${signal}. Initiating graceful shutdown...`);

  let timedOut = false;
  // Bounded force-termination fallback timer
  let forceExitTimer = setTimeout(() => {
    timedOut = true;
    console.error(`⚠️ Graceful shutdown timed out after ${timeoutMs}ms. Forcing exit.`);
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    if (exit) {
      process.exit(1);
    }
    isShuttingDown = false;
  }, timeoutMs);

  if (typeof forceExitTimer.unref === "function") {
    forceExitTimer.unref();
  }

  try {
    // 1. Stop accepting new HTTP connections
    const serverClosePromise = new Promise((resolve) => {
      if (server.listening) {
        server.close((err) => {
          if (err) console.error("Error closing HTTP server:", err.message);
          resolve();
        });
        // Immediately close idle HTTP keep-alive connections
        if (typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }
      } else {
        resolve();
      }
    });

    // 2. Notify and disconnect active Socket.IO clients before waiting for server close callback.
    // In Node.js, server.close() will not resolve if upgraded WebSocket connections
    // remain open; disconnecting clients allows server.close() to complete without deadlocking.
    if (io) {
      try {
        io.emit("server_restarting", {
          message: "Server is restarting. Please reconnect shortly.",
          reconnectDelayMs: 2000,
          timestamp: new Date().toISOString(),
        });
      } catch (emitErr) {
        console.error("Error broadcasting server_restarting event:", emitErr.message);
      }

      // Allow a brief flush window for connected sockets to receive the restart notice
      const activeSocketCount = io.sockets?.sockets?.size || 0;
      const flushDelay = Math.min(100, Math.floor(timeoutMs / 2));
      if (activeSocketCount > 0 && flushDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, flushDelay));
      }

      io.disconnectSockets(true);
      if (io.engine && typeof io.engine.close === "function") {
        io.engine.close();
      }
    }

    // 3. Await HTTP server drain completion
    await serverClosePromise;

    // 4. Disconnect Matchmaking, Presence, Socket.IO Redis adapter, and Redis client cleanly if initialized
    try {
      const matchmakingStatus = getMatchmakingRedisStatus();
      if (matchmakingStatus.enabled) {
        await closeMatchmakingRedisService();
        console.log("Matchmaking Redis service resources cleaned up cleanly.");
      }
    } catch (matchmakingCloseErr) {
      console.error("Error closing Matchmaking Redis service:", matchmakingCloseErr.message);
    }

    try {
      const presenceStatus = getPresenceStatus();
      if (presenceStatus.enabled) {
        const presenceTimeout = Math.min(2000, Math.floor(timeoutMs / 4));
        await closePresenceService({ timeoutMs: presenceTimeout });
        console.log("Presence service resources cleaned up cleanly.");
      }
    } catch (presenceCloseErr) {
      console.error("Error closing Presence service:", presenceCloseErr.message);
    }

    try {
      const adapterStatus = getSocketRedisAdapterStatus();
      if (adapterStatus.enabled) {
        const adapterTimeout = Math.min(2000, Math.floor(timeoutMs / 4));
        await closeSocketRedisAdapter({ timeoutMs: adapterTimeout });
        console.log("Socket.IO Redis adapter pub/sub connections closed cleanly.");
      }
    } catch (adapterCloseErr) {
      console.error("Error closing Socket.IO Redis adapter:", adapterCloseErr.message);
    }

    try {
      const redisStatus = getRedisStatus();
      if (redisStatus.enabled && getRedisClient()) {
        const redisTimeout = Math.min(2000, Math.floor(timeoutMs / 3));
        await closeRedisClient({ timeoutMs: redisTimeout });
        console.log("Redis connection closed cleanly.");
      }
    } catch (redisCloseErr) {
      console.error("Error closing Redis client:", redisCloseErr.message);
    }

    // 5. Disconnect Mongoose after network listeners and sockets are closed
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log("Mongoose connection closed cleanly.");
    }

    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
    }

    if (!timedOut) {
      console.log("Graceful shutdown complete.");
      if (exit) {
        process.exit(0);
      }
    }
    isShuttingDown = false;
  } catch (shutdownErr) {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
    }
    console.error("Error during graceful shutdown:", shutdownErr.message);
    if (!timedOut && exit) {
      process.exit(1);
    }
    isShuttingDown = false;
  }
};

const isMainModule = Boolean(
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isMainModule) {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  start({ exitOnError: true }).catch(() => process.exit(1));
}

const _resetShutdownForTesting = () => { isShuttingDown = false; };
const _setIsShuttingDownForTesting = (val) => { isShuttingDown = Boolean(val); };

export {
  app,
  server,
  io,
  start,
  gracefulShutdown,
  formatSafeDatabaseError,
  getMongoConnectionOptions,
  isRedisEnabled,
  validateRedisConfig,
  initRedisClient,
  closeRedisClient,
  getRedisClient,
  getRedisStatus,
  isSocketRedisAdapterEnabled,
  validateSocketRedisAdapterConfig,
  initSocketRedisAdapter,
  closeSocketRedisAdapter,
  getSocketRedisAdapterClients,
  getSocketRedisAdapterStatus,
  isPresenceRedisEnabled,
  validatePresenceRedisConfig,
  isMatchmakingRedisEnabled,
  validateMatchmakingRedisConfig,
  initPresenceService,
  closePresenceService,
  getPresenceStatus,
  initMatchmakingRedisService,
  closeMatchmakingRedisService,
  getMatchmakingRedisStatus,
  _resetShutdownForTesting,
  _setIsShuttingDownForTesting,
};
