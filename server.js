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
    const timeout = setTimeout(() => controller.abort(), options.timeout || 10000);
    const res = await fetch(url, {
     ...options,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SEO-AEO-Bot/3.0)",...options.headers },
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

// ========== UPGRADE 1: SCHEMA DETECTION PRO ==========
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
      const items = Array.isArray(json)? json : [];

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
    } catch (e) {
      console.error('Schema parse error:', e.message);
    }
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

// ========== UPGRADE 4: INTERNAL LINK INTELLIGENCE ==========
function analyzeInternalLinks($, url, h2s) {
  const baseUrl = new URL(url).origin;
  const allLinks = $('a').map((i, el) => $(el).attr('href')).get();
  const internalLinks = allLinks.filter(href =>
    href && (href.startsWith('/') || href.startsWith(baseUrl))
  );

  const linkMap = {};
  internalLinks.forEach(link => {
    const clean = link.split('#')[0].split('?')[0];
    linkMap[clean] = (linkMap[clean] || 0) + 1;
  });

  const orphanPages = [];
  const totalPages = Object.keys(linkMap).length;
  if (totalPages < 3) orphanPages.push(`${baseUrl}/blog`);

  const linkDepths = internalLinks.map(link => {
    const parts = link.split('/').filter(Boolean);
    return parts.length;
  });
  const avgDepth = linkDepths.length > 0? (linkDepths.reduce((a,b) => a+b, 0) / linkDepths.length).toFixed(1) : 0;

  const authorityFlow = h2s.length > 0? Math.round((internalLinks.length / h2s.length) * 100) : 0;

  const weakLinking = internalLinks.length < h2s.length;
  const suggestions = [];
  if (weakLinking) {
    h2s.slice(0, 3).forEach(h2 => {
      suggestions.push(`Add internal link to section: ${h2}`);
    });
  }

  return {
    totalInternalLinks: internalLinks.length,
    uniquePages: Object.keys(linkMap).length,
    orphanPages,
    avgLinkDepth: parseFloat(avgDepth),
    authorityFlow,
    weakLinking,
    suggestions,
    linkDistribution: linkMap,
    score: Math.max(0, 100 - (orphanPages.length * 20) - (weakLinking? 30 : 0) - (avgDepth > 4? 20 : 0))
  };
}

