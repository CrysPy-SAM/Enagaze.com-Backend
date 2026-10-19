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
import { validateJwtConfig } from "./config/jwt.js";
import { corsOptions } from "./config/cors.js";
import { globalApiLimiter } from "./middlewares/rateLimiter.middleware.js";

// ✅ Ensure .env loads properly even in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// Ensure database URI is configured
if (!process.env.MONGO_URI) {
  console.warn("⚠️ Warning: MONGO_URI is not set in environment variables.");
}

// Validate JWT configuration (fails startup immediately in production if invalid)
validateJwtConfig({ exitOnError: true });

const app = express();
const server = createServer(app);
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

// Liveness check: confirms the Node.js process is running and accepting HTTP requests
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
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

// Readiness check handler: confirms application dependencies (MongoDB) are ready to serve traffic
const handleReadinessCheck = (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  const statusCode = isDbConnected ? 200 : 503;

  res.status(statusCode).json({
    status: isDbConnected ? "healthy" : "unhealthy",
    ready: isDbConnected,
    database: isDbConnected ? "connected" : "disconnected",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
};

// Backward-compatible primary health endpoint and explicit readiness endpoint
app.get("/api/v1/health", handleReadinessCheck);
app.get("/api/v1/health/ready", handleReadinessCheck);

// Global rate limiting on API routes (bypassed for root and health/readiness probes above)
app.use("/api/v1", globalApiLimiter);

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/discovery", discoveryRoutes);
app.use("/api/v1/matches", matchRoutes);
app.use("/api/v1/conversations", chatRoutes);
app.use("/api/v1/safety", safetyRoutes);
app.use("/api/v1/moderation", moderationRoutes);
app.use("/api/v1/webrtc", webrtcRoutes);

/**
 * Starts the HTTP and Socket.IO server after establishing required database connection.
 * On unrecoverable database connection failure:
 * - Logs a safe error message without credentials.
 * - Does NOT start listening for traffic.
 * - Terminates process with exit code 1 if exitOnError is true.
 *
 * @param {Object} [options]
 * @param {boolean} [options.exitOnError=true]
 * @returns {Promise<{ app: Express, server: http.Server, connectionDb: mongoose.Connection }>}
 */
const start = async ({ exitOnError = true } = {}) => {
  if (!process.env.MONGO_URI || !process.env.MONGO_URI.trim()) {
    const errorMsg = "Fatal Startup Error: MONGO_URI environment variable is required to start the server.";
    console.error(`❌ ${errorMsg}`);
    if (exitOnError) {
      process.exit(1);
    }
    throw new Error(errorMsg);
  }

  try {
    const connectionDb = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MONGO Connected DB Host: ${connectionDb.connection.host}`);

    await new Promise((resolve, reject) => {
      server.listen(app.get("port"), () => {
        console.log(`🚀 Listening on PORT ${app.get("port")}`);
        resolve();
      });
      server.once("error", reject);
    });

    return { app, server, connectionDb };
  } catch (err) {
    console.error("❌ Fatal MongoDB Startup Connection Error:", err.message);
    if (exitOnError) {
      process.exit(1);
    }
    throw err;
  }
};

/**
 * Graceful process shutdown handler for SIGTERM and SIGINT signals.
 */
let isShuttingDown = false;
const gracefulShutdown = async (signal = "SIGTERM", { exit = true } = {}) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}. Initiating graceful shutdown...`);

  try {
    // 1. Stop accepting new HTTP connections
    await new Promise((resolve) => {
      if (server.listening) {
        server.close((err) => {
          if (err) console.error("Error closing HTTP server:", err.message);
          resolve();
        });
      } else {
        resolve();
      }
    });

    // 2. Disconnect active Socket.IO connections
    if (io) {
      io.disconnectSockets(true);
    }

    // 3. Disconnect Mongoose
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log("Mongoose connection closed cleanly.");
    }

    console.log("Graceful shutdown complete.");
    if (exit) {
      process.exit(0);
    }
  } catch (shutdownErr) {
    console.error("Error during graceful shutdown:", shutdownErr.message);
    if (exit) {
      process.exit(1);
    }
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

export { app, server, start, gracefulShutdown };
