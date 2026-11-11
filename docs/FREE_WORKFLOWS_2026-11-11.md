# Free workflow improvements

Live release: `10.3-beta-free-workflows`, application commit `ad284d8c5c92e5ea8fde3dae110640073daca788`. No paid API, subscription, billing activation, infrastructure upgrade, or additional scan charge is required by these workflows. Existing hosting/storage limits still apply; this is not a promise of unlimited free hosting.

Public URL: https://seo-ai-tool-production-ab4f.up.railway.app/

## Included

- Search Performance opens from the authenticated navigation. Each project can retain a baseline and current Search Console CSV export. Pages/Queries exports need English column headers, dates, and matching web/device/country filters. A standards-based MIT-licensed parser handles BOMs, quoted fields and Unicode content. Imports are limited to 512 KiB/2,000 rows, with a 384 KiB normalized storage cap per period; oversized input is rejected, not silently truncated.
- Imported totals cover exported rows only. Property ownership, file authenticity, hidden filters and omitted/anonymized rows cannot be verified from these files. They are never presented as a direct Google connection. Page URLs must match the project domains. Changing project domains preserves the data but withholds recommendations until imports match again.
- Opportunities cite actual uploaded rows. A CTR estimate requires five other rows in the same position band; it is a heuristic, not a traffic forecast. Near-page-one suggestions use average positions, not measured live rankings. Declines compare matching rows and clicks per day across ordered, nonoverlapping periods. Missing rows do not become invented lost rankings.
- Scan Changes compares two complete saved reports for the same page and project without re-crawling. Scores are compared only under the same analysis version. It shows factual changes and added/resolved content findings. Legacy summaries cannot support full comparisons. Cached evidence retains its original observation timestamp; explicit Re-scan fetches again, retains the saved report's project assignment, and consumes one ordinary scan unit.
- Data Export downloads owner-private projects or reports as paginated JSON batches of five. Project exports include imported search data; complete report exports include saved evidence. Credential fields are excluded by an explicit whitelist. Exports are not a consistent database backup and do not provide a restore operation.
- All new screens support English, Urdu, Pashto and Arabic, including RTL and mobile layouts. Language changes preserve form state and issue no network calls. Logout clears private workflow state; late responses from an earlier session are discarded.

## Storage and API

The existing project collection gains optional `performanceBaseline` and `performanceCurrent` JSON-string fields, excluded from ordinary queries. No collection, index, historical backfill, or bulk migration is needed. Removing this code leaves those optional fields untouched. Existing project/account deletion includes them automatically.

Authenticated routes, with owner checks and a separate process-local 30-request/minute account throttle:

```text
GET/POST/DELETE /projects/:id/search-performance
GET /reports/compare?before=<report-id>&after=<report-id>
GET /account/export?resource=projects|reports&cursor=<optional-id>
```

These routes do not call the scanner, reserve quota, or contact external APIs. `GET /scan?...&refresh=true` deliberately bypasses the owner-scoped cache, subject to the existing authentication, SSRF, capacity and scan-quota rules. Responses retain the application's private/no-store policy.

## Verification

Node 22: 59 tests passed, including real isolated MongoDB ownership, persistence, pagination, quota and deletion-rollback checks. Automated Chromium acceptance covers four report languages at desktop/mobile widths, four local PDF exports, two CSV imports, saved comparison, paginated downloads, and an explicit fresh re-scan. Crawling/PSI inputs in local browser acceptance are controlled fixtures, not live-provider evidence. CI repeats both database acceptance suites and the browser checks. Native-language editorial review remains separate.

GitHub CI passed for application commit `ad284d8` in [run 42974148311](https://github.com/AbdulHafeez222/seo-ai-tool/actions/runs/42974148311), including the project-preserving UI re-scan regression. Production dependency audit reported zero vulnerabilities.

Railway deployment `e48ce645-c9bf-4016-8545-9a2f234b99ee` reached terminal `SUCCESS` on 11 November 2026 at 06:43 UTC. The existing service remains pinned to the verified application commit, with one instance, sleeping enabled, the existing Docker configuration, and no plan upgrade. No bulk database migration or index creation was performed.

Live acceptance completed at approximately 06:45 UTC using two controlled accounts, both deleted afterward. It verified persisted synthetic CSV imports, observed-decline output, foreign-account rejection, private exports with credential fields excluded, two actual scans of the application's default target (`hafeezdigitalstudio.com`) with distinct observation times, and saved-report comparison. Only those two scans consumed quota; imports, comparisons, exports, and locale changes consumed none. Actual Chromium checked all four locales at 1440px and 390px, opened the live comparison, downloaded saved reports, and recorded zero application script errors. Synthetic search data does not establish a real Google property connection or traffic outcome.

## Remaining work and cost boundary

Follow-up: the direct Google connection and an isolated encrypted backup/restore rehearsal are now implemented in `GOOGLE_AND_BACKUPS_2026-11-11.md`. Google still requires owner OAuth configuration and live-provider acceptance; the fixture rehearsal is not a production backup. The paragraph below records the earlier release's remaining work.

Still possible without a paid API: native-speaker translation review, more usability/accessibility work, manual backup-and-restore rehearsal, and optional direct Google Search Console integration using the free API. Direct integration still needs implementation, owner-managed Google Cloud OAuth credentials/consent configuration, and any applicable verification. Credentials must be entered in hosting settings, never committed or pasted into chat. Recovery also remains disabled pending suitable SMTP configuration, index review and delivery tests; a paid provider is not inherently required.

Potential paid choices, not enabled here: additional hosting/storage beyond free limits, dedicated isolated crawling workers, commercial search datasets, paid AI citation collection/model calls, and production email capacity. Costs depend on actual usage and provider terms. They are optional future decisions, not prerequisites for these three workflows.
