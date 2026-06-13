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

// ========== HELPERS ==========
async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, {
    ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
       ...options.headers
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 100) throw new Error("Empty HTML response");
    return text;
  } catch (e) {
    console.error(`Fetch failed for ${url}:`, e.message);
    throw new Error(`Failed to fetch ${url}: ${e.message}`);
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
      const items = Array.isArray(json)? json : [json];
      const processItem = (item) => {
        if (item['@graph'] && Array.isArray(item['@graph'])) {
          item['@graph'].forEach(processItem);
          return;
        }
        if (item['@type']) {
          const types = Array.isArray(item['@type'])? item['@type'] : [item['@type']];
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

// ========== INTERNAL LINK INTELLIGENCE ==========
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
  const orphanPages = [];
  if (uniquePages < 3) orphanPages.push(`${url}/blog`);

  const linkDepths = Object.keys(linkMap).map(link => link.split('/').filter(Boolean).length);
  const avgDepth = linkDepths.length > 0? (linkDepths.reduce((a,b) => a+b, 0) / linkDepths.length).toFixed(1) : 0;
  const authorityFlow = h2s.length > 0? Math.round((internalLinks / h2s.length) * 100) : 0;
  const weakLinking = internalLinks < h2s.length;
  const suggestions = [];
  if (weakLinking) h2s.slice(0, 3).forEach(h2 => suggestions.push(`Add internal link to section: ${h2}`));

  return {
    totalInternalLinks: internalLinks,
    externalLinks,
    uniquePages,
    orphanPages,
    avgLinkDepth: parseFloat(avgDepth),
    authorityFlow,
    weakLinking,
    suggestions,
    linkDistribution: linkMap,
    score: Math.max(0, 100 - (orphanPages.length * 20) - (weakLinking? 30 : 0) - (avgDepth > 4? 20 : 0))
  };
}

// ========== E-E-A-T ADVANCED ==========
function calculateEEATAdvanced($, bodyText, hasAuthor, hasAboutPage, hasContactPage, hasPrivacyPolicy, hasLinkedIn, hasFacebook, isHttps, hasLastModified, schemas) {
  const breakdown = {
    experience: { score: 0, max: 25, factors: [] },
    expertise: { score: 0, max: 25, factors: [] },
    authoritativeness: { score: 0, max: 25, factors: [] },
    trustworthiness: { score: 0, max: 25, factors: [] }
  };

  if (hasAuthor) { breakdown.experience.score += 10; breakdown.experience.factors.push("✓ Author attribution"); }
  if (bodyText.match(/I have|we have|our experience|years of/i)) { breakdown.experience.score += 8; breakdown.experience.factors.push("✓ First-hand experience"); }
  if (bodyText.match(/case study|portfolio|client/i)) { breakdown.experience.score += 7; breakdown.experience.factors.push("✓ Case studies"); }

  if (hasAboutPage) { breakdown.expertise.score += 10; breakdown.expertise.factors.push("✓ About page"); }
  if (hasAuthor && bodyText.match(/expert|specialist|certified|degree/i)) { breakdown.expertise.score += 8; breakdown.expertise.factors.push("✓ Expert credentials"); }
  if (schemas.Organization?.present) { breakdown.expertise.score += 7; breakdown.expertise.factors.push("✓ Organization schema"); }

  if (hasLinkedIn) { breakdown.authoritativeness.score += 8; breakdown.authoritativeness.factors.push("✓ LinkedIn"); }
  if (hasFacebook) { breakdown.authoritativeness.score += 5; breakdown.authoritativeness.factors.push("✓ Social media"); }
  if ($('a[href*="wikipedia"]').length > 0 || $('a[href*="gov"]').length > 0) { breakdown.authoritativeness.score += 7; breakdown.authoritativeness.factors.push("✓ Authoritative sources"); }
  if (bodyText.match(/featured|award|recognition/i)) { breakdown.authoritativeness.score += 5; breakdown.authoritativeness.factors.push("✓ Awards mentioned"); }

  if (isHttps) { breakdown.trustworthiness.score += 6; breakdown.trustworthiness.factors.push("✓ HTTPS"); }
  if (hasPrivacyPolicy) { breakdown.trustworthiness.score += 5; breakdown.trustworthiness.factors.push("✓ Privacy policy"); }
  if (hasContactPage) { breakdown.trustworthiness.score += 6; breakdown.trustworthiness.factors.push("✓ Contact info"); }
  if (hasLastModified) { breakdown.trustworthiness.score += 4; breakdown.trustworthiness.factors.push("✓ Updated"); }
  if (schemas.LocalBusiness?.present) { breakdown.trustworthiness.score += 4; breakdown.trustworthiness.factors.push("✓ LocalBusiness"); }

  const totalScore = breakdown.experience.score + breakdown.expertise.score + breakdown.authoritativeness.score + breakdown.trustworthiness.score;
  return { score: totalScore, breakdown, level: totalScore >= 80? "Excellent" : totalScore >= 60? "Good" : totalScore >= 40? "Fair" : "Poor" };
}

// ========== ENTITY EXTRACTION ==========
function extractEntitiesFromContent(text, headings = "") {
  if (!text) return { keywords: [], entities: [], prices: [], locations: [], services: [], brands: [] };

  const brandRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  const brands = [...new Set((text + ' ' + headings).match(brandRegex) || [])]
  .filter(e => e.length > 3 &&!['The', 'This', 'That', 'With', 'From', 'What', 'How', 'Why'].includes(e))
  .slice(0, 5);

  const locationKeywords = ['USA','UK','Canada','Pakistan','India','Australia','Germany','France','UAE','Dubai','London','New York','Karachi','Lahore'];
  const locations = [...new Set(locationKeywords.filter(loc => text.toLowerCase().includes(loc.toLowerCase()) || headings.toLowerCase().includes(loc.toLowerCase())))];

  const servicePatterns = /website design|seo service|digital marketing|web development|ecommerce|wordpress|shopify|content writing|social media/gi;
  const services = [...new Set((text.match(servicePatterns) || []).map(s => s.trim()))].slice(0, 5);

  const priceRegex = /[\$₹€£]\s?\d+(?:,\d{3})*(?:\.\d{2})?|\d+\s?(?:dollars|USD|PKR|INR)/gi;
  const prices = [...new Set((text.match(priceRegex) || []))].slice(0, 3);

  const entities = [...new Set([...brands,...services])].slice(0, 10);

  const stopWords = ['about', 'https', 'website', 'click', 'here', 'their', 'there', 'which', 'would', 'function', 'return', 'const', 'document', 'window'];
  const headingText = String(headings || "").toLowerCase();
  const combinedText = headingText + ' ' + headingText + ' ' + headingText + ' ' + text.toLowerCase();
  const words = combinedText.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 4 &&!stopWords.includes(w));
  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word]) => word);

  return { keywords, entities, prices, locations, services, brands };
}
// NEW FEATURE START: Production Stability Helpers
const safe = (val, fallback = '') => val!== undefined && val!== null? val : fallback;
const clamp = (num, min = 0, max = 100) => Math.min(max, Math.max(min, isNaN(num)? 0 : num));
const safeArray = (arr) => Array.isArray(arr)? arr : [];
// NEW FEATURE END
// ========== MAIN ANALYZER ==========
async function analyzeSingleUrl(url) {
  try  {  
  const startTime = Date.now();
  const html = await safeFetch(url);
  const loadTime = Date.now() - startTime;

  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, svg').remove();

  const title = $("title").text().trim() || "";
  const h1 = $("h1").first().text().trim() || "";
  const metaDescription = $('meta[name="description"]').attr("content") || "";
  const bodyText = $("p, li, h2, h3, h4, td").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  const h2s = $("h2").map((i, el) => $(el).text().trim()).get().filter(Boolean);
  const h3s = $("h3").map((i, el) => $(el).text().trim()).get().filter(Boolean);

  const schemas = detectAllSchemas($, html);
  const uniqueSchemas = Object.keys(schemas).filter(k => schemas[k].present);
  const recommendedSchemas = Object.keys(schemas).filter(k => schemas[k].recommended &&!schemas[k].present);

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
  const imagesWithoutAlt = $("img").filter((i, el) =>!$(el).attr("alt")).length;
  const externalLinks = $("a[href^='http']").not(`a[href^='${url}']`).length;
  const isHttps = url.startsWith("https://");
  const mobileViewport = $('meta[name="viewport"]').length > 0;
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const hasCanonical =!!canonical;
  const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').attr("href") || "";
  const hasFavicon =!!favicon;

  const hasFAQ = faqQuestions.length > 0 || schemas.FAQPage.present;
  const hasHowTo = schemas.HowTo.present;
  const hasSchemaMarkup = uniqueSchemas.length > 0;
  const hasDirectAnswer = (bodyText.includes("Q:") && bodyText.includes("A:")) || bodyText.toLowerCase().includes("what is") || bodyText.toLowerCase().includes("how to") || (h2Count >= 3 && bodyText.length > 500);

  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const ogDescription = $('meta[property="og:description"]').attr("content") || "";
  const ogImage = $('meta[property="og:image"]').attr("content") || "";
  const hasOGTags =!!(ogTitle && ogDescription);

  const hasAuthor = $('meta[name="author"]').length > 0 || $('[rel="author"]').length > 0 || $('[itemprop="author"]').length > 0;
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

  const internalLinkData = analyzeInternalLinks($, url, h2s);
  const eeatData = calculateEEATAdvanced($, bodyText, hasAuthor, hasAboutPage, hasContactPage, hasPrivacyPolicy, hasLinkedIn, hasFacebook, isHttps, hasLastModified, schemas);

  const aiTrustSignals = [];
  if(hasPrivacyPolicy) aiTrustSignals.push("Privacy Policy");
  if(hasAboutPage) aiTrustSignals.push("About Page");
  if(hasContactPage) aiTrustSignals.push("Contact Page");
  if(hasEmail) aiTrustSignals.push("Email Address");
  if(hasPhone) aiTrustSignals.push("Phone Number");
  if(hasAuthor) aiTrustSignals.push("Author Profile");
  if(hasFacebook) aiTrustSignals.push("Facebook");
  if(hasLinkedIn) aiTrustSignals.push("LinkedIn");
  if(hasYouTube) aiTrustSignals.push("YouTube");
  if(hasTwitter) aiTrustSignals.push("Twitter/X");
  if(isHttps) aiTrustSignals.push("HTTPS Secure");
  if(hasLastModified) aiTrustSignals.push("Recently Updated");
  if(hasCanonical) aiTrustSignals.push("Canonical URL");
  if(hasFavicon) aiTrustSignals.push("Favicon");

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
      status: daysOld > 365? "outdated" : daysOld > 180? "aging" : "fresh",
      daysOld,
      needsRefresh: daysOld > 180,
      recommendation: daysOld > 365? "Urgent: Update statistics, dates, examples" : daysOld > 180? "Consider: Refresh intro + add 2026 data" : "Content is fresh"
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
  const seoStatus = seoScore >= 80? "Excellent" : seoScore >= 60? "Good" : seoScore >= 40? "Fair" : "Poor";

  let aeoScore = 0;
  if (hasFAQ) aeoScore += 30;
  if (hasHowTo) aeoScore += 20;
  if (hasDirectAnswer) aeoScore += 25;
  if (hasSchemaMarkup) aeoScore += 15;
  if (h1 && metaDescription) aeoScore += 10;
  const aeoStatus = aeoScore >= 80? "ChatGPT Ready" : aeoScore >= 50? "AI Friendly" : "Needs Work";

  const featuredSnippetChance = Math.min(100, (hasDirectAnswer? 40 : 0) + (hasFAQ? 30 : 0) + (listCount > 0? 20 : 0) + (h2Count >= 3? 10 : 0));
  const answerQuality = Math.min(100, Math.round((hasDirectAnswer? 30 : 0) + (hasFAQ? 25 : 0) + (listCount > 0? 15 : 0) + (h2Count >= 3? 15 : 0) + (readabilityScore * 0.15))) || 50;
  const aiTrustScore = Math.round((eeatData.score * 0.4) + (seoScore * 0.3) + (aeoScore * 0.3));

  const citationChatGPT = Math.min(95, 20 + (hasFAQ? 25 : 0) + (listCount > 2? 15 : 0) + (hasDirectAnswer? 20 : 0) + (hasAuthor? 10 : 0));
  const citationGemini = Math.min(95, 20 + (hasSchemaMarkup? 30 : 0) + (tableCount > 0? 20 : 0) + (hasAuthor? 15 : 0) + (wordCount > 800? 15 : 0));
  const citationPerplexity = Math.min(95, 20 + (hasDirectAnswer? 25 : 0) + (hasLastModified? 15 : 0) + (externalLinks > 5? 15 : 0) + (listCount > 0? 15 : 0));
  const citationProbability = Math.round((citationChatGPT + citationGemini + citationPerplexity) / 3);

  const schemaScore = (hasFAQ? 25 : 0) + (hasHowTo? 25 : 0) + (hasDirectAnswer? 20 : 0) + (uniqueSchemas.length > 0? 30 : 0);
  const overallAIVisibilityScore = Math.round((seoScore * 0.30) + (aeoScore * 0.20) + (aiTrustScore * 0.15) + (citationProbability * 0.15) + (readabilityScore * 0.10) + (schemaScore * 0.10));
  const schemaIntelligenceScore = Math.round(Object.values(schemas).reduce((sum, s) => sum + (s.present? 100 : 0), 0) / 8);

  const schemaErrors = [];
  const schemaWarnings = [];
  if (schemas.Article.present &&!hasAuthor) schemaErrors.push('Article schema missing author');
  if (schemas.FAQPage.present && faqQuestions.length === 0) schemaErrors.push('FAQPage schema has no questions');
  if (schemas.Organization.present &&!hasContactPage) schemaWarnings.push('Organization schema missing contactPoint');

  const schemaValidator = {
    valid: schemaErrors.length === 0,
    errors: schemaErrors,
    warnings: schemaWarnings,
    score: Math.max(0, 100 - (schemaErrors.length * 25) - (schemaWarnings.length * 10))
  };

  const chatGPTReadiness = Math.min(100, (hasFAQ? 30 : 0) + (hasDirectAnswer? 25 : 0) + (listCount > 2? 20 : 0) + (readabilityScore > 70? 15 : 0) + (hasAuthor? 10 : 0));
  const geminiReadiness = Math.min(100, (hasSchemaMarkup? 35 : 0) + (tableCount > 0? 25 : 0) + (hasLastModified? 20 : 0) + (eeatData.score > 60? 20 : 0));
  const perplexityReadiness = Math.min(100, (hasDirectAnswer? 30 : 0) + (wordCount > 800? 25 : 0) + (externalLinks > 5? 20 : 0) + (hasLastModified? 15 : 0) + (listCount > 0? 10 : 0));
  const claudeReadiness = Math.min(100, (readabilityScore > 75? 30 : 0) + (hasAboutPage? 25 : 0) + (hasAuthor? 20 : 0) + (hasPrivacyPolicy? 15 : 0) + (h2Count >= 4? 10 : 0));

  const aiVisibilityLevel = overallAIVisibilityScore >= 80? "Excellent" : overallAIVisibilityScore >= 60? "Good" : overallAIVisibilityScore >= 40? "Fair" : "Poor";
  const mobileScore = mobileViewport? seoScore : Math.max(0, seoScore - 20);
  const desktopScore = seoScore;

  const entityData = extractEntitiesFromContent(bodyText, h1 + ' ' + h2s.join(' '));
  const { keywords, entities, prices, locations, services, brands } = entityData;

  const keywordInsights = keywords.slice(0, 5).map(k => ({
    keyword: k,
    difficulty: getKeywordDifficulty(k),
    opportunity: getKeywordOpportunity(k, hasFAQ, hasSchemaMarkup)
  }));

  const mainTopic = h1 || title.split(" ").slice(0, 3).join(" ");
  const subtopics = h2s;
  const expectedSubtopics = [`What is ${mainTopic}`, `${mainTopic} Benefits`, `How to ${mainTopic}`, `${mainTopic} Examples`, `${mainTopic} vs Alternatives`];
  const missingSubtopics = expectedSubtopics.filter(exp =>!subtopics.some(sub => sub.toLowerCase().includes(exp.toLowerCase().split(' ')[0])));
  const topicCoverage = Math.round(((expectedSubtopics.length - missingSubtopics.length) / expectedSubtopics.length) * 100);

  const topicalAuthorityScore = Math.round((topicCoverage * 0.4) + (subtopics.length >= 5? 30 : subtopics.length * 6) + (hasFAQ? 15 : 0) + (wordCount > 1200? 15 : wordCount > 800? 10 : 5));

  const autoFAQ = [];
  if (h1) autoFAQ.push({ q: `What is ${h1}?`, a: metaDescription || bodyText.substring(0, 120) });
  if (prices.length > 0) autoFAQ.push({ q: `How much does ${services[0] || 'the service'} cost?`, a: `Pricing starts at ${prices[0]}. Contact us for custom quotes.` });
  if (locations.length > 0) autoFAQ.push({ q: `Do you serve ${locations[0]} clients?`, a: `Yes, we serve clients in ${locations.slice(0, 3).join(', ')}.` });
  if (allText.includes('delivery') || allText.includes('days')) autoFAQ.push({ q: `What is your delivery time?`, a: `Typical delivery is 7 days for standard projects.` });

  let aiExtractedAnswer = "No clear answer found";
  if (bodyText) {
    const firstPara = bodyText.split('.')[0];
    const brandName = brands[0] || getBrandName(url);
    const serviceName = services[0] || 'services';
    const priceInfo = prices[0]? ` starting at ${prices[0]}` : '';
    const locationInfo = locations.length > 0? ` for ${locations[0]} clients` : '';
    if (firstPara.length > 50) {
      aiExtractedAnswer = `${brandName} offers ${serviceName}${priceInfo}${locationInfo}. ${firstPara.substring(0, 100)}...`;
    } else {
      aiExtractedAnswer = `${brandName} provides ${serviceName}${priceInfo}${locationInfo}. ${bodyText.substring(0, 150)}...`;
    }
  }

  const aiSearchSimulation = {
    query: `What is ${mainTopic}?`,
    chatgpt: {
      answer: hasDirectAnswer? `${brands[0] || getBrandName(url)} offers ${services[0] || mainTopic}${prices[0]? ' starting at ' + prices[0] : ''}. ${metaDescription.substring(0, 100)}` : `Based on available data, ${mainTopic} relates to ${keywords.slice(0,3).join(', ')}. For specific details, check the official website.`,
      sources: hasAuthor? ["Official Website", "Author Profile"] : ["Official Website"],
      willCite: hasDirectAnswer && hasFAQ && listCount >= 2
    },
    gemini: {
      answer: hasSchemaMarkup? `According to structured data: ${title}. Key services include ${services.slice(0,2).join(' and ')}. ${hasLastModified? 'Last updated: ' + lastModified : ''}` : `${title}. ${metaDescription.substring(0, 120)}`,
      sources: hasSchemaMarkup? ["Schema.org Data", "Website"] : ["Website"],
      willCite: hasSchemaMarkup && tableCount > 0 && hasAuthor
    },
    perplexity: {
      answer: hasLastModified? `${aiExtractedAnswer} [Updated ${lastModified}]` : aiExtractedAnswer,
      sources: hasLastModified? ["Official Site (2026)", "Cited Sources"] : ["Official Site"],
      willCite: hasDirectAnswer && hasLastModified && externalLinks > 3
    },
    status: "live"
  };

  const aiCitationSimulator = {
    chatgpt: { willCite: hasDirectAnswer && hasFAQ && listCount >= 2, reasons: [], score: citationChatGPT, improvements: [] },
    gemini: { willCite: hasSchemaMarkup && tableCount > 0 && hasAuthor, reasons: [], score: citationGemini, improvements: [] },
    perplexity: { willCite: hasDirectAnswer && hasLastModified && externalLinks > 3, reasons: [], score: citationPerplexity, improvements: [] }
  };

  if (hasDirectAnswer) aiCitationSimulator.chatgpt.reasons.push("✓ Direct answer in first 100 words");
  else { aiCitationSimulator.chatgpt.reasons.push("✗ No direct answer format"); aiCitationSimulator.chatgpt.improvements.push("Add: 'Quick Answer: [50-word summary]' at top"); }
  if (hasFAQ) aiCitationSimulator.chatgpt.reasons.push("✓ FAQ schema present");
  else { aiCitationSimulator.chatgpt.reasons.push("✗ No FAQ schema"); aiCitationSimulator.chatgpt.improvements.push("Add FAQPage JSON-LD schema"); }
  if (listCount >= 2) aiCitationSimulator.chatgpt.reasons.push("✓ Structured lists for extraction");
  else { aiCitationSimulator.chatgpt.reasons.push("✗ No lists/bullets"); aiCitationSimulator.chatgpt.improvements.push("Add bullet points or numbered lists"); }
  if (!hasAuthor) { aiCitationSimulator.chatgpt.reasons.push("✗ No author attribution"); aiCitationSimulator.chatgpt.improvements.push("Add author bio with credentials"); }
  if (prices.length === 0) { aiCitationSimulator.chatgpt.reasons.push("✗ No statistics/pricing data"); aiCitationSimulator.chatgpt.improvements.push("Add specific numbers: pricing, stats, dates"); }

  if (hasSchemaMarkup) aiCitationSimulator.gemini.reasons.push("✓ Rich schema markup detected");
  else { aiCitationSimulator.gemini.reasons.push("✗ No structured data"); aiCitationSimulator.gemini.improvements.push("Add Article + Organization schema"); }
  if (tableCount > 0) aiCitationSimulator.gemini.reasons.push("✓ Tables for data extraction");
  else { aiCitationSimulator.gemini.reasons.push("✗ No tables found"); aiCitationSimulator.gemini.improvements.push("Add comparison tables"); }
  if (hasAuthor) aiCitationSimulator.gemini.reasons.push("✓ Author signals present");
  else { aiCitationSimulator.gemini.reasons.push("✗ Missing author EEAT"); aiCitationSimulator.gemini.improvements.push("Add author section with bio"); }

  if (hasDirectAnswer) aiCitationSimulator.perplexity.reasons.push("✓ Direct answers available");
  else { aiCitationSimulator.perplexity.reasons.push("✗ No clear Q&A format"); aiCitationSimulator.perplexity.improvements.push("Add Q&A format: Q:... A:..."); }
  if (hasLastModified) aiCitationSimulator.perplexity.reasons.push("✓ Fresh content date");
  else { aiCitationSimulator.perplexity.reasons.push("✗ No last modified date"); aiCitationSimulator.perplexity.improvements.push("Add <meta property='article:modified_time'>"); }
  if (externalLinks > 3) aiCitationSimulator.perplexity.reasons.push("✓ External citations present");
  else { aiCitationSimulator.perplexity.reasons.push("✗ Few trust signals"); aiCitationSimulator.perplexity.improvements.push("Add links to Wikipedia,.gov, research papers"); }

  const aiRecommendations = [];
  if (!hasFAQ) aiRecommendations.push({ priority: "CRITICAL", action: "Add FAQ Schema", impact: "+15% ChatGPT Citation", effort: "15 mins", code: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>` });
  if (!hasAuthor) aiRecommendations.push({ priority: "HIGH", action: "Add Author Section with Credentials", impact: "+12% EEAT Score", effort: "10 mins", code: `<div class="author" itemprop="author">By <span itemprop="name">John Doe</span>, <span itemprop="jobTitle">SEO Expert</span></div>` });
      if (!hasDirectAnswer) aiRecommendations.push({
      priority: "HIGH",
      action: "Add Direct Answer Block in First 100 Words",
      impact: "+20% Featured Snippet Chance",
      effort: "20 mins",
      code: `<p><strong>Quick Answer:</strong> ${mainTopic} is a proven solution that helps businesses improve ${keywords[0] || 'performance'}. In 50 words: ${metaDescription || bodyText.substring(0, 150)}</p>`,
      why: "AI search extracts direct Q&A format first. ChatGPT/Gemini cite sites with clear answers."
    });

    if (!hasLastModified) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Last Updated Date",
      impact: "+10% Freshness Score",
      effort: "5 mins",
      code: `<meta property="article:modified_time" content="${new Date().toISOString()}">`,
      why: "AI prefers recently updated content. Perplexity ranks fresh content higher."
    });

    if (readabilityScore < 60) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Improve Readability - Shorter Sentences",
      impact: "+15 Readability Score",
      effort: "30 mins",
      code: "Break sentences >20 words. Use bullet points. Aim for Grade 8 reading level.",
      why: "AI citations favor easy-to-parse content. Claude penalizes complex text."
    });

    if (wordCount < 800) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Statistics/Data Points",
      impact: "+10% AI Trust Score",
      effort: "25 mins",
      code: `Add: "Studies show 73% of users..." or "Starting at $${prices[0] || '99'}" with source citation`,
      why: "AI trusts specific numbers over vague claims. Increases citation probability."
    });

    if (externalLinks < 3) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Trust Signals - External Citations",
      impact: "+8% Perplexity Citation",
      effort: "15 mins",
      code: `Link to: Wikipedia,.gov sources, industry reports, research papers`,
      why: "External citations prove credibility. Perplexity requires 3+ trust sources."
    });

    if (listCount < 2) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Comparison Tables/Lists",
      impact: "+12% Gemini Citation",
      effort: "25 mins",
      code: `<table><thead><tr><th>Feature</th><th>Us</th><th>Competitor</th></tr></thead><tbody><tr><td>Price</td><td>$99</td><td>$199</td></tr></tbody></table>`,
      why: "Gemini extracts structured data. Tables boost AI citation by 12%."
    });

    if (!schemas.Organization.present) aiRecommendations.push({
      priority: "HIGH",
      action: "Add Organization Schema",
      impact: "+10% EEAT Score",
      effort: "20 mins",
      code: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"${getBrandName(url)}","url":"${url}","logo":"${favicon || url + '/logo.png'}"}</script>`,
      why: "Organization schema is mandatory for EEAT. Google requires it for trust."
    });

    if (!schemas.LocalBusiness.present && (allText.includes('service') || allText.includes('agency'))) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add LocalBusiness Schema",
      impact: "+8% Local AI Citations",
      effort: "25 mins",
      code: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"${getBrandName(url)}","address":{"@type":"PostalAddress","addressCountry":"PK"}}</script>`,
      why: "LocalBusiness schema helps AI understand service area. Boosts local citations."
    });

    if (imagesWithoutAlt > 0) aiRecommendations.push({
      priority: "LOW",
      action: `Add ALT Text to ${imagesWithoutAlt} Images`,
      impact: "+5 SEO Score",
      effort: "10 mins",
      code: `<img src="image.jpg" alt="Descriptive text about ${keywords[0] || 'service'}">`,
      why: "Image SEO + accessibility compliance. Required for AI image search."
    });

    if (!hasOGTags) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Open Graph Tags",
      impact: "+8 Social + AI Score",
      effort: "15 mins",
      code: `<meta property="og:title" content="${title}"><meta property="og:description" content="${metaDescription}"><meta property="og:image" content="${ogImage || url + '/og-image.jpg'}">`,
      why: "AI uses OG tags for rich results. Improves social sharing + AI previews."
    });

    if (!hasContactPage) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Contact Page with NAP",
      impact: "+6 Trust Score",
      effort: "15 mins",
      code: `<div>Contact: ${email || 'info@domain.com'} | ${phone || '+92-xxx'} | Address</div>`,
      why: "NAP consistency required for local SEO + AI trust signals."
    });

    if (!hasPrivacyPolicy) aiRecommendations.push({
      priority: "LOW",
      action: "Add Privacy Policy Link",
      impact: "+5 Trust Score",
      effort: "10 mins",
      code: `<a href="/privacy">Privacy Policy</a>`,
      why: "Legal compliance + trust signal for AI. Required for EEAT."
    });

    const recommendationScore = Math.max(0, 100 - (aiRecommendations.length * 8));

    const visibilityForecast = {
      current: overallAIVisibilityScore,
      afterFAQ: Math.min(100, overallAIVisibilityScore + (hasFAQ? 0 : 15)),
      afterHowTo: Math.min(100, overallAIVisibilityScore + (hasHowTo? 0 : 12)),
      afterAuthor: Math.min(100, overallAIVisibilityScore + (hasAuthor? 0 : 10)),
      afterSchema: Math.min(100, overallAIVisibilityScore + (hasSchemaMarkup? 0 : 8)),
      afterAll: Math.min(100, overallAIVisibilityScore + recommendationScore)
    };

    // ========== SCHEMA GENERATOR ==========
    const schemaGenerator = {};

    // FAQPage Schema
    if (!schemas.FAQPage.present && autoFAQ.length > 0) {
      const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": autoFAQ.map(f => ({
          "@type": "Question",
          "name": f.q,
          "acceptedAnswer": { "@type": "Answer", "text": f.a }
        }))
      };
      schemaGenerator.FAQPage = {
        recommended: true,
        code: JSON.stringify(faqSchema, null, 2),
        title: "FAQ Schema - ChatGPT ke liye zaroori"
      };
    }

    // Article Schema
    if (!schemas.Article.present) {
      const articleSchema = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title || h1,
        "description": metaDescription,
        "author": { "@type": "Person", "name": "Your Name" },
        "datePublished": new Date().toISOString(),
        "dateModified": new Date().toISOString()
      };
      schemaGenerator.Article = {
        recommended: true,
        code: JSON.stringify(articleSchema, null, 2),
        title: "Article Schema - AI Visibility"
      };
    }

    // Organization Schema
    if (!schemas.Organization.present) {
      const orgSchema = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": getBrandName(url),
        "url": url,
        "logo": favicon || `${url}/logo.png`
      };
      schemaGenerator.Organization = {
        recommended: true,
        code: JSON.stringify(orgSchema, null, 2),
        title: "Organization Schema - Trust Signal"
      };
    }

    // LocalBusiness Schema
    if (!schemas.LocalBusiness.present && (allText.includes('service') || allText.includes('agency'))) {
      const localSchema = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": getBrandName(url),
        "address": {
          "@type": "PostalAddress",
          "addressCountry": locations[0] || "PK"
        },
        "telephone": phone || "+92-xxx-xxx",
        "priceRange": prices[0] || "$$"
      };
      schemaGenerator.LocalBusiness = {
        recommended: true,
        code: JSON.stringify(localSchema, null, 2),
        title: "LocalBusiness Schema - Local SEO"
      };
    }

    
    // AI Autopilot Tasks
    const aiAutopilot = [
   !hasFAQ && { task: "Add FAQ Schema", impact: "+15", effort: "15 mins", priority: "CRITICAL" },
   !hasAuthor && { task: "Add Author Bio", impact: "+8", effort: "10 mins", priority: "HIGH" },
   !hasEmail && { task: "Add Email Address", impact: "+5", effort: "2 mins", priority: "MEDIUM" },
      internalLinkData.weakLinking && { task: "Fix Internal Linking", impact: "+12", effort: "20 mins", priority: "HIGH" },
   !hasLastModified && { task: "Add Last Modified Date", impact: "+6", effort: "5 mins", priority: "MEDIUM" },
      imagesWithoutAlt > 0 && { task: `Add ALT to ${imagesWithoutAlt} images`, impact: "+7", effort: "10 mins", priority: "MEDIUM" }
    ].filter(Boolean);
// NEW FEATURE START: Topical Authority Score
const calculateTopicalAuthority = ($, keywords, h2s, h3s) => {
  const allHeadings = [...safeArray(h2s),...safeArray(h3s)].map(h => h.toLowerCase());
  const keywordSet = new Set(safeArray(keywords).map(k => k.toLowerCase()));

  const coreTopics = ['what', 'why', 'how', 'best', 'guide', 'tutorial', 'examples', 'tips', 'benefits'];
  const topicsCovered = coreTopics.filter(topic =>
    allHeadings.some(h => h.includes(topic))
  ).length;

  const depthScore = clamp((topicsCovered / coreTopics.length) * 60);
  const keywordCoverage = clamp((keywordSet.size / 10) * 40);
  const score = clamp(depthScore + keywordCoverage);

  const missingSubtopics = coreTopics.filter(topic =>
   !allHeadings.some(h => h.includes(topic))
  );

  return { score, topicsCovered, missingSubtopics, depth: topicsCovered >= 6? 'Deep' : topicsCovered >= 3? 'Medium' : 'Shallow' };
};
// NEW FEATURE END

// NEW FEATURE START: Semantic SEO Analyzer
const analyzeSemanticSEO = ($, bodyText) => {
  const text = safe(bodyText).toLowerCase();
  const entities = [];
  const nlpKeywords = ['comprehensive', 'expert', 'proven', 'data-driven', 'results', 'strategy', 'solution', 'professional'];

  // Detect entities: Capitalized words that aren't sentence starts
  const entityRegex = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
  const matches = safe(bodyText).match(entityRegex) || [];
  matches.forEach(m => {
    if (m.length > 3 &&!['The', 'This', 'That', 'Your'].includes(m)) entities.push(m);
  });

  const nlpCoverage = nlpKeywords.filter(k => text.includes(k)).length;
  const semanticGaps = nlpKeywords.filter(k =>!text.includes(k)).slice(0, 5);

  return {
    entities: [...new Set(entities)].slice(0, 15),
    nlpScore: clamp((nlpCoverage / nlpKeywords.length) * 100),
    semanticGaps,
    hasSemanticHTML: $('article, section, aside, nav').length > 0
  };
};
// NEW FEATURE END

// NEW FEATURE START: AI Citation Opportunity Finder
const findCitationOpportunities = (data) => {
  const opportunities = [];
  const { hasFAQ, hasDirectAnswer, hasAuthor, hasHowTo, wordCount, eeatData } = data;

  if (!hasFAQ) opportunities.push({ engine: 'ChatGPT', reason: 'Missing FAQ Schema - ChatGPT loves Q&A format', impact: '+20', fix: 'Add FAQ Schema with 3+ questions' });
  if (!hasDirectAnswer) opportunities.push({ engine: 'Perplexity', reason: 'No direct answer in first 100 words', impact: '+15', fix: 'Add 50-word summary at top' });
  if (!hasAuthor) opportunities.push({ engine: 'Gemini', reason: 'No author bio - Gemini checks E-E-A-T', impact: '+12', fix: 'Add author with credentials' });
  if (!hasHowTo) opportunities.push({ engine: 'All', reason: 'Missing HowTo Schema for tutorials', impact: '+10', fix: 'Add HowTo Schema if applicable' });
  if (wordCount < 1500) opportunities.push({ engine: 'All', reason: 'Content depth below 1500 words', impact: '+8', fix: 'Expand content to 2000+ words' });
  if (safe(eeatData?.score) < 70) opportunities.push({ engine: 'Gemini', reason: 'Low E-E-A-T score', impact: '+18', fix: 'Add reviews, testimonials, social proof' });

  return opportunities;
};
// NEW FEATURE END

// NEW FEATURE START: Competitor Content Gap Engine
const competitorContentGap = (userData, compData) => {
  const userHeadings = [...safeArray(userData.h2s),...safeArray(userData.h3s)];
  const compHeadings = [...safeArray(compData.h2s),...safeArray(compData.h3s)];
  const userKeywords = new Set(safeArray(userData.keywords));
  const compKeywords = new Set(safeArray(compData.keywords));

  const headingGaps = compHeadings.filter(h =>!userHeadings.some(uh => uh.toLowerCase().includes(h.toLowerCase().substring(0, 10))));
  const keywordGaps = [...compKeywords].filter(k =>!userKeywords.has(k));

  const schemaGaps = [];
  if (compData.hasFAQ &&!userData.hasFAQ) schemaGaps.push('FAQ');
  if (compData.hasHowTo &&!userData.hasHowTo) schemaGaps.push('HowTo');
  if (compData.hasAuthor &&!userData.hasAuthor) schemaGaps.push('Author');

  return {
    headingGaps: headingGaps.slice(0, 10),
    keywordGaps: keywordGaps.slice(0, 15),
    schemaGaps,
    contentLengthDiff: safe(compData.wordCount, 0) - safe(userData.wordCount, 0),
    competitorHasMore: safe(compData.wordCount, 0) > safe(userData.wordCount, 0)
  };
};
// NEW FEATURE END

// NEW FEATURE START: FAQ Expansion Generator
const generateFAQExpansion = (keywords, h2s, brand) => {
  const mainKeyword = safeArray(keywords)[0] || safe(brand, 'service');
  const faqs = [
    { q: `What is ${mainKeyword}?`, a: `${mainKeyword} is a professional solution designed to help businesses achieve measurable results through expert strategies.` },
    { q: `How does ${mainKeyword} work?`, a: `${mainKeyword} works by analyzing your needs and implementing data-driven tactics tailored to your goals.` },
    { q: `Why choose ${safe(brand, 'us')} for ${mainKeyword}?`, a: `We combine 10+ years expertise with proven results and transparent reporting for ${mainKeyword}.` },
    { q: `How much does ${mainKeyword} cost?`, a: `${mainKeyword} pricing depends on scope. We offer custom quotes after free consultation.` },
    { q: `How long does ${mainKeyword} take to show results?`, a: `Most clients see initial ${mainKeyword} results in 30-90 days with consistent growth.` },
    { q: `Is ${mainKeyword} suitable for small businesses?`, a: `Yes, ${mainKeyword} scales for all business sizes with flexible packages.` },
    { q: `What makes ${mainKeyword} different?`, a: `Our ${mainKeyword} approach focuses on ROI, transparency, and long-term partnerships.` },
    { q: `Do you provide ${mainKeyword} reports?`, a: `Yes, monthly detailed ${mainKeyword} reports with rankings, traffic, and conversions.` },
    { q: `Can I cancel ${mainKeyword} anytime?`, a: `Yes, we offer flexible month-to-month ${mainKeyword} plans with no lock-in.` },
    { q: `Where do you provide ${mainKeyword}?`, a: `We serve clients globally for ${mainKeyword} with focus on Pakistan, UK, USA markets.` }
  ];
  return faqs;
};
// NEW FEATURE END

// NEW FEATURE START: AI Snippet Generator
const generateAISnippets = (h1, metaDescription, keywords) => {
  const keyword = safeArray(keywords)[0] || 'service';
  const directAnswer = `Quick Answer: ${safe(h1, keyword)} helps businesses ${safe(metaDescription, 'achieve results').substring(0, 100)}. Our proven approach delivers measurable outcomes in 30-90 days.`;

  const featuredSnippet = `## ${safe(h1, `What is ${keyword}?`)}\n\n${safe(metaDescription, keyword)} is a strategic approach that combines expert analysis with data-driven execution. Key benefits include:\n\n1. Improved visibility and rankings\n2. Qualified traffic growth\n3. Higher conversion rates\n4. Transparent ROI reporting`;

  return { directAnswer, featuredSnippet, wordCount: directAnswer.split(' ').length };
};
// NEW FEATURE END

