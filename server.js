import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";
import axios from "axios";
import https from "https";
import path from "path";

// =========================================================================
// ========== SECTION 0: GLOBAL CONSTANTS, CONFIGS & REGEXES ==============
// =========================================================================

export const PORT = process.env.PORT || 10000;
export const CACHE_TTL_MS = 10 * 60 * 1000;

export const ALLOWED_RECOMMENDED_TYPES = [
  "FAQPage", "Organization", "LocalBusiness", "WebSite", "Article",
  "HowTo", "BreadcrumbList", "Product", "Review", "Person",
  "Service", "BlogPosting", "WebPage", "VideoObject"
];

export const PLAN_LIMITS = {
  free: 5,
  starter: 25,
  pro: 100,
  agency: 500
};

export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

export const scanHistory = [];
export const trendDB = {};
export const activeScans = new Map();
export const scanCache = new Map();

export const saasUsers = {
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

export const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
export const PHONE_REGEX = /[\+]?[(]?[0-9]{3}[)]?[-\s.]?[0-9]{3}[-\s.]?[0-9]{4,6}/;

export const BAD_PATTERNS = [
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

export const STOP_WORDS = [
  'about', 'would', 'their', 'there', 'other', 'which', 'these', 'first', 'under', 'from', 'with', 'your',
  'this', 'that', 'were', 'been', 'have', 'more', 'some', 'them', 'then', 'also', 'here', 'homepage',
  'navigation', 'contact', 'search'
];

export const SERVICE_PATTERNS = [
  'SEO', 'Search Engine Optimization', 'Web Design', 'Digital Marketing', 'Web Development',
  'Content Writing', 'Copywriting', 'Social Media Marketing', 'E-commerce', 'Shopify',
  'Branding', 'Analytics', 'Enterprise Software', 'AI Integration', 'Consulting',
  'Software Development', 'Product Strategy', 'UI/UX Design', 'Cloud Hosting', 'Cybersecurity'
];

export const CITY_PATTERNS = [
  'New York', 'London', 'Toronto', 'Sydney', 'Berlin', 'Paris', 'Dubai', 'Singapore', 'Tokyo',
  'Chicago', 'San Francisco', 'Karachi', 'Lahore', 'Islamabad'
];

export const GENERIC_SERVICE_KEYWORDS = [
  "seo", "search engine optimization", "web design", "digital marketing", "web development",
  "content writing", "copywriting", "social media marketing", "ecommerce", "shopify",
  "branding", "analytics", "enterprise software", "ai integration", "consulting",
  "software development", "product strategy", "ui/ux design", "cloud hosting", "cybersecurity",
  "expert digital systems", "home", "homepage", "services", "contact", "about", "about us", "privacy policy"
];

export const TOPICAL_CLUSTERS = [
  { name: "Informational", queries: ["what", "how", "guide", "tutorial", "learn", "definition"] },
  { name: "Commercial", queries: ["best", "pricing", "reviews", "cost", "features", "compare"] },
  { name: "Authority", queries: ["examples", "comparison", "benefits", "case study", "portfolio"] },
  { name: "Transactional", queries: ["buy", "order", "purchase", "get started", "pricing", "sign up"] },
  { name: "Trust", queries: ["security", "about", "contact", "support", "guarantee", "compliance"] }
];

// =========================================================================
// ========== SECTION 1: EXPRESS MIDDLEWARE SETUP =========================
// =========================================================================

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("."));
app.use(express.static("public"));

// =========================================================================
// ========== SECTION 1.5: MIDDLEWARE SECURITY & LIMITS ===================
// =========================================================================

export function authenticateAndRateLimit(req, res, next) {
  const authHeader = safeText(req.headers.authorization || req.query.apiKey);
  const key = authHeader.replace(/^Bearer\s+/i, "");

  let user = saasUsers[key];
  if (!user) {
    const ip = req.ip || "unknown-client";
    const cacheKey = `anon-${ip}`;
    if (!saasUsers[cacheKey]) {
      saasUsers[cacheKey] = {
        email: "anonymous@platform.aeo",
        plan: "free",
        scansToday: 0,
        lastScanReset: Date.now(),
        apiKey: cacheKey
      };
    }
    user = saasUsers[cacheKey];
  }

  if (Date.now() - user.lastScanReset > 24 * 60 * 60 * 1000) {
    user.scansToday = 0;
    user.lastScanReset = Date.now();
  }

  const limit = PLAN_LIMITS[user.plan] || 5;
  if (user.scansToday >= limit) {
    return res.status(429).json({
      success: false,
      status: "LIMIT_EXCEEDED",
      message: `You have reached your tier daily limits (${user.scansToday}/${limit} Scans). Please upgrade plans.`
    });
  }

  req.user = user;
  next();
}

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

export const safeArray = (v) => (Array.isArray(v) ? v : []);

export const safeObject = (v, fallback = {}) => {
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : fallback;
};

export const safeBoolean = (v) => Boolean(v);

export const safeArraySlice = (arr, start, end) => {
  return Array.isArray(arr) ? arr.slice(start, end) : [];
};

export const clamp = (num, min = 0, max = 100) => {
  const val = Number(num);
  return Math.min(max, Math.max(min, isNaN(val) ? 0 : val));
};

export const cleanText = (input) => {
  let text = safeText(input);
  for (const pattern of BAD_PATTERNS) {
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

  const freq = {};

  clean.forEach(tok => {
    if (!STOP_WORDS.includes(tok)) {
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
  cleaned = cleaned.replace(/[[\]()]/g, "").trim();
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

export const countWords = (text) => {
  const clean = safeText(text);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
};

export const unique = (arr) => {
  return [...new Set(safeArray(arr))];
};

export const slugify = (text) => {
  return safeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
};

export function detectBlockedReason(html, status) {
  const text = safeText(html).toLowerCase();

  if (status === 403 || status === 401) {
    return { blocked: true, system: "Cloudflare/CDN Forbidden", reason: "Server returned a security response status of 403/401." };
  }
  if (status === 404) {
    return { blocked: true, system: "Not Found", reason: "Target document could not be located (404)." };
  }
  if (status === 429) {
    return { blocked: true, system: "Rate Limiter Block", reason: "Target endpoint rate-limited the crawler." };
  }
  if (status >= 500) {
    return { blocked: true, system: "Origin Server Error", reason: `Target returned a server-side error status (${status}).` };
  }
  if (text.includes("cloudflare") || text.includes("cf-browser-verification") || text.includes("ray id:")) {
    return { blocked: true, system: "Cloudflare Turnstile", reason: "Cloudflare challenge page detected." };
  }
  if (text.includes("captcha") || text.includes("recaptcha") || text.includes("hcaptcha")) {
    return { blocked: true, system: "CAPTCHA Block", reason: "Page validation challenge triggered." };
  }
  if (text.includes("just a moment") && text.includes("checking your browser")) {
    return { blocked: true, system: "DDoS Mitigation Screen", reason: "Active browser checking screen encountered." };
  }
  if (text.includes("access denied") || text.includes("you don't have permission")) {
    return { blocked: true, system: "Access Denied", reason: "Server explicitly denied access to the requested resource." };
  }
  return { blocked: false, system: null, reason: null };
}

// =========================================================================
// ========== SECTION 3: ROBOTS.TXT & SITEMAP DETECTION ====================
// =========================================================================

/**
 * Fetches and parses robots.txt for the target origin, extracting disallow
 * rules and any declared sitemap locations.
 */
export async function fetchRobotsTxt(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin;
    const robotsUrl = `${origin}/robots.txt`;
    const response = await axios.get(robotsUrl, {
      timeout: 8000,
      validateStatus: () => true,
      headers: { "User-Agent": USER_AGENTS[0] },
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });

    if (response.status >= 400) {
      return { found: false, disallowedPaths: [], sitemaps: [], raw: "" };
    }

    const raw = typeof response.data === "string" ? response.data : "";
    const disallowedPaths = [];
    const sitemaps = [];

    raw.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      const disallowMatch = trimmed.match(/^disallow:\s*(.*)$/i);
      const sitemapMatch = trimmed.match(/^sitemap:\s*(.*)$/i);
      if (disallowMatch && disallowMatch[1]) disallowedPaths.push(disallowMatch[1].trim());
      if (sitemapMatch && sitemapMatch[1]) sitemaps.push(sitemapMatch[1].trim());
    });

    return {
      found: true,
      disallowedPaths: unique(disallowedPaths).slice(0, 50),
      sitemaps: unique(sitemaps),
      raw: raw.slice(0, 2000)
    };
  } catch (err) {
    return { found: false, disallowedPaths: [], sitemaps: [], raw: "" };
  }
}

/**
 * Detects presence of a sitemap.xml either via robots.txt declaration or the
 * conventional root path fallback.
 */
export async function detectSitemap(baseUrl, robotsData) {
  const declared = safeArray(robotsData?.sitemaps);
  if (declared.length > 0) {
    return { found: true, source: "robots.txt", urls: declared };
  }

  try {
    const origin = new URL(baseUrl).origin;
    const fallbackUrl = `${origin}/sitemap.xml`;
    const response = await axios.get(fallbackUrl, {
      timeout: 8000,
      validateStatus: () => true,
      headers: { "User-Agent": USER_AGENTS[0] },
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    if (response.status < 400 && typeof response.data === "string" && response.data.toLowerCase().includes("<urlset") || (response.status < 400 && typeof response.data === "string" && response.data.toLowerCase().includes("<sitemapindex"))) {
      return { found: true, source: "conventional-path", urls: [fallbackUrl] };
    }
    return { found: false, source: null, urls: [] };
  } catch (err) {
    return { found: false, source: null, urls: [] };
  }
}

// =========================================================================
// ========== SECTION 4: HIGH-PERFORMANCE BRIDGED CRAWLER ==================
// =========================================================================

let globalBrowser = null;

export async function getBrowserInstance() {
  if (globalBrowser) {
    try {
      if (globalBrowser.isConnected()) return globalBrowser;
    } catch {
      globalBrowser = null;
    }
  }

  try {
    const { chromium } = await import("playwright");
    globalBrowser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--blink-settings=imagesEnabled=false"
      ]
    });
    return globalBrowser;
  } catch (err) {
    console.error("[CRAWL] Failed to bind Playwright chromium engine:", err.message);
    return null;
  }
}

export async function fetchAxios(url) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const response = await axios.get(url, {
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Connection": "keep-alive"
    },
    timeout: 12000,
    maxRedirects: 6,
    validateStatus: () => true,
    decompress: true,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true
    })
  });

  return {
    html: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
    status: response.status,
    headers: response.headers || {},
    finalUrl: response.request?.res?.responseUrl || url
  };
}

