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

// Health check endpoints for Render and status monitors
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Engaze.com Backend API",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

// Global rate limiting on API routes (bypassed for root and /health)
app.use("/api/v1", globalApiLimiter);

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/discovery", discoveryRoutes);
app.use("/api/v1/matches", matchRoutes);
app.use("/api/v1/conversations", chatRoutes);
app.use("/api/v1/safety", safetyRoutes);
app.use("/api/v1/moderation", moderationRoutes);

const start = async () => {
  try {
    const connectionDb = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MONGO Connected DB Host: ${connectionDb.connection.host}`);
    server.listen(app.get("port"), () => {
      console.log(`🚀 Listening on PORT ${app.get("port")}`);
    });
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err.message);
  }
};

const isMainModule = Boolean(
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isMainModule) {
  start();
}

export { app, server, start };
