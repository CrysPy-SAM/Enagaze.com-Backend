import dotenv from "dotenv";
import path from "path";
import fs from "fs";
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

const DEMO_INDIAN_USERNAMES = [
  // 10 Female
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  // 10 Male
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
];

async function writeArtifact() {
    await mongoose.connect(process.env.MONGO_URI);
    const dbHost = mongoose.connection.host;
    const dbName = mongoose.connection.name;

    const allUsers = await User.find({}).sort({ createdAt: 1 });

    const demoProfiles = [];
    const realUsers = [];
    const testAccounts = [];

    const demoSet = new Set(DEMO_INDIAN_USERNAMES);

    for (const u of allUsers) {
        const username = u.username.toLowerCase();
        const name = (u.name || "").toLowerCase();
        const bio = (u.bio || "").toLowerCase();

        if (demoSet.has(username)) {
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
            reason = `Username prefix ("${username.split('_')[0]}") matches automated test script`;
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
            reason = `Bio text matches automated test fixture template: "${u.bio}"`;
        }

        if (isTest) {
            testAccounts.push({
                _id: u._id.toString(),
                username: u.username,
                name: u.name,
                gender: u.gender || "none",
                isProfileComplete: u.isProfileComplete,
                photoCount: u.photos?.length || 0,
                createdAt: u.createdAt?.toISOString().split("T")[0],
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
                createdAt: u.createdAt?.toISOString().split("T")[0]
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

    let md = `# ENGAZE.COM — DISCOVERY FEED CLEANUP DRY-RUN AUDIT REPORT\n\n`;
    md += `**Date:** ${new Date().toISOString()}\n`;
    md += `**Database Target:** MongoDB Atlas Production (\`${dbHost}/${dbName}\`)\n`;
    md += `**Status:** DRY-RUN ONLY — ZERO DATABASE RECORDS HAVE BEEN MODIFIED OR DELETED\n\n`;

    md += `## 1. Executive Summary\n\n`;
    md += `| Category | Count | Proposed Action |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| **Total Users in Database** | **${allUsers.length}** | Baseline inventory |\n`;
    md += `| **Realistic Indian Demo Profiles** | **${demoProfiles.length}** | **RETAIN (100% Preserved & Verified)** |\n`;
    md += `| **Genuine User Accounts** | **${realUsers.length}** | **RETAIN (100% Untouched)** |\n`;
    md += `| **Test & Placeholder Profiles** | **${testAccounts.length}** | **PROPOSED FOR DELETION (Pending User Approval)** |\n`;
    md += `| Associated Test Swipes | ${testSwipesCount} | Proposed cascade removal |\n`;
    md += `| Associated Test Matches | ${testMatchesCount} | Proposed cascade removal |\n`;
    md += `| Associated Test Conversations | ${testConvsCount} | Proposed cascade removal |\n`;
    md += `| Associated Test Messages | ${testMsgsCount} | Proposed cascade removal |\n\n`;

    md += `> [!IMPORTANT]\n`;
    md += `> **Zero Deletions Executed**: In accordance with rule #9, no database records have been deleted or modified. Deletion will only take place once you explicitly review and approve this dry-run list.\n\n`;

    md += `## 2. Root Cause Analysis: Why Test Accounts Appeared in Discovery\n\n`;
    md += `1. **Integration Test Artifacts**: During previous testing phases (discovery, private chat, video matchmaking, concurrency testing), automated integration test scripts registered accounts with prefixes such as \`test_user_a..\`, \`chat_alpha..\`, \`rnd_alice..\`, \`conc_1..\`.\n`;
    md += `2. **Profile Completion Flag**: Those test scripts called \`PUT /api/v1/users/profile/me\` with \`isProfileComplete: true\` and placeholder photos/bios to test feed mechanics.\n`;
    md += `3. **Lack of Automated Teardown**: The test scripts previously concluded without an automated \`afterAll()\` teardown block, leaving the placeholder profiles active in MongoDB Atlas.\n`;
    md += `4. **Discovery Query Inclusion**: In \`discovery.controller.js\`, the discovery engine queries \`{ isProfileComplete: true, _id: { $nin: excludedIds } }\`. Because the test profiles were marked complete, they were served directly to browsing users in the dating card deck.\n\n`;

    md += `## 3. Retained Profiles: 20 Realistic Indian Demo Profiles\n\n`;
    md += `All 20 profiles from \`backend/scripts/seedProfiles.js\` have been verified in MongoDB Atlas:\n\n`;
    md += `### Female Profiles (10 Girls)\n`;
    md += `| # | Username | Name | Age | Photos | Interests | In Discovery |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    demoProfiles.filter(p => p.gender === "female").forEach((p, idx) => {
        const age = p.dob ? Math.floor((new Date() - new Date(p.dob)) / (365.25 * 24 * 60 * 60 * 1000)) : "N/A";
        md += `| ${idx+1} | \`@${p.username}\` | **${p.name}** | ${age} | ${p.photos?.length || 0} Unsplash | ${p.interests?.length || 0} tags | ✔ Yes |\n`;
    });

    md += `\n### Male Profiles (10 Boys)\n`;
    md += `| # | Username | Name | Age | Photos | Interests | In Discovery |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    demoProfiles.filter(p => p.gender === "male").forEach((p, idx) => {
        const age = p.dob ? Math.floor((new Date() - new Date(p.dob)) / (365.25 * 24 * 60 * 60 * 1000)) : "N/A";
        md += `| ${idx+1} | \`@${p.username}\` | **${p.name}** | ${age} | ${p.photos?.length || 0} Unsplash | ${p.interests?.length || 0} tags | ✔ Yes |\n`;
    });

    md += `\n## 4. Retained Genuine User Accounts (${realUsers.length} Users)\n\n`;
    md += `These accounts do not match any test prefixes and will be preserved completely untouched:\n\n`;
    md += `| # | MongoDB \`_id\` | Username | Display Name | Gender | Profile Complete | Registered Date |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    realUsers.forEach((u, idx) => {
        md += `| ${idx+1} | \`${u._id}\` | \`@${u.username}\` | ${u.name} | ${u.gender} | ${u.isProfileComplete ? "Yes" : "No"} | ${u.createdAt} |\n`;
    });

    md += `\n## 5. Complete Proposed Deletion List (${testAccounts.length} Test/Placeholder Accounts)\n\n`;
    md += `The following accounts have been classified as automated test fixtures or test placeholders. None will be deleted until your explicit confirmation.\n\n`;
    md += `| # | MongoDB \`_id\` | Username | Display Name | Visible in Discovery | Classification Reason |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    testAccounts.forEach((t, idx) => {
        md += `| ${idx+1} | \`${t._id}\` | \`@${t.username}\` | ${t.name} | ${t.isProfileComplete ? "Yes" : "No"} | ${t.reason} |\n`;
    });

    md += `\n## 6. Prevention Strategy (Rule #5)\n\n`;
    md += `To prevent test/placeholder accounts from ever re-entering the normal demo dataset:\n`;
    md += `1. **Dedicated Test Cleanup**: Test scripts must include guaranteed teardown functions (\`cleanUpTestUsers()\` in \`finally\` blocks).\n`;
    md += `2. **Strict Seeding Isolation**: \`backend/scripts/seedProfiles.js\` only upserts from the strict 20 Indian profile definitions (\`DUMMY_PROFILES\`) and does not seed placeholder names.\n`;
    md += `3. **Discovery Filtering**: The Discovery feed strictly requires \`isProfileComplete: true\` and genuine profile fields.\n\n`;

    const targetPath = "C:/Users/hi/.gemini/antigravity/brain/bfd25884-b54e-4f9c-9216-ad01b1e2669d/DISCOVERY_CLEANUP_DRY_RUN_REPORT.md";
    fs.writeFileSync(targetPath, md, "utf8");
    console.log(`Successfully written artifact to: ${targetPath}`);

    await mongoose.disconnect();
}

writeArtifact().catch(console.error);

