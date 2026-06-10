import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;
const scanHistory = [];

app.use(cors());
app.use(express.json());
app.use(express.static("."));
app.use(express.static("public"));

// ========== CRASH-PROOF HELPERS ==========
async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 10000);

    const res = await fetch(url, {
    ...options,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SEO-AEO-Bot/1.0)",...options.headers },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    console.error(`Fetch failed for ${url}:`, e.message);
    return "";
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

function getBrandName(url) {
  const domain = extractDomain(url);
  const brand = domain.split('.')[0] || 'unknown';
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function getKeywordDifficulty(keyword) {
  const len = keyword.length;
  if (len < 10) return "High";
  if (len < 18) return "Medium";
  return "Low";
}

function getKeywordOpportunity(keyword, hasFAQ, hasSchema) {
  let score = 0;
  if (hasFAQ) score++;
  if (hasSchema) score++;
  if (keyword.split(' ').length > 2) score++;

  if (score >= 2) return "High";
  if (score === 1) return "Medium";
  return "Low";
}

function extractKeywordsFromContent(text, headings = "", topN = 10) {
  if (!text) return [];

  const stopWords = [
    'about', 'https', 'website', 'click', 'here', 'their', 'there', 'which', 'would',
    'function', 'return', 'const', 'document', 'window', 'typeof', 'undefined', 'null',
    'true', 'false', 'this', 'that', 'with', 'from', 'have', 'your', 'will', 'been',
    'foreach', 'classlist', 'addeventlistener', 'javascript', 'button', 'var', 'let'
  ];

  const headingText = String(headings || "").toLowerCase();
  const combinedText = headingText + ' ' + headingText + ' ' + headingText + ' ' + text.toLowerCase();

  const words = combinedText
 .replace(/[^\w\s]/g, ' ')
 .split(/\s+/)
 .filter(w => w.length > 4 &&!stopWords.includes(w));

  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);

  return Object.entries(freq)
 .sort((a, b) => b[1] - a[1])
 .slice(0, topN)
 .map(([word]) => word);
}

async function analyzeSingleUrl(url) {
  let html = "";
  let $ = null;
  let loadTime = 0;
  let title = "";
  let h1 = "";
  let metaDescription = "";
  let bodyText = "";
  let wordCount = 0;
  let totalImages = 0;
  let imagesWithoutAlt = 0;
  let internalLinks = 0;
  let externalLinks = 0;
  let isHttps = url.startsWith("https://");
  let mobileViewport = false;
  let canonical = "";
  let hasCanonical = false;
  let favicon = "";
  let hasFavicon = false;
  let robotsExists = false;
  let sitemapExists = false;
  let brokenLinks = 0;
  let schemas = [];
  let hasFAQ = false;
  let hasHowTo = false;
  let hasSchemaMarkup = false;
  let hasDirectAnswer = false;
  let ogTitle = "";
  let ogDescription = "";
  let ogImage = "";
  let hasOGTags = false;
  let hasFacebook = false;
  let hasLinkedIn = false;
  let hasYouTube = false;
  let hasTwitter = false;
  let hasEmail = false;
  let hasPhone = false;
  let email = null;
  let phone = null;
  let hasPrivacyPolicy = false;
  let hasAboutPage = false;
  let hasContactPage = false;
  let h1Count = 0;
  let h2Count = 0;
  let h3Count = 0;
  let listCount = 0;
  let tableCount = 0;
  let hasAuthor = false;
  let hasLastModified = false;
  let lastModified = null;
  let readabilityScore = 50;
  let aiReport = "Rule-based analysis complete";
  let faqQuestions = [];
  let keywords = [];
  let keywordInsights = [];

  try {
    const startTime = Date.now();
    html = await safeFetch(url);
    loadTime = Date.now() - startTime;
    if (!html) throw new Error("Empty HTML response");

    $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript, svg').remove();

    try { title = $("title").text().trim(); } catch {}
    try { h1 = $("h1").first().text().trim(); } catch {}
    try { metaDescription = $('meta[name="description"]').attr("content") || ""; } catch {}
    try { bodyText = $("p, li, h2, h3, h4, td").text().replace(/\s+/g, " ").trim(); } catch {}
    try { wordCount = bodyText.split(/\s+/).filter(Boolean).length; } catch {}

    let h1Text = "";
    let h2Texts = "";
    try { h1Text = $("h1").first().text(); } catch {}
    try { h2Texts = $("h2").map((i, el) => $(el).text()).get().join(' '); } catch {}
    const headings = h1Text + ' ' + h2Texts;

    faqQuestions = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'FAQPage') {
          json.mainEntity?.forEach(q => {
            if (q.name) faqQuestions.push(q.name);
          });
        }
        const type = json["@type"] || json["@graph"]?.[0]?.["@type"];
        if (type) schemas.push(Array.isArray(type)? type[0] : type);
      } catch {}
    });

    hasFAQ = faqQuestions.length > 0 || schemas.includes("FAQPage");
    hasHowTo = schemas.includes("HowTo");
    hasSchemaMarkup = schemas.length > 0;

    keywords = extractKeywordsFromContent(bodyText, headings, 15);
    keywordInsights = keywords.slice(0, 5).map(k => ({
      keyword: k,
      difficulty: getKeywordDifficulty(k),
      opportunity: getKeywordOpportunity(k, hasFAQ, hasSchemaMarkup)
    }));

    try {
      const images = $("img");
      totalImages = images.length;
      imagesWithoutAlt = images.filter((i, el) =>!$(el).attr("alt")).length;
    } catch {}

    try {
      internalLinks = $("a[href^='/'], a[href^='" + url + "']").length;
      externalLinks = $("a[href^='http']").not(`a[href^='${url}']`).length;
    } catch {}

    try { mobileViewport = $('meta[name="viewport"]').length > 0; } catch {}
    try { canonical = $('link[rel="canonical"]').attr("href") || ""; hasCanonical =!!canonical; } catch {}
    try { favicon = $('link[rel="icon"], link[rel="shortcut icon"]').attr("href") || ""; hasFavicon =!!favicon; } catch {}

    try {
      const robotsHtml = await safeFetch(new URL("/robots.txt", url).href);
      robotsExists = robotsHtml.length > 0;
    } catch {}

    try {
      const sitemapHtml = await safeFetch(new URL("/sitemap.xml", url).href);
      sitemapExists = sitemapHtml.length > 0;
    } catch {}

    hasDirectAnswer = bodyText.includes("Q:") && bodyText.includes("A:");

    try {
      ogTitle = $('meta[property="og:title"]').attr("content") || "";
      ogDescription = $('meta[property="og:description"]').attr("content") || "";
      ogImage = $('meta[property="og:image"]').attr("content") || "";
      hasOGTags =!!(ogTitle && ogDescription);
    } catch {}

    try {
      const socialLinks = $("a").map((i, el) => $(el).attr("href") || "").get();
      hasFacebook = socialLinks.some(link => link.includes("facebook.com"));
      hasLinkedIn = socialLinks.some(link => link.includes("linkedin.com"));
      hasYouTube = socialLinks.some(link => link.includes("youtube.com"));
      hasTwitter = socialLinks.some(link => link.includes("twitter.com") || link.includes("x.com"));
    } catch {}

    try {
      const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const phoneMatch = bodyText.match(/(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      hasEmail =!!emailMatch;
      hasPhone =!!phoneMatch;
      email = emailMatch? emailMatch[0] : null;
      phone = phoneMatch? phoneMatch[0] : null;
    } catch {}

    try {
      const allText = bodyText.toLowerCase();
      hasPrivacyPolicy = allText.includes("privacy policy") || allText.includes("privacy");
      hasAboutPage = allText.includes("about us") || allText.includes("about");
      hasContactPage = allText.includes("contact us") || allText.includes("contact");
    } catch {}

    try {
      h1Count = $("h1").length;
      h2Count = $("h2").length;
      h3Count = $("h3").length;
      listCount = $("ul, ol").length;
      tableCount = $("table").length;
    } catch {}

    try {
      const authorSelectors = ['.author', '.byline', '[rel="author"]', '[class*="author"]', '[itemprop="author"]'];
      hasAuthor = authorSelectors.some(sel => $(sel).length > 0);
    } catch {}

    try {
      const dateStr = $('meta[property="article:modified_time"]').attr('content') || $('meta[property="article:published_time"]').attr('content');
      if (dateStr) {
        lastModified = new Date(dateStr).toLocaleDateString();
        hasLastModified = true;
      }
    } catch {}

    try {
      const sentences = bodyText.split(/[.!?]+/).length || 1;
      const avgWordsPerSentence = wordCount / sentences;
      if (avgWordsPerSentence > 25) readabilityScore = 30;
      else if (avgWordsPerSentence > 20) readabilityScore = 50;
      else readabilityScore = 80;
    } catch {}

  } catch (mainError) {
    console.error("Analysis error:", mainError.message);
    aiReport = `Partial analysis due to: ${mainError.message}`;
  }

  let seoScore = 100;
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
  if (!hasSchemaMarkup) { seoScore -= 10; importantIssues.push("No schema markup found"); }
  if (!robotsExists) { seoScore -= 5; minorIssues.push("robots.txt missing"); }
  if (!sitemapExists) { seoScore -= 5; minorIssues.push("sitemap.xml missing"); }
  if (!hasCanonical) { seoScore -= 5; importantIssues.push("Canonical URL missing"); }
  if (!hasFavicon) { seoScore -= 3; minorIssues.push("Favicon missing"); }

  seoScore = Math.max(0, seoScore);
  const seoStatus = seoScore >= 80? "Excellent" : seoScore >= 60? "Good" : seoScore >= 40? "Fair" : "Poor";

  let aeoScore = 0;
  if (hasFAQ) aeoScore += 30;
  if (hasHowTo) aeoScore += 20;
  if (hasDirectAnswer) aeoScore += 25;
  if (hasSchemaMarkup) aeoScore += 15;
  if (h1 && metaDescription) aeoScore += 10;
  const aeoStatus = aeoScore >= 80? "ChatGPT Ready" : aeoScore >= 50? "AI Friendly" : "Needs Work";

  let eeatScore = 0;
  if (hasAuthor) eeatScore += 20;
  if (hasContactPage || hasEmail || hasPhone) eeatScore += 15;
  if (hasAboutPage) eeatScore += 15;
  if (hasPrivacyPolicy) eeatScore += 15;
  if (hasFacebook || hasLinkedIn || hasYouTube || hasTwitter) eeatScore += 15;
  if (isHttps) eeatScore += 10;
  if (hasLastModified) eeatScore += 10;

  const aiTrustScore = Math.round((eeatScore * 0.4) + (seoScore * 0.3) + (aeoScore * 0.3));

  const citationChatGPT = Math.min(95, Math.round((aeoScore * 0.4) + (aiTrustScore * 0.3) + (hasFAQ? 20 : 0) + (hasDirectAnswer? 10 : 0)));
  const citationGemini = Math.min(95, Math.round((aeoScore * 0.4) + (seoScore * 0.3) + (hasSchemaMarkup? 20 : 0) + (hasAuthor? 10 : 0)));
  const citationPerplexity = Math.min(95, Math.round((aiTrustScore * 0.4) + (eeatScore * 0.3) + (hasDirectAnswer? 20 : 0)));
  const citationProbability = Math.round((citationChatGPT + citationGemini + citationPerplexity) / 3);

  const overall = Math.round((seoScore + aeoScore + aiTrustScore + citationProbability) / 4);

  const aiVisibilityLevel =
    overall >= 80
   ? "Excellent - AI Search Ready"
      : overall >= 60
   ? "Good - Needs Minor Fixes"
      : overall >= 40
   ? "Fair - Major Improvements Needed"
      : "Poor - Not AI Ready";

  const aiTrustSignals = [];
  if (hasPrivacyPolicy) aiTrustSignals.push("Privacy Policy");
  if (hasAboutPage) aiTrustSignals.push("About Page");
  if (hasContactPage) aiTrustSignals.push("Contact Page");
  if (hasAuthor) aiTrustSignals.push("Author Bio");
  if (isHttps) aiTrustSignals.push("HTTPS Secure");

  const autoFAQ = [];
  if (h1) {
    autoFAQ.push({
      q: `What is ${h1}?`,
      a: metaDescription || bodyText.substring(0, 120)
    });
  }

  // FIX 3: Answer Quality calculation + both names
  const answerQuality = Math.min(100, Math.round(
    (hasDirectAnswer? 30 : 0) +
    (hasFAQ? 25 : 0) +
    (listCount > 0? 15 : 0) +
    (h2Count >= 3? 15 : 0) +
    (readabilityScore * 0.15)
  )) || 50;

  // FIX 2: Mobile vs Desktop scores
  const mobileScore = mobileViewport? seoScore : Math.max(0, seoScore - 20);
  const desktopScore = seoScore;

  return {
    url: url || "",
    title: title || "No title",
    h1: h1 || "",
    metaDescription: metaDescription || "",
    wordCount: wordCount || 0,
    lastModified: lastModified || null,

    score: Number(seoScore) || 0,
    status: seoStatus || "Unknown",

    // FIX 1: Force number, never undefined. Send all 3 names for compatibility
    overall: Number(overall) || 0,
    overallAIVisibilityScore: Number(overall) || 0,
    aiVisibilityScore: Number(overall) || 0,
    aiVisibilityLevel: aiVisibilityLevel || "Poor - Not AI Ready",
    citationProbability: Number(citationProbability) || 0,

    totalImages: totalImages || 0,
    imagesWithoutAlt: imagesWithoutAlt || 0,
    internalLinks: internalLinks || 0,
    externalLinks: externalLinks || 0,

    mobileFriendly: mobileViewport || false,
    isHttps: isHttps || false,
    loadTime: loadTime || 0,
    brokenLinks: brokenLinks || 0,

    // FIX 2: Mobile/Desktop explicit scores
    mobileScore: Number(mobileScore) || 0,
    desktopScore: Number(desktopScore) || 0,

    hasSchemaMarkup: hasSchemaMarkup || false,
    robotsExists: robotsExists || false,
    sitemapExists: sitemapExists || false,
    hasCanonical: hasCanonical || false,

    canonical: canonical || "",
    hasFavicon: hasFavicon || false,
    favicon: favicon || "",

    hasOGTags: hasOGTags || false,
    ogTitle: ogTitle || "",
    ogDescription: ogDescription || "",
    ogImage: ogImage || "",

    aeoScore: Number(aeoScore) || 0,
    aeoStatus: aeoStatus || "Needs Work",

    hasFAQ: hasFAQ || false,
    hasHowTo: hasHowTo || false,
    hasDirectAnswer: hasDirectAnswer || false,

    schemas: schemas || [],
    keywords: keywords || [],
    keywordInsights: keywordInsights || [],

    aiReport: aiReport || "",
    readabilityScore: Number(readabilityScore) || 50,
    aiTrustScore: Number(aiTrustScore) || 0,

    // FIX 3: Answer Quality both names
    answerQuality: Number(answerQuality) || 50,
    answerQualityScore: Number(answerQuality) || 50,

    featuredSnippetChance: Math.round(
      (hasDirectAnswer? 40 : 0) +
      (hasFAQ? 30 : 0) +
      (listCount > 0? 20 : 0) +
      (h2Count >= 3? 10 : 0)
    ),

    contentStructureScore:
      (h1Count === 1? 20 : 0) +
      (h2Count >= 3? 20 : 0) +
      (h3Count >= 5? 20 : 0) +
      (listCount >= 2? 20 : 0) +
      (tableCount >= 1? 20 : 0),

    citationChatGPT: Number(citationChatGPT) || 0,
    citationGemini: Number(citationGemini) || 0,
    citationPerplexity: Number(citationPerplexity) || 0,

    aiExtractedAnswer: bodyText.substring(0, 300) || "No clear answer found",

    topicAuthority: {
      mainTopic: h1 || title.split(" ").slice(0, 3).join(" "),
      found: keywords.slice(0, 5),
      missing: []
    },

    businessValue: {
      trafficIncrease: `+${Math.round((100 - seoScore) * 0.5)}% potential`,
      leadsIncrease: `+${Math.round((100 - aeoScore) * 0.3)}% potential`,
      revenueImpact: `$${Math.round((100 - seoScore) * 50)}-${Math.round((100 - seoScore) * 100)}/month`
    },

    schemaCoverage: Math.min(100, schemas.length * 20),

    aeoReadiness: Math.round(
      (hasFAQ? 25 : 0) +
      (hasHowTo? 20 : 0) +
      (hasDirectAnswer? 20 : 0) +
      (hasSchemaMarkup? 15 : 0) +
      (hasAuthor? 10 : 0) +
      (hasLastModified? 10 : 0)
    ),

    aeoSignals: aiTrustSignals,
    fixSuggestions: [],
    instantFixes: [],

    realCitationChatGPT: citationChatGPT,
    realCitationGemini: citationGemini,
    realCitationPerplexity: citationPerplexity,

    // FIX 2: SERP Preview with null safety
    serpPreview: {
      title: title || "No title",
      displayUrl: url? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : "",
      description: metaDescription || (bodyText? bodyText.substring(0, 160) : "No description available")
    },

    aiSearchSimulation: {
      query: "AI temporarily disabled",
      answer: "Rule-based analysis active. Enable AI API for search simulation.",
      sources: []
    },

    criticalIssues: criticalIssues,
    importantIssues: importantIssues,
    minorIssues: minorIssues,
    autoFAQ: autoFAQ
  };
}

