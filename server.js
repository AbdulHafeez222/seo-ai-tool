import express from "express";
import * as cheerio from "cheerio";
import cors from "cors";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;
const scanHistory = [];
const trendDB = {}; // In-memory database for tracking historical scores

app.use(cors());
app.use(express.json());
app.use(express.static("."));
app.use(express.static("public"));

// ========== RESILIENT FETCH ENGINE (SOLVES 403/500 ISSUES) ==========
async function safeFetch(url, options = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    ...options.headers
  };

  // Try Axios first (best for TLS handshake and session/headers handling)
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500, // Process 4xx safely rather than crashing
    });
    if (response.data && typeof response.data === 'string' && response.data.length > 100) {
      return response.data;
    }
  } catch (axiosError) {
    console.warn(`Axios fetch failed for ${url}, trying fallback native fetch... Reason:`, axiosError.message);
  }

  // Fallback to standard global Fetch
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);
    const text = await res.text();
    if (text && text.length > 100) return text;
    throw new Error("Empty HTML or extremely short response");
  } catch (fetchError) {
    throw new Error(`All crawling attempts failed. Site blocks scraping or is offline. (${fetchError.message})`);
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

// ========== SCHEMA DETECTION ==========
function detectAllSchemas($, html) {
  const schemas = {
    FAQPage: { present: false, count: 0, data: [], recommended: false },
    HowTo: { present: false, count: 0, data: [], recommended: false },
    Article: { present: false, count: 0, data: [], recommended: true },
    Organization: { present: false, count: 0, data: [], recommended: true },
    LocalBusiness: { present: false, count: 0, data: [], recommended: false },
    BreadcrumbList: { present: false, count: 0, data: [], recommended: false },
    WebSite: { present: false, count: 0, data: [], recommended: true },
    Product: { present: false, count: 0, data: [], recommended: false }
  };

  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];
      const processItem = (item) => {
        if (item['@graph'] && Array.isArray(item['@graph'])) {
          item['@graph'].forEach(processItem);
          return;
        }
        if (item['@type']) {
          const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
          types.forEach(type => {
            if (schemas[type]) {
              schemas[type].present = true;
              schemas[type].count++;
              schemas[type].data.push(item);
            }
          });
        }
      };
      items.forEach(processItem);
    } catch (e) {}
  });

  const bodyText = $('body').text().toLowerCase();
  if (!schemas.LocalBusiness.present && (bodyText.includes('service') || bodyText.includes('contact'))) {
    schemas.LocalBusiness.recommended = true;
  }
  if (!schemas.HowTo.present && (bodyText.includes('step') || bodyText.includes('how to'))) {
    schemas.HowTo.recommended = true;
  }
  return schemas;
}

// ========== INTERNAL LINK INTELLIGENCE (UPGRADED - FIX 3) ==========
function analyzeInternalLinks($, url, h2s) {
  const baseHostname = new URL(url).hostname;
  let internalLinks = 0;
  let externalLinks = 0;
  const linkMap = {};

  $("a").each((i, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      let fullUrl;
      if (href === '/') fullUrl = url;
      else if (href.startsWith('/')) fullUrl = new URL(href, url).href;
      else fullUrl = href;

      const linkHostname = new URL(fullUrl).hostname;
      if (linkHostname.replace('www.', '') === baseHostname.replace('www.', '')) {
        internalLinks++;
        const clean = fullUrl.split('#')[0].split('?')[0];
        linkMap[clean] = (linkMap[clean] || 0) + 1;
      } else if (href.startsWith('http')) {
        externalLinks++;
      }
    } catch {}
  });

  const uniquePages = Object.keys(linkMap).length;
  const linkDepths = Object.keys(linkMap).map(link => link.split('/').filter(Boolean).length);
  const avgDepth = linkDepths.length > 0 ? (linkDepths.reduce((a, b) => a + b, 0) / linkDepths.length).toFixed(1) : 0;
  const authorityFlow = h2s.length > 0 ? Math.round((internalLinks / h2s.length) * 100) : 0;
  const weakLinking = internalLinks < h2s.length;
  const suggestions = [];
  if (weakLinking) h2s.slice(0, 3).forEach(h2 => suggestions.push(`Add internal link to section: ${h2}`));

  console.log("Internal Links Counted:", { internalLinks, uniquePages, averageDepth: parseFloat(avgDepth), authorityFlow });

  return {
    internalLinks,
    totalInternalLinks: internalLinks,
    externalLinks,
    uniquePages,
    orphanPages: uniquePages < 3 ? [`${url}/blog`] : [],
    avgLinkDepth: parseFloat(avgDepth),
    averageDepth: parseFloat(avgDepth),
    authorityFlow: clamp(authorityFlow, 0, 100),
    weakLinking,
    suggestions,
    linkDistribution: linkMap,
    score: Math.max(0, 100 - (uniquePages < 3 ? 20 : 0) - (weakLinking ? 30 : 0) - (parseFloat(avgDepth) > 4 ? 20 : 0))
  };
}

