import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";
import { getAISearchSimulation } from "./aiService.js";

const app = express();
const PORT = process.env.PORT || 4000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static("."));



// ========== HELPER FUNCTIONS ==========
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

function getBrandName(url) {
  const domain = extractDomain(url);
  const brand = domain.split('.')[0];
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function countBrandMentions(text, brandName) {
  const regex = new RegExp(brandName, 'gi');
  return (text.match(regex) || []).length;
}

function extractDates($) {
  const metaDates = {
    published: $('meta[property="article:published_time"]').attr('content') ||
               $('meta[name="date"]').attr('content') ||
               $('time[datetime]').attr('datetime'),
    modified: $('meta[property="article:modified_time"]').attr('content') ||
              $('meta[name="last-modified"]').attr('content'),
    updated: $('.updated,.last-updated, [class*="update"]').first().text()
  };

  return {
    published: metaDates.published? new Date(metaDates.published) : null,
    modified: metaDates.modified? new Date(metaDates.modified) : null,
    raw: metaDates
  };
}

function analyzeInternalLinks($, baseUrl) {
  const links = [];
  const baseDomain = extractDomain(baseUrl);

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    try {
      const fullUrl = new URL(href, baseUrl).href;
      const linkDomain = extractDomain(fullUrl);
      if (linkDomain === baseDomain) {
        links.push({
          url: fullUrl,
          text: $(el).text().trim().substring(0, 50),
          path: new URL(fullUrl).pathname
        });
      }
    } catch {}
  });

  const pageCounts = {};
  links.forEach(link => {
    pageCounts[link.path] = (pageCounts[link.path] || 0) + 1;
  });

  const sorted = Object.entries(pageCounts).sort((a, b) => b[1] - a[1]);

  return {
    total: links.length,
    uniquePages: Object.keys(pageCounts).length,
    mostLinked: sorted[0]? { path: sorted[0][0], count: sorted[0][1] } : null,
    weakPages: sorted.filter(([path, count]) => count <= 2).slice(0, 5).map(([path, count]) => ({ path, count }))
  };
}

function extractKeywordsFromContent(text, topN = 10) {
  const words = text.toLowerCase()
   .replace(/[^\w\s]/g, ' ')
   .split(/\s+/)
   .filter(w => w.length > 4 &&!['about', 'https', 'website', 'click', 'here'].includes(w));

  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);

  return Object.entries(freq)
   .sort((a, b) => b[1] - a[1])
   .slice(0, topN)
   .map(([word]) => word);
}

function calculateEEATScore($, data) {
  let score = 0;
  const signals = [];

  // Author: 20 points
  if (data.hasAuthor) {
    score += 20;
    signals.push('✓ Author Bio Found');
  } else {
    signals.push('✗ Author Bio Missing');
  }

  // Contact: 15 points
  if (data.hasContactPage || data.hasEmail || data.hasPhone) {
    score += 15;
    signals.push('✓ Contact Information Found');
  } else {
    signals.push('✗ Contact Information Missing');
  }

  // About: 15 points
  if (data.hasAboutPage) {
    score += 15;
    signals.push('✓ About Page Found');
  } else {
    signals.push('✗ About Page Missing');
  }

  // Privacy: 15 points
  if (data.hasPrivacyPolicy) {
    score += 15;
    signals.push('✓ Privacy Policy Found');
  } else {
    signals.push('✗ Privacy Policy Missing');
  }

  // Social: 15 points
  const socialCount = [data.hasFacebook, data.hasLinkedIn, data.hasYouTube, data.hasTwitter].filter(Boolean).length;
  score += socialCount * 5;
  if (socialCount >= 2) {
    signals.push(`✓ ${socialCount} Social Profiles Found`);
  } else {
    signals.push('✗ Insufficient Social Profiles');
  }

  // HTTPS: 10 points
  if (data.isHttps) {
    score += 10;
    signals.push('✓ HTTPS Secure');
  }

  // Last Updated: 10 points
  if (data.lastModified) {
    score += 10;
    signals.push('✓ Last Updated Date Found');
  } else {
    signals.push('✗ Last Updated Date Missing');
  }

  return { score: Math.min(score, 100), signals };
}

