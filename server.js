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
function calculateReadability(text) {
  if (!text || text.length < 100) return { score: 0, status: "Not Enough Content" };
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const syllables = words.reduce((count, word) => count + countSyllables(word), 0);
  if (sentences === 0 || wordCount === 0) return { score: 0, status: "Not Enough Content" };
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

function calculateCitationProbability({ hasFAQ, hasHowTo, hasDirectAnswer, hasArticle, hasSpeakable, schemas, wordCount, hasAuthor }) {
  let chatGPT = 0, gemini = 0, perplexity = 0;
  if (hasFAQ) chatGPT += 35;
  if (hasDirectAnswer) chatGPT += 30;
  if (hasArticle) chatGPT += 15;
  if (wordCount > 500) chatGPT += 10;
  if (hasAuthor) chatGPT += 10;
  if (hasHowTo) gemini += 30;
  if (schemas.length > 2) gemini += 25;
  if (hasArticle) gemini += 20;
  if (hasDirectAnswer) gemini += 15;
  if (wordCount > 800) gemini += 10;
  if (hasFAQ) perplexity += 30;
  if (hasHowTo) perplexity += 25;
  if (hasDirectAnswer) perplexity += 25;
  if (hasSpeakable) perplexity += 10;
  if (wordCount > 600) perplexity += 10;
  return {
    chatGPT: Math.min(100, chatGPT),
    gemini: Math.min(100, gemini),
    perplexity: Math.min(100, perplexity)
  };
}

function extractAIAnswer($) {
  let faqAnswer = '';
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'FAQPage' && json.mainEntity?.[0]) {
        const q = json.mainEntity[0].name;
        const a = json.mainEntity[0].acceptedAnswer?.text;
        if (q && a) faqAnswer = `Q: ${q}\nA: ${a.substring(0, 200)}...`;
      }
    } catch(e) {}
  });
  if (faqAnswer) return faqAnswer;
  let directAnswer = '';
  $('h2').each((i, el) => {
    if (directAnswer) return;
    const question = $(el).text().trim();
    const nextP = $(el).next('p').text().trim();
    const words = nextP.split(/\s+/).filter(Boolean);
    if (words.length >= 40 && words.length <= 80) {
      directAnswer = `Q: ${question}\nA: ${nextP.substring(0, 200)}...`;
    }
  });
  if (directAnswer) return directAnswer;
  const h1 = $("h1").first().text().trim();
  const firstPara = $("p").first().text().trim();
  if (h1 && firstPara) return `Q: ${h1}\nA: ${firstPara.substring(0, 200)}...`;
  return "No clear AI-extractable answer found. Add FAQ schema or direct answers under H2.";
}

function generateAEOSimulation({ title, h1, metaDescription, hasFAQ, directAnswer, url, wordCount }) {
  const brand = new URL(url).hostname.replace('www.', '').split('.')[0];
  const brandName = brand.charAt(0).toUpperCase() + brand.slice(1);
  if (hasFAQ && directAnswer.includes('Q:')) {
    return `"According to ${brandName}, ${directAnswer.split('A: ')[1]?.substring(0, 150) || 'this service is available'}."`;
  }
  if (h1 && wordCount > 300) {
    const answer = metaDescription || `${h1} services are available`;
    return `"According to ${brandName}, ${answer.substring(0, 150)}..."`;
  }
  return `"${brandName} provides ${title || 'web services'}. Visit ${url} for more details."`;
}

function detectAuthor($) {
  const authorMeta = $('meta[name="author"]').attr('content');
  const authorSchema = $('script[type="application/ld+json"]').text().includes('"author"');
  const authorText = $('body').text().match(/by\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/);
  return!!(authorMeta || authorSchema || authorText);
}

