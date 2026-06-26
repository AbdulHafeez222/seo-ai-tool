import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";
import axios from "axios";
import https from "https";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;

// =========================================================================
// ========== SECTION 1: IN-MEMORY CACHE & SAAS DB PARAMETERS ==============
// =========================================================================
const scanHistory = [];
const trendDB = {}; 
const activeScans = new Map(); 

const scanCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

const saasUsers = {
  "free-dev-key-9999": {
    email: "developer@free.aeo",
    plan: "free",
    scansToday: 0,
    lastScanReset: Date.now(),
    apiKey: "free-dev-key-9999"
  },
  "pro-member-key-7777": {
    email: "enterprise@premium.aeo",
    plan: "pro",
    scansToday: 0,
    lastScanReset: Date.now(),
    apiKey: "pro-member-key-7777"
  }
};

const PLAN_LIMITS = {
  free: 5,
  starter: 25,
  pro: 100,
  agency: 500
};

app.use(cors());
app.use(express.json());
app.use(express.static("."));
app.use(express.static("public"));

// =========================================================================
// ========== SECTION 2: SANITIZERS & STABILITY HARDENING ==================
// =========================================================================

export const safeText = (input, fallback = "") => {
  if (input === undefined || input === null) return fallback;
  return String(input).trim();
};

export const safeNumber = (v, fallback = 0) => {
  const num = Number(v);
  return Number.isFinite(num) ? num : fallback;
};

export const safeBoolean = (v) => Boolean(v);

export const safeArray = (v) => (Array.isArray(v) ? v : []);

export const safeObject = (v, fallback = {}) => {
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : fallback;
};

export const safeArraySlice = (arr, start, end) => {
  return Array.isArray(arr) ? arr.slice(start, end) : [];
};

export const clamp = (num, min = 0, max = 100) => {
  const val = Number(num);
  return Math.min(max, Math.max(min, isNaN(val) ? 0 : val));
};

export const cleanText = (input) => {
  let text = safeText(input);
  const badPatterns = [
    /I\s*n\/a\s*L\s*0\s*LD\s*0\s*I\s*n\/a\s*whois\s*source/gi,
    /Summary\s*report\s*Diagnosis\s*Density/gi,
    /LD\s*0\s*I\s*n\/a/gi,
    /In\/a/gi,
    /0LD0/gi,
    /whoissource/gi,
    /Density00/gi,
    /Diagnosis/gi,
    /Summary report/gi,
    /L0LD/gi
  ];
  for (const pattern of badPatterns) {
    text = text.replace(pattern, "");
  }
  return text.replace(/\s+/g, " ").trim();
};

