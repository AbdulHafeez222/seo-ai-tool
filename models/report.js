import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    url: String,
    title: String,
    h1: String,
    metaDescription: String,
    wordCount: Number,
    score: Number,
    status: String,
    tips: [String],
    aiReport: String
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
