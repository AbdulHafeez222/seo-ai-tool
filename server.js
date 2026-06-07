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
console.log("OpenRouter Loaded");

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

    // Validate URL first
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch(e) {
      return res.json({ error: "Invalid URL format" });
    }

    const baseUrl = new URL(url).origin;

    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const $ = cheerio.load(response.data);

    // Remove script/style tags before word count
    $('script, style, noscript, svg').remove();

    // ---------------- BASIC DATA ----------------
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const metaDescription = $('meta[name="description"]').attr("content") || "";

    // Better keywords with stop words filter
    const stopWords = ['with','from','your','this','that','about','after','have','will','into','which','their'];
    const keywords = title
   .toLowerCase()
   .replace(/[^\w\s]/g,'')
   .split(" ")
   .filter(word => word.length > 3 &&!stopWords.includes(word))
   .slice(0, 5);

    const text = $("body").text();
    const wordCount = text? text.trim().split(/\s+/).filter(Boolean).length : 0;

    const links = $("a").length;

    // ---------------- IMAGES ALT CHECK ----------------
    const images = $("img");
    const totalImages = images.length;
    let imagesWithoutAlt = 0;

    images.each((i, img) => {
      const alt = $(img).attr("alt");
      if (!alt || alt.trim() === "") {
        imagesWithoutAlt++;
      }
    });

    const h2 = $("h2").length;
    const canonical = $('link[rel="canonical"]').attr("href");
    const viewport = $('meta[name="viewport"]').attr("content");

    // ---------------- OPEN GRAPH TAGS CHECK ----------------
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const ogDescription = $('meta[property="og:description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || "";
    const hasOGTags =!!ogTitle &&!!ogDescription &&!!ogImage;

    // ---------------- ROBOTS.TXT CHECK ----------------
    let robotsExists = false;
    try {
      const robots = await axios.get(`${baseUrl}/robots.txt`, {
        timeout: 5000,
        validateStatus: status => status < 500
      });
      if (robots.status === 200) {
        robotsExists = true;
      }
    } catch(e) {}

    // ---------------- SITEMAP.XML CHECK ----------------
    let sitemapExists = false;
    try {
      const sitemap = await axios.get(`${baseUrl}/sitemap.xml`, {
        timeout: 5000,
        validateStatus: status => status < 500
      });
      if (sitemap.status === 200) {
        sitemapExists = true;
      }
    } catch(e) {}

    // Fixed internal/external links logic
    const internalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href");
      return href && (href.startsWith("/") || href.includes(hostname));
    }).length;

    const externalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href");
      return href && href.startsWith("http") &&!href.includes(hostname);
    }).length;

    // ---------------- AEO CHECKS ----------------
    const schemas = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        const type = json['@type'] || json['@graph']?.[0]?.['@type'];
        if(type) schemas.push(type);
      } catch(e) {}
    });

    const hasFAQ = schemas.includes('FAQPage');
    const hasHowTo = schemas.includes('HowTo');
    const hasArticle = schemas.includes('Article') || schemas.includes('BlogPosting');
    const hasSpeakable = schemas.includes('SpeakableSpecification');

    // Direct Answer Pattern: H2 ke baad 40-60 words ka para
    let hasDirectAnswer = false;
    $('h2').each((i, el) => {
      const nextP = $(el).next('p').text().trim();
      const words = nextP.split(/\s+/).filter(Boolean).length;
      if(words >= 40 && words <= 60) hasDirectAnswer = true;
    });

    const lastModified = $('meta[property="article:modified_time"]').attr('content') ||
                         $('meta[property="article:published_time"]').attr('content') ||
                         $('time').attr('datetime') || null;

    // ---------------- ISSUES ----------------
    let issues = [];

    if (!title) issues.push("Missing title tag");
    if (!metaDescription) issues.push("Missing meta description");
    if (!h1) issues.push("Missing H1 tag");
    if (imagesWithoutAlt > 0) {
      issues.push(`${imagesWithoutAlt} out of ${totalImages} images are missing ALT text`);
    }
    if (!canonical) issues.push("Missing canonical URL");
    if (wordCount < 300) issues.push("Thin content - less than 300 words");
    if (!viewport) issues.push("Website is not mobile optimized");
    if (!robotsExists) issues.push("robots.txt not found - AI crawlers may get blocked");
    if (!sitemapExists) issues.push("sitemap.xml not found - Google indexing will be slow");
    if (!hasOGTags) {
      issues.push("Open Graph tags missing - Poor social media sharing");
    }

    // AEO Issues
    if(!hasFAQ) issues.push("Missing FAQ Schema - ChatGPT won't quote you");
    if(!hasHowTo) issues.push("Missing HowTo Schema - No step-by-step answers for AI");
    if(!hasDirectAnswer) issues.push("No direct answer under H2 - Missing featured snippet");
    if(!lastModified) issues.push("No last updated date - AI prefers fresh content");

    if (issues.length === 0) {
      issues.push("No major SEO issues found");
    }

    // ---------------- SEO SCORE ----------------
    let score = 0;

    if (title.length > 10 && title.length < 70) score += 15;
    if (metaDescription.length > 80 && metaDescription.length < 160) score += 15;
    if (h1) score += 10;
    if (h2 > 0) score += 5;
    if (wordCount > 500) score += 15;
    if (links > 5) score += 10;
    if (totalImages > 0 && imagesWithoutAlt < totalImages) score += 10;
    if (canonical) score += 10;
    if (wordCount > 1000) score += 10;
    if (viewport) score += 10;
    if (robotsExists) score += 5;
    if (sitemapExists) score += 5;
    if (hasOGTags) score += 5; // <-- FIX: Pehle +5 phir cap karo

    if (score > 100) score = 100;

    let status =
      score >= 80? "Excellent SEO" :
      score >= 50? "Good SEO" :
      "Poor SEO";

    // ---------------- AEO SCORE ----------------
    let aeoScore = 0;
    if(hasFAQ) aeoScore += 25;
    if(hasHowTo) aeoScore += 20;
    if(hasDirectAnswer) aeoScore += 20;
    if(hasArticle) aeoScore += 15;
    if(lastModified) aeoScore += 10;
    if(hasSpeakable) aeoScore += 10;
    if(sitemapExists) aeoScore += 5;

    let aeoStatus =
      aeoScore >= 80? "AEO Ready - ChatGPT Will Quote You" :
      aeoScore >= 50? "Partial AEO - Needs Schema" :
      "Not AEO Ready - Only Old SEO";

    // ---------------- TIPS ----------------
    let tips = [];

    if (!title) tips.push("Add title tag 50-60 characters");
    if (!h1) tips.push("Add one H1 tag with main keyword");
    if (!metaDescription) tips.push("Add meta description 120-155 characters");
    if (imagesWithoutAlt > 0) tips.push(`Add ALT text to ${imagesWithoutAlt} images for better SEO & accessibility`);
    if (!robotsExists) tips.push("Create robots.txt to allow AI crawlers like GPTBot");
    if (!sitemapExists) tips.push("Add sitemap.xml and submit to Google Search Console");
    if (!hasFAQ) tips.push("Add FAQ Schema to get quoted by ChatGPT");
    if (!hasDirectAnswer) tips.push("Add 40-60 word paragraph right after H2");
    if (wordCount < 500) tips.push("Increase content to 800+ words");
    if (!hasOGTags) {
      tips.push("Add Open Graph tags for better Facebook, LinkedIn and social sharing previews");
    }

    // ---------------- AI REPORT ----------------
    let aiReport = "";

    try {
      if (typeof getAIReport === "function") {
        aiReport = await getAIReport({
          url,
          title,
          metaDescription,
          wordCount,
          score,
          aeoScore,
          hasFAQ,
          hasDirectAnswer
        });
      }
    } catch (e) {
      console.error("AI ERROR:", e);
      aiReport = "AI report not available due to AI error";
    }

    // ---------------- SAVE - No Duplicates ----------------
    await Report.findOneAndUpdate(
      { url },
      {
        url, title, h1, metaDescription, wordCount, score, status,
        aeoScore, aeoStatus, schemas, hasFAQ, hasHowTo, hasDirectAnswer,
        robotsExists, sitemapExists, totalImages, imagesWithoutAlt,
        hasOGTags, ogTitle, ogDescription, ogImage, // <-- FIX: Add kiya
        tips, aiReport, issues, keywords, internalLinks, externalLinks,
        lastModified
      },
      { upsert: true, new: true }
    );

    // ---------------- RESPONSE ----------------
    res.json({
      url,
      title,
      h1,
      metaDescription,
      wordCount,
      score,
      status,
      aeoScore,
      aeoStatus,
      schemas,
      hasFAQ,
      hasHowTo,
      hasDirectAnswer,
      lastModified,
      robotsExists,
      sitemapExists,
      totalImages,
      imagesWithoutAlt,
      hasOGTags, // <-- FIX: Add kiya
      ogTitle, // <-- FIX: Add kiya
      ogDescription, // <-- FIX: Add kiya
      ogImage, // <-- FIX: Add kiya
      tips,
      aiReport,
      issues,
      keywords,
      internalLinks,
      externalLinks
    });

  } catch (error) {
    console.error("Analyze Error:", error);
    if(error.code === 'ECONNABORTED'){
      return res.json({ error: "Website took too long to respond. Timeout 15s" });
    }
    if(error.response?.status === 404){
      return res.json({ error: "URL not found - 404" });
    }
    if(error.response?.status === 403){
      return res.json({ error: "Website blocked the request - 403 Forbidden" });
    }
    res.json({ error: "Failed to analyze: " + error.message });
  }
});

// ---------------- HISTORY ----------------
app.get("/history", async (req, res) => {
  try {
    const data = await Report.find().sort({ createdAt: -1 }).limit(50);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "History fetch failed" });
  }
});