function calculateAITrustScore({ isHttps, hasAuthor, hasEmail, hasPhone, hasPrivacyPolicy, hasAboutPage, hasContactPage }) {
  let score = 0;
  let signals = [];
  if (isHttps) { score += 20; signals.push('HTTPS ✅'); }
  if (hasAuthor) { score += 20; signals.push('Author ✅'); }
  if (hasEmail || hasPhone) { score += 15; signals.push('Contact Info ✅'); }
  if (hasPrivacyPolicy) { score += 15; signals.push('Privacy Policy ✅'); }
  if (hasAboutPage) { score += 15; signals.push('About Page ✅'); }
  if (hasContactPage) { score += 15; signals.push('Contact Page ✅'); }
  return { score: Math.min(100, score), signals };
}

function detectTrustPages($) {
  const text = $('body').text().toLowerCase();
  const links = [];
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const linkText = $(el).text().toLowerCase();
    links.push({ href, text: linkText });
  });
  const hasPrivacyPolicy = links.some(l => l.href.includes('privacy') || l.text.includes('privacy')) || text.includes('privacy policy');
  const hasAboutPage = links.some(l => l.href.includes('about') || l.text.includes('about us')) || text.includes('about us');
  const hasContactPage = links.some(l => l.href.includes('contact') || l.text.includes('contact us')) || text.includes('contact us');
  return { hasPrivacyPolicy, hasAboutPage, hasContactPage };
}

function predictFeaturedSnippet({ hasDirectAnswer, h2Questions, hasFAQ, hasHowTo, hasLists }) {
  let score = 0;
  let reasons = [];
  if (hasDirectAnswer) { score += 35; reasons.push('✅ Direct Answers Found'); }
  else { reasons.push('❌ No 40-60 word answers under H2'); }
  if (h2Questions > 0) { score += 25; reasons.push(`✅ ${h2Questions} H2 Questions Found`); }
  else { reasons.push('❌ No H2 questions'); }
  if (hasFAQ) { score += 20; reasons.push('✅ FAQ Schema Present'); }
  else { reasons.push('❌ FAQ Schema Missing'); }
  if (hasLists) { score += 10; reasons.push('✅ Lists Found'); }
  else { reasons.push('❌ No lists'); }
  if (hasHowTo) { score += 10; reasons.push('✅ HowTo Schema Present'); }
  return { chance: Math.min(100, score), reasons };
}

function calculateContentStructure($) {
  const h1Count = $('h1').length;
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;
  const listCount = $('ul, ol').length;
  const tableCount = $('table').length;
  let score = 0;
  if (h1Count === 1) score += 20;
  if (h2Count >= 3) score += 25;
  if (h3Count >= 5) score += 20;
  if (listCount >= 2) score += 20;
  if (tableCount >= 1) score += 15;
  return { score: Math.min(100, score), h1Count, h2Count, h3Count, listCount, tableCount };
}

function categorizeIssues(issues) {
  const critical = [];
  const important = [];
  const minor = [];
  issues.forEach(issue => {
    if (issue.includes('FAQ Schema') || issue.includes('HTTPS') || issue.includes('title tag') || issue.includes('H1')) {
      critical.push(issue);
    } else if (issue.includes('Last Updated') || issue.includes('Direct answer') || issue.includes('meta description') || issue.includes('robots.txt')) {
      important.push(issue);
    } else {
      minor.push(issue);
    }
  });
  return { critical, important, minor };
}

function calculateSchemaCoverage(schemas) {
  const totalPossible = 8;
  const uniqueSchemas = [...new Set(schemas)];
  return Math.round((uniqueSchemas.length / totalPossible) * 100);
}

function calculateAIVisibilityScore({ seoScore, aeoScore, aiTrust, readability, schemaCoverage }) {
  const score = Math.round((seoScore * 0.25) + (aeoScore * 0.25) + (aiTrust * 0.20) + (readability * 0.15) + (schemaCoverage * 0.15));
  const level = score >= 80? 'High' : score >= 60? 'Medium' : 'Needs Improvement';
  return { score: Math.min(100, score), level };
}