// ========== UPGRADE 5: E-E-A-T ADVANCED ==========
function calculateEEATAdvanced($, bodyText, hasAuthor, hasAboutPage, hasContactPage, hasPrivacyPolicy, hasLinkedIn, hasFacebook, isHttps, hasLastModified, schemas) {
  const breakdown = {
    experience: { score: 0, max: 25, factors: [] },
    expertise: { score: 0, max: 25, factors: [] },
    authoritativeness: { score: 0, max: 25, factors: [] },
    trustworthiness: { score: 0, max: 25, factors: [] }
  };

  if (hasAuthor) {
    breakdown.experience.score += 10;
    breakdown.experience.factors.push("✓ Author attribution");
  }
  if (bodyText.match(/I have|we have|our experience|years of/i)) {
    breakdown.experience.score += 8;
    breakdown.experience.factors.push("✓ First-hand experience mentioned");
  }
  if (bodyText.match(/case study|portfolio|client/i)) {
    breakdown.experience.score += 7;
    breakdown.experience.factors.push("✓ Case studies/portfolio");
  }

  if (hasAboutPage) {
    breakdown.expertise.score += 10;
    breakdown.expertise.factors.push("✓ About page exists");
  }
  if (hasAuthor && bodyText.match(/expert|specialist|certified|degree/i)) {
    breakdown.expertise.score += 8;
    breakdown.expertise.factors.push("✓ Expert credentials mentioned");
  }
  if (schemas.Organization?.present) {
    breakdown.expertise.score += 7;
    breakdown.expertise.factors.push("✓ Organization schema");
  }

  if (hasLinkedIn) {
    breakdown.authoritativeness.score += 8;
    breakdown.authoritativeness.factors.push("✓ LinkedIn presence");
  }
  if (hasFacebook) {
    breakdown.authoritativeness.score += 5;
    breakdown.authoritativeness.factors.push("✓ Social media presence");
  }
  if ($('a[href*="wikipedia"]').length > 0 || $('a[href*="gov"]').length > 0) {
    breakdown.authoritativeness.score += 7;
    breakdown.authoritativeness.factors.push("✓ Cites authoritative sources");
  }
  if (bodyText.match(/featured|award|recognition/i)) {
    breakdown.authoritativeness.score += 5;
    breakdown.authoritativeness.factors.push("✓ Awards/recognition mentioned");
  }

  if (isHttps) {
    breakdown.trustworthiness.score += 6;
    breakdown.trustworthiness.factors.push("✓ HTTPS secure");
  }
  if (hasPrivacyPolicy) {
    breakdown.trustworthiness.score += 5;
    breakdown.trustworthiness.factors.push("✓ Privacy policy");
  }
  if (hasContactPage) {
    breakdown.trustworthiness.score += 6;
    breakdown.trustworthiness.factors.push("✓ Contact information");
  }
  if (hasLastModified) {
    breakdown.trustworthiness.score += 4;
    breakdown.trustworthiness.factors.push("✓ Recently updated");
  }
  if (schemas.LocalBusiness?.present) {
    breakdown.trustworthiness.score += 4;
    breakdown.trustworthiness.factors.push("✓ LocalBusiness schema");
  }

  const totalScore = breakdown.experience.score + breakdown.expertise.score + breakdown.authoritativeness.score + breakdown.trustworthiness.score;

  return {
    score: totalScore,
    breakdown,
    level: totalScore >= 80? "Excellent" : totalScore >= 60? "Good" : totalScore >= 40? "Fair" : "Poor"
  };
}

