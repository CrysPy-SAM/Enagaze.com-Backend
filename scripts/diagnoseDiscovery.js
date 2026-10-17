import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";
import { Swipe } from "../src/models/swipe.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const DEMO_INDIAN_USERNAMES = [
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
];

async function diagnose() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Database Connected: " + mongoose.connection.name + " on " + mongoose.connection.host);

  // 1. Check all 20 demo profiles
  console.log("\n--- Checking 20 Demo Profiles ---");
  const foundDemo = await User.find({ username: { $in: DEMO_INDIAN_USERNAMES } }).lean();
  console.log("Demo profiles found in DB:", foundDemo.length, "/ 20");
  const foundUsernames = new Set(foundDemo.map(u => u.username));
  const missing = DEMO_INDIAN_USERNAMES.filter(u => !foundUsernames.has(u));
  console.log("Missing demo profiles:", missing);

  // 2. Check Swipes collection: who has swiped on what?
  console.log("\n--- Checking Swipes Collection ---");
  const allSwipes = await Swipe.find({}).lean();
  console.log("Total swipes in DB:", allSwipes.length);
  const swipesByFromUser = {};
  for (const s of allSwipes) {
    const f = s.fromUser.toString();
    swipesByFromUser[f] = (swipesByFromUser[f] || 0) + 1;
  }

  // 3. Inspect genuine users and demo profiles
  console.log("\n--- Inspecting All Users & Discovery Eligibility ---");
  const allUsersToTest = await User.find({}).lean();
  console.log("Total users to test:", allUsersToTest.length);

  for (const u of allUsersToTest) {
    const swipedRecords = await Swipe.find({ fromUser: u._id }).select("toUser");
    const swipedIds = swipedRecords.map(s => s.toUser.toString());
    const excludedIds = [u._id, ...swipedRecords.map(s => s.toUser)];

    // Exact query from discovery.controller.js
    const query = {
      _id: { $nin: excludedIds },
      isProfileComplete: true
    };

    const interestedIn = u.datingPreferences?.interestedIn;
    if (interestedIn && Array.isArray(interestedIn) && !interestedIn.includes("everyone")) {
      query.gender = { $in: interestedIn };
    }

    if (u.gender) {
      query["datingPreferences.interestedIn"] = { $in: [u.gender, "everyone"] };
    }

    const ageRange = u.datingPreferences?.ageRange;
    if (ageRange && ageRange.min && ageRange.max) {
      const now = new Date();
      const earliestDob = new Date(now.getFullYear() - ageRange.max - 1, now.getMonth(), now.getDate());
      const latestDob = new Date(now.getFullYear() - ageRange.min, now.getMonth(), now.getDate());
      query.dob = { $gte: earliestDob, $lte: latestDob };
    }

    const count = await User.countDocuments(query);
    console.log(`@${u.username} (name: "${u.name}", gender: "${u.gender}", prefs: ${JSON.stringify(u.datingPreferences?.interestedIn || [])}) -> Swipes: ${swipedRecords.length} -> Discovery count: ${count}`);
  }

  console.log("\n--- Detailed inspection for user 'alex' ---");
  const alex = await User.findOne({ username: "alex" });
  if (alex) {
    const alexSwipes = await Swipe.find({ fromUser: alex._id }).populate("toUser", "username");
    console.log(`Total swipes by alex: ${alexSwipes.length}`);
    const demoSwiped = alexSwipes.filter(s => s.toUser && DEMO_INDIAN_USERNAMES.includes(s.toUser.username));
    console.log(`Demo profiles swiped by alex: ${demoSwiped.length}`);
    for (const s of demoSwiped) {
      console.log(`  - @${s.toUser.username} (${s.action}) at ${s.createdAt?.toISOString()}`);
    }
  }

  await mongoose.disconnect();
}

diagnose().catch(console.error);
