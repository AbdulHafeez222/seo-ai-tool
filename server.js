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

// ---------------- HELPER FUNCTIONS ----------------
// 1. Readability Score - Flesch Reading Ease
function calculateReadability(text) {
  if (!text || text.length < 100) return { score: 0, status: "Not Enough Content" };

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const syllables = words.reduce((count, word) => count + countSyllables(word), 0);

  if (sentences === 0 || wordCount === 0) return { score: 0, status: "Not Enough Content" };

  // Flesch Reading Ease Formula
  const score = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount);
  const roundedScore = Math.max(0, Math.min(100, Math.round(score)));

  let status =
    roundedScore >= 80? "Very Easy" :
    roundedScore >= 70? "Easy" :
    roundedScore >= 60? "Fairly Easy" :
    roundedScore >= 50? "Standard" :
    roundedScore >= 30? "Difficult" : "Very Difficult";

  return { score: roundedScore, status };
}

function countSyllables(word) {
  word = word.toLowerCase();
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches? matches.length : 1;
}

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
    let isHttps = false;
    try {
      const urlObj = new URL(url);
      hostname = urlObj.hostname;
      isHttps = urlObj.protocol === 'https:';
    } catch(e) {
      return res.json({ error: "Invalid URL format" });
    }

    const baseUrl = new URL(url).origin;

    // ---------------- PAGE LOAD TIME CHECK ----------------
    const startTime = Date.now();
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const loadTime = Date.now() - startTime; // in ms

    const $ = cheerio.load(response.data);

    const canonical = $('link[rel="canonical"]').attr("href");
    const hasCanonical =!!canonical;

    // FAVICON DETECTION
    const favicon = $('link[rel="icon"]').attr("href") ||
                    $('link[rel="shortcut icon"]').attr("href") ||
                    $('link[rel="apple-touch-icon"]').attr("href");
    const hasFavicon =!!favicon;

    // Remove script/style tags before word count
    $('script, style, noscript, svg').remove();

    // ---------------- BASIC DATA ----------------
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const metaDescription = $('meta[name="description"]').attr("content") || "";

    // 2. BETTER KEYWORDS - Phrases + Stop words
    const stopWords = ['with','from','your','this','that','about','after','have','will','into','which','their','there','these','they','them','been','were','when','where','what','would','could','should'];
    const text = $("body").text();
    const cleanText = text.toLowerCase().replace(/[^\w\s]/g, ' ');

    // Single words
    const singleWords = cleanText
     .split(/\s+/)
     .filter(word => word.length > 3 &&!stopWords.includes(word));

    // 2-word phrases
    const phrases = [];
    for(let i = 0; i < singleWords.length - 1; i++) {
      const phrase = `${singleWords[i]} ${singleWords[i+1]}`;
      if(!stopWords.includes(singleWords[i]) &&!stopWords.includes(singleWords[i+1])) {
        phrases.push(phrase);
      }
    }

    // Count frequency
    const keywordCount = {};
    [...singleWords,...phrases].forEach(word => {
      keywordCount[word] = (keywordCount[word] || 0) + 1;
    });

    const keywords = Object.entries(keywordCount)
     .sort((a, b) => b[1] - a[1])
     .slice(0, 8)
     .map(([word]) => word);

    const wordCount = text? text.trim().split(/\s+/).filter(Boolean).length : 0;

    // 1. READABILITY SCORE
    const readability = calculateReadability(text);

    const links = $("a").length;

    // 3. SOCIAL MEDIA DETECTION
    let hasFacebook = false, hasLinkedIn = false, hasYouTube = false, hasTwitter = false;
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      if (href.includes("facebook.com") || href.includes("fb.com")) hasFacebook = true;
      if (href.includes("linkedin.com")) hasLinkedIn = true;
      if (href.includes("youtube.com") || href.includes("youtu.be")) hasYouTube = true;
      if (href.includes("twitter.com") || href.includes("x.com")) hasTwitter = true;
    });

    // 4. CONTACT INFO DETECTION
    const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/g;
    const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const emails = text.match(emailRegex) || [];
    const phones = text.match(phoneRegex) || [];
    const hasEmail = emails.length > 0;
    const hasPhone = phones.length > 0;
    const email = emails[0] || "";
    const phone = phones[0] || "";

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

    // ---------------- MOBILE FRIENDLY CHECK ----------------
    const viewportTag = $('meta[name="viewport"]').attr("content");
    const mobileFriendly =!!viewportTag && viewportTag.includes("width=device-width");

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

    // ---------------- BROKEN LINKS CHECK ----------------
    const allLinks = [];
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (href && href.startsWith("http") &&!href.includes('#')) {
        allLinks.push(href);
      }
    });

    // Check first 10 links only to avoid timeout
    const linksToCheck = allLinks.slice(0, 10);
    let brokenLinks = 0;
    const brokenLinksList = [];

    await Promise.all(
      linksToCheck.map(async (link) => {
        try {
          await axios.head(link, { timeout: 5000, validateStatus: s => s < 400 });
        } catch (e) {
          brokenLinks++;
          brokenLinksList.push(link);
        }
      })
    );

    // Fixed internal/external links logic
    const internalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href");
      return href && (href.startsWith("/") || href.includes(hostname));
    }).length;

    const externalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href");
      return href && href.startsWith("http") &&!href.includes(hostname);
    }).length;

    // ---------------- SCHEMA MARKUP CHECK ----------------
    const schemas = [];
    let hasSchemaMarkup = false;

    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        hasSchemaMarkup = true;
        const type = json['@type'] || json['@graph']?.[0]?.['@type'];
        if(type) schemas.push(type);
      } catch(e) {}
    });

    const hasFAQ = schemas.includes('FAQPage');
    const hasHowTo = schemas.includes('HowTo');
    const hasArticle = schemas.includes('Article') || schemas.includes('BlogPosting');
    const hasSpeakable = schemas.includes('SpeakableSpecification');
    const hasLocalBusiness = schemas.includes('LocalBusiness');
    const hasProduct = schemas.includes('Product');
    const hasBreadcrumb = schemas.includes('BreadcrumbList');

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
    if (!canonical) {
      issues.push("Canonical URL tag missing");
    }
    if (!hasFavicon) {
      issues.push("Favicon missing - Hurts branding");
    }
    if (wordCount < 300) issues.push("Thin content - less than 300 words");
    if (readability.score < 50) issues.push(`Content difficult to read - Score: ${readability.score}/100`);
    if (!hasFacebook &&!hasLinkedIn &&!hasYouTube) issues.push("No social media links found");
    if (!hasEmail &&!hasPhone) issues.push("No contact information found - Missing trust signals");
    if (!mobileFriendly) issues.push("Website is not mobile optimized - Missing viewport tag");
    if (!robotsExists) issues.push("robots.txt not found - AI crawlers may get blocked");
    if (!sitemapExists) issues.push("sitemap.xml not found - Google indexing will be slow");
    if (!hasOGTags) issues.push("Open Graph tags missing - Poor social media sharing");
    if (!isHttps) issues.push("Not using HTTPS - Security risk, Google ranks HTTP lower");
    if (loadTime > 3000) issues.push(`Slow page load time: ${loadTime}ms - Should be under 3 seconds`);
    if (brokenLinks > 0) issues.push(`${brokenLinks} broken links found - Hurts SEO & user experience`);
    if (!hasSchemaMarkup) issues.push("No Schema Markup found - Missing rich snippets opportunity");

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

    if (title.length > 10 && title.length < 70) score += 12;
    if (metaDescription.length > 80 && metaDescription.length < 160) score += 12;
    if (h1) score += 8;
    if (h2 > 0) score += 5;
    if (wordCount > 500) score += 10;
    if (links > 5) score += 5;
    if (totalImages > 0 && imagesWithoutAlt < totalImages) score += 8;
    if (hasCanonical) score += 2;
    if (hasFavicon) score += 1;
    if (readability.score >= 60) score += 5; // NEW: Readability
    if (hasEmail || hasPhone) score += 2; // NEW: Contact info
    if (hasFacebook || hasLinkedIn) score += 1; // NEW: Social
    if (wordCount > 1000) score += 5;
    if (mobileFriendly) score += 10;
    if (robotsExists) score += 3;
    if (sitemapExists) score += 3;
    if (hasOGTags) score += 3;
    if (isHttps) score += 5;
    if (loadTime < 3000) score += 3;
    if (brokenLinks === 0) score += 3;
    if (hasSchemaMarkup) score += 2;

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
    if(hasSpeakable) aeoScore += 5;
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
    if (readability.score < 60) tips.push(`Improve readability - Current: ${readability.score}/100. Use shorter sentences and simpler words`);
    if (!hasFacebook &&!hasLinkedIn) tips.push("Add social media links to build trust and authority");
    if (!hasEmail &&!hasPhone) tips.push("Add contact information (email/phone) to improve EEAT signals");
    if (!robotsExists) tips.push("Create robots.txt to allow AI crawlers like GPTBot");
    if (!sitemapExists) tips.push("Add sitemap.xml and submit to Google Search Console");
    if (!hasFAQ) tips.push("Add FAQ Schema to get quoted by ChatGPT");
    if (!hasDirectAnswer) tips.push("Add 40-60 word paragraph right after H2");
    if (wordCount < 500) tips.push("Increase content to 800+ words");
    if (!hasOGTags) tips.push("Add Open Graph tags for better Facebook, LinkedIn and social sharing previews");
    if (!mobileFriendly) tips.push("Add viewport meta tag: <meta name='viewport' content='width=device-width, initial-scale=1.0'>");
    if (!isHttps) tips.push("Migrate to HTTPS - Get SSL certificate for security & rankings");
    if (loadTime > 3000) tips.push(`Optimize page speed - Current: ${loadTime}ms. Compress images, enable caching`);
    if (brokenLinks > 0) tips.push(`Fix ${brokenLinks} broken links to improve user experience`);
    if (!hasSchemaMarkup) tips.push("Add Schema.org markup for rich snippets in Google");
    if (!hasCanonical) tips.push("Add canonical URL: <link rel='canonical' href='https://your-page-url'>");
    if (!hasFavicon) tips.push("Add a favicon to improve branding and user experience");

    // ---------------- AI REPORT WITH FALLBACK ----------------
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
          hasDirectAnswer,
          readabilityScore: readability.score
        });
      }
    } catch (e) {
      console.error("AI ERROR:", e);
    }

    // 5. AI FALLBACK REPORT
    if (!aiReport || aiReport.includes("not available")) {
      aiReport = `📊 AUTOMATED SEO + AEO ANALYSIS

SEO SCORE: ${score}/100 - ${status}
AEO SCORE: ${aeoScore}/100 - ${aeoStatus}
READABILITY: ${readability.score}/100 - ${readability.status}

✅ STRENGTHS:
${title? `• Strong title tag (${title.length} chars)` : ''}
${h1? `• H1 tag present` : ''}
${wordCount > 500? `• Good content length (${wordCount} words)` : ''}
${hasFAQ? `• FAQ Schema detected - AI ready` : ''}
${isHttps? `• HTTPS secure` : ''}
${mobileFriendly? `• Mobile optimized` : ''}

⚠️ ISSUES TO FIX:
${issues.slice(0, 5).map(i => `• ${i}`).join('\n')}

💡 TOP 3 RECOMMENDATIONS:
${tips.slice(0, 3).map((t, i) => `${i+1}. ${t}`).join('\n')}

🤖 AI VISIBILITY:
${aeoScore >= 80? 'Your content is well-optimized for ChatGPT, Perplexity & Gemini' :
  aeoScore >= 50? 'Add FAQ/HowTo schema to improve AI visibility' :
  'Content needs structured data to be quoted by AI search engines'}`;
    }

    // ---------------- SAVE - No Duplicates ----------------
    await Report.findOneAndUpdate(
      { url },
      {
        url, title, h1, metaDescription, wordCount, score, status,
        aeoScore, aeoStatus, schemas, hasFAQ, hasHowTo, hasDirectAnswer,
        robotsExists, sitemapExists, totalImages, imagesWithoutAlt,
        hasOGTags, ogTitle, ogDescription, ogImage,
        mobileFriendly, isHttps, loadTime, brokenLinks, brokenLinksList, hasSchemaMarkup,
        hasCanonical, canonical, hasFavicon, favicon,
        readabilityScore: readability.score, readabilityStatus: readability.status,
        hasFacebook, hasLinkedIn, hasYouTube, hasTwitter,
        hasEmail, hasPhone, email, phone,
        tips, aiReport, issues, keywords, internalLinks, externalLinks,
        lastModified
      },
      { upsert: true, new: true }
    );

    // ---------------- RESPONSE ----------------
    res.json({
      url, title, h1, metaDescription, wordCount, score, status,
      aeoScore, aeoStatus, schemas, hasFAQ, hasHowTo, hasDirectAnswer,
      lastModified, robotsExists, sitemapExists, totalImages, imagesWithoutAlt,
      hasOGTags, ogTitle, ogDescription, ogImage,
      mobileFriendly, isHttps, loadTime, brokenLinks, brokenLinksList, hasSchemaMarkup,
      hasCanonical, canonical, hasFavicon, favicon,
      readabilityScore: readability.score, readabilityStatus: readability.status,
      hasFacebook, hasLinkedIn, hasYouTube, hasTwitter,
      hasEmail, hasPhone, email, phone,
      tips, aiReport, issues, keywords, internalLinks, externalLinks
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
