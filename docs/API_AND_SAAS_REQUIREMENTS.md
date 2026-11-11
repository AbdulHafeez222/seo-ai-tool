# API and commercial release requirements

## This implemented milestone

English/Urdu/Pashto/Arabic core controls and the new content-evidence report use local dictionaries. Unicode word segmentation, exact heading/answer evidence, observed copy drafts, on-page link candidates and language-aware lexical differences use the already-downloaded HTML. **No translation/LLM API, paid API or extra crawler request is needed.** Report language changes do not change the scanned page's language or consume quota. Older detailed audit panels/account dialogs remain English and say so in the new report.

`aiService.js` is a disconnected legacy module. Setting `OPENROUTER_API_KEY` does not activate it in `server.js`. It must not be blindly imported: its automatic model fallback can incur unapproved costs and its old text claims unsupported citation gains. No model call is enabled by this milestone.

## Decisions and credentials for subsequent milestones

| Need | Integration | Owner setup / decision | Boundary |
|---|---|---|---|
| Natural-language explanations, rewrites and richer multilingual semantics | One approved model provider, e.g. existing OpenRouter account | Select a currently supported model and maximum per-user/monthly spend; configure key in hosting secrets only | Opt-in request, strict validated structured output with source IDs, untrusted page text separated from instructions, time/token/body bounds, atomic persistent per-user/provider usage ledger, no automatic paid fallback. Model drafts must never alter measured scores or invent citations/demand. Requires implementation and reviewed persistence plan. |
| Actual customer queries/clicks/impressions/average positions | Google Search Console OAuth | Google Cloud OAuth client ID/secret and redirect URL; each customer authorizes their own eligible property | Read-only scope, per-account encrypted refresh tokens, state/PKCE and ownership validation. It does not reveal competitor private Search Console data; sampled/top-row limits remain explicit. |
| Performance measurements | Existing PageSpeed Insights integration | Confirm API is enabled/key and quotas in provider settings | PSI timeouts remain unavailable results; lab data is not CrUX field data. No synthetic INP or mixed URL/origin results. |
| Password recovery and email verification | TLS SMTP sender | SMTP host/user/password and approved sender; controlled inbox test | Existing reset service is gated. Review collection/index plan first; no production migration or email send was performed here. |
| Subscriptions and paid entitlements | A merchant/payment provider available to the business | Provider eligibility, account/currency, Free/Pro/Agency pricing and test-mode credentials | Test mode, signed idempotent webhooks and atomic entitlements; reviewed subscription/usage schema. No live payments until explicitly approved. |
| Search volume, market keywords or independent live citation monitoring | Optional licensed external data provider or defined observation workflow | Decide if commercially necessary and approve source/budget | Not needed for the implemented evidence checks. A normal LLM completion is not proof of citations in public assistant products. No invented volume/ranks/citations. |

Never paste keys or customer credentials in chat, GitHub, screenshots or reports. Existing configured secret values were not read or emitted for this milestone.

## Still required before calling this a complete commercial SaaS

- Full report snapshots and methodology/version retention: current persistence is summary-only; new evidence is in the response/cache. Review migration/backfill/retention before changing production storage. Scores changed applicability; historical scores from older methods are not directly comparable.
- Complete translation of legacy detailed reports/account flows and native-speaker review. Script is not a language identifier. Supported small dictionaries are phrase heuristics, not full multilingual NLP. Unknown languages remain unavailable for dictionary/English-only checks.
- Contextual applicability review for remaining English-biased E-E-A-T/local/entity heuristics, and empirical validation of aggregate scores. A schema declaration is not independent identity verification.
- Authenticated real scan/report/project/isolation/transaction acceptance, the original mobile response failure, real mobile/PDF/a11y acceptance and provider outage cases.
- Verified network egress isolation before enabling Playwright rendering; password recovery delivery and billing remain gated.
- Production backup/restore, monitoring, durable queue/usage controls, abuse limits and a measured hosting budget.

## Primary API references checked 30 October 2026

- OpenRouter structured outputs: https://github.com/OpenRouterTeam/docs/blob/main/guides/features/structured-outputs.mdx — support varies per endpoint; validate responses in application code even when strict output is requested.
- Search Console OAuth: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
- Search Analytics query, scopes and limits: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
- PageSpeed API: https://developers.google.com/speed/docs/insights/rest
- Structured data relevance and no rich-result guarantee: https://developers.google.com/search/docs/appearance/structured-data/sd-policies