function generateCitationSimulator({ title, h1, metaDescription, url, hasFAQ }) {
  const brand = new URL(url).hostname.replace('www.', '').split('.')[0];
  const brandName = brand.charAt(0).toUpperCase() + brand.slice(1);
  const answer = metaDescription || h1 || title || 'professional services';
  return `If ChatGPT is asked: "What is ${brandName}?"\n\nAI will respond:\n"According to ${brandName}, ${answer.substring(0, 150)}..."\n\nCitation Probability: ${hasFAQ? 'HIGH' : 'MEDIUM'}`;
}

function analyzeTopicAuthority($, title) {
  const text = $('body').text().toLowerCase();
  const mainTopic = title?.split(' ')[0]?.toLowerCase() || 'website';
  const subTopics = {
    wordpress: text.includes('wordpress'),
    seo: text.includes('seo'),
    hosting: text.includes('hosting'),
    security: text.includes('security'),
    maintenance: text.includes('maintenance'),
    design: text.includes('design'),
    development: text.includes('development')
  };
  const found = Object.entries(subTopics).filter(([k, v]) => v).map(([k]) => k);
  const missing = Object.entries(subTopics).filter(([k, v]) =>!v).map(([k]) => k);
  return { mainTopic, found, missing };
}

function checkAnswerQuality($) {
  let score = 0;
  let checks = [];
  const h2s = $('h2').length;
  const lists = $('ul, ol').length;
  const hasFAQ = $('script[type="application/ld+json"]').text().includes('FAQPage');
  const paragraphs = $('p');
  let clearSentences = 0;
  paragraphs.each((i, p) => {
    const text = $(p).text().trim();
    const words = text.split(/\s+/).length;
    if (words > 10 && words < 50) clearSentences++;
  });
  if (clearSentences > 3) { score += 30; checks.push('✅ Clear sentences'); }
  else { checks.push('❌ Sentences too complex'); }
  if (h2s > 0) { score += 25; checks.push('✅ Direct answers under H2'); }
  else { checks.push('❌ No H2 structure'); }
  if (hasFAQ) { score += 25; checks.push('✅ FAQ structure'); }
  else { checks.push('❌ No FAQ structure'); }
  if (lists > 0) { score += 20; checks.push('✅ Step-by-step format'); }
  else { checks.push('❌ No step-by-step format'); }
  return { score: Math.min(100, score), checks };
}

function generateAutoFAQ(title, h1, metaDescription, url) {
  const brand = new URL(url).hostname.replace('www.', '').split('.')[0];
  const brandName = brand.charAt(0).toUpperCase() + brand.slice(1);
  return [
    { q: `What services does ${brandName} offer?`, a: metaDescription || h1 || `Professional ${title || 'web'} services` },
    { q: `How much does it cost?`, a: 'Starting from competitive rates. Contact us for a quote.' },
    { q: `How long does it take?`, a: 'Typical delivery within 7-14 days depending on project scope.' },
    { q: `Do you provide support?`, a: 'Yes, we offer ongoing support and maintenance.' }
  ];
}

function generateSERPPreview(title, metaDescription, url) {
  return {
    title: title || 'Your Page Title',
    description: metaDescription || 'Your meta description here...',
    url: url,
    displayUrl: new URL(url).hostname
  };
}

function estimateBusinessValue(seoScore, aeoScore, wordCount) {
  const trafficIncrease = Math.round((seoScore + aeoScore) / 5);
  const leadsIncrease = Math.round(trafficIncrease * 0.6);
  const revenueImpact = Math.round((wordCount / 100) * (seoScore / 10) * 50);
  return {
    trafficIncrease: `+${trafficIncrease}%`,
    leadsIncrease: `+${leadsIncrease}%`,
    revenueImpact: `+$${revenueImpact}/month`
  };
}

function generateInstantFixes(issues) {
  const fixes = [];
  if (issues.some(i => i.includes('FAQ Schema'))) fixes.push('Add FAQ Schema');
  if (issues.some(i => i.includes('Readability'))) fixes.push('Improve Readability');
  if (issues.some(i => i.includes('Last Updated'))) fixes.push('Add Last Updated Date');
  if (issues.some(i => i.includes('ALT text'))) fixes.push('Add Image ALT Text');
  if (issues.some(i => i.includes('meta description'))) fixes.push('Optimize Meta Description');
  return fixes;
}