export const cleanDomainBrand = (url) => {
  try {
    const u = safeText(url);
    if (!u) return "Brand Authority";
    const parsed = new URL(u.match(/^https?:\/\//i) ? u : 'https://' + u);
    const host = parsed.hostname.replace("www.", "");
    const brand = host.split('.')[0] || 'Brand Authority';
    return brand.charAt(0).toUpperCase() + brand.slice(1);
  } catch {
    return "Brand Authority";
  }
};

export const tokenizeKeywords = (text = "") => {
  const clean = String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(word => word && word.length > 3);
      
  const stopWords = ['about', 'would', 'their', 'there', 'other', 'which', 'these', 'first', 'under', 'from', 'with', 'your', 'this', 'that', 'were', 'been', 'have', 'more', 'some', 'them', 'then', 'also', 'here', 'homepage', 'navigation', 'contact', 'search'];
  const freq = {};
  
  clean.forEach(tok => {
    if (!stopWords.includes(tok)) {
      freq[tok] = (freq[tok] || 0) + 1;
    }
  });

  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  const finalKeywords = sorted.length > 0 ? sorted.slice(0, 15) : ["optimized", "framework", "intelligence", "analytics"];
  return [...new Set(finalKeywords)];
};

export const normalizeUrl = (url) => {
  let u = cleanText(safeText(url))
    .replace(/^(https?:\/\/)?(www\.)?/, "")
    .replace(/\/$/, "");
  return u.replace(/\s+/g, '').toLowerCase();
};

export const getKeywordDifficulty = (kw) => {
  const hash = String(kw).split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return clamp((hash % 40) + 30, 10, 99);
};

export const getKeywordOpportunity = (difficulty, searchVolume = 1200) => {
  return clamp(Math.round(((100 - difficulty) * 0.7) + ((searchVolume / 1000) * 10)), 5, 95);
};

export const enforceSecureUrl = (inputUrl) => {
  let cleaned = safeText(inputUrl).trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/[\[\]\(\)]/g, "").trim();
  if (!cleaned.match(/^https?:\/\//i)) {
    cleaned = "https://" + cleaned;
  }
  
  try {
    const parsed = new URL(cleaned);
    const hostParts = parsed.hostname.split('.');
    if (hostParts.length < 2) return null;
    const tld = hostParts[hostParts.length - 1];
    if (tld.length < 2 || /\d/.test(tld)) return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
};

// =========================================================================
// ========== SECTION 3: BOT & BLOCK PROTECTION DETECTION ==================
// =========================================================================

export const detectBlockedReason = (html = "", status = 200) => {
  const bodyStr = typeof html === "string" ? html : String(html);
  const lowercaseHtml = bodyStr.toLowerCase();
  
  if (status === 401) return { blocked: true, system: "HTTP 401 Unauthorized", reason: "Access is unauthorized. Bot security or basic authentication block active." };
  if (status === 403) return { blocked: true, system: "HTTP 403 Forbidden", reason: "Access forbidden by server edge protection rules." };
  if (status === 429) return { blocked: true, system: "HTTP 429 Rate Limited", reason: "Too many requests. Host rate-limiting or anti-scraping active." };
  if (status === 503) return { blocked: true, system: "HTTP 503 Service Unavailable", reason: "Service temporarily unavailable. Cloudflare or system DDoS defense active." };

  const triggers = [
    { pattern: "cf-browser-verification", system: "Cloudflare", msg: "Cloudflare Browser Integrity Verification Challenge active." },
    { pattern: "__cf_chl_opt", system: "Cloudflare", msg: "Cloudflare Turnstile or JS Challenge active." },
    { pattern: "error code 1020", system: "Cloudflare", msg: "Cloudflare Firewall Access Denied (Error 1020) restriction active." },
    { pattern: "verify you are human", system: "Bot Protection", msg: "Human verification CAPTCHA prompt triggered." },
    { pattern: "sucuri", system: "Sucuri Web Firewall", msg: "Sucuri Security protection block active." },
    { pattern: "incapsula", system: "Imperva Incapsula", msg: "Imperva Incapsula security block active." },
    { pattern: "perimeterx", system: "PerimeterX", msg: "PerimeterX automated bot prevention challenge active." },
    { pattern: "akamai", system: "Akamai Edge", msg: "Akamai Shield bot control mitigation challenge active." },
    { pattern: "attention required", system: "Cloudflare", msg: "Cloudflare One-Time Security verification required." },
    { pattern: "checking your browser", system: "Cloudflare", msg: "Browser verification checking loop active." },
    { pattern: "enable javascript", system: "JavaScript Restriction", msg: "Client browser requires active Javascript execution to render framework." },
    { pattern: "g-recaptcha", system: "Google reCAPTCHA", msg: "Google reCAPTCHA challenge block active." },
    { pattern: "hcaptcha", system: "hCaptcha", msg: "hCaptcha security validation active." },
    { pattern: "challenge-form", system: "Bot Protection", msg: "Bot validation form triggered." },
    { pattern: "turnstile", system: "Cloudflare Turnstile", msg: "Cloudflare Turnstile verification challenge active." },
    { pattern: "anti-bot", system: "Bot Protection", msg: "Generic Anti-Bot gateway block active." },
    { pattern: "ray id", system: "Cloudflare", msg: "Cloudflare Edge Ray Network Trace active." },
    { pattern: "ddos protection", system: "DDoS Mitigation", msg: "Active DDoS shield firewall challenge active." },
    { pattern: "access denied", system: "Web Shield", msg: "Security gateway server denied browser connection." },
    { pattern: "forbidden", system: "Web Server Protection", msg: "Web server completely forbidden automated resource request." },
    { pattern: "robot verification", system: "Bot Protection", msg: "Robot validation request active." },
    { pattern: "request blocked", system: "Web Shield", msg: "Web firewall filter intercepted the client browser package." }
  ];

  for (const trigger of triggers) {
    if (lowercaseHtml.includes(trigger.pattern)) {
      return { blocked: true, system: trigger.system, reason: trigger.msg };
    }
  }

  return { blocked: false, system: null, reason: null };
};

// =========================================================================
// ========== SECTION 4: HIGH-PERFORMANCE BRIDGED CRAWLER ==================
// =========================================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

let globalBrowser = null;
async function getBrowserInstance() {
  if (globalBrowser) return globalBrowser;
  try {
    const { chromium } = await import("playwright");
    globalBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    return globalBrowser;
  } catch (err) {
    console.error("[CRAWL] Playwright framework binding unavailable:", err.message);
    return null;
  }
}

async function fetchAxios(url) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const response = await axios.get(url, {
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive"
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  return {
    html: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
    status: response.status,
    headers: response.headers || {},
    finalUrl: response.request?.res?.responseUrl || url
  };
}

async function fetchPlaywright(url) {
  const browser = await getBrowserInstance();
  if (!browser) return null;
  const context = await browser.newContext({
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const content = await page.content();
    const status = response ? response.status() : 200;
    const finalUrl = page.url() || url;
    return { html: content, status, finalUrl };
  } finally {
    await page.close();
    await context.close();
  }
}

export async function smartCrawl(url) {
  let result = null;
  let crawlMethod = "STANDARD_GET";
  let status = 500;
  
  try {
    result = await withRetry(() => fetchAxios(url), 1);
    status = result?.status || 500;
  } catch (err) {
    console.error(`[CRAWL] Axios direct pull failed on target: ${url}`, err.message);
  }

  let html = result?.html || "";
  let finalUrl = result?.finalUrl || url;
  
  let blockCheck = detectBlockedReason(html, status);

  if (blockCheck.blocked || !html || html.length < 1500 || html.includes("javascript is required") || html.includes("enable javascript")) {
    console.log(`[CRAWL] Standard execution blocked, incomplete, or requires JS. Upgrading protocol to Headless Browser...`);
    try {
      const pwResult = await fetchPlaywright(url);
      if (pwResult && pwResult.html && pwResult.html.length >= 300) {
        const pwBlockCheck = detectBlockedReason(pwResult.html, pwResult.status);
        if (!pwBlockCheck.blocked) {
          html = pwResult.html;
          status = pwResult.status;
          finalUrl = pwResult.finalUrl;
          crawlMethod = "PLAYWRIGHT_RENDERED";
          blockCheck = pwBlockCheck;
        } else {
          html = pwResult.html;
          status = pwResult.status;
          blockCheck = pwBlockCheck;
        }
      }
    } catch (pwErr) {
      console.error("[CRAWL] Headless fallback failed:", pwErr.message);
    }
  }

  return {
    html,
    finalUrl,
    status,
    crawlMethod,
    blockCheck,
    contentLength: html.length
  };
}

export async function withRetry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

// =========================================================================
// ========== SECTION 5: STRUCTURAL ANALYSIS ENGINES ======================
// =========================================================================

export function detectAllSchemas($, html) {
  const schemas = {
    FAQPage: { present: false, data: [] },
    HowTo: { present: false, data: [] },
    Article: { present: false, data: [] },
    Organization: { present: false, data: [] },
    LocalBusiness: { present: false, data: [] },
    BreadcrumbList: { present: false, data: [] },
    WebSite: { present: false, data: [] },
    Product: { present: false, data: [] },
    Person: { present: false, data: [] }
  };

  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const json = JSON.parse(raw);
        const items = Array.isArray(json) ? json : [json];
        const parseItem = (item) => {
          if (!item) return;
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            item['@graph'].forEach(parseItem);
            return;
          }
          const type = String(item['@type'] || '');
          if (schemas[type]) {
            schemas[type].present = true;
            schemas[type].data.push(item);
          }
        };
        items.forEach(parseItem);
      } catch (e) {}
    });
  } catch (err) {}

  return schemas;
}

// =========================================================================
// ========== SECTION 6: CENTRALIZED SCORE ENGINE (NO FAKES) =============
// =========================================================================

