const express = require("express");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const multer = require("multer");
const socketIO = require("socket.io");
const http = require("http");
const { ClerkExpressWithAuth, getAuth,Clerk  } = require("@clerk/clerk-sdk-node");

const User = require("./models/User");
const Conversation = require("./models/Conversation");
const Message = require("./models/Message");

dotenv.config();
const clerk = new Clerk({ secretKey: process.env.CLERK_SECRET_KEY });
const app = express();
const server = http.createServer(app);

// Clerk middleware
app.use(
  ClerkExpressWithAuth({
    secretKey: process.env.CLERK_SECRET_KEY,
  })
);

// Middleware
app.use(cors({
  origin: ["http://localhost:5173", "https://magical-pavlova-ea008c.netlify.app"],
  credentials: true
}));
app.use(express.json());

app.use(session({
  secret: "your_secret",
  resave: false,
  saveUninitialized: true
}));

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

// Multer for file uploads
app.use('/uploads', express.static('uploads'));
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// Socket.io
const io = socketIO(server, {
  cors: {
    origin: ["http://localhost:5173", "https://sike-chat.netlify.app"],
    credentials: true,
  },
});

const users = {}; // Mapping of userId → socketId

io.on("connection", (socket) => {
  console.log("New client connected");

  // ✅ Register user with their userId
  socket.on("register", (userId) => {
    users[userId] = socket.id;
    console.log(`Registered user ${userId} with socket ${socket.id}`);
  });

  // ✅ Video/Audio Call Events
  socket.on("offer", ({ to, offer, type }) => {
    const targetSocket = users[to];
    if (targetSocket) {
      io.to(targetSocket).emit("offer", { from: socket.id, offer, type });
    }
  });

  socket.on("answer", ({ to, answer }) => {
    const targetSocket = users[to];
    if (targetSocket) {
      io.to(targetSocket).emit("answer", { from: socket.id, answer });
    }
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    const targetSocket = users[to];
    if (targetSocket) {
      io.to(targetSocket).emit("ice-candidate", { from: socket.id, candidate });
    }
  });

  socket.on("end-call", ({ to }) => {
    const targetSocket = users[to];
    if (targetSocket) {
      io.to(targetSocket).emit("end-call");
    }
  });

  // ✅ Messaging (Unchanged)
  socket.on("join_conversation", (room) => {
    socket.join(room);
  });

  socket.on("send_message", (data) => {
    io.to(data.conversationId).emit("receive_message", data);
  });

  // ✅ Cleanup on disconnect
  socket.on("disconnect", () => {
    for (let userId in users) {
      if (users[userId] === socket.id) {
        delete users[userId];
        console.log(`User ${userId} disconnected`);
        break;
      }
    }
    console.log("Client disconnected");
  });
});


// Routes

// Clerk Authenticated user
// Clerk Authenticated user
app.get("/me", async (req, res) => {
  try {
    console.log(req.auth);
    const { userId } = req.auth;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await clerk.users.getUser(userId);
    const email = user.emailAddresses[0].emailAddress;

    // Check if user already exists in MongoDB
    let dbUser = await User.findOne({ clerkId: userId });

    if (!dbUser) {
      console.log(user.firstName+" "+user.lastName);
      // If not, create a new user
      dbUser = new User({
        clerkId: user.id,
        name: user.firstName+" "+user.lastName,
        email:email,
        image: user.imageUrl,
      });
      await dbUser.save();
    }

    res.json({
      id: dbUser._id,
      clerkId: dbUser.clerkId,
      name: dbUser.name,
      email: dbUser.email,
      image: dbUser.image,
    });
  } catch (error) {
    console.error("Error in /me:", error.message);
    res.status(500).json({ error: "Failed to fetch or create user" });
  }
});

// Fetch all users
app.get("/users", async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Create/Get conversation
app.post("/conversations", async (req, res) => {
  const { senderId, receiverId } = req.body;
  if (!senderId || !receiverId)
    return res.status(400).json({ error: "Missing senderId or receiverId" });

  try {
    let convo = await Conversation.findOne({ members: { $all: [senderId, receiverId] } });

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
    const message = new Message({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      senderId: new mongoose.Types.ObjectId(senderId),
      text
    });

    await message.save();

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: { text, timestamp: new Date() }
    });

    res.status(201).json(message);
  } catch (err) {
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

// File upload message
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
    fileUrl: `/uploads/${file.filename}`,
  });

  await message.save();
  res.status(201).json(message);
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
