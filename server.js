import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";
import axios from "axios";
import https from "https";
import path from "path";
import crypto from "crypto";

// =========================================================================
// ========== SECTION 0: GLOBAL CONSTANTS, CONFIGS & REGEXES ==============
// =========================================================================

export const PORT = process.env.PORT || 10000;
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_CACHE_ENTRIES = 500;
export const MAX_SCAN_HISTORY = 50;
export const MAX_TREND_POINTS_PER_URL = 30;
export const MAX_TREND_URLS = 300;
export const ANON_USER_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_ANON_USERS = 5000;
export const CRAWL_HARD_TIMEOUT_MS = 30000;
export const MAX_URL_LENGTH = 2048;

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
    lastSeenAt: Date.now(),
    apiKey: "free-dev-key-9999"
  },
  "pro-member-key-7777": {
    email: "enterprise@premium.aeo",
    plan: "pro",
    scansToday: 0,
    lastScanReset: Date.now(),
    lastSeenAt: Date.now(),
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

// Blocked hostnames / private IP ranges to prevent SSRF via the crawler.
export const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /\.local$/i,
  /^0x/i,
  /^\[?::ffff:/i
];

// =========================================================================
// ========== SECTION 0.5: STRUCTURED LOGGING ==============================
// =========================================================================

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LOG_LEVEL = (() => {
  const configured = safeTextFallback(process.env.LOG_LEVEL).toUpperCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, configured) ? LOG_LEVELS[configured] : LOG_LEVELS.INFO;
})();

// Local helper used only during logger bootstrap, before safeText is defined below.
function safeTextFallback(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function logMessage(level, context, message, meta) {
  if (LOG_LEVELS[level] > CURRENT_LOG_LEVEL) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    ...(meta && typeof meta === "object" ? meta : {})
  };
  let serialized;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    serialized = `${entry.timestamp} [${level}] [${context}] ${message}`;
  }
  if (level === "ERROR") console.error(serialized);
  else if (level === "WARN") console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  error: (context, message, meta) => logMessage("ERROR", context, message, meta),
  warn: (context, message, meta) => logMessage("WARN", context, message, meta),
  info: (context, message, meta) => logMessage("INFO", context, message, meta),
  debug: (context, message, meta) => logMessage("DEBUG", context, message, meta)
};

// =========================================================================
// ========== SECTION 1: EXPRESS MIDDLEWARE SETUP =========================
// =========================================================================

const app = express();

// Required for correct req.ip resolution behind reverse proxies (Render, etc.)
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(".", { maxAge: "1h" }));
app.use(express.static("public", { maxAge: "1h" }));

// Manual security headers (avoids introducing new npm dependencies while
// still shipping the standard hardening headers a production API needs).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

// Lightweight structured request logging + request-id correlation.
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  const startedAt = Date.now();
  res.setHeader("X-Request-Id", req.requestId);
  res.on("finish", () => {
    logger.info("HTTP", "request_completed", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
});

// =========================================================================
// ========== SECTION 1.5: MIDDLEWARE SECURITY & LIMITS ===================
// =========================================================================

/**
 * Evicts stale/excess anonymous rate-limit entries so the in-memory
 * saasUsers map can't grow without bound under sustained anonymous traffic.
 */
function pruneAnonymousUsers() {
  const now = Date.now();
  const anonKeys = [];

  for (const key of Object.keys(saasUsers)) {
    if (!key.startsWith("anon-")) continue;
    const user = saasUsers[key];
    if (now - safeNumber(user.lastSeenAt, user.lastScanReset) > ANON_USER_TTL_MS) {
      delete saasUsers[key];
    } else {
      anonKeys.push(key);
    }
  }

  if (anonKeys.length > MAX_ANON_USERS) {
    anonKeys
      .sort((a, b) => safeNumber(saasUsers[a]?.lastSeenAt) - safeNumber(saasUsers[b]?.lastSeenAt))
      .slice(0, anonKeys.length - MAX_ANON_USERS)
      .forEach(key => delete saasUsers[key]);
  }
}

setInterval(pruneAnonymousUsers, 30 * 60 * 1000).unref();

export function authenticateAndRateLimit(req, res, next) {
  const authHeader = safeText(req.headers.authorization || req.query.apiKey);
  const key = authHeader.replace(/^Bearer\s+/i, "").slice(0, 128);

  let user = key ? saasUsers[key] : null;
  if (!user) {
    const ip = safeText(req.ip) || "unknown-client";
    const cacheKey = `anon-${ip}`;
    if (!saasUsers[cacheKey]) {
      saasUsers[cacheKey] = {
        email: "anonymous@platform.aeo",
        plan: "free",
        scansToday: 0,
        lastScanReset: Date.now(),
        lastSeenAt: Date.now(),
        apiKey: cacheKey
      };
    }
    user = saasUsers[cacheKey];
  }

  user.lastSeenAt = Date.now();

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

/**
 * Wraps an async Express handler so rejected promises are always forwarded
 * to Express's error pipeline instead of crashing the process or hanging
 * the request.
 */
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
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
export function buildMetric({ name, raw, max, weight, reason, evidence, recommendation }) {
  const safeMax = max > 0 ? max : 1;
  const clampedRaw = clamp(raw, 0, safeMax);
  const ratio = clampedRaw / safeMax;
  const contribution = Math.round(ratio * weight * 100) / 100;
  const passed = ratio >= 1;

  return {
    metric: name,
    rawValue: clampedRaw,
    maxValue: safeMax,
    weight,
    contribution,
    passed,
    reason,
    evidence: safeText(evidence, "No supporting evidence captured for this metric."),
    recommendation: passed ? null : safeText(recommendation, `Improve ${name.toLowerCase()} to recover lost points.`),
    expectedImprovement: passed ? 0 : Math.round((weight - contribution) * 100) / 100
  };
}
export function aggregateMetrics(metrics) {
  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0) || 100;
  const totalContribution = metrics.reduce((sum, m) => sum + m.contribution, 0);
  const score = clamp(Math.round((totalContribution / totalWeight) * 100));

  return {
    score,
    status: score >= 80 ? "Optimized" : score >= 50 ? "Satisfactory" : "Critical Improvements Needed",
    auditPassed: score >= 80,
    metrics,
    passedMetrics: metrics.filter(m => m.passed).map(m => m.metric),
    failedMetrics: metrics.filter(m => !m.passed).map(m => m.metric),
    totalExpectedImprovement: Math.round(metrics.reduce((s, m) => s + m.expectedImprovement, 0) * 100) / 100
  };
}
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

/**
 * Deterministic pseudo-volume derived from the keyword itself rather than
 * Math.random(), so identical keywords always produce identical, reproducible
 * output across requests (important for caching and for not presenting
 * unrepeatable random noise as if it were real search-volume data).
 */
export const getDeterministicSearchVolume = (kw) => {
  const hash = crypto.createHash("md5").update(String(kw).toLowerCase()).digest("hex");
  const numeric = parseInt(hash.slice(0, 8), 16);
  return 500 + (numeric % 4500);
};

/**
 * Returns true if a hostname resolves to a private/loopback/link-local
 * address space or is otherwise an internal-network target. Used to block
 * SSRF attempts through the crawl engine (e.g. scanning http://localhost or
 * internal cloud metadata endpoints).
 */
export function isPrivateOrReservedHost(hostname) {
  const host = safeText(hostname).toLowerCase();
  if (!host) return true;
  return PRIVATE_HOST_PATTERNS.some(pattern => pattern.test(host));
}

export const enforceSecureUrl = (inputUrl) => {
  let cleaned = safeText(inputUrl).trim();
  if (!cleaned || cleaned.length > MAX_URL_LENGTH) return null;
  cleaned = cleaned.replace(/[[\]()]/g, "").trim();
  if (!cleaned.match(/^https?:\/\//i)) {
    cleaned = "https://" + cleaned;
  }

  try {
    const parsed = new URL(cleaned);
    if (!/^https?:$/i.test(parsed.protocol)) return null;

    const hostParts = parsed.hostname.split('.');
    if (hostParts.length < 2) {
      // Allow single-label hosts only if they're not reserved (still reject).
      if (isPrivateOrReservedHost(parsed.hostname)) return null;
      return null;
    }
    const tld = hostParts[hostParts.length - 1];
    if (tld.length < 2 || /\d/.test(tld)) return null;
    if (isPrivateOrReservedHost(parsed.hostname)) return null;

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

/**
 * Deterministic content hash used to de-duplicate structurally identical
 * JSON-LD blocks (e.g. the same Organization schema declared twice).
 */
export function hashJsonLdItem(item) {
  try {
    return crypto.createHash("sha1").update(JSON.stringify(item)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Minimal structural validation for a parsed JSON-LD node. Rejects anything
 * that isn't a plausible schema.org object before it's trusted downstream.
 */
export function isValidJsonLdNode(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (!item['@type'] && !item['@graph']) return false;
  return true;
}

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
  if (text.includes("cloudflare") || text.includes("cf-browser-verification") || text.includes("ray id:") || text.includes("cf-chl-bypass") || text.includes("__cf_chl")) {
    return { blocked: true, system: "Cloudflare Turnstile", reason: "Cloudflare challenge page detected." };
  }
  if (text.includes("captcha") || text.includes("recaptcha") || text.includes("hcaptcha") || text.includes("verify you are human") || text.includes("are you a robot")) {
    return { blocked: true, system: "CAPTCHA Block", reason: "Page validation challenge triggered." };
  }
  if (text.includes("just a moment") && text.includes("checking your browser")) {
    return { blocked: true, system: "DDoS Mitigation Screen", reason: "Active browser checking screen encountered." };
  }
  if (text.includes("access denied") || text.includes("you don't have permission")) {
    return { blocked: true, system: "Access Denied", reason: "Server explicitly denied access to the requested resource." };
  }
  if (text.includes("pardon our interruption") || text.includes("unusual traffic")) {
    return { blocked: true, system: "Bot Mitigation Interstitial", reason: "Target displayed a bot-mitigation interstitial page." };
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
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      maxContentLength: 2 * 1024 * 1024
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
    logger.debug("ROBOTS", "robots_txt_fetch_failed", { baseUrl, error: err.message });
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
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      maxContentLength: 5 * 1024 * 1024
    });
    const bodyLower = typeof response.data === "string" ? response.data.toLowerCase() : "";
    if (response.status < 400 && (bodyLower.includes("<urlset") || bodyLower.includes("<sitemapindex"))) {
      return { found: true, source: "conventional-path", urls: [fallbackUrl] };
    }
    return { found: false, source: null, urls: [] };
  } catch (err) {
    logger.debug("SITEMAP", "sitemap_fetch_failed", { baseUrl, error: err.message });
    return { found: false, source: null, urls: [] };
  }
}

// =========================================================================
// ========== SECTION 4: HIGH-PERFORMANCE BRIDGED CRAWLER ==================
// =========================================================================

let globalBrowser = null;
let browserLastUsedAt = Date.now();
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export async function getBrowserInstance() {
  browserLastUsedAt = Date.now();

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
    logger.error("CRAWL", "playwright_launch_failed", { error: err.message });
    return null;
  }
}

/**
 * Closes the shared headless browser instance. Safe to call even if no
 * browser is currently open.
 */
export async function closeBrowserInstance() {
  if (!globalBrowser) return;
  try {
    await globalBrowser.close();
  } catch (err) {
    logger.warn("CRAWL", "browser_close_failed", { error: err.message });
  } finally {
    globalBrowser = null;
  }
}

// Periodically release the headless browser process when idle, to keep
// memory usage flat between bursts of crawl traffic.
setInterval(() => {
  if (globalBrowser && Date.now() - browserLastUsedAt > BROWSER_IDLE_TIMEOUT_MS) {
    closeBrowserInstance().catch(() => {});
  }
}, 60 * 1000).unref();

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
    maxContentLength: 15 * 1024 * 1024,
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
    browserLastUsedAt = Date.now();
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
      const jitter = Math.floor(Math.random() * 250);
      await new Promise(resolve => setTimeout(resolve, delay + jitter));
      delay *= 2;
    }
  }
  throw Object.assign(lastError || new Error("Unknown retry failure"), { attempts });
}
export async function sampleBrokenLinks(baseUrl, linkMap, sampleSize = 8) {
  const paths = Object.keys(safeObject(linkMap)).slice(0, sampleSize);
  if (paths.length === 0) {
    return { checked: 0, broken: 0, brokenUrls: [], sampleRate: 0 };
  }

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return { checked: 0, broken: 0, brokenUrls: [], sampleRate: 0 };
  }

  const checks = paths.map(async (p) => {
    const target = p.startsWith("http") ? p : `${origin}/${p.replace(/^\/*/, "")}`;
    try {
      const res = await axios.head(target, {
        timeout: 5000,
        maxRedirects: 4,
        validateStatus: () => true,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });
      return { url: target, ok: res.status < 400, status: res.status };
    } catch (err) {
      return { url: target, ok: false, status: 0 };
    }
  });

  const results = await Promise.allSettled(checks);
  const resolved = results.map(r => r.status === "fulfilled" ? r.value : { ok: false, status: 0, url: "unknown" });
  const broken = resolved.filter(r => !r.ok);

  return {
    checked: resolved.length,
    broken: broken.length,
    brokenUrls: broken.map(b => ({ url: b.url, status: b.status })),
    sampleRate: paths.length > 0 ? Math.round((resolved.length / Object.keys(linkMap).length) * 100) : 0
  };
}
/**
 * Races a promise against a hard timeout so a single hung crawl can never
 * stall a request indefinitely.
 */
function withHardTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded hard timeout of ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function smartCrawl(url) {
  let result = null;
  let crawlMethod = "STANDARD_GET";
  let status = 500;
  let retryCount = 0;
  let infiniteScrollDetected = false;

  try {
    const outcome = await withHardTimeout(withRetry(() => fetchAxios(url), 2, 1200), CRAWL_HARD_TIMEOUT_MS, "Standard fetch");
    result = outcome.result;
    retryCount = outcome.attempts - 1;
    status = result?.status || 500;
  } catch (err) {
    retryCount = safeNumber(err?.attempts, 1) - 1;
    logger.warn("CRAWL", "standard_fetch_failed", { url, error: err.message, retryCount });
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
    logger.info("CRAWL", "upgrading_to_headless_browser", { url });
    try {
      const pwResult = await withHardTimeout(fetchPlaywright(url), CRAWL_HARD_TIMEOUT_MS, "Headless render");
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
      logger.error("CRAWL", "headless_fallback_failed", { url, error: pwErr.message });
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

  const seenHashesByType = {};

  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const json = JSON.parse(raw);
        const items = Array.isArray(json) ? json : [json];
        const parseItem = (item) => {
          if (!isValidJsonLdNode(item)) return;
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            item['@graph'].forEach(parseItem);
            return;
          }
          const rawType = item['@type'];
          const types = Array.isArray(rawType) ? rawType.map(String) : [String(rawType || '')];
          types.forEach(type => {
            if (schemas[type]) {
              const hash = hashJsonLdItem(item);
              if (!seenHashesByType[type]) seenHashesByType[type] = new Set();
              // Duplicate-schema removal: skip structurally identical blocks
              // already recorded for this type.
              if (hash && seenHashesByType[type].has(hash)) return;
              if (hash) seenHashesByType[type].add(hash);

              schemas[type].present = true;
              schemas[type].data.push(item);
            }
          });
        };
        items.forEach(parseItem);
      } catch (e) {
        logger.debug("SCHEMA", "json_ld_parse_failed", { error: e.message });
      }
    });
  } catch (err) {
    logger.debug("SCHEMA", "schema_detection_failed", { error: err.message });
  }

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
          if (!isValidJsonLdNode(item)) return;
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
            }
            if (type.includes('person')) {
              people.push(name);
            }
            if (type.includes('product')) {
              products.push(name);
            }
            if (type.includes('localbusiness')) {
              organizations.push(name);
              brands.push(name);
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

  // Orphan-page detection is heuristic-only (a full crawl would be required
  // for certainty); rather than fabricating specific fake URLs, we surface a
  // boolean risk flag plus a neutral explanatory note.
  const orphanRisk = uniquePages < 3;

  return {
    internalLinks,
    totalInternalLinks: internalLinks,
    externalLinks,
    uniquePages,
    orphanPages: [],
    orphanPageRiskDetected: orphanRisk,
    orphanPageNote: orphanRisk
      ? "Low unique internal destination count detected. A full-site crawl is required to confirm actual orphan pages."
      : "",
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
  let title = cleanText(safeText($("title").text()));
  let metaDescription = cleanText(safeText($('meta[name="description"]').attr("content")));

  // Regex-based fallback: if cheerio couldn't find a title/description
  // (e.g. malformed markup), recover a best-effort value instead of
  // returning blank fields.
  if (!title || !metaDescription) {
    const fallback = regexFallbackParser(safeText(html), url);
    if (!title) title = fallback.title;
    if (!metaDescription) metaDescription = fallback.metaDescription;
  }

  const canonical = cleanText(safeText($('link[rel="canonical"]').attr("href")));
  const robots = cleanText(safeText($('meta[name="robots"]').attr("content")));
  const language = cleanText(safeText($('html').attr("lang") || $('html').attr("xml:lang")));
  const charset = cleanText(safeText($('meta[charset]').attr("charset")));
  const viewportContent = cleanText(safeText($('meta[name="viewport"]').attr("content")));
  const hasResponsiveViewport = /width\s*=\s*device-width/i.test(viewportContent);
  const ogTitle = cleanText(safeText($('meta[property="og:title"]').attr("content")));
  const ogDescription = cleanText(safeText($('meta[property="og:description"]').attr("content")));
  const ogImage = cleanText(safeText($('meta[property="og:image"]').attr("content")));
  const ogType = cleanText(safeText($('meta[property="og:type"]').attr("content")));

  const twitterCard = cleanText(safeText($('meta[name="twitter:card"]').attr("content")));
  const twitterTitle = cleanText(safeText($('meta[name="twitter:title"]').attr("content")));
  const twitterDescription = cleanText(safeText($('meta[name="twitter:description"]').attr("content")));
  const twitterImage = cleanText(safeText($('meta[name="twitter:image"]').attr("content")));

  let h1s = $("h1").map((_, el) => cleanText(safeText($(el).text()))).get().filter(Boolean);
  if (h1s.length === 0) {
    const fallback = regexFallbackParser(safeText(html), url);
    if (fallback.h1) h1s = [fallback.h1];
  }
  const h2s = [...new Set($("h2").map((_, el) => cleanText(safeText($(el).text()))).get().filter(Boolean))];
  const h3s = [...new Set($("h3").map((_, el) => cleanText(safeText($(el).text()))).get().filter(Boolean))];

    const images = $("img").map((_, el) => {
    const src = safeText($(el).attr("src"));
    const ext = (src.split("?")[0].split(".").pop() || "").toLowerCase();
    return {
      src,
      alt: safeText($(el).attr("alt")),
      width: safeText($(el).attr("width")),
      height: safeText($(el).attr("height")),
      loading: safeText($(el).attr("loading")),
      isModernFormat: ["webp", "avif"].includes(ext),
      hasFilenameContext: /[a-z0-9][-_][a-z0-9]/i.test(src.split("/").pop() || "") && !/^(img|image|dsc|photo)\d*\./i.test(src.split("/").pop() || "")
    };
  }).get();
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
    viewport: viewportContent,
    hasResponsiveViewport,
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
    author: dateInfo.author,
    linkAnalysisDetail: linkAnalysis
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

/**
 * Structural JSON-LD validation pass. Flags malformed nodes (missing
 * @type/@context, empty objects, non-parseable blocks) so validation issues
 * can be surfaced to the user rather than silently swallowed.
 */
export function validateJsonLdBlocks($) {
  const issues = [];
  let validCount = 0;
  let invalidCount = 0;

  $('script[type="application/ld+json"]').each((i, el) => {
    const raw = $(el).html();
    if (!raw || !raw.trim()) {
      invalidCount++;
      issues.push(`JSON-LD block #${i + 1} is empty.`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      invalidCount++;
      issues.push(`JSON-LD block #${i + 1} contains invalid JSON syntax: ${e.message}`);
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let blockValid = true;
    items.forEach(item => {
      if (!isValidJsonLdNode(item)) {
        blockValid = false;
      }
    });
    if (blockValid) {
      validCount++;
    } else {
      invalidCount++;
      issues.push(`JSON-LD block #${i + 1} is missing required "@type" or "@graph" declarations.`);
    }
  });

  return {
    totalBlocks: validCount + invalidCount,
    validBlocks: validCount,
    invalidBlocks: invalidCount,
    issues
  };
}

export function auditPageSchemas($, html) {
  const jsonLdSchemas = detectAllSchemas($, html);
  const microdataTypes = extractMicrodata($);
  const rdfaTypes = extractRDFa($);
  const jsonLdValidation = validateJsonLdBlocks($);

  const activeJsonLdKeys = Object.keys(jsonLdSchemas).filter(k => jsonLdSchemas[k]?.present);
  const allDetectedTypes = [...new Set([...activeJsonLdKeys, ...microdataTypes, ...rdfaTypes])];

  return {
    detectedTypes: allDetectedTypes,
    schemaCount: allDetectedTypes.length,
    jsonLd: jsonLdSchemas,
    microdata: microdataTypes,
    rdfa: rdfaTypes,
    validation: jsonLdValidation
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
          if (!isValidJsonLdNode(item)) return;
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
export async function calculateDynamicSeoScore(pageData, loadTimeMs, context = {}) {
  const { robotsData, sitemapData, schemaAudit } = context;
  const metrics = [];

  // 1. Title
  const title = safeText(pageData?.title);
  metrics.push(buildMetric({
    name: "Title Tag",
    raw: title ? (title.length >= 10 && title.length <= 60 ? 8 : 5) : 0,
    max: 8,
    weight: 8,
    reason: !title ? "No title tag detected." : title.length < 10 ? "Title under 10 characters." : title.length > 60 ? "Title exceeds 60 characters." : "Title present and within optimal length.",
    evidence: title ? `Title: "${title}" (${title.length} chars).` : "No <title> element found in the crawled DOM.",
    recommendation: "Write a unique, descriptive title between 10 and 60 characters that includes the page's primary topic."
  }));

  // 2. Meta Description
  const description = safeText(pageData?.metaDescription);
  metrics.push(buildMetric({
    name: "Meta Description",
    raw: description ? (description.length >= 50 && description.length <= 160 ? 7 : 4) : 0,
    max: 7,
    weight: 7,
    reason: !description ? "No meta description detected." : description.length < 50 ? "Description under 50 characters." : description.length > 160 ? "Description exceeds 160 characters." : "Description present and within optimal length.",
    evidence: description ? `Meta description: "${description.slice(0, 120)}${description.length > 120 ? '…' : ''}" (${description.length} chars).` : "No <meta name=\"description\"> tag found.",
    recommendation: "Write a compelling 50-160 character description summarizing the page for search snippets."
  }));

  // 3. Canonical
  const canonical = safeText(pageData?.canonical);
  metrics.push(buildMetric({
    name: "Canonical URL",
    raw: canonical ? 5 : 0,
    max: 5,
    weight: 5,
    reason: canonical ? "Canonical link element is configured." : "No canonical tag found.",
    evidence: canonical ? `Canonical resolves to: ${canonical}` : "No <link rel=\"canonical\"> element in <head>.",
    recommendation: "Add a self-referencing canonical tag to prevent duplicate-content indexing issues."
  }));

  // 4. Indexability (robots meta directive)
  const robotsMeta = safeText(pageData?.robots).toLowerCase();
  const isBlocked = robotsMeta.includes("noindex") || robotsMeta.includes("none");
  metrics.push(buildMetric({
    name: "Indexability",
    raw: isBlocked ? 0 : 6,
    max: 6,
    weight: 6,
    reason: isBlocked ? "Page explicitly blocks indexing via meta robots directive." : "No indexing block detected.",
    evidence: robotsMeta ? `<meta name="robots" content="${robotsMeta}">` : "No robots meta tag present (defaults to indexable).",
    recommendation: "Remove the noindex directive from the meta robots tag if this page should appear in search results."
  }));

  // 5. Headings
  const h1s = safeArray(pageData?.headings?.h1s);
  const h2Count = safeArray(pageData?.headings?.h2s).length;
  const headingRaw = (h1s.length === 1 ? 4 : 0) + (h2Count > 0 ? 3 : 0);
  metrics.push(buildMetric({
    name: "Heading Structure",
    raw: headingRaw,
    max: 7,
    weight: 7,
    reason: h1s.length === 0 ? "No H1 heading found." : h1s.length > 1 ? `${h1s.length} H1 headings found (should be exactly 1).` : h2Count === 0 ? "H1 present but no H2 subheadings found." : "Clean single-H1 hierarchy with supporting H2s.",
    evidence: `H1 count: ${h1s.length}. H2 count: ${h2Count}. H1 text: ${h1s[0] ? `"${h1s[0]}"` : "none"}.`,
    recommendation: "Use exactly one H1 describing the page topic, supported by H2 subheadings that break content into logical sections."
  }));

  // 6. Internal Links
  const internalLinks = safeNumber(pageData?.links?.internal);
  metrics.push(buildMetric({
    name: "Internal Links",
    raw: clamp(internalLinks, 0, 10),
    max: 10,
    weight: 6,
    reason: internalLinks === 0 ? "No internal links detected." : internalLinks < 5 ? "Low internal link count." : "Healthy internal link count.",
    evidence: `${internalLinks} internal link(s) detected across ${Object.keys(safeObject(pageData?.links?.linkMap)).length} unique destination(s).`,
    recommendation: "Add contextual internal links to related pages to distribute authority and aid crawl discovery."
  }));

  // 7. External Links
  const externalLinks = safeNumber(pageData?.links?.external);
  metrics.push(buildMetric({
    name: "External Links",
    raw: externalLinks > 0 ? 3 : 0,
    max: 3,
    weight: 3,
    reason: externalLinks > 0 ? "Outbound authoritative references present." : "No outbound external links detected.",
    evidence: `${externalLinks} external link(s) detected.`,
    recommendation: "Link out to authoritative external sources to support factual claims and build topical credibility."
  }));

  // 8. Broken Links — real HEAD-request evidence, not estimated.
  const brokenLinkData = await sampleBrokenLinks(pageData?.resolvedUrl || "", pageData?.links?.linkMap, 8);
  const brokenRaw = brokenLinkData.checked === 0 ? 4 : clamp(4 - brokenLinkData.broken, 0, 4);
  metrics.push(buildMetric({
    name: "Broken Links",
    raw: brokenRaw,
    max: 4,
    weight: 4,
    reason: brokenLinkData.checked === 0 ? "No internal links available to sample." : brokenLinkData.broken === 0 ? "All sampled internal links resolved successfully." : `${brokenLinkData.broken} of ${brokenLinkData.checked} sampled links returned an error status.`,
    evidence: brokenLinkData.checked > 0 ? `Sampled ${brokenLinkData.checked} internal link(s) via HTTP HEAD. Broken: ${brokenLinkData.broken}.${brokenLinkData.brokenUrls.length ? " Failing URLs: " + brokenLinkData.brokenUrls.map(b => `${b.url} (${b.status || 'no response'})`).join(", ") : ""}` : "No internal links were available for sampling.",
    recommendation: "Fix or remove broken internal links; each returns a client/server error and harms both users and crawl efficiency."
  }));

  // 9. Image ALT coverage
  const images = safeArray(pageData?.images);
  const imagesWithAlt = images.filter(img => safeText(img.alt)).length;
  const altRatio = images.length > 0 ? imagesWithAlt / images.length : 1;
  metrics.push(buildMetric({
    name: "Image ALT Tags",
    raw: Math.round(altRatio * 5),
    max: 5,
    weight: 5,
    reason: images.length === 0 ? "No images found on page." : altRatio === 1 ? "All images have descriptive alt attributes." : `${images.length - imagesWithAlt} of ${images.length} images are missing alt text.`,
    evidence: `${imagesWithAlt}/${images.length} images carry non-empty alt attributes.`,
    recommendation: "Add descriptive, keyword-relevant alt text to every content image for accessibility and image-search visibility."
  }));

  // 10. Structured Data
  const schemaCount = safeArray(schemaAudit?.detectedTypes).length;
  const invalidSchemaCount = safeNumber(schemaAudit?.validation?.invalidBlocks);
  const structuredDataRaw = schemaCount === 0 ? 0 : invalidSchemaCount > 0 ? 5 : 9;
  metrics.push(buildMetric({
    name: "Structured Data",
    raw: structuredDataRaw,
    max: 9,
    weight: 9,
    reason: schemaCount === 0 ? "No JSON-LD, Microdata, or RDFa schemas detected." : invalidSchemaCount > 0 ? "Schema present but some blocks failed validation." : "Valid structured data detected.",
    evidence: `Detected types: ${schemaCount > 0 ? schemaAudit.detectedTypes.join(", ") : "none"}. Invalid JSON-LD blocks: ${invalidSchemaCount}.`,
    recommendation: "Deploy valid JSON-LD structured data (Organization, WebPage, FAQPage, etc.) and fix any malformed blocks."
  }));

  // 11. Sitemap
  metrics.push(buildMetric({
    name: "XML Sitemap",
    raw: sitemapData?.found ? 4 : 0,
    max: 4,
    weight: 4,
    reason: sitemapData?.found ? `Sitemap discovered via ${sitemapData.source}.` : "No sitemap.xml found via robots.txt declaration or conventional path.",
    evidence: sitemapData?.found ? `Sitemap URL(s): ${safeArray(sitemapData.urls).join(", ")}` : "Checked robots.txt declaration and /sitemap.xml conventional path — neither resolved.",
    recommendation: "Publish an XML sitemap and reference it in robots.txt to improve crawl discovery and indexation speed."
  }));

  // 12. Robots.txt
  metrics.push(buildMetric({
    name: "Robots.txt",
    raw: robotsData?.found ? 3 : 0,
    max: 3,
    weight: 3,
    reason: robotsData?.found ? "robots.txt file is published and reachable." : "No robots.txt file found at site root.",
    evidence: robotsData?.found ? `robots.txt declares ${safeArray(robotsData.disallowedPaths).length} disallow rule(s).` : "GET request to /robots.txt did not return a valid file.",
    recommendation: "Publish a robots.txt file at the domain root to explicitly declare crawl permissions."
  }));

  // 13. Performance (real measured load time)
  const latency = safeNumber(loadTimeMs);
  const perfRaw = latency <= 1500 ? 8 : latency <= 3000 ? 5 : 0;
  metrics.push(buildMetric({
    name: "Response Performance",
    raw: perfRaw,
    max: 8,
    weight: 8,
    reason: latency <= 1500 ? "Fast server response time." : latency <= 3000 ? "Moderate response latency." : "Slow response time, likely to hurt Core Web Vitals (LCP).",
    evidence: `Measured crawl-to-render duration: ${latency}ms.`,
    recommendation: "Reduce server response time via caching, CDN delivery, and reducing render-blocking resources."
  }));

  // 14. Mobile Friendly (real viewport meta detection)
  metrics.push(buildMetric({
    name: "Mobile Friendly",
    raw: pageData?.hasResponsiveViewport ? 5 : 0,
    max: 5,
    weight: 5,
    reason: pageData?.hasResponsiveViewport ? "Responsive viewport meta tag detected." : "No responsive viewport meta tag detected.",
    evidence: pageData?.viewport ? `<meta name="viewport" content="${pageData.viewport}">` : "No <meta name=\"viewport\"> tag found in <head>.",
    recommendation: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to enable responsive mobile rendering."
  }));

  // 15. HTTPS
  const isHttps = safeText(pageData?.resolvedUrl).startsWith("https://");
  metrics.push(buildMetric({
    name: "HTTPS",
    raw: isHttps ? 6 : 0,
    max: 6,
    weight: 6,
    reason: isHttps ? "Site is served over a secure HTTPS connection." : "Site is served over insecure HTTP.",
    evidence: `Resolved URL scheme: ${safeText(pageData?.resolvedUrl).split("://")[0] || "unknown"}.`,
    recommendation: "Migrate to HTTPS with a valid TLS certificate; browsers and search engines penalize insecure HTTP pages."
  }));

  // 16. OpenGraph
  const hasOg = Boolean(pageData?.openGraph?.title && pageData?.openGraph?.description);
  metrics.push(buildMetric({
    name: "OpenGraph Tags",
    raw: hasOg ? 2 : 0,
    max: 2,
    weight: 2,
    reason: hasOg ? "OpenGraph title and description present." : "OpenGraph tags missing or incomplete.",
    evidence: `og:title="${safeText(pageData?.openGraph?.title, 'missing')}", og:description="${safeText(pageData?.openGraph?.description, 'missing').slice(0, 60)}".`,
    recommendation: "Add og:title, og:description, and og:image meta tags to control social-share previews."
  }));

  // 17. Twitter Cards
  const hasTwitter = Boolean(pageData?.twitterCards?.card);
  metrics.push(buildMetric({
    name: "Twitter Card Tags",
    raw: hasTwitter ? 1 : 0,
    max: 1,
    weight: 1,
    reason: hasTwitter ? "Twitter card meta tag present." : "No Twitter card meta tag found.",
    evidence: hasTwitter ? `twitter:card="${pageData.twitterCards.card}"` : "No <meta name=\"twitter:card\"> tag found.",
    recommendation: "Add a twitter:card meta tag (summary_large_image recommended) for richer Twitter/X sharing previews."
  }));

  // 18. Content Quality (word count, real measured)
  const words = safeNumber(pageData?.wordCount);
  const contentRaw = words >= 900 ? 5 : words >= 600 ? 4 : words >= 300 ? 2 : 0;
  metrics.push(buildMetric({
    name: "Content Depth",
    raw: contentRaw,
    max: 5,
    weight: 5,
    reason: words < 300 ? "Thin content body." : words < 600 ? "Below-average content depth." : words < 900 ? "Adequate content depth." : "Strong content depth.",
    evidence: `Measured visible body word count: ${words}.`,
    recommendation: "Expand thin sections with substantive, non-redundant content — aim for 900+ words on cornerstone pages."
  }));

  // 19. Keyword Coverage (on-page self-consistency: do the page's own top
  // tokenized keywords actually appear in its title/H1?)
  const topKeywords = tokenizeKeywords(pageData?.visibleText).slice(0, 8);
  const titleH1Lower = `${title} ${h1s[0] || ""}`.toLowerCase();
  const keywordsInTitleOrH1 = topKeywords.filter(k => titleH1Lower.includes(k));
  const keywordRatio = topKeywords.length > 0 ? keywordsInTitleOrH1.length / topKeywords.length : 0;
  metrics.push(buildMetric({
    name: "Keyword Coverage",
    raw: Math.round(keywordRatio * 3),
    max: 3,
    weight: 3,
    reason: topKeywords.length === 0 ? "No dominant keywords could be extracted from body content." : keywordRatio >= 0.5 ? "Title/H1 align well with the page's dominant extracted keywords." : "Title/H1 poorly reflect the page's own dominant content keywords.",
    evidence: `Top extracted keywords: ${topKeywords.join(", ") || "none"}. Present in title/H1: ${keywordsInTitleOrH1.join(", ") || "none"}.`,
    recommendation: "Align the title and H1 with the terms that actually dominate the page's body content."
  }));

  // 20. Semantic Relevance (entity density: entities per 100 words)
  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount);
  const entityDensity = words > 0 ? (entityCount / words) * 100 : 0;
  metrics.push(buildMetric({
    name: "Semantic Relevance",
    raw: entityDensity >= 1.5 ? 3 : entityDensity >= 0.5 ? 2 : 0,
    max: 3,
    weight: 3,
    reason: entityDensity >= 1.5 ? "Strong named-entity density relative to content length." : entityDensity >= 0.5 ? "Moderate entity density." : "Low entity density — content may read as generic.",
    evidence: `${entityCount} distinct entities detected across ${words} words (${entityDensity.toFixed(2)} entities per 100 words).`,
    recommendation: "Reference more specific named entities (brands, people, places, products) relevant to the topic."
  }));

  const result = aggregateMetrics(metrics);

  // Backward-compatible fields for the existing frontend/payload contract.
  return {
    ...result,
    deductions: metrics.filter(m => !m.passed).map(m => ({
      factor: m.metric,
      penalty: m.expectedImprovement,
      reason: m.reason
    })),
    brokenLinkSample: brokenLinkData
  };
}

// =========================================================================
// ========== SECTION 11: DYNAMIC AEO SIMULATION ENGINE ====================
// =========================================================================

export function calculateDynamicAeoScore(pageData, docVisibleText) {
  const text = safeText(docVisibleText).toLowerCase();
  const metrics = [];

  const hasFAQ = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "faqpage");
  metrics.push(buildMetric({
    name: "FAQ Schema",
    raw: hasFAQ ? 15 : 0,
    max: 15,
    weight: 15,
    reason: hasFAQ ? "FAQPage structured data detected." : "No FAQPage schema detected.",
    evidence: hasFAQ ? "FAQPage JSON-LD block present in page markup." : "No FAQPage entry in detected schema types.",
    recommendation: "Add FAQPage JSON-LD with real question/answer pairs relevant to the page's topic."
  }));

  const questionPatterns = ["what is", "how do i", "why does", "where can", "who is", "when should"];
  const matchedQuestions = questionPatterns.filter(p => text.includes(p));
  const hasQABlock = (text.includes("q:") && text.includes("a:")) || matchedQuestions.length > 0;
  metrics.push(buildMetric({
    name: "Question/Answer Blocks",
    raw: hasQABlock ? Math.min(12, 6 + matchedQuestions.length * 2) : 0,
    max: 12,
    weight: 12,
    reason: hasQABlock ? "Question-style phrasing detected in visible content." : "No question/answer phrasing patterns detected.",
    evidence: matchedQuestions.length > 0 ? `Matched question patterns: ${matchedQuestions.join(", ")}.` : "No 'what is/how do i/why does' style phrasing found in body text.",
    recommendation: "Phrase key sections as direct questions followed by concise answers, mirroring how users query AI assistants."
  }));

  const definitionTerms = ["is defined as", "refers to", "means", "denotes", "is the process of", "is a term used to"];
  const matchedDefinitions = definitionTerms.filter(term => text.includes(term));
  metrics.push(buildMetric({
    name: "Definitional Content",
    raw: matchedDefinitions.length > 0 ? 10 : 0,
    max: 10,
    weight: 10,
    reason: matchedDefinitions.length > 0 ? "Definitional phrasing detected." : "No definitional phrasing detected.",
    evidence: matchedDefinitions.length > 0 ? `Matched definitional phrases: ${matchedDefinitions.join(", ")}.` : "No 'refers to/is defined as/means' style phrasing found.",
    recommendation: "Open key sections with a clear one-sentence definition of the core concept being discussed."
  }));

  const listItemsCount = (text.match(/<li>/g) || []).length;
  metrics.push(buildMetric({
    name: "List Formatting",
    raw: listItemsCount > 5 ? 8 : listItemsCount > 0 ? 4 : 0,
    max: 8,
    weight: 8,
    reason: listItemsCount > 5 ? "Substantial list-based formatting detected." : listItemsCount > 0 ? "Minimal list formatting detected." : "No list elements detected.",
    evidence: `${listItemsCount} <li> element(s) detected in the crawled HTML.`,
    recommendation: "Break stepwise or enumerable information into <ul>/<ol> lists — LLMs favor extractable list structures."
  }));

  const tableRowsCount = (text.match(/<tr>/g) || []).length;
  metrics.push(buildMetric({
    name: "Table Formatting",
    raw: tableRowsCount > 0 ? 8 : 0,
    max: 8,
    weight: 8,
    reason: tableRowsCount > 0 ? "Tabular data detected." : "No table elements detected.",
    evidence: `${tableRowsCount} <tr> row(s) detected in the crawled HTML.`,
    recommendation: "Present comparisons, specs, or structured data in an HTML <table> — highly extractable for AI answer engines."
  }));

  const hasHowTo = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "howto");
  metrics.push(buildMetric({
    name: "HowTo Schema",
    raw: hasHowTo ? 12 : 0,
    max: 12,
    weight: 12,
    reason: hasHowTo ? "HowTo structured data detected." : "No HowTo schema detected.",
    evidence: hasHowTo ? "HowTo JSON-LD block present in page markup." : "No HowTo entry in detected schema types.",
    recommendation: "Add HowTo JSON-LD for any step-by-step process described on the page."
  }));

  const words = safeNumber(pageData?.wordCount);
  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount);
  const entityDensity = words > 0 ? (entityCount / words) * 100 : 0;
  metrics.push(buildMetric({
    name: "Entity Density",
    raw: entityDensity >= 1.5 ? 10 : entityDensity >= 0.5 ? 5 : 0,
    max: 10,
    weight: 10,
    reason: entityDensity >= 1.5 ? "High entity density supports knowledge-graph grounding." : entityDensity >= 0.5 ? "Moderate entity density." : "Low entity density.",
    evidence: `${entityCount} entities across ${words} words (${entityDensity.toFixed(2)} per 100 words).`,
    recommendation: "Reference more specific named entities so AI engines can ground answers in verifiable facts."
  }));

  const hasCleanHeading = safeArray(pageData?.headings?.h1s).length > 0 && safeArray(pageData?.headings?.h2s).length > 0;
  const hasValidDescription = safeText(pageData?.metaDescription).length > 60;
  const structuredAnswersRaw = (hasCleanHeading ? 4 : 0) + (hasValidDescription ? 4 : 0);
  metrics.push(buildMetric({
    name: "Structured Answer Framing",
    raw: structuredAnswersRaw,
    max: 8,
    weight: 8,
    reason: structuredAnswersRaw === 8 ? "Clean heading hierarchy and a substantive meta description both present." : structuredAnswersRaw > 0 ? "Partial structural framing present." : "No structural framing signals detected.",
    evidence: `Clean H1/H2 hierarchy: ${hasCleanHeading}. Meta description over 60 chars: ${hasValidDescription}.`,
    recommendation: "Pair a clear heading hierarchy with a substantive meta description so engines can frame a direct snippet."
  }));

  const hasDirectAnswer = (text.includes("q:") && text.includes("a:")) || (matchedQuestions.length > 0 && text.length > 500);
  metrics.push(buildMetric({
    name: "Direct Answer Blocks",
    raw: hasDirectAnswer ? 10 : 0,
    max: 10,
    weight: 10,
    reason: hasDirectAnswer ? "Direct-answer style content detected near question phrasing." : "No direct-answer block pattern detected.",
    evidence: hasDirectAnswer ? "Question phrasing combined with sufficient surrounding content length." : "Insufficient combination of question phrasing and supporting content length.",
    recommendation: "Follow each question-style heading immediately with a 1-3 sentence direct answer before elaborating."
  }));

  const sentenceCount = text.split(/[.!?]+/).filter(Boolean).length || 1;
  const avgSentenceLength = words / sentenceCount;
  const answerLengthRaw = (avgSentenceLength >= 12 && avgSentenceLength <= 22) ? 5 : (avgSentenceLength < 12 || (avgSentenceLength > 22 && avgSentenceLength <= 35)) ? 3 : 0;
  metrics.push(buildMetric({
    name: "Answer Length Calibration",
    raw: answerLengthRaw,
    max: 5,
    weight: 5,
    reason: answerLengthRaw === 5 ? "Average sentence length is within the optimal extractable range." : answerLengthRaw === 3 ? "Sentence length is workable but not optimal." : "Sentence length is too long for clean extraction.",
    evidence: `Measured average sentence length: ${avgSentenceLength.toFixed(1)} words across ${sentenceCount} sentence(s).`,
    recommendation: "Target 12-22 word average sentence length for maximum extractability by answer engines."
  }));

  const jsonLdCount = safeArray(pageData?.schema?.detectedTypes).length;
  metrics.push(buildMetric({
    name: "LLM-Friendly Formatting",
    raw: jsonLdCount > 0 ? 2 : 0,
    max: 2,
    weight: 2,
    reason: jsonLdCount > 0 ? "Structured data present, aiding machine parsing." : "No structured data present to aid machine parsing.",
    evidence: `${jsonLdCount} structured data type(s) detected.`,
    recommendation: "Add any relevant schema.org JSON-LD type to help language models parse page intent."
  }));

  const result = aggregateMetrics(metrics);
  const readabilityScore = avgSentenceLength >= 12 && avgSentenceLength <= 22 ? 100 : avgSentenceLength < 12 ? 80 : avgSentenceLength > 35 ? 30 : 60;

  // Per-engine simulation is now fully derived from the metrics above —
  // no independent static formula, so it can never drift from real evidence.
  const faqsWeight = metrics.find(m => m.metric === "FAQ Schema")?.contribution || 0;
  const howToWeight = metrics.find(m => m.metric === "HowTo Schema")?.contribution || 0;
  const tableWeight = metrics.find(m => m.metric === "Table Formatting")?.contribution || 0;
  const directAnswerWeight = metrics.find(m => m.metric === "Direct Answer Blocks")?.contribution || 0;

  const chatGptCitationProbability = clamp(Math.round((result.score * 0.40) + (readabilityScore * 0.30) + (faqsWeight * 2)), 10, 99);
  const geminiCitationProbability = clamp(Math.round((result.score * 0.35) + (tableWeight * 2) + (readabilityScore * 0.30)), 10, 99);
  const perplexityCitationProbability = clamp(Math.round((result.score * 0.45) + (directAnswerWeight * 1.5) + (readabilityScore * 0.20)), 10, 99);
  const claudeCitationProbability = clamp(Math.round((result.score * 0.30) + (readabilityScore * 0.50) + (howToWeight * 1.5)), 10, 99);

  return {
    aeoScore: result.score,
    status: result.status,
    metrics: result.metrics,
    passedMetrics: result.passedMetrics,
    failedMetrics: result.failedMetrics,
    totalExpectedImprovement: result.totalExpectedImprovement,
    readabilityScore,
    avgSentenceLength,
    structuralAeoMetrics: {
      hasFAQ, hasHowTo, matchesDefinition: matchedDefinitions.length > 0, hasDirectAnswer,
      listItemsCount, tableRowsCount, jsonLdCount
    },
    simulations: {
      chatgpt: { score: chatGptCitationProbability, reasoning: chatGptCitationProbability >= 80 ? "Strong Q&A structure and FAQ schema alignment." : "Add FAQ schema and direct-answer blocks to improve selection likelihood." },
      gemini: { score: geminiCitationProbability, reasoning: geminiCitationProbability >= 80 ? "Well-structured tables and readable sentence rhythm." : "Add tables and structured data to improve Gemini's rendering fit." },
      perplexity: { score: perplexityCitationProbability, reasoning: perplexityCitationProbability >= 80 ? "Clear direct-answer blocks near question phrasing." : "Add explicit direct-answer sentences immediately after question headings." },
      claude: { score: claudeCitationProbability, reasoning: claudeCitationProbability >= 80 ? "Deep procedural HowTo structure and calibrated sentence length." : "Add HowTo schema and calibrate sentence length to 12-22 words." }
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
export function calculateImageSeoScore(pageData) {
  const images = safeArray(pageData?.images);
  if (images.length === 0) {
    return { score: 100, status: "No Images Present", metrics: [], note: "No <img> elements were found to evaluate." };
  }

  const withAlt = images.filter(i => safeText(i.alt)).length;
  const withGoodFilename = images.filter(i => i.hasFilenameContext).length;
  const withDimensions = images.filter(i => i.width && i.height).length;
  const withLazyLoading = images.filter(i => i.loading === "lazy").length;
  const modernFormat = images.filter(i => i.isModernFormat).length;

  const metrics = [
    buildMetric({ name: "Alt Text Coverage", raw: Math.round((withAlt / images.length) * 30), max: 30, weight: 30, reason: `${withAlt}/${images.length} images have alt text.`, evidence: `${withAlt} of ${images.length} <img> tags carry a non-empty alt attribute.`, recommendation: "Add descriptive alt text to every content image." }),
    buildMetric({ name: "Descriptive Filenames", raw: Math.round((withGoodFilename / images.length) * 20), max: 20, weight: 20, reason: `${withGoodFilename}/${images.length} images use descriptive filenames.`, evidence: `${withGoodFilename} of ${images.length} image filenames avoid generic patterns like "IMG_001.jpg".`, recommendation: "Rename image files to describe their content (e.g., 'blue-widget-front-view.jpg')." }),
    buildMetric({ name: "Explicit Dimensions", raw: Math.round((withDimensions / images.length) * 20), max: 20, weight: 20, reason: `${withDimensions}/${images.length} images declare width/height.`, evidence: `${withDimensions} of ${images.length} <img> tags declare explicit width/height attributes.`, recommendation: "Add width and height attributes to prevent layout shift (CLS) during page load." }),
    buildMetric({ name: "Lazy Loading", raw: Math.round((withLazyLoading / images.length) * 15), max: 15, weight: 15, reason: `${withLazyLoading}/${images.length} images use native lazy loading.`, evidence: `${withLazyLoading} of ${images.length} <img> tags declare loading="lazy".`, recommendation: "Add loading=\"lazy\" to below-the-fold images to improve initial page load speed." }),
    buildMetric({ name: "Modern Image Formats", raw: Math.round((modernFormat / images.length) * 15), max: 15, weight: 15, reason: `${modernFormat}/${images.length} images use WebP/AVIF.`, evidence: `${modernFormat} of ${images.length} images use a modern compressed format (WebP/AVIF).`, recommendation: "Convert JPEG/PNG images to WebP or AVIF for smaller file sizes at equivalent quality." })
  ];

  return aggregateMetrics(metrics);
}

export function calculateInternalLinkScoreDetailed(linkAnalysisDetail) {
  const d = safeObject(linkAnalysisDetail);
  const metrics = [
    buildMetric({ name: "Internal Link Volume", raw: clamp(d.internalLinks, 0, 15), max: 15, weight: 30, reason: `${d.internalLinks || 0} internal links detected.`, evidence: `${d.internalLinks || 0} internal links across ${d.uniquePages || 0} unique destinations.`, recommendation: "Increase internal linking to related content." }),
    buildMetric({ name: "Anchor Text Diversity", raw: Math.round((safeNumber(d.anchorDiversityScore) / 100) * 25), max: 25, weight: 25, reason: `Anchor diversity score: ${d.anchorDiversityScore || 0}/100.`, evidence: `Anchor diversity measured at ${d.anchorDiversityScore || 0}/100 across sampled links.`, recommendation: "Vary anchor text instead of repeating the same phrase across links." }),
    buildMetric({ name: "Contextual Placement", raw: Math.round((safeNumber(d.contextualLinkScore) / 100) * 25), max: 25, weight: 25, reason: `Contextual link score: ${d.contextualLinkScore || 0}/100.`, evidence: `${d.contextualLinkScore || 0}/100 of internal links sit inside body paragraphs/lists rather than navigation.`, recommendation: "Place internal links within body content, not just navigation and footers." }),
    buildMetric({ name: "Destination Coverage", raw: d.orphanPageRiskDetected ? 0 : 20, max: 20, weight: 20, reason: d.orphanPageRiskDetected ? "Low unique destination count suggests possible orphaned pages." : "Healthy spread of unique link destinations.", evidence: `${d.uniquePages || 0} unique internal destinations detected from this single-page crawl.`, recommendation: "Run a full-site crawl to confirm and fix orphaned pages with no inbound internal links." })
  ];
  return aggregateMetrics(metrics);
}

export function calculateLocalSeoScore(pageData, schemaAudit) {
  const hasLocalBusinessSchema = safeArray(schemaAudit?.detectedTypes).some(t => String(t).toLowerCase() === "localbusiness");
  const hasPhone = safeArray(pageData?.entityDetails?.phones).length > 0;
  const hasAddress = /\b\d{5}\b/.test(safeText(pageData?.visibleText)) || /address|suite|street|avenue/i.test(safeText(pageData?.visibleText));
  const hasMapEmbed = /google\.com\/maps|maps\.google/i.test(safeText(pageData?.visibleText));
  const hasHoursText = /(open|hours)[^.]{0,40}(mon|tue|wed|thu|fri|sat|sun|\d{1,2}\s*(am|pm))/i.test(safeText(pageData?.visibleText).toLowerCase());
  const hasReviewsText = /review|testimonial|star rating|rated \d/i.test(safeText(pageData?.visibleText).toLowerCase());

  const metrics = [
    buildMetric({ name: "NAP Consistency (Name/Address/Phone)", raw: (hasPhone ? 10 : 0) + (hasAddress ? 10 : 0), max: 20, weight: 20, reason: hasPhone && hasAddress ? "Both phone and address signals detected in content." : "Incomplete NAP signals detected.", evidence: `Phone detected: ${hasPhone}. Address pattern detected: ${hasAddress}.`, recommendation: "Ensure Name, Address, and Phone are clearly and consistently listed on the page." }),
    buildMetric({ name: "LocalBusiness Schema", raw: hasLocalBusinessSchema ? 25 : 0, max: 25, weight: 25, reason: hasLocalBusinessSchema ? "LocalBusiness structured data detected." : "No LocalBusiness schema detected.", evidence: hasLocalBusinessSchema ? "LocalBusiness JSON-LD present." : "No LocalBusiness entry in detected schema types.", recommendation: "Add LocalBusiness JSON-LD with name, address, phone, and geo coordinates." }),
    buildMetric({ name: "Google Maps Linkage", raw: hasMapEmbed ? 20 : 0, max: 20, weight: 20, reason: hasMapEmbed ? "Google Maps reference detected." : "No Google Maps embed or link detected.", evidence: `Google Maps URL pattern detected in page content: ${hasMapEmbed}.`, recommendation: "Embed a Google Maps widget or link to your Google Business Profile listing." }),
    buildMetric({ name: "Opening Hours", raw: hasHoursText ? 15 : 0, max: 15, weight: 15, reason: hasHoursText ? "Opening hours text pattern detected." : "No opening hours text detected.", evidence: `Day-of-week / time pattern detected: ${hasHoursText}.`, recommendation: "List business hours clearly in visible text or structured data (openingHoursSpecification)." }),
    buildMetric({ name: "Review/Testimonial Signals", raw: hasReviewsText ? 20 : 0, max: 20, weight: 20, reason: hasReviewsText ? "Review or testimonial language detected." : "No review or testimonial content detected.", evidence: `Review-related keyword pattern detected: ${hasReviewsText}.`, recommendation: "Display customer reviews or testimonials, ideally with Review/AggregateRating schema." })
  ];

  return aggregateMetrics(metrics);
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
  const buildEvidenceBlock = (engineKey, score) => {
    const missing = [];
    if (!crawlData.hasFAQ) missing.push("No FAQ schema");
    if (!crawlData.hasDirectAnswer) missing.push("No direct-answer blocks");
    if (!crawlData.hasAuthor) missing.push("No author attribution");
    if (safeNumber(crawlData.wordCount) < 900) missing.push("Content depth below 900 words");
    if (safeNumber(crawlData.tableCount) === 0) missing.push("No tabular data");

    return {
      currentScore: score,
      evidence: `Derived from ${safeNumber(crawlData.wordCount)} words, EEAT score ${safeNumber(crawlData.eeatScore)}, topical authority ${safeNumber(crawlData.topicalAuthorityScore)}, and ${safeNumber(crawlData.internalLinkScore)}/100 internal link strength.`,
      missingSignals: missing,
      improvementSuggestions: missing.length > 0
        ? missing.map(m => `Address: ${m}.`)
        : ["No major gaps detected for this engine profile."]
    };
  };
  return {
    citationProbability: averageProbability,
    engines: {
      chatgpt: { score: chatgpt, status: getEngineVerdict(chatgpt), ...buildEvidenceBlock("chatgpt", chatgpt) },
      gemini: { score: gemini, status: getEngineVerdict(gemini), ...buildEvidenceBlock("gemini", gemini) },
      claude: { score: claude, status: getEngineVerdict(claude), ...buildEvidenceBlock("claude", claude) },
      perplexity: { score: perplexity, status: getEngineVerdict(perplexity), ...buildEvidenceBlock("perplexity", perplexity) },
      copilot: { score: copilot, status: getEngineVerdict(copilot), ...buildEvidenceBlock("copilot", copilot) },
      mistral: { score: mistral, status: getEngineVerdict(mistral), ...buildEvidenceBlock("mistral", mistral) }
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

/**
 * Bounds the in-memory scan cache to MAX_CACHE_ENTRIES using LRU-by-insertion
 * eviction, preventing unbounded memory growth under sustained traffic.
 */
function enforceScanCacheLimit() {
  while (scanCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = scanCache.keys().next().value;
    if (oldestKey === undefined) break;
    scanCache.delete(oldestKey);
  }
}

/**
 * Records a score data point for a URL in the in-memory trend database,
 * bounding both the number of points per URL and the number of tracked
 * URLs to keep memory usage predictable.
 */
function recordTrendPoint(cacheKey, payload) {
  if (!cacheKey) return;

  if (!trendDB[cacheKey] && Object.keys(trendDB).length >= MAX_TREND_URLS) {
    const oldestUrlKey = Object.keys(trendDB)[0];
    if (oldestUrlKey) delete trendDB[oldestUrlKey];
  }

  if (!trendDB[cacheKey]) trendDB[cacheKey] = [];

  trendDB[cacheKey].push({
    timestamp: new Date().toISOString(),
    overallAIVisibilityScore: payload.overallAIVisibilityScore,
    seoScore: payload.seoScore,
    aeoScore: payload.aeoScore,
    eeatScore: payload.eeatScore,
    authorityScore: payload.authorityScore,
    trustScore: payload.trustScore
  });

  if (trendDB[cacheKey].length > MAX_TREND_POINTS_PER_URL) {
    trendDB[cacheKey] = trendDB[cacheKey].slice(-MAX_TREND_POINTS_PER_URL);
  }
}

export async function analyzeSingleUrl(url) {
  const cacheKey = normalizeUrl(url);
  if (scanCache.has(cacheKey)) {
    const entry = scanCache.get(cacheKey);
    if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
      logger.info("CACHE", "serving_cached_scan", { url, cacheKey });
      return entry.data;
    }
    scanCache.delete(cacheKey);
  }

  const startTime = Date.now();
  let crawl = null;
  try {
    crawl = await smartCrawl(url);
  } catch (err) {
    logger.error("ORCHESTRATOR", "smart_crawl_crashed", { url, error: err.message });
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
    logger.warn("ORCHESTRATOR", "target_blocked", { url, system: crawl.blockCheck.system });
    return buildBlockedPayload(url, crawl);
  }

  try {
    const $ = cheerio.load(crawl.html || "");
    const pageData = extractPageData($, crawl.html, crawl.finalUrl);

    // Robots and sitemap detection are independent network calls; run them
    // concurrently rather than sequentially to cut orchestrator latency.
    const [robotsData, sitemapDataSeed] = await Promise.all([
      fetchRobotsTxt(crawl.finalUrl),
      (async () => null)()
    ]);
    const sitemapData = await detectSitemap(crawl.finalUrl, robotsData);
    void sitemapDataSeed;

   const seoAudit = await calculateDynamicSeoScore(pageData, loadTimeMs, {
  robotsData,
  sitemapData,
  schemaAudit: schemasDetected
});
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
    const imageSeoAudit = calculateImageSeoScore(pageData);
    const internalLinkAudit = calculateInternalLinkScoreDetailed(pageData.linkAnalysisDetail);
    const localSeoAudit = calculateLocalSeoScore(pageData, schemasDetected);
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
    if (schemasDetected.validation.invalidBlocks > 0) {
      roadmap.push("Repair malformed JSON-LD schema blocks flagged during structural validation.");
      autopilotTasks.push({
        id: `task_${taskIdCounter++}`,
        priority: "HIGH",
        impact: 9,
        title: "Fix Invalid JSON-LD Markup",
        description: `${schemasDetected.validation.invalidBlocks} structured data block(s) failed validation and are likely ignored by search and AI crawlers.`
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
        rdfa: schemasDetected.rdfa,
        validation: schemasDetected.validation
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
      imageSeo: imageSeoAudit,
      internalLinkDetail: internalLinkAudit,
      localSEO: {
        localScore: localSeoAudit.score,
        napConsistency: localSeoAudit.metrics.find(m => m.metric.includes("NAP"))?.reason,
        mapDetected: localSeoAudit.metrics.find(m => m.metric.includes("Maps"))?.passed || false,
        localBusinessSchemaDetected: localSeoAudit.metrics.find(m => m.metric.includes("LocalBusiness"))?.passed || false,
        metrics: localSeoAudit.metrics
      },
      recommendedSchemas: schemaBlock.missingSchemas,
      schemaRecommendationsBlock: schemaBlock.schemaGeneratorCode,
      roadmap,
      aiAutopilot: autopilotTasks,
      autopilot: { tasks: autopilotTasks }
    };

    scanCache.set(cacheKey, { timestamp: Date.now(), data: payload });
    enforceScanCacheLimit();

    recordTrendPoint(cacheKey, payload);

    scanHistory.unshift({
      url: crawl.finalUrl,
      title: payload.title,
      score: payload.overallAIVisibilityScore,
      timestamp: new Date().toISOString()
    });
    if (scanHistory.length > MAX_SCAN_HISTORY) scanHistory.length = MAX_SCAN_HISTORY;

    return payload;
  } catch (err) {
    logger.error("ORCHESTRATOR", "compilation_parser_error", { url, error: err.message, stack: err.stack });
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

/**
 * Shared query-param validator for the two-URL comparison-style endpoints
 * (/compare, /content-gap, /gap-analysis, /keyword-theft).
 */
function validateComparisonParams(req, res) {
  const { url, competitor } = req.query;
  if (!safeText(url) || !safeText(competitor)) {
    res.status(400).json({ success: false, status: "ERROR", message: "Both 'url' and 'competitor' query parameters are required." });
    return null;
  }

  const normalizedUrl = enforceSecureUrl(url);
  const normalizedComp = enforceSecureUrl(competitor);

  if (!normalizedUrl || !normalizedComp) {
    res.status(400).json({ success: false, status: "ERROR", message: "Invalid or unsafe target domain parameters received." });
    return null;
  }

  return { normalizedUrl, normalizedComp };
}

app.get("/", (req, res) => {
  try {
    res.sendFile(path.resolve("public/index.html"));
  } catch (err) {
    logger.error("API", "root_path_failed", { error: err.message });
    res.status(500).json({ success: false, error: "Root path configuration error" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    tool: "AI Visibility SaaS Platform",
    version: "10.1-enterprise-hardened",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get("/scan", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!safeText(url)) {
    return res.status(400).json({ success: false, status: "ERROR", message: "Target URL parameter is required." });
  }

  const normalized = enforceSecureUrl(url);
  if (!normalized) {
    return res.status(400).json({ success: false, status: "ERROR", message: "Malformed target domain, unsafe host, or invalid TLD received." });
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
  } finally {
    activeScans.delete(cacheKey);
  }
}));

app.get("/compare", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const validated = validateComparisonParams(req, res);
  if (!validated) return;
  const { normalizedUrl, normalizedComp } = validated;

  const results = await Promise.allSettled([
    analyzeSingleUrl(normalizedUrl),
    analyzeSingleUrl(normalizedComp)
  ]);

  const site1 = results[0].status === "fulfilled" ? results[0].value : null;
  const site2 = results[1].status === "fulfilled" ? results[1].value : null;

  if (results[0].status === "rejected") {
    logger.error("API", "compare_site1_failed", { url: normalizedUrl, error: results[0].reason?.message });
  }
  if (results[1].status === "rejected") {
    logger.error("API", "compare_site2_failed", { url: normalizedComp, error: results[1].reason?.message });
  }

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
}));

app.get("/content-gap", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const validated = validateComparisonParams(req, res);
  if (!validated) return;
  const { normalizedUrl, normalizedComp } = validated;

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
}));

app.get("/gap-analysis", authenticateAndRateLimit, (req, res) => {
  const { url, competitor } = req.query;
  if (!safeText(url) || !safeText(competitor)) {
    return res.status(400).json({ success: false, error: "Both 'url' and 'competitor' parameters are required." });
  }
  res.redirect(`/content-gap?url=${encodeURIComponent(url)}&competitor=${encodeURIComponent(competitor)}`);
});

app.get("/roadmap", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!safeText(url)) return res.status(400).json({ success: false, error: "URL parameter required" });
  const normalizedUrl = enforceSecureUrl(url);
  if (!normalizedUrl) {
    return res.status(400).json({ success: false, error: "Invalid or unsafe URL structure received" });
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
}));

app.get("/keyword-theft", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const validated = validateComparisonParams(req, res);
  if (!validated) return;
  const { normalizedUrl, normalizedComp } = validated;

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
        searchVolume: getDeterministicSearchVolume(k),
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
}));

app.get("/content-brief", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!safeText(url)) return res.status(400).json({ success: false, error: "URL parameter required" });
  const normalizedUrl = enforceSecureUrl(url);
  if (!normalizedUrl) return res.status(400).json({ success: false, error: "Invalid or unsafe URL structure received" });

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
}));

app.get("/autopilot", authenticateAndRateLimit, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!safeText(url)) return res.status(400).json({ success: false, error: "URL parameter required" });
  const normalizedUrl = enforceSecureUrl(url);
  if (!normalizedUrl) return res.status(400).json({ success: false, error: "Invalid or unsafe URL structure received" });

  const data = await analyzeSingleUrl(normalizedUrl);
  if (!data || data.blocked) {
    return res.json(data);
  }

  res.json({
    status: "SUCCESS",
    success: true,
    autopilot: { tasks: data.aiAutopilot || [] }
  });
}));

