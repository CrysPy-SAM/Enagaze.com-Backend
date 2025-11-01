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

// ✅ Ensure .env loads properly even in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// ✅ Debug line (optional, for first test)
console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

const app = express();
const server = createServer(app);
connectToSocket(server);

app.set("port", process.env.PORT || 8000);
app.use(cors());
app.use(express.json({ limit: "40kb" }));
app.use(express.urlencoded({ limit: "40kb", extended: true }));

app.use("/api/v1/users", userRoutes);

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
