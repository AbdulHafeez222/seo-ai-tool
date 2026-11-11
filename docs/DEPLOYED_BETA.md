# Deployed beta acceptance — 2026-10-29

Live URL: https://seo-ai-tool-production-ab4f.up.railway.app/

Draft PR: https://github.com/AbdulHafeez222/seo-ai-tool/pull/5

## Scope and references

The existing Node/Express/Mongoose/vanilla application was preserved and hardened rather than rebuilt. Additions include AI crawler policies, multilingual evidence, completed controls and project editing. Source commit `f1fc22a1e321e8c5f4bf5e02cff19e00965d053e` is pinned on Railway. Deployment `0e28775c-2aac-4055-aa2e-12bad7fdbf51` is SUCCESS. Main is unchanged; no payments were enabled.

## Executed checks

- Node 22 regression suite: 21 passed, 0 failed. These cover deterministic engines, SSRF boundaries, mocked scan/database operations and DOM contracts.
- GitHub CI `40801619778`: clean npm install, syntax/handler checks, regression tests and production dependency audit succeeded.
- Published source tree `8c2aa544ba54816e1c9767ab188d05f230bb54e0` exactly matched the tested local tree. Documentation may advance without changing the pinned application.
- Atlas: existing FREE Cluster0 initially paused; owner resumed it. Read-only metadata later reported unpaused/IDLE; a managed connection succeeded. No customer rows were queried or modified.
- Runtime: homepage rendered in the cloud browser; readiness returned true; liveness reported running; login modal opened and comparison inputs expanded; Projects denied unauthenticated access.
- Existing user index names were present, but the index response omitted unique options. No index uniqueness guarantee or migration execution is claimed.
- Browser console observations contained browser-extension diagnostic errors; no application script error was observed in this limited smoke check.

## Limitations

No real authenticated end-to-end scan, database write/isolation/transaction acceptance, SMTP delivery, PSI field-data comparison, PDF layout, mobile viewport or server Playwright security acceptance was executed in production. No production test account, report, collection or index was created. Browser rendering requires verified egress isolation and remains disabled; recovery needs SMTP/migration review; billing stays disabled. History stores summary reports. These limits must be clear to beta users.

The first build failed readiness because the free database was paused. The subsequent redeploy was requested using the prior deployment build; Railway nevertheless displayed a Docker BUILDING phase before SUCCESS. No zero-cost or zero-rebuild promise is made. No further retry was triggered. The service stays commit-pinned to avoid automatic deployments from documentation pushes.
