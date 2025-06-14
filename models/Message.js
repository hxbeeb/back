const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  conversationId: {
    type: String,
    // ref: "conversations",
    required: true
  },
  senderId: {
    type: String,
    required: true
  },
  fileUrl:{type:String},
  text: {type:String,required:true},
  timestamp: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Message", MessageSchema);