// NEW FEATURE START: Trust Signal Scanner
const scanTrustSignals = ($) => {
  const bodyText = $('body').text().toLowerCase();
  const signals = {
    hasAuthor: $('[itemprop="author"],.author,.author-bio').length > 0 || bodyText.includes('written by'),
    hasContact: $('a[href^="tel:"], a[href^="mailto:"],.contact').length > 0 || bodyText.includes('contact us'),
    hasAbout: $('a[href*="about"]').length > 0 || bodyText.includes('about us'),
    hasPrivacyPolicy: $('a[href*="privacy"]').length > 0 || bodyText.includes('privacy policy'),
    hasSocialProfiles: $('a[href*="facebook.com"], a[href*="linkedin.com"], a[href*="twitter.com"]').length > 0,
    hasReviews: $('.review,.testimonial, [itemprop="review"]').length > 0 || bodyText.includes('review'),
    hasTestimonials: $('.testimonial,.client-feedback').length > 0 || bodyText.includes('testimonial')
  };

  const score = Object.values(signals).filter(Boolean).length;
  return {...signals, trustScore: clamp((score / 7) * 100), totalSignals: score };
};
// NEW FEATURE END

// NEW FEATURE START: Schema Opportunity Finder
const findSchemaOpportunities = (data) => {
  const opportunities = [];
  const { hasFAQ, hasHowTo, hasAuthor, hasOrganization, wordCount, hasImages } = data;

  if (!hasFAQ) opportunities.push({ type: 'FAQPage', priority: 'CRITICAL', reason: 'ChatGPT prefers Q&A format', impact: '+20' });
  if (!hasHowTo && wordCount > 800) opportunities.push({ type: 'HowTo', priority: 'HIGH', reason: 'Tutorial content detected', impact: '+15' });
  if (!hasAuthor) opportunities.push({ type: 'Person', priority: 'HIGH', reason: 'Missing author E-E-A-T signal', impact: '+12' });
  if (!hasOrganization) opportunities.push({ type: 'Organization', priority: 'MEDIUM', reason: 'Brand trust signal', impact: '+8' });
  if (hasImages) opportunities.push({ type: 'ImageObject', priority: 'LOW', reason: 'Enhance image SEO', impact: '+5' });
  opportunities.push({ type: 'BreadcrumbList', priority: 'LOW', reason: 'Improve navigation signals', impact: '+5' });

  return opportunities;
};
// NEW FEATURE END

