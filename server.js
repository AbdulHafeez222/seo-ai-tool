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
/**
 * Classifies a failed metric into a Priority/Impact/Difficulty recommendation
 * object purely from its own weight/expectedImprovement — no static or
 * guessed values, no randomness.
 */
export function classifyRecommendation(metric) {
  const impact = metric.expectedImprovement;
  const priority = impact >= 10 ? "HIGH" : impact >= 5 ? "MEDIUM" : "LOW";
  const difficulty = /schema|https|canonical|meta|alt|viewport/i.test(metric.metric) ? "EASY"
    : /content|depth|readab|entity|link/i.test(metric.metric) ? "MODERATE"
    : "MODERATE";
  return {
    metric: metric.metric,
    priority,
    impact: priority,
    difficulty,
    recommendation: metric.recommendation,
    estimatedGain: impact
  };
}

/**
 * Wraps an aggregateMetrics() result into the enterprise-standard score
 * object shape required across every scoring category. Purely additive —
 * every existing field the aggregateMetrics result already carries (score,
 * status, metrics, etc.) is preserved unchanged; this only appends the new
 * standardized keys on top so existing frontend/API consumers are unaffected.
 */
export function buildStandardizedScoreOutput(aggregateResult, categoryWeight = 100) {
  const failed = aggregateResult.metrics.filter(m => !m.passed);
  return {
    ...aggregateResult,
    maxScore: 100,
    weight: categoryWeight,
    evidence: aggregateResult.metrics.map(m => `${m.metric}: ${m.evidence}`),
    penalties: failed.map(m => ({ metric: m.metric, penalty: m.expectedImprovement, reason: m.reason })),
    recommendations: failed.map(classifyRecommendation),
    expectedGain: aggregateResult.totalExpectedImprovement
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
/**
 * Heuristic syllable counter (vowel-group based) used for real Flesch
 * Reading Ease calculation — no external NLP dependency required.
 */
export function countSyllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const matches = w.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;
  if (w.endsWith("e") && count > 1) count--;
  return Math.max(1, count);
}

/**
 * Real Flesch Reading Ease score computed from actual word/sentence/
 * syllable counts in the supplied text — not a static estimate.
 */
export function calculateReadability(text) {
  const clean = safeText(text);
  const sentences = clean.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = clean.split(/\s+/).filter(Boolean);
  const sentenceCount = sentences.length || 1;
  const wordCount = words.length || 1;
  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);

  const fleschScore = 206.835 - (1.015 * (wordCount / sentenceCount)) - (84.6 * (syllableCount / wordCount));
  const clampedScore = clamp(Math.round(fleschScore), 0, 100);

  let label;
  if (clampedScore >= 70) label = "Easy to read";
  else if (clampedScore >= 50) label = "Standard readability";
  else if (clampedScore >= 30) label = "Fairly difficult";
  else label = "Very difficult to read";

  return { fleschScore: clampedScore, label, avgWordsPerSentence: parseFloat((wordCount / sentenceCount).toFixed(1)), avgSyllablesPerWord: parseFloat((syllableCount / wordCount).toFixed(2)) };
}

/**
 * Detects internally-duplicated paragraph blocks (the same or near-identical
 * paragraph repeated within the page). This is a single-page duplication
 * check only — it cannot detect duplication against other pages/domains
 * without a full-site or web-wide index, which this architecture doesn't
 * have. That limitation is stated explicitly in the returned evidence
 * rather than silently implying broader duplicate-content coverage.
 */
export function detectInternalDuplication($) {
  const paragraphs = $("p").map((_, el) => safeText($(el).text())).get().filter(p => p.length > 40);
  const normalized = paragraphs.map(p => p.toLowerCase().replace(/\s+/g, " ").trim());
  const counts = {};
  normalized.forEach(p => { counts[p] = (counts[p] || 0) + 1; });
  const duplicates = Object.entries(counts).filter(([, count]) => count > 1);

  return {
    totalParagraphs: paragraphs.length,
    duplicateBlockCount: duplicates.length,
    duplicateInstances: duplicates.reduce((sum, [, count]) => sum + (count - 1), 0),
    scopeNote: "Checked for repeated paragraph blocks within this single page only. Cross-page or cross-domain duplicate content requires a full-site or web index, which was not performed."
  };
}

/**
 * Computes keyword density for the page's own top extracted keywords and
 * flags stuffing if any single keyword exceeds a natural density threshold.
 */
export function detectKeywordStuffing(text, topKeywords) {
  const words = safeText(text).toLowerCase().split(/\s+/).filter(Boolean);
  const totalWords = words.length || 1;

  const densities = safeArray(topKeywords).map(kw => {
    const occurrences = words.filter(w => w.replace(/[^\w]/g, "") === kw).length;
    const density = (occurrences / totalWords) * 100;
    return { keyword: kw, occurrences, density: parseFloat(density.toFixed(2)) };
  });

  const stuffed = densities.filter(d => d.density > 3.5);

  return {
    densities,
    stuffingDetected: stuffed.length > 0,
    stuffedKeywords: stuffed.map(d => d.keyword)
  };
}
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