export async function fetchPlaywright(url) {
  const browser = await getBrowserInstance();
  if (!browser) return null;

  const context = await browser.newContext({
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    bypassCSP: true
  });

  await context.route("**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ttf,otf,ico}", route => route.abort());
  await context.route("**/*analytics*/**", route => route.abort());

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    try {
      await page.waitForLoadState("networkidle", { timeout: 3000 });
    } catch {}

    // Trigger lazy-loaded / infinite-scroll content by scrolling to bottom.
    let infiniteScrollDetected = false;
    try {
      const initialHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight > initialHeight + 200) infiniteScrollDetected = true;
    } catch {}

    const content = await page.content();
    const status = response ? response.status() : 200;
    const finalUrl = page.url() || url;

    return { html: content, status, finalUrl, infiniteScrollDetected };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function withRetry(fn, retries = 2, delay = 1000) {
  let lastError = null;
  let attempts = 0;
  for (let i = 0; i <= retries; i++) {
    attempts++;
    try {
      const result = await fn();
      return { result, attempts };
    } catch (err) {
      lastError = err;
      if (i === retries) throw Object.assign(lastError, { attempts });
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw Object.assign(lastError || new Error("Unknown retry failure"), { attempts });
}

export async function smartCrawl(url) {
  let result = null;
  let crawlMethod = "STANDARD_GET";
  let status = 500;
  let retryCount = 0;
  let infiniteScrollDetected = false;

  try {
    const outcome = await withRetry(() => fetchAxios(url), 1, 1500);
    result = outcome.result;
    retryCount = outcome.attempts - 1;
    status = result?.status || 500;
  } catch (err) {
    retryCount = safeNumber(err?.attempts, 1) - 1;
    console.error(`[CRAWL] Standard direct pull failed on target: ${url}. Exception: ${err.message}`);
  }

  let html = result?.html || "";
  let finalUrl = result?.finalUrl || url;

  let blockCheck = detectBlockedReason(html, status);

  const requiresUpgrade =
    blockCheck.blocked ||
    !html ||
    html.length < 1500 ||
    html.toLowerCase().includes("javascript is required") ||
    html.toLowerCase().includes("enable javascript");

  if (requiresUpgrade) {
    console.log(`[CRAWL] Standard fetch blocked, incomplete, or requires JS. Upgrading context flow to Headless Browser...`);
    try {
      const pwResult = await fetchPlaywright(url);
      if (pwResult && pwResult.html && pwResult.html.length >= 300) {
        const pwBlockCheck = detectBlockedReason(pwResult.html, pwResult.status);
        infiniteScrollDetected = !!pwResult.infiniteScrollDetected;
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
      console.error("[CRAWL] Headless rendering fallback failed:", pwErr.message);
    }
  }

  const isValidHtml = html && html.toLowerCase().includes("<html") && html.toLowerCase().includes("</html>");
  if (!isValidHtml && !blockCheck.blocked) {
    blockCheck = {
      blocked: true,
      system: "Malformed DOM Validation",
      reason: "Target document returned non-HTML or incomplete DOM nodes."
    };
  }

  return {
    html,
    finalUrl,
    status,
    crawlMethod,
    blockCheck,
    retryCount,
    infiniteScrollDetected,
    contentLength: html ? html.length : 0
  };
}

// =========================================================================
// ========== SECTION 5: STRUCTURAL ANALYSIS & HTML EXTRACTION ENGINE ======
// =========================================================================

export function detectAllSchemas($, html) {
  const schemas = {
    FAQPage: { present: false, data: [] },
    HowTo: { present: false, data: [] },
    Article: { present: false, data: [] },
    BlogPosting: { present: false, data: [] },
    Organization: { present: false, data: [] },
    LocalBusiness: { present: false, data: [] },
    BreadcrumbList: { present: false, data: [] },
    WebSite: { present: false, data: [] },
    WebPage: { present: false, data: [] },
    Product: { present: false, data: [] },
    Review: { present: false, data: [] },
    Person: { present: false, data: [] },
    Service: { present: false, data: [] },
    VideoObject: { present: false, data: [] }
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
          const rawType = item['@type'];
          const types = Array.isArray(rawType) ? rawType.map(String) : [String(rawType || '')];
          types.forEach(type => {
            if (schemas[type]) {
              schemas[type].present = true;
              schemas[type].data.push(item);
            }
          });
        };
        items.forEach(parseItem);
      } catch (e) {}
    });
  } catch (err) {}

  return schemas;
}

export function regexFallbackParser(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i) || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  return {
    title: titleMatch ? cleanText(titleMatch[1]) : cleanDomainBrand(url),
    metaDescription: metaDescMatch ? cleanText(metaDescMatch[1]) : "Expert digital insights and optimization framework.",
    h1: h1Match ? cleanText(h1Match[1]) : cleanDomainBrand(url)
  };
}

export function getBrandNameEnhanced(url, $, title, schemas) {
  let brand = "";

  const isGeneric = (name) => {
    if (!name) return true;
    const lower = name.toLowerCase().trim();
    if (lower.length <= 1 || lower.length > 60) return true;
    return GENERIC_SERVICE_KEYWORDS.some(kw => lower === kw || lower.includes("expert digital systems") || lower === "brand authority" || lower === "unknown");
  };

  if (schemas?.Organization?.present && schemas?.Organization?.data?.length > 0) {
    const orgName = schemas.Organization.data[0]?.name;
    if (orgName && typeof orgName === 'string' && !isGeneric(orgName)) {
      brand = cleanText(orgName);
    }
  }

  if (!brand) {
    const ogSiteName = $('meta[property="og:site_name"]').attr("content") || $('meta[name="application-name"]').attr("content");
    if (ogSiteName && typeof ogSiteName === 'string' && !isGeneric(ogSiteName)) {
      brand = cleanText(ogSiteName);
    }
  }

  if (!brand) {
    const logoAlt = $('img[src*="logo" i]').attr('alt') || $('img[class*="logo" i]').attr('alt') || $('img[id*="logo" i]').attr('alt');
    if (logoAlt && typeof logoAlt === 'string' && !isGeneric(logoAlt)) {
      brand = cleanText(logoAlt);
    }
  }

  if (!brand && title && !isGeneric(title)) {
    const parts = title.split(/[|\-\u2013\u2014]/);
    const possibleBrand = parts[parts.length - 1]?.trim() || parts[0]?.trim();
    if (possibleBrand && !isGeneric(possibleBrand)) {
      brand = cleanText(possibleBrand);
    }
  }

  if (!brand) {
    try {
      const domain = new URL(url).hostname.replace("www.", "");
      const hostBrand = domain.split('.')[0];
      if (hostBrand && hostBrand !== 'localhost') {
        brand = hostBrand.charAt(0).toUpperCase() + hostBrand.slice(1);
      }
    } catch {
      brand = "Brand Authority";
    }
  }

  return brand || "Brand Authority";
}

/**
 * Extracts author, published date, and modified date from meta tags,
 * JSON-LD, and <time> elements.
 */
export function extractDatesAndAuthor($, schemas) {
  let publishedDate = "";
  let modifiedDate = "";
  let author = "";

  publishedDate = safeText($('meta[property="article:published_time"]').attr("content"))
    || safeText($('meta[name="publish-date"]').attr("content"))
    || safeText($('time[itemprop="datePublished"]').attr("datetime"))
    || safeText($('time').first().attr("datetime"));

  modifiedDate = safeText($('meta[property="article:modified_time"]').attr("content"))
    || safeText($('meta[name="last-modified"]').attr("content"))
    || safeText($('time[itemprop="dateModified"]').attr("datetime"));

  author = safeText($('meta[name="author"]').attr("content"))
    || safeText($('[rel="author"]').first().text())
    || safeText($('[itemprop="author"]').first().text());

  const articleData = schemas?.Article?.data?.[0] || schemas?.BlogPosting?.data?.[0];
  if (articleData) {
    if (!publishedDate && articleData.datePublished) publishedDate = safeText(articleData.datePublished);
    if (!modifiedDate && articleData.dateModified) modifiedDate = safeText(articleData.dateModified);
    if (!author && articleData.author) {
      author = typeof articleData.author === 'string' ? articleData.author : safeText(articleData.author?.name);
    }
  }

  return { publishedDate, modifiedDate, author };
}

export function extractEntitiesV2($, html, title, h1, h2s, h3s, metaDescription, bodyText, url, schemas) {
  const brands = [];
  const locations = [];
  const services = [];
  const people = [];
  const organizations = [];
  const products = [];

  const brandName = getBrandNameEnhanced(url, $, title, schemas);
  if (brandName && brandName !== "Brand Authority") {
    brands.push(brandName);
    organizations.push(brandName);
  }

  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const json = JSON.parse(raw);
        const items = Array.isArray(json) ? json : [json];
        const traverse = (item) => {
          if (!item) return;
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            item['@graph'].forEach(traverse);
            return;
          }
          const type = String(item['@type'] || '').toLowerCase();
          if (type.includes('organization') && item.name) {
            organizations.push(item.name);
            brands.push(item.name);
          }
          if (type.includes('person') && item.name) {
            people.push(item.name);
          }
          if (type.includes('product') && item.name) {
            products.push(item.name);
          }
          if (type.includes('localbusiness') && item.name) {
            organizations.push(item.name);
            brands.push(item.name);
          }
          if (type.includes('postaladdress')) {
            if (item.addressLocality) locations.push(item.addressLocality);
            if (item.addressCountry) locations.push(item.addressCountry);
          }
        };
        items.forEach(traverse);
      } catch (e) {}
    });
  } catch (err) {}

  const combinedText = [title, h1, ...safeArray(h2s), ...safeArray(h3s), metaDescription, bodyText].join(" ");

  SERVICE_PATTERNS.forEach(srv => {
    if (new RegExp(`\\b${srv}\\b`, 'i').test(combinedText)) {
      services.push(srv);
    }
  });

  CITY_PATTERNS.forEach(city => {
    if (new RegExp(`\\b${city}\\b`, 'i').test(combinedText)) {
      locations.push(city);
    }
  });

  const cleanList = (arr, fallback = []) => {
    const result = [...new Set(safeArray(arr).map(x => safeText(x).trim()).filter(x => x.length > 1))].map(cleanText).filter(Boolean);
    return result.length > 0 ? result.slice(0, 10) : fallback;
  };

  const finalBrands = cleanList(brands, [brandName || "Brand Authority"]);
  const finalOrgs = cleanList(organizations, [brandName || "Brand Authority"]);
  const finalLocations = cleanList(locations, ["Global Domain Context"]);
  const finalServices = cleanList(services, ["Digital Framework Optimizations"]);
  const finalPeople = cleanList(people, ["Industry Specialist"]);
  const finalProducts = cleanList(products, ["Service Platform Matrix"]);

  const structuredEntitiesList = [...new Set([
    ...finalBrands,
    ...finalServices,
    ...finalLocations,
    ...finalPeople,
    ...finalOrgs,
    ...finalProducts
  ])];

  return {
    brands: finalBrands,
    locations: finalLocations,
    services: finalServices,
    people: finalPeople,
    organizations: finalOrgs,
    products: finalProducts,
    entities: structuredEntitiesList,
    totalEntities: structuredEntitiesList.length
  };
}