// ---------------- APP ----------------
const app = express();
const PORT = process.env.PORT || 4000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

console.log("OpenRouter Loaded");

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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------- SEO ANALYZE ROUTE ----------------
app.get("/analyze", async (req, res) => {
  let url = req.query.url;
  if (!url) return res.json({ error: "Please provide URL" });
  try {
    if (!url.startsWith("http")) url = "https://" + url;
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
    const startTime = Date.now();
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" }
    });
    const loadTime = Date.now() - startTime;
    const $ = cheerio.load(response.data);
    const canonical = $('link[rel="canonical"]').attr("href");
    const hasCanonical =!!canonical;
    const favicon = $('link[rel="icon"]').attr("href") || $('link[rel="shortcut icon"]').attr("href") || $('link[rel="apple-touch-icon"]').attr("href");
    const hasFavicon =!!favicon;
    $('script, style, noscript, svg').remove();
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const metaDescription = $('meta[name="description"]').attr("content") || "";
    const stopWords = ['with','from','your','this','that','about','after','have','will','into','which','their','there','these','they','them','been','were','when','where','what','would','could','should'];
    const text = $("body").text();
    const cleanText = text.toLowerCase().replace(/[^\w\s]/g, ' ');
    const singleWords = cleanText.split(/\s+/).filter(word => word.length > 3 &&!stopWords.includes(word));
    const phrases = [];
    for(let i = 0; i < singleWords.length - 1; i++) {
      const phrase = `${singleWords[i]} ${singleWords[i+1]}`;
      if(!stopWords.includes(singleWords[i]) &&!stopWords.includes(singleWords[i+1])) phrases.push(phrase);
    }
    const keywordCount = {};
    [...singleWords,...phrases].forEach(word => { keywordCount[word] = (keywordCount[word] || 0) + 1; });
    const keywords = Object.entries(keywordCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word);
    const wordCount = text? text.trim().split(/\s+/).filter(Boolean).length : 0;
    const readability = calculateReadability(text);
    const links = $("a").length;
    let hasFacebook = false, hasLinkedIn = false, hasYouTube = false, hasTwitter = false;
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      if (href.includes("facebook.com") || href.includes("fb.com")) hasFacebook = true;
      if (href.includes("linkedin.com")) hasLinkedIn = true;
      if (href.includes("youtube.com") || href.includes("youtu.be")) hasYouTube = true;
      if (href.includes("twitter.com") || href.includes("x.com")) hasTwitter = true;
    });
    const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/g;
    const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const emails = text.match(emailRegex) || [];
    const phones = text.match(phoneRegex) || [];
    const hasEmail = emails.length > 0;
    const hasPhone = phones.length > 0;
    const email = emails[0] || "";
    const phone = phones[0] || "";
    const images = $("img");
    const totalImages = images.length;
    let imagesWithoutAlt = 0;
    images.each((i, img) => {
      const alt = $(img).attr("alt");
      if (!alt || alt.trim() === "") imagesWithoutAlt++;
    });
    const h2 = $("h2").length;
    const h2Questions = $('h2').filter((i, el) => $(el).text().includes('?')).length;
    const viewportTag = $('meta[name="viewport"]').attr("content");
    const mobileFriendly =!!viewportTag && viewportTag.includes("width=device-width");
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const ogDescription = $('meta[property="og:description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || "";
    const hasOGTags =!!ogTitle &&!!ogDescription &&!!ogImage;
    let robotsExists = false;
    try {
      const robots = await axios.get(`${baseUrl}/robots.txt`, { timeout: 5000, validateStatus: status => status < 500 });
      if (robots.status === 200) robotsExists = true;
    } catch(e) {}
    let sitemapExists = false;
    try {
      const sitemap = await axios.get(`${baseUrl}/sitemap.xml`, { timeout: 5000, validateStatus: status => status < 500 });
      if (sitemap.status === 200) sitemapExists = true;
    } catch(e) {}
    const allLinks = [];
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (href && href.startsWith("http") &&!href.includes('#')) allLinks.push(href);
    });
    const linksToCheck = allLinks.slice(0, 10);
    let brokenLinks = 0;
    const brokenLinksList = [];
    await Promise.all(linksToCheck.map(async (link) => {
      try {
        await axios.head(link, { timeout: 5000, validateStatus: s => s < 400 });
      } catch (e) {
        brokenLinks++;
        brokenLinksList.push(link);
      }
    }));
    const internalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href");
      return href && (href.startsWith("/") || href.includes(hostname));
    }).length;
    const externalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href");
      return href && href.startsWith("http") &&!href.includes(hostname);
    }).length;
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
    let hasDirectAnswer = false;
    $('h2').each((i, el) => {
      const nextP = $(el).next('p').text().trim();
      const words = nextP.split(/\s+/).filter(Boolean).length;
      if(words >= 40 && words <= 60) hasDirectAnswer = true;
    });
    const lastModified = $('meta[property="article:modified_time"]').attr('content') || $('meta[property="article:published_time"]').attr('content') || $('time').attr('datetime') || null;
    const hasAuthor = detectAuthor($);
    const aiExtractedAnswer = extractAIAnswer($);
    const citationScores = calculateCitationProbability({ hasFAQ, hasHowTo, hasDirectAnswer, hasArticle, hasSpeakable, schemas, wordCount, hasAuthor });
    const aeoSimulation = generateAEOSimulation({ title, h1, metaDescription, hasFAQ, directAnswer: aiExtractedAnswer, url, wordCount });
    const { hasPrivacyPolicy, hasAboutPage, hasContactPage } = detectTrustPages($);
    const trustData = calculateAITrustScore({ isHttps, hasAuthor, hasEmail, hasPhone, hasPrivacyPolicy, hasAboutPage, hasContactPage });
    const hasLists = $('ul, ol').length > 0;
    const snippetData = predictFeaturedSnippet({ hasDirectAnswer, h2Questions, hasFAQ, hasHowTo, hasLists });
    const structureData = calculateContentStructure($);
    const avgCitation = Math.round((citationScores.chatGPT + citationScores.gemini + citationScores.perplexity) / 3);
    const schemaCoverage = calculateSchemaCoverage(schemas);
    
    let issues = [];
    if (!title) issues.push("Missing title tag");
    if (!metaDescription) issues.push("Missing meta description");
    if (!h1) issues.push("Missing H1 tag");
    if (imagesWithoutAlt > 0) issues.push(`${imagesWithoutAlt} out of ${totalImages} images are missing ALT text`);
    if (!canonical) issues.push("Canonical URL tag missing");
    if (!hasFavicon) issues.push("Favicon missing - Hurts branding");
    if (wordCount < 300) issues.push("Thin content - less than 300 words");
    if (readability.score < 50) issues.push(`Content difficult to read - Score: ${readability.score}/100`);
    if (!hasFacebook &&!hasLinkedIn &&!hasYouTube) issues.push("No social media links found");
    if (!hasEmail &&!hasPhone) issues.push("No contact information found - Missing trust signals");
    if (!hasAuthor) issues.push("No author found - Reduces EEAT and AI trust");
    if (!hasPrivacyPolicy) issues.push("Missing Privacy Policy page - Reduces AI trust");
    if (!hasAboutPage) issues.push("Missing About Us page - Weak EEAT signal");
    if (citationScores.chatGPT < 50) issues.push("Low ChatGPT citation chance - Add FAQ schema and direct answers");
    if (!mobileFriendly) issues.push("Website is not mobile optimized - Missing viewport tag");
    if (!robotsExists) issues.push("robots.txt not found - AI crawlers may get blocked");
    if (!sitemapExists) issues.push("sitemap.xml not found - Google indexing will be slow");
    if (!hasOGTags) issues.push("Open Graph tags missing - Poor social media sharing");
    if (!isHttps) issues.push("Not using HTTPS - Security risk, Google ranks HTTP lower");
    if (loadTime > 3000) issues.push(`Slow page load time: ${loadTime}ms - Should be under 3 seconds`);
    if (brokenLinks > 0) issues.push(`${brokenLinks} broken links found - Hurts SEO & user experience`);
    if (!hasSchemaMarkup) issues.push("No Schema Markup found - Missing rich snippets opportunity");
    if(!hasFAQ) issues.push("Missing FAQ Schema - ChatGPT won't quote you");
    if(!hasHowTo) issues.push("Missing HowTo Schema - No step-by-step answers for AI");
    if(!hasDirectAnswer) issues.push("No direct answer under H2 - Missing featured snippet");
    if(!lastModified) issues.push("No last updated date - AI prefers fresh content");
    if (issues.length === 0) issues.push("No major SEO issues found");
    
    const { critical, important, minor } = categorizeIssues(issues);
    
    let score = 0;
    if (title.length > 10 && title.length < 70) score += 10;
    if (metaDescription.length > 50 && metaDescription.length < 160) score += 10;
    if (h1) score += 10;
    if (h2 >= 2) score += 5;
    if (canonical) score += 5;
    if (hasFavicon) score += 5;
    if (wordCount > 300) score += 10;
    if (readability.score >= 60) score += 10;
    if (imagesWithoutAlt === 0 && totalImages > 0) score += 5;
    else if (totalImages === 0) score += 5;
    if (mobileFriendly) score += 5;
    if (hasOGTags) score += 5;
    if (robotsExists) score += 5;
    if (sitemapExists) score += 5;
    if (isHttps) score += 5;
    if (loadTime < 3000) score += 5;
    if (brokenLinks === 0) score += 5;
    if (hasSchemaMarkup) score += 5;
    score = Math.min(100, score);
    let status = score >= 80? "Excellent" : score >= 50? "Good" : "Poor";
    
    let aeoScore = 0;
    if(hasFAQ) aeoScore += 25;
    if(hasHowTo) aeoScore += 20;
    if(hasDirectAnswer) aeoScore += 20;
    if(lastModified) aeoScore += 10;
    if(wordCount > 500) aeoScore += 10;
    if(hasArticle) aeoScore += 10;
    if(hasSpeakable) aeoScore += 5;
    aeoScore = Math.min(100, aeoScore);
    let aeoStatus = aeoScore >= 80? "Excellent" : aeoScore >= 50? "Good" : "Poor";
    
    const overallAIVisibility = Math.round((score * 0.25) + (aeoScore * 0.25) + (trustData.score * 0.2) + (avgCitation * 0.3));
    const aiVisibilityData = calculateAIVisibilityScore({ 
      seoScore: score, 
      aeoScore: aeoScore, 
      aiTrust: trustData.score, 
      readability: readability.score, 
      schemaCoverage 
    });
    
    const answerQualityData = checkAnswerQuality($);
    const autoFAQ = generateAutoFAQ(title, h1, metaDescription, url);
    const serpPreview = generateSERPPreview(title, metaDescription, url);
    const topicAuthority = analyzeTopicAuthority($, title);
    const citationSimulator = generateCitationSimulator({ title, h1, metaDescription, url, hasFAQ });
    const businessValue = estimateBusinessValue(score, aeoScore, wordCount);
    const instantFixes = generateInstantFixes(issues);
    const mobileScore = mobileFriendly? 95 : 40;
    const desktopScore = score;
    
    let tips = [];
    if(!hasFAQ) tips.push("Add FAQ Schema to boost AI citation by 35%");
    if(!hasDirectAnswer) tips.push("Add 40-60 word answers under H2 headings for featured snippets");
    if(!lastModified) tips.push("Add 'Last Updated' date to improve AI freshness score");
    if(!hasSpeakable) tips.push("Add Speakable schema for voice search optimization");
    if(!hasArticle) tips.push("Add Article schema for better AI understanding");
    if(wordCount < 500) tips.push("Increase content to 500+ words for better AEO");
    if(!hasAuthor) tips.push("Add author byline to improve EEAT and AI trust");
    if(!hasPrivacyPolicy) tips.push("Add Privacy Policy page to boost AI trust score");
    if(!hasAboutPage) tips.push("Add About Us page to improve EEAT signals");
    if (tips.length === 0) tips.push("Your site is well optimized for AI search");
    
    let aiReport = "";
    try {
      aiReport = await getAIReport({ 
        url, title, h1, metaDescription, score, status, wordCount, issues, tips, keywords, 
        aeoScore, aeoStatus, schemas, hasFAQ, hasHowTo, hasDirectAnswer, lastModified, 
        hasArticle, hasSpeakable, readability, hasFacebook, hasLinkedIn, hasYouTube, hasTwitter, 
        hasEmail, hasPhone, email, phone, hasAuthor, aiExtractedAnswer, citationScores, aeoSimulation 
      });
    } catch(e) {
      aiReport = "AI Report not available";
    }
    
    if (!aiReport || aiReport.includes("not available")) {
      aiReport = `📊 AUTOMATED SEO + AEO ANALYSIS

SEO SCORE: ${score}/100 - ${status}
AEO SCORE: ${aeoScore}/100 - ${aeoStatus}
READABILITY: ${readability.score}/100 - ${readability.status}
AI TRUST: ${trustData.score}/100
AI CITATION: ChatGPT ${citationScores.chatGPT}% | Gemini ${citationScores.gemini}% | Perplexity ${citationScores.perplexity}%
OVERALL AI VISIBILITY: ${overallAIVisibility}/100

✅ STRENGTHS:
${issues.filter(i => i.includes('No')).map(i => i.replace('No', 'Has')).join('\n')}

⚠️ ISSUES TO FIX:
${issues.filter(i =>!i.includes('No')).join('\n')}

💡 TOP 3 RECOMMENDATIONS:
${tips.slice(0,3).join('\n')}`;
    }
    
    const reportData = {
      url, title, h1, metaDescription, wordCount, score, status, tips, issues, keywords,
      internalLinks, externalLinks, totalImages, imagesWithoutAlt, hasOGTags, ogTitle, ogDescription, ogImage,
      mobileFriendly, isHttps, loadTime, brokenLinks, brokenLinksList, hasSchemaMarkup, robotsExists, sitemapExists,
      hasCanonical, canonical, hasFavicon, favicon, readabilityScore: readability.score, readabilityStatus: readability.status,
      hasFacebook, hasLinkedIn, hasYouTube, hasTwitter, hasEmail, hasPhone, email, phone, hasAuthor,
      aiExtractedAnswer, citationChatGPT: citationScores.chatGPT, citationGemini: citationScores.gemini, citationPerplexity: citationScores.perplexity,
      aeoSimulation, aeoScore, aeoStatus, schemas, hasFAQ, hasHowTo, hasDirectAnswer, lastModified,
      hasPrivacyPolicy, hasAboutPage, hasContactPage, aiTrustScore: trustData.score, aiTrustSignals: trustData.signals,
      featuredSnippetChance: snippetData.chance, snippetReasons: snippetData.reasons,
      h3Count: structureData.h3Count, listCount: structureData.listCount, tableCount: structureData.tableCount,
      contentStructureScore: structureData.score, criticalIssues: critical, importantIssues: important, minorIssues: minor,
      overallAIVisibility, schemaCoverage, aiVisibilityScore: aiVisibilityData.score, aiVisibilityLevel: aiVisibilityData.level,
      citationSimulator, topicAuthority, answerQuality: answerQualityData.score, answerQualityChecks: answerQualityData.checks,
      autoFAQ, serpPreview, mobileScore, desktopScore, businessValue, instantFixes, aiReport
    };

    const existingReport = await Report.findOne({ url });
    if (existingReport) {
      await Report.updateOne({ url }, { $set: reportData });
    } else {
      await Report.create(reportData);
    }

    res.json(reportData);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ---------------- HISTORY ROUTE ----------------
app.get("/history", async (req, res) => {
  const data = await Report.find().sort({ createdAt: -1 }).limit(10);
  res.json(data);
});