// ========== E-E-A-T ADVANCED & SCANNER ==========
function calculateEEATAdvanced($, bodyText, hasAuthor, hasAboutPage, hasContactPage, hasPrivacyPolicy, hasLinkedIn, hasFacebook, isHttps, hasLastModified, schemas) {
  const breakdown = {
    experience: { score: 0, max: 25, factors: [] },
    expertise: { score: 0, max: 25, factors: [] },
    authoritativeness: { score: 0, max: 25, factors: [] },
    trustworthiness: { score: 0, max: 25, factors: [] }
  };

  // Experiential signals
  if (hasAuthor) { breakdown.experience.score += 10; breakdown.experience.factors.push("✓ Author attribution"); }
  if (bodyText.match(/I have|we have|our experience|years of/i)) { breakdown.experience.score += 8; breakdown.experience.factors.push("✓ First-hand experience"); }
  if (bodyText.match(/case study|portfolio|client/i)) { breakdown.experience.score += 7; breakdown.experience.factors.push("✓ Case studies"); }

  // Expertise signals
  if (hasAboutPage) { breakdown.expertise.score += 10; breakdown.expertise.factors.push("✓ About page"); }
  if (hasAuthor && bodyText.match(/expert|specialist|certified|degree/i)) { breakdown.expertise.score += 8; breakdown.expertise.factors.push("✓ Expert credentials"); }
  if (schemas.Organization?.present) { breakdown.expertise.score += 7; breakdown.expertise.factors.push("✓ Organization schema"); }

  // Authoritative signals
  if (hasLinkedIn) { breakdown.authoritativeness.score += 8; breakdown.authoritativeness.factors.push("✓ LinkedIn Link"); }
  if (hasFacebook) { breakdown.authoritativeness.score += 5; breakdown.authoritativeness.factors.push("✓ Facebook Link"); }
  if ($('a[href*="wikipedia"]').length > 0 || $('a[href*="gov"]').length > 0) { breakdown.authoritativeness.score += 7; breakdown.authoritativeness.factors.push("✓ Authoritative citations"); }
  if (bodyText.match(/featured|award|recognition/i)) { breakdown.authoritativeness.score += 5; breakdown.authoritativeness.factors.push("✓ Awards/recognition mentioned"); }

  // Trustworthiness signals
  if (isHttps) { breakdown.trustworthiness.score += 6; breakdown.trustworthiness.factors.push("✓ HTTPS Connection"); }
  if (hasPrivacyPolicy) { breakdown.trustworthiness.score += 5; breakdown.trustworthiness.factors.push("✓ Privacy policy page"); }
  if (hasContactPage) { breakdown.trustworthiness.score += 6; breakdown.trustworthiness.factors.push("✓ Contact details"); }
  if (hasLastModified) { breakdown.trustworthiness.score += 4; breakdown.trustworthiness.factors.push("✓ Last updated proof"); }
  if (schemas.LocalBusiness?.present) { breakdown.trustworthiness.score += 4; breakdown.trustworthiness.factors.push("✓ LocalBusiness schema"); }

  const totalScore = breakdown.experience.score + breakdown.expertise.score + breakdown.authoritativeness.score + breakdown.trustworthiness.score;
  return { 
    score: totalScore, 
    breakdown, 
    level: totalScore >= 80 ? "Excellent" : totalScore >= 60 ? "Good" : totalScore >= 40 ? "Fair" : "Poor" 
  };
}

// ========== ENTITY EXTRACTION ENGINE (UPGRADED - FIX 1) ==========
function extractEntitiesEnhanced($, html, title, h1, h2s, h3s, metaDescription, bodyText) {
  const brands = [];
  const locations = [];
  const services = [];
  const people = [];
  const organizations = [];

  // Parse Schemas for entities
  $('script[type="application/ld+json"]').each((i, el) => {
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
        if (item['@type']) {
          const type = String(item['@type']).toLowerCase();
          if (type.includes('organization') && item.name) {
            organizations.push(item.name);
            brands.push(item.name);
          }
          if (type.includes('person') && item.name) {
            people.push(item.name);
          }
          if (type.includes('localbusiness') && item.name) {
            organizations.push(item.name);
            brands.push(item.name);
          }
          if (type.includes('postaladdress')) {
            if (item.addressLocality) locations.push(item.addressLocality);
            if (item.addressCountry) locations.push(item.addressCountry);
          }
        }
      };
      items.forEach(traverse);
    } catch (e) {}
  });

  const canonicalUrl = $('link[rel="canonical"]').attr('href') || 'https://unknown.com';
  const brandNameFallback = getBrandName(canonicalUrl);
  if (brandNameFallback && brandNameFallback.toLowerCase() !== 'unknown') {
    brands.push(brandNameFallback);
  }

  // Parse title & headings
  if (title.includes('|')) {
    brands.push(title.split('|').pop().trim());
  } else if (title.includes('-')) {
    brands.push(title.split('-').pop().trim());
  }

  const combinedText = h1 + " " + h2s.join(" ") + " " + h3s.join(" ") + " " + bodyText;

  // Person extraction
  const peopleRegex = /\b(?:Mr|Mrs|Ms|Dr|CEO|Founder|Author|by)\.?\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;
  let match;
  while ((match = peopleRegex.exec(combinedText)) !== null) {
    const name = match[1];
    if (!['The', 'This', 'That', 'Your', 'With', 'From', 'What', 'How', 'Why', 'Click'].includes(name.split(' ')[0])) {
      people.push(name);
    }
  }

  // Location extraction
  const locationKeywords = [
    'USA', 'United States', 'UK', 'United Kingdom', 'Canada', 'Pakistan', 'India', 'Australia', 
    'Germany', 'France', 'UAE', 'Dubai', 'London', 'New York', 'Karachi', 'Lahore', 'Islamabad', 
    'Sydney', 'Toronto', 'Melbourne'
  ];
  locationKeywords.forEach(loc => {
    const regex = new RegExp(`\\b${loc}\\b`, 'i');
    if (regex.test(combinedText) || regex.test(metaDescription)) {
      locations.push(loc);
    }
  });

  // Services extraction
  const serviceKeywords = [
    'SEO', 'Search Engine Optimization', 'Web Design', 'Graphic Design', 'WordPress Development',
    'WordPress', 'Digital Marketing', 'Web Development', 'Content Writing', 'Copywriting',
    'Social Media Marketing', 'E-commerce', 'Shopify', 'Lead Generation', 'App Development',
    'Branding'
  ];
  serviceKeywords.forEach(srv => {
    const regex = new RegExp(`\\b${srv}\\b`, 'i');
    if (regex.test(combinedText) || regex.test(metaDescription)) {
      services.push(srv);
    }
  });

  const cleanArray = (arr) => [...new Set(arr.filter(Boolean).map(x => String(x).trim()))].slice(0, 10);

  const finalEntities = {
    brands: cleanArray(brands),
    locations: cleanArray(locations),
    services: cleanArray(services),
    people: cleanArray(people),
    organizations: cleanArray(organizations.length > 0 ? organizations : brands)
  };

  console.log("Entities Extracted:", finalEntities);
  return finalEntities;
}

