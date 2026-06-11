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

  try {
    const startTime = Date.now();
    html = await safeFetch(url);
    loadTime = Date.now() - startTime;
    if (!html) throw new Error("Empty HTML response");

    $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript, svg').remove();

    // ===== EXTRACT ALL DATA FIRST =====
    const title = $("title").text().trim() || "";
    const h1 = $("h1").first().text().trim() || "";
    const metaDescription = $('meta[name="description"]').attr("content") || "";
    const bodyText = $("p, li, h2, h3, h4, td").text().replace(/\s+/g, " ").trim();
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

    // ===== FIX 1: SCHEMA WITH @graph SUPPORT =====
    const schemas = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const json = JSON.parse(raw);
        const items = Array.isArray(json)? json : [json];

        items.forEach(item => {
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            item['@graph'].forEach(graphItem => {
              if (graphItem['@type']) {
                const types = Array.isArray(graphItem['@type'])? graphItem['@type'] : [graphItem['@type']];
                schemas.push(...types);
              }
            });
          }
          else if (item['@type']) {
            const types = Array.isArray(item['@type'])? item['@type'] : [item['@type']];
            schemas.push(...types);
          }
        });
      } catch (e) {
        console.error('Schema parse error:', e.message);
      }
    });
    const uniqueSchemas = [...new Set(schemas)];

    const faqQuestions = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'FAQPage') {
          json.mainEntity?.forEach(q => {
            if (q.name) faqQuestions.push(q.name);
          });
        }
        if (json['@graph']) {
          json['@graph'].forEach(item => {
            if (item['@type'] === 'FAQPage') {
              item.mainEntity?.forEach(q => {
                if (q.name) faqQuestions.push(q.name);
              });
            }
          });
        }
      } catch {}
    });

    const h1Count = $("h1").length;
    const h2Count = $("h2").length;
    const h3Count = $("h3").length;
    const listCount = $("ul, ol").length;
    const tableCount = $("table").length;
    const totalImages = $("img").length;
    const imagesWithoutAlt = $("img").filter((i, el) =>!$(el).attr("alt")).length;
    const internalLinks = $(`a[href^='/'], a[href^='${url}']`).length;
    const externalLinks = $("a[href^='http']").not(`a[href^='${url}']`).length;
    const isHttps = url.startsWith("https://");
    const mobileViewport = $('meta[name="viewport"]').length > 0;
    const canonical = $('link[rel="canonical"]').attr("href") || "";
    const hasCanonical =!!canonical;
    const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').attr("href") || "";
    const hasFavicon =!!favicon;

    // ===== FIX 2: FAQ + DIRECT ANSWER + AUTHOR IMPROVED =====
    const hasFAQ = faqQuestions.length > 0 || uniqueSchemas.includes("FAQPage") || $('[class*="faq"]').length > 0 || $('h2, h3').filter((i, el) => $(el).text().toLowerCase().includes('faq')).length > 0 || $('h2, h3').filter((i, el) => $(el).text().toLowerCase().includes('frequently asked')).length > 0;
    const hasHowTo = uniqueSchemas.includes("HowTo");
    const hasSchemaMarkup = uniqueSchemas.length > 0;
    const hasDirectAnswer = (bodyText.includes("Q:") && bodyText.includes("A:")) || bodyText.toLowerCase().includes("what is") || bodyText.toLowerCase().includes("how to") || bodyText.toLowerCase().includes("why is") || bodyText.toLowerCase().includes("step 1") || bodyText.toLowerCase().includes("step-by-step") || (h2Count >= 3 && bodyText.length > 500);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const ogDescription = $('meta[property="og:description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || "";
    const hasOGTags =!!(ogTitle && ogDescription);

    // ===== FIX 3: AUTHOR DETECTION IMPROVED =====
    const hasAuthor = $('meta[name="author"]').length > 0 || $('[rel="author"]').length > 0 || $('[itemprop="author"]').length > 0 || ['.author', '.byline', '[class*="author"]'].some(sel => $(sel).length > 0);

    const dateStr = $('meta[property="article:modified_time"]').attr('content') || $('meta[property="article:published_time"]').attr('content');
    const hasLastModified =!!dateStr;
    const lastModified = dateStr? new Date(dateStr).toLocaleDateString() : null;

    const socialLinks = $("a").map((i, el) => $(el).attr("href") || "").get();
    const hasFacebook = socialLinks.some(link => link.includes("facebook.com"));
    const hasLinkedIn = socialLinks.some(link => link.includes("linkedin.com"));
    const hasYouTube = socialLinks.some(link => link.includes("youtube.com"));
    const hasTwitter = socialLinks.some(link => link.includes("twitter.com") || link.includes("x.com"));

    const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const phoneMatch = bodyText.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/);
    const email = emailMatch? emailMatch[0] : null;
    const phone = phoneMatch? phoneMatch[0] : null;
    const hasEmail =!!email;
    const hasPhone =!!phone;

    const allText = bodyText.toLowerCase();
    const hasPrivacyPolicy = allText.includes("privacy policy") || allText.includes("privacy");
    const hasAboutPage = allText.includes("about us") || allText.includes("about");
    const hasContactPage = allText.includes("contact us") || allText.includes("contact");

    const sentences = bodyText.split(/[.!?]+/).length || 1;
    const avgWordsPerSentence = wordCount / sentences;
    let readabilityScore = 50;
    if (avgWordsPerSentence > 25) readabilityScore = 30;
    else if (avgWordsPerSentence > 20) readabilityScore = 50;
    else readabilityScore = 80;

    let robotsExists = false;
    let sitemapExists = false;
    try {
      const robotsRes = await fetch(new URL("/robots.txt", url).href, { signal: AbortSignal.timeout(3000) });
      robotsExists = robotsRes.ok;
    } catch {}
    try {
      const sitemapRes = await fetch(new URL("/sitemap.xml", url).href, { signal: AbortSignal.timeout(3000) });
      sitemapExists = sitemapRes.ok;
    } catch {}

    // ===== CALCULATE SCORES - ONLY ONCE =====
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

    // ===== FIX 4: featuredSnippetChance + answerQuality YAHAN SIRF EK BAAR =====
    const featuredSnippetChance = Math.min(
      100,
      (hasDirectAnswer? 40 : 0) +
      (hasFAQ? 30 : 0) +
      (listCount > 0? 20 : 0) +
      (h2Count >= 3? 10 : 0)
    );

    const answerQuality = Math.min(100, Math.round(
      (hasDirectAnswer? 30 : 0) +
      (hasFAQ? 25 : 0) +
      (listCount > 0? 15 : 0) +
      (h2Count >= 3? 15 : 0) +
      (readabilityScore * 0.15)
    )) || 50;

    let eeatScore = 0;
    if (hasAuthor) eeatScore += 20;
    if (hasContactPage || hasEmail || hasPhone) eeatScore += 15;
    if (hasAboutPage) eeatScore += 15;
    if (hasPrivacyPolicy) eeatScore += 15;
    if (hasFacebook || hasLinkedIn || hasYouTube || hasTwitter) eeatScore += 15;
    if (isHttps) eeatScore += 10;
    if (hasLastModified) eeatScore += 10;

    const aiTrustScore = Math.round((eeatScore * 0.4) + (seoScore * 0.3) + (aeoScore * 0.3));

    const citationChatGPT = Math.min(95, 20 + (hasFAQ? 25 : 0) + (listCount > 2? 15 : 0) + (hasDirectAnswer? 20 : 0) + (hasAuthor? 10 : 0));
    const citationGemini = Math.min(95, 20 + (hasSchemaMarkup? 30 : 0) + (tableCount > 0? 20 : 0) + (hasAuthor? 15 : 0) + (wordCount > 800? 15 : 0));
    const citationPerplexity = Math.min(95, 20 + (hasDirectAnswer? 25 : 0) + (hasLastModified? 15 : 0) + (externalLinks > 5? 15 : 0) + (listCount > 0? 15 : 0));
    const citationProbability = Math.round((citationChatGPT + citationGemini + citationPerplexity) / 3);

    const schemaScore = (hasFAQ? 25 : 0) + (hasHowTo? 25 : 0) + (hasDirectAnswer? 20 : 0) + (uniqueSchemas.length > 0? 30 : 0);

    const overallAIVisibilityScore = Math.round(
      (seoScore * 0.30) +
      (aeoScore * 0.20) +
      (aiTrustScore * 0.15) +
      (citationProbability * 0.15) +
      (readabilityScore * 0.10) +
      (schemaScore * 0.10)
    );

    const aiVisibilityLevel = overallAIVisibilityScore >= 80? "Excellent" :
                              overallAIVisibilityScore >= 60? "Good" :
                              overallAIVisibilityScore >= 40? "Fair" : "Needs Work";

    const mobileScore = mobileViewport? seoScore : Math.max(0, seoScore - 20);
    const desktopScore = seoScore;

    const keywords = extractKeywordsFromContent(bodyText, h1 + ' ' + $("h2").map((i, el) => $(el).text()).get().join(' '), 15);
    const keywordInsights = keywords.slice(0, 5).map(k => ({
      keyword: k,
      difficulty: getKeywordDifficulty(k),
      opportunity: getKeywordOpportunity(k, hasFAQ, hasSchemaMarkup)
    }));

    // ===== FIX 5: aiTrustSignals SIRF EK BAAR DECLARE =====
    const aiTrustSignals = [];
    if(hasPrivacyPolicy) aiTrustSignals.push("Privacy Policy");
    if(hasAboutPage) aiTrustSignals.push("About Page");
    if(hasContactPage || hasEmail || hasPhone) aiTrustSignals.push("Contact Information");
    if(hasAuthor) aiTrustSignals.push("Author Profile");
    if(hasFacebook || hasLinkedIn || hasYouTube || hasTwitter) aiTrustSignals.push("Social Presence");
    if(hasPhone) aiTrustSignals.push("Phone");
    if(isHttps) aiTrustSignals.push("HTTPS");
    if(hasLastModified) aiTrustSignals.push("Recently Updated");
    if(hasCanonical) aiTrustSignals.push("Canonical URL");

    const autoFAQ = [];
    if (h1) {
      autoFAQ.push({
        q: `What is ${h1}?`,
        a: metaDescription || bodyText.substring(0, 120)
      });
    }

    return {
      url, title, h1, metaDescription, wordCount, lastModified,
      score: seoScore,
      status: seoStatus,
      overallAIVisibilityScore,
      aiVisibilityLevel,
      breakdown: {
        seo: seoScore,
        aeo: aeoScore,
        trust: aiTrustScore,
        citation: citationProbability,
        readability: readabilityScore,
        schema: schemaScore
      },
      citationProbability,
      totalImages, imagesWithoutAlt, internalLinks, externalLinks,
      mobileFriendly: mobileViewport, isHttps, loadTime, brokenLinks: 0,
      mobileScore, desktopScore,
      hasSchemaMarkup, robotsExists, sitemapExists, hasCanonical,
      canonical, hasFavicon, favicon,
      hasOGTags, ogTitle, ogDescription, ogImage,
      aeoScore, aeoStatus,
      hasFAQ, hasHowTo, hasDirectAnswer,
      schemas: uniqueSchemas, keywords, keywordInsights,
      aiReport: "Rule-based analysis complete",
      readabilityScore, aiTrustScore,
      answerQualityScore: answerQuality,
      featuredSnippetChance,
      contentStructureScore: (h1Count === 1? 20 : 0) + (h2Count >= 3? 20 : 0) + (h3Count >= 5? 20 : 0) + (listCount >= 2? 20 : 0) + (tableCount >= 1? 20 : 0),
      citationChatGPT, citationGemini, citationPerplexity,
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
      schemaCoverage: Math.min(100, uniqueSchemas.length * 20),
      aeoReadiness: Math.round(
        (hasFAQ? 25 : 0) + (hasHowTo? 20 : 0) + (hasDirectAnswer? 20 : 0) +
        (hasSchemaMarkup? 15 : 0) + (hasAuthor? 10 : 0) + (hasLastModified? 10 : 0)
      ),
      aeoSignals: aiTrustSignals,
      fixSuggestions: [],
      instantFixes: [],
      realCitationChatGPT: citationChatGPT,
      realCitationGemini: citationGemini,
      realCitationPerplexity: citationPerplexity,
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
      criticalIssues, importantIssues, minorIssues, autoFAQ,
      hasPrivacyPolicy, hasAboutPage, hasContactPage, hasAuthor,
      hasFacebook, hasLinkedIn, hasYouTube, hasTwitter,
      hasEmail, hasPhone, email, phone,
      h1Count, h2Count, h3Count, listCount, tableCount,
      hasLastModified
    };

  } catch (mainError) {
    console.error("Analysis error:", mainError.message);
    throw new Error(`Failed to analyze ${url}: ${mainError.message}`);
  }
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
app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform running on port ${PORT}`);
  console.log(`📊 Features: Rule-based SEO/AEO Analysis | AI: WAITING MODE`);
});
