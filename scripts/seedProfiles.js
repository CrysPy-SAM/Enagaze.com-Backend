import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../src/models/user.model.js";

// Ensure .env loads properly
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const DEFAULT_PASSWORD = "Engaze@2026";

/**
 * 20 High-Quality Indian Dummy Profiles (10 Girls, 10 Boys — 1:1 Ratio)
 * Realistic names, bios, DOB (ages 23–28), interests, and Unsplash portrait URLs.
 */
const DUMMY_PROFILES = [
  // ==========================================
  // 10 FEMALE PROFILES (GIRLS)
  // ==========================================
  {
    name: "Ananya Sharma",
    username: "ananya_sharma",
    gender: "female",
    dob: new Date("2002-04-12"), // Age ~24
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 21, max: 35 }
    },
    bio: "Architect based in South Delhi ☕ Coffee enthusiast, watercolor painter, and spontaneous road-tripper. Tell me your favorite indie song!",
    photos: [
      "https://images.unsplash.com/photo-1617627143750-d86bc21e42bb?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Art 🎨", "Coffee ☕", "Music 🎵", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Priya Patel",
    username: "priya_patel",
    gender: "female",
    dob: new Date("2001-08-23"), // Age ~25
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 22, max: 36 }
    },
    bio: "Product designer in Mumbai 🏙️ Chai lover, classical dance enthusiast, and always hunting for the best street food in town.",
    photos: [
      "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Foodie 🍕", "Coffee ☕", "Art 🎨", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Diya Sen",
    username: "diya_sen",
    gender: "female",
    dob: new Date("2003-02-14"), // Age ~23
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 21, max: 32 }
    },
    bio: "Journalism grad & bookworm 📚 Weekend baker and vinyl record collector. Looking for great conversations over matcha or hot chocolate.",
    photos: [
      "https://images.unsplash.com/photo-1621784563330-caee0b138a00?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Books 📚", "Music 🎵", "Foodie 🍕", "Movies 🎬"],
    isProfileComplete: true
  },
  {
    name: "Sneha Reddy",
    username: "sneha_reddy",
    gender: "female",
    dob: new Date("2000-11-05"), // Age ~26
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 23, max: 36 }
    },
    bio: "Tech lead in Hyderabad 💻 Pilates regular, sunset chaser, and lover of South Indian filter kaapi. Swipe right if you can keep up on a trek!",
    photos: [
      "https://images.unsplash.com/photo-1583391733956-3750e0ff4e8b?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Fitness 🏋️", "Hiking 🏔️", "Coffee ☕", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Ishita Verma",
    username: "ishita_verma",
    gender: "female",
    dob: new Date("2002-09-18"), // Age ~24
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 21, max: 34 }
    },
    bio: "Fashion stylist & dog mom 🐾 Living between Gurgaon and Jaipur. I believe a good cup of masala chai can solve most life problems.",
    photos: [
      "https://images.unsplash.com/photo-1594744803329-e58b31de8bf5?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1519699047748-de8e457a634e?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Photography 📷", "Art 🎨", "Travel ✈️", "Music 🎵"],
    isProfileComplete: true
  },
  {
    name: "Riya Kapoor",
    username: "riya_kapoor",
    gender: "female",
    dob: new Date("2001-06-30"), // Age ~25
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 22, max: 35 }
    },
    bio: "Marketing strategist & amateur baker 🧁 Big fan of 90s Bollywood rom-coms, live acoustic gigs, and pasta nights.",
    photos: [
      "https://images.unsplash.com/photo-1614283233556-f35b0c801ef1?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1607746882042-944635dfe10e?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Movies 🎬", "Foodie 🍕", "Music 🎵", "Books 📚"],
    isProfileComplete: true
  },
  {
    name: "Meera Nair",
    username: "meera_nair",
    gender: "female",
    dob: new Date("1999-03-21"), // Age ~27
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 24, max: 37 }
    },
    bio: "Kerala roots, Bangalore living 🌴 Yoga instructor & wildlife photographer. Looking for someone genuine to explore hills and beaches with.",
    photos: [
      "https://images.unsplash.com/photo-1609505848912-b7c3b8b4beda?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Yoga 🧘", "Photography 📷", "Hiking 🏔️", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Tanvi Deshmukh",
    username: "tanvi_deshmukh",
    gender: "female",
    dob: new Date("2003-07-09"), // Age ~23
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 21, max: 32 }
    },
    bio: "Biotech researcher in Pune 🔬 Loves board games, rooftop cafes, and late night discussions on sci-fi and philosophy.",
    photos: [
      "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Gaming 🎮", "Books 📚", "Coffee ☕", "Movies 🎬"],
    isProfileComplete: true
  },
  {
    name: "Pooja Joshi",
    username: "pooja_joshi",
    gender: "female",
    dob: new Date("2000-12-11"), // Age ~26
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 23, max: 36 }
    },
    bio: "Corporate lawyer by day, pottery enthusiast on weekends. Love jazz, craft beer, and finding hidden gem bookstores.",
    photos: [
      "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Art 🎨", "Books 📚", "Coffee ☕", "Music 🎵"],
    isProfileComplete: true
  },
  {
    name: "Kavya Iyer",
    username: "kavya_iyer",
    gender: "female",
    dob: new Date("2002-10-27"), // Age ~24
    datingPreferences: {
      interestedIn: ["male", "everyone"],
      ageRange: { min: 21, max: 34 }
    },
    bio: "UI/UX Designer in Chennai 🎨 Obsessed with typography, carnatic fusion music, and seaside morning jogs. Let's trade Spotify playlists.",
    photos: [
      "https://images.unsplash.com/photo-1548142813-c348350df52b?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1502685104226-ee32379fefbe?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Music 🎵", "Art 🎨", "Fitness 🏋️", "Coffee ☕"],
    isProfileComplete: true
  },

  // ==========================================
  // 10 MALE PROFILES (BOYS)
  // ==========================================
  {
    name: "Aarav Mehta",
    username: "aarav_mehta",
    gender: "male",
    dob: new Date("2001-05-19"), // Age ~25
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 21, max: 33 }
    },
    bio: "Fintech analyst in Mumbai 📈 Weekend guitarist, marathon runner, and amateur pizza maker. Seeking good vibes and meaningful connections.",
    photos: [
      "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Music 🎵", "Fitness 🏋️", "Foodie 🍕", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Rohan Gupta",
    username: "rohan_gupta",
    gender: "male",
    dob: new Date("2000-03-15"), // Age ~26
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 22, max: 35 }
    },
    bio: "Software engineer in Bengaluru ☕ Coding by day, jamming on keyboards by night. Big fan of stand-up comedy and spontaneous road trips.",
    photos: [
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Gaming 🎮", "Music 🎵", "Coffee ☕", "Movies 🎬"],
    isProfileComplete: true
  },
  {
    name: "Kabir Malhotra",
    username: "kabir_malhotra",
    gender: "male",
    dob: new Date("1999-08-04"), // Age ~27
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 22, max: 35 }
    },
    bio: "Brand consultant in Delhi NCR 🎙️ Loves cold brew, tennis, indie films, and exploring quaint heritage streets. Let's find the best dim sum.",
    photos: [
      "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Foodie 🍕", "Coffee ☕", "Movies 🎬", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Vikram Singhania",
    username: "vikram_singhania",
    gender: "male",
    dob: new Date("1998-11-20"), // Age ~28
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 23, max: 36 }
    },
    bio: "Entrepreneur & motorsport enthusiast 🏎️ Always building something new. Love high-altitude Himalayan treks and dark roast coffee.",
    photos: [
      "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Hiking 🏔️", "Fitness 🏋️", "Coffee ☕", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Aditya Rao",
    username: "aditya_rao",
    gender: "male",
    dob: new Date("2002-01-30"), // Age ~24
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 21, max: 33 }
    },
    bio: "Photographer & documentary maker 📸 Capturing candid moments across India. Lover of sunset beaches, old rock records, and filter chai.",
    photos: [
      "https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1499996860823-5214fcc65f8f?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Photography 📷", "Art 🎨", "Music 🎵", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Siddharth Roy",
    username: "siddharth_roy",
    gender: "male",
    dob: new Date("2000-09-14"), // Age ~26
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 22, max: 35 }
    },
    bio: "Product manager in Kolkata/Gurgaon 🚀 Avid chess player, street food explorer, and dog whisperer. Always down for good sushi or biryani.",
    photos: [
      "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1527980965255-d3b416303d12?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Foodie 🍕", "Gaming 🎮", "Books 📚", "Travel ✈️"],
    isProfileComplete: true
  },
  {
    name: "Arjun Khanna",
    username: "arjun_khanna",
    gender: "male",
    dob: new Date("2001-07-22"), // Age ~25
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 21, max: 34 }
    },
    bio: "Fitness coach & nutrition buff 🏋️ Passionate about calisthenics, EDM festivals, and cooking authentic Punjabi food on Sundays.",
    photos: [
      "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Fitness 🏋️", "Foodie 🍕", "Music 🎵", "Yoga 🧘"],
    isProfileComplete: true
  },
  {
    name: "Dev Choudhary",
    username: "dev_choudhary",
    gender: "male",
    dob: new Date("2001-12-08"), // Age ~25
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 21, max: 34 }
    },
    bio: "Environmental scientist & trek leader 🌲 Based in Dehradun. Coffee over tea, mountains over beaches, and campfire stories over loud clubs.",
    photos: [
      "https://images.unsplash.com/photo-1508341591423-4347099e1f19?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Hiking 🏔️", "Travel ✈️", "Books 📚", "Photography 📷"],
    isProfileComplete: true
  },
  {
    name: "Varun Bhatia",
    username: "varun_bhatia",
    gender: "male",
    dob: new Date("2000-04-03"), // Age ~26
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 22, max: 35 }
    },
    bio: "Data scientist in Pune 📊 Trivia buff, jazz enthusiast, and aspiring cocktail mixologist. Tell me a fun fact I probably don't know!",
    photos: [
      "https://images.unsplash.com/photo-1520813792240-56fc4a3765a7?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1537151608828-ea2b11777ee8?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Music 🎵", "Books 📚", "Coffee ☕", "Gaming 🎮"],
    isProfileComplete: true
  },
  {
    name: "Kunal Nair",
    username: "kunal_nair",
    gender: "male",
    dob: new Date("1999-01-17"), // Age ~27
    datingPreferences: {
      interestedIn: ["female", "everyone"],
      ageRange: { min: 22, max: 36 }
    },
    bio: "Graphic designer & indie comic creator 🎨 Kochi → Bengaluru. Love synthwave, vintage movie posters, and artisanal ramen.",
    photos: [
      "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=800&q=80"
    ],
    interests: ["Art 🎨", "Movies 🎬", "Music 🎵", "Foodie 🍕"],
    isProfileComplete: true
  }
];