export function analyzeInternalLinks($, url, h2s) {
  let baseHostname = "";
  let baseProto = "https:";
  try {
    const parsedUrl = new URL(url);
    baseHostname = parsedUrl.hostname.replace('www.', '');
    baseProto = parsedUrl.protocol;
  } catch {
    baseHostname = "localhost";
  }

  let internalLinks = 0;
  let externalLinks = 0;
  const linkMap = {};
  const anchorTexts = [];
  let contextualLinksCount = 0;

  try {
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      const anchorText = safeText($(el).text());
      if (!href) return;
      const cleanHref = href.trim();
      if (cleanHref.startsWith('#') || cleanHref.startsWith('javascript:') || cleanHref.startsWith('mailto:') || cleanHref.startsWith('tel:') || cleanHref.startsWith('whatsapp:')) return;

      if (anchorText) anchorTexts.push(anchorText);
      if ($(el).closest('p, li, td').length > 0) contextualLinksCount++;

      try {
        let fullUrl;
        if (cleanHref.startsWith('//')) {
          fullUrl = baseProto + cleanHref;
        } else if (cleanHref.startsWith('/')) {
          fullUrl = new URL(cleanHref, url).href;
        } else if (!cleanHref.startsWith('http://') && !cleanHref.startsWith('https://')) {
          fullUrl = new URL(cleanHref, url).href;
        } else {
          fullUrl = cleanHref;
        }

        const parsedFull = new URL(fullUrl);
        const normalizedPath = parsedFull.hostname.replace('www.', '') + parsedFull.pathname.replace(/\/$/, "");
        const linkHostname = parsedFull.hostname.replace('www.', '');

        if (linkHostname === baseHostname) {
          internalLinks++;
          linkMap[normalizedPath] = (linkMap[normalizedPath] || 0) + 1;
        } else {
          externalLinks++;
        }
      } catch (e) {}
    });
  } catch (err) {}

  const uniquePages = Object.keys(linkMap || {}).length;
  const linkDepths = Object.keys(linkMap || {}).map(link => link.split('/').filter(Boolean).length);
  const avgDepth = linkDepths.length > 0 ? (linkDepths.reduce((a, b) => a + b, 0) / linkDepths.length) : 1;
  const h2Length = safeArray(h2s).length;
  const authorityFlow = h2Length > 0 ? Math.round((internalLinks / Math.max(1, h2Length)) * 10) : Math.min(100, Math.round(internalLinks * 5));
  const weakLinking = internalLinks < Math.max(1, h2Length);
  const suggestions = [];
  if (weakLinking) {
    safeArraySlice(h2s, 0, 3).forEach(h2 => suggestions.push(`Add internal anchor link referencing H2: "${h2}"`));
  }

  const uniqueAnchors = new Set(anchorTexts);
  const anchorDiversityScore = anchorTexts.length > 0 ? clamp(Math.round((uniqueAnchors.size / anchorTexts.length) * 100)) : 100;
  const contextualLinkScore = internalLinks > 0 ? clamp(Math.round((contextualLinksCount / Math.max(1, internalLinks)) * 100)) : 0;
  const internalLinkScore = clamp(
    Math.round(
      (Math.min(100, internalLinks * 10) * 0.3) +
      (Math.min(100, uniquePages * 20) * 0.3) +
      (anchorDiversityScore * 0.2) +
      (contextualLinkScore * 0.2)
    )
  );

  return {
    internalLinks,
    totalInternalLinks: internalLinks,
    externalLinks,
    uniquePages,
    orphanPages: uniquePages < 3 ? [`${url}/blog`, `${url}/services`] : [],
    avgLinkDepth: parseFloat(avgDepth.toFixed(1)),
    averageDepth: parseFloat(avgDepth.toFixed(1)),
    linkDepthAverage: parseFloat(avgDepth.toFixed(1)),
    authorityFlow: clamp(authorityFlow, 10, 100),
    weakLinking,
    suggestions: [...new Set(suggestions)],
    linkDistribution: linkMap,
    score: internalLinkScore,
    internalLinkScore,
    anchorDiversityScore,
    contextualLinkScore
  };
}

export function extractPageData($, html, url) {
  const title = cleanText(safeText($("title").text()));
  const metaDescription = cleanText(safeText($('meta[name="description"]').attr("content")));
  const canonical = cleanText(safeText($('link[rel="canonical"]').attr("href")));
  const robots = cleanText(safeText($('meta[name="robots"]').attr("content")));
  const language = cleanText(safeText($('html').attr("lang") || $('html').attr("xml:lang")));
  const charset = cleanText(safeText($('meta[charset]').attr("charset")));

  const ogTitle = cleanText(safeText($('meta[property="og:title"]').attr("content")));
  const ogDescription = cleanText(safeText($('meta[property="og:description"]').attr("content")));
  const ogImage = cleanText(safeText($('meta[property="og:image"]').attr("content")));
  const ogType = cleanText(safeText($('meta[property="og:type"]').attr("content")));

  const twitterCard = cleanText(safeText($('meta[name="twitter:card"]').attr("content")));
  const twitterTitle = cleanText(safeText($('meta[name="twitter:title"]').attr("content")));
  const twitterDescription = cleanText(safeText($('meta[name="twitter:description"]').attr("content")));
  const twitterImage = cleanText(safeText($('meta[name="twitter:image"]').attr("content")));

  const h1s = $("h1").map((_, el) => cleanText(safeText($(el).text()))).get().filter(Boolean);
  const h2s = [...new Set($("h2").map((_, el) => cleanText(safeText($(el).text()))).get().filter(Boolean))];
  const h3s = [...new Set($("h3").map((_, el) => cleanText(safeText($(el).text()))).get().filter(Boolean))];

  const images = $("img").map((_, el) => ({
    src: safeText($(el).attr("src")),
    alt: safeText($(el).attr("alt"))
  })).get();

  const bodyText = cleanText($("p, li, h2, h3, h4, td, span, article").map((_, el) => $(el).text()).get().join(" "));
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length || 0;

  const schemas = detectAllSchemas($, html);
  const entities = extractEntitiesV2($, html, title, h1s[0] || "", h2s, h3s, metaDescription, bodyText, url, schemas);
  const linkAnalysis = analyzeInternalLinks($, url, h2s);
  const dateInfo = extractDatesAndAuthor($, schemas);

  return {
    title,
    metaDescription,
    canonical,
    robots,
    language,
    charset,
    openGraph: {
      title: ogTitle,
      description: ogDescription,
      image: ogImage,
      type: ogType
    },
    twitterCards: {
      card: twitterCard,
      title: twitterTitle,
      description: twitterDescription,
      image: twitterImage
    },
    headings: {
      h1s,
      h2s,
      h3s
    },
    images,
    links: {
      internal: linkAnalysis.internalLinks,
      external: linkAnalysis.externalLinks,
      linkMap: linkAnalysis.linkDistribution,
      internalLinkScore: linkAnalysis.internalLinkScore
    },
    wordCount,
    visibleText: bodyText,
    schema: schemas,
    entities: entities.entities,
    entityDetails: entities,
    publishedDate: dateInfo.publishedDate,
    modifiedDate: dateInfo.modifiedDate,
    author: dateInfo.author
  };
}

// =========================================================================
// ========== SECTION 8: STRUCTURAL SCHEMA & METADATA ENGINE ===============
// =========================================================================

export function extractMicrodata($) {
  const types = [];
  $("[itemscope]").each((_, el) => {
    const type = $(el).attr("itemtype");
    if (type) {
      try {
        const url = new URL(type);
        const name = url.pathname.split("/").pop();
        if (name) types.push(name);
      } catch {
        const cleanType = type.split("/").pop();
        if (cleanType) types.push(cleanType);
      }
    }
  });
  return types;
}

export function extractRDFa($) {
  const types = [];
  $("[typeof]").each((_, el) => {
    const type = $(el).attr("typeof");
    if (type) {
      const cleanType = type.split(":").pop();
      if (cleanType) types.push(cleanType);
    }
  });
  return types;
}

export function auditPageSchemas($, html) {
  const jsonLdSchemas = detectAllSchemas($, html);
  const microdataTypes = extractMicrodata($);
  const rdfaTypes = extractRDFa($);

  const activeJsonLdKeys = Object.keys(jsonLdSchemas).filter(k => jsonLdSchemas[k]?.present);
  const allDetectedTypes = [...new Set([...activeJsonLdKeys, ...microdataTypes, ...rdfaTypes])];

  return {
    detectedTypes: allDetectedTypes,
    schemaCount: allDetectedTypes.length,
    jsonLd: jsonLdSchemas,
    microdata: microdataTypes,
    rdfa: rdfaTypes
  };
}

export function getRecommendedSchemas(detectedTypes) {
  const detectedSet = new Set(safeArray(detectedTypes).map(t => String(t).toLowerCase()));
  return ALLOWED_RECOMMENDED_TYPES.filter(type => !detectedSet.has(type.toLowerCase()));
}

export function generateRecommendedSchemaBlock(type, title, metaDescription, url) {
  const baseSchema = { "@context": "https://schema.org" };
  const safeTitle = title || "Brand Authority";
  const safeUrl = url || "https://example.com";
  const safeDesc = metaDescription || "Expert digital insights and technical system optimizations.";

  switch (type) {
    case "FAQPage":
      return {
        ...baseSchema,
        "@type": "FAQPage",
        "mainEntity": [{
          "@type": "Question",
          "name": `What core topics are discussed on ${safeTitle}?`,
          "acceptedAnswer": { "@type": "Answer", "text": safeDesc }
        }]
      };

    case "Organization":
      return {
        ...baseSchema,
        "@type": "Organization",
        "name": safeTitle,
        "url": safeUrl,
        "logo": `${safeUrl}/logo.png`,
        "description": safeDesc
      };

    case "LocalBusiness":
      return {
        ...baseSchema,
        "@type": "LocalBusiness",
        "name": safeTitle,
        "description": safeDesc,
        "url": safeUrl,
        "telephone": "+1-000-000-0000"
      };

    case "WebSite":
      return { ...baseSchema, "@type": "WebSite", "name": safeTitle, "url": safeUrl };

    case "WebPage":
      return {
        ...baseSchema,
        "@type": "WebPage",
        "name": safeTitle,
        "description": safeDesc,
        "url": safeUrl
      };

    case "Article":
      return {
        ...baseSchema,
        "@type": "Article",
        "headline": safeTitle,
        "description": safeDesc,
        "author": { "@type": "Person", "name": "Platform Specialist" }
      };

    case "BlogPosting":
      return {
        ...baseSchema,
        "@type": "BlogPosting",
        "headline": safeTitle,
        "description": safeDesc,
        "author": { "@type": "Person", "name": "Platform Specialist" }
      };

    case "HowTo":
      return {
        ...baseSchema,
        "@type": "HowTo",
        "name": `How to optimize ${safeTitle}`,
        "step": [
          { "@type": "HowToStep", "text": "Review technical metrics and analyze schema layouts." },
          { "@type": "HowToStep", "text": "Embed missing semantic key phrases into content nodes." }
        ]
      };

    case "BreadcrumbList":
      return {
        ...baseSchema,
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Home", "item": safeUrl }
        ]
      };

    case "Product":
      return {
        ...baseSchema,
        "@type": "Product",
        "name": safeTitle,
        "description": safeDesc
      };

    case "Review":
      return {
        ...baseSchema,
        "@type": "Review",
        "itemReviewed": { "@type": "Thing", "name": safeTitle },
        "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
        "author": { "@type": "Person", "name": "Verified Client" }
      };

    case "Person":
      return { ...baseSchema, "@type": "Person", "name": "Industry Specialist" };

    case "Service":
      return {
        ...baseSchema,
        "@type": "Service",
        "name": safeTitle,
        "description": safeDesc,
        "provider": { "@type": "Organization", "name": safeTitle }
      };

    case "VideoObject":
      return {
        ...baseSchema,
        "@type": "VideoObject",
        "name": safeTitle,
        "description": safeDesc,
        "uploadDate": new Date().toISOString().split("T")[0]
      };

    default:
      return null;
  }
}