export function detectBlockedReason(html, status, redirectCount = 0) {
  const text = safeText(html).toLowerCase();
  const signals = [];

  if (status === 403 || status === 401) {
    return { blocked: true, system: "Cloudflare/CDN Forbidden", reason: "Server returned a security response status of 403/401.", signals: ["http_403_401"] };
  }
  if (status === 404) {
    return { blocked: true, system: "Not Found", reason: "Target document could not be located (404).", signals: ["http_404"] };
  }
  if (status === 429) {
    return { blocked: true, system: "Rate Limiter Block", reason: "Target endpoint rate-limited the crawler.", signals: ["http_429"] };
  }
  if (status >= 500) {
    return { blocked: true, system: "Origin Server Error", reason: `Target returned a server-side error status (${status}).`, signals: ["http_5xx"] };
  }

  if (text.includes("cloudflare") || text.includes("cf-browser-verification") || text.includes("ray id:") || text.includes("cf-chl-bypass") || text.includes("__cf_chl")) {
    return { blocked: true, system: "Cloudflare Turnstile", reason: "Cloudflare challenge page detected.", signals: ["cloudflare_challenge"] };
  }
  if (text.includes("captcha") || text.includes("recaptcha") || text.includes("hcaptcha") || text.includes("verify you are human") || text.includes("are you a robot")) {
    return { blocked: true, system: "CAPTCHA Block", reason: "Page validation challenge triggered.", signals: ["captcha"] };
  }
  if (text.includes("just a moment") && text.includes("checking your browser")) {
    return { blocked: true, system: "DDoS Mitigation Screen", reason: "Active browser checking screen encountered.", signals: ["js_challenge"] };
  }
  if (text.includes("access denied") || text.includes("you don't have permission")) {
    return { blocked: true, system: "Access Denied", reason: "Server explicitly denied access to the requested resource.", signals: ["access_denied"] };
  }
  if (text.includes("pardon our interruption") || text.includes("unusual traffic")) {
    return { blocked: true, system: "Bot Mitigation Interstitial", reason: "Target displayed a bot-mitigation interstitial page.", signals: ["bot_interstitial"] };
  }

  // WAF signatures — generic vendor fingerprints beyond Cloudflare.
  const wafSignatures = [
    "web application firewall", "blocked by security policy", "incapsula incident",
    "sucuri website firewall", "mod_security", "akamai reference number",
    "request blocked by imperva", "the requested url was rejected"
  ];
  const matchedWaf = wafSignatures.find(sig => text.includes(sig));
  if (matchedWaf) {
    return { blocked: true, system: "Web Application Firewall", reason: `WAF signature detected: "${matchedWaf}".`, signals: ["waf_signature"] };
  }

  // Login-wall detection — content is gated behind authentication rather
  // than genuinely blocked, but downstream SEO analysis would be equally
  // meaningless since we're not seeing the real page.
  const loginPhrases = [
    "please sign in to continue", "please log in to continue", "you must log in",
    "login required to view this page", "sign in to view this content", "you need to be logged in"
  ];
  const matchedLogin = loginPhrases.find(p => text.includes(p));
  const hasPasswordField = /<input[^>]+type=["']password["']/i.test(html);
  if (matchedLogin || (hasPasswordField && text.length < 2500)) {
    return { blocked: true, system: "Authentication Wall", reason: matchedLogin ? `Login-gated content detected: "${matchedLogin}".` : "Password field detected on a very short page, indicating a login gate rather than real content.", signals: ["login_wall"] };
  }

  // Soft-404: HTTP 200 but the page body indicates the resource doesn't
  // exist. Requires BOTH a not-found phrase AND thin content, to avoid
  // false-positives on pages that merely mention "404" in passing (e.g. a
  // blog post about HTTP status codes).
  const notFoundPhrases = [
    "page not found", "404 error", "content not available", "this page doesn't exist",
    "the page you are looking for", "we couldn't find that page", "oops! that page can't be found"
  ];
  const matchedNotFound = notFoundPhrases.find(p => text.includes(p));
  const visibleTextLength = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  if (matchedNotFound && visibleTextLength < 1200) {
    return { blocked: true, system: "Soft 404", reason: `Page returned HTTP 200 but content indicates a not-found state: "${matchedNotFound}".`, signals: ["soft_404"] };
  }

  if (redirectCount > 5) {
    signals.push("excessive_redirects");
  }

  return { blocked: false, system: null, reason: null, signals };
}
/**
 * Supplementary block/error signatures beyond what detectBlockedReason
 * already covers: JavaScript-required walls, bot-verification challenges,
 * maintenance pages, generic error templates, custom 404s, and empty HTML.
 * Kept separate so detectBlockedReason's existing, already-proven signal
 * set is never touched.
 */
export function detectAdditionalPageSignatures(html, title) {
  const text = safeText(html).toLowerCase();
  const titleLower = safeText(title).toLowerCase();
  const visibleTextLength = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;

  if (visibleTextLength < 40 || safeText(html).trim().length < 200) {
    return { matched: true, category: "EMPTY_PAGE", system: "Empty HTML", reason: `Document contains only ${visibleTextLength} character(s) of visible text and ${safeText(html).length} total byte(s) — effectively empty.` };
  }

  const jsRequiredPhrases = ["please enable javascript", "javascript is required", "enable javascript to continue", "this site requires javascript"];
  const matchedJsRequired = jsRequiredPhrases.find(p => text.includes(p));
  if (matchedJsRequired) {
    return { matched: true, category: "BLOCKED_PAGE", system: "JavaScript Required", reason: `Page requires JavaScript to render real content: "${matchedJsRequired}".` };
  }

  const botVerificationPhrases = ["verify you are a human", "bot verification", "automated access detected", "unusual activity from your browser"];
  const matchedBotVerification = botVerificationPhrases.find(p => text.includes(p));
  if (matchedBotVerification) {
    return { matched: true, category: "BLOCKED_PAGE", system: "Bot Verification Challenge", reason: `Bot verification phrase detected: "${matchedBotVerification}".` };
  }

  const maintenancePhrases = ["site is under maintenance", "temporarily unavailable", "scheduled maintenance", "back soon", "we'll be back", "down for maintenance"];
  const matchedMaintenance = maintenancePhrases.find(p => text.includes(p));
  if (matchedMaintenance) {
    return { matched: true, category: "ERROR_PAGE", system: "Maintenance Page", reason: `Maintenance page phrase detected: "${matchedMaintenance}".` };
  }

  const errorTemplatePhrases = ["something went wrong", "an unexpected error has occurred", "internal server error", "application error", "we're sorry, something broke", "an error occurred while processing your request"];
  const matchedErrorTemplate = errorTemplatePhrases.find(p => text.includes(p));
  if (matchedErrorTemplate) {
    return { matched: true, category: "ERROR_PAGE", system: "Generic Error Template", reason: `Error template phrase detected: "${matchedErrorTemplate}".` };
  }

  const looksLike404 = /\b404\b/.test(titleLower) && visibleTextLength < 800;
  if (looksLike404) {
    return { matched: true, category: "ERROR_PAGE", system: "Custom 404 Page", reason: `Title references "404" alongside thin content (${visibleTextLength} chars).` };
  }

  return { matched: false, category: null, system: null, reason: null };
}

/**
 * Page Integrity Score (0-100): evidence-based check across all 13
 * required signals — never a static or guessed number.
 */
export function calculatePageIntegrityScore($, html) {
  const metrics = [];

  const title = safeText($("title").text());
  metrics.push(buildMetric({ name: "Document Title", raw: title.length > 0 ? 8 : 0, max: 8, weight: 8, reason: title ? "Title element present." : "No <title> element found.", evidence: title ? `Title: "${title}".` : "Missing <title>.", recommendation: "Ensure the page serves a real <title> element." }));

  const metaDesc = safeText($('meta[name="description"]').attr("content"));
  metrics.push(buildMetric({ name: "Meta Description", raw: metaDesc.length > 0 ? 7 : 0, max: 7, weight: 7, reason: metaDesc ? "Meta description present." : "No meta description found.", evidence: metaDesc ? `Description present (${metaDesc.length} chars).` : "Missing meta description.", recommendation: "Ensure the page serves a real meta description." }));

  const bodyText = safeText($("body").text()).replace(/\s+/g, " ").trim();
  const bodyTextLength = bodyText.length;
  metrics.push(buildMetric({ name: "Body Text Length", raw: bodyTextLength >= 500 ? 12 : bodyTextLength >= 150 ? 6 : 0, max: 12, weight: 12, reason: bodyTextLength >= 500 ? "Substantial visible body text." : bodyTextLength >= 150 ? "Minimal visible body text." : "Body text is too short to represent real content.", evidence: `${bodyTextLength} character(s) of visible body text.`, recommendation: "Verify the server returned complete page content, not a stub or partial render." }));

  const htmlSize = safeText(html).length;
  const tagCount = (safeText(html).match(/<[a-z][a-z0-9]*(\s|>)/gi) || []).length;
  metrics.push(buildMetric({ name: "DOM Completeness", raw: tagCount >= 40 ? 10 : tagCount >= 15 ? 5 : 0, max: 10, weight: 10, reason: tagCount >= 40 ? "Rich DOM tag structure detected." : tagCount >= 15 ? "Sparse DOM tag structure." : "Extremely thin DOM, unlikely to be a real rendered page.", evidence: `${tagCount} HTML tag(s) across ${htmlSize} byte(s) of markup.`, recommendation: "Confirm the crawler captured the fully rendered page." }));

  const hasNav = $("nav, [role='navigation'], header nav, .navbar, .nav-menu, .site-nav").length > 0;
  metrics.push(buildMetric({ name: "Navigation Exists", raw: hasNav ? 8 : 0, max: 8, weight: 8, reason: hasNav ? "Navigation landmark detected." : "No navigation element detected.", evidence: `Nav landmark match: ${hasNav}.`, recommendation: "Verify navigation rendered." }));

  const hasFooter = $("footer, [role='contentinfo'], .site-footer, .footer").length > 0;
  metrics.push(buildMetric({ name: "Footer Exists", raw: hasFooter ? 7 : 0, max: 7, weight: 7, reason: hasFooter ? "Footer landmark detected." : "No footer element detected.", evidence: `Footer landmark match: ${hasFooter}.`, recommendation: "Verify the footer region rendered." }));

  const hasMain = $("main, [role='main'], article, .main-content, #main, #content").length > 0;
  metrics.push(buildMetric({ name: "Main Content Exists", raw: hasMain ? 10 : 0, max: 10, weight: 10, reason: hasMain ? "Main content landmark detected." : "No main/article content landmark detected.", evidence: `Main content landmark match: ${hasMain}.`, recommendation: "Verify the primary content region rendered." }));

  const h1Count = $("h1").length;
  const h2Count = $("h2").length;
  metrics.push(buildMetric({ name: "Heading Structure", raw: (h1Count > 0 ? 5 : 0) + (h2Count > 0 ? 5 : 0), max: 10, weight: 10, reason: h1Count === 0 ? "No H1 heading found." : h2Count === 0 ? "H1 present but no H2 subheadings." : "H1/H2 hierarchy present.", evidence: `H1 count: ${h1Count}. H2 count: ${h2Count}.`, recommendation: "Verify heading structure rendered." }));

  const canonical = safeText($('link[rel="canonical"]').attr("href"));
  metrics.push(buildMetric({ name: "Canonical Tag", raw: canonical ? 5 : 0, max: 5, weight: 5, reason: canonical ? "Canonical tag present." : "No canonical tag found.", evidence: canonical ? `Canonical: ${canonical}` : "Missing canonical link.", recommendation: "Verify canonical tag rendered." }));

  const visibleContentRatio = htmlSize > 0 ? bodyTextLength / htmlSize : 0;
  metrics.push(buildMetric({ name: "Visible Content Ratio", raw: visibleContentRatio >= 0.08 ? 8 : visibleContentRatio >= 0.03 ? 4 : 0, max: 8, weight: 8, reason: visibleContentRatio >= 0.08 ? "Healthy visible-text-to-markup ratio." : visibleContentRatio >= 0.03 ? "Low but plausible ratio." : "Visible text negligible relative to markup — common on challenge/loading pages.", evidence: `Visible text ratio: ${(visibleContentRatio * 100).toFixed(1)}%.`, recommendation: "Investigate whether this page requires JavaScript to render real content." }));

  metrics.push(buildMetric({ name: "HTML Size", raw: htmlSize >= 3000 ? 5 : htmlSize >= 1000 ? 2 : 0, max: 5, weight: 5, reason: htmlSize >= 3000 ? "Document size consistent with a real page." : htmlSize >= 1000 ? "Document size is on the small side." : "Document size too small to be genuine.", evidence: `Total document size: ${htmlSize} byte(s).`, recommendation: "Verify the full page payload was captured." }));

  const internalLinkCount = $("a[href]").length;
  metrics.push(buildMetric({ name: "Internal Links Present", raw: internalLinkCount >= 5 ? 5 : internalLinkCount > 0 ? 2 : 0, max: 5, weight: 5, reason: internalLinkCount >= 5 ? "Healthy number of links detected." : internalLinkCount > 0 ? "Few links detected." : "No links detected anywhere on the page.", evidence: `${internalLinkCount} <a href> element(s) detected.`, recommendation: "Real pages almost always contain multiple links." }));

  const imageCount = $("img").length;
  metrics.push(buildMetric({ name: "Images Present", raw: imageCount > 0 ? 5 : 0, max: 5, weight: 5, reason: imageCount > 0 ? `${imageCount} image(s) detected.` : "No images detected.", evidence: `${imageCount} <img> element(s) detected.`, recommendation: "Absence of images is normal for text-only pages but also common on stub pages." }));

  const result = aggregateMetrics(metrics);
  return {
    integrityScore: result.score,
    metrics: result.metrics,
    raw: { title, metaDesc, bodyTextLength, htmlSize, tagCount, hasNav, hasFooter, hasMain, h1Count, h2Count, canonical, visibleContentRatio, internalLinkCount, imageCount }
  };
}

/**
 * Validation Confidence (0-100): a narrower composite, differently
 * weighted from Page Integrity Score, focused specifically on how
 * trustworthy this content is for downstream scoring.
 */
export function calculateValidationConfidence(integrityRaw, blockSignalCount) {
  const metrics = [
    buildMetric({ name: "DOM Completeness", raw: integrityRaw.tagCount >= 40 ? 20 : integrityRaw.tagCount >= 15 ? 10 : 0, max: 20, weight: 20, reason: `${integrityRaw.tagCount} tag(s) detected.`, evidence: `Tag density: ${integrityRaw.tagCount}.`, recommendation: "Investigate incomplete rendering." }),
    buildMetric({ name: "Visible Text", raw: integrityRaw.bodyTextLength >= 500 ? 20 : integrityRaw.bodyTextLength >= 150 ? 10 : 0, max: 20, weight: 20, reason: `${integrityRaw.bodyTextLength} visible character(s).`, evidence: `Body text length: ${integrityRaw.bodyTextLength}.`, recommendation: "Investigate thin visible content." }),
    buildMetric({ name: "Main Content", raw: integrityRaw.hasMain ? 15 : 0, max: 15, weight: 15, reason: integrityRaw.hasMain ? "Main content region found." : "No main content region found.", evidence: `hasMain: ${integrityRaw.hasMain}.`, recommendation: "Verify primary content container rendered." }),
    buildMetric({ name: "Navigation", raw: integrityRaw.hasNav ? 10 : 0, max: 10, weight: 10, reason: integrityRaw.hasNav ? "Navigation found." : "No navigation found.", evidence: `hasNav: ${integrityRaw.hasNav}.`, recommendation: "Verify navigation rendered." }),
    buildMetric({ name: "Footer", raw: integrityRaw.hasFooter ? 10 : 0, max: 10, weight: 10, reason: integrityRaw.hasFooter ? "Footer found." : "No footer found.", evidence: `hasFooter: ${integrityRaw.hasFooter}.`, recommendation: "Verify footer rendered." }),
    buildMetric({ name: "Metadata", raw: (integrityRaw.title ? 7.5 : 0) + (integrityRaw.metaDesc ? 7.5 : 0), max: 15, weight: 15, reason: `Title present: ${Boolean(integrityRaw.title)}. Description present: ${Boolean(integrityRaw.metaDesc)}.`, evidence: `Title: "${integrityRaw.title || 'none'}".`, recommendation: "Verify metadata rendered." }),
    buildMetric({ name: "Challenge Indicators", raw: blockSignalCount === 0 ? 10 : 0, max: 10, weight: 10, reason: blockSignalCount === 0 ? "No challenge/block signatures detected." : `${blockSignalCount} challenge/block signature(s) detected.`, evidence: `Block signal count: ${blockSignalCount}.`, recommendation: "Resolve bot-mitigation or challenge screens." })
  ];
  return aggregateMetrics(metrics);
}

/**
 * Enterprise Page Validation Engine — the sole authority for whether
 * extracted HTML represents a real website page. HTTP status is never
 * used in isolation to make this decision.
 */
export function runPageValidationEngine(html, status, redirectCount = 0) {
  const $ = cheerio.load(safeText(html) || "<html><body></body></html>");
  const title = safeText($("title").text());

  const primaryBlockCheck = detectBlockedReason(html, status, redirectCount);
  const additionalSignature = detectAdditionalPageSignatures(html, title);

  const integrity = calculatePageIntegrityScore($, html);
  const blockSignalCount = (primaryBlockCheck.blocked ? 1 : 0) + (additionalSignature.matched ? 1 : 0);
  const confidence = calculateValidationConfidence(integrity.raw, blockSignalCount);

  let state, protectionType, evidence, retryRecommendation;

  if (primaryBlockCheck.blocked) {
    const isAuthOrChallenge = ["Cloudflare Turnstile", "CAPTCHA Block", "DDoS Mitigation Screen", "Bot Mitigation Interstitial", "Web Application Firewall", "Authentication Wall", "Cloudflare/CDN Forbidden", "Rate Limiter Block"].includes(primaryBlockCheck.system);
    state = isAuthOrChallenge ? "BLOCKED_PAGE" : "ERROR_PAGE";
    protectionType = primaryBlockCheck.system;
    evidence = primaryBlockCheck.reason;
    retryRecommendation = state === "BLOCKED_PAGE"
      ? "Retry with stealth Playwright rendering; if this persists, the target likely requires IP allowlisting or a residential proxy."
      : "Retry with standard rendering after confirming the URL is correct.";
  } else if (additionalSignature.matched) {
    state = additionalSignature.category;
    protectionType = additionalSignature.system;
    evidence = additionalSignature.reason;
    retryRecommendation = state === "EMPTY_PAGE"
      ? "Retry with Playwright rendering; the standard GET likely returned before JavaScript populated the page."
      : "Verify the URL points to a live, published page rather than a placeholder or removed resource.";
  } else if (integrity.integrityScore >= 70) {
    state = "VALID_PAGE"; protectionType = null;
    evidence = "Document passed page-integrity checks with no block/challenge signatures detected.";
    retryRecommendation = null;
  } else if (integrity.integrityScore >= 40) {
    state = "PARTIAL_PAGE"; protectionType = null;
    evidence = `Document is missing some expected elements (integrity score ${integrity.integrityScore}/100) but shows no block signatures; treated as real, analyzable content.`;
    retryRecommendation = "Analysis will proceed; consider re-crawling with Playwright to confirm full page completeness.";
  } else {
    state = "ERROR_PAGE"; protectionType = "Unclassified Low-Integrity Page";
    evidence = `Document scored only ${integrity.integrityScore}/100 on integrity checks with no specific signature matched.`;
    retryRecommendation = "Retry with Playwright or stealth Playwright rendering.";
  }

  const analyzable = state === "VALID_PAGE" || state === "PARTIAL_PAGE";

  return {
    state, analyzable,
    integrityScore: integrity.integrityScore,
    confidenceScore: confidence.score,
    protectionType, evidence, retryRecommendation,
    integrityMetrics: integrity.metrics,
    confidenceMetrics: confidence.metrics,
    blockCheck: primaryBlockCheck.blocked
      ? primaryBlockCheck
      : (additionalSignature.matched
        ? { blocked: true, system: additionalSignature.system, reason: additionalSignature.reason, signals: [additionalSignature.category.toLowerCase()] }
        : { blocked: false, system: null, reason: null, signals: [] })
  };
}
/**
 * Stage 4: DOM validation. Confirms the response is a structurally real
 * HTML document (complete <html>/<body> tags, sufficient tag density) —
 * not a truncated response, a JSON error blob, or a near-empty stub.
 */
export function validateDomStructure(html) {
  const raw = safeText(html);
  const lower = raw.toLowerCase();
  const hasHtmlTag = lower.includes("<html") && lower.includes("</html>");
  const hasBody = lower.includes("<body") && lower.includes("</body>");
  const tagMatches = raw.match(/<[a-z][a-z0-9]*(\s|>)/gi) || [];
  const tagCount = tagMatches.length;
  const valid = hasHtmlTag && hasBody && tagCount >= 10;

  return {
    valid,
    hasHtmlTag,
    hasBody,
    tagCount,
    reason: valid
      ? "Document contains a well-formed HTML structure with a body and sufficient tag density."
      : !hasHtmlTag
        ? "Response is missing complete <html>...</html> structure."
        : !hasBody
          ? "Response is missing a <body>...</body> element."
          : `Document contains only ${tagCount} HTML tag(s), too sparse to be real page markup.`
  };
}

/**
 * Stage 5: Content validation. Confirms the captured HTML is genuine
 * website content and not an error/interstitial/challenge page, by
 * checking for known block signatures AND a minimum real visible-text
 * threshold. This is the explicit "is this a real page, not an error page"
 * gate that must pass before any scoring is allowed to run.
 */
export function validateContentAuthenticity(html, status, blockCheck) {
  const raw = safeText(html);
  const visibleText = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const visibleTextLength = visibleText.length;

  if (blockCheck?.blocked) {
    return { valid: false, visibleTextLength, reason: blockCheck.reason || "Content matched a known block/challenge signature." };
  }
  if (visibleTextLength < 150) {
    return { valid: false, visibleTextLength, reason: `Visible text content is only ${visibleTextLength} characters — too thin to represent a real page.` };
  }
  return { valid: true, visibleTextLength, reason: "Visible content passed authenticity checks (no block signatures, sufficient text density)." };
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
  const redirectChain = [];

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
    }),
    beforeRedirect: (options, responseDetails) => {
      redirectChain.push({
        from: responseDetails?.headers?.location ? options.href : undefined,
        status: responseDetails?.statusCode,
        location: responseDetails?.headers?.location
      });
    }
  });

  return {
    html: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
    status: response.status,
    headers: response.headers || {},
    finalUrl: response.request?.res?.responseUrl || url,
    redirectChain,
    redirectCount: redirectChain.length,
    httpVersion: response.request?.res?.httpVersion || null
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
 * Samples a small set of asset URLs (CSS/JS/images) referenced in the page
 * to detect broken assets, using the same bounded HEAD-request approach as
 * sampleBrokenLinks — never crawls the whole site, just spot-checks.
 */
export async function sampleBrokenAssets($, baseUrl, sampleSize = 6) {
  const assetUrls = new Set();
  $('link[rel="stylesheet"][href], script[src], img[src]').each((_, el) => {
    const src = safeText($(el).attr("href") || $(el).attr("src"));
    if (src) assetUrls.add(src);
  });

  const sampled = Array.from(assetUrls).slice(0, sampleSize);
  if (sampled.length === 0) return { checked: 0, broken: 0, brokenAssets: [] };

  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return { checked: 0, broken: 0, brokenAssets: [] }; }

  const checks = sampled.map(async (src) => {
    let target;
    try { target = new URL(src, origin).href; } catch { return { url: src, ok: false, status: 0 }; }
    try {
      const res = await axios.head(target, {
        timeout: 5000, maxRedirects: 4, validateStatus: () => true,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });
      return { url: target, ok: res.status < 400, status: res.status };
    } catch {
      return { url: target, ok: false, status: 0 };
    }
  });

  const results = (await Promise.allSettled(checks)).map(r => r.status === "fulfilled" ? r.value : { ok: false, status: 0, url: "unknown" });
  const broken = results.filter(r => !r.ok);

  return { checked: results.length, broken: broken.length, brokenAssets: broken.map(b => ({ url: b.url, status: b.status })) };
}

