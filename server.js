import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

import { getAIReport } from "./aiService.js";
import Report from "./models/Report.js";

// ---------------- APP ----------------
const app = express();
const PORT = process.env.PORT || 4000;

// __dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- MIDDLEWARE ----------------
app.use(cors({ origin: "*" }));
app.use(express.json());

// ---------------- ENV CHECK ----------------
console.log("API KEY:", process.env.GEMINI_API_KEY);

// ---------------- DB CONNECT ----------------
mongoose.set("strictQuery", false);

mongoose.connect(process.env.MONGO_URL)
  .then(() => {
    console.log("MongoDB Connected ✅");

    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
    });

  })
  .catch(err => {
    console.log("MongoDB Error:", err);
  });

// ---------------- SEO ROUTE ----------------
app.get("/", async (req, res) => {

  let url = req.query.url;

  if (!url) {
    return res.json({ error: "Please provide URL" });
  }

  try {

    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(response.data);

    const title = $("title").text();
    const h1 = $("h1").first().text();
    const metaDescription = $('meta[name="description"]').attr("content") || "";

    const text = $("body").text();
    const wordCount = text.trim().split(/\s+/).length;

    // ---------------- SCORE ----------------
    let score = 0;

    if (title.length > 5) score += 20;
    if (h1) score += 20;
    if (metaDescription.length > 50) score += 20;
    if (wordCount > 300) score += 20;
    if (wordCount > 1000) score += 20;

    if (score > 100) score = 100;

    let status =
      score >= 80 ? "Excellent SEO" :
      score >= 50 ? "Good SEO" :
      "Poor SEO";

    let tips = [];

    if (!title) tips.push("Add title");
    if (!h1) tips.push("Add H1");
    if (!metaDescription) tips.push("Add meta description");

    // ---------------- AI REPORT (FIXED) ----------------
    let aiReport = "";

    try {
      if (getAIReport) {
        aiReport = await getAIReport({
          url,
          title,
          metaDescription,
          wordCount,
          score
        });
      }
    } catch (e) {
      aiReport = "AI report not available";
    }

    // ---------------- SAVE ----------------
    await Report.create({
      url,
      title,
      h1,
      metaDescription,
      wordCount,
      score,
      status,
      tips,
      aiReport
    });

    // ---------------- RESPONSE ----------------
    res.json({
      url,
      title,
      h1,
      metaDescription,
      wordCount,
      score,
      status,
      tips,
      aiReport
    });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ---------------- HISTORY ROUTE ----------------
app.get("/history", async (req, res) => {
  try {
    const data = await Report.find().sort({ createdAt: -1 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "History fetch failed" });
  }
});