// ========== API ENDPOINTS ==========
app.get("/", (req, res) => {
  res.json({
    status: "running",
    tool: "AI Visibility Platform",
    version: "2.3-unified",
    timestamp: new Date().toISOString()
  });
});

app.get("/analyze", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);

    data.aiSearchSimulation = {
      query: "Processing with AI...",
      answer: "AI analysis queued. Showing rule-based results.",
      sources: ["Rule-based Engine"],
      status: "waiting"
    };

    scanHistory.push({
      url: data.url,
      timestamp: new Date().toISOString(),
      seoScore: data.score,
      aeoScore: data.aeoScore,
      aiVisibilityScore: data.overallAIVisibilityScore
    });

    res.json(data);
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({
      error: "Analysis failed",
      message: err.message,
      fallback: true
    });
  }
});

app.get("/scan", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);

    data.aiSearchSimulation = {
      query: "Processing with AI...",
      answer: "AI analysis queued. Showing rule-based results.",
      sources: ["Rule-based Engine"],
      status: "waiting"
    };

    scanHistory.push({
      url: data.url,
      timestamp: new Date().toISOString(),
      seoScore: data.score,
      aeoScore: data.aeoScore,
      aiVisibilityScore: data.overallAIVisibilityScore
    });

    res.json(data);
  } catch (err) {
    console.error("Scan error:", err);
    res.status(500).json({
      error: "Scan failed",
      message: err.message,
      fallback: true
    });
  }
});