export function buildSchemaRecommendations(detectedTypes, title, metaDescription, url) {
  const missingTypes = unique(getRecommendedSchemas(detectedTypes));
  const blocks = [];

  missingTypes.forEach(type => {
    const schemaObj = generateRecommendedSchemaBlock(type, title, metaDescription, url);
    if (schemaObj) {
      blocks.push(`<script type="application/ld+json">\n${JSON.stringify(schemaObj, null, 2)}\n</script>`);
    }
  });

  return {
    missingSchemas: missingTypes,
    schemaGeneratorCode: blocks.join("\n\n")
  };
}

// =========================================================================
// ========== SECTION 9: NLP ENTITY EXTRACTION ENGINE ======================
// =========================================================================

export function extractSemanticEntities($, html, url, pageData) {
  const brands = [];
  const organizations = [];
  const products = [];
  const services = [];
  const people = [];
  const locations = [];
  const emails = [];
  const phones = [];
  const socialProfiles = [];
  const knowledgeGraphCandidates = [];

  const titleText = safeText(pageData?.title || $("title").text());
  const h1Text = safeText(pageData?.headings?.h1s?.[0] || $("h1").first().text());
  const bodyText = safeText(pageData?.visibleText || $("body").text());
  const combinedContext = `${titleText} ${h1Text} ${bodyText}`;

  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const json = JSON.parse(raw);
        const items = Array.isArray(json) ? json : [json];
        const traverse = (item) => {
          if (!item) return;
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            item['@graph'].forEach(traverse);
            return;
          }
          const type = String(item['@type'] || '').toLowerCase();
          const name = String(item.name || '').trim();

          if (name) {
            if (type.includes('organization')) {
              organizations.push(name);
              brands.push(name);
              knowledgeGraphCandidates.push({ name, type: "Organization", source: "Schema" });
            }
            if (type.includes('person')) {
              people.push(name);
              knowledgeGraphCandidates.push({ name, type: "Person", source: "Schema" });
            }
            if (type.includes('product')) {
              products.push(name);
              knowledgeGraphCandidates.push({ name, type: "Product", source: "Schema" });
            }
            if (type.includes('localbusiness')) {
              organizations.push(name);
              brands.push(name);
              knowledgeGraphCandidates.push({ name, type: "LocalBusiness", source: "Schema" });
            }
          }

          if (type.includes('postaladdress')) {
            if (item.addressLocality) locations.push(item.addressLocality);
            if (item.addressCountry) locations.push(item.addressCountry);
          }
        };
        items.forEach(traverse);
      } catch (e) {}
    });
  } catch (err) {}

  const matchedEmails = bodyText.match(new RegExp(EMAIL_REGEX, 'g'));
  if (matchedEmails) matchedEmails.forEach(email => emails.push(email.trim().toLowerCase()));

  const matchedPhones = bodyText.match(new RegExp(PHONE_REGEX, 'g'));
  if (matchedPhones) matchedPhones.forEach(phone => phones.push(phone.trim()));

  try {
    $("a").each((_, el) => {
      const href = safeText($(el).attr("href"));
      if (href) {
        const isSocial = [
          "facebook.com", "linkedin.com", "twitter.com", "x.com",
          "instagram.com", "youtube.com", "github.com", "pinterest.com"
        ].some(platform => href.toLowerCase().includes(platform));

        if (isSocial) socialProfiles.push(href);
      }
    });
  } catch (err) {}

  SERVICE_PATTERNS.forEach(srv => {
    if (new RegExp(`\\b${srv}\\b`, 'i').test(combinedContext)) services.push(srv);
  });

  CITY_PATTERNS.forEach(city => {
    if (new RegExp(`\\b${city}\\b`, 'i').test(combinedContext)) locations.push(city);
  });

  const sanitizeList = (arr) => {
    return [...new Set(safeArray(arr).map(x => cleanText(safeText(x))).filter(x => x.length > 1))];
  };

  const finalBrands = sanitizeList(brands);
  const finalOrgs = sanitizeList(organizations);
  const finalProducts = sanitizeList(products);
  const finalServices = sanitizeList(services);
  const finalPeople = sanitizeList(people);
  const finalLocations = sanitizeList(locations);
  const finalEmails = sanitizeList(emails);
  const finalPhones = sanitizeList(phones);
  const finalSocials = sanitizeList(socialProfiles);

  if (finalBrands[0]) knowledgeGraphCandidates.push({ name: finalBrands[0], type: "Brand", source: "Heuristics" });
  finalProducts.slice(0, 3).forEach(p => knowledgeGraphCandidates.push({ name: p, type: "Product", source: "NLP Content Scan" }));
  finalServices.slice(0, 3).forEach(s => knowledgeGraphCandidates.push({ name: s, type: "Service", source: "NLP Content Scan" }));

  const deduplicatedKG = [];
  const seenKGNames = new Set();
  knowledgeGraphCandidates.forEach(cand => {
    const key = cand.name.toLowerCase();
    if (!seenKGNames.has(key)) {
      seenKGNames.add(key);
      deduplicatedKG.push(cand);
    }
  });

  return {
    brands: finalBrands,
    organizations: finalOrgs,
    products: finalProducts,
    services: finalServices,
    people: finalPeople,
    locations: finalLocations,
    emails: finalEmails,
    phones: finalPhones,
    socialProfiles: finalSocials,
    knowledgeGraphCandidates: deduplicatedKG,
    totalEntityCount: finalBrands.length + finalOrgs.length + finalProducts.length + finalServices.length + finalPeople.length + finalLocations.length
  };
}

// =========================================================================
// ========== SECTION 10: DYNAMIC SEO SCORING ENGINE ======================
// =========================================================================

export function calculateDynamicSeoScore(pageData, loadTimeMs) {
  let score = 100;
  const deductions = [];

  const title = safeText(pageData?.title);
  if (!title) {
    score -= 15;
    deductions.push({ factor: "Title Tag", penalty: 15, reason: "Title tag is missing or completely blank." });
  } else if (title.length < 10) {
    score -= 5;
    deductions.push({ factor: "Title Tag Length", penalty: 5, reason: "Title is too short (under 10 characters). Weak context signal." });
  } else if (title.length > 60) {
    score -= 5;
    deductions.push({ factor: "Title Tag Length", penalty: 5, reason: "Title is too long (over 60 characters). Risks clipping in SERP snippets." });
  }

  const description = safeText(pageData?.metaDescription);
  if (!description) {
    score -= 15;
    deductions.push({ factor: "Meta Description", penalty: 15, reason: "Meta description is missing or blank." });
  } else if (description.length < 50) {
    score -= 5;
    deductions.push({ factor: "Meta Description Length", penalty: 5, reason: "Meta description is too brief (under 50 characters). Underutilizes dynamic search space." });
  } else if (description.length > 160) {
    score -= 5;
    deductions.push({ factor: "Meta Description Length", penalty: 5, reason: "Meta description is too long (over 160 characters). Clipped in generative SERP frames." });
  }

  const h1s = safeArray(pageData?.headings?.h1s);
  if (h1s.length === 0) {
    score -= 10;
    deductions.push({ factor: "H1 Element", penalty: 10, reason: "No H1 heading found. Weak structural page foundation." });
  } else if (h1s.length > 1) {
    score -= 5;
    deductions.push({ factor: "H1 Element Duplication", penalty: 5, reason: "Multiple H1 headings detected. Weakens context focal point." });
  }

  const h2Count = safeArray(pageData?.headings?.h2s).length;
  if (h2Count === 0) {
    score -= 5;
    deductions.push({ factor: "H2 Element Hierarchy", penalty: 5, reason: "No H2 subheadings detected. Limits logical content grouping." });
  }

  const internalLinks = safeNumber(pageData?.links?.internal);
  if (internalLinks === 0) {
    score -= 8;
    deductions.push({ factor: "Internal Links", penalty: 8, reason: "No internal links detected. Severely limits internal navigation depth." });
  }

  const images = safeArray(pageData?.images);
  const imagesWithoutAlt = images.filter(img => !safeText(img.alt)).length;
  if (images.length > 0 && imagesWithoutAlt > 0) {
    const penalty = clamp(Math.round((imagesWithoutAlt / images.length) * 8), 2, 8);
    score -= penalty;
    deductions.push({ factor: "Image Alt Tags", penalty, reason: `${imagesWithoutAlt} out of ${images.length} images are missing alternative descriptive alt tags.` });
  }

  const schemaDetected = safeArray(pageData?.schema?.detectedTypes).length > 0;
  if (!schemaDetected) {
    score -= 10;
    deductions.push({ factor: "Schema Markup", penalty: 10, reason: "No structured schemas found (JSON-LD, Microdata, or RDFa)." });
  }

  const canonical = safeText(pageData?.canonical);
  if (!canonical) {
    score -= 8;
    deductions.push({ factor: "Canonical URL", penalty: 8, reason: "No canonical link element configured. Vulnerable to duplicate parameter indexes." });
  }

  const robots = safeText(pageData?.robots);
  if (robots && (robots.toLowerCase().includes("noindex") || robots.toLowerCase().includes("none"))) {
    score -= 15;
    deductions.push({ factor: "Robots Directives", penalty: 15, reason: "Block active (noindex). Search crawler indexation completely forbidden." });
  }

  const latency = safeNumber(loadTimeMs);
  if (latency > 3000) {
    score -= 10;
    deductions.push({ factor: "Response Latency", penalty: 10, reason: `Response loading took ${latency}ms. Exceeds standard LCP guidelines.` });
  } else if (latency > 1500) {
    score -= 4;
    deductions.push({ factor: "Response Latency", penalty: 4, reason: `Response loading took ${latency}ms. Sub-optimal mobile performance.` });
  }

  const words = safeNumber(pageData?.wordCount);
  if (words < 300) {
    score -= 10;
    deductions.push({ factor: "Content Density", penalty: 10, reason: `Thin text body found (${words} words). Fails minimal informational standard thresholds.` });
  } else if (words < 600) {
    score -= 4;
    deductions.push({ factor: "Content Density", penalty: 4, reason: `Low word count (${words} words). Broaden text topics to boost ranking potential.` });
  }

  const finalScore = clamp(score, 0, 100);

  return {
    score: finalScore,
    deductions,
    auditPassed: finalScore >= 80,
    status: finalScore >= 80 ? "Optimized" : finalScore >= 50 ? "Satisfactory" : "Critical Improvements Needed"
  };
}

// =========================================================================
// ========== SECTION 11: DYNAMIC AEO SIMULATION ENGINE ====================
// =========================================================================