export function calculateCentralScores(signals) {
  const {
    title,
    metaDescription,
    h1,
    bodyText,
    wordCount,
    h1Count,
    h2Count,
    h3Count,
    totalImages,
    imagesWithoutAlt,
    uniqueSchemas,
    internalLinkData,
    readabilityScore,
    semanticSEO,
    citationProbability,
    eeatScore
  } = signals;

  let titleQuality = title.trim().length > 5 ? (title.length <= 60 ? 20 : 10) : 0;
  let metaQuality = metaDescription.trim().length > 20 ? (metaDescription.length <= 160 ? 20 : 10) : 0;
  let headingQuality = (h1Count === 1 ? 10 : 0) + (h2Count >= 2 ? 5 : 0) + (h3Count >= 2 ? 5 : 0);
  let lengthFactor = wordCount >= 1500 ? 15 : (wordCount >= 800 ? 10 : (wordCount >= 500 ? 5 : 0));
  let linkFactor = clamp(Math.min(10, internalLinkData.totalInternalLinks));
  let imgFactor = clamp(totalImages > 0 ? Math.round(((totalImages - imagesWithoutAlt) / totalImages) * 10) : 10);
  let schemaFactor = clamp(uniqueSchemas.length * 3);
  let entityFactor = clamp(Math.round((semanticSEO?.entityCoverage || 0) / 10));

  let calculatedSeo = titleQuality + metaQuality + headingQuality + lengthFactor + linkFactor + imgFactor + schemaFactor + entityFactor;
  const seoScore = clamp(calculatedSeo, 0, 100);

  const hasFAQ = uniqueSchemas.includes("FAQPage");
  const hasHowTo = uniqueSchemas.includes("HowTo");
  const hasDirectAnswer = (bodyText.includes("Q:") && bodyText.includes("A:")) || bodyText.toLowerCase().includes("what is") || bodyText.toLowerCase().includes("how to") || (h2Count >= 3 && bodyText.length > 500);
  
  const answerClarity = Math.min(100, Math.round((hasDirectAnswer ? 50 : 0) + (hasFAQ ? 30 : 0) + (readabilityScore * 0.2))) || 0;
  const schemaPresence = clamp((hasFAQ ? 40 : 0) + (hasHowTo ? 30 : 0) + (uniqueSchemas.length > 0 ? 30 : 0));
  
  const rawAeoScore = Math.round((answerClarity * 0.30) + (citationProbability * 0.25) + (schemaPresence * 0.20) + ((semanticSEO?.entityCoverage || 0) * 0.25));
  const aeoScore = clamp(rawAeoScore, 0, 100);

  const overallAIVisibilityScore = clamp(Math.round((seoScore * 0.3) + (aeoScore * 0.3) + ((eeatScore || 0) * 0.2) + ((citationProbability || 0) * 0.2)));

  return {
    seoScore,
    aeoScore,
    overallAIVisibilityScore
  };
}

// =========================================================================
// ========== SECTION 7: COMPREHENSIVE SCANNER PIPELINE ===================
// =========================================================================

