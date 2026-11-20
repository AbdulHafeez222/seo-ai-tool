# Public beta deployment, 11 November 2026

Live site: https://seo-ai-tool-production-ab4f.up.railway.app/

Deployed application commit: `3d216ebe1b5f62c8899bbb3eba72ec24a6661295`.

Railway reached SUCCESS at 05:47 UTC. This release is available as a controlled public beta. Main was not merged. The service remains pinned to the application commit, so documentation pushes do not trigger application deployments.

## Build recovery

Earlier attempts failed before application compilation because Railway could not connect to its BuildKit daemon. The subsequent build reached the worker successfully, built the existing Dockerfile, pushed the image and passed database readiness. The observation establishes recovery; it does not establish the underlying provider fault's cause.

Direct service settings now explicitly name `Dockerfile`, run `node server.js`, and use `/health/ready` with a 120-second health-check window. Sleep mode remains enabled as required by the existing free plan. Railway's current API rejects the older config-file setting as deprecated, so those direct settings were used. No new project, paid plan, database migration or paid provider was activated.

## Live acceptance

Executed against the deployed application using two generated test accounts:

- Registration/login and Secure/HttpOnly session cookies passed.
- Project read/delete isolation passed. A foreign-project scan was rejected before consuming quota.
- Loopback, cloud metadata and file scan inputs were rejected without consuming quota.
- Exactly one scan of the application's default target, `https://hafeezdigitalstudio.com/`, returned a successful VALID_PAGE result and saved a complete report.
- The report reopened through the full-result endpoint with its analysis version and scores preserved, without another scan or quota charge. Foreign read/delete/reopening attempts were rejected.
- Real Chromium logged into the deployed app and reopened that saved report through the UI. English, Urdu, Pashto and Arabic were checked at 1440px and 390px. No horizontal overflow or application script errors were observed. Language switching issued no requests; reopening issued no scan.
- A live Urdu A4 PDF was generated successfully. The earlier four-language PDF and browser fixture checks also passed in CI.
- Logout invalidated the old token; a new login worked. Billing remained disabled.
- Both generated test accounts and their associated test records were removed through the account API. No existing customer account was modified.

The live API reports local-only AI with external model calls and paid fallbacks disabled. MongoDB readiness is true. Runtime logs showed a PageSpeed timeout; the scan completed with unavailable performance data rather than fabricating a measurement.

The deployed commit's GitHub CI passed, including regression, production dependency audit, isolated replica-set acceptance, and Chromium desktop/mobile/PDF acceptance. Local verification recorded 46 passing tests with real database acceptance enabled. No application code changed during deployment recovery.

## Remaining limits

This is a controlled beta, not certification of every production capability. Detailed legacy panels still contain English and native-language accuracy review is pending. Browser rendering remains disabled until network-level worker isolation is verified; some JavaScript-only pages cannot be analyzed. SMTP recovery and billing remain disabled. FREE hosting sleeps when idle and has resource/usage limits; unlimited uptime or capacity is not promised. A current production backup/restore rehearsal and longer-term report retention/monitoring remain outstanding. Deployment rollback restores application code, not database state.

Existing users should log in again because the release changes session validation. No historical reports were backfilled or deleted.