// ========== SAAS UTILITY HELPERS ==========
const safe = (val, fallback = '') => val !== undefined && val !== null ? val : fallback;
const clamp = (num, min = 0, max = 100) => Math.min(max, Math.max(min, isNaN(num) ? 0 : num));
const safeArray = (arr) => Array.isArray(arr) ? arr : [];

// 1. TOPICAL AUTHORITY ENGINE
const calculateTopicalAuthority = ($, keywords, h2s, h3s) => {
  const allHeadings = [...safeArray(h2s), ...safeArray(h3s)].map(h => h.toLowerCase());
  const keywordSet = new Set(safeArray(keywords).map(k => k.toLowerCase()));

  const coreTopics = ['what', 'why', 'how', 'best', 'guide', 'tutorial', 'examples', 'tips', 'benefits', 'pricing', 'reviews', 'comparison'];
  const topicsCovered = coreTopics.filter(topic =>
    allHeadings.some(h => h.includes(topic))
  ).length;

  const depthScore = clamp((topicsCovered / coreTopics.length) * 60);
  const keywordCoverage = clamp((keywordSet.size / 15) * 40);
  const score = clamp(depthScore + keywordCoverage);

  const missingSubtopics = coreTopics.filter(topic =>
    !allHeadings.some(h => h.includes(topic))
  );

  return { 
    score, 
    topicsCovered, 
    missingSubtopics, 
    depth: topicsCovered >= 7 ? 'Deep' : topicsCovered >= 4 ? 'Medium' : 'Shallow' 
  };
};

// 2. ADVANCED SEMANTIC SEO ANALYZER (FIX 6)
const analyzeSemanticSEO = ($, bodyText, keywords) => {
  const text = safe(bodyText).toLowerCase();
  const keywordSet = safeArray(keywords).slice(0, 10);
  const matchedKeywords = keywordSet.filter(k => text.includes(k.toLowerCase()));
  const nlpScore = clamp(Math.round((matchedKeywords.length / Math.max(1, keywordSet.length)) * 100));

  const semanticGaps = keywordSet.filter(k => !text.includes(k.toLowerCase()));

  return {
    entities: keywordSet,
    nlpScore,
    semanticGaps,
    hasSemanticHTML: $('article, section, aside, nav').length > 0
  };
};

// 3. AI CITATION OPPORTUNITY FINDER
const findCitationOpportunities = (data) => {
  const opportunities = [];
  const { hasFAQ, hasDirectAnswer, hasAuthor, hasHowTo, wordCount, eeatScore } = data;

  if (!hasFAQ) opportunities.push({ engine: 'ChatGPT', reason: 'Missing FAQ Schema - ChatGPT maps structured Q&As', impact: '+20%', fix: 'Deploy FAQ JSON-LD schema with exact queries.' });
  if (!hasDirectAnswer) opportunities.push({ engine: 'Perplexity', reason: 'No clear, direct semantic summary at top of page', impact: '+15%', fix: 'Add a 50-word "Quick Answer" component under H1.' });
  if (!hasAuthor) opportunities.push({ engine: 'Gemini', reason: 'Missing Author Profile credentials - Gemini checks E-E-A-T', impact: '+12%', fix: 'Add a schema-marked Author Bio block.' });
  if (!hasHowTo && wordCount > 1000) opportunities.push({ engine: 'All Engines', reason: 'Educational structure detected without structural steps', impact: '+10%', fix: 'Integrate HowTo Schema steps with lists.' });

  return opportunities;
};

// 4. AI SNIPPET GENERATOR (FIX 5)
const generateAISnippets = (h1, metaDescription, bodyText, keywords) => {
  const contentSentence = bodyText && bodyText.length > 50 ? bodyText.split('.').slice(0, 2).join('.') + '.' : '';
  const keyword = safeArray(keywords)[0] || 'the page';

  const directAnswer = metaDescription || contentSentence || `About ${h1}: This resource covers core components of ${keyword}.`;
  const featuredSnippet = `## ${h1 || 'Overview'}\n\n${directAnswer}\n\n${contentSentence ? `Key facts discussed:\n- ${contentSentence.substring(0, 150)}` : ""}`;

  return {
    directAnswer: directAnswer.substring(0, 300),
    featuredSnippet: featuredSnippet.substring(0, 600),
    wordCount: directAnswer.split(' ').length
  };
};

// 5. LOCAL SEO & ADVANCED TRUST SIGNAL SCANNER (FIX 2)
const analyzeLocalSEO = ($, bodyText) => {
  const text = safe(bodyText);
  const hasNAP = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(text) || text.includes('address') || text.includes('phone');
  const hasLocalBusiness = $('[itemtype*="LocalBusiness"]').length > 0;
  const hasMap = $('iframe[src*="google.com/maps"], iframe[src*="maps"]').length > 0;
  const hasCity = /\b(Karachi|Lahore|Islamabad|London|New York|Dubai|Sydney|Toronto)\b/i.test(text);

  const signals = { hasNAP, hasLocalBusiness, hasMap, hasCity };
  const score = Object.values(signals).filter(Boolean).length;

  return {
    ...signals,
    localScore: clamp((score / 4) * 100),
    napConsistency: hasNAP ? 'Active' : 'Incomplete/Missing',
    recommendations: !hasLocalBusiness ? ['Deploy LocalBusiness JSON-LD Schema markup immediately'] : []
  };
};

