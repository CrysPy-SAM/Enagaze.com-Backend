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

const DEMO_INDIAN_USERNAMES = new Set([
  // 10 Female
  "ananya_sharma", "priya_patel", "diya_sen", "sneha_reddy", "ishita_verma",
  "riya_kapoor", "meera_nair", "tanvi_deshmukh", "pooja_joshi", "kavya_iyer",
  // 10 Male
  "aarav_mehta", "rohan_gupta", "kabir_malhotra", "vikram_singhania", "aditya_rao",
  "siddharth_roy", "arjun_khanna", "dev_choudhary", "varun_bhatia", "kunal_nair"
]);

const KNOWN_GENUINE_EXPLICIT = new Set([
  "heyyy", "satyam0987643", "doggy", "satyam mishra", "mishrasaty9889@gmail.com",
  "arif", "realme123", "satyam_mishrra", "heyyyy", "ram", "satyammishra", "alex", "alia"
]);

async function runCleanup() {
  console.log("================================================================================");
  console.log("ENGAZE.COM — DISCOVERY TEST-PROFILE CLEANUP EXECUTION");
  console.log("================================================================================");

  // 1. Database Connection & Environment Verification
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing from environment variables! Aborting.");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const dbHost = mongoose.connection.host;
  const dbName = mongoose.connection.name;
  console.log(`[1] Database Connected: Host=${dbHost}, Database=${dbName}, ReadyState=${mongoose.connection.readyState}`);

  if (dbName !== "test" || !dbHost.includes("mongodb.net")) {
    throw new Error(`Target database "${dbName}" at "${dbHost}" does not match expected MongoDB Atlas cluster. Aborting for safety!`);
  }
  console.log("    -> Target database connection verified safely.");

  // 2. Inventory & Classification
  const allUsers = await User.find({}).sort({ createdAt: 1 }).lean();
  console.log(`[2] Total users currently in DB: ${allUsers.length}`);

  const retainedDemo = [];
  const retainedGenuine = [];
  const testCandidates = [];
  const ambiguous = [];

  for (const u of allUsers) {
    const un = (u.username || "").toLowerCase().trim();
    const name = (u.name || "").toLowerCase().trim();
    const bio = (u.bio || "").toLowerCase().trim();

    // Check 20 Demo Profiles
    if (DEMO_INDIAN_USERNAMES.has(un)) {
      retainedDemo.push(u);
      continue;
    }

    // Check Genuine Accounts
    if (KNOWN_GENUINE_EXPLICIT.has(un) || un.startsWith("alice_")) {
      // Per instructions: Keep genuine and keep the 8 alice_<timestamp> accounts safe
      retainedGenuine.push(u);
      continue;
    }

    // Check Test Candidate Indicators
    const isTestUsername = (
      un.startsWith("test_user_") ||
      un.startsWith("testuser") ||
      un.startsWith("chat_alpha") ||
      un.startsWith("chat_beta") ||
      un.startsWith("chat_charlie") ||
      un.startsWith("rnd_alice") ||
      un.startsWith("rnd_bob") ||
      un.startsWith("rnd_carol") ||
      un.startsWith("conc_") ||
      un.startsWith("prod_test_") ||
      un.startsWith("test_")
    );

    const isTestNameOrBio = (
      name.includes("test user") ||
      name.startsWith("chat_") ||
      name.startsWith("rnd_") ||
      name.startsWith("conc_") ||
      bio.startsWith("bio for test_") ||
      bio.startsWith("dating bio for ") ||
      bio.startsWith("bio for chat_") ||
      bio.includes("automated render production verification")
    );

    if (isTestUsername) {
      testCandidates.push(u);
    } else if (isTestNameOrBio) {
      testCandidates.push(u);
    } else {
      // Ambiguous or unrecognized
      ambiguous.push(u);
    }
  }

  console.log(`    - Retained Realistic Indian Demo Profiles: ${retainedDemo.length} (Expected: 20)`);
  console.log(`    - Retained Genuine Accounts (including 8 alice runners): ${retainedGenuine.length} (Expected: 21)`);
  console.log(`    - Verified Test Accounts: ${testCandidates.length} (Expected: 107)`);
  console.log(`    - Ambiguous Accounts (Skipped): ${ambiguous.length}`);

  if (retainedDemo.length !== 20) {
    throw new Error(`Demo profiles count mismatch! Found ${retainedDemo.length}, expected 20. Aborting.`);
  }
  if (retainedGenuine.length !== 21) {
    throw new Error(`Genuine accounts count mismatch! Found ${retainedGenuine.length}, expected 21. Aborting.`);
  }
  if (testCandidates.length !== 107) {
    throw new Error(`Test candidates count mismatch! Found ${testCandidates.length}, expected 107. Aborting.`);
  }

  const testUserIds = testCandidates.map(u => u._id);
  const testUserIdSet = new Set(testCandidates.map(u => u._id.toString()));
  const retainedUserIdSet = new Set([...retainedDemo, ...retainedGenuine].map(u => u._id.toString()));

  // 3. Inspect Cascades & Cross-Links
  console.log("[3] Inspecting Cascades & Cross-links...");
  const candidateSwipes = await Swipe.find({
    $or: [{ fromUser: { $in: testUserIds } }, { toUser: { $in: testUserIds } }]
  }).lean();

  // Ensure NO swipe involves retained genuine users
  const safeSwipesToDelete = [];
  const crossSwipes = [];
  for (const s of candidateSwipes) {
    const fromIsRetained = retainedUserIdSet.has(s.fromUser?.toString());
    const toIsRetained = retainedUserIdSet.has(s.toUser?.toString());
    if (fromIsRetained || toIsRetained) {
      crossSwipes.push(s);
    } else {
      safeSwipesToDelete.push(s);
    }
  }
  console.log(`    - Test-only Swipes: ${safeSwipesToDelete.length}`);
  console.log(`    - Cross Swipes with retained users: ${crossSwipes.length}`);

  const candidateMatches = await Match.find({
    users: { $in: testUserIds }
  }).lean();

  const safeMatchesToDelete = [];
  const crossMatches = [];
  for (const m of candidateMatches) {
    const hasRetained = m.users.some(uid => retainedUserIdSet.has(uid?.toString()));
    if (hasRetained) {
      crossMatches.push(m);
    } else {
      safeMatchesToDelete.push(m);
    }
  }
  console.log(`    - Test-only Matches: ${safeMatchesToDelete.length}`);
  console.log(`    - Cross Matches with retained users: ${crossMatches.length}`);

  const safeMatchIdsToDelete = safeMatchesToDelete.map(m => m._id);

  const candidateConversations = await Conversation.find({
    $or: [
      { match: { $in: safeMatchIdsToDelete } },
      { participants: { $in: testUserIds } }
    ]
  }).lean();

  const safeConversationsToDelete = [];
  const crossConversations = [];
  for (const c of candidateConversations) {
    const hasRetained = c.participants.some(uid => retainedUserIdSet.has(uid?.toString()));
    if (hasRetained) {
      crossConversations.push(c);
    } else {
      safeConversationsToDelete.push(c);
    }
  }
  console.log(`    - Test-only Conversations: ${safeConversationsToDelete.length}`);
  console.log(`    - Cross Conversations with retained users: ${crossConversations.length}`);

  const safeConvIdsToDelete = safeConversationsToDelete.map(c => c._id);

  const candidateMessages = await Message.find({
    $or: [
      { conversation: { $in: safeConvIdsToDelete } },
      { sender: { $in: testUserIds } }
    ]
  }).lean();

  const safeMessagesToDelete = [];
  const crossMessages = [];
  for (const msg of candidateMessages) {
    const senderIsRetained = retainedUserIdSet.has(msg.sender?.toString());
    if (senderIsRetained) {
      crossMessages.push(msg);
    } else {
      safeMessagesToDelete.push(msg);
    }
  }
  console.log(`    - Test-only Messages: ${safeMessagesToDelete.length}`);
  console.log(`    - Cross Messages with retained users: ${crossMessages.length}`);

  // 4. Create Recoverable Backup Export
  console.log("[4] Creating Pre-Deletion JSON Backup...");
  const backupData = {
    exportedAt: new Date().toISOString(),
    databaseHost: dbHost,
    databaseName: dbName,
    summary: {
      usersCount: testCandidates.length,
      swipesCount: safeSwipesToDelete.length,
      matchesCount: safeMatchesToDelete.length,
      conversationsCount: safeConversationsToDelete.length,
      messagesCount: safeMessagesToDelete.length
    },
    users: testCandidates,
    swipes: safeSwipesToDelete,
    matches: safeMatchesToDelete,
    conversations: safeConversationsToDelete,
    messages: safeMessagesToDelete
  };

  const backupDir = path.join(__dirname, "../backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFilePath = path.join(backupDir, `cleanup_backup_${timestampStr}.json`);
  fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), "utf8");
  console.log(`    -> Local backup written: ${backupFilePath} (${(fs.statSync(backupFilePath).size / 1024).toFixed(1)} KB)`);

  // Also write to brain scratch directory if available
  const brainScratchDir = "C:\\Users\\hi\\.gemini\\antigravity\\brain\\bfd25884-b54e-4f9c-9216-ad01b1e2669d\\scratch";
  if (!fs.existsSync(brainScratchDir)) {
    fs.mkdirSync(brainScratchDir, { recursive: true });
  }
  const brainBackupPath = path.join(brainScratchDir, `cleanup_backup_${timestampStr}.json`);
  fs.writeFileSync(brainBackupPath, JSON.stringify(backupData, null, 2), "utf8");
  console.log(`    -> Artifact scratch backup written: ${brainBackupPath}`);

  // 5. Execute Safe Deletion (Ordered Cascade)
  console.log("[5] Executing Ordered Cascade Deletion...");

  // 5a. Delete test messages
  if (safeMessagesToDelete.length > 0) {
    const msgIds = safeMessagesToDelete.map(m => m._id);
    const msgRes = await Message.deleteMany({ _id: { $in: msgIds } });
    console.log(`    - Messages deleted: ${msgRes.deletedCount}`);
  } else {
    console.log("    - No messages to delete.");
  }

  // 5b. Delete test conversations
  if (safeConversationsToDelete.length > 0) {
    const convIds = safeConversationsToDelete.map(c => c._id);
    const convRes = await Conversation.deleteMany({ _id: { $in: convIds } });
    console.log(`    - Conversations deleted: ${convRes.deletedCount}`);
  } else {
    console.log("    - No conversations to delete.");
  }

  // 5c. Delete test matches
  if (safeMatchesToDelete.length > 0) {
    const matchIds = safeMatchesToDelete.map(m => m._id);
    const matchRes = await Match.deleteMany({ _id: { $in: matchIds } });
    console.log(`    - Matches deleted: ${matchRes.deletedCount}`);
  } else {
    console.log("    - No matches to delete.");
  }

  // 5d. Delete test swipes
  if (safeSwipesToDelete.length > 0) {
    const swipeIds = safeSwipesToDelete.map(s => s._id);
    const swipeRes = await Swipe.deleteMany({ _id: { $in: swipeIds } });
    console.log(`    - Swipes deleted: ${swipeRes.deletedCount}`);
  } else {
    console.log("    - No swipes to delete.");
  }

  // 5e. Delete test users
  const userRes = await User.deleteMany({ _id: { $in: testUserIds } });
  console.log(`    - Users deleted: ${userRes.deletedCount}`);

  // 6. Post-Cleanup Verification
  console.log("[6] Post-Cleanup Verification...");
  const remainingUsers = await User.find({}).sort({ createdAt: 1 }).lean();
  console.log(`    - Total users remaining in DB: ${remainingUsers.length} (Expected: 41)`);

  const remainingDemo = remainingUsers.filter(u => DEMO_INDIAN_USERNAMES.has(u.username?.toLowerCase()));
  const remainingGenuine = remainingUsers.filter(u => !DEMO_INDIAN_USERNAMES.has(u.username?.toLowerCase()));

  console.log(`    - Demo profiles intact: ${remainingDemo.length}/20`);
  console.log(`    - Genuine accounts intact: ${remainingGenuine.length}/21`);

  if (remainingDemo.length !== 20) {
    console.error("❌ CRITICAL: Demo profiles count is not 20!");
  } else {
    console.log("    ✅ All 20 Indian Demo profiles verified intact.");
  }

  if (remainingGenuine.length !== 21) {
    console.error("❌ CRITICAL: Genuine accounts count is not 21!");
  } else {
    console.log("    ✅ All 21 genuine accounts verified intact.");
  }

  // 7. Verify Discovery Feed Query
  console.log("[7] Simulating Discovery Feed Query for User satyam0987643...");
  const satyamUser = await User.findOne({ username: "satyam0987643" });
  if (satyamUser) {
    const userSwipes = await Swipe.find({ fromUser: satyamUser._id }).distinct("toUser");
    const excludedIds = [satyamUser._id, ...userSwipes];
    const discoveryCandidates = await User.find({
      isProfileComplete: true,
      _id: { $nin: excludedIds }
    }).select("name username gender photos isProfileComplete").lean();

    console.log(`    - Total profiles surfaced in Discovery deck: ${discoveryCandidates.length}`);
    const anyTestLeft = discoveryCandidates.filter(u => {
      const un = (u.username || "").toLowerCase();
      return (
        un.startsWith("test_") ||
        un.startsWith("testuser") ||
        un.startsWith("chat_") ||
        un.startsWith("rnd_") ||
        un.startsWith("conc_") ||
        un.startsWith("prod_test_")
      );
    });

    console.log(`    - Test accounts appearing in Discovery feed: ${anyTestLeft.length}`);
    if (anyTestLeft.length === 0) {
      console.log("    ✅ ZERO test accounts in Discovery! Clean feed achieved.");
    } else {
      console.error("    ❌ Warning: Found test accounts in Discovery feed:", anyTestLeft.map(u => u.username));
    }
  }

  console.log("================================================================================");
  console.log("CLEANUP EXECUTION COMPLETED SUCCESSFULLY");
  console.log("================================================================================");

  await mongoose.disconnect();
}

runCleanup().catch(err => {
  console.error("Execution failed:", err);
  process.exit(1);
});