async function seedProfiles() {
  console.log("==================================================");
  console.log("  ENGAZE.COM — SEEDING DUMMY INDIAN PROFILES      ");
  console.log("==================================================");

  if (!process.env.MONGO_URI) {
    console.error("❌ Error: MONGO_URI is missing in .env");
    process.exit(1);
  }

  try {
    console.log("⏳ Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected successfully to MongoDB.");

    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    console.log(`🔐 Generated bcrypt hash for default dummy password: "${DEFAULT_PASSWORD}"`);

    let createdCount = 0;
    let updatedCount = 0;

    const femaleCount = DUMMY_PROFILES.filter(p => p.gender === "female").length;
    const maleCount = DUMMY_PROFILES.filter(p => p.gender === "male").length;

    console.log(`📋 Total dummy profiles to process: ${DUMMY_PROFILES.length}`);
    console.log(`   - Girls (Female): ${femaleCount}`);
    console.log(`   - Boys (Male):    ${maleCount}`);
    console.log(`   - Ratio:          ${femaleCount}:${maleCount} (50:50 Exact Same Ratio)\n`);

    for (const profile of DUMMY_PROFILES) {
      const existing = await User.findOne({ username: profile.username });

      if (existing) {
        // Update existing dummy profile so it stays fresh and complete
        existing.name = profile.name;
        existing.gender = profile.gender;
        existing.dob = profile.dob;
        existing.datingPreferences = profile.datingPreferences;
        existing.bio = profile.bio;
        existing.photos = profile.photos;
        existing.interests = profile.interests;
        existing.isProfileComplete = profile.isProfileComplete;
        existing.password = hashedPassword;
        await existing.save();

        console.log(`🔄 Updated [${profile.gender.toUpperCase()}]: ${profile.name} (@${profile.username})`);
        updatedCount++;
      } else {
        // Insert new dummy profile
        const newUser = new User({
          ...profile,
          password: hashedPassword
        });
        await newUser.save();

        console.log(`✨ Created [${profile.gender.toUpperCase()}]: ${profile.name} (@${profile.username})`);
        createdCount++;
      }
    }

    console.log("\n==================================================");
    console.log("🎉 SEEDING COMPLETED SUCCESSFULLY!");
    console.log(`   New Profiles Created: ${createdCount}`);
    console.log(`   Profiles Updated:     ${updatedCount}`);
    console.log(`   Total Profiles:       ${DUMMY_PROFILES.length}`);
    console.log(`   Girls: ${femaleCount} | Boys: ${maleCount} (Equal Ratio)`);
    console.log(`   Default Login Password: ${DEFAULT_PASSWORD}`);
    console.log("==================================================");

  } catch (error) {
    console.error("❌ Seeding failed with error:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB disconnected.");
  }
}

seedProfiles();

