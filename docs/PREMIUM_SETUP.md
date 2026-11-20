# Paid-plan and AI setup — 20 November 2026

## Delivered scope and prices

The owner selected Pakistan as the business country, USD prices, and a $10 total monthly AI budget, and delegated initial pricing. Introductory prices are Pro $9/month and Agency $19/month, before applicable taxes. Free retains 5 scan units per rolling 24 hours; Pro/Agency use the existing 100/500 daily plan limits and add at most 10/25 AI requests per UTC calendar month. Existing Google imports, reports and account export are not newly paywalled. AI access is additionally subject to a $1 per-user monthly reservation cap, $0.01 per-request cap and the shared $10 cap. Failed attempts keep their reservations and request counts.

**Live payments are not implemented or enabled in this release.** All Paddle calls target its sandbox, checkout says Test, and `BILLING_MODE=live` fails closed. No merchant application, identity verification, credits purchase, production database setup, or paid API request has been performed by this code delivery. Provider responses in acceptance tests are fixtures. Sandbox entitlements should be tested on an isolated staging database before public activation.

## 1. Create the owner accounts

Paddle lists unsupported supplier countries; Pakistan is not currently on that list, but merchant eligibility/verification, payout availability and website approval remain Paddle's decisions. Start with a separate sandbox account using the signup link in https://developer.paddle.com/sdks/sandbox/. Do not enter false business details or use a different country to bypass eligibility. Later create/apply for a real merchant account only when ready for live commerce.

Create an OpenRouter account at https://openrouter.ai/ and a dedicated key under https://openrouter.ai/settings/keys. Configure a provider-side $10 key spending limit and a monthly reset if supported; otherwise use a non-renewing $10 cap and review it before any manual renewal. Keep automatic top-ups off. The app's reservation accounting is not a substitute for the provider's own billing guardrail. Do not paste secrets in chat, screenshots or GitHub. Purchasing credits is an owner action; this delivery does not purchase them.

Official references: https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle, https://developer.paddle.com/webhooks/about/signature-verification/, https://developer.paddle.com/webhooks/about/how-webhooks-work/, https://developer.paddle.com/build/transactions/default-payment-link/, https://openrouter.ai/docs/guides/routing/provider-selection.

## 2. Prepare storage

An operator must review and run `node scripts/prepare-premium.mjs` with `PREMIUM_SETUP_MONGODB_URI` supplied through a secure environment and `PREMIUM_SETUP_CONFIRM=CREATE_PREMIUM_COLLECTIONS`. Use a separate staging database first. The script creates six collections and a `userId` index on each: premium checkouts, billing events, subscription and customer bindings, usage counters and AI jobs. Native `_id` indexes enforce request/event/subscription uniqueness. It does not drop collections, modify existing indexes, rewrite users or activate flags. Only set `PREMIUM_STORAGE_READY=true` after checking all collections/indexes and transaction support.

Optional user fields hold the latest bounded subscription state and pending checkout nonce; there is no backfill. Billing/AI event history is stored in separate documents rather than unbounded user arrays. Exact monthly counters and webhook updates use transactions. Each subscription and billing-customer ID is atomically bound to one account, so a customer portal cannot expose another account's billing history. Newer events win; stale events cannot revive canceled access. Active access also expires at `paidThrough` even if an expiration webhook is missed. Account deletion removes premium records but retains the anonymous application-wide monthly counter so deleting an account cannot restore spending capacity. Subscription cancellation must be confirmed before account deletion.

Existing report retention is unchanged. AI drafts and per-account premium records persist until account deletion; global monthly counters contain no user identifier. Do not automatically delete idempotency records without designing and documenting replay behavior. A pending/ambiguous checkout is reused or blocked instead of creating another potentially billable transaction. If a provider response fails after transaction creation, an operator must reconcile the pending checkout with Paddle; the app deliberately does not retry it automatically. Cancel/rejoin changes must be managed in the customer portal; a second subscription is refused.

