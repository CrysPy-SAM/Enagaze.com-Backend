import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const DEMO_INDIAN_USERNAMES = new Set([
  // 10 Female
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  // 10 Male
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
]);

async function analyzeUsers() {
    await mongoose.connect(process.env.MONGO_URI);

    const allUsers = await User.find({}).sort({ createdAt: 1 });
    console.log(`Total users in DB: ${allUsers.length}`);

    const demoProfiles = [];
    const testPlaceholderProfiles = [];
    const realOrNormalUsers = [];

    for (const u of allUsers) {
        const username = u.username.toLowerCase();
        const name = (u.name || "").toLowerCase();
        const bio = (u.bio || "").toLowerCase();

        if (DEMO_INDIAN_USERNAMES.has(username)) {
            demoProfiles.push(u);
            continue;
        }

        // Test indicators check
        let isTest = false;
        let testReason = "";

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
            testReason = `Username pattern matches automated test prefix ("${username.split('_')[0]}")`;
        } else if (
            name.startsWith("test user") ||
            name.includes("test user") ||
            name.endsWith("user") && (name.startsWith("chat_") || name.startsWith("rnd_") || name.startsWith("conc_"))
        ) {
            isTest = true;
            testReason = `Name matches test placeholder pattern ("${u.name}")`;
        } else if (
            bio.startsWith("bio for test_") ||
            bio.startsWith("dating bio for ") ||
            bio.startsWith("bio for chat_") ||
            bio.includes("automated render production verification")
        ) {
            isTest = true;
            testReason = `Bio matches automated test placeholder text ("${u.bio}")`;
        }

        if (isTest) {
            testPlaceholderProfiles.push({ user: u, reason: testReason });
        } else {
            realOrNormalUsers.push(u);
        }
    }

    console.log("\n==================================================");
    console.log(`1. Realistic Indian Demo Profiles (TO KEEP): ${demoProfiles.length}`);
    console.log("==================================================");
    demoProfiles.forEach((u, i) => {
        console.log(`${i+1}. [${u.gender.toUpperCase()}] ${u.name} (@${u.username}) - Complete: ${u.isProfileComplete}, Photos: ${u.photos?.length}`);
    });

    console.log("\n==================================================");
    console.log(`2. Real Registered Users (TO KEEP TOUCH-FREE): ${realOrNormalUsers.length}`);
    console.log("==================================================");
    realOrNormalUsers.forEach((u, i) => {
        console.log(`${i+1}. id=${u._id} | username="${u.username}" | name="${u.name}" | Complete: ${u.isProfileComplete} | Photos: ${u.photos?.length} | Created: ${u.createdAt?.toISOString()}`);
    });

    console.log("\n==================================================");
    console.log(`3. Proposed Test Accounts to Remove (DRY RUN): ${testPlaceholderProfiles.length}`);
    console.log("==================================================");
    testPlaceholderProfiles.forEach((item, i) => {
        const u = item.user;
        console.log(`${i+1}. id: ${u._id} | @${u.username} | "${u.name}" | inDiscovery: ${u.isProfileComplete} | Reason: ${item.reason}`);
    });

    await mongoose.disconnect();
}

analyzeUsers().catch(console.error);