app.get("/gap-analysis", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) {
    return res.status(400).json({ error: "Both URL and competitor required" });
  }

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const gaps = {
      competitor: { url: compData.url, brand: getBrandName(compData.url), has: [] },
      you: { url: userData.url, brand: getBrandName(userData.url), missing: [] }
    };

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
      if (compData[check.key]) gaps.competitor.has.push(check.label);
      if (compData[check.key] &&!userData[check.key]) gaps.you.missing.push(check.label);
    });

    res.json(gaps);
  } catch (err) {
    console.error("Gap analysis error:", err);
    res.status(500).json({ error: "Gap analysis failed", message: err.message });
  }
});

app.get("/roadmap", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);
    const roadmap = [];
    let step = 1;

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

    if (!data.hasLastModified) {
      roadmap.push({
        step: step++,
        priority: "MEDIUM",
        task: "Add Last Updated Date",
        impact: "+10 Freshness Score",
        effort: "Low (5 mins)",
        code: '<meta property="article:modified_time" content="2026-01-15">',
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
      currentScore: data.overallAIVisibilityScore,
      potentialScore: Math.min(100, data.overallAIVisibilityScore + roadmap.reduce((sum, r) => {
        const impact = parseInt(r.impact.match(/\d+/)?.[0] || 0);
        return sum + impact;
      }, 0)),
      totalSteps: roadmap.length,
      estimatedTime: roadmap.length * 20 + " mins",
      roadmap
    });
  } catch (err) {
    console.error("Roadmap error:", err);
    res.status(500).json({ error: "Roadmap generation failed", message: err.message });
  }
});