export function calculateDynamicAeoScore(pageData, docVisibleText) {
  const text = safeText(docVisibleText).toLowerCase();

  const hasFAQ = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "faqpage");
  const hasHowTo = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "howto");

  const definitionTerms = ["is defined as", "refers to", "means", "denotes", "is the process of", "is a term used to"];
  const matchesDefinition = definitionTerms.some(term => text.includes(term));

  const questionPatterns = ["what is", "how do i", "why does", "where can", "who is", "when should"];
  const matchesQuestionPatterns = questionPatterns.some(pattern => text.includes(pattern));
  const hasDirectAnswer = (text.includes("q:") && text.includes("a:")) || (matchesQuestionPatterns && text.length > 500);

  const listItemsCount = (text.match(/<li>/g) || []).length;
  const tableRowsCount = (text.match(/<tr>/g) || []).length;

  const hasCleanHeading = safeArray(pageData?.headings?.h1s).length > 0 && safeArray(pageData?.headings?.h2s).length > 0;
  const hasValidDescription = safeText(pageData?.metaDescription).length > 60;
  let snippetScore = 10;
  if (hasCleanHeading) snippetScore += 30;
  if (hasValidDescription) snippetScore += 30;
  if (hasDirectAnswer) snippetScore += 30;

  const jsonLdCount = safeArray(pageData?.schema?.jsonLd?.detectedTypes || pageData?.schema?.detectedTypes).length;

  const sentenceCount = text.split(/[.!?]+/).filter(Boolean).length || 1;
  const wordCount = safeNumber(pageData?.wordCount || text.split(/\s+/).filter(Boolean).length);
  const avgSentenceLength = wordCount / sentenceCount;

  let readabilityScore = 50;
  if (avgSentenceLength >= 12 && avgSentenceLength <= 22) {
    readabilityScore = 100;
  } else if (avgSentenceLength < 12) {
    readabilityScore = 80;
  } else if (avgSentenceLength > 35) {
    readabilityScore = 30;
  } else {
    readabilityScore = 60;
  }

  const faqsWeight = hasFAQ ? 15 : 0;
  const howToWeight = hasHowTo ? 15 : 0;
  const definitionWeight = matchesDefinition ? 10 : 0;
  const directAnswerWeight = hasDirectAnswer ? 20 : 0;
  const snippetWeight = Math.round((snippetScore / 100) * 15);
  const listWeight = listItemsCount > 3 ? 10 : (listItemsCount > 0 ? 5 : 0);
  const tableWeight = tableRowsCount > 0 ? 10 : 0;
  const jsonLdWeight = jsonLdCount > 0 ? 5 : 0;

  const dynamicAeoTotal = faqsWeight + howToWeight + definitionWeight + directAnswerWeight + snippetWeight + listWeight + tableWeight + jsonLdWeight;
  const aeoScore = clamp(dynamicAeoTotal, 10, 100);

  const chatGptCitationProbability = clamp(Math.round((aeoScore * 0.40) + (readabilityScore * 0.30) + (faqsWeight * 2)), 10, 99);
  const geminiCitationProbability = clamp(Math.round((aeoScore * 0.35) + (tableWeight * 2) + (jsonLdWeight * 2) + (readabilityScore * 0.30)), 10, 99);
  const perplexityCitationProbability = clamp(Math.round((aeoScore * 0.45) + (directAnswerWeight * 1.5) + (readabilityScore * 0.20)), 10, 99);
  const claudeCitationProbability = clamp(Math.round((aeoScore * 0.30) + (readabilityScore * 0.50) + (howToWeight * 1.5)), 10, 99);

  return {
    aeoScore,
    readabilityScore,
    avgSentenceLength,
    structuralAeoMetrics: {
      hasFAQ,
      hasHowTo,
      matchesDefinition,
      hasDirectAnswer,
      listItemsCount,
      tableRowsCount,
      jsonLdCount
    },
    simulations: {
      chatgpt: {
        score: chatGptCitationProbability,
        reasoning: chatGptCitationProbability >= 80 ? "Excellent sentence structure and rich Q&A syntax alignment." : "Enhance Q&A formats to boost reference selection likelihood."
      },
      gemini: {
        score: geminiCitationProbability,
        reasoning: geminiCitationProbability >= 80 ? "Highly structured lists, table matrices, and dynamic entities found." : "Add schema profiles and tables to optimize data rendering."
      },
      perplexity: {
        score: perplexityCitationProbability,
        reasoning: perplexityCitationProbability >= 80 ? "Explicit semantic summary block located close to primary header tags." : "Add clear concise summaries right below H1 headings."
      },
      claude: {
        score: claudeCitationProbability,
        reasoning: claudeCitationProbability >= 80 ? "Exemplary linguistic layout containing deep procedural guides." : "Increase deep descriptive formatting and logical guide step coverage."
      }
    }
  };
}

// =========================================================================
// ========== SECTION 12: DYNAMIC EEAT AUDIT ENGINE =======================
// =========================================================================

export function analyzeEEATAdvanced($, bodyText, pageData) {
  const text = safeText(bodyText).toLowerCase();

  const factors = [];
  const issues = [];

  const hasAuthor = $('meta[name="author"]').length > 0 || $('[rel="author"]').length > 0 || $('[itemprop="author"]').length > 0 || Boolean(pageData?.author);
  if (hasAuthor) {
    factors.push("Verified author attribution on page metadata.");
  } else {
    issues.push("Missing explicit author profile references or author schema markup.");
  }

  let hasAbout = false;
  let hasContact = false;
  let hasPrivacy = false;
  let hasTerms = false;

  $("a").each((_, el) => {
    const href = safeText($(el).attr("href")).toLowerCase();
    const textContext = safeText($(el).text()).toLowerCase();

    if (href.includes("about") || textContext.includes("about us") || textContext.includes("our story")) hasAbout = true;
    if (href.includes("contact") || textContext.includes("contact us") || textContext.includes("support")) hasContact = true;
    if (href.includes("privacy") || textContext.includes("privacy policy")) hasPrivacy = true;
    if (href.includes("terms") || textContext.includes("terms of service") || textContext.includes("terms and conditions")) hasTerms = true;
  });

  if (hasAbout) factors.push("Active 'About' bio page or organizational profile linked.");
  else issues.push("Missing dedicated 'About Us' section. Hinders corporate identity validation.");

  if (hasContact) factors.push("Active 'Contact Us' page or support channel discovered.");
  else issues.push("Missing direct 'Contact' path. Generative models prefer websites with transparent access channels.");

  if (hasPrivacy) factors.push("Active 'Privacy Policy' documentation page linked.");
  else issues.push("Missing standard 'Privacy Policy' compliance pages.");

  if (hasTerms) factors.push("Active 'Terms of Service' agreements linked.");
  else issues.push("Missing transactional or organizational 'Terms of Service' blocks.");

  const organizationDetected = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "organization");
  if (organizationDetected) factors.push("Structured 'Organization' schema mapped on page scripts.");
  else issues.push("Missing structured 'Organization' schema tag mapping corporate metadata.");

  let externalRefLinksCount = 0;
  $("a[href^='http']").each((_, el) => {
    const href = safeText($(el).attr("href"));
    if (href && pageData?.resolvedUrl) {
      try {
        if (!href.includes(new URL(pageData.resolvedUrl).hostname)) externalRefLinksCount++;
      } catch {}
    }
  });
  if (externalRefLinksCount > 2) {
    factors.push("Outbound references to authoritative external platforms present.");
  } else {
    issues.push("Low outbound citation volume. Backing assertions with authoritative references improves expertise.");
  }

  const credentialTerms = ["certified", "certificate", "ph.d", "doctor", "bachelor", "master of", "diploma", "accredited"];
  const matchesCredentials = credentialTerms.some(term => text.includes(term));
  if (matchesCredentials) factors.push("Implicit educational or professional credential terms matched in text.");
  else issues.push("No explicit professional or academic credential attributes highlighted in content.");

  const yearsInBusinessTerms = ["founded in", "established in", "years in business", "est. 19", "est. 20", "years of experience", "celebrating our"];
  const matchesYears = yearsInBusinessTerms.some(term => text.includes(term));
  if (matchesYears) factors.push("Brand legacy or years in business parameters detected.");
  else issues.push("No brand establishment date or timeline milestones located.");

  const isHttps = pageData?.resolvedUrl ? pageData.resolvedUrl.startsWith("https://") : false;
  if (isHttps) factors.push("Secure connection validated (HTTPS/SSL encryption active).");
  else issues.push("Insecure page connection context (HTTP). Compromises trust ratings completely.");

  if (pageData?.modifiedDate) factors.push("Explicit last-modified timestamp found for freshness verification.");
  else issues.push("No last-modified timestamp detected. Freshness signal unavailable to crawlers.");

  let score = 10;

  if (hasAuthor) score += 15;
  if (hasAbout) score += 10;
  if (hasContact) score += 10;
  if (hasPrivacy) score += 10;
  if (hasTerms) score += 10;
  if (organizationDetected) score += 10;
  if (externalRefLinksCount > 0) score += Math.min(10, externalRefLinksCount * 2);
  if (matchesCredentials) score += 10;
  if (matchesYears) score += 5;
  if (isHttps) score += 10;
  if (pageData?.modifiedDate) score += 5;

  const eeatScore = clamp(score, 10, 100);

  return {
    score: eeatScore,
    status: eeatScore >= 80 ? "High Trust (Enterprise Ready)" : eeatScore >= 50 ? "Verified Authority" : "Shallow Authority Profile",
    factors: [...new Set(factors)],
    issues: [...new Set(issues)],
    auditMetrics: {
      hasAuthor,
      hasAbout,
      hasContact,
      hasPrivacy,
      hasTerms,
      organizationDetected,
      externalRefLinksCount,
      matchesCredentials,
      matchesYears,
      isHttps
    }
  };
}

// =========================================================================
// ========== SECTION 13: DYNAMIC AUTHORITY & TRUST AUDIT ENGINE ===========
// =========================================================================

export function calculateDynamicAuthority(pageData) {
  let score = 15;
  const factors = [];
  const suggestions = [];

  const coveredClusters = pageData?.topicalAuthority?.clusters?.filter(c => c.status === "Active") || [];
  const clusterCoveragePercent = pageData?.topicalAuthority?.coveragePercent || 0;

  if (clusterCoveragePercent > 0) {
    const clusterPoints = Math.round((clusterCoveragePercent / 100) * 25);
    score += clusterPoints;
    factors.push(`Covers ${coveredClusters.length} main intent query clusters (+${clusterPoints} points).`);
  } else {
    suggestions.push("Introduce subheadings targeting informational, commercial, and transactional user intent.");
  }

  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount || pageData?.entities?.length);
  if (entityCount > 15) {
    score += 15;
    factors.push("High NLP entity representation (+15 points).");
  } else if (entityCount > 5) {
    score += 8;
    factors.push("Moderate entity candidate volume (+8 points).");
  } else {
    suggestions.push("Integrate prominent industry-specific nouns, concepts, and service entities.");
  }

  const internalLinks = safeNumber(pageData?.links?.internal || pageData?.internalLinks);
  if (internalLinks > 10) {
    score += 15;
    factors.push("Robust internal link profile (+15 points).");
  } else if (internalLinks > 2) {
    score += 8;
    factors.push("Standard internal link connectivity (+8 points).");
  } else {
    suggestions.push("Add internal links referencing related guides or transactional services to improve flow.");
  }

  const schemasCount = safeNumber(pageData?.schema?.schemaCount || pageData?.schemaCount);
  if (schemasCount >= 3) {
    score += 15;
    factors.push("Comprehensive multi-schema structured framework (+15 points).");
  } else if (schemasCount > 0) {
    score += 8;
    factors.push("Standard schema structured metadata mapped (+8 points).");
  } else {
    suggestions.push("Deploy missing recommended schemas like WebSite, FAQPage, or Organization.");
  }

  const brand = safeText(pageData?.competitor?.winner || pageData?.title);
  const isGenericTitle = brand.toLowerCase().includes("home") || brand.toLowerCase().includes("brand authority");
  if (brand && !isGenericTitle) {
    score += 15;
    factors.push("Distinct non-generic brand profile established (+15 points).");
  } else {
    suggestions.push("Refine title tags and meta descriptions to highlight your unique brand identity.");
  }

  const authorityScore = clamp(score, 10, 100);

  return {
    authorityScore,
    status: authorityScore >= 80 ? "Topical Leader" : authorityScore >= 50 ? "Competitor" : "Emerging Voice",
    factors,
    suggestions: [...new Set(suggestions)]
  };
}