function calculateFreshnessScore(dates) {
  if (!dates.modified &&!dates.published) {
    return { score: 0, status: 'No dates found', daysAgo: null };
  }

  const latest = dates.modified || dates.published;
  const daysAgo = Math.floor((Date.now() - latest.getTime()) / (1000 * 60 * 60 * 24));

  let score = 100;
  if (daysAgo > 365) score = 20;
  else if (daysAgo > 180) score = 40;
  else if (daysAgo > 90) score = 60;
  else if (daysAgo > 30) score = 80;

  return {
    score,
    daysAgo,
    status: daysAgo < 30? 'Fresh' : daysAgo < 90? 'Good' : daysAgo < 180? 'Stale' : 'Outdated',
    lastUpdated: latest.toLocaleDateString()
  };
}

function calculateZeroClickScore(data) {
  let score = 0;
  const factors = [];

  if (data.hasDirectAnswer) {
    score += 25;
    factors.push('✓ Direct Answer Found');
  } else {
    factors.push('✗ No Direct Answer');
  }

  if (data.hasFAQ) {
    score += 20;
    factors.push('✓ FAQ Schema');
  } else {
    factors.push('✗ FAQ Schema Missing');
  }

  if (data.listCount >= 2) {
    score += 15;
    factors.push(`✓ ${data.listCount} Lists Found`);
  } else {
    factors.push('✗ Insufficient Lists');
  }

  if (data.tableCount >= 1) {
    score += 15;
    factors.push(`✓ ${data.tableCount} Tables Found`);
  } else {
    factors.push('✗ No Tables');
  }

  if (data.h2Count >= 3) {
    score += 15;
    factors.push(`✓ ${data.h2Count} H2 Headers`);
  } else {
    factors.push('✗ Poor Heading Structure');
  }

  if (data.hasHowTo) {
    score += 10;
    factors.push('✓ HowTo Schema');
  }

  return { score: Math.min(score, 100), factors };
}

async function generateContentBrief(keyword, ai) {
  if (!ai) return null;

  const prompt = `Generate a content brief for the keyword: "${keyword}". Return JSON with: h1 (string), h2s (array of 5 strings), faqs (array of 3 objects with q and a), schemaType (string: Article/FAQ/HowTo).`;

  try {
    const model = ai.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch? JSON.parse(jsonMatch[0]) : null;
  } catch {
    return null;
  }
}