// NEW FEATURE START: Local SEO Analyzer
const analyzeLocalSEO = ($, bodyText) => {
  const text = safe(bodyText);
  const hasNAP = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(text) || text.includes('address') || text.includes('phone');
  const hasLocalBusiness = $('[itemtype*="LocalBusiness"]').length > 0;
  const hasMap = $('iframe[src*="google.com/maps"], iframe[src*="maps"]').length > 0;
  const hasCity = /\b(Karachi|Lahore|Islamabad|London|New York|Dubai)\b/i.test(text);

  const signals = { hasNAP, hasLocalBusiness, hasMap, hasCity };
  const score = Object.values(signals).filter(Boolean).length;

  return {
   ...signals,
    localScore: clamp((score / 4) * 100),
    napConsistency: hasNAP? 'Detected' : 'Missing',
    recommendations:!hasLocalBusiness? ['Add LocalBusiness Schema'] : []
  };
};
// NEW FEATURE END
    return {
      schemaGenerator, aiAutopilot, url, title, h1, h2s, h3s, metaDescription, wordCount, lastModified,
      score: seoScore, status: seoScore >= 80? "Excellent" : seoScore >= 60? "Good" : "Fair",
      aiTrustSignals, overallAIVisibilityScore, aiVisibilityLevel: overallAIVisibilityScore >= 80? "Excellent" : "Good",
      breakdown: {
        seo: seoScore, aeo: aeoScore, eeatScore: eeatData.score, eeatBreakdown: eeatData.breakdown,
        internalLinkingAudit: internalLinkData, trust: aiTrustScore, citation: citationProbability,
        readability: readabilityScore, schema: schemaScore
      },
      citationProbability, totalImages, imagesWithoutAlt, internalLinks: internalLinkData.totalInternalLinks, externalLinks,
      mobileFriendly: mobileViewport, isHttps, loadTime, mobileScore: mobileViewport? seoScore : seoScore - 20, desktopScore: seoScore,
      hasSchemaMarkup, robotsExists, sitemapExists, hasCanonical, canonical, hasFavicon, favicon,
      hasOGTags, ogTitle, ogDescription, ogImage, aeoScore, aeoStatus: aeoScore >= 80? "ChatGPT Ready" : "Needs Work",
      hasFAQ, hasHowTo, hasDirectAnswer, schemas: uniqueSchemas, recommendedSchemas, keywords, entities,
      readabilityScore, aiTrustScore, answerQualityScore: answerQuality, featuredSnippetChance,
      contentStructureScore: (h1Count === 1? 20 : 0) + (h2Count >= 3? 20 : 0) + (h3Count >= 5? 20 : 0) + (listCount >= 2? 20 : 0) + (tableCount >= 1? 20 : 0),
      citationChatGPT, citationGemini, citationPerplexity, h1Count, h2Count, h3Count, listCount, tableCount,
      hasPrivacyPolicy, hasAboutPage, hasContactPage, hasAuthor, hasFacebook, hasLinkedIn, hasYouTube, hasTwitter,
      hasEmail, hasPhone, email, phone, hasLastModified, autoFAQ, aiSearchSimulation,
      realCitationChatGPT: citationChatGPT, realCitationGemini: citationGemini, realCitationPerplexity: citationPerplexity,
      criticalIssues, importantIssues, minorIssues, aiRecommendations, recommendationScore, visibilityForecast,topicalAuthority: calculateTopicalAuthority($, keywords, h2s, h3s),
 semanticSEO: analyzeSemanticSEO($, bodyText),
citationOpportunities: findCitationOpportunities({
  hasFAQ, hasDirectAnswer, hasAuthor, hasHowTo, wordCount, eeatData
}),
faqExpansion: generateFAQExpansion(keywords, h2s, getBrandName(url)), // ← FIXED
aiSnippets: generateAISnippets(h1, metaDescription, keywords),
trustSignals: scanTrustSignals($),
schemaOpportunities: findSchemaOpportunities({ 
  hasFAQ, 
  hasHowTo, 
  hasAuthor, 
  hasOrganization: schemas.Organization?.present, 
  wordCount, 
  hasImages: totalImages > 0 
}),
localSEO: analyzeLocalSEO($, bodyText)
 
};
   
  } catch (mainError) {
    console.error("Analysis error:", mainError.message);
    throw new Error(`Failed to analyze ${url}: ${mainError.message}`);
  }
}