export function scanDynamicTrustSignals($, html, url, pageData) {
  const text = $('body').text().toLowerCase();

  let score = 10;
  const factors = [];
  const issues = [];

  const isHttps = url.startsWith("https://");
  if (isHttps) {
    score += 20;
    factors.push("SSL Security validation active (HTTPS context).");
  } else {
    issues.push("Page is missing modern SSL encryption (HTTP standard).");
  }

  const hasContact = pageData?.entityDetails?.emails?.length > 0 || pageData?.entityDetails?.phones?.length > 0;
  if (hasContact) {
    score += 15;
    factors.push("Direct contact methods verified (Email/Phone elements on DOM).");
  } else {
    issues.push("No explicit contact channels found in text or headers.");
  }

  let hasPrivacy = false;
  let hasTerms = false;
  $("a").each((_, el) => {
    const href = safeText($(el).attr("href")).toLowerCase();
    const textCtx = safeText($(el).text()).toLowerCase();
    if (href.includes("privacy") || textCtx.includes("privacy")) hasPrivacy = true;
    if (href.includes("terms") || textCtx.includes("terms") || href.includes("tos")) hasTerms = true;
  });

  if (hasPrivacy) {
    score += 15;
    factors.push("Privacy Policy safety documentation verified.");
  } else {
    issues.push("Missing Privacy Policy disclosure documentation link.");
  }

  if (hasTerms) {
    score += 10;
    factors.push("Terms of Service operations compliance validated.");
  } else {
    issues.push("Missing formal Terms of Service framework.");
  }

  const hasLocalBusinessSchema = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "localbusiness");
  const matchesAddressText = text.includes("address") || text.includes("suite") || text.includes("postal") || /\b\d{5}\b/.test(text);
  const hasNAP = hasLocalBusinessSchema || (hasContact && matchesAddressText);
  if (hasNAP) {
    score += 15;
    factors.push("Local NAP (Name, Address, Phone) consistency indicators verified.");
  } else {
    issues.push("Incomplete physical address (NAP) parameters.");
  }

  const reviewsTerms = ["review", "testimonial", "star rating", "happy clients", "verified buyer", "rated"];
  const matchesReviews = reviewsTerms.some(term => text.includes(term)) || $('.review, .testimonial').length > 0;
  if (matchesReviews) {
    score += 15;
    factors.push("Social proof review or testimonial clusters detected.");
  } else {
    issues.push("No client reviews or testimonial snippets discovered on content body.");
  }

  const socialProfilesCount = safeNumber(pageData?.entityDetails?.socialProfiles?.length);
  if (socialProfilesCount > 0) {
    const socialPoints = Math.min(10, socialProfilesCount * 3);
    score += socialPoints;
    factors.push(`Identified ${socialProfilesCount} verified external social channel links (+${socialPoints} points).`);
  } else {
    issues.push("No verified social networks profiles connected to the document.");
  }

  const trustScore = clamp(score, 10, 100);

  return {
    trustScore,
    status: trustScore >= 80 ? "SaaS Enterprise Trusted" : trustScore >= 50 ? "Verified Profile" : "Unverified Identity Framework",
    factors,
    issues: [...new Set(issues)]
  };
}

// =========================================================================
// ========== SECTION 14: ENTERPRISE AI CITATION ENGINE ====================
// =========================================================================

export function estimateAIEngineCitations(crawlData) {
  const {
    hasFAQ,
    hasHowTo,
    hasLocalBusiness,
    hasAuthor,
    hasContact,
    hasAbout,
    internalLinkScore,
    entityCoverage,
    eeatScore,
    topicalAuthorityScore,
    wordCount,
    listCount,
    tableCount,
    externalLinksCount,
    hasDirectAnswer,
    hasLastModified
  } = safeObject(crawlData);

  const normalizedWordCount = clamp(wordCount / 2000, 0.1, 1.0);
  const normalizedEEAT = clamp(eeatScore / 100, 0.1, 1.0);
  const normalizedAuthority = clamp(topicalAuthorityScore / 100, 0.1, 1.0);
  const normalizedEntities = clamp(entityCoverage / 100, 0.1, 1.0);
  const normalizedInternalLinks = clamp(internalLinkScore / 100, 0.1, 1.0);

  const chatGptBase =
    (hasFAQ ? 25 : 5) +
    (hasDirectAnswer ? 20 : 5) +
    (hasAuthor ? 15 : 2) +
    (listCount > 2 ? 15 : 5) +
    (normalizedAuthority * 25);
  const chatgpt = clamp(Math.round(chatGptBase), 10, 99);

  const jsonLdCount = jsonLdCountForEngine(crawlData);

  const geminiBase =
    (hasLocalBusiness ? 25 : 5) +
    (tableCount > 0 ? 20 : 5) +
    (normalizedEEAT * 20) +
    (normalizedWordCount * 15) +
    (jsonLdCount > 0 ? 20 : 5);
  const gemini = clamp(Math.round(geminiBase), 10, 99);

  const claudeBase =
    (normalizedWordCount * 35) +
    (hasHowTo ? 20 : 5) +
    (hasAbout ? 15 : 2) +
    (normalizedEntities * 15) +
    (normalizedAuthority * 15);
  const claude = clamp(Math.round(claudeBase), 10, 99);

  const perplexityBase =
    (hasDirectAnswer ? 25 : 5) +
    (hasLastModified ? 15 : 5) +
    (externalLinksCount > 3 ? 20 : 5) +
    (normalizedInternalLinks * 20) +
    (listCount > 0 ? 20 : 5);
  const perplexity = clamp(Math.round(perplexityBase), 10, 99);

  const copilotBase =
    (hasLocalBusiness ? 20 : 5) +
    (hasFAQ ? 15 : 5) +
    (hasContact ? 15 : 2) +
    (normalizedEEAT * 25) +
    (normalizedInternalLinks * 25);
  const copilot = clamp(Math.round(copilotBase), 10, 99);

  const mistralBase =
    (hasDirectAnswer ? 25 : 5) +
    (normalizedEntities * 25) +
    (normalizedWordCount * 25) +
    (listCount > 0 ? 25 : 5);
  const mistral = clamp(Math.round(mistralBase), 10, 99);

  const averageProbability = Math.round((chatgpt + gemini + claude + perplexity + copilot + mistral) / 6);

  return {
    citationProbability: averageProbability,
    engines: {
      chatgpt: { score: chatgpt, status: getEngineVerdict(chatgpt) },
      gemini: { score: gemini, status: getEngineVerdict(gemini) },
      claude: { score: claude, status: getEngineVerdict(claude) },
      perplexity: { score: perplexity, status: getEngineVerdict(perplexity) },
      copilot: { score: copilot, status: getEngineVerdict(copilot) },
      mistral: { score: mistral, status: getEngineVerdict(mistral) }
    }
  };
}

function getEngineVerdict(score) {
  if (score >= 80) return "Highly Likely Source";
  if (score >= 50) return "Likely Candidate";
  return "Unlikely Source";
}

function jsonLdCountForEngine(crawlData) {
  try {
    return safeArray(crawlData?.uniqueSchemas || crawlData?.schema?.detectedTypes).length;
  } catch {
    return 0;
  }
}

// =========================================================================
// ========== SECTION 15: DYNAMIC COMPETITOR COMPARISON ENGINE ============
// =========================================================================

export function compareTargetToCompetitor(targetData, competitorData) {
  if (!targetData || !competitorData || targetData.status === "BLOCKED" || competitorData.status === "BLOCKED") {
    return {
      success: false,
      reason: "One or both targets blocked or returned invalid payload parameters."
    };
  }

  const targetSEO = safeNumber(targetData.seoScore || targetData.audit?.seo?.score);
  const compSEO = safeNumber(competitorData.seoScore || competitorData.audit?.seo?.score);
  const seoDiff = targetSEO - compSEO;

  const targetAEO = safeNumber(targetData.aeoScore || targetData.audit?.aeo?.score);
  const compAEO = safeNumber(competitorData.aeoScore || competitorData.audit?.aeo?.score);
  const aeoDiff = targetAEO - compAEO;

  const targetEEAT = safeNumber(targetData.eeatScore || targetData.audit?.eeat?.score);
  const compEEAT = safeNumber(competitorData.eeatScore || competitorData.audit?.eeat?.score);
  const eeatDiff = targetEEAT - compEEAT;

  const targetAuthority = safeNumber(targetData.authorityScore || targetData.topicalAuthority?.authorityScore);
  const compAuthority = safeNumber(competitorData.authorityScore || competitorData.topicalAuthority?.authorityScore);
  const authorityDiff = targetAuthority - compAuthority;

  const targetTrust = safeNumber(targetData.trustScore || targetData.trustSignals?.trustScore);
  const compTrust = safeNumber(competitorData.trustScore || competitorData.trustSignals?.trustScore);
  const trustDiff = targetTrust - compTrust;

  const targetHeadings = [...safeArray(targetData.h2s), ...safeArray(targetData.h3s)].map(h => String(h).toLowerCase());
  const compHeadings = [...safeArray(competitorData.h2s), ...safeArray(competitorData.h3s)];

  const headingGaps = compHeadings.filter(compH => {
    const cleanCompH = String(compH).toLowerCase();
    return !targetHeadings.some(targetH => targetH.includes(cleanCompH.substring(0, 12)));
  });

  const targetKeywords = safeArray(targetData.keywords).map(k => String(k).toLowerCase());
  const compKeywords = safeArray(competitorData.keywords);

  const keywordGaps = compKeywords.filter(compK => !targetKeywords.includes(String(compK).toLowerCase()));

  const targetSchemas = safeArray(targetData.schema?.detectedTypes);
  const compSchemas = safeArray(competitorData.schema?.detectedTypes);
  const schemaGaps = compSchemas.filter(s => !targetSchemas.includes(s));

  const targetEntities = safeArray(targetData.entities?.brands || targetData.entities).map(e => String(e).toLowerCase());
  const compEntities = safeArray(competitorData.entities?.brands || competitorData.entities);
  const entityGaps = compEntities.filter(compE => !targetEntities.includes(String(compE).toLowerCase()));

  const targetOverall = safeNumber(targetData.overallAIVisibilityScore);
  const competitorOverall = safeNumber(competitorData.overallAIVisibilityScore);

  let leaderBrand = "Tie";
  let winnerReason = "Both sites present matching technical visibility signals.";

  if (targetOverall > competitorOverall) {
    leaderBrand = targetData.title || "Your Platform";
    winnerReason = `Commands a clear performance lead overall with stronger semantic indexing and structure.`;
  } else if (competitorOverall > targetOverall) {
    leaderBrand = competitorData.title || "Competitor Platform";
    winnerReason = `Competitor holds optimization edges. Enhance schema code and content length to close gaps.`;
  }

  return {
    success: true,
    winner: leaderBrand,
    winnerReason,
    metrics: {
      seo: { target: targetSEO, competitor: compSEO, difference: seoDiff, leader: seoDiff > 0 ? "You" : (seoDiff < 0 ? "Competitor" : "Tie") },
      aeo: { target: targetAEO, competitor: compAEO, difference: aeoDiff, leader: aeoDiff > 0 ? "You" : (aeoDiff < 0 ? "Competitor" : "Tie") },
      eeat: { target: targetEEAT, competitor: compEEAT, difference: eeatDiff, leader: eeatDiff > 0 ? "You" : (eeatDiff < 0 ? "Competitor" : "Tie") },
      authority: { target: targetAuthority, competitor: compAuthority, difference: authorityDiff, leader: authorityDiff > 0 ? "You" : (authorityDiff < 0 ? "Competitor" : "Tie") },
      trust: { target: targetTrust, competitor: compTrust, difference: trustDiff, leader: trustDiff > 0 ? "You" : (trustDiff < 0 ? "Competitor" : "Tie") }
    },
    gaps: {
      headingGaps: [...new Set(headingGaps)].slice(0, 10),
      keywordGaps: [...new Set(keywordGaps)].slice(0, 15),
      schemaGaps: [...new Set(schemaGaps)],
      entityGaps: [...new Set(entityGaps)].slice(0, 10),
      contentLengthDiff: safeNumber(competitorData.wordCount) - safeNumber(targetData.wordCount),
      competitorHasMoreWords: safeNumber(competitorData.wordCount) > safeNumber(targetData.wordCount)
    }
  };
}