// ========== MAIN ANALYZE FUNCTION ==========
async function analyzeSingleUrl(url) {
  const startTime = Date.now();
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SEO-AEO-Bot/1.0)" },
    timeout: 15000
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const loadTime = Date.now() - startTime;

  // Basic Extraction
  const title = $("title").text().trim();
  const h1 = $("h1").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content") || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).length;
  const brandName = getBrandName(url);

  // SEO Metrics
  const images = $("img");
  const totalImages = images.length;
  const imagesWithoutAlt = images.filter((i, el) =>!$(el).attr("alt")).length;
  const internalLinks = $("a[href^='/'], a[href^='" + url + "']").length;
  const externalLinks = $("a[href^='http']").not(`a[href^='${url}']`).length;

  // Technical SEO
  const isHttps = url.startsWith("https://");
  const mobileViewport = $('meta[name="viewport"]').length > 0;
  const canonical = $('link[rel="canonical"]').attr("href");
  const hasCanonical =!!canonical;
  const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').attr("href");
  const hasFavicon =!!favicon;

  // Robots & Sitemap
  let robotsExists = false;
  let sitemapExists = false;
  try {
    const robotsRes = await fetch(new URL("/robots.txt", url).href, { timeout: 5000 });
    robotsExists = robotsRes.ok;
    const sitemapRes = await fetch(new URL("/sitemap.xml", url).href, { timeout: 5000 });
    sitemapExists = sitemapRes.ok;
  } catch {}

  // Broken Links Check (sample first 10)
  const allLinks = $("a[href]").slice(0, 10);
  let brokenLinks = 0;
  for (let i = 0; i < allLinks.length; i++) {
    const href = $(allLinks[i]).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const linkUrl = new URL(href, url).href;
      const checkRes = await fetch(linkUrl, { method: "HEAD", timeout: 3000 });
      if (!checkRes.ok) brokenLinks++;
    } catch {
      brokenLinks++;
    }
  }

  // AEO Metrics
  const schemas = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const json = JSON.parse($(el).html());
      const type = json["@type"] || json["@graph"]?.[0]?.["@type"];
      if (type) schemas.push(Array.isArray(type)? type[0] : type);
    } catch {}
  });

  const hasFAQ = schemas.includes("FAQPage");
  const hasHowTo = schemas.includes("HowTo");
  const hasSchemaMarkup = schemas.length > 0;
  const hasDirectAnswer = bodyText.includes("Q:") && bodyText.includes("A:");

  // Open Graph
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDescription = $('meta[property="og:description"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");
  const hasOGTags =!!(ogTitle && ogDescription);

  // Social Media
  const socialLinks = $("a[href]").map((i, el) => $(el).attr("href")).get();
  const hasFacebook = socialLinks.some(link => link.includes("facebook.com"));
  const hasLinkedIn = socialLinks.some(link => link.includes("linkedin.com"));
  const hasYouTube = socialLinks.some(link => link.includes("youtube.com"));
  const hasTwitter = socialLinks.some(link => link.includes("twitter.com") || link.includes("x.com"));

  // Contact Info
  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = bodyText.match(/(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const hasEmail =!!emailMatch;
  const hasPhone =!!phoneMatch;
  const email = emailMatch? emailMatch[0] : null;
  const phone = phoneMatch? phoneMatch[0] : null;

  // Trust Pages
  const allText = bodyText.toLowerCase();
  const hasPrivacyPolicy = allText.includes("privacy policy") || allText.includes("privacy");
  const hasAboutPage = allText.includes("about us") || allText.includes("about");
  const hasContactPage = allText.includes("contact us") || allText.includes("contact");

  // Content Structure
  const h1Count = $("h1").length;
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const listCount = $("ul, ol").length;
  const tableCount = $("table").length;

  // Author Detection
  const authorSelectors = ['.author', '.byline', '[rel="author"]', '[class*="author"]', '[itemprop="author"]'];
  let hasAuthor = false;
  authorSelectors.forEach(sel => {
    if ($(sel).length > 0) hasAuthor = true;
  });

  // Dates
  const dates = extractDates($);
  const lastModified = dates.modified? dates.modified.toLocaleDateString() : dates.published? dates.published.toLocaleDateString() : null;

  // Brand Mentions
  const brandMentions = countBrandMentions(bodyText, brandName);

  // Internal Linking
  const internalLinkData = analyzeInternalLinks($, url);

  // Keywords
  const keywords = extractKeywordsFromContent(bodyText, 15);

  // Scores
  let seoScore = 100;
  const tips = [];
  const criticalIssues = [];
  const importantIssues = [];
  const minorIssues = [];

  if (!title) { seoScore -= 10; criticalIssues.push("Title tag missing"); }
  if (title.length > 60) { seoScore -= 5; importantIssues.push("Title too long (>60 chars)"); }
  if (!metaDescription) { seoScore -= 10; criticalIssues.push("Meta description missing"); }
  if (!h1) { seoScore -= 10; criticalIssues.push("H1 tag missing"); }
  if (imagesWithoutAlt > 0) { seoScore -= 5; importantIssues.push(`${imagesWithoutAlt} images missing ALT text`); }
  if (!isHttps) { seoScore -= 15; criticalIssues.push("Site not using HTTPS"); }
  if (!mobileViewport) { seoScore -= 10; criticalIssues.push("Mobile viewport not set"); }
  if (loadTime > 3000) { seoScore -= 10; importantIssues.push("Slow load time (>3s)"); }
  if (brokenLinks > 0) { seoScore -= 5; importantIssues.push(`${brokenLinks} broken links found`); }
  if (!hasSchemaMarkup) { seoScore -= 10; importantIssues.push("No schema markup found"); }
  if (!robotsExists) { seoScore -= 5; minorIssues.push("robots.txt missing"); }
  if (!sitemapExists) { seoScore -= 5; minorIssues.push("sitemap.xml missing"); }
  if (!hasCanonical) { seoScore -= 5; importantIssues.push("Canonical URL missing"); }
  if (!hasFavicon) { seoScore -= 3; minorIssues.push("Favicon missing"); }

  seoScore = Math.max(0, seoScore);
  const seoStatus = seoScore >= 80? "Excellent" : seoScore >= 60? "Good" : seoScore >= 40? "Fair" : "Poor";

  // AEO Score
  let aeoScore = 0;
  if (hasFAQ) aeoScore += 30;
  if (hasHowTo) aeoScore += 20;
  if (hasDirectAnswer) aeoScore += 25;
  if (hasSchemaMarkup) aeoScore += 15;
  if (h1 && metaDescription) aeoScore += 10;
  const aeoStatus = aeoScore >= 80? "ChatGPT Ready" : aeoScore >= 50? "AI Friendly" : "Needs Work";

  // EEAT Score
  const eeatData = calculateEEATScore($, {
    hasAuthor, hasContactPage, hasAboutPage, hasPrivacyPolicy,
    hasFacebook, hasLinkedIn, hasYouTube, hasTwitter,
    isHttps, hasEmail, hasPhone, lastModified
  });

  // Freshness Score
  const freshnessData = calculateFreshnessScore(dates);

  // Zero Click Score
  const zeroClickData = calculateZeroClickScore({
    hasDirectAnswer, hasFAQ, listCount, tableCount, h2Count, hasHowTo
  });

  // Content Structure Score
  let contentStructureScore = 0;
  if (h1Count === 1) contentStructureScore += 20;
  if (h2Count >= 3) contentStructureScore += 20;
  if (h3Count >= 5) contentStructureScore += 20;
  if (listCount >= 2) contentStructureScore += 20;
  if (tableCount >= 1) contentStructureScore += 20;

  // Readability Score (simplified)
  const avgWordsPerSentence = wordCount / (bodyText.split(/[.!?]+/).length || 1);
  let readabilityScore = 100;
  if (avgWordsPerSentence > 25) readabilityScore -= 30;
  else if (avgWordsPerSentence > 20) readabilityScore -= 15;
  const readabilityStatus = readabilityScore >= 70? "Easy" : readabilityScore >= 50? "Medium" : "Hard";

  // AI Trust Score
  const aiTrustScore = Math.round((eeatData.score * 0.4) + (seoScore * 0.3) + (aeoScore * 0.3));

  // AI Visibility Score
  const aiVisibilityScore = Math.round(
    (seoScore * 0.25) +
    (aeoScore * 0.25) +
    (aiTrustScore * 0.2) +
    (readabilityScore * 0.15) +
    (schemas.length * 3)
  );

  const aiVisibilityLevel = aiVisibilityScore >= 80? "Excellent - AI Search Ready" :
                           aiVisibilityScore >= 60? "Good - Needs Minor Fixes" :
                           aiVisibilityScore >= 40? "Fair - Major Improvements Needed" :
                           "Poor - Not AI Ready";

  // Citation Probability
  const citationChatGPT = Math.min(95, Math.round((aeoScore * 0.4) + (aiTrustScore * 0.3) + (hasFAQ? 20 : 0) + (hasDirectAnswer? 10 : 0)));
  const citationGemini = Math.min(95, Math.round((aeoScore * 0.4) + (seoScore * 0.3) + (hasSchemaMarkup? 20 : 0) + (hasAuthor? 10 : 0)));
  const citationPerplexity = Math.min(95, Math.round((aiTrustScore * 0.4) + (eeatData.score * 0.3) + (hasDirectAnswer? 20 : 0) + (freshnessData.score * 0.1)));

  // Overall AI Visibility
  const overallAIVisibility = Math.round(
    (seoScore * 0.2) +
    (aeoScore * 0.2) +
    (aiTrustScore * 0.2) +
    (Math.round((citationChatGPT + citationGemini + citationPerplexity) / 3) * 0.4)
  );

  // AI Extracted Answer
  let aiExtractedAnswer = "No clear answer found";
  const firstParagraph = $("p").first().text().trim();
  if (firstParagraph && firstParagraph.length > 50) {
    aiExtractedAnswer = firstParagraph.substring(0, 300) + "...";
  }
  if (hasDirectAnswer) {
    const qaMatch = bodyText.match(/Q:\s*([^?]+\?)\s*A:\s*([^Q]+)/i);
    if (qaMatch) {
      aiExtractedAnswer = `Q: ${qaMatch[1]}\nA: ${qaMatch[2].substring(0, 200)}...`;
    }
  }

  // Answer Quality
  const answerQualityChecks = [];
  let answerQuality = 0;
  if (firstParagraph.length > 100) { answerQuality += 25; answerQualityChecks.push("✓ Answer >100 chars"); }
  else { answerQualityChecks.push("✗ Answer too short"); }
  if (h1 && firstParagraph.toLowerCase().includes(h1.toLowerCase().split(' ')[0])) {
    answerQuality += 25; answerQualityChecks.push("✓ Matches query intent");
  } else {
    answerQualityChecks.push("✗ Doesn't match query");
  }
  if (listCount > 0 || tableCount > 0) {
    answerQuality += 25; answerQualityChecks.push("✓ Has lists/tables");
  } else {
    answerQualityChecks.push("✗ No structured data");
  }
  if (hasFAQ || hasHowTo) {
    answerQuality += 25; answerQualityChecks.push("✓ Has FAQ/HowTo schema");
  } else {
    answerQualityChecks.push("✗ No schema markup");
  }

  // Auto FAQ
  const autoFAQ = [];
  $("h2, h3").slice(0, 3).each((i, el) => {
    const question = $(el).text().trim();
    if (question && question.length > 10) {
      const nextP = $(el).next("p").text().trim();
      if (nextP) {
        autoFAQ.push({ q: question, a: nextP.substring(0, 150) + "..." });
      }
    }
  });

  // SERP Preview
  const serpPreview = {
    title: title || "No title",
    displayUrl: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    description: metaDescription || bodyText.substring(0, 160) + "..."
  };

  // Mobile vs Desktop Score (simplified - mobile penalty if no viewport)
  const mobileScore = mobileViewport? seoScore : Math.max(0, seoScore - 20);
  const desktopScore = seoScore;

  // Topic Authority
  const topicAuthority = {
    mainTopic: h1 || title.split(' ').slice(0, 3).join(' '),
    found: keywords.slice(0, 5),
    missing: ['guide', 'tutorial', 'examples', 'best practices', 'comparison'].filter(k =>!bodyText.toLowerCase().includes(k))
  };

  // Business Value
  const businessValue = {
    trafficIncrease: `+${Math.round((100 - seoScore) * 0.5)}% potential`,
    leadsIncrease: `+${Math.round((100 - aeoScore) * 0.3)}% potential`,
    revenueImpact: `$${Math.round((100 - overallAIVisibility) * 50)}-${Math.round((100 - overallAIVisibility) * 100)}/month`
  };

  // Schema Coverage
  const schemaCoverage = Math.min(100, schemas.length * 20);

  // AI Report
  let aiReport = `SEO Score: ${seoScore}/100 (${seoStatus})\n`;
  aiReport += `AEO Score: ${aeoScore}/100 (${aeoStatus})\n`;
  aiReport += `AI Visibility: ${aiVisibilityScore}/100 (${aiVisibilityLevel})\n\n`;
  if (criticalIssues.length > 0) aiReport += `Critical Issues:\n${criticalIssues.map(i => `• ${i}`).join('\n')}\n\n`;
  if (importantIssues.length > 0) aiReport += `Important Issues:\n${importantIssues.map(i => `• ${i}`).join('\n')}\n\n`;
  aiReport += `Strengths:\n`;
  if (isHttps) aiReport += `• HTTPS enabled\n`;
  if (hasSchemaMarkup) aiReport += `• Schema markup present\n`;
  if (hasFAQ) aiReport += `• FAQ schema for AI citations\n`;
  if (hasAuthor) aiReport += `• Author attribution (EEAT)\n`;
  if (mobileViewport) aiReport += `• Mobile friendly\n`;

  // Citation Simulator
  const citationSimulator = hasFAQ
   ? `ChatGPT will likely quote: "${h1 || title}" - ${metaDescription || firstParagraph.substring(0, 100)}...`
    : "Add FAQ schema to increase AI citation chances";

  // Instant Fixes
  const instantFixes = [];
  if (!metaDescription) instantFixes.push("Add Meta Description");
  if (imagesWithoutAlt > 0) instantFixes.push("Add ALT Text to Images");
  if (!hasFAQ) instantFixes.push("Add FAQ Schema");
  if (!hasAuthor) instantFixes.push("Add Author Bio");
  if (!hasCanonical) instantFixes.push("Add Canonical URL");
  if (!robotsExists) instantFixes.push("Create robots.txt");
  if (!sitemapExists) instantFixes.push("Create sitemap.xml");
  if (!hasOGTags) instantFixes.push("Add Open Graph Tags");

  // Featured Snippet
  const featuredSnippetChance = Math.round((hasDirectAnswer? 40 : 0) + (hasFAQ? 30 : 0) + (listCount > 0? 20 : 0) + (h2Count >= 3? 10 : 0));
  const snippetReasons = [];
  if (hasDirectAnswer) snippetReasons.push("Direct Q&A format found");
  if (hasFAQ) snippetReasons.push("FAQ schema present");
  if (listCount > 0) snippetReasons.push(`${listCount} lists found`);
  if (h2Count >= 3) snippetReasons.push("Good heading structure");
  if (snippetReasons.length === 0) snippetReasons.push("No snippet-friendly content");

  // AEO Readiness
  const aeoReadiness = Math.round((hasFAQ? 25 : 0) + (hasHowTo? 20 : 0) + (hasDirectAnswer? 20 : 0) + (hasSchemaMarkup? 15 : 0) + (hasAuthor? 10 : 0) + (lastModified? 10 : 0));
  const aeoSignals = [];
  if (hasFAQ) aeoSignals.push("✓ FAQ Schema");
  else aeoSignals.push("✗ FAQ Schema Missing");
  if (hasHowTo) aeoSignals.push("✓ HowTo Schema");
  else aeoSignals.push("✗ HowTo Schema Missing");
  if (hasAuthor) aeoSignals.push("✓ Author Bio");
  else aeoSignals.push("✗ Author Bio Missing");
  if (lastModified) aeoSignals.push("✓ Last Updated Date");
  else aeoSignals.push("✗ Last Updated Date Missing");
  if (hasDirectAnswer) aeoSignals.push("✓ Direct Answer Format");
  else aeoSignals.push("✗ No Direct Answer");

  // Fix Suggestions
  const fixSuggestions = [];
  if (!metaDescription) {
    fixSuggestions.push({
      problem: "Meta Description Missing",
      solution: "Add meta description tag",
      code: `<meta name="description" content="${h1 || title} - ${bodyText.substring(0, 120)}...">`
    });
  }
  if (imagesWithoutAlt > 0) {
    fixSuggestions.push({
      problem: `${imagesWithoutAlt} Images Missing ALT Text`,
      solution: "Add descriptive ALT attributes",
      code: `<img src="image.jpg" alt="Descriptive text about the image" />`
    });
  }
  if (!hasFAQ) {
    fixSuggestions.push({
      problem: "FAQ Schema Missing",
      solution: "Add FAQPage JSON-LD schema",
      code: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [{
    "@type": "Question",
    "name": "What is ${h1}?",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "${firstParagraph.substring(0, 150)}"
    }
  }]
}
</script>`
    });
  }

  // Real Citation Scores (based on actual content)
  const realCitationChatGPT = Math.min(95, citationChatGPT + (hasFAQ? 5 : 0) + (hasDirectAnswer? 5 : 0));
  const realCitationGemini = Math.min(95, citationGemini + (hasSchemaMarkup? 5 : 0) + (hasAuthor? 5 : 0));
  const realCitationPerplexity = Math.min(95, citationPerplexity + (eeatData.score > 70? 5 : 0) + (freshnessData.score > 70? 5 : 0));

  const citationReasons = [];
  if (hasFAQ) citationReasons.push("FAQ schema increases citation probability");
  if (hasAuthor) citationReasons.push("Author bio boosts EEAT signals");
  if (hasDirectAnswer) citationReasons.push("Direct Q&A format is AI-friendly");
  if (lastModified) citationReasons.push("Fresh content is preferred by AI");
  if (hasSchemaMarkup) citationReasons.push("Structured data helps AI extraction");

  // AI Search Simulation
  const aiSearchSimulation = await getAISearchSimulation({
    url, title, h1, metaDescription, aiExtractedAnswer
  });

  return {
    url, title, h1, metaDescription, wordCount, lastModified,
    score: seoScore, status: seoStatus,
    totalImages, imagesWithoutAlt, internalLinks, externalLinks,
    mobileFriendly: mobileViewport, isHttps, loadTime,
    brokenLinks, hasSchemaMarkup, robotsExists, sitemapExists,
    hasCanonical, canonical, hasFavicon, favicon,
    hasOGTags, ogTitle, ogDescription, ogImage,
    hasFacebook, hasLinkedIn, hasYouTube, hasTwitter,
    hasEmail, hasPhone, email, phone,
    aeoScore, aeoStatus, hasFAQ, hasHowTo, hasDirectAnswer, schemas,
    keywords, tips, criticalIssues, importantIssues, minorIssues,
    aiReport, citationSimulator, instantFixes,
    readabilityScore, readabilityStatus, hasAuthor,
    aiTrustScore, aiTrustSignals: eeatData.signals,
    hasPrivacyPolicy, hasAboutPage, hasContactPage,
    featuredSnippetChance, snippetReasons,
    contentStructureScore, h1Count, h2Count, h3Count, listCount, tableCount,
    overallAIVisibility, citationChatGPT, citationGemini, citationPerplexity,
    aiExtractedAnswer, answerQuality, answerQualityChecks,
    autoFAQ, serpPreview, mobileScore, desktopScore,
    topicAuthority, businessValue, aiVisibilityScore, aiVisibilityLevel, schemaCoverage,
    aeoReadiness, aeoSignals, fixSuggestions,
    realCitationChatGPT, realCitationGemini, realCitationPerplexity,
    citationReasons, aiSearchSimulation
  };
}

// ========== API ENDPOINTS ==========
const scanHistory = [];
app.get("/analyze", async (req, res) => {
  const url = req.query.url;
  const competitor = req.query.competitor;

  if (!url || !competitor) {
    return res.status(400).json({ error: "Both URL and competitor required" });
  }

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http') ? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http') ? competitor : 'https://' + competitor)
    ]);

    const yourKeywords = new Set(userData.keywords || []);
    const compKeywords = compData.keywords || [];

    const missing = compKeywords.filter(k => !yourKeywords.has(k));
    const shared = compKeywords.filter(k => yourKeywords.has(k));

    res.json({
      yourUrl: userData.url,
      competitorUrl: compData.url,
      topCompetitorKeywords: compKeywords.slice(0, 15),
      yourKeywords: userData.keywords.slice(0, 10),
      missingKeywords: missing.slice(0, 10),
      sharedKeywords: shared.slice(0, 5),
      opportunity: `${missing.length} keywords you can target`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/compare", async (req, res) => {
  const urls = req.query.urls? req.query.urls.split(',') : [];
  if (urls.length < 2) return res.status(400).json({ error: "At least 2 URLs required" });

  try {
    const results = await Promise.all(
      urls.map(u => analyzeSingleUrl(u.startsWith('http')? u : 'https://' + u))
    );

    const comparison = {
      sites: results.map(r => ({
        url: r.url,
        brand: getBrandName(r.url),
        aiVisibilityScore: r.aiVisibilityScore,
        seoScore: r.score,
        aeoScore: r.aeoScore,
        eeatScore: r.aiTrustScore,
        freshnessScore: r.freshnessScore || 0
      })),
      winner: results.reduce((prev, curr) =>
        curr.aiVisibilityScore > prev.aiVisibilityScore? curr : prev
      )
    };

    res.json(comparison);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/gap-analysis", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) return res.status(400).json({ error: "Both URL and competitor required" });

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const gaps = {
      competitor: {
        url: compData.url,
        brand: getBrandName(compData.url),
        has: []
      },
      you: {
        url: userData.url,
        brand: getBrandName(userData.url),
        missing: []
      }
    };

    // Check various factors
    const checks = [
      { key: 'hasFAQ', label: 'FAQ Schema' },
      { key: 'hasHowTo', label: 'HowTo Schema' },
      { key: 'hasAuthor', label: 'Author Bio' },
      { key: 'hasDirectAnswer', label: 'Direct Answer Format' },
      { key: 'hasSchemaMarkup', label: 'Schema Markup' },
      { key: 'hasOGTags', label: 'Open Graph Tags' },
      { key: 'hasPrivacyPolicy', label: 'Privacy Policy' },
      { key: 'hasAboutPage', label: 'About Page' },
      { key: 'hasContactPage', label: 'Contact Page' }
    ];

    checks.forEach(check => {
      if (compData[check.key]) {
        gaps.competitor.has.push(check.label);
      }
      if (compData[check.key] &&!userData[check.key]) {
        gaps.you.missing.push(check.label);
      }
    });

    res.json(gaps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/roadmap", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);
    const roadmap = [];
    let step = 1;

    // Priority order based on impact
    if (!data.hasFAQ) {
      roadmap.push({
        step: step++,
        priority: "CRITICAL",
        task: "Add FAQ Schema",
        impact: "+15 AI Citation Score",
        effort: "Low (15 mins)",
        code: "JSON-LD FAQPage schema",
        why: "ChatGPT/Gemini prioritize FAQ content for direct answers"
      });
    }

    if (!data.hasAuthor) {
      roadmap.push({
        step: step++,
        priority: "HIGH",
        task: "Add Author Bio Section",
        impact: "+12 EEAT Score",
        effort: "Low (10 mins)",
        code: "<div class='author'>Written by [Name], [Credentials]</div>",
        why: "Google EEAT requires author attribution for trust signals"
      });
    }

    if (!data.hasDirectAnswer) {
      roadmap.push({
        step: step++,
        priority: "HIGH",
        task: "Add Direct Answer Format",
        impact: "+20 Featured Snippet Chance",
        effort: "Medium (30 mins)",
        code: "Q: What is [topic]?\nA: [50-word answer]",
        why: "AI search extracts direct Q&A format first"
      });
    }

    if (!data.lastModified) {
      roadmap.push({
        step: step++,
        priority: "MEDIUM",
        task: "Add Last Updated Date",
        impact: "+10 Freshness Score",
        effort: "Low (5 mins)",
        code: '<meta property="article:modified_time" content="2024-01-15">',
        why: "AI prefers recently updated content"
      });
    }

    if (data.readabilityScore < 60) {
      roadmap.push({
        step: step++,
        priority: "MEDIUM",
        task: "Improve Readability",
        impact: "+15 Readability Score",
        effort: "Medium (45 mins)",
        code: "Shorter sentences, bullet points, simple words",
        why: "AI citations favor easy-to-parse content"
      });
    }

    if (!data.hasSchemaMarkup) {
      roadmap.push({
        step: step++,
        priority: "HIGH",
        task: "Add Article/Organization Schema",
        impact: "+10 SEO + AEO Score",
        effort: "Low (20 mins)",
        code: "JSON-LD Article schema with author, datePublished",
        why: "Structured data is mandatory for AI visibility"
      });
    }

    if (data.imagesWithoutAlt > 0) {
      roadmap.push({
        step: step++,
        priority: "LOW",
        task: `Add ALT Text to ${data.imagesWithoutAlt} Images`,
        impact: "+5 SEO Score",
        effort: "Low (10 mins)",
        code: '<img src="image.jpg" alt="Descriptive text">',
        why: "Image SEO + accessibility compliance"
      });
    }

    if (!data.hasOGTags) {
      roadmap.push({
        step: step++,
        priority: "MEDIUM",
        task: "Add Open Graph Tags",
        impact: "+8 Social + AI Score",
        effort: "Low (15 mins)",
        code: '<meta property="og:title" content="...">',
        why: "AI uses OG tags for rich results"
      });
    }

    res.json({
      url: data.url,
      currentScore: data.aiVisibilityScore,
      potentialScore: Math.min(100, data.aiVisibilityScore + roadmap.reduce((sum, r) => {
        const impact = parseInt(r.impact.match(/\d+/)[0]);
        return sum + impact;
      }, 0)),
      totalSteps: roadmap.length,
      estimatedTime: roadmap.length * 20 + " mins",
      roadmap
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/content-brief", async (req, res) => {
  const keyword = req.query.keyword;
  if (!keyword) return res.status(400).json({ error: "Keyword required" });

  try {
    const brief = await generateContentBrief(keyword, ai);
    if (!brief) {
      return res.json({
        error: "AI not available. Manual brief:",
        h1: `Complete Guide: ${keyword}`,
        h2s: [
          `What is ${keyword}?`,
          `Why ${keyword} Matters in 2024`,
          `How to Implement ${keyword}`,
          `${keyword} Best Practices`,
          `Common ${keyword} Mistakes to Avoid`
        ],
        faqs: [
          { q: `What is ${keyword}?`, a: `${keyword} is...` },
          { q: `How does ${keyword} work?`, a: `${keyword} works by...` },
          { q: `Why is ${keyword} important?`, a: `${keyword} is important because...` }
        ],
        schemaType: "Article"
      });
    }
    res.json(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/keyword-theft", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) return res.status(400).json({ error: "Both URL and competitor required" });

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const yourKeywords = new Set(userData.keywords);
    const compKeywords = compData.keywords;

    const missing = compKeywords.filter(k =>!yourKeywords.has(k));
    const shared = compKeywords.filter(k => yourKeywords.has(k));

    res.json({
      yourUrl: userData.url,
      competitorUrl: compData.url,
      topCompetitorKeywords: compKeywords.slice(0, 15),
      yourKeywords: userData.keywords.slice(0, 10),
      missingKeywords: missing.slice(0, 10),
      sharedKeywords: shared.slice(0, 5),
      opportunity: `${missing.length} keywords you can target`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// History endpoint (in-memory for now)
const scanHistory = [];

app.get("/history", (req, res) => {
  res.json(scanHistory.slice(-20).reverse());
});

// Save to history after each scan
const originalAnalyze = app._router.stack.find(r => r.route && r.route.path === '/analyze');
if (originalAnalyze) {
  const oldHandler = originalAnalyze.route.stack[0].handle;
  originalAnalyze.route.stack[0].handle = async (req, res) => {
    const result = await oldHandler(req, res);
    return result;
  };
}

app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform running on port ${PORT}`);
  console.log(`📊 Features: Competitor Compare, EEAT, Roadmap, Gap Finder, Keyword Theft`);
});