// ========== API ENDPOINTS ==========
app.get("/", (req, res) => res.json({ status: "running", tool: "AI Visibility Platform", version: "5.0-production" }));

app.get("/scan", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });
  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Scan failed", message: err.message });
  }
});

app.get("/compare", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });
  const [site1, site2] = await Promise.all([
  analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
  analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
]);
    const sites = [
      { brand: getBrandName(site1.url), aiVisibilityScore: site1.overallAIVisibilityScore, seoScore: site1.score, aeoScore: site1.aeoScore },
      { brand: getBrandName(site2.url), aiVisibilityScore: site2.overallAIVisibilityScore, seoScore: site2.score, aeoScore: site2.aeoScore }
    ];
    res.json({ sites, winner: sites[0].aiVisibilityScore >= sites[1].aiVisibilityScore? sites[0] : sites[1] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// NEW FEATURE START: Competitor Content Gap Engine Endpoint
app.get("/content-gap", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });

    const [userData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const gapData = competitorContentGap(userData, compData);
    res.json(gapData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// NEW FEATURE END
app.get("/roadmap", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    const data = await analyzeSingleUrl(url);
    const roadmap = data.aiAutopilot.map((task, i) => ({
      step: i + 1, task: task.task, priority: task.priority,
      why: task.priority === 'CRITICAL'? 'Blocks AI citations' : 'Improves trust',
      code: task.task.includes('Schema')? '<script type="application/ld+json">...</script>' : 'HTML changes needed'
    }));
    res.json({
      currentScore: data.overallAIVisibilityScore,
      potentialScore: Math.min(100, data.overallAIVisibilityScore + 40),
      roadmap,
      estimatedTime: `${roadmap.length * 2} hours`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/gap-analysis", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });
    const [userData, compData] = await Promise.all([
  analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
  analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
]);
    const checks = [
      { key: 'hasFAQ', label: 'FAQ Schema' }, { key: 'hasHowTo', label: 'HowTo Schema' },
      { key: 'hasAuthor', label: 'Author Bio' }, { key: 'hasDirectAnswer', label: 'Direct Answer' },
      { key: 'hasSchemaMarkup', label: 'Schema Markup' }, { key: 'hasPrivacyPolicy', label: 'Privacy Policy' }
    ];
    const competitorHas = [], youMissing = [];
    checks.forEach(check => {
      if (compData[check.key]) competitorHas.push(check.label);
      if (compData[check.key] &&!userData[check.key]) youMissing.push(check.label);
    });
    res.json({ competitor: { has: competitorHas }, you: { missing: youMissing } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/keyword-theft", async (req, res) => {
  try {
    const { url, competitor } = req.query;
    if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });
   const [userData, compData] = await Promise.all([
  analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
  analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
]);
    const yourKeywords = new Set(userData.keywords || []);
    const compKeywords = new Set(compData.keywords || []);
    const missingKeywords = [...compKeywords].filter(k =>!yourKeywords.has(k));
    const sharedKeywords = [...compKeywords].filter(k => yourKeywords.has(k));
    res.json({
      topCompetitorKeywords: [...compKeywords].slice(0, 15),
      missingKeywords: missingKeywords.slice(0, 15),
      sharedKeywords: sharedKeywords.slice(0, 15),
      opportunity: `${missingKeywords.length} keywords you can target to beat competitor`
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
      h1: `Complete Guide: ${keyword}`,
      h2s: [`What is ${keyword}?`, `Why ${keyword} Matters in 2026`, `How to Implement ${keyword}`, `${keyword} Best Practices`, `Common ${keyword} Mistakes`],
      faqs: [
        { q: `What is ${keyword}?`, a: `${keyword} is a strategic approach...` },
        { q: `How does ${keyword} work?`, a: `${keyword} works by...` },
        { q: `Why is ${keyword} important?`, a: `${keyword} is critical for...` }
      ],
      entities: ["Brand", "Service", "Location", "Price"],
      schemaType: "Article"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/history", (req, res) => {
  res.json([]);
});
// NEW MODULE START: v5.1 Additional Features

const axios = require('axios');

// Helper: Safe execution wrapper
const safeRun = async (fn, fallback = null) => {
  try { return await fn(); } catch (e) { console.error('Feature error:', e.message); return fallback; }
};

// 1. REAL BROKEN LINK CHECKER
async function checkBrokenLinks($, baseUrl) {
  return safeRun(async () => {
    const links = [];
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href &&!href.startsWith('#') &&!href.startsWith('mailto:') &&!href.startsWith('tel:')) {
        links.push(new URL(href, baseUrl).href);
      }
    });

    const uniqueLinks = [...new Set(links)].slice(0, 50); // Limit for performance
    const results = await Promise.allSettled(
      uniqueLinks.map(async (url) => {
        try {
          const res = await axios.head(url, { timeout: 5000, validateStatus: () => true });
          return { url, status: res.status, broken: res.status >= 400 };
        } catch { return { url, status: 0, broken: true }; }
      })
    );

    const checked = results.map(r => r.value || r.reason).filter(Boolean);
    return {
      totalChecked: checked.length,
      brokenLinks: checked.filter(l => l.broken),
      brokenCount: checked.filter(l => l.broken).length,
      healthScore: Math.round(((checked.length - checked.filter(l => l.broken).length) / checked.length) * 100) || 100
    };
  }, { totalChecked: 0, brokenLinks: [], brokenCount: 0, healthScore: 100 });
}

// 2. CORE WEB VITALS ANALYSIS
async function analyzeCoreWebVitals(url) {
  return safeRun(async () => {
    // Using Google PageSpeed Insights API - free tier
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance`;
    const res = await axios.get(apiUrl, { timeout: 15000 });
    const lighthouse = res.data.lighthouseResult;
    const audits = lighthouse.audits;

    return {
      lcp: Math.round(audits['largest-contentful-paint']?.numericValue || 0), // ms
      fid: Math.round(audits['max-potential-fid']?.numericValue || 0), // ms
      cls: audits['cumulative-layout-shift']?.numericValue || 0,
      performanceScore: Math.round((lighthouse.categories.performance?.score || 0) * 100),
      lcpGrade: audits['largest-contentful-paint']?.numericValue < 2500? 'Good' : audits['largest-contentful-paint']?.numericValue < 4000? 'Needs Improvement' : 'Poor',
      clsGrade: audits['cumulative-layout-shift']?.numericValue < 0.1? 'Good' : audits['cumulative-layout-shift']?.numericValue < 0.25? 'Needs Improvement' : 'Poor',
      recommendations: audits['largest-contentful-paint']?.details?.items?.[0]?.node?.explanation || 'Optimize images and server response time'
    };
  }, { lcp: 0, fid: 0, cls: 0, performanceScore: 0, lcpGrade: 'Unknown', clsGrade: 'Unknown', recommendations: 'Unable to fetch Core Web Vitals' });
}

// 3. TOPICAL AUTHORITY SCORE - Enhanced
function calculateTopicalAuthority($, html, entities) {
  return safeRun(() => {
    const wordCount = $('body').text().split(/\s+/).length;
    const h2Count = $('h2').length;
    const h3Count = $('h3').length;
    const entityCount = entities.brands?.length + entities.services?.length + entities.locations?.length || 0;

    // Depth indicators
    const hasGuides = /guide|tutorial|how to|complete/i.test(html);
    const hasComparisons = /vs|versus|compare|best/i.test(html);
    const hasExamples = /example|case study|for instance/i.test(html);
    const hasStats = /\d+%|\$\d+|\d+x/i.test(html);

    let score = 0;
    if (wordCount > 2000) score += 30; else if (wordCount > 1000) score += 20; else if (wordCount > 500) score += 10;
    if (h2Count >= 5) score += 20; else if (h2Count >= 3) score += 10;
    if (entityCount >= 10) score += 20; else if (entityCount >= 5) score += 10;
    if (hasGuides) score += 10; if (hasComparisons) score += 10; if (hasExamples) score += 5; if (hasStats) score += 5;

    return {
      score: Math.min(score, 100),
      wordCount,
      headingDepth: h2Count + h3Count,
      entityDensity: entityCount,
      contentSignals: {
        hasGuides, hasComparisons, hasExamples, hasStats
      },
      missingElements: [
       !hasGuides && 'Add comprehensive guides',
       !hasComparisons && 'Add comparison content',
       !hasStats && 'Add statistics and data',
        wordCount < 1500 && 'Expand content depth'
      ].filter(Boolean),
      depth: score > 80? 'Expert' : score > 60? 'Intermediate' : score > 40? 'Basic' : 'Shallow'
    };
  }, { score: 0, wordCount: 0, headingDepth: 0, entityDensity: 0, contentSignals: {}, missingElements: [], depth: 'Unknown' });
}

// 4. AI ENTITY EXTRACTION - Enhanced
function extractAIEntities($, html) {
  return safeRun(() => {
    const text = $('body').text();

    // Brands: Capitalized words, company names
    const brands = [...new Set((text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [])
     .filter(w => w.length > 3 &&!['The', 'This', 'Your', 'Our', 'WordPress'].includes(w)))].slice(0, 15);

    // Services: Action words + service/product
    const services = [...new Set((text.match(/\b(?:website|seo|design|development|marketing|branding|logo|hosting)\s+(?:design|service|services|optimization|development)/gi) || []))].slice(0, 15);

    // Locations: Countries, cities
    const locations = [...new Set((text.match(/\b(?:USA|UK|Canada|Pakistan|India|UAE|Australia|London|New York|Dubai|Karachi|Lahore)\b/gi) || []))];

    // People: Mr/Mrs/Dr + Name patterns
    const people = [...new Set((text.match(/\b(?:Mr|Mrs|Ms|Dr)\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || []))];

    return { brands, services, locations, people, totalEntities: brands.length + services.length + locations.length + people.length };
  }, { brands: [], services: [], locations: [], people: [], totalEntities: 0 });
}

// 5. INTERNAL LINK OPPORTUNITY FINDER
function findInternalLinkOpportunities($, html) {
  return safeRun(() => {
    const headings = [];
    $('h2, h3').each((i, el) => {
      headings.push({
        text: $(el).text().trim(),
        level: el.tagName,
        anchor: $(el).text().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      });
    });

    const bodyText = $('body').text().toLowerCase();
    const opportunities = [];

    headings.forEach(h => {
      const keywords = h.text.toLowerCase().split(' ').filter(w => w.length > 4);
      keywords.forEach(keyword => {
        const mentions = (bodyText.match(new RegExp(keyword, 'g')) || []).length;
        if (mentions >= 2) { // Keyword appears multiple times but not linked
          opportunities.push({
            keyword,
            targetHeading: h.text,
            anchor: `#${h.anchor}`,
            priority: mentions > 3? 'HIGH' : 'MEDIUM',
            reason: `Keyword "${keyword}" mentioned ${mentions} times. Link to ${h.text}`
          });
        }
      });
    });

    return {
      opportunities: opportunities.slice(0, 10),
      totalFound: opportunities.length,
      linkScore: Math.max(0, 100 - (opportunities.length * 5))
    };
  }, { opportunities: [], totalFound: 0, linkScore: 100 });
}