app.get("/content-brief", async (req, res) => {
  const keyword = req.query.keyword;
  if (!keyword) return res.status(400).json({ error: "Keyword required" });

  res.json({
    h1: `Complete Guide: ${keyword}`,
    h2s: [
      `What is ${keyword}?`,
      `Why ${keyword} Matters in 2026`,
      `How to Implement ${keyword}`,
      `${keyword} Best Practices`,
      `Common ${keyword} Mistakes to Avoid`
    ],
    faqs: [
      { q: `What is ${keyword}?`, a: `${keyword} refers to...` },
      { q: `How does ${keyword} work?`, a: `${keyword} works by...` },
      { q: `Why is ${keyword} important?`, a: `${keyword} is important because...` }
    ],
    schemaType: "Article",
    note: "AI analysis in queue. Showing scripted brief. Enable API for dynamic briefs.",
    status: "waiting"
  });
});

app.get("/keyword-theft", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) return res.status(400).json({ error: "Both URL and competitor required" });

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const compKeywords = compData.keywords || [];
    const yourKeywords = new Set(userData.keywords || []);

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
    console.error("Keyword theft error:", err);
    res.status(500).json({ error: "Keyword analysis failed", message: err.message });
  }
});

app.get("/history", (req, res) => {
  res.json(scanHistory.slice(-20).reverse());
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", ai: "waiting", timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: "Something went wrong. Please try again.",
    fallback: true
  });
});
// ========== AEO ENGINE v2: 4 NEW FEATURES ==========

