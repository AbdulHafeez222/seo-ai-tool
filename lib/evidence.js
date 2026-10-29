import { parseRobots, robotsAllows } from './robots.js';

const sources = {
  openai: 'https://developers.openai.com/api/docs/bots',
  anthropic: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler',
  google: 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers'
};
const bots = [
  ['OAI-SearchBot', 'Search discovery', sources.openai],
  ['GPTBot', 'Model training', sources.openai],
  ['ChatGPT-User', 'User-triggered retrieval', sources.openai],
  ['Claude-SearchBot', 'Search discovery', sources.anthropic],
  ['ClaudeBot', 'Model training', sources.anthropic],
  ['Claude-User', 'User-triggered retrieval', sources.anthropic],
  ['Googlebot', 'Google Search, including Search AI features', sources.google],
  ['Google-Extended', 'Gemini training and grounding; independent of Search', sources.google]
];

export function crawlerPolicyMatrix(url, robotsData) {
  const known = robotsData?.available === true && (robotsData.found || [404, 410].includes(robotsData.status));
  return {
    scope: 'robots.txt policy for this URL only. No bot requests, firewall access, indexing or citations were verified. Training opt-outs are owner preferences, not SEO failures.',
    checkedUrl: url,
    bots: bots.map(([agent, purpose, source]) => ({
      agent, purpose, source,
      policy: known ? (robotsAllows(url, parseRobots(robotsData.raw || '', agent).rules) ? 'allowed' : 'disallowed') : 'unknown',
      note: agent === 'ChatGPT-User' ? 'User-triggered requests may not follow robots.txt; this is only the declared policy.' : agent === 'Google-Extended' ? 'Product-control token, not a separate HTTP crawler or Google Search ranking signal.' : ''
    }))
  };
}

function validLanguage(value) {
  try { return Boolean(Intl.getCanonicalLocales(value)[0]); } catch { return false; }
}
function httpUrl(value, base) {
  try { const url = new URL(value, base); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
}

// All observations reuse the downloaded page. No additional requests or paid APIs.
export function analyzePageEvidence($, page, robotsData) {
  const url = page.resolvedUrl;
  const findings = [];
  const add = (priority, check, evidence, action) => findings.push({priority, check, evidence, action});
  const language = String(page.language || '').toLowerCase();
  const direction = String($('html').attr('dir') || '').toLowerCase();
  const letters = (page.visibleText || '').match(/\p{L}/gu) || [];
  const arabicLetters = letters.filter(c => /\p{Script_Extensions=Arabic}/u.test(c)).length;
  const arabicShare = letters.length ? arabicLetters / letters.length : null;
  const rtlExpected = /^(ar|ur|ps|fa|he|yi|ug|sd)(-|$)/.test(language) || (arabicShare !== null && arabicShare > 0.5);
  if (!language || !validLanguage(language)) add('High', 'Document language', language || 'Missing html lang.', 'Declare the actual BCP 47 document language; script alone cannot distinguish Urdu, Pashto or Arabic.');
  if (rtlExpected && !['rtl', 'auto'].includes(direction)) add('Medium', 'RTL direction', `html dir=${direction || '(missing)'}`, 'Review inherited direction and CSS; set dir="rtl" on right-to-left documents where appropriate.');

  const alternates = [];
  const seen = new Set();
  $('link[rel~="alternate"][hreflang]').slice(0, 200).each((_, el) => {
    const code = String($(el).attr('hreflang') || '').toLowerCase();
    const href = String($(el).attr('href') || '');
    const target = href.trim() ? httpUrl(href, url) : null;
    const valid = (code === 'x-default' || validLanguage(code)) && Boolean(target);
    if (!valid) add('High', 'Hreflang syntax', `${code || '(missing)'} → ${href}`, 'Use a valid language tag and an HTTP(S) alternate URL.');
    if (seen.has(code)) add('Medium', 'Duplicate hreflang', code, 'Publish a single alternate per language/region for this document.');
    seen.add(code);
    alternates.push({language: code, url: target?.href || null, valid});
  });
  const canonicalTags = $('link[rel~="canonical"]');
  const canonicalValue = String(canonicalTags.first().attr('href') || '').trim();
  const canonical = canonicalValue ? httpUrl(canonicalValue, url) : null;
  if (canonicalTags.length > 1) add('High', 'Multiple canonicals', `${canonicalTags.length} declarations`, 'Publish one consistent canonical.');
  if (canonicalTags.length && !canonical) add('High', 'Invalid canonical', canonicalValue || 'Empty href.', 'Use an HTTP(S) canonical URL.');
  if (canonical && canonical.origin !== new URL(url).origin) add('Medium', 'Cross-origin canonical', canonical.href, 'Confirm that consolidation to the other origin is intentional. Target availability is unverified.');
  const directives = [page.robots || '', ...$('meta[name="googlebot" i]').map((_, el) => $(el).attr('content') || '').get()].join(',');
  if (/(?:^|[\s,])(noindex|none)(?:$|[\s,])/i.test(directives)) add('High', 'Indexing restriction', directives, 'Confirm whether excluding this page from search is intentional.');
  const answerBlocks = [];
  $('h2,h3').each((_, el) => {
    if (answerBlocks.length >= 20) return;
    const heading = $(el).text().replace(/\s+/g, ' ').trim();
    const next = $(el).next();
    const answer = next.is('p,ul,ol,table') ? next.text().replace(/\s+/g, ' ').trim() : '';
    if (heading && answer) answerBlocks.push({heading: heading.slice(0, 250), excerpt: answer.slice(0, 600), format: next.prop('tagName').toLowerCase()});
  });
  if (!answerBlocks.length) add('Medium', 'Extractable answers', 'No H2/H3 immediately followed by a paragraph, list or table.', 'For relevant informational topics, place a concise answer after its heading. This does not guarantee an AI citation.');
  if (!page.author) add('Low', 'Attribution', 'No author found by existing extraction.', 'For authored advice, identify the responsible author or reviewer. This may not apply to every page type.');
  const priority = {High: 0, Medium: 1, Low: 2};
  findings.sort((a,b) => priority[a.priority] - priority[b.priority]);
  return {
    version: 1,
    scope: 'Observed HTML on one page. Recommendations are contextual heuristics. Hreflang reciprocity, alternate targets, CSS rendering and HTTP header directives are unverified.',
    locale: {language: language || null, direction: direction || null, arabicScriptShare: arabicShare, rtlReviewSuggested: rtlExpected, languageDetectedFromScript: false},
    alternates, canonical: {declared: canonicalValue || null, resolved: canonical?.href || null, targetVerified: false},
    answerBlocks, findings, crawlerPolicies: crawlerPolicyMatrix(url, robotsData)
  };
}