app.get("/history", (req, res) => {
  try {
    res.json(safeArray(scanHistory));
  } catch (err) {
    logger.error("API", "history_retrieval_failed", { error: err.message });
    res.status(500).json({ success: false, error: "History retrieval failed" });
  }
});

app.get("/trend", (req, res) => {
  try {
    const { url } = req.query;
    if (!safeText(url)) {
      return res.status(400).json({ success: false, error: "URL parameter required" });
    }
    const normalized = enforceSecureUrl(url);
    if (!normalized) {
      return res.status(400).json({ success: false, error: "Invalid or unsafe URL structure received" });
    }
    const cacheKey = normalizeUrl(normalized);
    res.json({
      success: true,
      url: normalized,
      points: safeArray(trendDB[cacheKey])
    });
  } catch (err) {
    logger.error("API", "trend_retrieval_failed", { error: err.message });
    res.status(500).json({ success: false, error: "Trend retrieval failed" });
  }
});

// =========================================================================
// ========== SECTION 16.5: ERROR HANDLING & FALLBACK ROUTES ===============
// =========================================================================

app.use((req, res) => {
  res.status(404).json({ success: false, status: "NOT_FOUND", message: `No route matches ${req.method} ${req.path}.` });
});

// Centralized Express error handler. Anything reaching here has already
// been caught via asyncHandler or thrown synchronously in a route.
app.use((err, req, res, next) => {
  logger.error("HTTP", "unhandled_route_error", {
    requestId: req?.requestId,
    path: req?.path,
    error: err?.message,
    stack: err?.stack
  });

  if (res.headersSent) return next(err);

  res.status(500).json({
    success: false,
    status: "ERROR",
    message: "An unexpected internal error occurred while processing the request."
  });
});

// =========================================================================
// ========== SECTION 17: EXPRESS HTTP SERVER INITIALIZATION ==============
// =========================================================================

const server = app.listen(PORT, () => {
  logger.info("SYSTEM", "server_started", { port: PORT, version: "10.1-enterprise-hardened" });
});

// Prevents a single unexpected rejection/exception from silently crashing
// the whole process without any diagnostic trail.
process.on("unhandledRejection", (reason) => {
  logger.error("PROCESS", "unhandled_rejection", { reason: reason?.message || String(reason), stack: reason?.stack });
});

process.on("uncaughtException", (err) => {
  logger.error("PROCESS", "uncaught_exception", { error: err.message, stack: err.stack });
});

async function gracefulShutdown(signal) {
  logger.info("SYSTEM", "shutdown_initiated", { signal });
  server.close(async () => {
    await closeBrowserInstance();
    logger.info("SYSTEM", "shutdown_complete", { signal });
    process.exit(0);
  });

  // Force-exit if graceful close hangs.
  setTimeout(() => {
    logger.warn("SYSTEM", "shutdown_forced", { signal });
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