// 6. CONTENT DECAY DETECTOR
function detectContentDecay($, html, lastModified) {
  return safeRun(() => {
    const currentYear = new Date().getFullYear();
    const text = $('body').text();

    // Check for outdated years
    const yearsFound = text.match(/\b(20[1-2][0-9])\b/g) || [];
    const outdatedYears = yearsFound.filter(y => parseInt(y) < currentYear - 1);

    // Check for outdated stats/claims
    const hasOutdatedStats = /in 202[0-3]|last year|recently/i.test(text);

    // Check last modified date
    const daysSinceUpdate = lastModified? Math.floor((Date.now() - new Date(lastModified)) / (1000 * 60 * 60 * 24)) : 999;

    let decayScore = 100;
    if (outdatedYears.length > 0) decayScore -= outdatedYears.length * 10;
    if (hasOutdatedStats) decayScore -= 15;
    if (daysSinceUpdate > 365) decayScore -= 20; else if (daysSinceUpdate > 180) decayScore -= 10;

    return {
      decayScore: Math.max(0, decayScore),
      daysSinceUpdate,
      outdatedYears: [...new Set(outdatedYears)],
      hasOutdatedStats,
      recommendations: [
        outdatedYears.length > 0 && `Update ${outdatedYears.length} outdated year references`,
        hasOutdatedStats && 'Refresh statistics and claims',
        daysSinceUpdate > 180 && 'Update content - last modified > 6 months ago'
      ].filter(Boolean),
      status: decayScore > 80? 'Fresh' : decayScore > 60? 'Aging' : 'Decayed'
    };
  }, { decayScore: 100, daysSinceUpdate: 0, outdatedYears: [], hasOutdatedStats: false, recommendations: [], status: 'Unknown' });
}