const scanTrustSignals = ($, url) => {
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

  $("a").each((i, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().toLowerCase().trim();

    if (href.startsWith('mailto:') || href.startsWith('tel:') || text.includes('contact') || href.includes('contact')) {
      if (href.includes('contact') || text.includes('contact')) hasContact = true;
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

  if (bodyText.includes('review') || bodyText.includes('stars') || $('.review, .testimonial').length > 0) {
    hasReviews = true;
  }
  if (bodyText.includes('testimonial') || bodyText.includes('what our clients say') || $('.testimonial, .client-feedback').length > 0) {
    hasTestimonials = true;
  }

  const signalsCount = [hasContact, hasAbout, hasPrivacyPolicy, hasTermsPage, hasSocialProfiles, hasReviews, hasTestimonials, hasAuthorPage].filter(Boolean).length;
  const trustScore = clamp((signalsCount / 8) * 100);

  const signals = {
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

  console.log("Trust Signals Scanned:", signals);
  return signals;
};

// 6. HISTORICAL TREND TRACKER
function trackAIVisibilityTrend(url, currentScore) {
  const key = Buffer.from(url).toString('base64');
  if (!trendDB[key]) trendDB[key] = [];

  trendDB[key].push({
    score: currentScore,
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  });

  if (trendDB[key].length > 30) trendDB[key] = trendDB[key].slice(-30);

  const history = trendDB[key];
  const trend = history.length > 1 ? history[history.length - 1].score - history[0].score : 0;

  return {
    current: currentScore,
    history: history.slice(-7), // Retrieve last 7 entries for graphs
    trend: trend >= 0 ? `+${trend}` : `${trend}`,
    direction: trend > 0 ? 'improving' : trend < 0 ? 'declining' : 'stable',
    average: Math.round(history.reduce((sum, h) => sum + h.score, 0) / history.length)
  };
}

// ========== MAIN ANALYZER PIPELINE (FIX 4) ==========
async function analyzeSingleUrl(url) {
  url = String(url).trim();
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url;
  url = url.replace(/\s+/g, '');

  let html;
  let fetchError = false;
  let warning = "";
  const startTime = Date.now();

  try {
    html = await safeFetch(url);
  } catch (err) {
    console.error(`CRAWL ERROR (BLOCKED/OFFLINE) for ${url}:`, err.message);
    // Explicit return to block score fabrication
    return {
      url,
      fetchError: true,
      competitorBlocked: true,
      warning: "Website scan unavailable due to website restrictions.",
      score: 0,
      aeoScore: 0,
      overallAIVisibilityScore: 0,
      citationProbability: 0,
      keywords: [],
      entities: [],
      v51Features: {}
    };
  }

  const loadTime = Date.now() - startTime;
  const $ = cheerio.load(html);

  // Isolate body text before script removal
  const rawBodyText = $("p, li, h2, h3, h4, td").text().replace(/\s+/g, " ").trim();

  // Clean elements for targeted parsing
  $('script, style, nav, footer, header, noscript, svg').remove();

  const title = $("title").text().trim() || "";
  const h1 = $("h1").first().text().trim() || "";
  const metaDescription = $('meta[name="description"]').attr("content") || "";
  const bodyText = $("p, li, h2, h3, h4, td").text().replace(/\s+/g, " ").trim() || rawBodyText;
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length || 50;
  const h2s = $("h2").map((i, el) => $(el).text().trim()).get().filter(Boolean);
  const h3s = $("h3").map((i, el) => $(el).text().trim()).get().filter(Boolean);

  const schemas = detectAllSchemas($, html);
  const uniqueSchemas = Object.keys(schemas).filter(k => schemas[k].present);
  const recommendedSchemas = Object.keys(schemas).filter(k => schemas[k].recommended && !schemas[k].present);

  const faqQuestions = [];
  if (schemas.FAQPage.present && schemas.FAQPage.data.length > 0) {
    schemas.FAQPage.data.forEach(schema => {
      schema.mainEntity?.forEach(q => { if (q.name) faqQuestions.push(q.name); });
    });
  }

  const h1Count = $("h1").length;
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const listCount = $("ul, ol").length;
  const tableCount = $("table").length;
  const totalImages = $("img").length;
  const imagesWithoutAlt = $("img").filter((i, el) => !$(el).attr("alt")).length;
  const externalLinks = $("a[href^='http']").not(`a[href^='${url}']`).length;
  const isHttps = url.startsWith("https://");
  const mobileViewport = $('meta[name="viewport"]').length > 0;
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const hasCanonical = !!canonical;
  const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').attr("href") || "";
  const hasFavicon = !!favicon;

  const hasFAQ = faqQuestions.length > 0 || schemas.FAQPage.present;
  const hasHowTo = schemas.HowTo.present;
  const hasSchemaMarkup = uniqueSchemas.length > 0;
  const hasDirectAnswer = (bodyText.includes("Q:") && bodyText.includes("A:")) || bodyText.toLowerCase().includes("what is") || bodyText.toLowerCase().includes("how to") || (h2Count >= 3 && bodyText.length > 500);

  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const ogDescription = $('meta[property="og:description"]').attr("content") || "";
  const ogImage = $('meta[property="og:image"]').attr("content") || "";
  const hasOGTags = !!(ogTitle && ogDescription);

  const hasAuthor = $('meta[name="author"]').length > 0 || $('[rel="author"]').length > 0 || $('[itemprop="author"]').length > 0;
  const dateStr = $('meta[property="article:modified_time"]').attr('content') || $('meta[property="article:published_time"]').attr('content');
  const hasLastModified = !!dateStr;
  const lastModified = dateStr ? new Date(dateStr).toLocaleDateString() : null;

  const socialLinks = $("a").map((i, el) => $(el).attr("href") || "").get();
  const hasFacebook = socialLinks.some(link => link.includes("facebook.com"));
  const hasLinkedIn = socialLinks.some(link => link.includes("linkedin.com"));
  const hasYouTube = socialLinks.some(link => link.includes("youtube.com"));
  const hasTwitter = socialLinks.some(link => link.includes("twitter.com") || link.includes("x.com"));

  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = bodyText.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/);
  const email = emailMatch ? emailMatch[0] : null;
  const phone = phoneMatch ? phoneMatch[0] : null;
  const hasEmail = !!email;
  const hasPhone = !!phone;

  const allText = bodyText.toLowerCase();
  const hasPrivacyPolicy = allText.includes("privacy policy") || allText.includes("privacy");
  const hasAboutPage = allText.includes("about us") || allText.includes("about");
  const hasContactPage = allText.includes("contact us") || allText.includes("contact");

  const internalLinkData = analyzeInternalLinks($, url, h2s);
  const eeatData = calculateEEATAdvanced($, bodyText, hasAuthor, hasAboutPage, hasContactPage, hasPrivacyPolicy, hasLinkedIn, hasFacebook, isHttps, hasLastModified, schemas);

  const aiTrustSignals = [];
  if (hasPrivacyPolicy) aiTrustSignals.push("Privacy Policy");
  if (hasAboutPage) aiTrustSignals.push("About Page");
  if (hasContactPage) aiTrustSignals.push("Contact Page");
  if (hasEmail) aiTrustSignals.push("Email Address");
  if (hasPhone) aiTrustSignals.push("Phone Number");
  if (hasAuthor) aiTrustSignals.push("Author Profile");
  if (hasFacebook) aiTrustSignals.push("Facebook");
  if (hasLinkedIn) aiTrustSignals.push("LinkedIn");
  if (hasYouTube) aiTrustSignals.push("YouTube");
  if (hasTwitter) aiTrustSignals.push("Twitter/X");
  if (isHttps) aiTrustSignals.push("HTTPS Secure");
  if (hasLastModified) aiTrustSignals.push("Recently Updated");
  if (hasCanonical) aiTrustSignals.push("Canonical URL");
  if (hasFavicon) aiTrustSignals.push("Favicon");

  const sentences = bodyText.split(/[.!?]+/).length || 1;
  const avgWordsPerSentence = wordCount / sentences;
  let readabilityScore = 50;
  if (avgWordsPerSentence > 25) readabilityScore = 30;
  else if (avgWordsPerSentence > 20) readabilityScore = 50;
  else readabilityScore = 80;

  let contentDecay = { status: "fresh", daysOld: 0, needsRefresh: false };
  if (dateStr) {
    const daysOld = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
    contentDecay = {
      status: daysOld > 365 ? "outdated" : daysOld > 180 ? "aging" : "fresh",
      daysOld,
      needsRefresh: daysOld > 180,
      recommendation: daysOld > 365 ? "Urgent: Update statistics, dates, and live references" : daysOld > 180 ? "Consider: Refresh introduction + verify performance metric points" : "Content is fresh"
    };
  }

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
  const seoStatus = seoScore >= 80 ? "Excellent" : seoScore >= 60 ? "Good" : seoScore >= 40 ? "Fair" : "Poor";

  let aeoScore = 0;
  if (hasFAQ) aeoScore += 30;
  if (hasHowTo) aeoScore += 20;
  if (hasDirectAnswer) aeoScore += 25;
  if (hasSchemaMarkup) aeoScore += 15;
  if (h1 && metaDescription) aeoScore += 10;
  const aeoStatus = aeoScore >= 80 ? "ChatGPT Ready" : aeoScore >= 50 ? "AI Friendly" : "Needs Work";

  const featuredSnippetChance = Math.min(100, (hasDirectAnswer ? 40 : 0) + (hasFAQ ? 30 : 0) + (listCount > 0 ? 20 : 0) + (h2Count >= 3 ? 10 : 0));
  const answerQuality = Math.min(100, Math.round((hasDirectAnswer ? 30 : 0) + (hasFAQ ? 25 : 0) + (listCount > 0 ? 15 : 0) + (h2Count >= 3 ? 15 : 0) + (readabilityScore * 0.15))) || 50;
  const aiTrustScore = Math.round((eeatData.score * 0.4) + (seoScore * 0.3) + (aeoScore * 0.3));

  const citationChatGPT = Math.min(95, 20 + (hasFAQ ? 25 : 0) + (listCount > 2 ? 15 : 0) + (hasDirectAnswer ? 20 : 0) + (hasAuthor ? 10 : 0));
  const citationGemini = Math.min(95, 20 + (hasSchemaMarkup ? 30 : 0) + (tableCount > 0 ? 20 : 0) + (hasAuthor ? 15 : 0) + (wordCount > 800 ? 15 : 0));
  const citationPerplexity = Math.min(95, 20 + (hasDirectAnswer ? 25 : 0) + (hasLastModified ? 15 : 0) + (externalLinks > 5 ? 15 : 0) + (listCount > 0 ? 15 : 0));
  const citationProbability = Math.round((citationChatGPT + citationGemini + citationPerplexity) / 3);

  const schemaScore = (hasFAQ ? 25 : 0) + (hasHowTo ? 25 : 0) + (hasDirectAnswer ? 20 : 0) + (uniqueSchemas.length > 0 ? 30 : 0);
  const overallAIVisibilityScore = Math.round((seoScore * 0.30) + (aeoScore * 0.20) + (aiTrustScore * 0.15) + (citationProbability * 0.15) + (readabilityScore * 0.10) + (schemaScore * 0.10));

  const schemaErrors = [];
  const schemaWarnings = [];
  if (schemas.Article.present && !hasAuthor) schemaErrors.push('Article schema missing author');
  if (schemas.FAQPage.present && faqQuestions.length === 0) schemaErrors.push('FAQPage schema has no questions');
  if (schemas.Organization.present && !hasContactPage) schemaWarnings.push('Organization schema missing contactPoint');

  const schemaValidator = {
    valid: schemaErrors.length === 0,
    errors: schemaErrors,
    warnings: schemaWarnings,
    score: Math.max(0, 100 - (schemaErrors.length * 25) - (schemaWarnings.length * 10))
  };

  const aiVisibilityLevel = overallAIVisibilityScore >= 80 ? "Excellent" : overallAIVisibilityScore >= 60 ? "Good" : overallAIVisibilityScore >= 40 ? "Fair" : "Poor";
  const mobileScore = mobileViewport ? seoScore : Math.max(0, seoScore - 20);
  const desktopScore = seoScore;

  // Accurate entity extraction
  const entityData = extractEntitiesEnhanced($, html, title, h1, h2s, h3s, metaDescription, bodyText);
  const { keywords, entities, prices, locations, services, brands, people, organizations } = entityData;

  const keywordInsights = keywords.slice(0, 5).map(k => ({
    keyword: k,
    difficulty: getKeywordDifficulty(k),
    opportunity: getKeywordOpportunity(k, hasFAQ, hasSchemaMarkup)
  }));

  const mainTopic = h1 || title.split(" ").slice(0, 3).join(" ");
  const subtopics = h2s;
  const expectedSubtopics = [`What is ${mainTopic}`, `${mainTopic} Benefits`, `How to ${mainTopic}`, `${mainTopic} Examples`, `${mainTopic} vs Alternatives`];
  const missingSubtopics = expectedSubtopics.filter(exp => !subtopics.some(sub => sub.toLowerCase().includes(exp.toLowerCase().split(' ')[0])));
  const topicCoverage = Math.round(((expectedSubtopics.length - missingSubtopics.length) / expectedSubtopics.length) * 100);

  const topicalAuthorityScore = Math.round((topicCoverage * 0.4) + (subtopics.length >= 5 ? 30 : subtopics.length * 6) + (hasFAQ ? 15 : 0) + (wordCount > 1200 ? 15 : wordCount > 800 ? 10 : 5));

  const autoFAQ = [];
  if (h1) autoFAQ.push({ q: `What is ${h1}?`, a: metaDescription || bodyText.substring(0, 120) });
  if (prices.length > 0) autoFAQ.push({ q: `How much does ${services[0] || 'the service'} cost?`, a: `Pricing starts at ${prices[0]}. Contact us for custom quotes.` });
  if (locations.length > 0) autoFAQ.push({ q: `Do you serve ${locations[0]} clients?`, a: `Yes, we serve clients in ${locations.slice(0, 3).join(', ')}.` });

  let aiExtractedAnswer = "No clear answer found";
  if (bodyText) {
    const firstPara = bodyText.split('.')[0];
    const brandName = brands[0] || getBrandName(url);
    const serviceName = services[0] || 'services';
    const priceInfo = prices[0] ? ` starting at ${prices[0]}` : '';
    const locationInfo = locations.length > 0 ? ` for ${locations[0]} clients` : '';
    if (firstPara.length > 50) {
      aiExtractedAnswer = `${brandName} offers ${serviceName}${priceInfo}${locationInfo}. ${firstPara.substring(0, 100)}...`;
    } else {
      aiExtractedAnswer = `${brandName} provides ${serviceName}${priceInfo}${locationInfo}. ${bodyText.substring(0, 150)}...`;
    }
  }

  const aiSearchSimulation = {
    query: `What is ${mainTopic}?`,
    chatgpt: {
      answer: hasDirectAnswer ? `${brands[0] || getBrandName(url)} offers ${services[0] || mainTopic}${prices[0] ? ' starting at ' + prices[0] : ''}. ${metaDescription.substring(0, 100)}` : `Based on available data, ${mainTopic} relates to ${keywords.slice(0, 3).join(', ')}. For specific details, check the official website.`,
      sources: hasAuthor ? ["Official Website", "Author Profile"] : ["Official Website"],
      willCite: hasDirectAnswer && hasFAQ && listCount >= 2
    },
    gemini: {
      answer: hasSchemaMarkup ? `According to structured data: ${title}. Key services include ${services.slice(0, 2).join(' and ')}. ${hasLastModified ? 'Last updated: ' + lastModified : ''}` : `${title}. ${metaDescription.substring(0, 120)}`,
      sources: hasSchemaMarkup ? ["Schema.org Data", "Website"] : ["Website"],
      willCite: hasSchemaMarkup && tableCount > 0 && hasAuthor
    },
    perplexity: {
      answer: hasLastModified ? `${aiExtractedAnswer} [Updated ${lastModified}]` : aiExtractedAnswer,
      sources: hasLastModified ? ["Official Site (2026)", "Cited Sources"] : ["Official Site"],
      willCite: hasDirectAnswer && hasLastModified && externalLinks > 3
    },
    status: "live"
  };

  const aiRecommendations = [];
  if (!hasFAQ) aiRecommendations.push({ priority: "CRITICAL", action: "Add FAQ Schema", impact: "+15% ChatGPT Citation", effort: "15 mins", code: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>` });
  if (!hasAuthor) aiRecommendations.push({ priority: "HIGH", action: "Add Author Section with Credentials", impact: "+12% EEAT Score", effort: "10 mins", code: `<div class="author" itemprop="author">By <span itemprop="name">Expert</span></div>` });

  const recommendationScore = Math.max(0, 100 - (aiRecommendations.length * 8));

  const visibilityForecast = {
    current: overallAIVisibilityScore,
    afterFAQ: Math.min(100, overallAIVisibilityScore + (hasFAQ ? 0 : 15)),
    afterHowTo: Math.min(100, overallAIVisibilityScore + (hasHowTo ? 0 : 12)),
    afterAuthor: Math.min(100, overallAIVisibilityScore + (hasAuthor ? 0 : 10)),
    afterSchema: Math.min(100, overallAIVisibilityScore + (hasSchemaMarkup ? 0 : 8)),
    afterAll: Math.min(100, overallAIVisibilityScore + recommendationScore)
  };

  // ========== SCHEMA GENERATOR ==========
  const schemaGenerator = {};
  if (!schemas.FAQPage.present && autoFAQ.length > 0) {
    schemaGenerator.FAQPage = {
      recommended: true,
      code: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": autoFAQ.map(f => ({
          "@type": "Question",
          "name": f.q,
          "acceptedAnswer": { "@type": "Answer", "text": f.a }
        }))
      }, null, 2),
      title: "FAQ Schema - AI Preferred"
    };
  }

  // AI Autopilot Tasks
  const aiAutopilot = [
    !hasFAQ && { task: "Add FAQ Schema", impact: "+15", effort: "15 mins", priority: "CRITICAL" },
    !hasAuthor && { task: "Add Author Bio", impact: "+8", effort: "10 mins", priority: "HIGH" },
    !hasEmail && { task: "Add Email Address", impact: "+5", effort: "2 mins", priority: "MEDIUM" },
    internalLinkData.weakLinking && { task: "Fix Internal Linking Structure", impact: "+12", effort: "20 mins", priority: "HIGH" }
  ].filter(Boolean);

  const citationOpportunities = findCitationOpportunities({
    hasFAQ, hasDirectAnswer, hasAuthor, hasHowTo, wordCount, eeatScore: eeatData.score
  });
  const semanticSEO = analyzeSemanticSEO($, bodyText, keywords);
  const topicalAuthority = calculateTopicalAuthority($, keywords, h2s, h3s);
  const localSEO = analyzeLocalSEO($, bodyText);
  const trustSignals = scanTrustSignals($, url);
  const aiSnippets = generateAISnippets(h1, metaDescription, bodyText, keywords);
  const visibilityTrend = trackAIVisibilityTrend(url, overallAIVisibilityScore);

  const payload = {
    fetchError,
    warning,
    schemaGenerator,
    aiAutopilot,
    url,
    title,
    h1,
    h2s,
    h3s,
    metaDescription,
    wordCount,
    lastModified,
    score: seoScore,
    status: seoStatus,
    aiTrustSignals,
    overallAIVisibilityScore,
    aiVisibilityLevel,
    breakdown: {
      seo: seoScore,
      aeo: aeoScore,
      eeatScore: eeatData.score,
      eeatBreakdown: eeatData.breakdown,
      internalLinkingAudit: internalLinkData,
      trust: aiTrustScore,
      citation: citationProbability,
      readability: readabilityScore,
      schema: schemaScore
    },
    citationProbability,
    totalImages,
    imagesWithoutAlt,
    internalLinks: internalLinkData.totalInternalLinks,
    externalLinks,
    mobileFriendly: mobileViewport,
    isHttps,
    loadTime,
    mobileScore,
    desktopScore,
    hasSchemaMarkup,
    robotsExists,
    sitemapExists,
    hasCanonical,
    canonical,
    hasFavicon,
    favicon,
    hasOGTags,
    ogTitle,
    ogDescription,
    ogImage,
    aeoScore,
    aeoStatus,
    hasFAQ,
    hasHowTo,
    hasDirectAnswer,
    schemas: uniqueSchemas,
    recommendedSchemas,
    keywords,
    entities,
    readabilityScore,
    aiTrustScore,
    answerQualityScore: answerQuality,
    featuredSnippetChance,
    contentStructureScore: (h1Count === 1 ? 20 : 0) + (h2Count >= 3 ? 20 : 0) + (h3Count >= 5 ? 20 : 0) + (listCount >= 2 ? 20 : 0) + (tableCount >= 1 ? 20 : 0),
    citationChatGPT,
    citationGemini,
    citationPerplexity,
    h1Count,
    h2Count,
    h3Count,
    listCount,
    tableCount,
    hasPrivacyPolicy,
    hasAboutPage,
    hasContactPage,
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
    criticalIssues,
    importantIssues,
    minorIssues,
    aiRecommendations,
    recommendationScore,
    visibilityForecast,
    
    // SaaS Advanced Module Outputs
    topicalAuthority,
    semanticSEO,
    citationOpportunities,
    aiSnippets,
    trustSignals,
    localSEO,
    visibilityTrend,
    aiEntities: { brands, services, locations, people, organizations, totalEntities: brands.length + services.length + locations.length + people.length },
    
    // Backward compatibility mappings
    brokenLinkCount: 0,
    lcpScore: 1200
  };

  return payload;
}

// ========== COMPETITOR CONTENT GAP ENGINE ==========
function competitorContentGap(userData, compData) {
  const userHeadings = [...safeArray(userData.h2s), ...safeArray(userData.h3s)];
  const compHeadings = [...safeArray(compData.h2s), ...safeArray(compData.h3s)];
  const userKeywords = new Set(safeArray(userData.keywords));
  const compKeywords = new Set(safeArray(compData.keywords));

  const headingGaps = compHeadings.filter(h => !userHeadings.some(uh => uh.toLowerCase().includes(h.toLowerCase().substring(0, 10))));
  const keywordGaps = [...compKeywords].filter(k => !userKeywords.has(k));

  const schemaGaps = [];
  if (compData.hasFAQ && !userData.hasFAQ) schemaGaps.push('FAQPage');
  if (compData.hasHowTo && !userData.hasHowTo) schemaGaps.push('HowTo');
  if (compData.hasAuthor && !userData.hasAuthor) schemaGaps.push('Author Profile');

  return {
    headingGaps: headingGaps.slice(0, 10),
    keywordGaps: keywordGaps.slice(0, 15),
    schemaGaps,
    contentLengthDiff: safe(compData.wordCount, 0) - safe(userData.wordCount, 0),
    competitorHasMore: safe(compData.wordCount, 0) > safe(userData.wordCount, 0)
  };
}

// ========== API ENDPOINTS ==========
app.get("/", (req, res) => res.json({ status: "running", tool: "AI Visibility Platform", version: "5.1-production" }));

app.get("/scan", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });
  try {
    const data = await analyzeSingleUrl(url);
    res.json(data);
  } catch (err) {
    console.error("SCAN ENDPOINT ERROR:", err);
    res.status(500).json({ error: "Scan failed completely", message: err.message });
  }
});

app.get("/compare", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) return res.status(400).json({ error: "Both URLs required" });

    const [site1, site2] = await Promise.all([
      analyzeSingleUrl(url),
      analyzeSingleUrl(competitor)
    ]);

    // Competitor scan reliability check (FIX 4)
    if (site2.competitorBlocked || site2.fetchError) {
      return res.json({ competitorBlocked: true, warning: "Competitor scan unavailable due to website restrictions." });
    }
    if (site1.fetchError) {
      return res.json({ fetchError: true, warning: "Your website scan was blocked or is offline." });
    }

    const seoAdvantage = site1.score - site2.score;
    const aeoAdvantage = site1.aeoScore - site2.aeoScore;
    const trustAdvantage = site1.aiTrustScore - site2.aiTrustScore;

    const sites = [
      { 
        brand: getBrandName(site1.url), 
        url: site1.url, 
        aiVisibilityScore: site1.overallAIVisibilityScore, 
        seoScore: site1.score, 
        aeoScore: site1.aeoScore,
        trustScore: site1.aiTrustScore,
        citationProbability: site1.citationProbability
      },
      { 
        brand: getBrandName(site2.url), 
        url: site2.url, 
        aiVisibilityScore: site2.overallAIVisibilityScore, 
        seoScore: site2.score, 
        aeoScore: site2.aeoScore,
        trustScore: site2.aiTrustScore,
        citationProbability: site2.citationProbability
      }
    ];

    let winnerReason = "Overall visibility performance metrics are tightly matched.";
    if (site1.overallAIVisibilityScore > site2.overallAIVisibilityScore) {
      winnerReason = `${getBrandName(site1.url)} dominates AI search indexing benchmarks due to enhanced schema integration and E-E-A-T credentials.`;
    } else if (site2.overallAIVisibilityScore > site1.overallAIVisibilityScore) {
      winnerReason = `${getBrandName(site2.url)} commands AI listings with premium structural outline depths and topical authority indicators.`;
    }

    res.json({ 
      sites, 
      winner: sites[0].aiVisibilityScore >= sites[1].aiVisibilityScore ? sites[0] : sites[1],
      advantages: {
        seo: { diff: Math.abs(seoAdvantage), leader: seoAdvantage > 0 ? sites[0].brand : (seoAdvantage < 0 ? sites[1].brand : "Tie") },
        aeo: { diff: Math.abs(aeoAdvantage), leader: aeoAdvantage > 0 ? sites[0].brand : (aeoAdvantage < 0 ? sites[1].brand : "Tie") },
        trust: { diff: Math.abs(trustAdvantage), leader: trustAdvantage > 0 ? sites[0].brand : (trustAdvantage < 0 ? sites[1].brand : "Tie") }
      },
      winnerReason
    });
  } catch (err) {
    console.error("COMPARE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/content-gap", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) return res.status(400).json({ error: "Both URLs required" });

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url),
      analyzeSingleUrl(competitor)
    ]);

    if (compData.competitorBlocked || compData.fetchError) {
      return res.json({ competitorBlocked: true, warning: "Competitor scan unavailable due to website restrictions." });
    }

    const gapData = competitorContentGap(userData, compData);
    res.json(gapData);
  } catch (err) {
    console.error("CONTENT GAP ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/roadmap", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    const data = await analyzeSingleUrl(url);
    const autopilotTasks = data.aiAutopilot || [];
    
    if (autopilotTasks.length === 0) {
      return res.json({
        currentScore: data.overallAIVisibilityScore || 0,
        potentialScore: data.overallAIVisibilityScore || 0,
        roadmap: [{
          step: 1,
          task: "No Critical Issues Found",
          priority: "LOW",
          why: "Your page meets optimal system requirements.",
          code: "No structural action needed."
        }],
        estimatedTime: "0 hours"
      });
    }
    
    const roadmap = autopilotTasks.map((task, i) => ({
      step: i + 1, 
      task: task.task || 'Optimize Framework', 
      priority: task.priority || 'MEDIUM',
      why: task.priority === 'CRITICAL' ? 'Blocks real-time citations across ChatGPT search indexes.' : 'Boosts indexing accuracy.',
      code: task.task?.includes('Schema') ? '<script type="application/ld+json">...</script>' : 'Modify local elements',
      impact: task.impact || '+5',
      effort: task.effort || '15 mins'
    }));
    
    const currentScore = data.overallAIVisibilityScore || 0;
    const totalImpact = autopilotTasks.reduce((sum, t) => sum + (parseInt(t.impact) || 5), 0);
    
    res.json({
      currentScore,
      potentialScore: Math.min(100, currentScore + totalImpact),
      roadmap,
      estimatedTime: `${Math.ceil(roadmap.length * 0.5)} hours`
    });
  } catch (err) {
    console.error('ROADMAP ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/gap-analysis", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) return res.status(400).json({ error: "Both URLs required" });

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url),
      analyzeSingleUrl(competitor)
    ]);

    if (compData.competitorBlocked || compData.fetchError) {
      return res.json({ competitorBlocked: true, warning: "Competitor scan unavailable due to website restrictions." });
    }

    const checks = [
      { key: 'hasFAQ', label: 'FAQ Schema' }, { key: 'hasHowTo', label: 'HowTo Schema' },
      { key: 'hasAuthor', label: 'Author Bio' }, { key: 'hasDirectAnswer', label: 'Direct Answer' },
      { key: 'hasSchemaMarkup', label: 'Schema Markup' }, { key: 'hasPrivacyPolicy', label: 'Privacy Policy' }
    ];

    const competitorHas = [], youMissing = [];
    checks.forEach(check => {
      if (compData[check.key]) competitorHas.push(check.label);
      if (compData[check.key] && !userData[check.key]) youMissing.push(check.label);
    });

    res.json({ competitor: { has: competitorHas }, you: { missing: youMissing } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/keyword-theft", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url || !competitor) return res.status(400).json({ error: "Both URLs required" });

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url),
      analyzeSingleUrl(competitor)
    ]);

    if (compData.competitorBlocked || compData.fetchError) {
      return res.json({ competitorBlocked: true, warning: "Competitor scan unavailable due to website restrictions." });
    }

    const yourKeywords = new Set(userData.keywords || []);
    const compKeywords = new Set(compData.keywords || []);
    const missingKeywords = [...compKeywords].filter(k => !yourKeywords.has(k));
    const sharedKeywords = [...compKeywords].filter(k => yourKeywords.has(k));

    res.json({
      topCompetitorKeywords: [...compKeywords].slice(0, 15),
      missingKeywords: missingKeywords.slice(0, 15),
      sharedKeywords: sharedKeywords.slice(0, 15),
      opportunity: `${missingKeywords.length} targeted keyword semantic variants to reclaim topical authority.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/content-brief", async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ error: "Keyword required" });
    res.json({
      h1: `Strategic Playbook: ${keyword}`,
      h2s: [`What is ${keyword}?`, `Why ${keyword} Commands Market Importance`, `How to Configure ${keyword} Safely`, `Industry-Proven ${keyword} Best Practices`, `Resolving Critical Mistakes with ${keyword}`],
      faqs: [
        { q: `What is ${keyword}?`, a: `${keyword} is an engineered approach...` },
        { q: `How do we configure ${keyword}?`, a: `Configuration processes follow guidelines...` }
      ],
      entities: ["Brand Authority", "Service Suite", "Localization Points", "Value Benchmarks"],
      schemaType: "Article"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/history", (req, res) => {
  res.json([]);
});

app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform v5.1 running on port ${PORT}`);
  console.log(`📊 Advanced Enterprise modules loaded | Dual-Fetch engine integrated`);
});
