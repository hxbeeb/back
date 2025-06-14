const { Schema, model } = require("mongoose");

const userSchema=new Schema({
 name:{
    type:String,
    required:true,
    trim:true
 },
 email:{
   type:String,
   required:true,
   unique:true,
   lowercase:true
 },
 image:{
   type:String,
   default:""
 },
 
 createdAt:{
   type:Date,default:Date.now
 }
 
});


module.exports=model('User',userSchema);