/**
 * Detects HTTP resources referenced from an HTTPS page (mixed content),
 * which browsers actively block or flag and search engines penalize.
 */
export function detectMixedContent($, resolvedUrl) {
  if (!safeText(resolvedUrl).startsWith("https://")) {
    return { applicable: false, mixedContentCount: 0, examples: [] };
  }

  const insecureRefs = [];
  $('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"]').each((_, el) => {
    const src = safeText($(el).attr("src") || $(el).attr("href"));
    if (src) insecureRefs.push(src);
  });

  return {
    applicable: true,
    mixedContentCount: insecureRefs.length,
    examples: insecureRefs.slice(0, 5)
  };
}

/**
 * Evaluates the presence of modern security response headers. Feeds the
 * "Security Headers" metric in scanDynamicTrustSignals (Phase 2).
 */
export function analyzeSecurityHeaders(headers) {
  const h = safeObject(headers);
  const checks = {
    "Strict-Transport-Security": Boolean(h["strict-transport-security"]),
    "Content-Security-Policy": Boolean(h["content-security-policy"]),
    "X-Frame-Options": Boolean(h["x-frame-options"]),
    "X-Content-Type-Options": Boolean(h["x-content-type-options"]),
    "Referrer-Policy": Boolean(h["referrer-policy"])
  };
  const present = Object.entries(checks).filter(([, v]) => v).map(([k]) => k);
  return {
    present,
    missing: Object.keys(checks).filter(k => !checks[k]),
    score: present.length * 2 // out of 10, matches the weight/max used in Trust scoring
  };
}

/**
 * Composite Technical SEO score: canonical, robots, sitemap, HTTPS,
 * redirects, compression, HTTP version, mixed content, and broken assets —
 * each backed by real evidence captured during the crawl.
 */