// 7. FEATURED SNIPPET GENERATOR
function generateFeaturedSnippet($, title, metaDescription, h1) {
  return safeRun(() => {
    const question = h1 || title;
    const answer = metaDescription || $('p').first().text().substring(0, 300);

    // Generate paragraph snippet
    const paragraphSnippet = {
      type: 'paragraph',
      question: `What is ${question}?`,
      answer: answer,
      wordCount: answer.split(' ').length,
      optimal: answer.split(' ').length >= 40 && answer.split(' ').length <= 60
    };

    // Generate list snippet from H2s
    const listItems = [];
    $('h2').slice(0, 5).each((i, el) => listItems.push($(el).text().trim()));
    const listSnippet = {
      type: 'list',
      question: `How to ${question.toLowerCase()}?`,
      items: listItems,
      count: listItems.length,
      optimal: listItems.length >= 3 && listItems.length <= 8
    };

    // Generate table snippet if tables exist
    const tableData = [];
    $('table tr').slice(0, 5).each((i, row) => {
      const cells = [];
      $(row).find('td, th').each((j, cell) => cells.push($(cell).text().trim()));
      if (cells.length) tableData.push(cells);
    });

    return {
      paragraph: paragraphSnippet,
      list: listSnippet,
      table: tableData.length > 0? { type: 'table', data: tableData, optimal: true } : null,
      bestFormat: listItems.length >= 3? 'list' : paragraphSnippet.optimal? 'paragraph' : 'none',
      implementation: `Add this HTML above the fold:\n<div itemscope itemtype="https://schema.org/Question">\n <h2 itemprop="name">${paragraphSnippet.question}</h2>\n <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">\n <p itemprop="text">${paragraphSnippet.answer}</p>\n </div>\n</div>`
    };
  }, { paragraph: null, list: null, table: null, bestFormat: 'none', implementation: '' });
}