// 1. REAL CITATION SIMULATION
app.get("/citation-simulation", async (req, res) => {
  const { url, query } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);

    let chatGPTScore = 0;
    let geminiScore = 0;
    let perplexityScore = 0;
    const reasons = [];

    if (data.hasFAQ) { chatGPTScore += 30; reasons.push("FAQ Schema = ChatGPT favorite"); }
    if (data.hasDirectAnswer) { chatGPTScore += 25; reasons.push("Q&A format detected"); }
    if (data.listCount >= 2) { chatGPTScore += 15; reasons.push("Lists = Easy to quote"); }
    if (data.hasAuthor) { chatGPTScore += 10; reasons.push("Author = Trust signal"); }
    if (data.readabilityScore > 70) { chatGPTScore += 20; reasons.push("High readability"); }

    if (data.hasSchemaMarkup) { geminiScore += 25; reasons.push("Schema markup helps Gemini"); }
    if (data.hasLastModified) { geminiScore += 20; reasons.push("Fresh content preferred"); }
    if (data.tableCount > 0) { geminiScore += 20; reasons.push("Tables = Structured data"); }
    if (data.h2Count >= 5) { geminiScore += 15; reasons.push("Good heading structure"); }
    if (data.hasAuthor) { geminiScore += 20; reasons.push("EEAT signals strong"); }

    if (data.hasDirectAnswer) { perplexityScore += 30; reasons.push("Direct answers = Perplexity gold"); }
    if (data.hasLastModified) { perplexityScore += 25; reasons.push("Recent update = Perplexity ranks"); }
    if (data.wordCount > 800) { perplexityScore += 20; reasons.push("Long-form = Authority"); }
    if (data.externalLinks > 3) { perplexityScore += 15; reasons.push("Outbound links = Research"); }
    if (data.listCount > 0) { perplexityScore += 10; reasons.push("Lists extractable"); }

    chatGPTScore = Math.min(100, chatGPTScore);
    geminiScore = Math.min(100, geminiScore);
    perplexityScore = Math.min(100, perplexityScore);

    const avgScore = (chatGPTScore + geminiScore + perplexityScore) / 3;
    const estimatedCitations = Math.round((avgScore / 100) * 50);

    res.json({
      url: data.url,
      query: query || "general topic",
      chatGPTCitationChance: chatGPTScore,
      geminiCitationChance: geminiScore,
      perplexityCitationChance: perplexityScore,
      estimatedCitationsPer1000: estimatedCitations,
      reasoning: reasons.slice(0, 5),
      recommendation: avgScore < 40? "Add FAQ Schema + Direct Answers ASAP" :
                      avgScore < 70? "Improve heading structure + add tables" :
                      "Excellent - Maintain freshness"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. KEYWORD INTENT CLUSTERING
app.get("/intent-cluster", async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: "Keyword required" });

  const kw = keyword.toLowerCase();
  const clusters = {
    informational: [],
    commercial: [],
    transactional: [],
    navigational: []
  };

  if (kw.includes('what') || kw.includes('how') || kw.includes('why') || kw.includes('guide')) {
    clusters.informational.push(`What is ${keyword}?`);
    clusters.informational.push(`How to use ${keyword}?`);
    clusters.informational.push(`${keyword} explained`);
    clusters.informational.push(`${keyword} tutorial for beginners`);
  }

  if (kw.includes('best') || kw.includes('top') || kw.includes('vs') || kw.includes('compare')) {
    clusters.commercial.push(`Best ${keyword} 2026`);
    clusters.commercial.push(`${keyword} vs alternatives`);
    clusters.commercial.push(`Top ${keyword} comparison`);
    clusters.commercial.push(`${keyword} reviews`);
  }

  if (kw.includes('buy') || kw.includes('price') || kw.includes('cost') || kw.includes('deal')) {
    clusters.transactional.push(`Buy ${keyword}`);
    clusters.transactional.push(`${keyword} pricing`);
    clusters.transactional.push(`${keyword} discount`);
    clusters.transactional.push(`${keyword} free trial`);
  }

  if (kw.includes('login') || kw.includes('official') || kw.includes('website')) {
    clusters.navigational.push(`${keyword} official site`);
    clusters.navigational.push(`${keyword} login`);
    clusters.navigational.push(`${keyword} dashboard`);
  }

  if (Object.values(clusters).every(arr => arr.length === 0)) {
    clusters.informational.push(`What is ${keyword}?`);
    clusters.informational.push(`${keyword} guide`);
    clusters.commercial.push(`Best ${keyword}`);
  }

  const primaryIntent = clusters.informational.length? 'informational' :
                        clusters.commercial.length? 'commercial' : 'transactional';

  let aiAnswer = "";
  if (primaryIntent === 'informational') {
    aiAnswer = `${keyword} is a solution that helps users with [specific problem]. It works by [mechanism]. Key benefits include: 1) Benefit one, 2) Benefit two, 3) Benefit three. Best for users who need [use case].`;
  } else if (primaryIntent === 'commercial') {
    aiAnswer = `The best ${keyword} options in 2026 are: 1) Option A - best for beginners, 2) Option B - best value, 3) Option C - enterprise grade. Compare features, pricing, and reviews before choosing.`;
  } else {
    aiAnswer = `You can get ${keyword} starting at $X/month. Free trial available. Click here to start or compare pricing plans.`;
  }

  res.json({
    keyword,
    primaryIntent,
    clusters,
    aiGeneratedAnswer: aiAnswer,
    recommendedContent: primaryIntent === 'informational'? 'Blog post + FAQ Schema' :
                        primaryIntent === 'commercial'? 'Comparison table + Product Schema' :
                        'Landing page + Offer Schema'
  });
});

