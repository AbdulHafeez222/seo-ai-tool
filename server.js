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
// ========== SECTION 1.5: STABILITY HARDENING & SANITIZERS ===============
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

export const isBlockedHTML = (html = "", status = 200) => {
  if (html === undefined || html === null) return true;
  const bodyStr = typeof html === "string" ? html : String(html);

  const blockedStatuses = [202, 401, 403, 429, 503];
  if (blockedStatuses.includes(status)) return true;

  const lowercaseHtml = bodyStr.toLowerCase();
  const strictBlockedPatterns = [
    "cf-browser-verification",
    "__cf_chl_opt",
    "error code 1020",
    "verify you are human",
    "access denied",
    "sucuri",
    "cloudflare",
    "captcha",
    "just a moment...",
    "attention required",
    "g-recaptcha",
    "hcaptcha",
    "challenge-form",
    "turnstile",
    "anti-bot",
    "ray id",
    "ddos protection"
  ];

  return strictBlockedPatterns.some(p => lowercaseHtml.includes(p));
};

// Regex backup helpers to prevent undefined reference errors
export const regexFallbackParser = (html, url) => {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i) || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  
  return {
    title: titleMatch ? cleanText(titleMatch[1]) : cleanDomainBrand(url),
    metaDescription: metaDescMatch ? cleanText(metaDescMatch[1]) : "Expert digital insights and optimization framework.",
    h1: h1Match ? cleanText(h1Match[1]) : cleanDomainBrand(url)
  };
};

export const getKeywordDifficulty = (kw) => {
  const hash = String(kw).split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return clamp((hash % 40) + 30, 10, 99);
};

export const getKeywordOpportunity = (difficulty, searchVolume = 1200) => {
  return clamp(Math.round(((100 - difficulty) * 0.7) + ((searchVolume / 1000) * 10)), 5, 95);
};

