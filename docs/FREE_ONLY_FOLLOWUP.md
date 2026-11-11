# Free-only follow-up audit — 30 October 2026

Owner selected a free-only budget. No paid model/API/fallback, purchase or deployment is authorized by this milestone.

Confirmed before edits:

- High: E-E-A-T/trust still search only English policy labels and call schema/HTTPS/social links independently verified authority. Authorship is penalized even on non-authored pages.
- High: Local SEO accepts any five-digit number as an address, evaluates every page as a local business and describes one-page name/address/phone presence as cross-source consistency.
- High: Disconnected legacy `aiService.js` still contains paid fallback models and fabricated fallback citation gains. An accidental use of the legacy entry point could incur cost or display invented results.
- Medium: Dynamic account dialogs overwrite localized controls with English when opened; settings/security labels are untranslated.

Plan: collect bounded, reusable schema/link/contact observations; gate page-specific metrics by declared purpose; distinguish declaration/presence from verification; make unknown local applicability unavailable; disable external AI in the legacy module without paid fallback; extend local translation dictionaries and test switching account modes. Preserve public response fields and existing controls. No database migration or customer data operation is necessary.

## Implemented and checked

- Bounded shared trust evidence observes multilingual policy/contact links, exact link hostnames and declared business objects. It makes no additional network requests. Query-string/hostname substrings cannot manufacture policy, social, map or external-reference evidence.
- Numeric strings/address keywords cannot establish local-business applicability. Unknown applicability returns a null score. A complete NAP tuple must be declared on one business object; real-world correctness and cross-source consistency remain unverified. Supported subtype recognition is conservative; unsupported local-business types may remain unknown.
- Authorship is evaluated when authored structured content is declared or an actual byline is present. Optional credential/tenure/policy signals are not universally failed. E-E-A-T status describes observations, not enterprise readiness or independently verified authority. Self-declared entity counts retain compatibility keys but explicitly disclose their basis; inferred brand fallbacks are removed.
- Available overall score components are normalized by assessed weight instead of silently scoring missing categories as zero. Method changes mean older trend scores require caution; no production storage migration was made.
- Legacy AI exports cannot make external model calls or select paid fallbacks, even if an API key is configured. They return an explicit unavailable notice, rather than invented citations/gains/dates. Schema exports remain incomplete editorial drafts based only on supplied title/type. The supported running server already uses deterministic evidence; no generative-model service is enabled.
- Account mode/profile/settings/security labels use the existing local English/Urdu/Pashto/Arabic dictionaries. Switching language preserves form inputs and retains explicit permanent-deletion confirmation. Local-business observations show an unverified notice in the chosen language. Detailed old panels, some validation/server messages and native-speaker review are still unfinished.
- Node 22.23.4: syntax/handler checks and **36 tests passed, 0 failed**, including cost-boundary, applicability, subject-scoped NAP, multilingual links, URL spoofing and auth-language switching tests. Network/DB operations in the broader regression suite remain mocked; no authenticated production scan, email, mobile viewport/PDF acceptance, customer write or deployment was performed.

Current budget boundary is local-only AI analysis, not a promise of unlimited free hosting/provider quotas. Search Console OAuth, SMTP delivery, durable full reports/usage storage, billing and browser egress isolation remain the separate reviewed SaaS milestones documented in `API_AND_SAAS_REQUIREMENTS.md`. No budget increase or paid API is requested for these code changes.