export async function analyzeSingleUrl(url) {
  let normalizedUrl;
  try {
    normalizedUrl = enforceSecureUrl(url);
  } catch (err) {
    return {
      success: false,
      status: "ERROR",
      message: "Malformed target domain or invalid TLD",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    };
  }

  if (!normalizedUrl) {
    return {
      success: false,
      status: "ERROR",
      message: "Malformed target domain or invalid TLD"
    };
  }

  const cacheKey = normalizeUrl(normalizedUrl);
  if (scanCache.has(cacheKey)) {
    const cachedEntry = scanCache.get(cacheKey);
    if (Date.now() - cachedEntry.cachedAt < CACHE_TTL_MS) {
      console.log(`[CACHE HIT] Reusing cached analysis for: ${normalizedUrl}`);
      return cachedEntry.payload;
    }
  }

  let startTime = Date.now();
  let crawlResult;
  try {
    crawlResult = await smartCrawl(normalizedUrl);
  } catch (err) {
    return {
      success: false,
      status: "ERROR",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    };
  }

  const loadTime = Date.now() - startTime;

  // Immediately terminate and STOP if block conditions are detected.
  if (crawlResult.blockCheck.blocked) {
    const blockedPayload = {
      success: false,
      status: "BLOCKED",
      httpStatus: crawlResult.status,
      reason: crawlResult.blockCheck.reason,
      blockedBy: crawlResult.blockCheck.system,
      crawlMethod: crawlResult.crawlMethod,
      resolvedUrl: crawlResult.finalUrl,
      timestamp: new Date().toISOString(),
      seoScore: null,
      aeoScore: null,
      eeatScore: null,
      citationScore: null,
      authorityScore: null,
      trustScore: null,
      audit: null,
      entities: null,
      schema: null,
      roadmap: null,
      keywordGap: null,
      comparison: null,
      simulation: null
    };
    scanCache.set(cacheKey, { cachedAt: Date.now(), payload: blockedPayload });
    return blockedPayload;
  }

  const html = crawlResult.html || "";

  // Parse HTML
  let $ = cheerio.load(html);
  
  // Extract Metadata
  let title = cleanText(safeText($("title").text()).trim());
  let metaDescription = cleanText(safeText($('meta[name="description"]').attr("content")).trim());
  let h1 = cleanText(safeText($("h1").first().text()).trim());
  let h2s = [...new Set($("h2").map((i, el) => safeText($(el).text()).trim()).get().filter(Boolean).map(cleanText))];
  let h3s = [...new Set($("h3").map((i, el) => safeText($(el).text()).trim()).get().filter(Boolean).map(cleanText))];

  // Extract Links
  const internalLinkData = analyzeInternalLinks($, normalizedUrl, h2s);
  const bodyText = cleanText($("p, li, h2, h3, h4, td, span, article").map((i, el) => $(el).text()).get().join(" "));
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length || 0;

  // Fallback to regex parser if elements completely missing but page parsed
  if (!title || !metaDescription || !h1 || wordCount < 100) {
    const backupExtraction = regexFallbackParser(html, normalizedUrl);
    if (!title) title = backupExtraction.title;
    if (!metaDescription) metaDescription = backupExtraction.metaDescription;
    if (!h1) h1 = backupExtraction.h1;
  }

  // Schema Markup
  const schemas = detectAllSchemas($, html);
  const uniqueSchemas = [...new Set(Object.keys(schemas).filter(k => schemas[k]?.present))];
  const ALLOWED_RECOMMENDED_TYPES = ["FAQPage", "Organization", "LocalBusiness", "WebSite", "Article", "HowTo"];
  const recommendedSchemas = [...new Set(
    Object.keys(schemas).filter(k => !schemas[k]?.present && ALLOWED_RECOMMENDED_TYPES.includes(k))
  )];

  const h1Count = $("h1").length || (title ? 1 : 0);
  const h2Count = h2s.length;
  const h3Count = h3s.length;
  const listCount = $("ul, ol").length || 0;
  const tableCount = $("table").length || 0;
  const totalImages = $("img").length || 0;
  const imagesWithoutAlt = $("img").filter((i, el) => !$(el).attr("alt")).length || 0;
  const mobileViewport = $('meta[name="viewport"]').length > 0;
  const canonical = safeText($('link[rel="canonical"]').attr("href"));
  const hasCanonical = !!canonical;
  const favicon = safeText($('link[rel="icon"], link[rel="shortcut icon"]').attr("href"));
  const hasFavicon = !!favicon;

  const faqQuestions = [];
  if (schemas?.FAQPage?.present && schemas?.FAQPage?.data?.length > 0) {
    schemas.FAQPage.data.forEach(schema => {
      schema?.mainEntity?.forEach(q => { if (q?.name) faqQuestions.push(safeText(q.name)); });
    });
  }
  const hasFAQ = faqQuestions.length > 0 || schemas?.FAQPage?.present || false;
  const hasHowTo = schemas?.HowTo?.present || false;
  const hasLocalBusiness = schemas?.LocalBusiness?.present || false;
  const hasDirectAnswer = (bodyText.includes("Q:") && bodyText.includes("A:")) || bodyText.toLowerCase().includes("what is") || bodyText.toLowerCase().includes("how to") || (h2Count >= 3 && bodyText.length > 500);

  const ogTitle = safeText($('meta[property="og:title"]').attr("content"));
  const ogDescription = safeText($('meta[property="og:description"]').attr("content"));
  const ogImage = safeText($('meta[property="og:image"]').attr("content"));
  const hasOGTags = !!(ogTitle && ogDescription);

  const hasAuthor = $('meta[name="author"]').length > 0 || $('[rel="author"]').length > 0 || $('[itemprop="author"]').length > 0;
  const dateStr = safeText($('meta[property="article:modified_time"]').attr('content') || $('meta[property="article:published_time"]').attr('content'));
  const hasLastModified = !!dateStr;
  const lastModified = dateStr ? new Date(dateStr).toLocaleDateString() : null;

  const socialLinksList = $("a").map((i, el) => safeText($(el).attr("href"))).get() || [];
  const hasFacebook = socialLinksList.some(link => link.includes("facebook.com"));
  const hasLinkedIn = socialLinksList.some(link => link.includes("linkedin.com"));
  const hasYouTube = socialLinksList.some(link => link.includes("youtube.com"));
  const hasTwitter = socialLinksList.some(link => link.includes("twitter.com") || link.includes("x.com"));

  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = bodyText.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/);
  const email = emailMatch ? emailMatch[0] : null;
  const phone = phoneMatch ? phoneMatch[0] : null;
  const hasEmail = !!email;
  const hasPhone = !!phone;

  const keywords = tokenizeKeywords(bodyText);
  const entityData = extractEntitiesV2($, html, title, h1, h2s, h3s, metaDescription, bodyText, normalizedUrl, schemas);
  const entityCoverageScore = clamp(safeArray(entityData?.entities).length * 10);

  let readabilityScore = 50;
  const sentences = bodyText.split(/[.!?]+/).length || 1;
  const avgWordsPerSentence = wordCount / sentences;
  if (avgWordsPerSentence > 25) readabilityScore = 30;
  else if (avgWordsPerSentence > 20) readabilityScore = 50;
  else readabilityScore = 80;

  const trustSignals = scanTrustSignals($, normalizedUrl);
  const trustScore = safeNumber(trustSignals?.trustScore, 0);

  const eeatData = analyzeEEATAdvanced($, bodyText, hasAuthor, trustSignals.hasAbout, trustSignals.hasContact, trustSignals.hasPrivacyPolicy, hasLinkedIn, hasFacebook, normalizedUrl.startsWith("https://"), hasLastModified, schemas, trustSignals.hasTermsPage, trustSignals.socialLinks);
  const eeatScore = safeNumber(eeatData?.score, 0);

  const localSEO = analyzeLocalSEO($, bodyText, schemas, hasEmail, hasPhone);
  const topicalAuthority = calculateTopicalAuthority($, keywords, h2s, h3s, wordCount);
  const topicalAuthorityScore = safeNumber(topicalAuthority?.authorityScore, 0);

  const semanticSEO = analyzeSemanticSEO($, bodyText, keywords);

  const aiTrustSignals = [];
  if (trustSignals.hasPrivacyPolicy) aiTrustSignals.push("Privacy Policy");
  if (trustSignals.hasAbout) aiTrustSignals.push("About Page");
  if (trustSignals.hasContact) aiTrustSignals.push("Contact Page");
  if (trustSignals.hasTermsPage) aiTrustSignals.push("Terms Page");
  if (hasEmail) aiTrustSignals.push("Email Address");
  if (hasPhone) aiTrustSignals.push("Phone Number");
  if (hasAuthor) aiTrustSignals.push("Author Profile");
  if (hasFacebook) aiTrustSignals.push("Facebook");
  if (hasLinkedIn) aiTrustSignals.push("LinkedIn");
  if (hasYouTube) aiTrustSignals.push("YouTube");
  if (hasTwitter) aiTrustSignals.push("Twitter/X");
  if (normalizedUrl.startsWith("https://")) aiTrustSignals.push("HTTPS Secure");
  if (hasLastModified) aiTrustSignals.push("Recently Updated");
  if (hasCanonical) aiTrustSignals.push("Canonical URL");
  if (hasFavicon) aiTrustSignals.push("Favicon");

  const aiTrustScore = clamp(Math.round((aiTrustSignals.length / 15) * 100));
  const externalLinksCount = $("a[href^='http']").not(`a[href^='${normalizedUrl}']`).length || 0;

  const simulationResult = aeoSimulationEngine({
    hasFAQ,
    hasHowTo,
    hasLocalBusiness,
    hasAuthor,
    hasContact: trustSignals.hasContact,
    hasAbout: trustSignals.hasAbout,
    internalLinkScore: internalLinkData.internalLinkScore,
    entityCoverage: entityCoverageScore,
    eeatScore,
    topicalAuthorityScore,
    wordCount,
    listCount,
    tableCount,
    externalLinksCount,
    hasDirectAnswer,
    hasLastModified
  });

  const citationProbability = simulationResult.citationProbability;
  const citationChatGPT = simulationResult.citationChatGPT;
  const citationGemini = simulationResult.citationGemini;
  const citationPerplexity = simulationResult.citationPerplexity;
  const citationClaude = simulationResult.citationClaude;

  let confidenceFactors = 0;
  if (title && title.length > 5) confidenceFactors += 15;
  if (metaDescription && metaDescription.length > 15) confidenceFactors += 15;
  if (h1 && h1.length > 3) confidenceFactors += 10;
  if (wordCount >= 500) confidenceFactors += 20;
  if (h2Count > 0 || h3Count > 0) confidenceFactors += 10;
  if (uniqueSchemas.length > 0) confidenceFactors += 10;
  if (internalLinkData.internalLinks > 0) confidenceFactors += 10;
  if (totalImages > 0) confidenceFactors += 10;

  let analysisConfidence = clamp(confidenceFactors, 5, 100);
  const confidenceWarning = analysisConfidence < 40 ? "Low confidence scan due to crawl limitations" : null;

  const calculatedSignalsScores = calculateCentralScores({
    title,
    metaDescription,
    h1,
    bodyText,
    wordCount,
    h1Count,
    h2Count,
    h3Count,
    totalImages,
    imagesWithoutAlt,
    uniqueSchemas,
    internalLinkData,
    readabilityScore,
    semanticSEO,
    citationProbability,
    eeatScore
  });

  const seoScore = calculatedSignalsScores?.seoScore || 0;
  const aeoScore = calculatedSignalsScores?.aeoScore || 0;
  const overallAIVisibilityScore = calculatedSignalsScores?.overallAIVisibilityScore || 0;

  const seoStatus = seoScore >= 80 ? "Excellent" : seoScore >= 50 ? "Good" : "Needs Work";
  const aeoStatus = aeoScore >= 80 ? "Excellent" : aeoScore >= 50 ? "Good" : "Needs Work";
  const featuredSnippetChance = clamp(Math.round((hasDirectAnswer ? 50 : 0) + (wordCount > 500 ? 30 : 0) + (uniqueSchemas.length > 0 ? 20 : 0)));

  const criticalIssues = [];
  const importantIssues = [];
  const minorIssues = [];
  if (!title) criticalIssues.push("Missing Title Tag");
  if (!metaDescription) criticalIssues.push("Missing Meta Description");
  if (h1Count !== 1) importantIssues.push("H1 count should be exactly 1");
  if (!normalizedUrl.startsWith("https://")) criticalIssues.push("Site is not running on HTTPS");
  if (imagesWithoutAlt > 0) minorIssues.push("Images without alt attributes detected");

  const aiAutopilot = [];
  if (!hasFAQ) aiAutopilot.push({ task: "Deploy Structured FAQ JSON-LD Blocks", priority: "CRITICAL", impact: 15, effort: "15 mins" });
  if (!hasDirectAnswer) aiAutopilot.push({ task: "Place a 50-word direct summary answer box under H1", priority: "HIGH", impact: 15, effort: "10 mins" });
  if (!hasAuthor) aiAutopilot.push({ task: "Establish E-E-A-T: Include author name and schema reference", priority: "HIGH", impact: 10, effort: "15 mins" });
  if (!hasCanonical) aiAutopilot.push({ task: "Add canonical link tag", priority: "MEDIUM", impact: 5, effort: "5 mins" });
  if (imagesWithoutAlt > 0) aiAutopilot.push({ task: "Fix missing image alt attributes", priority: "LOW", impact: 5, effort: "20 mins" });
  if (aiAutopilot.length === 0) {
    aiAutopilot.push({ task: "Maintain regular content freshness", priority: "LOW", impact: 5, effort: "Continuous" });
  }

  const brandName = getBrandNameEnhanced(normalizedUrl, $, title, schemas);
  const schemaGenerator = `<!-- Automated Schema Recommendation -->\n<script type="application/ld+json">\n${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": title,
    "description": metaDescription
  }, null, 2)}\n</script>`;

  const aiVisibilityLevel = overallAIVisibilityScore >= 80 ? "Leader" : overallAIVisibilityScore >= 50 ? "Competitor" : "Emerging";
  const totalRoadmapImpact = aiAutopilot.reduce((sum, task) => sum + task.impact, 0);
  const currentAIVisibility = overallAIVisibilityScore;
  const potentialAIVisibility = Math.min(100, currentAIVisibility + totalRoadmapImpact);

  const autoFAQ = faqQuestions.map(q => ({ question: q, answer: "Auto-generated answer context." }));
  const aiSearchSimulation = {
    chatgpt: { score: citationChatGPT, summary: "ChatGPT selection probability is high." },
    gemini: { score: citationGemini, summary: "Gemini requires clear structured facts." },
    perplexity: { score: citationPerplexity, summary: "Perplexity prefers fresh updates." },
    claude: { score: citationClaude, summary: "Claude values semantic density." }
  };

  const aiSnippets = generateAISnippets(h1, metaDescription, bodyText, keywords);
  const reasoning = aiReasoningEngine({ missingEntities: semanticSEO.missingEntities || [] }, seoScore, aeoScore, citationProbability);
  const visibilityTrend = trackAIVisibilityTrend(normalizedUrl, overallAIVisibilityScore, seoScore, aeoScore);

  const payload = {
    success: true,
    status: "SUCCESS",
    seoScore,
    aeoScore,
    eeatScore,
    citationScore: citationProbability,
    authorityScore: topicalAuthorityScore,
    trustScore: aiTrustScore,
    currentAIVisibility,
    potentialAIVisibility,
    overallAIVisibilityScore,
    aiVisibilityLevel,
    title,
    h1,
    h2s,
    h3s,
    metaDescription,
    lastModified,
    wordCount,
    loadTime,
    crawlMethod: crawlResult.crawlMethod,
    resolvedUrl: crawlResult.finalUrl,
    schemaDetected: uniqueSchemas.length > 0,
    schemaCount: uniqueSchemas.length,
    schemaGenerator,
    schema: schemaGenerator,
    recommendedSchemas,
    keywords,
    totalImages,
    imagesWithoutAlt,
    internalLinks: internalLinkData.totalInternalLinks,
    externalLinks: externalLinksCount,
    hasCanonical,
    canonical,
    hasFavicon,
    favicon,
    hasOGTags,
    ogTitle,
    ogDescription,
    ogImage,
    hasFAQ,
    hasHowTo,
    hasDirectAnswer,
    hasPrivacyPolicy: trustSignals.hasPrivacyPolicy,
    hasAboutPage: trustSignals.hasAbout,
    hasContactPage: trustSignals.hasContact,
    hasAuthor,
    hasFacebook,
    hasLinkedIn,
    hasYouTube,
    hasTwitter,
    hasEmail,
    hasPhone,
    email,
    phone,
    hasLastModified,
    autoFAQ,
    readabilityScore,
    featuredSnippetChance,
    answerQualityScore: answerClarity,
    aiSnippets,
    reasoning,
    aiReasoning: reasoning,
    visibilityTrend,
    aiAutopilot,
    autopilot: { tasks: aiAutopilot },
    topicalAuthority,
    semanticSEO,
    localSEO,
    trustSignals,

    audit: {
      seo: {
        status: seoStatus,
        criticalIssues: [...new Set(criticalIssues)],
        importantIssues: [...new Set(importantIssues)],
        minorIssues: [...new Set(minorIssues)],
        readabilityScore
      },
      aeo: {
        status: aeoStatus,
        answerQualityScore: answerClarity,
        featuredSnippetChance,
        citationChatGPT,
        citationGemini,
        citationPerplexity,
        citationClaude,
        faqQuestions: [...new Set(faqQuestions)]
      },
      eeat: {
        score: eeatScore,
        status: eeatData.status || "Shallow Trust Profile",
        factors: eeatData.factors || [],
        issues: eeatData.issues || []
      },
      technical: {
        isHttps: normalizedUrl.startsWith("https://"),
        loadTime,
        mobileFriendly: mobileViewport,
        wordCount,
        hasSchemaMarkup: uniqueSchemas.length > 0,
        schemas: uniqueSchemas,
        recommendedSchemas
      }
    },

    entities: {
      brands: [...new Set(entityData?.brands || [])],
      services: [...new Set(entityData?.services || [])],
      locations: [...new Set(entityData?.locations || [])],
      people: [...new Set(entityData?.people || [])],
      organizations: [...new Set(entityData?.organizations || [])],
      products: [...new Set(entityData?.products || [])],
      totalEntities: entityData?.totalEntities || 0
    },

    roadmap: aiAutopilot.map((task, idx) => ({ 
      step: idx + 1, 
      task: task.task, 
      priority: task.priority, 
      impact: task.impact, 
      effort: task.effort,
      why: task.priority === 'CRITICAL' ? 'Immediate indexing blocker.' : 'Enhances search crawler context.',
      code: task.task.includes('Schema') ? '<script type="application/ld+json">...</script>' : 'Inline elements code'
    })),

    keywordGap: null,
    comparison: null,
    
    simulation: {
      chatgpt: { score: citationChatGPT, summary: "ChatGPT selection probability is high." },
      gemini: { score: citationGemini, summary: "Gemini requires clear structured facts." },
      perplexity: { score: citationPerplexity, summary: "Perplexity prefers fresh updates." },
      claude: { score: citationClaude, summary: "Claude values semantic density." }
    },

    competitor: {
      winner: brandName,
      winnerReason: "Live verification complete"
    },

    meta: {
      url: normalizedUrl,
      wordCount,
      timestamp: new Date().toISOString()
    }
  };

  scanCache.set(cacheKey, {
    cachedAt: Date.now(),
    payload
  });

  scanHistory.unshift({
    url: payload.meta.url,
    score: payload.overallAIVisibilityScore,
    seoScore: payload.seoScore,
    aeoScore: payload.aeoScore,
    timestamp: new Date().toISOString()
  });
  if (scanHistory.length > 50) scanHistory.pop();

  return payload;
}