// 8. PEOPLE ALSO ASK GENERATOR
function generatePeopleAlsoAsk($, keywords, title) {
  return safeRun(() => {
    const mainTopic = title || keywords[0] || 'this topic';
    const baseQuestions = [
      `What is ${mainTopic}?`,
      `How does ${mainTopic} work?`,
      `Why is ${mainTopic} important?`,
      `How much does ${mainTopic} cost?`,
      `What are the benefits of ${mainTopic}?`,
      `How long does ${mainTopic} take?`,
      `Is ${mainTopic} worth it?`,
      `What is the best ${mainTopic}?`,
      `How to choose ${mainTopic}?`,
      `Where to get ${mainTopic}?`
    ];

    // Add keyword-specific questions
    keywords.slice(0, 3).forEach(kw => {
      baseQuestions.push(`What is ${kw}?`, `How to use ${kw}?`);
    });

    return {
      questions: baseQuestions.slice(0, 12),
      totalGenerated: 12,
      schemaCode: `{\n "@context": "https://schema.org",\n "@type": "FAQPage",\n "mainEntity": [\n${baseQuestions.slice(0, 5).map(q => ` {\n "@type": "Question",\n "name": "${q}",\n "acceptedAnswer": {\n "@type": "Answer",\n "text": "Answer about ${q.toLowerCase()}..."\n }\n }`).join(',\n')}\n ]\n}`,
      implementation: 'Add FAQPage schema to capture PAA boxes in Google'
    };
  }, { questions: [], totalGenerated: 0, schemaCode: '', implementation: '' });
}

