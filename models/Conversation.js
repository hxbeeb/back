const mongoose = require("mongoose");

const ConversationSchema = new mongoose.Schema({
  members: {
    type: [String], // Array of user IDs
    required: true,
  },
  lastMessage: {
    text: String,
    timestamp: Date,
  }
}, { timestamps: true });

module.exports = mongoose.model("Conversation", ConversationSchema);
