# AI Visibility Intelligence Platform

Existing Express/Mongoose/vanilla-JavaScript application, hardened on a development branch for beta review. **Not cleared for production launch**: see [release readiness](docs/RELEASE_READINESS.md), [baseline audit](docs/AUDIT.md), and [migration plan](docs/MIGRATIONS.md).

## Local development

Use Node 22. Copy `.env.example` to `.env`, generate a random JWT secret of at least 32 bytes, and configure an isolated MongoDB test database. Do not paste secrets into GitHub or chat.

```sh
npm ci
npm run check
npm test
npm start
```

`server.js` is the supported entry point. Legacy `index.js`, `scan.js`, `report.js`, `Report.js`, `models/report.js`, `seoCalculator.js` and `aiService.js` remain for compatibility investigation; do not start or import them into the production pipeline.

## Beta operation

* Production requires `JWT_SECRET`, `MONGODB_URI`, and an HTTPS `APP_ORIGIN`. Set secrets in hosting settings. Atlas network access, unique indexes, backups and least-privilege credentials require owner review.
* Static files are served only from `public`. Browser sessions use HttpOnly/SameSite cookies; API clients may use Authorization Bearer JWT or their account API key on scan routes. Old unstamped JWTs require a new login. Password changes/key rotation revoke all old JWTs and keys.
* Free/Pro/Agency quotas are 5/100/500 units per rolling 24-hour period. Legacy starter accounts retain 25. Each attempted URL consumes one unit; comparisons consume up to five, site crawl reserves its whole page budget upfront. Failed scans and unused reservations are not refunded. Make this policy visible to beta customers.
* Anonymous scans are disabled by default. Opt-in demo quotas and request throttles are process-local: use one instance for beta. They are not distributed abuse protection.
* Target HTTP requests validate DNS and every redirect, pin socket addresses, verify TLS, block non-public networks and restrict ports to 80/443. Path/query case is preserved.
* Browser rendering is **disabled** unless `CRAWLER_EGRESS_ISOLATED=true`. It requires deployment-level egress isolation protecting private/metadata networks and DNS rebinding; Playwright route interception is defense in depth. CAPTCHA/security/login walls stop crawling. No stealth or proxy bypass.
* Scores and engine profiles are uncalibrated on-page readiness heuristics. No actual AI citations, search rankings, demand or keyword difficulty are measured. PageSpeed may be unavailable. Schema drafts are incomplete and need editorial validation; they are not rich-result guarantees.
* Reports store summary snapshots, not complete live reports. Cache hits create fresh owner-scoped summaries. History/trends require an account. Projects accept `/scan?url=...&projectId=...` only for their owner.
* Password recovery is disabled until SMTP settings, reset-collection review, and delivery testing are complete. TLS SMTP on port 465 is supported; no paid provider is activated. Billing checkout always returns disabled. Admin status is read-only and restricted to `ADMIN_EMAILS`.

## Hosting proposal (approval required before deployment)

Use Docker on one small container instance with Atlas, initially limiting beta accounts and crawl sizes. No hosting price or memory guarantee has been verified. HTTP-only crawling is the safe starting point on a low budget; Chromium may require more memory and a separately isolated worker. The old Railpack file is retained but unvalidated; prefer Docker.

```sh
docker build -t ai-visibility-beta .
docker run --env-file .env -p 10000:10000 ai-visibility-beta
```

Docker installs Chromium matching the exact Playwright lockfile version and runs as a non-root user. The image build and egress isolation need a hosting rehearsal. `/api/status` is liveness; `/health/ready` returns 503 until MongoDB connects. Keep `TRUST_PROXY_HOPS=0` except behind exactly one trusted proxy; protect direct origin access when enabling it.

## Validation boundaries

`npm run check` parses source/inline scripts and checks static UI handlers. `npm test` covers deterministic scoring and mocked orchestration/API/DOM behavior; mocked DB tests do not prove transaction or concurrency behavior. Live Atlas, SMTP, PSI, browser rendering, production proxy behavior and Docker build remain separate acceptance checks. No production database is used by tests.

## Latest local feature checkpoint

Scans now include `pageEvidence`: AI search/training policy separation, multilingual/RTL observations, local hreflang/canonical checks, and actual answer excerpts. This adds no outbound requests. Readability excludes unsupported languages and keyword extraction preserves Unicode. The existing Projects UI supports name/URL editing. See [local completion notes](docs/LOCAL_COMPLETION.md) for scope, limitations and the owner-requested deployment hold.
