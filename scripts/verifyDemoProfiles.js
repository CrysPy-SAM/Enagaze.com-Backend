import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const DEMO_INDIAN_USERNAMES = [
  // 10 Female
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  // 10 Male
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
];

async function verifyDemoProfiles() {
    await mongoose.connect(process.env.MONGO_URI);

    console.log("==================================================");
    console.log("  VERIFYING 20 REALISTIC INDIAN DEMO PROFILES     ");
    console.log("==================================================");

    let allValid = true;

    for (let i = 0; i < DEMO_INDIAN_USERNAMES.length; i++) {
        const username = DEMO_INDIAN_USERNAMES[i];
        const user = await User.findOne({ username });

        if (!user) {
            console.error(`❌ MISSING PROFILE: @${username}`);
            allValid = false;
            continue;
        }

        const age = user.dob ? Math.floor((new Date() - new Date(user.dob)) / (365.25 * 24 * 60 * 60 * 1000)) : null;
        const validPhotos = Array.isArray(user.photos) && user.photos.length >= 2 && user.photos.every(p => p.startsWith("https://images.unsplash.com/"));
        const validInterests = Array.isArray(user.interests) && user.interests.length >= 3;
        const validBio = Boolean(user.bio && user.bio.length >= 20);

        const ok = user.isProfileComplete && age >= 18 && validPhotos && validInterests && validBio;
        if (!ok) allValid = false;

        console.log(`${i+1}. [${user.gender?.toUpperCase()}] ${user.name} (@${user.username}) | Age: ${age} | Complete: ${user.isProfileComplete} | Photos: ${user.photos.length} | Interests: ${user.interests.length} | Status: ${ok ? "PASS ✔" : "FAIL ❌"}`);
    }

    console.log("==================================================");
    console.log(`RESULT: ${allValid ? "ALL 20 DEMO PROFILES FULLY VALID & READY ✔" : "SOME PROFILES NEED FIXING ❌"}`);
    console.log("==================================================");

    await mongoose.disconnect();
}

verifyDemoProfiles().catch(console.error);

