# Local completion checkpoint — 2026-10-29

## Deployment hold and budget

Owner instruction: finish and test locally before deployment. No build, redeploy, service creation or plan purchase was initiated in this checkpoint.

Railway read-only GraphQL confirms workspace plan `FREE`, remaining usage credit `$1`, and `hasExhaustedFreePlan: false`. The usage endpoint reported current usage/bill `$0`. These values are point-in-time observations, not a promise of free continuous operation. Browser rendering and concurrent crawling still need memory/cost rehearsal before launch. No production database was accessed or migrated.

## Delivered

- `lib/evidence.js`: eight crawler/product-token policies, separating search discovery, training and user-triggered access. Training opt-outs are preferences and do not reduce SEO scores. Unknown robots responses stay unknown; declared access never claims verified bot access or citations. Registry reviewed against official OpenAI, Anthropic and Google documentation on this date.
- Existing pipeline in `server.js` returns `pageEvidence`: document language/direction, Arabic-script share without guessed language identity, local hreflang syntax/duplicates, invalid/multiple/cross-origin canonical observations, HTML indexing restrictions, and actual adjacent heading/answer excerpts. Uses the existing fetched HTML and robots file, with no new paid API or network calls.
- `lib/robots.js`: caller-selectable agent while preserving existing scanner default. Policy report reads the full already bounded robots response rather than the first 2000 characters.
- English Flesch heuristics are unavailable and excluded from score weights for declared unsupported languages, non-Latin text, and absent text. Latin text without a language declaration remains explicitly an English assumption. This is not a multilingual readability model.
- Keyword tokenization preserves Unicode letters/marks/numbers including Urdu/Pashto. Keywords remain frequency suggestions, not calibrated semantic entities or measured demand. Existing entity/intent engines still have English-oriented limitations.
- `public/index.html`, `public/features.js`: evidence panel with escaped, expandable findings and actual excerpts; project name/URL editing through the existing owner-scoped endpoint. Old responses without the new evidence field remain supported.
- `test/evidence.test.js`, `test/regression.test.js`, `test/frontend.test.js`: deterministic bot-policy separation, long robots files, multilingual fixtures, unknown-data handling, escaped frontend content, pipeline response contract, project edit action, and authenticated write isolation with mocked I/O.

## Product positioning hypothesis

Generic AI visibility/prompt monitoring already exists in products such as [Ahrefs Brand Radar](https://ahrefs.com/brand-radar), [Semrush Prompt Tracking](https://www.semrush.com/kb/1503-prompt-tracking) and [Profound Agent Analytics](https://www.tryprofound.com/features/agent-analytics/crawlability). Do not market the generic category as low competition.

A narrower hypothesis is an affordable, evidence-led multilingual audit workflow for WordPress/local-business agencies serving Urdu/Pashto/Arabic-script pages. This checkpoint supports that direction; WordPress writeback, automatic translation, live citation monitoring and a validated low-competition market are not implemented or claimed. Validate demand, willingness to pay and local alternatives with actual agency interviews before committing to that positioning.

Primary crawler references:

- https://developers.openai.com/api/docs/bots
- https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers

## Validation and review reference

Local implementation commit: `987775d` on `codex/beta-hardening-2026-10-29`. Node 22.23.4 ran `node --test`: **20 passed, 0 failed**. `node scripts/check.mjs` and whitespace checks passed. No dependency versions changed in this checkpoint; the previously executed production dependency audit reported zero vulnerabilities. GitHub branch/PR creation remains blocked (403); this reference is a local Git commit, not a published GitHub commit.

## Remaining work in dependency order

1. Isolated Atlas acceptance for ownership, quotas, transactional deletion and password recovery; no production schema changes before the migration plan is reviewed.
2. Finish applicability/evidence review of existing scoring engines, persisted full-report scope and remote canonical/hreflang/indexability verification. Current report history stores summaries only.
3. Real Chromium/mobile/accessibility/PDF QA and Docker/network-isolation rehearsal. Existing Chromium download failed; DOM tests are not browser acceptance.
4. Exercise PSI/CrUX and SMTP with controlled credentials and destinations. No actual citations, live billing or verified search volumes are promised.
5. Produce one reviewed release candidate and a constrained hosting rehearsal after the deployment hold is lifted. GitHub publishing is still blocked by integration write permissions; the local development branch and portable Git bundle preserve the changes.

See `RELEASE_READINESS.md` for the complete phase ledger and launch gates. The application is **not yet launch-ready**.