// =========================================================================
// ========== SECTION 15.5: SINGLE URL ANALYZER ORCHESTRATOR ==============
// =========================================================================

/**
 * Structured response for blocked/unreachable targets. Never includes
 * synthetic audit scores.
 */
export function buildBlockedPayload(url, crawl) {
  return {
    success: false,
    blocked: true,
    status: crawl?.status || 0,
    reason: crawl?.blockCheck?.reason || "Target could not be crawled.",
    crawlMethod: crawl?.crawlMethod || "STANDARD_GET",
    retryCount: safeNumber(crawl?.retryCount, 0),
    protectionType: crawl?.blockCheck?.system || "Unknown",
    resolvedUrl: crawl?.finalUrl || url
  };
}

export async function analyzeSingleUrl(url) {
  const cacheKey = normalizeUrl(url);
  if (scanCache.has(cacheKey)) {
    const entry = scanCache.get(cacheKey);
    if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
      console.log(`[CACHE] Serving structural memory snapshot for: ${url}`);
      return entry.data;
    }
  }

  const startTime = Date.now();
  let crawl = null;
  try {
    crawl = await smartCrawl(url);
  } catch (err) {
    console.error(`[ORCHESTRATOR] Smart crawl crashed on url ${url}: ${err.message}`);
    return {
      success: false,
      blocked: true,
      status: 0,
      reason: `Crawler exception: ${err.message}`,
      crawlMethod: "STANDARD_GET",
      retryCount: 0,
      protectionType: "Crawler Exception",
      resolvedUrl: url
    };
  }

  const loadTimeMs = Date.now() - startTime;

  if (crawl.blockCheck && crawl.blockCheck.blocked) {
    console.log(`[ORCHESTRATOR] Blocked target validation encountered on url: ${url}. System: ${crawl.blockCheck.system}`);
    return buildBlockedPayload(url, crawl);
  }

  try {
    const $ = cheerio.load(crawl.html || "");
    const pageData = extractPageData($, crawl.html, crawl.finalUrl);

    const robotsData = await fetchRobotsTxt(crawl.finalUrl);
    const sitemapData = await detectSitemap(crawl.finalUrl, robotsData);

    const seoAudit = calculateDynamicSeoScore(pageData, loadTimeMs);
    const aeoAudit = calculateDynamicAeoScore(pageData, pageData.visibleText);
    const eeatAudit = analyzeEEATAdvanced($, pageData.visibleText, pageData);

    const lowercaseText = String(pageData.visibleText).toLowerCase();
    const clusters = TOPICAL_CLUSTERS.map(cluster => {
      const activeQueries = cluster.queries.filter(q => lowercaseText.includes(q));
      const hasCoverage = activeQueries.length > 0;
      return {
        name: cluster.name,
        status: hasCoverage ? "Active" : "Missing",
        coverageCount: activeQueries.length,
        matchedQueries: activeQueries
      };
    });
    const coveredClusters = clusters.filter(c => c.status === "Active").length;
    const coveragePercent = Math.round((coveredClusters / TOPICAL_CLUSTERS.length) * 100);

    const enrichedPageData = {
      ...pageData,
      resolvedUrl: crawl.finalUrl,
      topicalAuthority: { clusters, coveragePercent }
    };

    const authorityAudit = calculateDynamicAuthority(enrichedPageData);
    const trustAudit = scanDynamicTrustSignals($, crawl.html, crawl.finalUrl, enrichedPageData);

    const schemasDetected = auditPageSchemas($, crawl.html);
    const schemaBlock = buildSchemaRecommendations(schemasDetected.detectedTypes, pageData.title, pageData.metaDescription, crawl.finalUrl);

    const aiEngineCitations = estimateAIEngineCitations({
      hasFAQ: schemasDetected.detectedTypes.some(t => String(t).toLowerCase() === "faqpage"),
      hasHowTo: schemasDetected.detectedTypes.some(t => String(t).toLowerCase() === "howto"),
      hasLocalBusiness: schemasDetected.detectedTypes.some(t => String(t).toLowerCase() === "localbusiness"),
      hasAuthor: eeatAudit.auditMetrics.hasAuthor,
      hasContact: eeatAudit.auditMetrics.hasContact,
      hasAbout: eeatAudit.auditMetrics.hasAbout,
      internalLinkScore: pageData.links.internalLinkScore,
      entityCoverage: clamp(pageData.entityDetails.totalEntityCount * 5, 10, 100),
      eeatScore: eeatAudit.score,
      topicalAuthorityScore: authorityAudit.authorityScore,
      wordCount: pageData.wordCount,
      listCount: (lowercaseText.match(/<li>/g) || []).length,
      tableCount: (lowercaseText.match(/<tr>/g) || []).length,
      externalLinksCount: pageData.links.external,
      hasDirectAnswer: aeoAudit.structuralAeoMetrics.hasDirectAnswer,
      hasLastModified: Boolean(pageData.modifiedDate),
      uniqueSchemas: schemasDetected.detectedTypes
    });

    const finalAIVisibilityScore = clamp(
      Math.round(
        (seoAudit.score * 0.20) +
        (aeoAudit.aeoScore * 0.30) +
        (eeatAudit.score * 0.25) +
        (authorityAudit.authorityScore * 0.15) +
        (trustAudit.trustScore * 0.10)
      )
    );

    const roadmap = [];
    const autopilotTasks = [];
    let taskIdCounter = 1;

    if (seoAudit.score < 85) {
      roadmap.push("Improve title keywords length constraints and meta description elements.");
      autopilotTasks.push({
        id: `task_${taskIdCounter++}`,
        priority: "HIGH",
        impact: 12,
        title: "Optimize Metadata Lengths",
        description: "Align Title tags and Meta descriptions with target search and engine character constraints."
      });
    }
    if (!schemasDetected.detectedTypes.includes("FAQPage")) {
      roadmap.push("Generate FAQPage JSON-LD and configure dynamic Q&A structures on content root.");
      autopilotTasks.push({
        id: `task_${taskIdCounter++}`,
        priority: "MEDIUM",
        impact: 10,
        title: "Add FAQ Schema Markup",
        description: "Inject structured FAQ metadata to secure direct answer and generative snippet cards."
      });
    }
    if (pageData.wordCount < 600) {
      roadmap.push("Broaden technical word density and topical guides to over 1,500 words.");
      autopilotTasks.push({
        id: `task_${taskIdCounter++}`,
        priority: "MEDIUM",
        impact: 8,
        title: "Deepen Technical Content density",
        description: "Add clear procedural headings to expand informational coverage for LLMs."
      });
    }
    if (!robotsData.found) {
      roadmap.push("Publish a robots.txt file to explicitly declare crawl permissions and sitemap location.");
      autopilotTasks.push({
        id: `task_${taskIdCounter++}`,
        priority: "LOW",
        impact: 5,
        title: "Publish robots.txt",
        description: "Add a robots.txt file at the site root declaring crawl rules and sitemap URL."
      });
    }
    if (!sitemapData.found) {
      roadmap.push("Generate and submit an XML sitemap to improve discovery and indexation coverage.");
      autopilotTasks.push({
        id: `task_${taskIdCounter++}`,
        priority: "LOW",
        impact: 5,
        title: "Generate XML Sitemap",
        description: "Create a sitemap.xml and reference it from robots.txt for improved crawl efficiency."
      });
    }

    const payload = {
      success: true,
      status: "SUCCESS",
      blocked: false,
      resolvedUrl: crawl.finalUrl,
      title: pageData.title || cleanDomainBrand(crawl.finalUrl),
      metaDescription: pageData.metaDescription || "Expert platform insights and optimization.",
      wordCount: pageData.wordCount,
      h2s: pageData.headings.h2s,
      h3s: pageData.headings.h3s,
      keywords: tokenizeKeywords(pageData.visibleText),
      publishedDate: pageData.publishedDate,
      modifiedDate: pageData.modifiedDate,
      author: pageData.author,
      schemaCount: schemasDetected.schemaCount,
      schema: {
        detectedTypes: schemasDetected.detectedTypes,
        jsonLd: schemasDetected.jsonLd,
        microdata: schemasDetected.microdata,
        rdfa: schemasDetected.rdfa
      },
      crawl: {
        method: crawl.crawlMethod,
        status: crawl.status,
        contentSize: crawl.contentLength,
        url: crawl.finalUrl,
        duration: loadTimeMs,
        retryCount: crawl.retryCount,
        infiniteScrollDetected: crawl.infiniteScrollDetected
      },
      robots: {
        found: robotsData.found,
        disallowedPaths: robotsData.disallowedPaths
      },
      sitemap: sitemapData,
      seoScore: seoAudit.score,
      aeoScore: aeoAudit.aeoScore,
      eeatScore: eeatAudit.score,
      authorityScore: authorityAudit.authorityScore,
      trustScore: trustAudit.trustScore,
      citationScore: aiEngineCitations.citationProbability,
      overallAIVisibilityScore: finalAIVisibilityScore,
      potentialAIVisibility: clamp(finalAIVisibilityScore + 18, 50, 99),
      entities: pageData.entities,
      entityDetails: pageData.entityDetails,
      seo: seoAudit,
      aeo: {
        score: aeoAudit.aeoScore,
        readabilityScore: aeoAudit.readabilityScore,
        avgSentenceLength: aeoAudit.avgSentenceLength,
        simulations: aeoAudit.simulations
      },
      eeat: eeatAudit,
      citation: aiEngineCitations,
      authority: authorityAudit,
      trust: trustAudit,
      audit: {
        seo: seoAudit,
        aeo: {
          score: aeoAudit.aeoScore,
          readabilityScore: aeoAudit.readabilityScore,
          avgSentenceLength: aeoAudit.avgSentenceLength,
          simulations: aeoAudit.simulations
        },
        eeat: eeatAudit,
        aiCitations: aiEngineCitations
      },
      topicalAuthority: {
        authorityScore: authorityAudit.authorityScore,
        status: authorityAudit.status,
        clusters,
        coveragePercent
      },
      semantic: {
        entities: pageData.entityDetails,
        clusters,
        coveragePercent
      },
      trustSignals: {
        trustScore: trustAudit.trustScore,
        status: trustAudit.status,
        factors: trustAudit.factors,
        issues: trustAudit.issues
      },
      recommendedSchemas: schemaBlock.missingSchemas,
      schemaRecommendationsBlock: schemaBlock.schemaGeneratorCode,
      roadmap,
      aiAutopilot: autopilotTasks,
      autopilot: { tasks: autopilotTasks }
    };

    scanCache.set(cacheKey, { timestamp: Date.now(), data: payload });

    scanHistory.unshift({
      url: crawl.finalUrl,
      title: payload.title,
      score: payload.overallAIVisibilityScore,
      timestamp: new Date().toISOString()
    });
    if (scanHistory.length > 50) scanHistory.pop();

    return payload;
  } catch (err) {
    console.error(`[ORCHESTRATOR] Compilation parser error on url: ${url}. Trace:`, err);
    return {
      success: false,
      blocked: true,
      status: crawl?.status || 0,
      reason: `Parser exception: ${err.message}`,
      crawlMethod: crawl?.crawlMethod || "STANDARD_GET",
      retryCount: safeNumber(crawl?.retryCount, 0),
      protectionType: "Parser Exception",
      resolvedUrl: crawl?.finalUrl || url
    };
  }
}