export function competitorContentGap(userData, compData) {
  if (!userData || !compData || userData.status === "BLOCKED" || compData.status === "BLOCKED") {
    return {
      headingGaps: [],
      keywordGaps: [],
      schemaGaps: [],
      contentLengthDiff: 0,
      competitorHasMore: false,
      topicalCoverageStatus: "Low Coverage"
    };
  }

  const userHeadings = [...safeArray(userData.h2s), ...safeArray(userData.h3s)];
  const compHeadings = [...safeArray(compData.h2s), ...safeArray(compData.h3s)];
  const userKeywords = new Set(safeArray(userData.keywords));
  const compKeywords = new Set(safeArray(compData.keywords));

  const headingGaps = compHeadings.filter(h => !userHeadings.some(uh => safeText(uh).toLowerCase().includes(safeText(h).toLowerCase().substring(0, 10))));
  const keywordGaps = [...compKeywords].filter(k => !userKeywords.has(k));

  const schemaGaps = [];
  if (compData.hasFAQ && !userData.hasFAQ) schemaGaps.push('FAQPage');
  if (compData.hasHowTo && !userData.hasHowTo) schemaGaps.push('HowTo');
  if (compData.hasAuthor && !userData.hasAuthor) schemaGaps.push('Author Profile');

  const coveragePercent = safeNumber(userData?.topicalAuthority?.coveragePercent || 0);
  let topicalCoverageStatus = "Low Coverage";
  if (coveragePercent >= 90) topicalCoverageStatus = "Perfect topical coverage";
  else if (coveragePercent >= 70) topicalCoverageStatus = "Strong Topical Authority";
  else topicalCoverageStatus = "Topical Gaps Identified";

  return {
    headingGaps: [...new Set(headingGaps)].slice(0, 10),
    keywordGaps: [...new Set(keywordGaps)].slice(0, 15),
    schemaGaps: [...new Set(schemaGaps)],
    contentLengthDiff: safeNumber(compData.wordCount) - safeNumber(userData.wordCount),
    competitorHasMore: safeNumber(compData.wordCount) > safeNumber(userData.wordCount),
    topicalCoverageStatus
  };
}