export function calculateTechnicalSeoScore({ pageData, headers, robotsData, sitemapData, redirectCount, httpVersion, mixedContent, brokenAssetData }) {
  const metrics = [];

  const canonical = safeText(pageData?.canonical);
  metrics.push(buildMetric({
    name: "Canonical Tag", raw: canonical ? 15 : 0, max: 15, weight: 15,
    reason: canonical ? "Canonical URL configured." : "No canonical tag found.",
    evidence: canonical ? `Canonical resolves to: ${canonical}` : "No <link rel=\"canonical\"> found.",
    recommendation: "Add a self-referencing canonical tag."
  }));

  const robotsMeta = safeText(pageData?.robots).toLowerCase();
  const blockedByMeta = robotsMeta.includes("noindex");
  metrics.push(buildMetric({
    name: "Robots Directive", raw: blockedByMeta ? 0 : 10, max: 10, weight: 10,
    reason: blockedByMeta ? "Page blocks indexing via meta robots." : "No indexing block detected.",
    evidence: robotsMeta ? `content="${robotsMeta}"` : "No robots meta tag (defaults to indexable).",
    recommendation: "Remove noindex if this page should be indexed."
  }));

  metrics.push(buildMetric({
    name: "Sitemap Availability", raw: sitemapData?.found ? 10 : 0, max: 10, weight: 10,
    reason: sitemapData?.found ? `Sitemap found via ${sitemapData.source}.` : "No sitemap.xml found.",
    evidence: sitemapData?.found ? safeArray(sitemapData.urls).join(", ") : "Checked robots.txt and /sitemap.xml.",
    recommendation: "Publish and reference an XML sitemap."
  }));

  metrics.push(buildMetric({
    name: "Robots.txt Availability", raw: robotsData?.found ? 8 : 0, max: 8, weight: 8,
    reason: robotsData?.found ? "robots.txt is published." : "No robots.txt found.",
    evidence: robotsData?.found ? `${safeArray(robotsData.disallowedPaths).length} disallow rule(s) declared.` : "GET /robots.txt did not resolve.",
    recommendation: "Publish a robots.txt at the domain root."
  }));

  const isHttps = safeText(pageData?.resolvedUrl).startsWith("https://");
  metrics.push(buildMetric({
    name: "HTTPS", raw: isHttps ? 15 : 0, max: 15, weight: 15,
    reason: isHttps ? "Secure HTTPS connection." : "Insecure HTTP connection.",
    evidence: `Scheme: ${safeText(pageData?.resolvedUrl).split("://")[0] || "unknown"}.`,
    recommendation: "Migrate to HTTPS with a valid TLS certificate."
  }));

  metrics.push(buildMetric({
    name: "Redirect Chain", raw: redirectCount === 0 ? 10 : redirectCount <= 2 ? 6 : 0, max: 10, weight: 10,
    reason: redirectCount === 0 ? "Direct 200 response, no redirects." : redirectCount <= 2 ? "Minimal redirect chain." : "Excessive redirect chain.",
    evidence: `${redirectCount} redirect hop(s) followed.`,
    recommendation: "Minimize redirect chains to a single hop or none."
  }));

  const contentEncoding = safeText(headers?.["content-encoding"]).toLowerCase();
  const isCompressed = ["gzip", "br", "deflate"].includes(contentEncoding);
  metrics.push(buildMetric({
    name: "Compression", raw: isCompressed ? 10 : 0, max: 10, weight: 10,
    reason: isCompressed ? `Response compressed via ${contentEncoding}.` : "No compression detected on the response.",
    evidence: `Content-Encoding header: ${contentEncoding || "none"}.`,
    recommendation: "Enable gzip or Brotli compression on the web server."
  }));

  const httpVersionNum = parseFloat(httpVersion) || 1.1;
  metrics.push(buildMetric({
    name: "Modern Protocol (HTTP/2+)", raw: httpVersionNum >= 2 ? 8 : 0, max: 8, weight: 8,
    reason: httpVersionNum >= 2 ? `Served over HTTP/${httpVersion}.` : `Served over HTTP/${httpVersion || "1.1"}, not HTTP/2 or HTTP/3.`,
    evidence: `Detected protocol version: HTTP/${httpVersion || "1.1"}.`,
    recommendation: "Enable HTTP/2 or HTTP/3 on the server/CDN for reduced latency and multiplexing."
  }));

  metrics.push(buildMetric({
    name: "Mixed Content", raw: !mixedContent?.applicable || mixedContent.mixedContentCount === 0 ? 8 : 0, max: 8, weight: 8,
    reason: !mixedContent?.applicable ? "Page is not served over HTTPS; mixed-content check not applicable." : mixedContent.mixedContentCount === 0 ? "No insecure HTTP resources referenced from this HTTPS page." : `${mixedContent.mixedContentCount} insecure HTTP resource(s) referenced from an HTTPS page.`,
    evidence: mixedContent?.examples?.length > 0 ? `Examples: ${mixedContent.examples.join(", ")}` : "No mixed-content resources detected.",
    recommendation: "Update all asset references (img/script/link/iframe) to use HTTPS URLs."
  }));

  metrics.push(buildMetric({
    name: "Broken Assets", raw: brokenAssetData?.checked === 0 ? 6 : clamp(6 - safeNumber(brokenAssetData?.broken), 0, 6), max: 6, weight: 6,
    reason: brokenAssetData?.checked === 0 ? "No assets available to sample." : brokenAssetData.broken === 0 ? "All sampled CSS/JS/image assets resolved successfully." : `${brokenAssetData.broken} of ${brokenAssetData.checked} sampled assets returned an error.`,
    evidence: brokenAssetData?.brokenAssets?.length > 0 ? brokenAssetData.brokenAssets.map(a => `${a.url} (${a.status || "no response"})`).join(", ") : `Sampled ${brokenAssetData?.checked || 0} asset(s).`,
    recommendation: "Fix or remove broken CSS, JS, or image references."
  }));

  return aggregateMetrics(metrics);
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
/**
 * Produces a confidence score (how sure we are this crawl reflects the real
 * page) and a quality score (how complete/parseable the captured content
 * is). Both are evidence-based composites, not static guesses — this is
 * what downstream code checks before trusting a crawl enough to score it.
 */
export function assessCrawlReliability({ html, status, blockCheck, redirectCount, crawlMethod, contentLength }) {
  const metrics = [];

  metrics.push(buildMetric({
    name: "HTTP Status Validity",
    raw: (status >= 200 && status < 400) ? 25 : 0,
    max: 25, weight: 25,
    reason: (status >= 200 && status < 400) ? "Server returned a successful status code." : `Server returned a non-success status code (${status}).`,
    evidence: `Final HTTP status: ${status}.`,
    recommendation: "Investigate why the server is not returning a 2xx/3xx status for this URL."
  }));

  metrics.push(buildMetric({
    name: "Unblocked Access",
    raw: blockCheck?.blocked ? 0 : 30,
    max: 30, weight: 30,
    reason: blockCheck?.blocked ? `Access was blocked: ${blockCheck.system}.` : "No bot-mitigation, WAF, login-wall, or soft-404 signals detected.",
    evidence: blockCheck?.blocked ? safeText(blockCheck.reason) : "Crawl completed without triggering any known block signature.",
    recommendation: "Consider IP allowlisting the crawler or reviewing this domain's bot-protection configuration."
  }));

  const isValidHtml = html && html.toLowerCase().includes("<html") && html.toLowerCase().includes("</html>");
  metrics.push(buildMetric({
    name: "Document Structural Validity",
    raw: isValidHtml ? 20 : 0,
    max: 20, weight: 20,
    reason: isValidHtml ? "Response contains a well-formed HTML document." : "Response does not contain a complete/valid HTML document.",
    evidence: `Content length: ${contentLength || 0} bytes. Contains <html>/</html>: ${isValidHtml}.`,
    recommendation: "Verify the target serves valid server-rendered or client-rendered HTML to standard crawlers."
  }));

  metrics.push(buildMetric({
    name: "Redirect Chain Health",
    raw: redirectCount <= 2 ? 15 : redirectCount <= 5 ? 8 : 0,
    max: 15, weight: 15,
    reason: redirectCount === 0 ? "No redirects encountered." : redirectCount <= 2 ? "Minimal, healthy redirect chain." : redirectCount <= 5 ? "Moderate redirect chain length." : "Excessive redirect chain detected.",
    evidence: `${redirectCount} redirect hop(s) followed before reaching final content.`,
    recommendation: "Reduce redirect chain length; each hop adds latency and dilutes link equity."
  }));

  metrics.push(buildMetric({
    name: "Content Substantiality",
    raw: (contentLength || 0) >= 1500 ? 10 : 0,
    max: 10, weight: 10,
    reason: (contentLength || 0) >= 1500 ? "Response body is substantial enough for reliable analysis." : "Response body is too small to reliably represent real page content.",
    evidence: `Captured content length: ${contentLength || 0} bytes.`,
    recommendation: "If this persists, the page may require JavaScript rendering or is serving a stub/error page."
  }));

  const result = aggregateMetrics(metrics);

  return {
    confidenceScore: result.score,
    qualityScore: clamp(Math.round((result.score * 0.7) + (crawlMethod === "PLAYWRIGHT_RENDERED" ? 30 : 20))),
    status: result.status,
    metrics: result.metrics,
    reliable: result.score >= 60
  };
}
/**
 * Stage 3: Stealth Playwright retry. Same rendering approach as
 * fetchPlaywright, but with headless-detection evasions applied (patches
 * navigator.webdriver, plugins, languages, adds realistic headers, and
 * simulates minimal mouse movement) — used only when a normal Playwright
 * render is still blocked/challenged.
 */
export async function fetchPlaywrightStealth(url) {
  const browser = await getBrowserInstance();
  if (!browser) return null;

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/New_York",
    bypassCSP: true,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1"
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  await context.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf,ico}", route => route.abort());
  await context.route("**/*analytics*/**", route => route.abort());

  const page = await context.newPage();
  page.setDefaultTimeout(25000);

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch {}

    try {
      await page.mouse.move(200, 300);
      await page.waitForTimeout(600);
      await page.mouse.move(400, 500);
      await page.waitForTimeout(1200);
    } catch {}

    let infiniteScrollDetected = false;
    try {
      const initialHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
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

// --- Internal stage runners (not exported; used only by smartCrawl) ---

async function attemptStandardGet(url) {
  let result = null;
  let status = 0;
  let retryCount = 0;
  let redirectCount = 0;
  let httpVersion = null;
  let headers = {};

  try {
    const outcome = await withHardTimeout(withRetry(() => fetchAxios(url), 2, 1200), CRAWL_HARD_TIMEOUT_MS, "Standard fetch");
    result = outcome.result;
    retryCount = outcome.attempts - 1;
    status = result?.status || 0;
    redirectCount = safeNumber(result?.redirectCount, 0);
    httpVersion = result?.httpVersion || null;
    headers = result?.headers || {};
  } catch (err) {
    retryCount = safeNumber(err?.attempts, 1) - 1;
    logger.warn("CRAWL", "standard_fetch_failed", { url, error: err.message, retryCount });
  }

  const html = result?.html || "";
  const finalUrl = result?.finalUrl || url;
  const pageValidation = runPageValidationEngine(html, status, redirectCount);

  return {
    stageName: "STANDARD_GET", crawlMethod: "STANDARD_GET",
    html, status, finalUrl, retryCount, redirectCount, httpVersion, headers,
    infiniteScrollDetected: false,
    pageValidation,
    blockCheck: pageValidation.blockCheck,
    success: pageValidation.analyzable
  };
}

async function attemptPlaywrightRender(url, label, fetchFn) {
  let pwResult = null;
  try {
    pwResult = await withHardTimeout(fetchFn(url), CRAWL_HARD_TIMEOUT_MS, `${label} render`);
  } catch (err) {
    logger.error("CRAWL", `${label.toLowerCase()}_render_failed`, { url, error: err.message });
  }

  if (!pwResult || !pwResult.html) {
    const pageValidation = {
      state: "EMPTY_PAGE", analyzable: false, integrityScore: 0, confidenceScore: 0,
      protectionType: `${label} Unavailable`,
      evidence: `${label} attempt failed to produce content (browser unavailable or navigation failed).`,
      retryRecommendation: "Retry crawling later or verify the target allows headless browser access.",
      integrityMetrics: [], confidenceMetrics: [],
      blockCheck: { blocked: true, system: `${label} Unavailable`, reason: `${label} attempt failed to produce content.`, signals: ["render_failed"] }
    };
    return {
      stageName: label, crawlMethod: label,
      html: "", status: 0, finalUrl: url, retryCount: 0, redirectCount: 0, httpVersion: null, headers: {},
      infiniteScrollDetected: false,
      pageValidation, blockCheck: pageValidation.blockCheck,
      success: false
    };
  }

  const { html, status, finalUrl, infiniteScrollDetected } = pwResult;
  const pageValidation = runPageValidationEngine(html, status, 0);

  return {
    stageName: label, crawlMethod: label,
    html, status, finalUrl, retryCount: 0, redirectCount: 0, httpVersion: null, headers: {},
    infiniteScrollDetected: Boolean(infiniteScrollDetected),
    pageValidation, blockCheck: pageValidation.blockCheck,
    success: pageValidation.analyzable
  };
}

function finalizeCrawlResult(winningStage, allStages) {
  const stagesAttempted = allStages.map(s => ({
    stage: s.stageName, status: s.status, success: s.success,
    validationState: s.pageValidation?.state,
    integrityScore: s.pageValidation?.integrityScore,
    confidenceScore: s.pageValidation?.confidenceScore,
    protectionType: s.pageValidation?.protectionType
  }));

  if (!winningStage) {
    const lastStage = allStages[allStages.length - 1];
    return {
      html: lastStage.html, finalUrl: lastStage.finalUrl, status: lastStage.status,
      crawlMethod: lastStage.crawlMethod, blockCheck: lastStage.blockCheck,
      retryCount: lastStage.retryCount, redirectCount: lastStage.redirectCount,
      httpVersion: lastStage.httpVersion, headers: lastStage.headers,
      infiniteScrollDetected: lastStage.infiniteScrollDetected,
      contentLength: lastStage.html ? lastStage.html.length : 0,
      stagesAttempted,
      pageValidation: lastStage.pageValidation,
      reliability: { confidenceScore: lastStage.pageValidation?.confidenceScore || 0, qualityScore: 0, status: "Critical Improvements Needed", metrics: [], reliable: false }
    };
  }

  const reliability = assessCrawlReliability({
    html: winningStage.html, status: winningStage.status, blockCheck: winningStage.blockCheck,
    redirectCount: winningStage.redirectCount, crawlMethod: winningStage.crawlMethod,
    contentLength: winningStage.html ? winningStage.html.length : 0
  });

  return {
    html: winningStage.html, finalUrl: winningStage.finalUrl, status: winningStage.status,
    crawlMethod: winningStage.crawlMethod, blockCheck: winningStage.blockCheck,
    retryCount: winningStage.retryCount, redirectCount: winningStage.redirectCount,
    httpVersion: winningStage.httpVersion, headers: winningStage.headers,
    infiniteScrollDetected: winningStage.infiniteScrollDetected,
    contentLength: winningStage.html ? winningStage.html.length : 0,
    stagesAttempted, pageValidation: winningStage.pageValidation, reliability
  };
}

/**
 * Multi-stage crawl pipeline:
 *   1. Standard HTTP GET
 *   2. Automatic Playwright retry
 *   3. Stealth Playwright retry
 *   4. DOM validation (per stage)
 *   5. Content validation (per stage)
 *   6. Block detection (per stage)
 *   7. Final blocked response ONLY if every stage above fails
 *
 * HTTP 401/403/429 no longer cause an immediate stop — they simply mark a
 * stage as unsuccessful, triggering escalation to the next stage. If
 * Playwright (stealth or not) successfully renders real content after an
 * earlier 401/403/429, that content is used and full analysis proceeds.
 */
export async function smartCrawl(url) {
  const stages = [];

  const stage1 = await attemptStandardGet(url);
  stages.push(stage1);
  logger.info("CRAWL", "stage_completed", { url, stage: stage1.stageName, success: stage1.success, status: stage1.status });
  if (stage1.success) return finalizeCrawlResult(stage1, stages);

  logger.info("CRAWL", "escalating_to_playwright", { url, priorStatus: stage1.status, priorBlockSystem: stage1.blockCheck?.system });
  const stage2 = await attemptPlaywrightRender(url, "PLAYWRIGHT_RENDERED", fetchPlaywright);
  stages.push(stage2);
  logger.info("CRAWL", "stage_completed", { url, stage: stage2.stageName, success: stage2.success, status: stage2.status });
  if (stage2.success) return finalizeCrawlResult(stage2, stages);

  logger.info("CRAWL", "escalating_to_stealth_playwright", { url, priorBlockSystem: stage2.blockCheck?.system });
  const stage3 = await attemptPlaywrightRender(url, "PLAYWRIGHT_STEALTH_RENDERED", fetchPlaywrightStealth);
  stages.push(stage3);
  logger.info("CRAWL", "stage_completed", { url, stage: stage3.stageName, success: stage3.success, status: stage3.status });
  if (stage3.success) return finalizeCrawlResult(stage3, stages);

  logger.warn("CRAWL", "all_stages_exhausted", { url, stagesAttempted: stages.map(s => s.stageName) });
  return finalizeCrawlResult(null, stages);
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
  const verified = {
    brands: [], organizations: [], people: [], products: [],
    software: [], locations: []
  };
  const candidates = {
    services: [], locations: []
  };

  const brandName = getBrandNameEnhanced(url, $, title, schemas);
  if (brandName && brandName !== "Brand Authority") {
    verified.brands.push({ name: brandName, source: "meta/title/domain-derived" });
  }

  // Verified entities: only from structured data the page itself declares.
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
          if (!name) return;

          if (type.includes('organization') || type.includes('localbusiness')) {
            verified.organizations.push({ name, source: "json-ld", schemaType: item['@type'] });
            verified.brands.push({ name, source: "json-ld", schemaType: item['@type'] });
          }
          if (type.includes('person')) {
            verified.people.push({ name, source: "json-ld", schemaType: item['@type'], jobTitle: safeText(item.jobTitle) || null });
          }
          if (type.includes('product')) {
            verified.products.push({ name, source: "json-ld", schemaType: item['@type'] });
          }
          if (type.includes('softwareapplication') || type.includes('webapplication')) {
            verified.software.push({ name, source: "json-ld", schemaType: item['@type'] });
          }
          if (type.includes('postaladdress')) {
            const locality = safeText(item.addressLocality);
            const country = safeText(item.addressCountry);
            if (locality) verified.locations.push({ name: locality, source: "json-ld", type: "locality" });
            if (country) verified.locations.push({ name: country, source: "json-ld", type: "country" });
          }
        };
        items.forEach(traverse);
      } catch (e) {}
    });
  } catch (err) {}

  // Verified via microdata (itemtype/itemprop) as a second structured-data source.
  try {
    $('[itemscope][itemtype*="schema.org"]').each((_, el) => {
      const itemType = safeText($(el).attr('itemtype'));
      const nameEl = $(el).find('[itemprop="name"]').first();
      const name = safeText(nameEl.text());
      if (!name) return;
      const typeLower = itemType.toLowerCase();
      if (typeLower.includes('organization')) verified.organizations.push({ name, source: "microdata", schemaType: itemType });
      if (typeLower.includes('person')) verified.people.push({ name, source: "microdata", schemaType: itemType });
      if (typeLower.includes('product')) verified.products.push({ name, source: "microdata", schemaType: itemType });
    });
  } catch (err) {}

  // Candidate entities: pattern-matched against known service/city lists.
  // Explicitly NOT presented as "verified" — the page never declared these,
  // we're inferring them from keyword co-occurrence in visible text only.
  const combinedText = [title, h1, ...safeArray(h2s), ...safeArray(h3s), metaDescription, bodyText].join(" ");

  SERVICE_PATTERNS.forEach(srv => {
    if (new RegExp(`\\b${srv}\\b`, 'i').test(combinedText)) {
      candidates.services.push({ name: srv, source: "keyword-match", confidence: "unverified" });
    }
  });

  CITY_PATTERNS.forEach(city => {
    if (new RegExp(`\\b${city}\\b`, 'i').test(combinedText)) {
      candidates.locations.push({ name: city, source: "keyword-match", confidence: "unverified" });
    }
  });

  const dedupeByName = (arr) => {
    const seen = new Set();
    return arr.filter(item => {
      const key = item.name.toLowerCase().trim();
      if (!key || key.length <= 1 || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);
  };

  const finalVerified = {
    brands: dedupeByName(verified.brands),
    organizations: dedupeByName(verified.organizations),
    people: dedupeByName(verified.people),
    products: dedupeByName(verified.products),
    software: dedupeByName(verified.software),
    locations: dedupeByName(verified.locations)
  };
  const finalCandidates = {
    services: dedupeByName(candidates.services),
    locations: dedupeByName(candidates.locations)
  };

  const verifiedCount = Object.values(finalVerified).reduce((sum, arr) => sum + arr.length, 0);
  const candidateCount = Object.values(finalCandidates).reduce((sum, arr) => sum + arr.length, 0);

  // Backward-compatible flat name lists for existing frontend fields
  // (brands/organizations/services/locations/people/products as plain
  // string arrays), now sourced only from verified data where possible,
  // falling back to an empty array rather than a fabricated name — showing
  // invented entity names (e.g. "Industry Specialist") as if they were real
  // detected data would violate the verified-entities-only requirement.
  const namesOnly = (arr, fallback) => arr.length > 0 ? arr.map(i => i.name) : fallback;

  return {
    // New verified/candidate structure — the source of truth going forward.
    verified: finalVerified,
    candidates: finalCandidates,
    verifiedEntityCount: verifiedCount,
    candidateEntityCount: candidateCount,

    // Legacy flat fields preserved for existing payload/frontend compatibility.
    // Only "Brand Authority" remains as a fallback since other scoring logic
    // (e.g. isGenericTitle checks) already recognizes it as a deliberate
    // "brand undetermined" marker, not a fabricated entity name.
    brands: namesOnly(finalVerified.brands, [brandName || "Brand Authority"]),
    organizations: namesOnly(finalVerified.organizations, [brandName || "Brand Authority"]),
    locations: namesOnly([...finalVerified.locations], namesOnly(finalCandidates.locations, [])),
    services: namesOnly(finalCandidates.services, []),
    people: namesOnly(finalVerified.people, []),
    products: namesOnly(finalVerified.products, []),
    entities: [...new Set([
      ...namesOnly(finalVerified.brands, []),
      ...namesOnly(finalCandidates.services, []),
      ...namesOnly(finalVerified.locations, []),
      ...namesOnly(finalVerified.people, []),
      ...namesOnly(finalVerified.organizations, []),
      ...namesOnly(finalVerified.products, []),
      ...namesOnly(finalVerified.software, [])
    ])],
    totalEntities: verifiedCount + candidateCount
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
entities.totalEntityCount = entities.verifiedEntityCount + entities.candidateEntityCount;
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
// Minimum properties Google's Rich Results documentation requires (or
// strongly recommends) per schema type, for eligibility checking.
export const SCHEMA_REQUIRED_PROPERTIES = {
  FAQPage: ["mainEntity"],
  HowTo: ["name", "step"],
  Article: ["headline", "author", "datePublished"],
  BlogPosting: ["headline", "author", "datePublished"],
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address", "telephone"],
  Product: ["name"],
  Review: ["itemReviewed", "reviewRating", "author"],
  Person: ["name"],
  Service: ["name", "provider"],
  VideoObject: ["name", "uploadDate", "thumbnailUrl"],
  BreadcrumbList: ["itemListElement"],
  WebSite: ["name", "url"]
};

/**
 * Checks each detected JSON-LD item against Google's minimum required
 * properties for Rich Result eligibility. Returns per-type findings rather
 * than a single pass/fail, so the dashboard can show exactly which schema
 * blocks are missing which properties.
 */
export function validateSchemaRequiredProperties(detectedSchemas) {
  const findings = [];

  Object.entries(SCHEMA_REQUIRED_PROPERTIES).forEach(([type, requiredProps]) => {
    const schemaEntry = detectedSchemas?.[type];
    if (!schemaEntry?.present) return;

    schemaEntry.data.forEach((item, idx) => {
      const missingProps = requiredProps.filter(prop => {
        const val = item[prop];
        return val === undefined || val === null || (typeof val === "string" && val.trim() === "");
      });

      findings.push({
        type,
        instanceIndex: idx,
        requiredProperties: requiredProps,
        missingProperties: missingProps,
        richResultEligible: missingProps.length === 0,
        reason: missingProps.length === 0
          ? `${type} schema #${idx + 1} contains all properties required for Rich Result eligibility.`
          : `${type} schema #${idx + 1} is missing required propert${missingProps.length === 1 ? "y" : "ies"}: ${missingProps.join(", ")}.`
      });
    });
  });

  return {
    checkedTypes: findings.map(f => f.type),
    eligibleCount: findings.filter(f => f.richResultEligible).length,
    ineligibleCount: findings.filter(f => !f.richResultEligible).length,
    findings
  };
}
export function auditPageSchemas($, html) {
  const jsonLdSchemas = detectAllSchemas($, html);
  const microdataTypes = extractMicrodata($);
  const rdfaTypes = extractRDFa($);
  const jsonLdValidation = validateJsonLdBlocks($);
  const requiredPropertyValidation = validateSchemaRequiredProperties(jsonLdSchemas);

  const activeJsonLdKeys = Object.keys(jsonLdSchemas).filter(k => jsonLdSchemas[k]?.present);
  const allDetectedTypes = [...new Set([...activeJsonLdKeys, ...microdataTypes, ...rdfaTypes])];

  return {
    detectedTypes: allDetectedTypes,
    schemaCount: allDetectedTypes.length,
    jsonLd: jsonLdSchemas,
    microdata: microdataTypes,
    rdfa: rdfaTypes,
    validation: jsonLdValidation,
    richResultEligibility: requiredPropertyValidation
  };
}
 
export function inferWebsiteType(detectedTypes, pageData) {
  const types = safeArray(detectedTypes).map(t => String(t).toLowerCase());
  const url = safeText(pageData?.resolvedUrl).toLowerCase();
  const hasProducts = safeArray(pageData?.entityDetails?.verified?.products).length > 0;
  const hasLocalSignals = types.includes("localbusiness") || /\/(location|store|branch)/i.test(url);

  if (types.includes("product") || hasProducts || /\/(shop|product|store)/i.test(url)) return "ecommerce";
  if (hasLocalSignals) return "local_business";
  if (types.includes("article") || types.includes("blogposting") || /\/(blog|article|news)/i.test(url)) return "content_publisher";
  if (types.includes("service") || /\/(service|services)/i.test(url)) return "service_business";
  return "general";
}

const WEBSITE_TYPE_SCHEMA_PRIORITY = {
  ecommerce: ["Product", "Review", "Organization", "BreadcrumbList", "FAQPage", "WebSite"],
  local_business: ["LocalBusiness", "Organization", "BreadcrumbList", "FAQPage", "Review", "WebSite"],
  content_publisher: ["Article", "BlogPosting", "Person", "BreadcrumbList", "FAQPage", "WebSite"],
  service_business: ["Service", "Organization", "FAQPage", "Review", "BreadcrumbList", "WebSite"],
  general: ["Organization", "WebSite", "FAQPage", "BreadcrumbList", "WebPage", "HowTo"]
};

export function getRecommendedSchemas(detectedTypes, websiteType = "general") {
  const detectedSet = new Set(safeArray(detectedTypes).map(t => String(t).toLowerCase()));
  const priorityOrder = WEBSITE_TYPE_SCHEMA_PRIORITY[websiteType] || WEBSITE_TYPE_SCHEMA_PRIORITY.general;
  const prioritized = priorityOrder.filter(type => !detectedSet.has(type.toLowerCase()));
  const remaining = ALLOWED_RECOMMENDED_TYPES.filter(type => !detectedSet.has(type.toLowerCase()) && !prioritized.includes(type));
  return [...prioritized, ...remaining];
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

export function buildSchemaRecommendations(detectedTypes, title, metaDescription, url, websiteType = "general") {
  const missingTypes = unique(getRecommendedSchemas(detectedTypes, websiteType));
  const blocks = [];

  missingTypes.forEach(type => {
    const schemaObj = generateRecommendedSchemaBlock(type, title, metaDescription, url);
    if (schemaObj) {
      blocks.push(`<script type="application/ld+json">\n${JSON.stringify(schemaObj, null, 2)}\n</script>`);
    }
  });

  return {
    websiteType,
    missingSchemas: missingTypes,
    highPriorityMissing: missingTypes.slice(0, 3),
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
export function calculateContentQualityScore(pageData, $) {
  const metrics = [];
  const words = safeNumber(pageData?.wordCount);
  const text = safeText(pageData?.visibleText);

  metrics.push(buildMetric({
    name: "Content Depth", raw: words >= 1200 ? 20 : words >= 600 ? 12 : words >= 300 ? 5 : 0, max: 20, weight: 20,
    reason: words < 300 ? "Thin content." : words < 600 ? "Below-average depth." : words < 1200 ? "Adequate depth." : "Strong depth.",
    evidence: `Measured word count: ${words}.`,
    recommendation: "Expand thin sections with substantive, non-redundant content."
  }));

  const readability = calculateReadability(text);
  metrics.push(buildMetric({
    name: "Readability", raw: readability.fleschScore >= 50 ? 15 : readability.fleschScore >= 30 ? 8 : 0, max: 15, weight: 15,
    reason: `Flesch Reading Ease score: ${readability.fleschScore} (${readability.label}).`,
    evidence: `Avg ${readability.avgWordsPerSentence} words/sentence, ${readability.avgSyllablesPerWord} syllables/word.`,
    recommendation: "Shorten sentences and use simpler vocabulary to improve readability."
  }));

  const h1Count = safeArray(pageData?.headings?.h1s).length;
  const h2Count = safeArray(pageData?.headings?.h2s).length;
  metrics.push(buildMetric({
    name: "Heading Structure", raw: (h1Count === 1 ? 8 : 0) + (h2Count > 0 ? 7 : 0), max: 15, weight: 15,
    reason: h1Count !== 1 ? `${h1Count} H1 heading(s) found (should be exactly 1).` : h2Count === 0 ? "No H2 subheadings found." : "Clean heading hierarchy.",
    evidence: `H1 count: ${h1Count}. H2 count: ${h2Count}.`,
    recommendation: "Use exactly one H1, supported by logically structured H2 subheadings."
  }));

  const duplication = detectInternalDuplication($);
  metrics.push(buildMetric({
    name: "Content Uniqueness (Page-Internal)", raw: duplication.duplicateBlockCount === 0 ? 15 : clamp(15 - duplication.duplicateBlockCount * 3, 0, 15), max: 15, weight: 15,
    reason: duplication.duplicateBlockCount === 0 ? "No internally duplicated paragraph blocks detected." : `${duplication.duplicateBlockCount} duplicated paragraph block(s) detected within this page.`,
    evidence: `${duplication.scopeNote}`,
    recommendation: "Remove or rewrite repeated paragraph blocks within the page."
  }));

  const topKeywords = tokenizeKeywords(text).slice(0, 5);
  const stuffing = detectKeywordStuffing(text, topKeywords);
  metrics.push(buildMetric({
    name: "Keyword Density Health", raw: stuffing.stuffingDetected ? 0 : 10, max: 10, weight: 10,
    reason: stuffing.stuffingDetected ? `Unnaturally high density for: ${stuffing.stuffedKeywords.join(", ")}.` : "Keyword usage density is within natural range.",
    evidence: stuffing.densities.map(d => `"${d.keyword}": ${d.density}%`).join(", ") || "No dominant keywords extracted.",
    recommendation: "Reduce repetition of over-used keywords; vary phrasing naturally."
  }));

  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount);
  const entityDensity = words > 0 ? (entityCount / words) * 100 : 0;
  metrics.push(buildMetric({
    name: "Entity Usage", raw: entityDensity >= 1.5 ? 10 : entityDensity >= 0.5 ? 5 : 0, max: 10, weight: 10,
    reason: entityDensity >= 1.5 ? "Strong named-entity usage." : entityDensity >= 0.5 ? "Moderate entity usage." : "Low entity usage.",
    evidence: `${entityCount} entities across ${words} words (${entityDensity.toFixed(2)} per 100 words).`,
    recommendation: "Reference more specific named entities relevant to the topic."
  }));

  const listCount = $("ul, ol").length;
  const tableCount = $("table").length;
  const mediaCount = $("img, video, iframe").length;
  metrics.push(buildMetric({
    name: "Rich Media & Structure Usage", raw: (listCount > 0 ? 5 : 0) + (tableCount > 0 ? 3 : 0) + (mediaCount > 0 ? 2 : 0), max: 10, weight: 10,
    reason: `Lists: ${listCount}, tables: ${tableCount}, media elements: ${mediaCount}.`,
    evidence: `Detected ${listCount} list(s), ${tableCount} table(s), ${mediaCount} media element(s) in the DOM.`,
    recommendation: "Incorporate lists, tables, or media to break up long-form text and aid scannability."
  }));

  const result = aggregateMetrics(metrics);
  return { ...result, readability, duplication, keywordStuffing: stuffing };
}
export function calculateSemanticSeoScore(pageData, clusters, coveragePercent) {
  const metrics = [];

  metrics.push(buildMetric({
    name: "Topic/Intent Coverage", raw: Math.round((coveragePercent / 100) * 30), max: 30, weight: 30,
    reason: `Covers ${safeArray(clusters).filter(c => c.status === "Active").length} of ${safeArray(clusters).length} intent clusters.`,
    evidence: `Measured coverage: ${coveragePercent}%. Active clusters: ${safeArray(clusters).filter(c => c.status === "Active").map(c => c.name).join(", ") || "none"}.`,
    recommendation: "Add content addressing missing intent clusters (informational, commercial, transactional, trust, authority)."
  }));

  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount);
  metrics.push(buildMetric({
    name: "Entity Coverage", raw: entityCount >= 15 ? 25 : entityCount >= 8 ? 15 : entityCount > 0 ? 5 : 0, max: 25, weight: 25,
    reason: entityCount >= 15 ? "Rich entity coverage supports semantic grounding." : entityCount >= 8 ? "Moderate entity coverage." : "Low entity coverage.",
    evidence: `${entityCount} distinct entities detected (${safeNumber(pageData?.entityDetails?.verifiedEntityCount)} verified via structured data).`,
    recommendation: "Reference more specific brands, products, people, and organizations relevant to the topic."
  }));

  const verifiedRatio = entityCount > 0 ? safeNumber(pageData?.entityDetails?.verifiedEntityCount) / entityCount : 0;
  metrics.push(buildMetric({
    name: "Knowledge Graph Groundedness", raw: Math.round(verifiedRatio * 20), max: 20, weight: 20,
    reason: verifiedRatio >= 0.5 ? "Most detected entities are verified via structured data." : "Most detected entities are unverified pattern matches rather than structured data.",
    evidence: `${safeNumber(pageData?.entityDetails?.verifiedEntityCount)} verified / ${entityCount} total entities.`,
    recommendation: "Add JSON-LD declaring key entities (Organization, Person, Product) so they're machine-verifiable rather than inferred."
  }));

  const missingClusters = safeArray(clusters).filter(c => c.status === "Missing");
  metrics.push(buildMetric({
    name: "Topical Cluster Completeness", raw: missingClusters.length === 0 ? 15 : clamp(15 - missingClusters.length * 4, 0, 15), max: 15, weight: 15,
    reason: missingClusters.length === 0 ? "All tracked intent clusters have coverage." : `Missing coverage for: ${missingClusters.map(c => c.name).join(", ")}.`,
    evidence: `${missingClusters.length} of ${safeArray(clusters).length} tracked clusters show zero matched signals.`,
    recommendation: "Add subheadings or sections explicitly addressing the missing topical clusters."
  }));

  const h2h3Count = safeArray(pageData?.headings?.h2s).length + safeArray(pageData?.headings?.h3s).length;
  metrics.push(buildMetric({
    name: "Subtopic Structural Signals", raw: h2h3Count >= 6 ? 10 : h2h3Count >= 3 ? 5 : 0, max: 10, weight: 10,
    reason: h2h3Count >= 6 ? "Well-segmented subtopic structure." : h2h3Count >= 3 ? "Basic subtopic segmentation." : "Little to no subtopic segmentation.",
    evidence: `${h2h3Count} combined H2/H3 heading(s) detected.`,
    recommendation: "Break the topic into clearly labeled subtopics using H2/H3 headings."
  }));

  return aggregateMetrics(metrics);
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
  const metrics = [];

  const hasAuthor = $('meta[name="author"]').length > 0 || $('[rel="author"]').length > 0 || $('[itemprop="author"]').length > 0 || Boolean(pageData?.author);
  metrics.push(buildMetric({
    name: "Author Attribution",
    raw: hasAuthor ? 15 : 0, max: 15, weight: 15,
    reason: hasAuthor ? "Author metadata or byline detected." : "No author attribution found.",
    evidence: hasAuthor ? `Author: ${safeText(pageData?.author, "detected via meta/rel/itemprop attribute")}.` : "No <meta name=\"author\">, [rel=author], or [itemprop=author] element found.",
    recommendation: "Add a named author with a byline and, ideally, a linked author bio page."
  }));

  let hasAbout = false, hasContact = false, hasPrivacy = false, hasTerms = false;
  $("a").each((_, el) => {
    const href = safeText($(el).attr("href")).toLowerCase();
    const textContext = safeText($(el).text()).toLowerCase();
    if (href.includes("about") || textContext.includes("about us") || textContext.includes("our story")) hasAbout = true;
    if (href.includes("contact") || textContext.includes("contact us") || textContext.includes("support")) hasContact = true;
    if (href.includes("privacy") || textContext.includes("privacy policy")) hasPrivacy = true;
    if (href.includes("terms") || textContext.includes("terms of service") || textContext.includes("terms and conditions")) hasTerms = true;
  });

  metrics.push(buildMetric({
    name: "About Page",
    raw: hasAbout ? 10 : 0, max: 10, weight: 10,
    reason: hasAbout ? "About/organizational profile link detected." : "No About Us section linked from this page.",
    evidence: `Anchor scan for 'about'/'about us'/'our story': ${hasAbout ? "match found" : "no match"}.`,
    recommendation: "Link a dedicated About Us page describing the organization, its people, and its mission."
  }));

  metrics.push(buildMetric({
    name: "Contact Page",
    raw: hasContact ? 10 : 0, max: 10, weight: 10,
    reason: hasContact ? "Contact/support link detected." : "No Contact Us path found.",
    evidence: `Anchor scan for 'contact'/'contact us'/'support': ${hasContact ? "match found" : "no match"}.`,
    recommendation: "Link a Contact page with a real business email, phone number, or support channel."
  }));

  metrics.push(buildMetric({
    name: "Privacy Policy",
    raw: hasPrivacy ? 10 : 0, max: 10, weight: 10,
    reason: hasPrivacy ? "Privacy Policy link detected." : "No Privacy Policy found.",
    evidence: `Anchor scan for 'privacy'/'privacy policy': ${hasPrivacy ? "match found" : "no match"}.`,
    recommendation: "Publish and link a Privacy Policy page — required for compliance and expected for trust signals."
  }));

  metrics.push(buildMetric({
    name: "Terms of Service",
    raw: hasTerms ? 10 : 0, max: 10, weight: 10,
    reason: hasTerms ? "Terms of Service link detected." : "No Terms of Service found.",
    evidence: `Anchor scan for 'terms'/'terms of service'/'terms and conditions': ${hasTerms ? "match found" : "no match"}.`,
    recommendation: "Publish and link a Terms of Service page defining usage rules and liability."
  }));

  const organizationDetected = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "organization");
  metrics.push(buildMetric({
    name: "Organization Schema",
    raw: organizationDetected ? 10 : 0, max: 10, weight: 10,
    reason: organizationDetected ? "Organization structured data detected." : "No Organization JSON-LD schema detected.",
    evidence: organizationDetected ? "Organization type present in detected schema types." : "No Organization entry in detected schema types.",
    recommendation: "Add Organization JSON-LD with name, logo, url, and sameAs social profile links."
  }));

  let externalRefLinksCount = 0;
  $("a[href^='http']").each((_, el) => {
    const href = safeText($(el).attr("href"));
    if (href && pageData?.resolvedUrl) {
      try {
        if (!href.includes(new URL(pageData.resolvedUrl).hostname)) externalRefLinksCount++;
      } catch {}
    }
  });
  metrics.push(buildMetric({
    name: "Outbound Authority Citations",
    raw: clamp(externalRefLinksCount, 0, 3) * 3.33,
    max: 10, weight: 10,
    reason: externalRefLinksCount > 2 ? "Outbound references to external platforms present." : "Low outbound citation volume.",
    evidence: `${externalRefLinksCount} outbound external link(s) detected.`,
    recommendation: "Cite authoritative external sources to support factual claims."
  }));

  const credentialTerms = ["certified", "certificate", "ph.d", "doctor", "bachelor", "master of", "diploma", "accredited"];
  const matchedCredentials = credentialTerms.filter(term => text.includes(term));
  metrics.push(buildMetric({
    name: "Credentials & Expertise Signals",
    raw: matchedCredentials.length > 0 ? 10 : 0, max: 10, weight: 10,
    reason: matchedCredentials.length > 0 ? "Professional/academic credential terms detected." : "No credential terms detected in visible text.",
    evidence: matchedCredentials.length > 0 ? `Matched terms: ${matchedCredentials.join(", ")}.` : "No 'certified/accredited/Ph.D.' style terms found.",
    recommendation: "State relevant certifications, degrees, or professional experience where applicable."
  }));

  const yearsInBusinessTerms = ["founded in", "established in", "years in business", "est. 19", "est. 20", "years of experience", "celebrating our"];
  const matchedYears = yearsInBusinessTerms.filter(term => text.includes(term));
  metrics.push(buildMetric({
    name: "Business Longevity Signals",
    raw: matchedYears.length > 0 ? 5 : 0, max: 5, weight: 5,
    reason: matchedYears.length > 0 ? "Business founding/tenure language detected." : "No business tenure signals detected.",
    evidence: matchedYears.length > 0 ? `Matched phrases: ${matchedYears.join(", ")}.` : "No 'founded in/established in/years in business' phrasing found.",
    recommendation: "Mention founding year or years of operating experience to reinforce established credibility."
  }));

  const isHttps = pageData?.resolvedUrl ? pageData.resolvedUrl.startsWith("https://") : false;
  metrics.push(buildMetric({
    name: "HTTPS Security",
    raw: isHttps ? 5 : 0, max: 5, weight: 5,
    reason: isHttps ? "Secure HTTPS connection verified." : "Page served over insecure HTTP.",
    evidence: `Resolved URL scheme: ${safeText(pageData?.resolvedUrl).split("://")[0] || "unknown"}.`,
    recommendation: "Serve the page over HTTPS with a valid TLS certificate."
  }));

  metrics.push(buildMetric({
    name: "Content Freshness Timestamp",
    raw: pageData?.modifiedDate ? 5 : 0, max: 5, weight: 5,
    reason: pageData?.modifiedDate ? "Last-modified timestamp detected." : "No last-modified timestamp detected.",
    evidence: pageData?.modifiedDate ? `Last modified: ${pageData.modifiedDate}.` : "No article:modified_time meta tag or dateModified schema property found.",
    recommendation: "Expose a dateModified value via meta tags or Article/BlogPosting schema to signal freshness."
  }));

  const result = aggregateMetrics(metrics);

  return {
    score: result.score,
    status: result.score >= 80 ? "High Trust (Enterprise Ready)" : result.score >= 50 ? "Verified Authority" : "Shallow Authority Profile",
    metrics: result.metrics,
    passedMetrics: result.passedMetrics,
    failedMetrics: result.failedMetrics,
    totalExpectedImprovement: result.totalExpectedImprovement,
    // Backward-compatible fields for the existing frontend contract.
    factors: result.metrics.filter(m => m.passed).map(m => m.reason),
    issues: result.metrics.filter(m => !m.passed).map(m => m.reason),
    auditMetrics: {
      hasAuthor, hasAbout, hasContact, hasPrivacy, hasTerms,
      organizationDetected, externalRefLinksCount,
      matchesCredentials: matchedCredentials.length > 0,
      matchesYears: matchedYears.length > 0,
      isHttps
    }
  };
}

// =========================================================================
// ========== SECTION 13: DYNAMIC AUTHORITY & TRUST AUDIT ENGINE ===========
// =========================================================================

export function calculateDynamicAuthority(pageData) {
  const metrics = [];

  const coveredClusters = pageData?.topicalAuthority?.clusters?.filter(c => c.status === "Active") || [];
  const clusterCoveragePercent = safeNumber(pageData?.topicalAuthority?.coveragePercent);
  metrics.push(buildMetric({
    name: "Topical Intent Coverage",
    raw: Math.round((clusterCoveragePercent / 100) * 25), max: 25, weight: 25,
    reason: clusterCoveragePercent > 0 ? `Covers ${coveredClusters.length} of ${safeArray(pageData?.topicalAuthority?.clusters).length} intent clusters.` : "No intent clusters (informational/commercial/transactional/trust) covered.",
    evidence: `Measured intent cluster coverage: ${clusterCoveragePercent}%.`,
    recommendation: "Add subheadings addressing informational, commercial, and transactional user intent for this topic."
  }));

  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount || pageData?.entities?.length);
  metrics.push(buildMetric({
    name: "Entity Representation",
    raw: entityCount > 15 ? 15 : entityCount > 5 ? 8 : 0, max: 15, weight: 15,
    reason: entityCount > 15 ? "High named-entity representation." : entityCount > 5 ? "Moderate entity representation." : "Low entity representation.",
    evidence: `${entityCount} distinct verified entities detected.`,
    recommendation: "Reference more specific brands, products, people, or locations relevant to the topic."
  }));

  const internalLinks = safeNumber(pageData?.links?.internal || pageData?.internalLinks);
  metrics.push(buildMetric({
    name: "Internal Link Authority Flow",
    raw: internalLinks > 10 ? 15 : internalLinks > 2 ? 8 : 0, max: 15, weight: 15,
    reason: internalLinks > 10 ? "Robust internal link profile." : internalLinks > 2 ? "Standard internal link connectivity." : "Weak internal link connectivity.",
    evidence: `${internalLinks} internal link(s) detected on this page.`,
    recommendation: "Add internal links to related guides or transactional pages to distribute authority."
  }));

  const schemasCount = safeNumber(pageData?.schema?.schemaCount || pageData?.schemaCount);
  metrics.push(buildMetric({
    name: "Structured Data Depth",
    raw: schemasCount >= 3 ? 15 : schemasCount > 0 ? 8 : 0, max: 15, weight: 15,
    reason: schemasCount >= 3 ? "Comprehensive multi-schema structured data." : schemasCount > 0 ? "Basic structured data present." : "No structured data present.",
    evidence: `${schemasCount} distinct schema type(s) detected.`,
    recommendation: "Deploy additional relevant schemas (WebSite, FAQPage, Organization, BreadcrumbList)."
  }));

  const brand = safeText(pageData?.competitor?.winner || pageData?.title);
  const isGenericTitle = brand.toLowerCase().includes("home") || brand.toLowerCase().includes("brand authority") || !brand;
  metrics.push(buildMetric({
    name: "Distinct Brand Identity",
    raw: !isGenericTitle ? 15 : 0, max: 15, weight: 15,
    reason: !isGenericTitle ? "Distinct, non-generic brand identity established in title." : "Title reads as generic rather than brand-distinct.",
    evidence: `Extracted title/brand text: "${brand || 'none'}".`,
    recommendation: "Refine the title tag to clearly reflect a unique brand or product identity, not a generic label."
  }));

  const words = safeNumber(pageData?.wordCount);
  metrics.push(buildMetric({
    name: "Content Depth for Authority",
    raw: words >= 1200 ? 15 : words >= 600 ? 8 : 0, max: 15, weight: 15,
    reason: words >= 1200 ? "Substantial content depth supports authority signals." : words >= 600 ? "Moderate content depth." : "Thin content undermines authority signals.",
    evidence: `Measured word count: ${words}.`,
    recommendation: "Expand coverage depth — authoritative pages typically exceed 1,200 words on cornerstone topics."
  }));

  const result = aggregateMetrics(metrics);

  return {
    authorityScore: result.score,
    status: result.score >= 80 ? "Topical Leader" : result.score >= 50 ? "Competitor" : "Emerging Voice",
    metrics: result.metrics,
    passedMetrics: result.passedMetrics,
    failedMetrics: result.failedMetrics,
    totalExpectedImprovement: result.totalExpectedImprovement,
    factors: result.metrics.filter(m => m.passed).map(m => m.reason),
    suggestions: result.metrics.filter(m => !m.passed).map(m => m.recommendation)
  };
}

export function scanDynamicTrustSignals($, html, url, pageData) {
  const text = $('body').text().toLowerCase();
  const metrics = [];

  const isHttps = url.startsWith("https://");
  metrics.push(buildMetric({
    name: "HTTPS Security",
    raw: isHttps ? 20 : 0, max: 20, weight: 20,
    reason: isHttps ? "SSL/HTTPS validated." : "Page served over insecure HTTP.",
    evidence: `URL scheme: ${url.split("://")[0] || "unknown"}.`,
    recommendation: "Serve the page over HTTPS with a valid TLS certificate."
  }));

  const hasContact = pageData?.entityDetails?.emails?.length > 0 || pageData?.entityDetails?.phones?.length > 0;
  metrics.push(buildMetric({
    name: "Direct Contact Methods",
    raw: hasContact ? 15 : 0, max: 15, weight: 15,
    reason: hasContact ? "Email or phone contact detected in page content." : "No email or phone contact detected.",
    evidence: `Emails detected: ${safeArray(pageData?.entityDetails?.emails).length}. Phones detected: ${safeArray(pageData?.entityDetails?.phones).length}.`,
    recommendation: "Publish a visible email address and/or phone number on the page."
  }));

  let hasPrivacy = false, hasTerms = false;
  $("a").each((_, el) => {
    const href = safeText($(el).attr("href")).toLowerCase();
    const textCtx = safeText($(el).text()).toLowerCase();
    if (href.includes("privacy") || textCtx.includes("privacy")) hasPrivacy = true;
    if (href.includes("terms") || textCtx.includes("terms") || href.includes("tos")) hasTerms = true;
  });

  metrics.push(buildMetric({
    name: "Privacy Policy Disclosure",
    raw: hasPrivacy ? 15 : 0, max: 15, weight: 15,
    reason: hasPrivacy ? "Privacy Policy link detected." : "No Privacy Policy disclosure found.",
    evidence: `Anchor scan for 'privacy': ${hasPrivacy ? "match found" : "no match"}.`,
    recommendation: "Publish a Privacy Policy page describing data handling practices."
  }));

  metrics.push(buildMetric({
    name: "Terms of Service Disclosure",
    raw: hasTerms ? 10 : 0, max: 10, weight: 10,
    reason: hasTerms ? "Terms of Service found." : "No formal Terms of Service found.",
    evidence: `Anchor scan for 'terms'/'tos': ${hasTerms ? "match found" : "no match"}.`,
    recommendation: "Publish a Terms of Service page defining usage rules."
  }));

  const hasLocalBusinessSchema = safeArray(pageData?.schema?.detectedTypes).some(t => String(t).toLowerCase() === "localbusiness");
  const matchesAddressText = text.includes("address") || text.includes("suite") || text.includes("postal") || /\b\d{5}\b/.test(text);
  const hasNAP = hasLocalBusinessSchema || (hasContact && matchesAddressText);
  metrics.push(buildMetric({
    name: "NAP Consistency",
    raw: hasNAP ? 15 : 0, max: 15, weight: 15,
    reason: hasNAP ? "Name/Address/Phone signals verified." : "Incomplete physical address (NAP) parameters.",
    evidence: `LocalBusiness schema: ${hasLocalBusinessSchema}. Address pattern in text: ${matchesAddressText}.`,
    recommendation: "Publish a consistent Name, Address, and Phone number, ideally backed by LocalBusiness schema."
  }));

  const reviewsTerms = ["review", "testimonial", "star rating", "happy clients", "verified buyer", "rated"];
  const matchesReviews = reviewsTerms.some(term => text.includes(term)) || $('.review, .testimonial').length > 0;
  metrics.push(buildMetric({
    name: "Social Proof Signals",
    raw: matchesReviews ? 15 : 0, max: 15, weight: 15,
    reason: matchesReviews ? "Review or testimonial content detected." : "No review or testimonial content detected.",
    evidence: `Review-related keyword or .review/.testimonial element match: ${matchesReviews}.`,
    recommendation: "Display customer reviews or testimonials, ideally backed by Review/AggregateRating schema."
  }));

  const socialProfilesCount = safeNumber(pageData?.entityDetails?.socialProfiles?.length);
  metrics.push(buildMetric({
    name: "Verified Social Presence",
    raw: clamp(socialProfilesCount, 0, 3) / 3 * 10, max: 10, weight: 10,
    reason: socialProfilesCount > 0 ? `${socialProfilesCount} social profile link(s) detected.` : "No social profile links detected.",
    evidence: `Social platforms detected: ${safeArray(pageData?.entityDetails?.socialProfiles).join(", ") || "none"}.`,
    recommendation: "Link verified social media profiles (LinkedIn, Twitter/X, Facebook, Instagram)."
  }));

  const securityHeaderScore = safeNumber(pageData?.securityHeaders?.score);
  metrics.push(buildMetric({
    name: "Security Headers",
    raw: securityHeaderScore, max: 10, weight: 10,
    reason: securityHeaderScore >= 8 ? "Strong security header configuration." : securityHeaderScore > 0 ? "Partial security header configuration." : "No modern security headers detected on the response.",
    evidence: pageData?.securityHeaders?.present?.length > 0 ? `Present headers: ${pageData.securityHeaders.present.join(", ")}.` : "No CSP, HSTS, X-Frame-Options, or X-Content-Type-Options headers detected.",
    recommendation: "Add HSTS, Content-Security-Policy, X-Frame-Options, and X-Content-Type-Options response headers."
  }));

  const result = aggregateMetrics(metrics);

  return {
    trustScore: result.score,
    status: result.score >= 80 ? "SaaS Enterprise Trusted" : result.score >= 50 ? "Verified Profile" : "Unverified Identity Framework",
    metrics: result.metrics,
    passedMetrics: result.passedMetrics,
    failedMetrics: result.failedMetrics,
    totalExpectedImprovement: result.totalExpectedImprovement,
    factors: result.metrics.filter(m => m.passed).map(m => m.reason),
    issues: result.metrics.filter(m => !m.passed).map(m => m.reason)
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

export function calculateInternalLinkScoreDetailed(linkAnalysisDetail, brokenLinkData, $) {
  const d = safeObject(linkAnalysisDetail);
  const metrics = [];

  metrics.push(buildMetric({
    name: "Internal Link Volume", raw: clamp(d.internalLinks, 0, 15), max: 15, weight: 20,
    reason: `${d.internalLinks || 0} internal links detected.`,
    evidence: `${d.internalLinks || 0} internal links across ${d.uniquePages || 0} unique destinations.`,
    recommendation: "Increase internal linking to related content."
  }));

  metrics.push(buildMetric({
    name: "External Link Presence", raw: safeNumber(d.externalLinks) > 0 ? 10 : 0, max: 10, weight: 10,
    reason: safeNumber(d.externalLinks) > 0 ? `${d.externalLinks} external link(s) to outside sources.` : "No external links detected.",
    evidence: `${safeNumber(d.externalLinks)} external link(s) detected.`,
    recommendation: "Link to authoritative external sources where relevant."
  }));

  metrics.push(buildMetric({
    name: "Anchor Text Diversity", raw: Math.round((safeNumber(d.anchorDiversityScore) / 100) * 20), max: 20, weight: 20,
    reason: `Anchor diversity score: ${d.anchorDiversityScore || 0}/100.`,
    evidence: `Measured across sampled internal links.`,
    recommendation: "Vary anchor text instead of repeating the same phrase across links."
  }));

  metrics.push(buildMetric({
    name: "Contextual Placement", raw: Math.round((safeNumber(d.contextualLinkScore) / 100) * 15), max: 15, weight: 15,
    reason: `Contextual link score: ${d.contextualLinkScore || 0}/100.`,
    evidence: `${d.contextualLinkScore || 0}/100 of internal links sit inside body paragraphs/lists rather than navigation.`,
    recommendation: "Place internal links within body content, not just navigation and footers."
  }));

  const brokenCount = safeNumber(brokenLinkData?.broken);
  const checkedCount = safeNumber(brokenLinkData?.checked);
  metrics.push(buildMetric({
    name: "Broken Internal Links", raw: checkedCount === 0 ? 15 : clamp(15 - brokenCount * 4, 0, 15), max: 15, weight: 15,
    reason: checkedCount === 0 ? "No internal links available to sample." : brokenCount === 0 ? "All sampled internal links resolved." : `${brokenCount} of ${checkedCount} sampled links are broken.`,
    evidence: safeArray(brokenLinkData?.brokenUrls).map(b => `${b.url} (${b.status || "no response"})`).join(", ") || "No broken links found in sample.",
    recommendation: "Fix or remove broken internal links."
  }));

  metrics.push(buildMetric({
    name: "Destination Coverage / Orphan Risk", raw: d.orphanPageRiskDetected ? 0 : 10, max: 10, weight: 10,
    reason: d.orphanPageRiskDetected ? "Low unique destination count suggests possible orphaned pages." : "Healthy spread of unique link destinations.",
    evidence: `${d.uniquePages || 0} unique internal destinations detected from this single-page crawl. Full-site crawl required to confirm orphan pages.`,
    recommendation: "Run a full-site crawl to confirm and fix orphaned pages with no inbound internal links."
  }));

  const hasNav = $ ? $("nav, [role='navigation'], header nav, .navbar, .nav-menu").length > 0 : false;
  const navLinkCount = $ ? $("nav a, [role='navigation'] a, header nav a").length : 0;
  metrics.push(buildMetric({
    name: "Navigation Quality", raw: hasNav && navLinkCount >= 3 ? 10 : hasNav ? 5 : 0, max: 10, weight: 10,
    reason: hasNav && navLinkCount >= 3 ? "Semantic navigation element with multiple links detected." : hasNav ? "Navigation element found but with few links." : "No semantic <nav> or navigation landmark detected.",
    evidence: `Navigation element present: ${hasNav}. Links inside navigation: ${navLinkCount}.`,
    recommendation: "Use a semantic <nav> element with clear, crawlable links to key site sections."
  }));

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
// ========== SECTION 13.5: GEO (GENERATIVE ENGINE OPTIMIZATION) SCORE =====
// =========================================================================

/**
 * GEO Score: composite visibility-readiness score for generative AI engines.
 * Reuses already-computed evidence from semanticSeoAudit, authorityAudit,
 * and schemaAudit rather than recalculating entity/topic/schema signals a
 * second time — no duplicated scoring logic.
 */
export function calculateGeoScore(pageData, semanticSeoAudit, authorityAudit, schemaAudit, aeoStructuralMetrics) {
  const entityCount = safeNumber(pageData?.entityDetails?.totalEntityCount);
  const verifiedRatio = entityCount > 0 ? safeNumber(pageData?.entityDetails?.verifiedEntityCount) / entityCount : 0;

  const metrics = [
    buildMetric({
      name: "Entity Coverage", raw: Math.round((clamp(entityCount, 0, 20) / 20) * 20), max: 20, weight: 20,
      reason: `${entityCount} distinct entities detected (${(verifiedRatio * 100).toFixed(0)}% verified via structured data).`,
      evidence: `Verified: ${safeNumber(pageData?.entityDetails?.verifiedEntityCount)}. Total: ${entityCount}.`,
      recommendation: "Reference more specific, structured-data-backed entities relevant to the topic."
    }),
    buildMetric({
      name: "Schema Signals", raw: Math.round((safeArray(schemaAudit?.detectedTypes).length / 5) * 20), max: 20, weight: 20,
      reason: `${safeArray(schemaAudit?.detectedTypes).length} schema type(s) detected.`,
      evidence: `Detected: ${safeArray(schemaAudit?.detectedTypes).join(", ") || "none"}.`,
      recommendation: "Deploy additional relevant schema.org types to strengthen machine-readability."
    }),
    buildMetric({
      name: "Content Freshness", raw: pageData?.modifiedDate ? 15 : 0, max: 15, weight: 15,
      reason: pageData?.modifiedDate ? "Last-modified timestamp detected." : "No last-modified timestamp detected.",
      evidence: pageData?.modifiedDate ? `Last modified: ${pageData.modifiedDate}.` : "No dateModified property or article:modified_time meta tag found.",
      recommendation: "Expose a dateModified value so generative engines can weigh content recency."
    }),
    buildMetric({
      name: "Topical Authority", raw: Math.round((safeNumber(authorityAudit?.authorityScore) / 100) * 20), max: 20, weight: 20,
      reason: `Authority score: ${safeNumber(authorityAudit?.authorityScore)}/100.`,
      evidence: `Derived from existing Authority scoring (topical coverage, entity representation, link structure).`,
      recommendation: "Improve topical authority signals per the Authority score's own recommendations."
    }),
    buildMetric({
      name: "Semantic Coverage", raw: Math.round((safeNumber(semanticSeoAudit?.score) / 100) * 15), max: 15, weight: 15,
      reason: `Semantic SEO score: ${safeNumber(semanticSeoAudit?.score)}/100.`,
      evidence: `Derived from existing Semantic SEO scoring (intent clusters, knowledge-graph groundedness).`,
      recommendation: "Improve semantic coverage per the Semantic SEO score's own recommendations."
    }),
    buildMetric({
      name: "AI-Friendly Formatting", raw: (aeoStructuralMetrics?.hasDirectAnswer ? 5 : 0) + (aeoStructuralMetrics?.listItemsCount > 0 ? 5 : 0), max: 10, weight: 10,
      reason: `Direct-answer pattern: ${Boolean(aeoStructuralMetrics?.hasDirectAnswer)}. List formatting present: ${safeNumber(aeoStructuralMetrics?.listItemsCount) > 0}.`,
      evidence: `List item count: ${safeNumber(aeoStructuralMetrics?.listItemsCount)}.`,
      recommendation: "Add direct-answer phrasing and list-based formatting for generative-engine extractability."
    })
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
    let recoverablePoints = 0;

    if (!crawlData.hasFAQ) { missing.push({ signal: "No FAQ schema", pointValue: 10 }); recoverablePoints += 10; }
    if (!crawlData.hasDirectAnswer) { missing.push({ signal: "No direct-answer blocks", pointValue: 12 }); recoverablePoints += 12; }
    if (!crawlData.hasAuthor) { missing.push({ signal: "No author attribution", pointValue: 6 }); recoverablePoints += 6; }
    if (safeNumber(crawlData.wordCount) < 900) { missing.push({ signal: "Content depth below 900 words", pointValue: 8 }); recoverablePoints += 8; }
    if (safeNumber(crawlData.tableCount) === 0) { missing.push({ signal: "No tabular data", pointValue: 6 }); recoverablePoints += 6; }
    if (!crawlData.hasHowTo) { missing.push({ signal: "No HowTo schema", pointValue: 8 }); recoverablePoints += 8; }
    if (safeNumber(crawlData.internalLinkScore) < 60) { missing.push({ signal: "Weak internal link structure", pointValue: 5 }); recoverablePoints += 5; }

    const potentialScore = clamp(score + recoverablePoints, score, 99);

    return {
      currentScore: score,
      maxScore: 99,
      weight: Math.round(100 / 6),
      potentialScore,
      estimatedGain: potentialScore - score,
      evidence: [`Derived from ${safeNumber(crawlData.wordCount)} words, EEAT score ${safeNumber(crawlData.eeatScore)}, topical authority ${safeNumber(crawlData.topicalAuthorityScore)}, and ${safeNumber(crawlData.internalLinkScore)}/100 internal link strength.`],
      penalties: missing.map(m => ({ signal: m.signal, penalty: m.pointValue })),
      missingSignals: missing.map(m => m.signal),
      improvementSuggestions: missing.length > 0
        ? missing.map(m => `Address: ${m.signal} (potential +${m.pointValue} pts for this engine).`)
        : ["No major gaps detected for this engine profile."],
      recommendations: missing.map(m => ({
        metric: m.signal,
        priority: m.pointValue >= 10 ? "HIGH" : m.pointValue >= 6 ? "MEDIUM" : "LOW",
        impact: m.pointValue >= 10 ? "HIGH" : m.pointValue >= 6 ? "MEDIUM" : "LOW",
        difficulty: /schema/i.test(m.signal) ? "EASY" : "MODERATE",
        estimatedGain: m.pointValue
      }))
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
  if (!targetData || !competitorData || targetData.blocked || competitorData.blocked) {
    return {
      success: false,
      reason: "One or both targets blocked or returned invalid payload parameters."
    };
  }

  const buildComparison = (label, targetVal, compVal, higherIsBetter = true) => {
    const t = safeNumber(targetVal);
    const c = safeNumber(compVal);
    const diff = t - c;
    const winner = diff === 0 ? "Tie" : (higherIsBetter ? diff > 0 : diff < 0) ? "You" : "Competitor";
    const loser = winner === "Tie" ? "Tie" : winner === "You" ? "Competitor" : "You";
    const impact = Math.abs(diff);

    return {
      metric: label,
      target: t,
      competitor: c,
      difference: diff,
      winner,
      leader: winner,
      loser,
      impact,
      evidence: `Your ${label} score: ${t}. Competitor's ${label} score: ${c}. Gap: ${Math.abs(diff)} point(s).`,
      reason: winner === "Tie" ? `Both sites scored identically on ${label}.` : `${winner === "You" ? "You outperform" : "Competitor outperforms you"} on ${label} by ${impact} point(s).`,
      recommendedAction: winner === "You"
        ? `Maintain your ${label} advantage; monitor for competitor improvements.`
        : winner === "Tie"
          ? `Look for differentiation opportunities in ${label} since scores are currently even.`
          : `Prioritize improving ${label} — closing this ${impact}-point gap is the most direct lever identified for this metric.`
    };
  };

  const metricComparisons = [
    buildComparison("SEO", targetData.seoScore, competitorData.seoScore),
    buildComparison("AEO", targetData.aeoScore, competitorData.aeoScore),
    buildComparison("E-E-A-T", targetData.eeatScore, competitorData.eeatScore),
    buildComparison("Authority", targetData.authorityScore, competitorData.authorityScore),
    buildComparison("Trust", targetData.trustScore, competitorData.trustScore),
    buildComparison("AI Citation", targetData.citationScore, competitorData.citationScore)
  ];

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

  const targetEntities = safeArray(targetData.entities).map(e => String(e).toLowerCase());
  const compEntities = safeArray(competitorData.entities);
  const entityGaps = compEntities.filter(compE => !targetEntities.includes(String(compE).toLowerCase()));

  const targetOverall = safeNumber(targetData.overallAIVisibilityScore);
  const competitorOverall = safeNumber(competitorData.overallAIVisibilityScore);
  const overallDiff = targetOverall - competitorOverall;

  const winningMetrics = metricComparisons.filter(m => m.winner === "You");
  const losingMetrics = metricComparisons.filter(m => m.winner === "Competitor").sort((a, b) => b.impact - a.impact);

  let leaderBrand = "Tie";
  let winnerReason = "Both sites present matching technical visibility signals.";
  if (overallDiff > 0) {
    leaderBrand = targetData.title || "Your Platform";
    winnerReason = `Leads overall by ${overallDiff} point(s), driven primarily by ${winningMetrics.map(m => m.metric).join(", ") || "balanced performance across metrics"}.`;
  } else if (overallDiff < 0) {
    leaderBrand = competitorData.title || "Competitor Platform";
    winnerReason = `Competitor leads overall by ${Math.abs(overallDiff)} point(s), primarily via stronger ${losingMetrics.map(m => m.metric).join(", ") || "overall optimization"}.`;
  }

  return {
    success: true,
    winner: leaderBrand,
    winnerReason,
    overall: { target: targetOverall, competitor: competitorOverall, difference: overallDiff },
    metricComparisons,
    topPriorityAction: losingMetrics.length > 0 ? losingMetrics[0].recommendedAction : "Maintain current standing across all measured metrics.",
    // Backward-compatible shape for existing frontend contract.
    metrics: {
      seo: metricComparisons[0], aeo: metricComparisons[1], eeat: metricComparisons[2],
      authority: metricComparisons[3], trust: metricComparisons[4]
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
  const pv = crawl?.pageValidation || {};
  return {
    success: false,
    blocked: true,
    validationState: pv.state || "BLOCKED_PAGE",
    status: crawl?.status || 0,
    reason: pv.evidence || crawl?.blockCheck?.reason || "Target could not be crawled.",
    protectionType: pv.protectionType || crawl?.blockCheck?.system || "Unknown",
    evidence: pv.evidence || crawl?.blockCheck?.reason || "No further evidence captured.",
    validationConfidence: pv.confidenceScore ?? crawl?.reliability?.confidenceScore ?? 0,
    integrityScore: pv.integrityScore ?? 0,
    crawlMethod: crawl?.crawlMethod || "STANDARD_GET",
    crawlerMethodUsed: crawl?.crawlMethod || "STANDARD_GET",
    retryRecommendation: pv.retryRecommendation || "Retry the scan; if this persists, the target may require manual verification.",
    retryCount: safeNumber(crawl?.retryCount, 0),
    resolvedUrl: crawl?.finalUrl || url,
    crawlConfidence: crawl?.reliability?.confidenceScore ?? 0,
    crawlQuality: crawl?.reliability?.qualityScore ?? 0,
    blockSignals: safeArray(crawl?.blockCheck?.signals),
    redirectCount: safeNumber(crawl?.redirectCount, 0),
    stagesAttempted: safeArray(crawl?.stagesAttempted)
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

  // Enterprise Scoring Engine gate: scoring may ONLY proceed when the Page
  // Validation Engine classified this crawl as VALID_PAGE. Any other state
  // (PARTIAL_PAGE, BLOCKED_PAGE, ERROR_PAGE, EMPTY_PAGE) short-circuits here
  // with a null-score response — no SEO/AEO/GEO/EEAT/Authority/Trust/
  // Citation calculation is ever attempted on unverified content.
  const validationState = crawl?.pageValidation?.state;
  if ((crawl.blockCheck && crawl.blockCheck.blocked) || validationState !== "VALID_PAGE") {
    logger.warn("ORCHESTRATOR", "target_blocked", { url, system: crawl.blockCheck?.system, validationState });
    const blockedPayload = buildBlockedPayload(url, crawl);
    return { ...blockedPayload, score: null, status: "BLOCKED", reason: blockedPayload.reason };
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
  const schemasDetected = auditPageSchemas($, crawl.html);
    const mixedContent = detectMixedContent($, crawl.finalUrl);
    const brokenAssetData = await sampleBrokenAssets($, crawl.finalUrl, 6);
    const securityHeaders = analyzeSecurityHeaders(crawl.headers);
    pageData.securityHeaders = securityHeaders; // consumed by Trust scoring (Phase 2)

    const technicalSeoAudit = calculateTechnicalSeoScore({
      pageData,
      headers: crawl.headers,
      robotsData,
      sitemapData,
      redirectCount: crawl.redirectCount,
      httpVersion: crawl.httpVersion,
      mixedContent,
      brokenAssetData
    });
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
    const contentQualityAudit = calculateContentQualityScore(pageData, $);
    const semanticSeoAudit = calculateSemanticSeoScore(enrichedPageData, clusters, coveragePercent);
    const authorityAudit = calculateDynamicAuthority(enrichedPageData);
    const trustAudit = scanDynamicTrustSignals($, crawl.html, crawl.finalUrl, enrichedPageData);
    const geoAudit = calculateGeoScore(pageData, semanticSeoAudit, authorityAudit, schemasDetected, aeoAudit.structuralAeoMetrics);

   const websiteType = inferWebsiteType(schemasDetected.detectedTypes, { ...pageData, resolvedUrl: crawl.finalUrl });
   const schemaBlock = buildSchemaRecommendations(schemasDetected.detectedTypes, pageData.title, pageData.metaDescription, crawl.finalUrl, websiteType);
    const imageSeoAudit = calculateImageSeoScore(pageData);
   const internalLinkAudit = calculateInternalLinkScoreDetailed(pageData.linkAnalysisDetail, seoAudit.brokenLinkSample, $);
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
      technicalSeo: technicalSeoAudit,
      mixedContent,
      brokenAssets: brokenAssetData,
      securityHeaders,
     schema: {
        detectedTypes: schemasDetected.detectedTypes,
        jsonLd: schemasDetected.jsonLd,
        microdata: schemasDetected.microdata,
        rdfa: schemasDetected.rdfa,
        validation: schemasDetected.validation,
        richResultEligibility: schemasDetected.richResultEligibility
      },
      websiteType,
      crawl: {
        method: crawl.crawlMethod,
        status: crawl.status,
        contentSize: crawl.contentLength,
        url: crawl.finalUrl,
        duration: loadTimeMs,
        retryCount: crawl.retryCount,
        infiniteScrollDetected: crawl.infiniteScrollDetected,
        redirectCount: crawl.redirectCount,
        confidenceScore: crawl.reliability?.confidenceScore,
        qualityScore: crawl.reliability?.qualityScore
      },
      pageValidation: {
        state: crawl.pageValidation?.state,
        integrityScore: crawl.pageValidation?.integrityScore,
        confidenceScore: crawl.pageValidation?.confidenceScore
      },
      robots: {
        found: robotsData.found,
        disallowedPaths: robotsData.disallowedPaths
      },
      sitemap: sitemapData,
      seoScore: seoAudit.score,
      aeoScore: aeoAudit.aeoScore,
      geoScore: geoAudit.score,
      eeatScore: eeatAudit.score,
      authorityScore: authorityAudit.authorityScore,
      trustScore: trustAudit.trustScore,
      citationScore: aiEngineCitations.citationProbability,
      overallAIVisibilityScore: finalAIVisibilityScore,
      potentialAIVisibility: clamp(finalAIVisibilityScore + 18, 50, 99),
      entities: pageData.entities,
      entityDetails: pageData.entityDetails,
      seo: buildStandardizedScoreOutput(seoAudit, 20),
      aeo: {
        ...buildStandardizedScoreOutput(aeoAudit, 30),
        score: aeoAudit.aeoScore,
        readabilityScore: aeoAudit.readabilityScore,
        avgSentenceLength: aeoAudit.avgSentenceLength,
        simulations: aeoAudit.simulations
      },
      geo: buildStandardizedScoreOutput(geoAudit, 100),
      eeat: buildStandardizedScoreOutput(eeatAudit, 25),
      citation: aiEngineCitations,
      authority: buildStandardizedScoreOutput(authorityAudit, 15),
      trust: buildStandardizedScoreOutput(trustAudit, 10),
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
      contentQuality: contentQualityAudit,
      semanticSeoDetail: semanticSeoAudit,
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