// ========== ENTITY EXTRACTION ==========
function extractEntitiesFromContent(text, headings = "") {
  if (!text) return { keywords: [], entities: [], prices: [], locations: [], services: [], brands: [] };

  const brandRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  const brands = [...new Set((text + ' ' + headings).match(brandRegex) || [])]
.filter(e => e.length > 3 &&!['The', 'This', 'That', 'With', 'From', 'What', 'How', 'Why'].includes(e))
.slice(0, 5);

  const locationKeywords = ['USA','UK','Canada','Pakistan','India','Australia','Germany','France','UAE','Dubai','London','New York','Karachi','Lahore'];
  const locations = [...new Set(locationKeywords.filter(loc =>
    text.toLowerCase().includes(loc.toLowerCase()) || headings.toLowerCase().includes(loc.toLowerCase())
  ))];

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

    const title = $("title").text().trim() || "";
    const h1 = $("h1").first().text().trim() || "";
    const metaDescription = $('meta[name="description"]').attr("content") || "";
    const bodyText = $("p, li, h2, h3, h4, td").text().replace(/\s+/g, " ").trim();
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
    const h2s = $("h2").map((i, el) => $(el).text().trim()).get().filter(Boolean);

    const schemas = detectAllSchemas($, html);
    const uniqueSchemas = Object.keys(schemas).filter(k => schemas[k].present);
    const recommendedSchemas = Object.keys(schemas).filter(k => schemas[k].recommended &&!schemas[k].present);

    const faqQuestions = [];
    if (schemas.FAQPage.present && schemas.FAQPage.data.length > 0) {
      schemas.FAQPage.data.forEach(schema => {
        schema.mainEntity?.forEach(q => {
          if (q.name) faqQuestions.push(q.name);
        });
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

    const aiTrustScore = Math.round((eeatData.score * 0.4) + (seoScore * 0.3) + (aeoScore * 0.3));

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

    const schemaIntelligenceScore = Math.round(
      Object.values(schemas).reduce((sum, s) => sum + (s.present? 100 : 0), 0) / 8
    );

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

    const chatGPTReadiness = Math.min(100,
      (hasFAQ? 30 : 0) +
      (hasDirectAnswer? 25 : 0) +
      (listCount > 2? 20 : 0) +
      (readabilityScore > 70? 15 : 0) +
      (hasAuthor? 10 : 0)
    );

    const geminiReadiness = Math.min(100,
      (hasSchemaMarkup? 35 : 0) +
      (tableCount > 0? 25 : 0) +
      (hasLastModified? 20 : 0) +
      (eeatData.score > 60? 20 : 0)
    );

    const perplexityReadiness = Math.min(100,
      (hasDirectAnswer? 30 : 0) +
      (wordCount > 800? 25 : 0) +
      (externalLinks > 5? 20 : 0) +
      (hasLastModified? 15 : 0) +
      (listCount > 0? 10 : 0)
    );

    const claudeReadiness = Math.min(100,
      (readabilityScore > 75? 30 : 0) +
      (hasAboutPage? 25 : 0) +
      (hasAuthor? 20 : 0) +
      (hasPrivacyPolicy? 15 : 0) +
      (h2Count >= 4? 10 : 0)
    );

    const aiVisibilityLevel = overallAIVisibilityScore >= 80? "Excellent" :
                              overallAIVisibilityScore >= 60? "Good" :
                              overallAIVisibilityScore >= 40? "Fair" : "Poor";

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
    const expectedSubtopics = [
      `What is ${mainTopic}`,
      `${mainTopic} Benefits`,
      `How to ${mainTopic}`,
      `${mainTopic} Examples`,
      `${mainTopic} vs Alternatives`
    ];
    const missingSubtopics = expectedSubtopics.filter(exp =>
   !subtopics.some(sub => sub.toLowerCase().includes(exp.toLowerCase().split(' ')[0]))
    );
    const topicCoverage = Math.round(((expectedSubtopics.length - missingSubtopics.length) / expectedSubtopics.length) * 100);

    const topicalAuthorityScore = Math.round(
      (topicCoverage * 0.4) +
      (subtopics.length >= 5? 30 : subtopics.length * 6) +
      (hasFAQ? 15 : 0) +
      (wordCount > 1200? 15 : wordCount > 800? 10 : 5)
    );

    const autoFAQ = [];
    if (h1) {
      autoFAQ.push({
        q: `What is ${h1}?`,
        a: metaDescription || bodyText.substring(0, 120)
      });
    }
    if (prices.length > 0) {
      autoFAQ.push({
        q: `How much does ${services[0] || 'the service'} cost?`,
        a: `Pricing starts at ${prices[0]}. Contact us for custom quotes.`
      });
    }
    if (locations.length > 0) {
      autoFAQ.push({
        q: `Do you serve ${locations[0]} clients?`,
        a: `Yes, we serve clients in ${locations.slice(0, 3).join(', ')}.`
      });
    }
    if (allText.includes('delivery') || allText.includes('days')) {
      autoFAQ.push({
        q: `What is your delivery time?`,
        a: `Typical delivery is 7 days for standard projects.`
      });
    }

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
        answer: hasDirectAnswer
       ? `${brands[0] || getBrandName(url)} offers ${services[0] || mainTopic}${prices[0]? ' starting at ' + prices[0] : ''}. ${metaDescription.substring(0, 100)}`
          : `Based on available data, ${mainTopic} relates to ${keywords.slice(0,3).join(', ')}. For specific details, check the official website.`,
        sources: hasAuthor? ["Official Website", "Author Profile"] : ["Official Website"],
        willCite: hasDirectAnswer && hasFAQ && listCount >= 2
      },
      gemini: {
        answer: hasSchemaMarkup
       ? `According to structured data: ${title}. Key services include ${services.slice(0,2).join(' and ')}. ${hasLastModified? 'Last updated: ' + lastModified : ''}`
          : `${title}. ${metaDescription.substring(0, 120)}`,
        sources: hasSchemaMarkup? ["Schema.org Data", "Website"] : ["Website"],
        willCite: hasSchemaMarkup && tableCount > 0 && hasAuthor
      },
      perplexity: {
        answer: hasLastModified
       ? `${aiExtractedAnswer} [Updated ${lastModified}]`
          : aiExtractedAnswer,
        sources: hasLastModified? ["Official Site (2026)", "Cited Sources"] : ["Official Site"],
        willCite: hasDirectAnswer && hasLastModified && externalLinks > 3
      },
      status: "live"
    };

    const aiCitationSimulator = {
      chatgpt: {
        willCite: hasDirectAnswer && hasFAQ && listCount >= 2,
        reasons: [],
        score: citationChatGPT,
        improvements: []
      },
      gemini: {
        willCite: hasSchemaMarkup && tableCount > 0 && hasAuthor,
        reasons: [],
        score: citationGemini,
        improvements: []
      },
      perplexity: {
        willCite: hasDirectAnswer && hasLastModified && externalLinks > 3,
        reasons: [],
        score: citationPerplexity,
        improvements: []
      }
    };

    if (hasDirectAnswer) aiCitationSimulator.chatgpt.reasons.push("✓ Direct answer in first 100 words");
    else {
      aiCitationSimulator.chatgpt.reasons.push("✗ No direct answer format");
      aiCitationSimulator.chatgpt.improvements.push("Add: 'Quick Answer: [50-word summary]' at top");
    }

    if (hasFAQ) aiCitationSimulator.chatgpt.reasons.push("✓ FAQ schema present");
    else {
      aiCitationSimulator.chatgpt.reasons.push("✗ No FAQ schema");
      aiCitationSimulator.chatgpt.improvements.push("Add FAQPage JSON-LD schema");
    }

    if (listCount >= 2) aiCitationSimulator.chatgpt.reasons.push("✓ Structured lists for extraction");
    else {
      aiCitationSimulator.chatgpt.reasons.push("✗ No lists/bullets");
      aiCitationSimulator.chatgpt.improvements.push("Add bullet points or numbered lists");
    }

    if (!hasAuthor) {
      aiCitationSimulator.chatgpt.reasons.push("✗ No author attribution");
      aiCitationSimulator.chatgpt.improvements.push("Add author bio with credentials");
    }

    if (prices.length === 0) {
      aiCitationSimulator.chatgpt.reasons.push("✗ No statistics/pricing data");
      aiCitationSimulator.chatgpt.improvements.push("Add specific numbers: pricing, stats, dates");
    }

    if (hasSchemaMarkup) aiCitationSimulator.gemini.reasons.push("✓ Rich schema markup detected");
    else {
      aiCitationSimulator.gemini.reasons.push("✗ No structured data");
      aiCitationSimulator.gemini.improvements.push("Add Article + Organization schema");
    }

    if (tableCount > 0) aiCitationSimulator.gemini.reasons.push("✓ Tables for data extraction");
    else {
      aiCitationSimulator.gemini.reasons.push("✗ No tables found");
      aiCitationSimulator.gemini.improvements.push("Add comparison tables");
    }

    if (hasAuthor) aiCitationSimulator.gemini.reasons.push("✓ Author signals present");
    else {
      aiCitationSimulator.gemini.reasons.push("✗ Missing author EEAT");
      aiCitationSimulator.gemini.improvements.push("Add author section with bio");
    }

    if (hasDirectAnswer) aiCitationSimulator.perplexity.reasons.push("✓ Direct answers available");
    else {
      aiCitationSimulator.perplexity.reasons.push("✗ No clear Q&A format");
      aiCitationSimulator.perplexity.improvements.push("Add Q&A format: Q:... A:...");
    }

    if (hasLastModified) aiCitationSimulator.perplexity.reasons.push("✓ Fresh content date");
    else {
      aiCitationSimulator.perplexity.reasons.push("✗ No last modified date");
      aiCitationSimulator.perplexity.improvements.push("Add <meta property='article:modified_time'>");
    }

    if (externalLinks > 3) aiCitationSimulator.perplexity.reasons.push("✓ External citations present");
    else {
      aiCitationSimulator.perplexity.reasons.push("✗ Few trust signals");
      aiCitationSimulator.perplexity.improvements.push("Add links to Wikipedia,.gov, research papers");
    }

      const aiRecommendations = [];
    if (!hasFAQ) aiRecommendations.push({
      priority: "CRITICAL",
      action: "Add FAQ Schema",
      impact: "+15% ChatGPT Citation",
      effort: "15 mins",
      code: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is ${mainTopic}?","acceptedAnswer":{"@type":"Answer","text":"${metaDescription}"}}]}</script>`
    });

    if (!hasAuthor) aiRecommendations.push({
      priority: "HIGH",
      action: "Add Author Section with Credentials",
      impact: "+12% EEAT Score",
      effort: "10 mins",
      code: `<div class="author" itemprop="author">By <span itemprop="name">John Doe</span>, <span itemprop="jobTitle">SEO Expert</span></div>`
    });

    if (!hasDirectAnswer) aiRecommendations.push({
      priority: "HIGH",
      action: "Add Direct Answer Block in First 100 Words",
      impact: "+20% Featured Snippet Chance",
      effort: "20 mins",
      code: `<p><strong>Quick Answer:</strong> [50-word summary of the page]</p>`
    });

    if (wordCount < 800) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Statistics/Data Points",
      impact: "+10% AI Trust Score",
      effort: "30 mins",
      code: `Add: "Studies show 73% of users..." with source citation`
    });

    if (externalLinks < 3) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Trust Signals - External Citations",
      impact: "+8% Perplexity Citation",
      effort: "15 mins",
      code: `Link to: Google, Wikipedia, Industry reports,.gov sources`
    });

    if (listCount < 2) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add Comparison Tables/Lists",
      impact: "+12% Gemini Citation",
      effort: "25 mins",
      code: `<table><thead><tr><th>Feature</th><th>Us</th><th>Them</th></tr></thead></table>`
    });

    if (!schemas.Organization.present) aiRecommendations.push({
      priority: "HIGH",
      action: "Add Organization Schema",
      impact: "+10% EEAT Score",
      effort: "20 mins",
      code: `<script type="application/ld+json">{"@type":"Organization","name":"${getBrandName(url)}","url":"${url}"}</script>`
    });

    if (!schemas.LocalBusiness.present && (allText.includes('service') || allText.includes('agency'))) aiRecommendations.push({
      priority: "MEDIUM",
      action: "Add LocalBusiness Schema",
      impact: "+8% Local AI Citations",
      effort: "25 mins",
      code: `<script type="application/ld+json">{"@type":"LocalBusiness","name":"${getBrandName(url)}","address":{"@type":"PostalAddress","addressCountry":"PK"}}</script>`
    });

    const recommendationScore = Math.max(0, 100 - (aiRecommendations.length * 12));

    const visibilityForecast = {
      current: overallAIVisibilityScore,
      afterFAQ: Math.min(100, overallAIVisibilityScore + (hasFAQ? 0 : 15)),
      afterHowTo: Math.min(100, overallAIVisibilityScore + (hasHowTo? 0 : 12)),
      afterAuthor: Math.min(100, overallAIVisibilityScore + (hasAuthor? 0 : 10)),
      afterSchema: Math.min(100, overallAIVisibilityScore + (hasSchemaMarkup? 0 : 8)),
      afterAll: Math.min(100, overallAIVisibilityScore + recommendationScore)
    };

    return {
      url, title, h1, metaDescription, wordCount, lastModified,
      score: seoScore,
      status: seoStatus,
      overallAIVisibilityScore,
      aiVisibilityLevel,
      breakdown: {
        seo: seoScore,
        aeo: aeoScore,
        schemaValidator,
        schemaIntelligence: schemas,
        schemaIntelligenceScore,
        eeatScore: eeatData.score,
        eeatBreakdown: eeatData.breakdown,
        internalLinkingAudit: internalLinkData,
        topicalAuthorityScore,
        topicCoverage,
        missingSubtopics,
        trust: aiTrustScore,
        citation: citationProbability,
        readability: readabilityScore,
        schema: schemaScore,
        contentDecay,
      },
      citationProbability,
      totalImages, imagesWithoutAlt, internalLinks: internalLinkData.totalInternalLinks, externalLinks,
      mobileFriendly: mobileViewport, isHttps, loadTime, brokenLinks: 0,
      mobileScore, desktopScore,
      hasSchemaMarkup, robotsExists, sitemapExists, hasCanonical,
      canonical, hasFavicon, favicon,
      hasOGTags, ogTitle, ogDescription, ogImage,
      aeoScore, aeoStatus,
      hasFAQ, hasHowTo, hasDirectAnswer,
      schemas: uniqueSchemas,
      recommendedSchemas,
      keywords,
      keywordInsights,
      entities: {
        brands,
        locations,
        services,
        prices,
        all: entities
      },
      aiReport: "Advanced rule-based analysis complete",
      readabilityScore, aiTrustScore,
      answerQualityScore: answerQuality,
      featuredSnippetChance,
      contentStructureScore: (h1Count === 1? 20 : 0) + (h2Count >= 3? 20 : 0) + (h3Count >= 5? 20 : 0) + (listCount >= 2? 20 : 0) + (tableCount >= 1? 20 : 0),
      citationChatGPT, citationGemini, citationPerplexity,
      aiExtractedAnswer,
      topicAuthority: {
        mainTopic: h1 || title.split(" ").slice(0, 3).join(" "),
        found: keywords.slice(0, 5),
        entities,
        missing: [],
        subtopics
      },
      aiReadiness: {
        chatgpt: chatGPTReadiness,
        gemini: geminiReadiness,
        perplexity: perplexityReadiness,
        claude: claudeReadiness
      },
      aiCitationSimulator,
      aiSearchSimulation,
      visibilityForecast,
      aiRecommendations,
      recommendationScore,
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
    version: "4.0-production",
    timestamp: new Date().toISOString()
  });
});

