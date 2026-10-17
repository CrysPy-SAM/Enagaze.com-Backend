import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";
import { Swipe } from "../src/models/swipe.model.js";
import { Match } from "../src/models/match.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { Message } from "../src/models/message.model.js";

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

async function generateReport() {
    await mongoose.connect(process.env.MONGO_URI);
    const dbHost = mongoose.connection.host;
    const dbName = mongoose.connection.name;

    const allUsers = await User.find({}).sort({ createdAt: 1 });

    const demoProfiles = [];
    const realUsers = [];
    const testAccounts = [];

    for (const u of allUsers) {
        const username = u.username.toLowerCase();
        const name = (u.name || "").toLowerCase();
        const bio = (u.bio || "").toLowerCase();

        if (DEMO_INDIAN_USERNAMES.has(username)) {
            demoProfiles.push(u);
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
            reason = `Username begins with automated test pattern: "${username.split('_')[0]}"`;
        } else if (
            name.includes("test user") ||
            name.includes("render verified user") ||
            ((name.startsWith("chat_") || name.startsWith("rnd_") || name.startsWith("conc_")) && name.endsWith("user"))
        ) {
            isTest = true;
            reason = `Name matches test placeholder pattern: "${u.name}"`;
        } else if (
            bio.startsWith("bio for test_") ||
            bio.startsWith("dating bio for ") ||
            bio.startsWith("bio for chat_") ||
            bio.includes("automated render production verification")
        ) {
            isTest = true;
            reason = `Bio matches automated test placeholder text: "${u.bio}"`;
        }

        if (isTest) {
            testAccounts.push({
                _id: u._id.toString(),
                username: u.username,
                name: u.name,
                gender: u.gender || "none",
                isProfileComplete: u.isProfileComplete,
                photoCount: u.photos?.length || 0,
                createdAt: u.createdAt?.toISOString(),
                reason
            });
        } else {
            realUsers.push({
                _id: u._id.toString(),
                username: u.username,
                name: u.name,
                gender: u.gender || "none",
                isProfileComplete: u.isProfileComplete,
                photoCount: u.photos?.length || 0,
                bio: u.bio || "",
                createdAt: u.createdAt?.toISOString()
            });
        }
    }

    // Check related collections for test accounts
    const testIds = testAccounts.map(a => new mongoose.Types.ObjectId(a._id));
    const testSwipesCount = await Swipe.countDocuments({
        $or: [{ fromUser: { $in: testIds } }, { toUser: { $in: testIds } }]
    });
    const testMatchesCount = await Match.countDocuments({
        users: { $in: testIds }
    });
    const testConvsCount = await Conversation.countDocuments({
        participants: { $in: testIds }
    });
    const testMsgsCount = await Message.countDocuments({
        sender: { $in: testIds }
    });

    console.log(JSON.stringify({
        database: { host: dbHost, name: dbName },
        totalUsers: allUsers.length,
        demoCount: demoProfiles.length,
        realCount: realUsers.length,
        testCount: testAccounts.length,
        testAccounts,
        realUsers,
        demoProfiles: demoProfiles.map(d => ({
            _id: d._id.toString(),
            username: d.username,
            name: d.name,
            gender: d.gender,
            isProfileComplete: d.isProfileComplete,
            photoCount: d.photos?.length || 0,
            hasValidDob: Boolean(d.dob),
            interestsCount: d.interests?.length || 0
        })),
        cascadeStats: {
            swipes: testSwipesCount,
            matches: testMatchesCount,
            conversations: testConvsCount,
            messages: testMsgsCount
        }
    }, null, 2));

    await mongoose.disconnect();
}

generateReport().catch(console.error);