// 9. AI VISIBILITY TREND TRACKING - Server side storage
const trendDB = {}; // In-memory for demo. Use Redis/DB in production

function trackAIVisibilityTrend(url, currentScore) {
  return safeRun(() => {
    const key = Buffer.from(url).toString('base64');
    if (!trendDB[key]) trendDB[key] = [];

    trendDB[key].push({
      score: currentScore,
      timestamp: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0]
    });

    // Keep last 30 entries
    if (trendDB[key].length > 30) trendDB[key] = trendDB[key].slice(-30);

    const history = trendDB[key];
    const trend = history.length > 1?
      history[history.length - 1].score - history[0].score : 0;

    return {
      current: currentScore,
      history: history.slice(-7), // Last 7 scans
      trend: trend > 0? `+${trend}` : trend.toString(),
      direction: trend > 0? 'improving' : trend < 0? 'declining' : 'stable',
      average: Math.round(history.reduce((sum, h) => sum + h.score, 0) / history.length)
    };
  }, { current: currentScore, history: [], trend: '0', direction: 'stable', average: currentScore });
}

// INTEGRATE INTO EXISTING SCAN ENDPOINT
// Find your existing /scan endpoint and add this BEFORE res.json(data):
/*
  // Append v5.1 features - DO NOT MODIFY EXISTING DATA
  const $ = cheerio.load(html);
  const entities = extractAIEntities($, html);

  data.v51Features = {
    brokenLinks: await checkBrokenLinks($, url),
    coreWebVitals: await analyzeCoreWebVitals(url),
    topicalAuthority: calculateTopicalAuthority($, html, entities),
    aiEntities: entities,
    internalLinkOpportunities: findInternalLinkOpportunities($, html),
    contentDecay: detectContentDecay($, html, data.lastModified),
    featuredSnippet: generateFeaturedSnippet($, data.title, data.metaDescription, data.h1),
    peopleAlsoAsk: generatePeopleAlsoAsk($, data.keywords, data.title),
    visibilityTrend: trackAIVisibilityTrend(url, data.overallAIVisibilityScore)
  };

  // Keep backward compatibility - merge into root for old frontend
  data.brokenLinkCount = data.v51Features.brokenLinks.brokenCount;
  data.lcpScore = data.v51Features.coreWebVitals.lcp;
*/
// NEW MODULE END
app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform v5.0 running on port ${PORT}`);
  console.log(`📊 All 20 features enabled | Empty HTML fix applied | Error handling active`);
});