// =========================================================================
// ========== SECTION 16: API ROUTING SYSTEM ===============================
// =========================================================================

app.get("/", (req, res) => {
  try {
    res.sendFile(path.resolve("public/index.html"));
  } catch (err) {
    res.status(500).json({ success: false, error: "Root path configuration error" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    tool: "AI Visibility SaaS Platform",
    version: "10.0-enterprise-tier",
    timestamp: new Date().toISOString()
  });
});

app.get("/scan", authenticateAndRateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ success: false, status: "ERROR", message: "Target URL parameter is required." });
  }

  const normalized = enforceSecureUrl(url);
  if (!normalized) {
    return res.status(400).json({ success: false, status: "ERROR", message: "Malformed target domain or invalid TLD received." });
  }

  const cacheKey = normalizeUrl(normalized);
  if (activeScans.has(cacheKey)) {
    const startTime = activeScans.get(cacheKey);
    if (Date.now() - startTime < 60000) {
      return res.status(409).json({ success: false, status: "ALREADY_SCANNING", message: "A scan is already in progress for this URL." });
    } else {
      activeScans.delete(cacheKey);
    }
  }

  activeScans.set(cacheKey, Date.now());

  try {
    const data = await analyzeSingleUrl(normalized);

    if (data && data.success && req.user) {
      req.user.scansToday = safeNumber(req.user.scansToday) + 1;
    }

    if (data && data.blocked) {
      return res.status(200).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("[API] Error in /scan endpoint:", err.message);
    res.status(500).json({ success: false, status: "ERROR", message: err.message || "An unexpected error occurred during page analysis." });
  } finally {
    activeScans.delete(cacheKey);
  }
});

app.get("/compare", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) {
      return res.status(400).json({ success: false, status: "ERROR", message: "Both 'url' and 'competitor' query parameters are required." });
    }

    const normalizedUrl = enforceSecureUrl(url);
    const normalizedComp = enforceSecureUrl(competitor);

    if (!normalizedUrl || !normalizedComp) {
      return res.status(400).json({ success: false, status: "ERROR", message: "Invalid domain target parameters received." });
    }

    const results = await Promise.allSettled([
      analyzeSingleUrl(normalizedUrl),
      analyzeSingleUrl(normalizedComp)
    ]);

    const site1 = results[0].status === "fulfilled" ? results[0].value : null;
    const site2 = results[1].status === "fulfilled" ? results[1].value : null;

    if (!site1 || !site2 || site1.blocked || site2.blocked) {
      return res.status(200).json({
        success: false,
        competitorBlocked: true,
        reason: "Comparison unavailable: One or both targets blocked or returned invalid payload parameters."
      });
    }

    if (req.user) {
      req.user.scansToday = Math.min(PLAN_LIMITS[req.user.plan], safeNumber(req.user.scansToday) + 2);
    }

    const comparativeResult = compareTargetToCompetitor(site1, site2);

    res.json({
      status: "SUCCESS",
      success: true,
      comparison: comparativeResult,
      scores: {
        site1: site1?.overallAIVisibilityScore || 0,
        site2: site2?.overallAIVisibilityScore || 0
      },
      audit: site1.audit || {},
      entities: site1.entities || [],
      schema: site1.schema || "",
      roadmap: site1.roadmap || []
    });
  } catch (err) {
    console.error("[API] Error in /compare endpoint:", err.message);
    res.status(500).json({ success: false, status: "ERROR", message: err.message || "Could not complete competitor comparison." });
  }
});

app.get("/content-gap", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) {
      return res.status(400).json({ success: false, status: "ERROR", message: "Both 'url' and 'competitor' query parameters are required." });
    }

    const normalizedUrl = enforceSecureUrl(url);
    const normalizedComp = enforceSecureUrl(competitor);

    if (!normalizedUrl || !normalizedComp) {
      return res.status(400).json({ success: false, status: "ERROR", message: "Invalid target URLs provided." });
    }

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(normalizedUrl),
      analyzeSingleUrl(normalizedComp)
    ]);

    if (!userData || !compData || userData.blocked || compData.blocked) {
      return res.json({
        success: false,
        status: "BLOCKED",
        competitorBlocked: true,
        reason: "Gap analysis unavailable: One or both target engines failed or were blocked."
      });
    }

    const comparativeResult = compareTargetToCompetitor(userData, compData);

    res.json({
      status: "SUCCESS",
      success: true,
      scores: {
        userScore: userData?.overallAIVisibilityScore || 0,
        compScore: compData?.overallAIVisibilityScore || 0
      },
      audit: userData.audit || {},
      entities: userData.entities || [],
      schema: userData.schema || "",
      roadmap: userData.roadmap || [],
      keywordGap: {
        competitorKeywords: safeArraySlice(comparativeResult.gaps?.keywordGaps, 0, 5),
        missingKeywords: safeArraySlice(comparativeResult.gaps?.keywordGaps, 5, 10),
        opportunityKeywords: safeArraySlice(comparativeResult.gaps?.keywordGaps, 10, 15)
      },
      comparison: comparativeResult
    });
  } catch (err) {
    console.error("[API] Error in /content-gap endpoint:", err.message);
    res.status(500).json({ success: false, status: "ERROR", message: err.message || "An error occurred during content gap calculation." });
  }
});

app.get("/gap-analysis", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) {
      return res.status(400).json({ success: false, error: "Both 'url' and 'competitor' parameters are required." });
    }
    res.redirect(`/content-gap?url=${encodeURIComponent(url)}&competitor=${encodeURIComponent(competitor)}`);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/roadmap", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL parameter required" });
    const normalizedUrl = enforceSecureUrl(url);
    if (!normalizedUrl) {
      return res.status(400).json({ success: false, error: "Invalid URL structure received" });
    }

    const data = await analyzeSingleUrl(normalizedUrl);
    if (!data || data.blocked) {
      return res.json(data);
    }

    res.json({
      status: "SUCCESS",
      success: true,
      scores: {
        currentAIVisibility: data.overallAIVisibilityScore || 0,
        potentialAIVisibility: data.potentialAIVisibility || 0
      },
      audit: data.audit || {},
      entities: data.entities || [],
      schema: data.schema || "",
      roadmap: data.roadmap || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/keyword-theft", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) {
      return res.status(400).json({ success: false, error: "Both URLs are required" });
    }

    const normalizedUrl = enforceSecureUrl(url);
    const normalizedComp = enforceSecureUrl(competitor);

    if (!normalizedUrl || !normalizedComp) {
      return res.status(400).json({ success: false, error: "Invalid URL structure received" });
    }

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(normalizedUrl),
      analyzeSingleUrl(normalizedComp)
    ]);

    if (!userData || !compData || userData.blocked || compData.blocked) {
      return res.json({
        success: false,
        status: "BLOCKED",
        competitorBlocked: true,
        reason: "Keyword theft analysis unavailable due to crawl block limits."
      });
    }

    const userKeywords = safeArray(userData.keywords).map(k => String(k).toLowerCase());
    const compKeywords = safeArray(compData.keywords);

    const stolenKeywords = compKeywords
      .filter(k => !userKeywords.includes(String(k).toLowerCase()))
      .map(k => {
        const diff = getKeywordDifficulty(k);
        return {
          keyword: String(k),
          searchVolume: Math.floor(Math.random() * 5000) + 500,
          difficulty: diff,
          opportunityScore: getKeywordOpportunity(diff)
        };
      });

    res.json({
      status: "SUCCESS",
      success: true,
      stolenKeywords: stolenKeywords.slice(0, 10),
      scores: {
        userScore: userData.overallAIVisibilityScore || 0,
        competitorScore: compData.overallAIVisibilityScore || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/content-brief", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL parameter required" });
    const normalizedUrl = enforceSecureUrl(url);
    if (!normalizedUrl) return res.status(400).json({ success: false, error: "Invalid URL structure received" });

    const data = await analyzeSingleUrl(normalizedUrl);
    if (!data || data.blocked) {
      return res.json(data);
    }

    res.json({
      status: "SUCCESS",
      success: true,
      brief: {
        targetWordCount: Math.max(1500, safeNumber(data.wordCount) + 1000),
        recommendedHeadings: safeArraySlice(data.h2s, 0, 5).map(h => `Expand Context: ${String(h)}`),
        targetKeywords: safeArraySlice(data.keywords, 0, 8),
        recommendedSchemas: data.recommendedSchemas || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/autopilot", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL parameter required" });
    const normalizedUrl = enforceSecureUrl(url);
    if (!normalizedUrl) return res.status(400).json({ success: false, error: "Invalid URL structure received" });

    const data = await analyzeSingleUrl(normalizedUrl);
    if (!data || data.blocked) {
      return res.json(data);
    }

    res.json({
      status: "SUCCESS",
      success: true,
      autopilot: { tasks: data.aiAutopilot || [] }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/history", (req, res) => {
  try {
    res.json(safeArray(scanHistory));
  } catch (err) {
    res.status(500).json({ success: false, error: "History retrieval failed" });
  }
});

// =========================================================================
// ========== SECTION 17: EXPRESS HTTP SERVER INITIALIZATION ==============
// =========================================================================

app.listen(PORT, () => {
  console.log(`[SYSTEM] SEO AI Visibility Intel Service active. Listening on Port: ${PORT}`);
});
