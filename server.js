const express = require("express");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const multer = require("multer");
const socketIO = require("socket.io");
const http = require("http");
const { ClerkExpressWithAuth, getAuth,Clerk  } = require("@clerk/clerk-sdk-node");
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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
  origin: ["http://localhost:5173", "https://wave-link.netlify.app"],
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
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});
const S3_BUCKET = process.env.S3_BUCKET;

// Socket.io
const io = socketIO(server, {
  cors: {
    origin: ["http://localhost:5173","https://wave-link.netlify.app"],
    credentials: true,
  },
});
const users = {}; 
io.on("connection", (socket) => {
  console.log("New client connected");

  // ✅ Register user with their userId
  socket.on("register", (userId) => {
    users[userId] = socket.id;
    console.log(`Registered user ${userId} with socket ${socket.id}`);
  });

  // ✅ Video/Audio Call Events
  socket.on("offer", ({ to, offer, type, fromUserId }) => {
    const targetSocket = users[to];
    console.log(`[OFFER] from ${fromUserId} to ${to} (socket: ${targetSocket})`);
    if (targetSocket) {
      io.to(targetSocket).emit("offer", { fromUserId, offer, type });
    } else {
      console.log(`[OFFER] Target user ${to} not connected`);
    }
  });

 socket.on("answer", ({ to, answer }, callback) => {
  const targetSocket = users[to];
  console.log("target"+to);
  if (targetSocket) {
    io.to(targetSocket).emit("answer", { answer });
    callback?.({ success: true }); // ✅ This is required for client ack to resolve
  } else {
    callback({ error: "User not found" }); // ✅ Reject on client side
  }
});


// Make sure your server properly relays ICE candidates
socket.on('ice-candidate', (data) => {
  const { to, from, candidate } = data;
  
  if (!to || !from || !candidate) {
    console.error('Invalid ICE candidate data');
    return;
  }

  // Look up socket IDs from user IDs
  const toSocket = users[to];
  const fromSocket = users[from];

  if (!toSocket || !fromSocket) {
    console.error('One or both users not connected');
    return;
  }

  console.log(`Relaying ICE candidate from ${from} to ${to}`);
  io.to(toSocket).emit('ice-candidate', { 
    from, 
    candidate 
  });
});
socket.on("call-rejected", ({ to }) => {
 const targetSocket = users[to];
    if (targetSocket) {
      io.to(targetSocket).emit("end-call");
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
    console.log("room joined");
  });


  socket.on("send_message", (data) => {
    io.to(data.conversationId).emit("receive_message", data);
    console.log("sending msgg");
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

// Replace the /messages/file route with S3 upload
app.post('/messages/file', upload.single('file'), async (req, res) => {
  try {
    const { conversationId, senderId } = req.body;
    const file = req.file;
    const s3Key = Date.now() + '-' + file.originalname;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: file.buffer,
      ContentType: file.mimetype
    }));
    const fileUrl = `/files/${encodeURIComponent(s3Key)}`;

    // Save the message in MongoDB
    const message = new Message({
      conversationId,
      senderId,
      text: file.originalname, // or any text you want
      fileUrl, // <-- store the S3 file URL
    });
    await message.save();

    res.status(201).json(message);
  } catch (err) {
    console.error('S3 upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Route to get a pre-signed URL for a file
app.get('/files/:key', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour
    res.redirect(url);
  } catch (err) {
    console.error('Error generating signed URL:', err);
    res.status(404).send('File not found');
  }
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
