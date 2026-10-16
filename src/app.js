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

const app = express();
const server = createServer(app);
connectToSocket(server);

app.set("port", process.env.PORT || 8000);
app.use(cors());
app.use(express.json({ limit: "40kb" }));
app.use(express.urlencoded({ limit: "40kb", extended: true }));

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
