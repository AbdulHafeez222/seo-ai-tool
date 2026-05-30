import dotenv from "dotenv";
dotenv.config();

import dns from "dns";
dns.setServers(["1.1.1.1", "8.8.8.8"]);

import mongoose from "mongoose";
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";

import { getAIReport } from "./aiService.js";
import Report from "./Report.js";

// ---------------- APP ----------------
const app = express();

// __dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- MIDDLEWARE ----------------
app.use(cors({
  origin: "*"
}));

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

// ---------------- MAIN SEO ROUTE ----------------
app.get("/", async (req, res) => {

  let url = req.query.url;

  if (!url) {
    return res.json({ error: "Please provide URL" });
  }

  try {

    // fix url
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    // fetch website
let response;

try {
  response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Encoding": "gzip, deflate, br"
    }
  });

} catch (err) {
  console.log("Axios Error:", err.message);

  return res.json({
    error: "Website fetch failed. Try another URL."
  });
}

// 
if (!response?.data || typeof response.data !== "string") {
  return res.json({
    error: "Invalid website response"
  });
}

// 
const $ = cheerio.load(response.data);
    // scrape
    const title = $("title").text() || "";
    const metaDescription =
      $('meta[name="description"]').attr("content") || "";
    const h1 = $("h1").first().text() || "";

    const text = $("body").text();
   const wordCount = text?.trim()
  ? text.trim().split(/\s+/).filter(Boolean).length
  : 0;


    let score = 0;

// TITLE
if (title.length > 5) score += 20;

// H1
if (h1) score += 20;

// META
if (metaDescription.length > 50) score += 20;

// CONTENT
if (wordCount > 300) score += 20;

// BONUS
if (wordCount > 1000) score += 20;

if (score > 100) score = 100;
    

    if (score > 100) score = 100;

    // STATUS
    let status =
      score >= 80 ? "Excellent SEO" :
      score >= 50 ? "Good SEO" :
      "Poor SEO";

    // GRADE
    let grade = "C";
    if (score >= 90) grade = "A+";
    else if (score >= 80) grade = "A";
    else if (score >= 70) grade = "B";
    else if (score >= 50) grade = "C";
    else grade = "D";

    // TIPS
    let tips = [];

    if (!title) tips.push("Add SEO title");
    if (!h1) tips.push("Add H1 tag");
    if (!metaDescription) tips.push("Add meta description");
    if (wordCount < 300) tips.push("Increase content length");

    // AI REPORT
    let aiReport = null;

    if (process.env.GEMINI_API_KEY) {
      try {
        aiReport = await getAIReport({
          title,
          h1,
          metaDescription,
          wordCount,
          score
        });
      } catch (err) {
        aiReport = "AI not available";
      }
    }

    // SAVE DB
    await Report.create({
      url,
      title,
      metaDescription,
      h1,
      wordCount,
      score,
      status,
      tips
    });

    // RESPONSE
    res.json({
      url,
      title,
      metaDescription,
      h1,
      wordCount,
      score,
      grade,
      status,
      tips,
      aiReport
    });

  } catch (error) {
    console.log("ERROR:", error.message);
    res.json({ error: error.message });
  }

});

// ---------------- UI PAGE ----------------
app.get("/ui", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------- HISTORY API ----------------
app.get("/history", async (req, res) => {
  const reports = await Report.find().sort({ createdAt: -1 });
  res.json(reports);
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
