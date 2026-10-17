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
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
]);

async function main() {
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
                gender: u.gender || "none",
                isProfileComplete: u.isProfileComplete,
                reason
            });
        } else {
            realUsers.push({
                _id: u._id.toString(),
                username: u.username,
                name: u.name,
                gender: u.gender || "none",
                isProfileComplete: u.isProfileComplete,
                bio: u.bio,
                photos: u.photos?.length || 0,
                createdAt: u.createdAt
            });
        }
    }

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

    console.log("==================================================");
    console.log(`DATABASE TARGET: MongoDB Atlas (${dbHost}/${dbName})`);
    console.log(`TOTAL USERS IN DATABASE: ${allUsers.length}`);
    console.log(`RETAINED DEMO PROFILES (Indian 10F/10M): ${demoProfiles.length}`);
    console.log(`RETAINED GENUINE USERS (Untouched): ${realUsers.length}`);
    console.log(`PROPOSED TEST ACCOUNTS TO DELETE: ${testAccounts.length}`);
    console.log("==================================================\n");

    console.log("--- 1. REAL REGISTERED USERS (TO PRESERVE COMPLETELY) ---");
    realUsers.forEach((u, i) => {
        console.log(`  ${i+1}. [${u._id}] @${u.username} | "${u.name}" | Gender: ${u.gender} | ProfileComplete: ${u.isProfileComplete} | Photos: ${u.photos}`);
    });

    console.log("\n--- 2. ASSOCIATED TEST RECORDS IN OTHER COLLECTIONS ---");
    console.log(`  - Test Swipes: ${testSwipesCount}`);
    console.log(`  - Test Matches: ${testMatchesCount}`);
    console.log(`  - Test Conversations: ${testConvsCount}`);
    console.log(`  - Test Messages: ${testMsgsCount}`);

    console.log("\n--- 3. DETAILED TEST ACCOUNTS BREAKDOWN (BY TEST BATCH) ---");
    const testUserAtoF = testAccounts.filter(a => a.username.includes("test_user_"));
    const chatAlphaBetaCharlie = testAccounts.filter(a => a.username.includes("chat_"));
    const rndAliceBobCarol = testAccounts.filter(a => a.username.includes("rnd_"));
    const conc1to4 = testAccounts.filter(a => a.username.includes("conc_"));
    const prodTest = testAccounts.filter(a => a.username.includes("prod_test"));
    const otherTests = testAccounts.filter(a => 
        !a.username.includes("test_user_") && 
        !a.username.includes("chat_") && 
        !a.username.includes("rnd_") && 
        !a.username.includes("conc_") && 
        !a.username.includes("prod_test")
    );

    console.log(`  - Discovery Phase Test Users (test_user_a..f): ${testUserAtoF.length}`);
    console.log(`  - Private Chat Phase Test Users (chat_alpha..charlie): ${chatAlphaBetaCharlie.length}`);
    console.log(`  - Video Matchmaking Phase Test Users (rnd_alice..carol): ${rndAliceBobCarol.length}`);
    console.log(`  - Concurrency Test Users (conc_1..4): ${conc1to4.length}`);
    console.log(`  - Render Production Verification Account (prod_test_...): ${prodTest.length}`);
    console.log(`  - Other explicit test accounts: ${otherTests.length}`);

    await mongoose.disconnect();
}

main().catch(console.error);

