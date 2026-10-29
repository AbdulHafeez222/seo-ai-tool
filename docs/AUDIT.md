# Production beta audit — 2026-10-29

Baseline: `eb2831c93c1bc5a3a25118e71f25fd249648db57` on main. Static repository inspection completed before application edits. No production credentials, customer data, or databases accessed. Findings below describe the baseline; see RELEASE_READINESS.md for remediation and executed checks.

## Architecture and inventory

All 16 tracked files inspected (including license, ignore rules, package/lock, Docker/Railpack and legacy modules). No AGENTS.md, tests, CI, controllers directory, or dedicated auth middleware exists.

* `server.js`: 7,177-line ESM Express monolith; inline User, Report, Project, SiteCrawlJob Mongoose models; JWT/bcrypt accounts; in-memory anonymous quotas, cache/history/trends; Axios -> Playwright -> stealth fallback; Cheerio extraction and deterministic heuristic scoring; PSI integration; API routes; background site crawl; shutdown.
* `public/index.html`: 4,091-line responsive single-page interface containing styles and JavaScript. Chart.js and html2pdf loaded from third-party CDNs. Login/register, dashboard/report/site crawl modals, scan/compare/gap/roadmap/brief actions and browser PDF export.
* Unwired legacy files: CommonJS `index.js` incompatible with package ESM mode; `scan.js` and `report.js` import nonexistent services; `Report.js` and `models/report.js` duplicate Report model registration; `seoCalculator.js` is a separate simplistic scoring engine; `aiService.js` is an unused OpenRouter integration. Preserve pending compatibility review; these are not the production entry point.
* `package.json`: start only, Node 22 requested; Docker Playwright 1.54 image but floating Playwright dependency; malformed lockfile. Railpack recipe not verified.

## Baseline feature status

| Area | Present | Broken or incomplete |
|---|---|---|
| Accounts | Registration/login/me, bcrypt, JWT, login lockout | No reset, email verification, revocation, account deletion, admin controls; localStorage bearer tokens; registration unthrottled |
| Scans | HTTP/browser, block detection, metrics, cache, best-effort persistence | SSRF, insecure TLS, challenge evasion, unbounded aggregate concurrency; cache ownership and missing-data issues |
| SEO/GEO/AEO | Technical, content, image, semantic, trust, local and citation heuristics | Schema/resolved URL not wired before scoring; duplicated body words; fabricated metadata; lists/tables never detected; inferred entities called verified |
| Competitors | Two-site and 2–5-site APIs, gaps, ranks | Multi-site UI handler absent; ties ranked differently; blocked target silently replaced; misleading performance label |
| Content | Synthesized optimizer and brief APIs | Optimizer UI handler absent; arbitrary word targets; generic intent matching and English readability only |
| Technical monitor | Issue generator, link/asset HEAD sampling, duplicates, partial crawl | Issue generator never invoked; malformed internal HEAD URLs; timeouts treated as broken; no hreflang validation; incomplete robots/canonical validation |
| Reports/dashboard | Owned summary reports, stats, pagination and deletion | Cache hit does not save a new report; shared cached report IDs; only summaries persisted; unrestricted regex search |
| Projects | Owned CRUD routes | No UI; scan ignores projectId; some related-report queries omit userId |
| Site crawl | Mongo-backed jobs and bounded per-job workers, duplicates/thin/orphans | Missing links in payload stops discovery/orphan graph; accepts off-origin sitemap URLs; quota charged only after completion; no global bound |
| Commercial | Free/starter/pro/agency limit constants | Published pro dev key; quotas race/bypass on most endpoints; no subscription lifecycle or billing boundary |
| Deployment | Dockerfile, health-like status, graceful close | Lockfile prevents npm ci; root static exposes source; DB optional even in production; no CI or documented env contract |

## Prioritized findings (baseline line references)

