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

// ✅ Ensure .env loads properly even in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// Ensure database URI is configured
if (!process.env.MONGO_URI) {
  console.warn("⚠️ Warning: MONGO_URI is not set in environment variables.");
}

// Ensure JWT secret is configured in production
if (!process.env.JWT_SECRET) {
  console.warn("⚠️ Warning: JWT_SECRET is not set in environment variables. Using development fallback.");
}

const app = express();
const server = createServer(app);
connectToSocket(server);

app.set("port", process.env.PORT || 8000);

// Explicit CORS configuration supporting Vercel production frontend and local dev
const allowedOrigins = [
  "https://engaze-com.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app") ||
        process.env.NODE_ENV !== "production"
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

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

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/discovery", discoveryRoutes);
app.use("/api/v1/matches", matchRoutes);
app.use("/api/v1/conversations", chatRoutes);

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

start();