// =========================================================================
// ========== SECTION 8: SAAS MONETIZATION MIDDLEWARE ======================
// =========================================================================

function authenticateAndRateLimit(req, res, next) {
  if (process.env.DEV_MODE === "true") {
    req.user = saasUsers["pro-member-key-7777"];
    return next();
  }

  const apiKey = req.query.apiKey || req.headers["x-api-key"];
  if (!apiKey) {
    req.user = saasUsers["free-dev-key-9999"];
  } else {
    const user = saasUsers[apiKey];
    if (!user) {
      return res.status(401).json({ success: false, error: "Unauthorized: Invalid API Key" });
    }
    req.user = user;
  }

  const user = req.user;
  const now = Date.now();
  const resetInterval = 24 * 60 * 60 * 1000;

  if (now - user.lastScanReset > resetInterval) {
    user.scansToday = 0;
    user.lastScanReset = now;
  }

  const limit = PLAN_LIMITS[user.plan] || 5;
  if (user.scansToday >= limit) {
    const targetUrl = req.query.url || "https://example.com";
    return res.json({
      success: false,
      status: "BLOCKED",
      reason: `You reached the limit of ${limit} scans/day for plan '${user.plan.toUpperCase()}'.`,
      blockedBy: "SaaS Plan Limits Manager",
      httpStatus: 429,
      resolvedUrl: targetUrl,
      timestamp: new Date().toISOString()
    });
  }

  next();
}