// 3. COMPETITOR GAP AI SCORING
app.get("/competitor-gap-ai", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const competitorFAQs = compData.faqQuestions || [];
    const yourFAQs = new Set(userData.faqQuestions || []);

    const missingFAQs = competitorFAQs.filter(q =>!yourFAQs.has(q));

    const gapScore = missingFAQs.map(faq => {
      let importance = 50;
      if (faq.toLowerCase().includes('price') || faq.toLowerCase().includes('cost')) importance = 90;
      if (faq.toLowerCase().includes('how') || faq.toLowerCase().includes('what')) importance = 80;
      if (faq.toLowerCase().includes('vs') || faq.toLowerCase().includes('compare')) importance = 85;
      return { question: faq, importance, impact: `+${Math.round(importance/10)}% citation chance` };
    }).sort((a,b) => b.importance - a.importance);

    const schemaGaps = [];
    if (compData.hasFAQ &&!userData.hasFAQ) schemaGaps.push({ schema: 'FAQPage', impact: '+25% ChatGPT' });
    if (compData.hasHowTo &&!userData.hasHowTo) schemaGaps.push({ schema: 'HowTo', impact: '+20% Gemini' });
    if (compData.hasAuthor &&!userData.hasAuthor) schemaGaps.push({ schema: 'Author', impact: '+15% EEAT' });

    res.json({
      yourUrl: userData.url,
      competitorUrl: compData.url,
      totalGaps: gapScore.length,
      criticalGaps: gapScore.filter(g => g.importance >= 80).length,
      missingFAQs: gapScore.slice(0, 10),
      schemaGaps,
      estimatedCitationLoss: `${gapScore.length * 3}%`,
      priorityFix: gapScore[0]?.question || 'Add FAQ Schema first',
      competitorAdvantage: compData.aeoScore > userData.aeoScore?
        `${compData.aeoScore - userData.aeoScore} points ahead` : 'You are ahead'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. CHATGPT-STYLE ANSWER PREDICTION
app.get("/predict-ai-answer", async (req, res) => {
  const { query, url } = req.query;
  if (!query) return res.status(400).json({ error: "Query required" });

  let contextData = null;
  if (url) {
    try {
      contextData = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);
    } catch {}
  }

  const q = query.toLowerCase();
  let predictedAnswer = "";
  let confidence = 50;
  let sources = [];
  let format = "paragraph";

  if (q.includes('what is') || q.includes('define')) {
    format = "definition";
    predictedAnswer = `${query.replace(/what is|define/gi, '').trim()} is [extracted definition from top result]. Key points: 1) Point one, 2) Point two, 3) Point three.`;
    confidence = 75;
    sources = ["FAQ Schema", "H1 tag", "First paragraph"];
  }
  else if (q.includes('how to') || q.includes('how do')) {
    format = "steps";
    predictedAnswer = `To ${query.replace(/how to|how do/gi, '').trim()}:\n1. Step one\n2. Step two\n3. Step three\n\nTip: [extracted from HowTo schema]`;
    confidence = 80;
    sources = ["HowTo Schema", "Numbered lists", "H2 headings"];
  }
  else if (q.includes('best') || q.includes('top')) {
    format = "list";
    predictedAnswer = `The best ${query.replace(/best|top/gi, '').trim()} are:\n1. Option A - [reason]\n2. Option B - [reason]\n3. Option C - [reason]\n\nBased on [criteria].`;
    confidence = 70;
    sources = ["Comparison tables", "Lists", "Review snippets"];
  }
  else if (q.includes('vs') || q.includes('compare')) {
    format = "comparison";
    predictedAnswer = `${query} comparison:\n| Feature | Option A | Option B |\n|---------|----------|----------|\n| Key 1 | Value | Value |\n\nVerdict: [extracted conclusion]`;
    confidence = 65;
    sources = ["Tables", "VS articles", "Comparison sections"];
  }
  else {
    format = "paragraph";
    predictedAnswer = `Based on available data, ${query} involves [extracted summary]. Important factors: [factor 1], [factor 2].`;
    confidence = 60;
    sources = ["Meta description", "H1/H2", "First 100 words"];
  }

  if (contextData) {
    if (contextData.hasFAQ) confidence += 10;
    if (contextData.hasHowTo && q.includes('how')) confidence += 15;
    if (contextData.hasDirectAnswer) confidence += 10;
    sources.push("Your site: " + contextData.url);
  }

  confidence = Math.min(95, confidence);

  res.json({
    query,
    predictedAnswer,
    format,
    confidence,
    sourcesUsed: sources,
    willCiteYou: contextData? (confidence > 70? "High chance" : confidence > 50? "Medium chance" : "Low chance") : "Provide URL to check",
    optimization: confidence < 70? [
      "Add FAQ Schema for this query",
      "Create H2 with exact query text",
      "Add numbered list or table",
      "Put answer in first 100 words"
    ] : ["Content is AI-ready"]
  });
});

// ========== AEO ENGINE v2: 4 NEW FEATURES ==========

// 1. REAL CITATION SIMULATION
app.get("/citation-simulation", async (req, res) => {
  const { url, query } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);

    let chatGPTScore = 0;
    let geminiScore = 0;
    let perplexityScore = 0;
    const reasons = [];

    if (data.hasFAQ) { chatGPTScore += 30; reasons.push("FAQ Schema = ChatGPT favorite"); }
    if (data.hasDirectAnswer) { chatGPTScore += 25; reasons.push("Q&A format detected"); }
    if (data.listCount >= 2) { chatGPTScore += 15; reasons.push("Lists = Easy to quote"); }
    if (data.hasAuthor) { chatGPTScore += 10; reasons.push("Author = Trust signal"); }
    if (data.readabilityScore > 70) { chatGPTScore += 20; reasons.push("High readability"); }

    if (data.hasSchemaMarkup) { geminiScore += 25; reasons.push("Schema markup helps Gemini"); }
    if (data.hasLastModified) { geminiScore += 20; reasons.push("Fresh content preferred"); }
    if (data.tableCount > 0) { geminiScore += 20; reasons.push("Tables = Structured data"); }
    if (data.h2Count >= 5) { geminiScore += 15; reasons.push("Good heading structure"); }
    if (data.hasAuthor) { geminiScore += 20; reasons.push("EEAT signals strong"); }

    if (data.hasDirectAnswer) { perplexityScore += 30; reasons.push("Direct answers = Perplexity gold"); }
    if (data.hasLastModified) { perplexityScore += 25; reasons.push("Recent update = Perplexity ranks"); }
    if (data.wordCount > 800) { perplexityScore += 20; reasons.push("Long-form = Authority"); }
    if (data.externalLinks > 3) { perplexityScore += 15; reasons.push("Outbound links = Research"); }
    if (data.listCount > 0) { perplexityScore += 10; reasons.push("Lists extractable"); }

    chatGPTScore = Math.min(100, chatGPTScore);
    geminiScore = Math.min(100, geminiScore);
    perplexityScore = Math.min(100, perplexityScore);

    const avgScore = (chatGPTScore + geminiScore + perplexityScore) / 3;
    const estimatedCitations = Math.round((avgScore / 100) * 50);

    res.json({
      url: data.url,
      query: query || "general topic",
      chatGPTCitationChance: chatGPTScore,
      geminiCitationChance: geminiScore,
      perplexityCitationChance: perplexityScore,
      estimatedCitationsPer1000: estimatedCitations,
      reasoning: reasons.slice(0, 5),
      recommendation: avgScore < 40? "Add FAQ Schema + Direct Answers ASAP" :
                      avgScore < 70? "Improve heading structure + add tables" :
                      "Excellent - Maintain freshness"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. KEYWORD INTENT CLUSTERING
app.get("/intent-cluster", async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: "Keyword required" });

  const kw = keyword.toLowerCase();
  const clusters = {
    informational: [],
    commercial: [],
    transactional: [],
    navigational: []
  };

  if (kw.includes('what') || kw.includes('how') || kw.includes('why') || kw.includes('guide')) {
    clusters.informational.push(`What is ${keyword}?`);
    clusters.informational.push(`How to use ${keyword}?`);
    clusters.informational.push(`${keyword} explained`);
    clusters.informational.push(`${keyword} tutorial for beginners`);
  }

  if (kw.includes('best') || kw.includes('top') || kw.includes('vs') || kw.includes('compare')) {
    clusters.commercial.push(`Best ${keyword} 2026`);
    clusters.commercial.push(`${keyword} vs alternatives`);
    clusters.commercial.push(`Top ${keyword} comparison`);
    clusters.commercial.push(`${keyword} reviews`);
  }

  if (kw.includes('buy') || kw.includes('price') || kw.includes('cost') || kw.includes('deal')) {
    clusters.transactional.push(`Buy ${keyword}`);
    clusters.transactional.push(`${keyword} pricing`);
    clusters.transactional.push(`${keyword} discount`);
    clusters.transactional.push(`${keyword} free trial`);
  }

  if (kw.includes('login') || kw.includes('official') || kw.includes('website')) {
    clusters.navigational.push(`${keyword} official site`);
    clusters.navigational.push(`${keyword} login`);
    clusters.navigational.push(`${keyword} dashboard`);
  }

  if (Object.values(clusters).every(arr => arr.length === 0)) {
    clusters.informational.push(`What is ${keyword}?`);
    clusters.informational.push(`${keyword} guide`);
    clusters.commercial.push(`Best ${keyword}`);
  }

  const primaryIntent = clusters.informational.length? 'informational' :
                        clusters.commercial.length? 'commercial' : 'transactional';

  let aiAnswer = "";
  if (primaryIntent === 'informational') {
    aiAnswer = `${keyword} is a solution that helps users with [specific problem]. It works by [mechanism]. Key benefits include: 1) Benefit one, 2) Benefit two, 3) Benefit three. Best for users who need [use case].`;
  } else if (primaryIntent === 'commercial') {
    aiAnswer = `The best ${keyword} options in 2026 are: 1) Option A - best for beginners, 2) Option B - best value, 3) Option C - enterprise grade. Compare features, pricing, and reviews before choosing.`;
  } else {
    aiAnswer = `You can get ${keyword} starting at $X/month. Free trial available. Click here to start or compare pricing plans.`;
  }

  res.json({
    keyword,
    primaryIntent,
    clusters,
    aiGeneratedAnswer: aiAnswer,
    recommendedContent: primaryIntent === 'informational'? 'Blog post + FAQ Schema' :
                        primaryIntent === 'commercial'? 'Comparison table + Product Schema' :
                        'Landing page + Offer Schema'
  });
});

// 3. COMPETITOR GAP AI SCORING
app.get("/competitor-gap-ai", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });

  try {
    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const competitorFAQs = compData.faqQuestions || [];
    const yourFAQs = new Set(userData.faqQuestions || []);

    const missingFAQs = competitorFAQs.filter(q =>!yourFAQs.has(q));

    const gapScore = missingFAQs.map(faq => {
      let importance = 50;
      if (faq.toLowerCase().includes('price') || faq.toLowerCase().includes('cost')) importance = 90;
      if (faq.toLowerCase().includes('how') || faq.toLowerCase().includes('what')) importance = 80;
      if (faq.toLowerCase().includes('vs') || faq.toLowerCase().includes('compare')) importance = 85;
      return { question: faq, importance, impact: `+${Math.round(importance/10)}% citation chance` };
    }).sort((a,b) => b.importance - a.importance);

    const schemaGaps = [];
    if (compData.hasFAQ &&!userData.hasFAQ) schemaGaps.push({ schema: 'FAQPage', impact: '+25% ChatGPT' });
    if (compData.hasHowTo &&!userData.hasHowTo) schemaGaps.push({ schema: 'HowTo', impact: '+20% Gemini' });
    if (compData.hasAuthor &&!userData.hasAuthor) schemaGaps.push({ schema: 'Author', impact: '+15% EEAT' });

    res.json({
      yourUrl: userData.url,
      competitorUrl: compData.url,
      totalGaps: gapScore.length,
      criticalGaps: gapScore.filter(g => g.importance >= 80).length,
      missingFAQs: gapScore.slice(0, 10),
      schemaGaps,
      estimatedCitationLoss: `${gapScore.length * 3}%`,
      priorityFix: gapScore[0]?.question || 'Add FAQ Schema first',
      competitorAdvantage: compData.aeoScore > userData.aeoScore?
        `${compData.aeoScore - userData.aeoScore} points ahead` : 'You are ahead'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. CHATGPT-STYLE ANSWER PREDICTION
app.get("/predict-ai-answer", async (req, res) => {
  const { query, url } = req.query;
  if (!query) return res.status(400).json({ error: "Query required" });

  let contextData = null;
  if (url) {
    try {
      contextData = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);
    } catch {}
  }

  const q = query.toLowerCase();
  let predictedAnswer = "";
  let confidence = 50;
  let sources = [];
  let format = "paragraph";

  if (q.includes('what is') || q.includes('define')) {
    format = "definition";
    predictedAnswer = `${query.replace(/what is|define/gi, '').trim()} is [extracted definition from top result]. Key points: 1) Point one, 2) Point two, 3) Point three.`;
    confidence = 75;
    sources = ["FAQ Schema", "H1 tag", "First paragraph"];
  }
  else if (q.includes('how to') || q.includes('how do')) {
    format = "steps";
    predictedAnswer = `To ${query.replace(/how to|how do/gi, '').trim()}:\n1. Step one\n2. Step two\n3. Step three\n\nTip: [extracted from HowTo schema]`;
    confidence = 80;
    sources = ["HowTo Schema", "Numbered lists", "H2 headings"];
  }
  else if (q.includes('best') || q.includes('top')) {
    format = "list";
    predictedAnswer = `The best ${query.replace(/best|top/gi, '').trim()} are:\n1. Option A - [reason]\n2. Option B - [reason]\n3. Option C - [reason]\n\nBased on [criteria].`;
    confidence = 70;
    sources = ["Comparison tables", "Lists", "Review snippets"];
  }
  else if (q.includes('vs') || q.includes('compare')) {
    format = "comparison";
    predictedAnswer = `${query} comparison:\n| Feature | Option A | Option B |\n|---------|----------|----------|\n| Key 1 | Value | Value |\n\nVerdict: [extracted conclusion]`;
    confidence = 65;
    sources = ["Tables", "VS articles", "Comparison sections"];
  }
  else {
    format = "paragraph";
    predictedAnswer = `Based on available data, ${query} involves [extracted summary]. Important factors: [factor 1], [factor 2].`;
    confidence = 60;
    sources = ["Meta description", "H1/H2", "First 100 words"];
  }

  if (contextData) {
    if (contextData.hasFAQ) confidence += 10;
    if (contextData.hasHowTo && q.includes('how')) confidence += 15;
    if (contextData.hasDirectAnswer) confidence += 10;
    sources.push("Your site: " + contextData.url);
  }

  confidence = Math.min(95, confidence);

  res.json({
    query,
    predictedAnswer,
    format,
    confidence,
    sourcesUsed: sources,
    willCiteYou: contextData? (confidence > 70? "High chance" : confidence > 50? "Medium chance" : "Low chance") : "Provide URL to check",
    optimization: confidence < 70? [
      "Add FAQ Schema for this query",
      "Create H2 with exact query text",
      "Add numbered list or table",
      "Put answer in first 100 words"
    ] : ["Content is AI-ready"]
  });
});


app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform running on port ${PORT}`);
  console.log(`📊 Features: Rule-based SEO/AEO Analysis | AI: WAITING MODE`);
});