| ID | Severity | Evidence and consequence | Repair priority |
|---|---|---|---|
| C1 | Critical | `package-lock.json:1` contains shell/transcript, not JSON; npm ci/Docker build cannot work | Build first |
| C2 | Critical | `server.js:567` serves repository root; source/config and future non-dot sensitive artifacts exposed | Remove root static |
| C3 | Critical | `server.js:956,1434–1891,1709,2524` only regex-checks initial host, trusts DNS/redirects/embedded URLs, disables TLS verification; browser subrequests unrestricted | Central outbound boundary; disable unsafe browser path until egress isolation |
| C4 | Critical | `server.js:52,630` published pro key; unknown/invalid bearer falls through to anon, prototype keys accepted | Remove baked-in keys; fail closed |
| H1 | High | `server.js:630–737,6371–6537,6942` read/modify/write quotas, several routes never charge, crawl charges at end | Atomic reservation before work |
| H2 | High | `server.js:5444,6670,6759` global history/trends/cache and report IDs cross users, cached scans not persisted per owner | Owned cache/history/trends |
| H3 | High | `server.js:2524,2724` browser fingerprint evasions and escalation on 401/403/429/CAPTCHA | Stop on protection; remove stealth |
| H4 | High | `server.js:2812,3169,5444` invented missing title/H1/description; nested text double counted; URL and schema missing in scorers | Evidence extraction and wiring |
| H5 | High | `server.js:4139,5588` searches plain text for li/tr; always zero | DOM counts |
| H6 | High | `server.js:940,6447` hashes create fake search volume/difficulty; UI calls them ranking data | Null unavailable metrics |
| H7 | High | `public/index.html:1224,1259,1263` toggleMoreCompetitors/compareMultiSite/runContentOptimizer undefined | Implement and test controls |
| H8 | High | Inline handlers interpolate escaped URLs (`public/index.html:2063,2196,4020`); HTML entity decoding permits JS-string injection | Data attributes and delegated listeners |
| H9 | High | No reset/revocation/deletion/admin/billing service, no commercial acceptance tests | Separate account lifecycle milestone |
| M1 | Medium | `server.js:1777` prepends origin to hostname/path keys, requests wrong internal URL; 403/timeout equated to dead links | Correct URL resolution; unknown state |
| M2 | Medium | `server.js:1478` declared sitemap treated as verified; robots groups merged; failures indistinguishable from missing | Availability metadata, validate XML, group-aware rules |
| M3 | Medium | `server.js:1953,2352` protocol limited by HTTP client; missing CWV creates false recommendation, partial metrics called full pass | Explicit unavailable/applicability |
| M4 | Medium | `server.js:5244` equal scores get unequal ranks; null first target gets replaced by competitor | Tie ranking; preserve target |
| M5 | Medium | `server.js:6115` expensive bcrypt registration unbounded; password whitespace trimmed and bcrypt 72-byte limit unchecked | Throttle and validate |
| M6 | Medium | `server.js:6586` user-supplied regex allows expensive DB matching; pagination accepts fractions | Escape literal search; bound integers |
| M7 | Medium | `server.js:3463` generator invents reviews/authors/phone/logo/date, recommends all schema types regardless of relevance | Evidence-only drafts |
| M8 | Medium | `server.js:5919` no full-site evidence for orphan claims; job progress saved only at completion; delete running jobs races worker | Label sampled scope; prevent active deletion |
| M9 | Medium | Docker/browser version drift; source copying without .dockerignore; no readiness distinction; import starts server | Pin browser; health/readiness; testable startup |
| L1 | Low | Legacy dead modules/duplicate models, very short README, inconsistent displayed versions; monolithic organization | Document, defer safe extraction |

## Dependency-ordered completion roadmap and complexity

Estimates are engineering effort ranges, not delivery commitments, and include review/testing.

1. Audit/build baseline and regression harness: medium, 1–2 days.
2. Authentication, quotas, tenant isolation, outbound networking, bounded scans: high, 3–6 days. Browser egress isolation requires deployment verification.
3. Evidence-correct extraction/scoring, missing data, heuristic labels: high, 3–5 days; contextual relevance of local/schema/EEAT metrics needs product review.
4. Competitor UI, gaps/ranks/CWV and content optimizer: medium, 2–4 days; reuse current engines.
5. Technical monitor, robots rules, canonical/hreflang, partial-crawl verification: high, 3–5 days.
6. Projects and account settings, secure account lifecycle: high, 3–5 days; reset delivery requires an approved email provider/configuration. No new production schema without migration review.
7. Billing disabled by default; admin permissions and subscription enforcement: high, 3–5 days; provider/plan decisions before live activation.
8. Low-budget single-instance deployment rehearsal and complete integration/browser QA: high, 3–5 days; isolated Atlas test DB and network/browser access required.

Approximate remaining baseline effort: 3–6 engineer-weeks, with overlap possible, subject to discovered runtime issues. Enterprise-grade availability, audit logs, backups and multi-instance queues require additional design. A beta must not be described as enterprise-ready merely from heuristic SEO scores.

## Initial verification

`node --check server.js` passed on local Node 24.22.1 (production target is Node 22). No automated tests existed. Dependency audit, installation, Docker build, browser navigation, Atlas operations and PSI requests had not yet been executed when this report was written. No claim of production readiness.
