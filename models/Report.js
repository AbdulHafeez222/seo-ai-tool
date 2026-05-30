import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  url: String,
  title: String,
  metaDescription: String,
  h1: String,
  wordCount: Number,
  score: Number,
  status: String,
  tips: Array
}, { timestamps: true });

export default mongoose.model("Report", reportSchema);
