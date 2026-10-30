# Content and multilingual audit — 30 October 2026

Baseline: remote PR #5 head `34775bbfb1ce08fce6cffe06f1599f9216c09fec`; local `c0040a1` has the identical source tree. Existing audit, account/network boundaries, all application routes, scoring/optimizer/comparison modules, frontend scripts, legacy entry points, configuration and tests were reviewed. This is a source audit, not authenticated production acceptance.

| Priority | Confirmed finding | Required change |
|---|---|---|
| High | Running server never imports `aiService.js`; an OpenRouter key alone does not enable AI-written analysis. Legacy module has invented citation uplift and dates. | Keep legacy module disconnected; explicitly expose provider status and document the optional evidence-constrained AI milestone. |
| High | Intent clusters search English substrings, so `what` can match inside another word and Urdu/Pashto content is scored as absent. | Unicode boundaries, localized dictionaries and unavailable states for unsupported languages. |
| High | AEO treats a question anywhere plus long text as a direct answer. It splits sentences only on English punctuation and rewards English sentence length for every language. | Inspect actual adjacent heading/answer blocks; localize lexical patterns; exclude English calibration for non-English text. |
| High | Optimizer prescribes FAQ schema as Critical on every page; fixed FAQ and entity-count messages dominate results. | Evidence-linked actions, exact headings/URLs/image sources, editorial drafts from observed copy; no generic mandatory FAQ. |
| High | Schema declarations are described as verified entities/knowledge graph evidence. | Explain that declarations are self-published and not independently verified. |
| Medium | Existing multilingual feature only observes lang/dir/hreflang; no report-language selector. | Add English/Urdu/Pashto/Arabic interface controls and localized evidence/action reports, RTL and persisted preference. Disclose untranslated legacy details. |
| Medium | Optimizer starts another quota-charging analysis even immediately after a successful scan. | Reuse the current matching result before requesting analysis. |
| High | Complete SaaS gates remain: summary-only persistence, SMTP recovery, subscription lifecycle, browser egress isolation and authenticated/mobile/PDF acceptance. | Separate reviewed milestones; do not call the product commercially complete based on this content update. |

No production deployment, database/schema change or paid provider activation is part of this audit. Existing features and response fields are retained. Evidence-based additions use the already-downloaded HTML; no extra third-party API is required for multilingual interface or structural analysis.
