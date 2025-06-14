const express = require("express");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const session = require("express-session");
const passport = require("passport");
const cors = require("cors");
const User = require("./models/User");
const Conversation = require("./models/Conversation");
const Message = require("./models/Message");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require('multer');
// const upload = multer({ dest: 'uploads/' });
// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Middleware
app.use(cors({
  origin: ["http://localhost:5173","https://684cf29ef12af9e6cadbdc0d--magical-pavlova-ea008c.netlify.app"],
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: "your_secret",
  resave: false,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  }
};
connectDB();
app.use('/uploads', express.static('uploads'));
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Make sure this directory exists
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// Passport Configuration
passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});
passport.use(new GoogleStrategy({
  clientID: process.env.client_id,
  clientSecret: process.env.client_secret,
  callbackURL: "/auth/google/callback"
},
  async (accessToken, refreshToken, profile, cb) => {
    try {
      const existingUser = await User.findOne({ email: profile.emails[0].value });
      if (existingUser) return cb(null, existingUser);

      const newUser = new User({
        name: profile.displayName,
        email: profile.emails[0].value,
        image: profile.photos[0].value
      });
      await newUser.save();
      cb(null, newUser);
    } catch (err) {
      cb(err, null);
    }
  }
));

// Routes
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("https://684cf29ef12af9e6cadbdc0d--magical-pavlova-ea008c.netlify.app/chat");
    // res.redirect("http://localhost:5173/chat");
  }
);
app.get("/me", (req, res) => {
  if (req.isAuthenticated()) {
    res.json(req.user);
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});
app.get("/users", async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Chat System

// Create/Get Conversation between 2 users
app.post("/conversations", async (req, res) => {
  const { senderId, receiverId } = req.body;
  if (!senderId || !receiverId) return res.status(400).json({ error: "Missing senderId or receiverId" });

  try {
    let convo = await Conversation.findOne({ members: { $all: [senderId, receiverId] } });
    console.log("found");

    if (!convo) {
      convo = new Conversation({ members: [senderId, receiverId] });
      await convo.save();
    }

    res.status(200).json(convo);
  } catch (err) {
    res.status(500).json({ error: "Failed to get or create conversation" });
  }
});

// Get all conversations for a user
app.get("/conversations/:userId", async (req, res) => {
  try {
    const conversations = await Conversation.find({
      members: { $in: [req.params.userId] }
    });

    const enrichedConversations = await Promise.all(conversations.map(async (convo) => {
      const otherUserId = convo.members.find(id => id !== req.params.userId);
      const otherUser = await User.findById(otherUserId).select("name image");
      return {
        ...convo.toObject(),
        user: otherUser,
      };
    }));

    res.json(enrichedConversations);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});


// Send a message
app.post("/messages", async (req, res) => {
  const { conversationId, senderId, text } = req.body;

  if (!conversationId || !senderId || !text) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (
    !mongoose.Types.ObjectId.isValid(conversationId) ||
    !mongoose.Types.ObjectId.isValid(senderId)
  ) {
    return res.status(400).json({ error: "Invalid conversationId or senderId" });
  }

  try {
    console.log("conversationId:", conversationId);
    console.log("senderId:", senderId);
    console.log("text:", text);
   

    const message = new Message({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      senderId: new mongoose.Types.ObjectId(senderId),
      text
    });

    console.log("savinggg");
    await message.save();
    console.log("✅ saved message");

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: { text, timestamp: new Date() }
    });

    res.status(201).json(message);
  } catch (err) {
    console.error("❌ Error while saving message:", err);
    res.status(500).json({ error: "Failed to send message", details: err.message });
  }
});

// Get messages of a conversation
app.get("/messages/:conversationId", async (req, res) => {
  try {
    const messages = await Message.find({ conversationId: req.params.conversationId });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});




app.post('/messages/file', upload.single('file'), async (req, res) => {
  const { conversationId, senderId } = req.body;
  const file = req.file;

  if (!conversationId || !senderId || !file) {
    return res.status(400).json({ error: 'Missing data or file' });
  }

  const message = new Message({
    conversationId,
    senderId,
    text: `${file.originalname}`,
    fileUrl: `/uploads/${file.filename}`, // Save URL
  });

  await message.save();
  res.status(201).json(message);
});
// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