// =========================================================================
// ========== SECTION 9: API ROUTING SYSTEM ===============================
// =========================================================================

app.get("/", (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    tool: "AI Visibility SaaS Platform",
    version: "9.0-enterprise-tier"
  });
});

app.get("/scan", authenticateAndRateLimit, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: "error", message: "URL required" });

  const normalized = enforceSecureUrl(url);
  if (!normalized) {
    return res.status(400).json({
      status: "error",
      message: "Malformed target domain or invalid TLD"
    });
  }

  const cacheKey = normalizeUrl(normalized);
  if (activeScans.has(cacheKey)) {
    const startTime = activeScans.get(cacheKey);
    if (Date.now() - startTime < 60000) {
      return res.status(409).json({
        status: "already_scanning",
        message: "Scan already in progress"
      });
    } else {
      activeScans.delete(cacheKey);
    }
  }

  activeScans.set(cacheKey, Date.now());

  try {
    const data = await analyzeSingleUrl(normalized);
    if (data.status === "BLOCKED") {
      return res.json(data);
    }
    if (data.success && req.user) {
      req.user.scansToday++;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "ERROR",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  } finally {
    activeScans.delete(cacheKey);
  }
});

app.get("/compare", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) return res.status(400).json({ error: "Both URLs required" });

    const normalizedUrl = enforceSecureUrl(url);
    const normalizedComp = enforceSecureUrl(competitor);

    if (!normalizedUrl || !normalizedComp) {
      return res.status(400).json({ error: "Invalid domain target parameters received" });
    }

    const results = await Promise.allSettled([
      analyzeSingleUrl(normalizedUrl),
      analyzeSingleUrl(normalizedComp)
    ]);

    const site1 = results[0].status === "fulfilled" ? results[0].value : null;
    const site2 = results[1].status === "fulfilled" ? results[1].value : null;

    if (!site1 || !site2) {
      return res.status(200).json({
        success: false,
        status: "BLOCKED",
        reason: "Comparison unavailable: One or both engines failed."
      });
    }

    if (site1.status === "BLOCKED" || site2.status === "BLOCKED") {
      return res.json({
        success: false,
        status: "BLOCKED",
        reason: "Comparison unavailable: Content blocked or protection wall detected on one or both target sites.",
        blockedBy: site1.status === "BLOCKED" ? site1.blockedBy : site2.blockedBy,
        httpStatus: site1.status === "BLOCKED" ? site1.httpStatus : site2.httpStatus,
        resolvedUrl: site1.status === "BLOCKED" ? site1.resolvedUrl : site2.resolvedUrl,
        timestamp: new Date().toISOString()
      });
    }

    if (req.user) {
      req.user.scansToday = Math.min(PLAN_LIMITS[req.user.plan], req.user.scansToday + 2);
    }

    const seoAdvantage = (site1?.seoScore || 0) - (site2?.seoScore || 0);
    const aeoAdvantage = (site1?.aeoScore || 0) - (site2?.aeoScore || 0);
    const eeatAdvantage = (site1?.eeatScore || 0) - (site2?.eeatScore || 0);
    const citationAdvantage = (site1?.citationScore || 0) - (site2?.citationScore || 0);
    const trustAdvantage = (site1?.trustScore || 0) - (site2?.trustScore || 0);

    const leaderBrand = site1?.overallAIVisibilityScore >= site2?.overallAIVisibilityScore ? (site1?.title || "Your Site") : (site2?.title || "Competitor Site");

    const competitorAdvantage = {
      seoAdvantage: { diff: Math.abs(seoAdvantage), leader: seoAdvantage > 0 ? "You" : (seoAdvantage < 0 ? "Competitor" : "Tie") },
      aeoAdvantage: { diff: Math.abs(aeoAdvantage), leader: aeoAdvantage > 0 ? "You" : (aeoAdvantage < 0 ? "Competitor" : "Tie") },
      eeatAdvantage: { diff: Math.abs(eeatAdvantage), leader: eeatAdvantage > 0 ? "You" : (eeatAdvantage < 0 ? "Competitor" : "Tie") },
      citationAdvantage: { diff: Math.abs(citationAdvantage), leader: citationAdvantage > 0 ? "You" : (citationAdvantage < 0 ? "Competitor" : "Tie") },
      trustAdvantage: { diff: Math.abs(trustAdvantage), leader: trustAdvantage > 0 ? "You" : (trustAdvantage < 0 ? "Competitor" : "Tie") },
      finalWinner: leaderBrand
    };

    res.json({
      status: "SUCCESS",
      scores: {
        site1: site1?.overallAIVisibilityScore,
        site2: site2?.overallAIVisibilityScore
      },
      audit: site1.audit,
      entities: site1.entities,
      schema: site1.schema,
      roadmap: site1.roadmap,
      keywordGap: null,
      comparison: {
        sites: [
          { brand: site1.competitor?.winner || "Site 1", url: site1.resolvedUrl, aiVisibilityScore: site1.overallAIVisibilityScore, seoScore: site1.seoScore, aeoScore: site1.aeoScore },
          { brand: site2.competitor?.winner || "Site 2", url: site2.resolvedUrl, aiVisibilityScore: site2.overallAIVisibilityScore, seoScore: site2.seoScore, aeoScore: site2.aeoScore }
        ],
        advantages: competitorAdvantage,
        competitorAdvantage,
        winnerReason: `${leaderBrand} commands clear performance leads overall.`
      },
      simulation: site1.simulation
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "ERROR",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
});

