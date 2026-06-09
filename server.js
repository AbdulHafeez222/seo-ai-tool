import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 4000;
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

function safeJSONParse(str, fallback = {}) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
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

// ========== MAIN ANALYZE - CRASH PROOF ==========
Bhai abhi bhi 2 error hain kyunki variables `try` block ke andar banaye aur bahar use kar rahe ho. JS me scope ka issue hai.

### *Problem*
try {
  const keywords = extractKeywordsFromContent(...) // ye try ke andar hai
} catch {}

return { keywords: keywords } // yahan undefined error aayega
### *Fix: Variables Upar Declare Karo*

`server.js` me `analyzeSingleUrl` function ke andar ye changes karo:

*1. Function ke top pe ye lines add karo, baaki variables ke saath:*
async function analyzeSingleUrl(url) {
  let html = "";
  let $ = null;
  //... baaki saare let variables

  // ⬇️ YE 2 LINES ADD KARO ⬇️
  let keywords = [];
  let keywordInsights = [];

  let readabilityScore = 50;
  let aiReport = "Rule-based analysis complete";
*2. Phir neeche jahan keywords ban rahe hain wahan `const` hata do:*

Pehle ye tha:
const keywords = extractKeywordsFromContent(bodyText, headings, 15);
const keywordInsights = keywords.slice(0, 5).map(k => ({
Isse replace karo:
keywords = extractKeywordsFromContent(bodyText, headings, 15);
keywordInsights = keywords.slice(0, 5).map(k => ({
### *Full Fixed `analyzeSingleUrl` Function*

Copy-paste kardo poora function:
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
    try { h2Texts = $("h2").map((i,el)=>$(el).text()).get().join(' '); } catch {}
    const headings = h1Text + ' ' + h2Texts;

    const faqQuestions = [];
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
  const aiVisibilityScore = Math.round((seoScore * 0.25) + (aeoScore * 0.25) + (aiTrustScore * 0.2) + (readabilityScore * 0.15) + (schemas.length * 3));
  const aiVisibilityLevel = aiVisibilityScore >= 80? "Excellent - AI Search Ready" : aiVisibilityScore >= 60? "Good - Needs Minor Fixes" : aiVisibilityScore >= 40? "Fair - Major Improvements Needed" : "Poor - Not AI Ready";

  const citationChatGPT = Math.min(95, Math.round((aeoScore * 0.4) + (aiTrustScore * 0.3) + (hasFAQ? 20 : 0) + (hasDirectAnswer? 10 : 0)));
  const citationGemini = Math.min(95, Math.round((aeoScore * 0.4) + (seoScore * 0.3) + (hasSchemaMarkup? 20 : 0) + (hasAuthor? 10 : 0)));
  const citationPerplexity = Math.min(95, Math.round((aiTrustScore * 0.4) + (eeatScore * 0.3) + (hasDirectAnswer? 20 : 0)));

  const tips = [];
  if (!hasFAQ) tips.push("Add FAQ Schema to increase ChatGPT citations");
  if (!hasHowTo) tips.push("Add HowTo Schema for AI answer extraction");
  if (!hasAuthor) tips.push("Add author information to improve EEAT");
  if (!hasLastModified) tips.push("Add Last Updated date");

  const instantFixes = [];
  if (!metaDescription) instantFixes.push("Add Meta Description");
  if (imagesWithoutAlt > 0) instantFixes.push("Add ALT Text to Images");
  if (!hasFAQ) instantFixes.push("Add FAQ Schema");
  if (!hasCanonical) instantFixes.push("Add Canonical URL");

  return {
    url: url || "",
    title: title || "No title",
    h1: h1 || "",
    metaDescription: metaDescription || "",
    wordCount: wordCount || 0,
    lastModified: lastModified || null,
    score: seoScore || 0,
    status: seoStatus || "Unknown",
    totalImages: totalImages || 0,
    imagesWithoutAlt: imagesWithoutAlt || 0,
    internalLinks: internalLinks || 0,
    externalLinks: externalLinks || 0,
    mobileFriendly: mobileViewport || false,
    isHttps: isHttps || false,
    loadTime: loadTime || 0,
    brokenLinks: brokenLinks || 0,
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
    hasFacebook: hasFacebook || false,
    hasLinkedIn: hasLinkedIn || false,
    hasYouTube: hasYouTube || false,
    hasTwitter: hasTwitter || false,
    hasEmail: hasEmail || false,
    hasPhone: hasPhone || false,
    email: email || null,
    phone: phone || null,
    aeoScore: aeoScore || 0,
    aeoStatus: aeoStatus || "Needs Work",
    hasFAQ: hasFAQ || false,
    hasHowTo: hasHowTo || false,
    hasDirectAnswer: hasDirectAnswer || false,
    schemas: schemas || [],
    keywords: keywords || [],
    keywordInsights: keywordInsights || [],
    tips: tips || [],
    criticalIssues: criticalIssues || [],
    importantIssues: importantIssues || [],
    minorIssues: minorIssues || [],
    aiReport: aiReport || "",
    citationSimulator: hasFAQ? `ChatGPT may quote: "${h1 || title}"` : "Add FAQ schema to increase AI citation chances",
    instantFixes: instantFixes || [],
    readabilityScore: readabilityScore || 50,
    readabilityStatus: readabilityScore >= 70? "Easy" : readabilityScore >= 50? "Medium" : "Hard",
    hasAuthor: hasAuthor || false,
    aiTrustScore: aiTrustScore || 0,
    aiTrustSignals: [],
    hasPrivacyPolicy: hasPrivacyPolicy || false,
    hasAboutPage: hasAboutPage || false,
    hasContactPage: hasContactPage || false,
    featuredSnippetChance: Math.round((hasDirectAnswer? 40 : 0) + (hasFAQ? 30 : 0) + (listCount > 0? 20 : 0) + (h2Count >= 3? 10 : 0)),
    snippetReasons: [],
    contentStructureScore: (h1Count === 1? 20 : 0) + (h2Count >= 3? 20 : 0) + (h3Count >= 5? 20 : 0) + (listCount >= 2? 20 : 0) + (tableCount >= 1? 20 : 0),
    h1Count: h1Count || 0,
    h2Count: h2Count || 0,
    h3Count: h3Count || 0,
    listCount: listCount || 0,
    tableCount: tableCount || 0,
    citationChatGPT: citationChatGPT || 0,
    citationGemini: citationGemini || 0,
    citationPerplexity: citationPerplexity || 0,
    aiExtractedAnswer: bodyText.substring(0, 300) || "No clear answer found",
    answerQuality: 50,
    answerQualityChecks: [],
    autoFAQ: [],
    serpPreview: {
      title: title || "No title",
      displayUrl: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      description: metaDescription || bodyText.substring(0, 160) + "..."
    },
    mobileScore: mobileViewport? seoScore : Math.max(0, seoScore - 20),
    desktopScore: seoScore,
    topicAuthority: {
      mainTopic: h1 || title.split(' ').slice(0, 3).join(' '),
      found: keywords.slice(0, 5),
      missing: []
    },
    businessValue: {
      trafficIncrease: `+${Math.round((100 - seoScore) * 0.5)}% potential`,
      leadsIncrease: `+${Math.round((100 - aeoScore) * 0.3)}% potential`,
      revenueImpact: `$${Math.round((100 - seoScore) * 50)}-${Math.round((100 - seoScore) * 100)}/month`
    },
    aiVisibilityScore: aiVisibilityScore || 0,
    aiVisibilityLevel: aiVisibilityLevel || "Poor - Not AI Ready",
    schemaCoverage: Math.min(100, schemas.length * 20),
    aeoReadiness: Math.round((hasFAQ? 25 : 0) + (hasHowTo? 20 : 0) + (hasDirectAnswer? 20 : 0) + (hasSchemaMarkup? 15 : 0) + (hasAuthor? 10 : 0) + (hasLastModified? 10 : 0)),
    aeoSignals: [],
    fixSuggestions: [],
    realCitationChatGPT: citationChatGPT,
    realCitationGemini: citationGemini,
    realCitationPerplexity: citationPerplexity,
    citationReasons: [],
    aiSearchSimulation: {
      query: "AI temporarily disabled",
      answer: "Rule-based analysis active. Enable AI API for search simulation.",
      sources: []
    }
  };
}
*Ab deploy karo.* `ReferenceError: keywords is not defined` khatam ho jayega ✅

// ========== API ENDPOINTS ==========
app.get("/", (req, res) => {
  res.json({
    status: "running",
    tool: "AI Visibility Platform",
    version: "2.0-stable",
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
      aiVisibilityScore: data.aiVisibilityScore
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
      aiVisibilityScore: data.aiVisibilityScore
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
      currentScore: data.aiVisibilityScore,
      potentialScore: Math.min(100, data.aiVisibilityScore + roadmap.reduce((sum, r) => {
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

    const yourKeywords = new Set(userData.keywords);
    const compKeywords = compData.keywords || [];

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

app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform running on port ${PORT}`);
  console.log(`📊 Features: Rule-based SEO/AEO Analysis | AI: WAITING MODE`);
});