app.get("/analyze", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url);

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

app.get("/competitor-gap-ai", async (req, res) => {
  const { url, competitor } = req.query;
  if (!url ||!competitor) return res.status(400).json({ error: "Both URLs required" });

  try {
    const [yourData, compData] = await Promise.all([
      analyzeSingleUrl(url.startsWith('http')? url : 'https://' + url),
      analyzeSingleUrl(competitor.startsWith('http')? competitor : 'https://' + competitor)
    ]);

    const yourH2s = yourData.topicAuthority?.subtopics || [];
    const compH2s = compData.topicAuthority?.subtopics || [];

    const missingH2s = compH2s.filter(h2 =>
!yourH2s.some(y => y.toLowerCase().includes(h2.toLowerCase().split(' ')[0]))
    );

    const yourKeywords = new Set(yourData.keywords);
    const missingKeywords = compData.keywords.filter(k =>!yourKeywords.has(k));

    const yourEntities = new Set(yourData.entities?.all || []);
    const missingEntities = (compData.entities?.all || []).filter(e =>!yourEntities.has(e));

    const yourFAQs = yourData.autoFAQ.map(f => f.q);
    const compFAQs = compData.autoFAQ.map(f => f.q);
    const missingFAQs = compFAQs.filter(f =>!yourFAQs.includes(f));

    const contentLengthGap = compData.wordCount - yourData.wordCount;

    res.json({
      your: { url: yourData.url, wordCount: yourData.wordCount, brand: getBrandName(yourData.url) },
      competitor: { url: compData.url, wordCount: compData.wordCount, brand: getBrandName(compData.url) },
      gaps: {
        missingH2s: missingH2s.slice(0, 5),
        missingKeywords: missingKeywords.slice(0, 10),
        missingEntities: missingEntities.slice(0, 8),
        missingFAQs: missingFAQs.slice(0, 5),
        contentLengthGap: contentLengthGap > 0? `+${contentLengthGap} words needed` : 'You have more content',
        schemaGaps: compData.schemas.filter(s =>!yourData.schemas.includes(s))
      },
      opportunityScore: Math.min(100,
        (missingH2s.length * 10) +
        (missingKeywords.length * 5) +
        (missingEntities.length * 8) +
        (missingFAQs.length * 12)
      )
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        code: `JSON-LD FAQPage schema with 3-5 questions`,
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
        code: `<div class="author" itemprop="author">Written by [Name], [Credentials]</div>`,
        why: "Google EEAT requires author attribution for trust signals"
      });
    }

    if (!data.hasDirectAnswer) {
      roadmap.push({
        step: step++,
        priority: "HIGH",
        task: "Add Direct Answer Block in First 100 Words",
        impact: "+20 Featured Snippet Chance",
        effort: "Medium (30 mins)",
        code: `<p><strong>Quick Answer:</strong> [50-word summary]</p>`,
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
        code: `<meta property="article:modified_time" content="2026-01-15">`,
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
        code: `JSON-LD Article schema with author, datePublished`,
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
        code: `<img src="image.jpg" alt="Descriptive text">`,
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
        code: `<meta property="og:title" content="...">`,
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
      roadmap,
      forecast: data.visibilityForecast
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
    entities: ["Brand", "Service", "Location", "Price"],
    note: "AI-optimized brief. Add these elements for 80+ AI visibility.",
    status: "live"
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
      opportunity: `${missing.length} keywords you can target`,
      estimatedTrafficGain: `+${missing.length * 50}-${missing.length * 200} visits/month`
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
  res.json({ status: "OK", ai: "live", timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: "Something went wrong. Please try again.",
    fallback: true
  });
});

app.get("/citation-simulator-v2", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url);
    res.json({
      url: data.url,
      overallProbability: data.citationProbability,
      chatgpt: data.aiCitationSimulator.chatgpt,
      gemini: data.aiCitationSimulator.gemini,
      perplexity: data.aiCitationSimulator.perplexity,
      criticalFix: [
   !data.hasFAQ? "Add FAQ Schema" : null,
   !data.hasAuthor? "Add Author Bio" : null,
   !data.hasLastModified? "Add Last Modified Date" : null,
        data.entities.prices.length === 0? "Add Statistics/Pricing" : null
      ].filter(Boolean)[0] || "Content is AI-ready"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/ai-snippet-generator", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await analyzeSingleUrl(url);
    const topic = data.h1 || data.title;

    const snippets = {
      directAnswer: `Quick Answer: ${topic} is ${data.metaDescription || '...'}`,
      featuredSnippet: `${topic}\n\nKey Points:\n• ${data.keywords[0] || 'Point 1'}\n• ${data.keywords[1] || 'Point 2'}\n• ${data.keywords[2] || 'Point 3'}`,
      aiOverview: `Based on analysis, ${topic} helps users with ${data.keywords.slice(0,3).join(', ')}. Key benefits include improved ${data.keywords[0] || 'results'}.`,
      faqBlock: data.autoFAQ.length? `Q: ${data.autoFAQ[0].q}\nA: ${data.autoFAQ[0].a}` : `Q: What is ${topic}?\nA: ${data.metaDescription}`
    };

    res.json({ url, topic, snippets, readyToCopy: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AI Visibility Platform v4.0 running on port ${PORT}`);
  console.log(`📊 Features: SEO/AEO/AI Visibility | Entity Extraction | Citation Simulator v3 | Internal Link Intelligence | E-E-A-T Advanced`);
});tion",
      effort: "15 mins",
      code: `<script type="application/ld+json">{"@context":"https://schema.org","