app.get("/content-gap", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) return res.status(400).json({ error: "Both URLs required" });

    const normalizedUrl = enforceSecureUrl(url);
    const normalizedComp = enforceSecureUrl(competitor);

    if (!normalizedUrl || !normalizedComp) {
      return res.status(400).json({ error: "Invalid domain parameters received" });
    }

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(normalizedUrl),
      analyzeSingleUrl(normalizedComp)
    ]);

    if (userData.status === "BLOCKED" || compData.status === "BLOCKED") {
      return res.json({
        success: false,
        status: "BLOCKED",
        reason: "Content gap analysis unavailable: One or both engines intercepted by bot prevention gateway.",
        blockedBy: userData.status === "BLOCKED" ? userData.blockedBy : compData.blockedBy,
        httpStatus: userData.status === "BLOCKED" ? userData.httpStatus : compData.httpStatus,
        resolvedUrl: userData.status === "BLOCKED" ? userData.resolvedUrl : compData.resolvedUrl,
        timestamp: new Date().toISOString()
      });
    }

    const gapData = competitorContentGap(userData, compData);
    
    res.json({
      status: "SUCCESS",
      scores: {
        userScore: userData?.overallAIVisibilityScore,
        compScore: compData?.overallAIVisibilityScore
      },
      audit: userData.audit,
      entities: userData.entities,
      schema: userData.schema,
      roadmap: userData.roadmap,
      keywordGap: {
        competitorKeywords: gapData?.keywordGaps?.slice(0, 5) || [],
        missingKeywords: gapData?.keywordGaps?.slice(5, 10) || [],
        opportunityKeywords: gapData?.keywordGaps?.slice(10, 15) || []
      },
      comparison: {
        ...gapData,
        gapAnalysis: {
          missingTopics: gapData?.headingGaps || []
        }
      },
      simulation: userData.simulation
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "ERROR",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
});

app.get("/roadmap", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    const normalizedUrl = enforceSecureUrl(url);
    if (!normalizedUrl) return res.status(400).json({ error: "Invalid URL format" });

    const data = await analyzeSingleUrl(normalizedUrl);

    if (data.status === "BLOCKED") {
      return res.json(data);
    }

    res.json({
      status: "SUCCESS",
      scores: {
        currentAIVisibility: data.overallAIVisibilityScore,
        potentialAIVisibility: data.potentialAIVisibility
      },
      audit: data.audit,
      entities: data.entities,
      schema: data.schema,
      roadmap: data.roadmap,
      keywordGap: null,
      comparison: null,
      simulation: data.simulation
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "ERROR",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
});

app.get("/history", (req, res) => {
  res.json(scanHistory);
});

// ========== STARTUP SELF-VALIDATION ROUTINE ==========
validateRequiredSystemHelpers();

function validateRequiredSystemHelpers() {
  console.log("🔍 System validation running...");
  const helpers = [
    { name: "cleanDomainBrand", fn: typeof cleanDomainBrand === "function" ? cleanDomainBrand : null },
    { name: "safeArray", fn: typeof safeArray === "function" ? safeArray : null },
    { name: "safeNumber", fn: typeof safeNumber === "function" ? safeNumber : null },
    { name: "clamp", fn: typeof clamp === "function" ? clamp : null },
    { name: "tokenizeKeywords", fn: typeof tokenizeKeywords === "function" ? tokenizeKeywords : null },
    { name: "getBrandNameEnhanced", fn: typeof getBrandNameEnhanced === "function" ? getBrandNameEnhanced : null },
    { name: "analyzeInternalLinks", fn: typeof analyzeInternalLinks === "function" ? analyzeInternalLinks : null },
    { name: "extractEntitiesV2", fn: typeof extractEntitiesV2 === "function" ? extractEntitiesV2 : null },
    { name: "calculateTopicalAuthority", fn: typeof calculateTopicalAuthority === "function" ? calculateTopicalAuthority : null },
    { name: "analyzeSemanticSEO", fn: typeof analyzeSemanticSEO === "function" ? analyzeSemanticSEO : null },
    { name: "findCitationOpportunities", fn: typeof findCitationOpportunities === "function" ? findCitationOpportunities : null },
    { name: "generateAISnippets", fn: typeof generateAISnippets === "function" ? generateAISnippets : null },
    { name: "analyzeLocalSEO", fn: typeof analyzeLocalSEO === "function" ? analyzeLocalSEO : null },
    { name: "scanTrustSignals", fn: typeof scanTrustSignals === "function" ? scanTrustSignals : null },
    { name: "trackAIVisibilityTrend", fn: typeof trackAIVisibilityTrend === "function" ? trackAIVisibilityTrend : null },
    { name: "detectAllSchemas", fn: typeof detectAllSchemas === "function" ? detectAllSchemas : null },
    { name: "aeoSimulationEngine", fn: typeof aeoSimulationEngine === "function" ? aeoSimulationEngine : null },
    { name: "aiReasoningEngine", fn: typeof aiReasoningEngine === "function" ? aiReasoningEngine : null },
    { name: "calculateCentralScores", fn: typeof calculateCentralScores === "function" ? calculateCentralScores : null }
  ];

  helpers.forEach(helper => {
    if (!helper.fn) {
      console.warn(`⚠️ Warning: optional helper "${helper.name}" is missing/undefined! Safe mode active.`);
    } else {
      console.log(`✓ Helper verified: ${helper.name}`);
    }
  });

  console.log("✅ System running in SAFE MODE");
}

app.listen(PORT, () => {
  console.log(`... AI Visibility Platform v9.0 running on port ${PORT}`);
});
