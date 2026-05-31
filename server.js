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
import Report from "./models/report.js";

// ---------------- APP ----------------
const app = express();
const PORT = process.env.PORT || 4000;

// __dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- MIDDLEWARE ----------------
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------- ENV CHECK ----------------
console.log("API KEY LOADED");

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

// ---------------- HOME ROUTE ----------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------- SEO ANALYZE ROUTE ----------------
app.get("/analyze", async (req, res) => {

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

    // ---------------- BASIC DATA ----------------
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const metaDescription =
      $('meta[name="description"]').attr("content") || "";

    const text = $("body").text();
    const wordCount = text ? text.trim().split(/\s+/).length : 0;

    const links = $("a").length;
    const images = $("img").length;
    const imagesWithoutAlt = $("img").filter((i, el) => !$(el).attr("alt")).length;

    const h2 = $("h2").length;
    const canonical = $('link[rel="canonical"]').attr("href");

    // ---------------- ISSUES ----------------
    let issues = [];

    if (!title) issues.push("Missing title tag");
    if (!metaDescription) issues.push("Missing meta description");
    if (!h1) issues.push("Missing H1 tag");
    if (imagesWithoutAlt > 0) issues.push("Images missing alt text");
    if (!canonical) issues.push("Missing canonical URL");
    if (wordCount < 300) issues.push("Thin content");

    if (issues.length === 0) {
      issues.push("No major SEO issues found");
    }

    // ---------------- SCORE ----------------
    let score = 0;

    if (title.length > 10 && title.length < 70) score += 15;
    if (metaDescription.length > 80 && metaDescription.length < 160) score += 15;
    if (h1) score += 10;
    if (h2 > 0) score += 5;
    if (wordCount > 500) score += 15;
    if (links > 5) score += 10;
    if (images > 0 && imagesWithoutAlt < images) score += 10;
    if (canonical) score += 10;
    if (wordCount > 1000) score += 10;

    if (score > 100) score = 100;

    let status =
      score >= 80 ? "Excellent SEO" :
      score >= 50 ? "Good SEO" :
      "Poor SEO";

    // ---------------- TIPS ----------------
    let tips = [];

    if (!title) tips.push("Add title");
    if (!h1) tips.push("Add H1");
    if (!metaDescription) tips.push("Add meta description");

    // ---------------- AI REPORT ----------------
    let aiReport = "";

    try {
      if (typeof getAIReport === "function") {
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
      aiReport,
      issues
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
      aiReport,
      issues
    });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ---------------- HISTORY ----------------
app.get("/history", async (req, res) => {
  try {
    const data = await Report.find().sort({ createdAt: -1 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "History fetch failed" });
  }
});