## 3. Configure Paddle sandbox

Create monthly recurring prices with no trial: Pro USD 9.00 and Agency USD 19.00. The server checks price amount, currency, billing interval and status before making a checkout. Set the sandbox default payment link to:

`https://seo-ai-tool-production-ab4f.up.railway.app/checkout.html`

Create a notification destination at:

`https://seo-ai-tool-production-ab4f.up.railway.app/billing/webhook/paddle`

Subscribe to subscription.created, subscription.updated, subscription.canceled, subscription.paused, subscription.resumed and subscription.past_due. Use the secret belonging to that destination. Raw bytes and Paddle-Signature are verified, with a five-second timestamp tolerance and constant-time HMAC comparison. A browser success screen never grants a plan.

In the chosen staging service's secret settings:

```dotenv
BILLING_MODE=sandbox
PREMIUM_STORAGE_READY=true
PADDLE_SANDBOX_API_KEY=<sandbox API key>
PADDLE_SANDBOX_WEBHOOK_SECRET=<notification destination secret>
PADDLE_SANDBOX_CLIENT_TOKEN=<public sandbox token beginning test_>
PADDLE_PRO_PRICE_ID=<Pro pri_ identifier>
PADDLE_AGENCY_PRICE_ID=<Agency pri_ identifier>
```

Use the staging hostname instead of the public hostname above when testing in staging. Log in, visit `/premium.html`, perform a sandbox transaction with Paddle's documented test payment details, verify the webhook and plan allowance, use the portal, cancel and verify access revocation. Confirm duplicate/out-of-order events and an expired billing period cannot grant access. Paddle approval, live keys, live-event separation, real refund/cancellation/customer-support policy, live lifecycle acceptance and real payment authorization remain a separate release gate.

## 4. Configure optional AI drafts

Suggested starting model: `openai/gpt-4.1-mini`, provider `openai`. On 20 November the public OpenRouter catalog listed prompt/completion pricing of $0.40/$1.60 per million tokens and structured outputs. Availability/pricing/privacy routing can change; verify the current model and endpoint before enabling. The requested ZDR/no-collection routing may be unavailable; failure remains a failure, with no relaxed privacy or provider fallback.

```dotenv
AI_DRAFTS_ENABLED=true
OPENROUTER_API_KEY=<dedicated capped key>
AI_DRAFT_MODEL=openai/gpt-4.1-mini
AI_DRAFT_PROVIDER=openai
AI_MONTHLY_BUDGET_USD=10
AI_USER_MONTHLY_BUDGET_USD=1
AI_MAX_REQUEST_USD=0.01
AI_MAX_PROMPT_USD_PER_MILLION=0.5
AI_MAX_COMPLETION_USD_PER_MILLION=2
```

The last two values are explicit routing price ceilings, not claims of current model prices. Input byte length plus conservative overhead and a 1024-token output ceiling determine the reservation. The route fails if that maximum exceeds the configured per-request cap. Reservations for global and per-user budgets plus request counts are atomic; no refunds are made on failures, and the same request key cannot create another provider call. Configure the provider key limit too, since external metering/fees remain the provider's responsibility.

The user must select a complete owned report, choose explanation or rewrite and consent to sending its public-page evidence. Only bounded observed excerpts/topic labels are sent. Account fields, API keys, Google tokens and Search Console observations are excluded. Source text is untrusted data in a separate message. The response must be structured JSON, use real evidence IDs and fit bounds; all output is escaped as text in the browser. AI drafts are editorial, can still contain errors and never modify measured scores or claim real citations/rankings. No browsing, tools, retry chain or paid fallback is enabled.

## Remaining launch requirements

Do not accept real customer money until merchant approval, real-provider acceptance, cancellation/refund/support terms, SMTP recovery, production backups and operational monitoring are ready. Existing privacy/terms accurately state that billing remains test-only. This implementation is ready for sandbox setup, not a claim that a publicly paid commercial service is live.
