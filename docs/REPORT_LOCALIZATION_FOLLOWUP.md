# Report localization follow-up — 30 October 2026

Scope: existing development branch and draft PR #5. Free-only, deterministic client-side changes; no new API, dependency, database mutation or Railway deployment.

## Findings and changes

- **Medium:** page evidence and technical report headings/summaries stayed in English after a language change. Added English, Urdu, Pashto and Arabic report labels and rerendering from the current in-memory payload. Original source excerpts and diagnostic prose are preserved; detailed server diagnostics, bot purpose descriptions and some older panels remain English and are explicitly disclosed.
- **Medium:** language switching could restore a previous report after reset/new scan. All four report caches now clear when report state resets. Empty results stay hidden across locale changes.
- **Low:** inherited object property names were accepted as stored/selected locales. Only own dictionary keys are accepted; invalid stored values fall back to English.
- Optimizer score labels and unavailable states now translate. Missing technical/readability data stays unavailable; a measured zero remains zero. Answer excerpts use automatic direction; the affected panels wrap long content to fit narrow containers.

## Files

`public/features.js`, `public/index.html`, `public/languages.js`, `test/content-intelligence.test.js`, `test/frontend.test.js`, this report.

## Executed validation

Node **22.23.4**: `node scripts/check.mjs && node --test`: **37 passed, 0 failed**. Checks parse all JavaScript/inline scripts, resolve static handlers and validate lockfile JSON. DOM regressions cover all four locales, no extra fetches on language switches or matching optimizer reuse, retained account input, escaped HTML in source excerpts, unavailable versus zero, invalid stored locales and no stale panels after reset. Existing auth/crawler/ownership regressions remain included; external database/provider I/O is mocked.

A first run exposed an older frontend fixture that omitted `languages.js`; it was corrected to load the production dictionary and assert its actual unavailable label, then the complete suite passed. Whitespace checks passed.

## Acceptance limits

An offline 390px fixture was generated outside the repository for visual review. The cloud browser rejected file:// previews by URL security policy. No alternate route around that restriction was attempted. Therefore **actual mobile visual and PDF export acceptance were not executed**, and the wrapping CSS is not claimed as visually verified. Native-speaker review is also outstanding. No production scan or quota was consumed for this follow-up.

The previous free-only milestone and commercial release blockers remain described in `FREE_ONLY_FOLLOWUP.md` and `API_AND_SAAS_REQUIREMENTS.md`. Full snapshot/version persistence, SMTP recovery acceptance, read-only Search Console OAuth, browser-worker egress isolation, live user-isolation/transaction acceptance and operational backups/monitoring remain separate release gates. Do not merge or deploy this follow-up without the agreed final review.