// =========================================================================
// ========== SECTION 2: HIGH-PERFORMANCE BRIDGED CRAWLER ==================
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
  
  let state = "SUCCESS";
  if (!html || html.length < 200) {
    state = "FAILED";
  } else if (isBlockedHTML(html, status)) {
    state = "BLOCKED";
  } else if (html.length < 1500) {
    state = "INCOMPLETE_CRAWL";
  }

  if (state === "BLOCKED" || state === "INCOMPLETE_CRAWL" || html.includes("javascript is required") || html.includes("enable javascript")) {
    console.log(`[CRAWL] Standard execution blocked or incomplete. Upgrading protocol to Headless Browser...`);
    try {
      const pwResult = await fetchPlaywright(url);
      if (pwResult && pwResult.html && pwResult.html.length >= 300) {
        const pwBlocked = isBlockedHTML(pwResult.html, pwResult.status);
        if (!pwBlocked) {
          html = pwResult.html;
          status = pwResult.status;
          finalUrl = pwResult.finalUrl;
          state = pwResult.html.length < 1500 ? "INCOMPLETE_CRAWL" : "SUCCESS";
          crawlMethod = "PLAYWRIGHT_RENDERED";
        } else {
          state = "BLOCKED";
        }
      }
    } catch (pwErr) {
      console.error("[CRAWL] Headless fallback failed:", pwErr.message);
    }
  }

  return {
    html,
    finalUrl,
    state,
    status,
    crawlMethod,
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
// ========== SECTION 3: DETERMINISTIC STRUCTURAL EXTRACTORS =================
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

export function extractStructuredData($, html, url) {
  const meta = {
    title: cleanText($("title").text() || $('meta[property="og:title"]').attr("content") || ""),
    description: cleanText($('meta[name="description"]').attr("content") || $('meta[property="og:description"]').attr("content") || ""),
    canonical: safeText($('link[rel="canonical"]').attr("href")),
    robots: safeText($('meta[name="robots"]').attr("content") || "index, follow"),
    h1: cleanText($("h1").first().text()),
    h2s: [...new Set($("h2").map((_, el) => cleanText($(el).text())).get().filter(Boolean))],
    h3s: [...new Set($("h3").map((_, el) => cleanText($(el).text())).get().filter(Boolean))],
    bodyText: cleanText($("p, li, h2, h3, h4, td, span, article").map((_, el) => $(el).text()).get().join(" ")),
    images: [],
    favicon: safeText($('link[rel="icon"], link[rel="shortcut icon"]').attr("href")),
    ogTitle: safeText($('meta[property="og:title"]').attr("content")),
    ogDescription: safeText($('meta[property="og:description"]').attr("content")),
    ogImage: safeText($('meta[property="og:image"]').attr("content")),
    hasLastModified: false,
    lastModified: null,
    hasFacebook: false,
    hasLinkedIn: false,
    hasYouTube: false,
    hasTwitter: false,
    email: null,
    phone: null
  };

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const alt = $(el).attr("alt");
    if (src) {
      meta.images.push({ src, alt: alt ? cleanText(alt) : null });
    }
  });

  const dateStr = safeText($('meta[property="article:modified_time"]').attr('content') || $('meta[property="article:published_time"]').attr('content'));
  if (dateStr) {
    meta.hasLastModified = true;
    meta.lastModified = new Date(dateStr).toLocaleDateString();
  }

  $("a").each((_, el) => {
    const href = safeText($(el).attr("href")).toLowerCase();
    if (href.includes("facebook.com")) meta.hasFacebook = true;
    if (href.includes("linkedin.com")) meta.hasLinkedIn = true;
    if (href.includes("youtube.com")) meta.hasYouTube = true;
    if (href.includes("twitter.com") || href.includes("x.com")) meta.hasTwitter = true;
  });

  const emailMatch = meta.bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = meta.bodyText.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/);
  meta.email = emailMatch ? emailMatch[0] : null;
  meta.phone = phoneMatch ? phoneMatch[0] : null;

  return meta;
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

  const servicePatterns = [
    'SEO', 'Search Engine Optimization', 'Web Design', 'Digital Marketing', 'Web Development', 
    'Content Writing', 'Copywriting', 'Social Media Marketing', 'E-commerce', 'Shopify', 
    'Branding', 'Analytics', 'Enterprise Software', 'AI Integration', 'Consulting', 
    'Software Development', 'Product Strategy', 'UI/UX Design', 'Cloud Hosting', 'Cybersecurity'
  ];
  servicePatterns.forEach(srv => {
    if (new RegExp(`\\b${srv}\\b`, 'i').test(combinedText)) {
      services.push(srv);
    }
  });

  const cityPatterns = ['New York', 'London', 'Toronto', 'Sydney', 'Berlin', 'Paris', 'Dubai', 'Singapore', 'Tokyo', 'Chicago', 'San Francisco', 'Karachi', 'Lahore', 'Islamabad'];
  cityPatterns.forEach(city => {
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

export function getBrandNameEnhanced(url, $, title, schemas) {
  let brand = "";
  const genericServiceKeywords = [
    "seo", "search engine optimization", "web design", "digital marketing", "web development", 
    "content writing", "copywriting", "social media marketing", "ecommerce", "shopify", 
    "branding", "analytics", "enterprise software", "ai integration", "consulting", 
    "software development", "product strategy", "ui/ux design", "cloud hosting", "cybersecurity",
    "expert digital systems", "home", "homepage", "services", "contact", "about", "about us", "privacy policy"
  ];

  const isGeneric = (name) => {
    if (!name) return true;
    const lower = name.toLowerCase().trim();
    if (lower.length <= 1 || lower.length > 60) return true;
    return genericServiceKeywords.some(kw => lower === kw || lower.includes("expert digital systems") || lower === "brand authority" || lower === "unknown");
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

export function calculateTopicalAuthority($, keywords, h2s, h3s, wordCount) {
  const allHeadings = [...safeArray(h2s), ...safeArray(h3s)].map(h => safeText(h).toLowerCase());
  
  const clusters = [
    { name: "Informational", queries: ["what", "how", "guide", "tutorial", "learn", "definition"] },
    { name: "Commercial", queries: ["best", "pricing", "reviews", "cost", "features", "compare"] },
    { name: "Authority", queries: ["examples", "comparison", "benefits", "case study", "portfolio"] },
    { name: "Transactional", queries: ["buy", "order", "purchase", "get started", "pricing", "sign up"] },
    { name: "Trust", queries: ["security", "about", "contact", "support", "guarantee", "compliance"] }
  ];

  let coveredCount = 0;
  const missingClusters = [];
  const missingTopics = [];

  clusters.forEach(cluster => {
    const hasQuery = cluster.queries.some(q => allHeadings.some(h => h.includes(q)));
    if (hasQuery) {
      coveredCount++;
    } else {
      missingClusters.push(cluster.name);
      missingTopics.push(`${cluster.name} Core Query missing (target matching phrases: ${cluster.queries.slice(0, 3).join(', ')})`);
    }
  });

  const totalClusters = clusters.length;
  const coveragePercent = Math.round((coveredCount / totalClusters) * 100);
  
  let depthFactor = "Shallow Structure";
  if (wordCount > 2500) {
    depthFactor = "SaaS Enterprise Tier (Deep)";
  } else if (wordCount > 1000) {
    depthFactor = "Moderate Coverage";
  }

  const authorityScore = clamp(coveragePercent + Math.min(40, safeArray(keywords).length * 4) + (wordCount > 1500 ? 15 : 5));

  return {
    authorityScore,
    clusters: clusters.map(c => ({
      name: c.name,
      status: c.queries.some(q => allHeadings.some(h => h.includes(q))) ? "Active" : "Incomplete"
    })),
    coveragePercent,
    missingClusters: [...new Set(missingClusters)],
    missingTopics: [...new Set(missingTopics)].slice(0, 5),
    depth: depthFactor,
    topicsCovered: `${coveredCount}/${totalClusters}`
  };
}

export function analyzeSemanticSEO($, bodyText, keywords) {
  const text = safeText(bodyText).toLowerCase();
  const keywordSet = safeArraySlice(keywords, 0, 10);
  const matchedKeywords = keywordSet.filter(k => text.includes(safeText(k).toLowerCase()));
  
  const entityCoverage = Math.round((matchedKeywords.length / Math.max(1, keywordSet.length)) * 100);
  const semanticRelevance = text.length > 500 ? 85 : 45;
  const topicCoverage = Math.min(100, Math.round((matchedKeywords.length * 10) + (text.length > 1000 ? 20 : 5)));
  const contentDepth = text.length > 3000 ? "Deep (SaaS Tier)" : "Shallow Structure";

  const nlpScore = clamp(Math.round((topicCoverage * 0.4) + (semanticRelevance * 0.3) + (entityCoverage * 0.3)));
  const semanticGaps = keywordSet.filter(k => !text.includes(safeText(k).toLowerCase()));

  return {
    nlpScore,
    topicCoverage,
    semanticRelevance,
    entityCoverage,
    contentDepth,
    semanticGaps: [...new Set(semanticGaps)],
    missingEntities: [...new Set(semanticGaps)],
    recommendations: [...new Set(semanticGaps)].map(g => `Embed entity phrase: "${g}" naturally in content core.`)
  };
}

export function findCitationOpportunities(data) {
  const opportunities = [];
  const { hasFAQ, hasDirectAnswer, hasAuthor, hasHowTo } = data;

  if (!hasFAQ) {
    opportunities.push({
      engine: 'ChatGPT',
      issue: 'Missing FAQ Schema mapping',
      impact: 'CRITICAL (+20%)',
      fix: 'Deploy FAQ JSON-LD schema with exact long-tail queries.'
    });
  }
  if (!hasDirectAnswer) {
    opportunities.push({
      engine: 'Perplexity',
      issue: 'No clear semantic paragraph at the top',
      impact: 'HIGH (+15%)',
      fix: 'Integrate a 50-word "Quick Answer Summary" immediately under the H1.'
    });
  }
  if (!hasAuthor) {
    opportunities.push({
      engine: 'Gemini',
      issue: 'Missing schema-marked Author profile credentials',
      impact: 'HIGH (+12%)',
      fix: 'Add structured Author Bio block with external profile links.'
    });
  }
  if (!hasHowTo) {
    opportunities.push({
      engine: 'Claude',
      issue: 'Procedural/step documentation missing logical blocks',
      impact: 'MEDIUM (+10%)',
      fix: 'Implement HowTo schema block matching user goals.'
    });
  }

  return opportunities;
}

export function generateAISnippets(h1, metaDescription, bodyText, keywords) {
  const safeBody = safeText(bodyText);
  const safeH1 = safeText(h1);
  const safeDesc = safeText(metaDescription);
  const contentSentence = safeBody.length > 50 ? safeBody.split('.').slice(0, 2).join('.') + '.' : '';
  const keyword = safeArray(keywords)[0] || 'the page';

  const directAnswer = safeDesc || `This playbook breaks down all standard frameworks about ${keyword}.`;

  return {
    directAnswer: cleanText(directAnswer),
    directAnswerWordCount: directAnswer.split(/\s+/).filter(Boolean).length,
    featuredSnippet: `## ${safeH1 || 'Overview'}\n\n${contentSentence ? `Key insights include: ${contentSentence}` : `Essential overview of ${keyword}.`}`,
    aiOverviewAnswer: `According to live page analysis, ${safeH1 || 'this platform'} specializes in providing high-performance solutions for ${keyword}.`,
    quickFactsBlock: [
      `Main Concept: ${safeH1}`,
      `Niche Category: ${keyword}`,
      `Authority Focus: Enterprise Optimization`
    ]
  };
}

export function analyzeEEATAdvanced($, bodyText, hasAuthor, hasAboutPage, hasContactPage, hasPrivacyPolicy, hasLinkedIn, hasFacebook, isHttps, hasLastModified, schemas, hasTermsPage, socialLinks) {
  const factors = [];
  const issues = [];
  
  let experience = hasAuthor ? 25 : 5;
  let expertise = (hasAboutPage || hasLinkedIn) ? 25 : 5;
  let authoritativeness = (safeArray(socialLinks).length > 0 || schemas?.Organization?.present) ? 25 : 5;
  let trustworthiness = (isHttps && hasPrivacyPolicy && hasContactPage && hasTermsPage) ? 25 : (isHttps ? 15 : 5);

  if (hasAuthor) factors.push("Author Attribution Detected"); else issues.push("No specific author profile found");
  if (hasAboutPage) factors.push("About Page Linked"); else issues.push("About section missing");
  if (hasContactPage) factors.push("Contact Access Points Configured"); else issues.push("No clear contact channels");
  if (hasPrivacyPolicy) factors.push("Privacy Policy Configured"); else issues.push("Missing privacy parameters");
  if (hasTermsPage) factors.push("Terms of Service Configured"); else issues.push("Missing Terms page");
  if (isHttps) factors.push("HTTPS SSL Security Configured"); else issues.push("Not secure (HTTP)");

  const score = clamp(experience + expertise + authoritativeness + trustworthiness, 10, 100);
  const status = score >= 80 ? "SaaS Enterprise Tier" : score >= 60 ? "Secure Authority" : "Shallow Trust Profile";

  return {
    score,
    status,
    factors: [...new Set(factors)],
    issues: [...new Set(issues)],
    author: hasAuthor ? "Verified Credentials" : "Anonymous Admin",
    aboutPage: hasAboutPage ? "Active" : "Missing",
    contactPage: hasContactPage ? "Active" : "Missing",
    socialProfiles: (hasLinkedIn || hasFacebook) ? "Detected" : "None Found",
    breakdown: {
      experience: { score: experience, max: 25, factors: hasAuthor ? ["Author Profile Found"] : [] },
      expertise: { score: expertise, max: 25, factors: hasAboutPage ? ["About page context verified"] : [] },
      authoritativeness: { score: authoritativeness, max: 25, factors: (hasLinkedIn || hasFacebook) ? ["External professional credentials linked"] : [] },
      trustworthiness: { score: trustworthiness, max: 25, factors: isHttps ? ["SSL Security active"] : [] }
    }
  };
}

export function analyzeLocalSEO($, bodyText, schemas, hasEmail, hasPhone) {
  const text = safeText(bodyText);
  const hasNAP = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(text) || text.toLowerCase().includes('address') || text.toLowerCase().includes('phone') || (hasEmail && hasPhone);
  const hasLocalBusiness = schemas?.LocalBusiness?.present || $('[itemtype*="LocalBusiness"]').length > 0;
  const hasMap = $('iframe[src*="google.com/maps"], iframe[src*="maps"]').length > 0;
  
  const cityPatterns = ['karachi', 'lahore', 'islamabad', 'london', 'new york', 'dubai', 'sydney', 'toronto', 'paris', 'berlin', 'tokyo'];
  const lowercaseText = text.toLowerCase();
  const hasCity = cityPatterns.some(city => lowercaseText.includes(city));

  const signals = { hasNAP, hasLocalBusiness, hasMap, hasCity };
  const scoreCount = Object.values(signals).filter(Boolean).length;
  const localSEOScore = clamp((scoreCount / 4) * 100);

  const recommendations = [];
  if (!hasLocalBusiness) recommendations.push('Deploy LocalBusiness JSON-LD Schema markup immediately');
  if (!hasNAP) recommendations.push('Publish name, address, and phone number (NAP) data clearly on homepage');

  return {
    hasNAP,
    hasLocalBusiness,
    hasMap,
    hasCity,
    localScore: localSEOScore,
    localSEOScore,
    napConsistency: hasNAP ? 'Active' : 'Incomplete/Missing',
    napStatus: hasNAP ? 'Active' : 'Incomplete/Missing',
    mapDetected: hasMap,
    localBusinessSchemaDetected: hasLocalBusiness,
    recommendations: [...new Set(recommendations)]
  };
}

export function scanTrustSignals($, url) {
  const bodyText = $('body').text().toLowerCase();
  
  let hasContact = false;
  let hasAbout = false;
  let hasPrivacyPolicy = false;
  let hasTermsPage = false;
  let hasSocialProfiles = false;
  let hasReviews = false;
  let hasTestimonials = false;
  let hasAuthorPage = false;

  const socialLinks = [];
  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = bodyText.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/);
  const hasEmail = !!emailMatch;
  const hasPhone = !!phoneMatch;

  try {
    $("a").each((i, el) => {
      const href = ($(el).attr("href") || "").trim();
      const text = $(el).text().toLowerCase().trim();

      if (href.startsWith('mailto:') || href.startsWith('tel:') || href.includes('wa.me') || href.includes('whatsapp') || text.includes('contact') || href.includes('contact')) {
        hasContact = true;
      }
      if (href.includes('about') || text.includes('about') || text.includes('our story') || text.includes('who we are')) {
        hasAbout = true;
      }
      if (href.includes('privacy') || text.includes('privacy')) {
        hasPrivacyPolicy = true;
      }
      if (href.includes('terms') || text.includes('terms') || text.includes('tos') || text.includes('conditions')) {
        hasTermsPage = true;
      }
      if (href.includes('author') || href.includes('profile') || text.includes('author') || $(el).attr('rel') === 'author') {
        hasAuthorPage = true;
      }
      if (href.includes('facebook.com') || href.includes('linkedin.com') || href.includes('twitter.com') || href.includes('x.com') || href.includes('instagram.com') || href.includes('youtube.com')) {
        hasSocialProfiles = true;
        socialLinks.push(href);
      }
    });
  } catch (err) {}

  if (hasEmail || hasPhone) {
    hasContact = true;
  }

  if (bodyText.includes('review') || bodyText.includes('stars') || bodyText.includes('rated') || $('.review, .testimonial').length > 0) {
    hasReviews = true;
  }
  if (bodyText.includes('testimonial') || bodyText.includes('what our clients say') || bodyText.includes('happy clients') || $('.testimonial, .client-feedback').length > 0) {
    hasTestimonials = true;
  }

  const signalsCount = [hasContact, hasAbout, hasPrivacyPolicy, hasTermsPage, hasSocialProfiles, hasReviews, hasTestimonials, hasAuthorPage].filter(Boolean).length;
  const trustScore = clamp((signalsCount / 8) * 100);

  return {
    hasContact,
    hasAbout,
    hasPrivacyPolicy,
    hasTermsPage,
    hasSocialProfiles,
    hasReviews,
    hasTestimonials,
    hasAuthorPage,
    trustScore,
    totalSignals: signalsCount,
    socialLinks: [...new Set(socialLinks)].slice(0, 10)
  };
}

export function trackAIVisibilityTrend(url, currentScore, seoScore, aeoScore) {
  if (currentScore === null || seoScore === null || aeoScore === null) {
    return { labels: [], scores: [], seoScores: [], aeoScores: [], growthPercentage: 0 };
  }
  const key = Buffer.from(url).toString('base64');
  if (!trendDB[key]) {
    trendDB[key] = [
      { date: "Day -4", score: Math.max(1, currentScore - 12), seo: Math.max(1, seoScore - 10), aeo: Math.max(1, aeoScore - 8) },
      { date: "Day -3", score: Math.max(1, currentScore - 8), seo: Math.max(1, seoScore - 6), aeo: Math.max(1, aeoScore - 5) },
      { date: "Day -2", score: Math.max(1, currentScore - 5), seo: Math.max(1, seoScore - 4), aeo: Math.max(1, aeoScore - 3) },
      { date: "Day -1", score: Math.max(1, currentScore - 2), seo: Math.max(1, seoScore - 2), aeo: Math.max(1, aeoScore - 1) }
    ];
  }

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  trendDB[key].push({
    date: dateStr,
    score: currentScore,
    seo: seoScore,
    aeo: aeoScore
  });

  if (trendDB[key].length > 10) trendDB[key] = trendDB[key].slice(-10);

  const history = safeArray(trendDB[key]);
  const firstScore = safeObject(history[0]).score || 0;
  const growthPercentage = firstScore > 0 ? Math.round(((currentScore - firstScore) / firstScore) * 100) : 0;

  return {
    labels: history.map(h => h.date),
    scores: history.map(h => h.score),
    seoScores: history.map(h => h.seo),
    aeoScores: history.map(h => h.aeo),
    growthPercentage
  };
}

// =========================================================================
// ========== SECTION 4: AI CITATION & AEO SIMULATION ENGINES =============
// =========================================================================

export function aeoSimulationEngine(data) {
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
  } = safeObject(data);

  const citationChatGPT = Math.min(95, 10 + 
    (hasFAQ ? 25 : 0) + 
    (listCount > 2 ? 15 : 0) + 
    (hasDirectAnswer ? 20 : 0) + 
    (hasAuthor ? 15 : 0) + 
    (topicalAuthorityScore > 60 ? 10 : 0)
  );

  const citationGemini = Math.min(95, 10 + 
    (hasLocalBusiness ? 25 : 0) + 
    (tableCount > 0 ? 20 : 0) + 
    (hasAuthor ? 15 : 0) + 
    (wordCount > 1000 ? 15 : 0) + 
    (eeatScore > 60 ? 15 : 0)
  );

  const citationPerplexity = Math.min(95, 10 + 
    (hasDirectAnswer ? 25 : 0) + 
    (hasLastModified ? 15 : 0) + 
    (externalLinksCount > 5 ? 15 : 0) + 
    (listCount > 0 ? 15 : 0) + 
    (internalLinkScore > 60 ? 15 : 0)
  );

  const citationClaude = Math.min(95, 10 + 
    (wordCount > 1500 ? 25 : 0) + 
    (hasHowTo ? 20 : 0) + 
    (hasAbout ? 15 : 0) + 
    (entityCoverage > 50 ? 20 : 0) + 
    (topicalAuthorityScore > 70 ? 10 : 0)
  );
  
  const citationProbability = Math.round((citationChatGPT + citationGemini + citationPerplexity + citationClaude) / 4);

  const missingAnswerBlocks = [];
  if (!hasDirectAnswer) missingAnswerBlocks.push("Semantic Direct Summary Block under the Main Heading");
  if (!hasFAQ) missingAnswerBlocks.push("Structured Q&A / FAQ Block");
  if (listCount === 0) missingAnswerBlocks.push("Bullet points/ordered list for quick LLM ingestion");

  const improvementSuggestions = [];
  if (!hasFAQ) improvementSuggestions.push("Add FAQ Schema containing direct query keys targeting top user intent.");
  if (!hasDirectAnswer) improvementSuggestions.push("Place a 50-word direct summary answer box directly underneath your main H1 tag.");
  if (!hasAuthor) improvementSuggestions.push("Establish E-E-A-T: Include author name and schema reference linked to social credentials.");

  return {
    citationChatGPT,
    citationGemini,
    citationPerplexity,
    citationClaude,
    chatgptProbability: citationChatGPT,
    geminiProbability: citationGemini,
    perplexityProbability: citationPerplexity,
    claudeProbability: citationClaude,
    citationProbability,
    missingAnswerBlocks: [...new Set(missingAnswerBlocks)],
    improvementSuggestions: [...new Set(improvementSuggestions)]
  };
}

export function aiReasoningEngine(data, seoScore, aeoScore, citationProbability) {
  const missingEntities = safeArray(data?.missingEntities || data?.semanticGaps || []);

  let seoReasoning = "Your page features solid structural fundamentals.";
  if (seoScore === null) {
    seoReasoning = "Crawl blocked. Cannot calculate structural profiles.";
  } else if (seoScore < 30) {
    seoReasoning = "Critical structural elements are missing or badly configured (missing meta tags, title length issues, or non-HTTPS URL).";
  } else if (seoScore < 70) {
    seoReasoning = "Strong structural base, but could be enhanced by fixing image alt tags, ensuring a canonical link, or speeding up loading performance.";
  } else {
    seoReasoning = "Excellent technical setup with correct HTML validation, metadata coverage, and optimal responsive design.";
  }

  let aeoReasoning = "Ready to be referenced by core generative model architectures.";
  if (aeoScore === null) {
    aeoReasoning = "Crawl blocked. Cannot calculate generative AI semantic features.";
  } else if (aeoScore < 30) {
    aeoReasoning = "The document layout lacks LLM-friendly structural hooks like direct questions, list summaries, or JSON-LD FAQ/HowTo schemas.";
  } else if (aeoScore < 70) {
    aeoReasoning = "LLMs can parse the structure, but adding a high-contrast 'Answer Box' section and expanding Q&A schema blocks would significantly improve visibility.";
  }

  let citationLikelihood = "Moderate chance of selection as a reference source.";
  if (citationProbability === null) {
    citationLikelihood = "No active visibility calculations available due to index limitations.";
  } else if (citationProbability >= 80) {
    citationLikelihood = "Highly Likely. Structured schema, rich topical density, and verifiable trust signals position this content for top-tier indexing.";
  } else if (citationProbability < 50) {
    citationLikelihood = "Low citation potential. High-performance models prefer pages containing marked schemas, clear list hierarchies, and explicit author attribution.";
  }

  return {
    seo: seoReasoning,
    aeo: aeoReasoning,
    citationLikelihood,
    missingEntities: [...new Set(missingEntities)]
  };
}

// =========================================================================
// ========== SECTION 4.4: CENTRALIZED SCORE ENGINE (NO FAKES) =============
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
    eeatScore,
    state
  } = signals;

  if (
    state === "BLOCKED" || 
    state === "FAILED" || 
    !title || 
    !metaDescription || 
    !h1 || 
    wordCount < 100 || 
    !internalLinkData
  ) {
    return null;
  }

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

export function fallbackSafePayload(url, err = null) {
  const brand = cleanDomainBrand(url);
  const now = new Date().toISOString();
  
  return {
    status: "success",
    seoScore: null,
    aeoScore: null,
    eeatScore: null,
    citationScore: null,
    currentAIVisibility: null,
    potentialAIVisibility: null,
    totalRoadmapImpact: null,
    schemaDetected: false,
    schemaCount: 0,
    recommendedSchemas: ["FAQPage", "LocalBusiness", "Organization"],
    fallbackMode: true,
    analysisConfidence: 0,
    confidenceWarning: "Crawl limitations / protection wall detected.",
    classification: "FAILED",
    analysisStatus: "BLOCKED",
    scores: null,
    comparison: null,
    gapAnalysis: null,
    keywordIntelligence: null,
    roadmap: null,
    analysis: null,
    entities: {
      brands: [brand],
      services: [],
      locations: ["Global Context"]
    },
    issues: [
      { priority: "CRITICAL", description: "Bypass triggered: target resource is protected or unreadable." }
    ],
    meta: {
      url: url || "https://example.com",
      wordCount: 0,
      timestamp: now
    }
  };
}

export function enforceSecureUrl(inputUrl) {
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
}

// =========================================================================
// ========== SECTION 5: COMPREHENSIVE SCANNER PIPELINE ===================
// =========================================================================

export async function analyzeSingleUrl(url) {
  let normalizedUrl;
  try {
    normalizedUrl = enforceSecureUrl(url);
  } catch (err) {
    return fallbackSafePayload(url, err);
  }

  if (!normalizedUrl) {
    return {
      error: "Malformed target domain or invalid TLD",
      crawlSuccess: false,
      status: "error"
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

  let html = "";
  let crawlResult;
  let startTime = Date.now();
  try {
    crawlResult = await smartCrawl(normalizedUrl);
    html = crawlResult.html || "";
  } catch (err) {
    return fallbackSafePayload(normalizedUrl, err);
  }

  const loadTime = Date.now() - startTime;
  const isBlocked = crawlResult.state === "BLOCKED" || [202, 401, 403, 429, 503].includes(crawlResult.status) || isBlockedHTML(html, crawlResult.status);

  if (isBlocked) {
    let blockedReason = "Cloudflare or CAPTCHA protection detected.";
    if (crawlResult.status === 403) blockedReason = "403 Forbidden detected. Cloudflare or CAPTCHA protection detected.";
    else if (crawlResult.status === 401) blockedReason = "401 Unauthorized detected. Cloudflare or CAPTCHA protection detected.";
    else if (crawlResult.status === 429) blockedReason = "429 Too Many Requests rate limiting. Cloudflare or CAPTCHA protection detected.";
    else if (crawlResult.status === 202) blockedReason = "202 Accepted pending challenge. Cloudflare or CAPTCHA protection detected.";

    const blockedResultPayload = {
      status: "blocked",
      success: false,
      crawlSuccess: false,
      analysisStatus: "BLOCKED",
      classification: "BLOCKED",
      reason: "Cloudflare or CAPTCHA protection detected.",
      blockedReason: blockedReason,
      recommendation: "Target website is protected by Cloudflare or CAPTCHA. Switch to enterprise proxies or white-list API requests.",
      crawlMethod: crawlResult.crawlMethod || "STANDARD_GET",
      httpStatus: crawlResult.status || 403,
      contentLength: crawlResult.contentLength || 0,
      resolvedUrl: crawlResult.finalUrl || normalizedUrl,
      fallbackMode: false,
      analysisConfidence: 0,
      confidenceWarning: "Analysis Limited: Target website is protected by Cloudflare or CAPTCHA.",
      seoScore: null,
      aeoScore: null,
      eeatScore: null,
      citationScore: null,
      currentAIVisibility: null,
      potentialAIVisibility: null,
      score: null,
      citationProbability: null,
      overallAIVisibilityScore: null,
      pageType: "BLOCKED_PAGE",
      scores: null,
      comparison: null,
      gapAnalysis: null,
      keywordIntelligence: null,
      roadmap: null,
      meta: {
        url: crawlResult.finalUrl || normalizedUrl,
        timestamp: new Date().toISOString()
      }
    };
    scanCache.set(cacheKey, { cachedAt: Date.now(), payload: blockedResultPayload });
    return blockedResultPayload;
  }

  let $ = cheerio.load(html);
  const backupExtraction = regexFallbackParser(html, normalizedUrl);

  let title = cleanText(safeText($("title").text()).trim() || backupExtraction.title);
  let metaDescription = cleanText(safeText($('meta[name="description"]').attr("content")).trim() || backupExtraction.metaDescription);
  let h1 = cleanText(safeText($("h1").first().text()).trim() || backupExtraction.h1);
  let h2s = [...new Set($("h2").map((i, el) => safeText($(el).text()).trim()).get().filter(Boolean).map(cleanText))];
  let h3s = [...new Set($("h3").map((i, el) => safeText($(el).text()).trim()).get().filter(Boolean).map(cleanText))];

  const internalLinkData = analyzeInternalLinks($, normalizedUrl, h2s);
  const bodyText = cleanText($("p, li, h2, h3, h4, td, span, article").map((i, el) => $(el).text()).get().join(" "));
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length || 0;

  if (!title || !metaDescription || !h1 || wordCount < 100) {
    const thinResultPayload = {
      status: "success",
      success: false,
      crawlSuccess: true,
      analysisStatus: "BLOCKED",
      classification: "FAILED",
      reason: "Insufficient page metadata or HTML body content parsed.",
      crawlMethod: crawlResult.crawlMethod || "STANDARD_GET",
      httpStatus: crawlResult.status || 200,
      contentLength: html.length,
      resolvedUrl: crawlResult.finalUrl || normalizedUrl,
      fallbackMode: false,
      analysisConfidence: 0,
      confidenceWarning: "Core metrics calculation disabled: missing title, meta tags, h1, or body markup.",
      seoScore: null,
      aeoScore: null,
      eeatScore: null,
      citationScore: null,
      currentAIVisibility: null,
      potentialAIVisibility: null,
      score: null,
      citationProbability: null,
      overallAIVisibilityScore: null,
      pageType: "THIN_CONTENT",
      scores: null,
      comparison: null,
      gapAnalysis: null,
      keywordIntelligence: null,
      roadmap: null,
      meta: {
        url: crawlResult.finalUrl || normalizedUrl,
        timestamp: new Date().toISOString()
      }
    };
    scanCache.set(cacheKey, { cachedAt: Date.now(), payload: thinResultPayload });
    return thinResultPayload;
  }

  const schemas = detectAllSchemas($, html);
  const uniqueSchemas = [...new Set(Object.keys(schemas).filter(k => schemas[k]?.present))];
  const ALLOWED_RECOMMENDED_TYPES = ["FAQPage", "Organization", "LocalBusiness", "WebSite", "Article", "HowTo"];
  const recommendedSchemas = [...new Set(
    Object.keys(schemas).filter(k => !schemas[k]?.present && ALLOWED_RECOMMENDED_TYPES.includes(k))
  )];

  const h1Count = $("h1").length || (backupExtraction.h1 ? 1 : 0);
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

  let crawlQuality = "High Quality";
  let classification = "SUCCESS";

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
  const semanticScore = safeNumber(semanticSEO?.nlpScore, 0);

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
    eeatScore,
    state: crawlResult.state
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
    status: "success",
    seoScore,
    aeoScore,
    eeatScore,
    citationScore: citationProbability,
    currentAIVisibility,
    potentialAIVisibility,
    totalRoadmapImpact,
    schemaDetected: uniqueSchemas.length > 0,
    schemaCount: uniqueSchemas.length,
    recommendedSchemas,
    fallbackMode: false,
    analysisConfidence,
    confidenceWarning,
    analysisStatus: "SUCCESS",
    classification,
    
    crawlMethod: crawlResult.crawlMethod || "STANDARD_GET",
    httpStatus: crawlResult.status || 200,
    contentLength: crawlResult.contentLength || 0,
    resolvedUrl: crawlResult.finalUrl || normalizedUrl,
    pageType: crawlResult.type,
    blockedReason: null,

    analysis: {
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
      locations: [...new Set(entityData?.locations || [])]
    },
    
    issues: [...new Set([...criticalIssues, ...importantIssues])].map(issue => ({ priority: "HIGH", description: issue })),
    roadmap: aiAutopilot.map((task, idx) => ({ step: idx + 1, task: task.task, priority: task.priority, impact: task.impact, effort: task.effort })),
    competitor: {
      winner: brandName,
      winnerReason: "Live verification complete"
    },
    
    meta: {
      url: normalizedUrl,
      wordCount,
      timestamp: new Date().toISOString()
    },

    success: true,
    crawlSuccess: true,
    crawlQuality,
    warning: confidenceWarning,
    schemaGenerator,
    schema: schemaGenerator,
    topicalClusters: topicalAuthority.clusters,
    recommendations: [...new Set(aiAutopilot.map(a => a.task))],
    aiAutopilot,
    autopilot: { tasks: aiAutopilot },
    title,
    h1,
    h2s,
    h3s,
    metaDescription,
    lastModified,
    score: seoScore,
    citationProbability,
    aiTrustSignals: [...new Set(aiTrustSignals)],
    overallAIVisibilityScore,
    aiVisibilityLevel,
    breakdown: {
      seo: seoScore,
      aeo: aeoScore,
      eeatScore: eeatScore,
      eeatBreakdown: eeatData,
      internalLinkingAudit: internalLinkData,
      trust: aiTrustScore,
      citation: citationProbability,
      readability: readabilityScore,
      schema: clamp(uniqueSchemas.length * 25)
    },
    totalImages,
    imagesWithoutAlt,
    internalLinks: internalLinkData.totalInternalLinks,
    externalLinks: externalLinksCount,
    mobileScore: mobileViewport ? 90 : 50,
    desktopScore: 85,
    robotsExists: html.includes("robots.txt"),
    sitemapExists: html.includes("sitemap.xml"),
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
    keywords,
    aiTrustScore,
    answerQualityScore: answerClarity,
    featuredSnippetChance,
    contentStructureScore: (h1Count === 1 ? 20 : 0) + (h2Count >= 3 ? 20 : 0) + (h3Count >= 5 ? 20 : 0) + (listCount >= 2 ? 20 : 0) + (tableCount >= 1 ? 20 : 0),
    h1Count,
    h2Count,
    h3Count,
    listCount,
    tableCount,
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
    aiSearchSimulation,
    aiSimulation: {
      chatgpt: aiSearchSimulation.chatgpt,
      gemini: aiSearchSimulation.gemini,
      perplexity: aiSearchSimulation.perplexity
    },
    aiRecommendations: [...new Set(aiAutopilot.map(a => a.task))],
    recommendationScore: clamp(100 - (aiAutopilot.length * 10)),
    visibilityForecast: {
      current: currentAIVisibility,
      forecast: Array.from({ length: 6 }, (_, i) => Math.min(100, Math.round(currentAIVisibility + (i * (potentialAIVisibility - currentAIVisibility) / 5))))
    },
    topicalAuthority,
    semanticSEO,
    citationOpportunities: findCitationOpportunities({ hasFAQ, hasDirectAnswer, hasAuthor, hasHowTo }),
    aiSnippets,
    trustSignals,
    localSEO,
    visibilityTrend,
    aiEntities: { 
      brands: [...new Set(entityData?.brands || [])], 
      locations: [...new Set(entityData?.locations || [])], 
      services: [...new Set(entityData?.services || [])], 
      people: [...new Set(entityData?.people || [])], 
      organizations: [...new Set(entityData?.organizations || [])], 
      products: [...new Set(entityData?.products || [])], 
      totalEntities: entityData?.totalEntities || 0 
    },
    internalLinkIntelligence: internalLinkData,
    brokenLinkCount: 0,
    lcpScore: 1200,
    aiExtractedAnswer: aiSnippets.aiOverviewAnswer,
    reasoning,
    aiReasoning: reasoning,
    aeoSimulation: {
      citationChatGPT,
      citationGemini,
      citationPerplexity,
      citationClaude,
      chatgptProbability: citationChatGPT,
      geminiProbability: citationGemini,
      perplexityProbability: citationPerplexity,
      claudeProbability: citationClaude,
      citationProbability,
      missingAnswerBlocks: simulationResult.missingAnswerBlocks,
      improvementSuggestions: simulationResult.improvementSuggestions
    }
  };

  scanCache.set(cacheKey, {
    cachedAt: Date.now(),
    payload
  });

  scanHistory.unshift({
    url: payload.meta.url,
    score: payload.overallAIVisibilityScore,
    seoScore: payload.score,
    aeoScore: payload.aeoScore,
    timestamp: new Date().toISOString()
  });
  if (scanHistory.length > 50) scanHistory.pop();

  return payload;
}

export function competitorContentGap(userData, compData) {
  if (!userData || !compData || userData.status === "blocked" || compData.status === "blocked") {
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
// ========== SECTION 6: SAAS MONETIZATION MIDDLEWARE ======================
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
    const fallbackResponse = fallbackSafePayload(targetUrl);
    fallbackResponse.warning = `You reached the limit of ${limit} scans/day for plan '${user.plan.toUpperCase()}'.`;
    return res.json(fallbackResponse);
  }

  next();
}

// =========================================================================
// ========== SECTION 7: API AND SERVING ROUTING SYSTEM ===================
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
    if (data.status === "blocked") {
      return res.json(data);
    }
    if (data.status === "error") {
      return res.status(400).json(data);
    }
    if (data.success && req.user) {
      req.user.scansToday++;
    }
    res.json(data);
  } catch (err) {
    const fb = fallbackSafePayload(normalized, err);
    res.json(fb);
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
        crawlSuccess: false,
        reason: "Comparison unavailable: One or both engines failed."
      });
    }

    if (site1.status === "blocked" || site2.status === "blocked") {
      return res.json({
        status: "blocked_page",
        success: false,
        analysisStatus: "BLOCKED",
        reason: "Comparison unavailable: Content blocked or insufficient crawl metadata.",
        sites: [
          { brand: "Blocked Site", url: normalizedUrl, pageType: site1.pageType || "BLOCKED_PAGE" },
          { brand: "Blocked Site", url: normalizedComp, pageType: site2.pageType || "BLOCKED_PAGE" }
        ]
      });
    }

    if (site1.fallbackMode || site2.fallbackMode) {
      return res.status(200).json({
        success: false,
        crawlSuccess: false,
        reason: "Comparison disabled: One or both target sites are operating in fallback mode.",
        winner: null,
        advantages: null,
        competitorAdvantage: null,
        winnerReason: "Crawl limitations prevent accurate data comparison."
      });
    }

    if (req.user) {
      req.user.scansToday = Math.min(PLAN_LIMITS[req.user.plan], req.user.scansToday + 2);
    }

    const seoAdvantage = (site1?.seoScore || 0) - (site2?.seoScore || 0);
    const aeoAdvantage = (site1?.aeoScore || 0) - (site2?.aeoScore || 0);
    const eeatAdvantage = (site1?.eeatScore || 0) - (site2?.eeatScore || 0);
    const citationAdvantage = (site1?.citationProbability || 0) - (site2?.citationProbability || 0);
    const trustAdvantage = (site1?.aiTrustScore || 0) - (site2?.aiTrustScore || 0);

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
      status: "success",
      seoScore: site1?.overallAIVisibilityScore,
      aeoScore: site1?.aeoScore,
      eeatScore: site1?.eeatScore,
      citationScore: site1?.citationScore,
      sites: [
        { brand: getBrandNameEnhanced(site1?.url, cheerio.load("<html></html>"), site1?.title, {}), url: site1?.url, aiVisibilityScore: site1?.overallAIVisibilityScore, seoScore: site1?.score, aeoScore: site1?.aeoScore },
        { brand: getBrandNameEnhanced(site2?.url, cheerio.load("<html></html>"), site2?.title, {}), url: site2?.url, aiVisibilityScore: site2?.overallAIVisibilityScore, seoScore: site2?.score, aeoScore: site2?.aeoScore }
      ],
      advantages: competitorAdvantage,
      competitorAdvantage,
      winner: site1?.overallAIVisibilityScore >= site2?.overallAIVisibilityScore ? site1 : site2,
      winnerReason: `${leaderBrand} commands clear performance leads overall.`
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
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

    if (userData.status === "blocked" || compData.status === "blocked" || userData.status === "blocked_page" || compData.status === "blocked_page") {
      return res.status(200).json({
        status: "success",
        success: false,
        analysisStatus: "BLOCKED",
        error: "One or both pages failed validation due to bot blocking parameters."
      });
    }

    if (userData.status === "error" || compData.status === "error") {
      return res.status(400).json({ error: "One or both pages failed validation" });
    }

    const gapData = competitorContentGap(userData, compData);
    
    res.json({
      status: "success",
      seoScore: userData?.seoScore,
      aeoScore: userData?.aeoScore,
      eeatScore: userData?.eeatScore,
      citationScore: userData?.citationScore,
      ...gapData,
      keywordGap: {
        competitorKeywords: gapData?.keywordGaps?.slice(0, 5) || [],
        missingKeywords: gapData?.keywordGaps?.slice(5, 10) || [],
        opportunityKeywords: gapData?.keywordGaps?.slice(10, 15) || []
      },
      gapAnalysis: {
        missingTopics: gapData?.headingGaps || []
      }
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/roadmap", authenticateAndRateLimit, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    const normalizedUrl = enforceSecureUrl(url);
    if (!normalizedUrl) return res.status(400).json({ error: "Invalid URL format" });

    const data = await analyzeSingleUrl(normalizedUrl);

    if (data.status === "blocked" || data.status === "blocked_page") {
      return res.json({
        status: "success",
        analysisStatus: "BLOCKED",
        currentScore: null,
        potentialScore: null,
        roadmap: null,
        estimatedTime: null
      });
    }

    const autopilotTasks = data?.aiAutopilot || [];
    const roadmap = autopilotTasks.map((task, i) => ({
      step: i + 1, 
      task: task?.task || 'Optimize Framework', 
      priority: task?.priority || 'MEDIUM',
      why: task?.priority === 'CRITICAL' ? 'Blocks real-time citations across ChatGPT search indexes.' : 'Boosts indexing accuracy.',
      code: task?.task?.includes('Schema') ? '<script type="application/ld+json">...</script>' : 'Modify local elements',
      impact: task?.impact || 5,
      effort: task?.effort || '15 mins'
    }));

    const totalRoadmapImpact = roadmap.reduce((acc, curr) => acc + safeNumber(curr.impact), 0);
    const currentAIVisibility = data?.overallAIVisibilityScore || 0;
    const potentialAIVisibility = Math.min(100, currentAIVisibility + totalRoadmapImpact);
    
    res.json({
      status: "success",
      seoScore: data?.seoScore,
      aeoScore: data?.aeoScore,
      eeatScore: data?.eeatScore,
      citationScore: data?.citationScore,
      currentScore: currentAIVisibility,
      potentialScore: potentialAIVisibility,
      currentAIVisibility,
      potentialAIVisibility,
      totalRoadmapImpact,
      roadmap,
      aiRoadmap: { roadmap },
      estimatedTime: `${Math.ceil(roadmap.length * 0.5)} hours`
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/history", (req, res) => {
  res.json(scanHistory);
});

// ========== GLOBAL ERROR HANDLER FOR API ROUTES ==========
app.use((err, req, res, next) => {
  console.error("UNHANDLED SYSTEM ERROR:", err);
  res.status(500).json({
    status: "error",
    error: "Internal server error inside the AI Visibility SaaS Core",
    message: err.message
  });
});

// ========== STARTUP SELF-VALIDATION ROUTINE ==========
function validateRequiredSystemHelpers() {
  console.log("🔍 System validation running...");

  const helpers = [
    { name: "cleanDomainBrand", fn: typeof cleanDomainBrand === "function" ? cleanDomainBrand : null },
    { name: "safeArray", fn: typeof safeArray === "function" ? safeArray : null },
    { name: "safeNumber", fn: typeof safeNumber === "function" ? safeNumber : null },
    { name: "safeArraySlice", fn: typeof safeArraySlice === "function" ? safeArraySlice : null },
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

validateRequiredSystemHelpers();

process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 UNCAUGHT REJECTION AT:', promise, 'REASON:', reason);
});

app.listen(PORT, () => {
  console.log(`... AI Visibility Platform v9.0 running on port ${PORT}`);
});
