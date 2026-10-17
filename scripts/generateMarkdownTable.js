import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const DEMO_INDIAN_USERNAMES = new Set([
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
]);

async function generateMarkdownTable() {
    await mongoose.connect(process.env.MONGO_URI);
    const allUsers = await User.find({}).sort({ createdAt: 1 });

    const testAccounts = [];
    const realUsers = [];

    for (const u of allUsers) {
        const username = u.username.toLowerCase();
        const name = (u.name || "").toLowerCase();
        const bio = (u.bio || "").toLowerCase();

        if (DEMO_INDIAN_USERNAMES.has(username)) {
            continue;
        }

        let isTest = false;
        let reason = "";

        if (
            username.startsWith("test_user") ||
            username.startsWith("testuser") ||
            username.startsWith("chat_alpha") ||
            username.startsWith("chat_beta") ||
            username.startsWith("chat_charlie") ||
            username.startsWith("rnd_alice") ||
            username.startsWith("rnd_bob") ||
            username.startsWith("rnd_carol") ||
            username.startsWith("conc_") ||
            username.startsWith("prod_test_") ||
            username.startsWith("test_")
        ) {
            isTest = true;
            reason = `Username matches automated test pattern ("${username.split('_')[0]}")`;
        } else if (
            name.includes("test user") ||
            name.includes("render verified user") ||
            ((name.startsWith("chat_") || name.startsWith("rnd_") || name.startsWith("conc_")) && name.endsWith("user"))
        ) {
            isTest = true;
            reason = `Name matches test placeholder pattern ("${u.name}")`;
        } else if (
            bio.startsWith("bio for test_") ||
            bio.startsWith("dating bio for ") ||
            bio.startsWith("bio for chat_") ||
            bio.includes("automated render production verification")
        ) {
            isTest = true;
            reason = `Bio matches test placeholder text ("${u.bio}")`;
        }

        if (isTest) {
            testAccounts.push({
                _id: u._id.toString(),
                username: u.username,
                name: u.name,
                reason,
                inDiscovery: u.isProfileComplete ? "Yes" : "No",
                created: u.createdAt?.toISOString().split("T")[0]
            });
        } else {
            realUsers.push({
                _id: u._id.toString(),
                username: u.username,
                name: u.name,
                gender: u.gender || "none",
                isProfileComplete: u.isProfileComplete,
                created: u.createdAt?.toISOString().split("T")[0]
            });
        }
    }

    console.log(`PROPOSED_COUNT:${testAccounts.length}`);
    console.log(`REAL_COUNT:${realUsers.length}`);

    await mongoose.disconnect();
}

generateMarkdownTable().catch(console.error);

