import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  url: String,
  title: String,
  metaDescription: String,
  h1: String,
  wordCount: Number,
  score: Number,
  status: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

export default mongoose.model("Report", reportSchema);