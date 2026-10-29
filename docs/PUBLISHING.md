# Publishing status and restoration

## Browser publishing in progress — 2026-10-29

The owner authorized browser fallback after connected GitHub writes returned 403. Browser sign-in and mobile device verification succeeded. The dedicated remote branch `codex/beta-hardening-2026-10-29` was created from baseline `eb2831c93c1bc5a3a25118e71f25fd249648db57`; main is unchanged. Tested server/configuration, security modules, frontend and release scripts have been published through GitHub UI. Regression tests and documentation are being completed before deployment. The final remote tree must match the tested local source before connecting this branch to Railway. No deployment success is claimed by this checkpoint.

Remote commit examples: root server/config `65b2348e8a9c68901792d61d3d169632d0945944`; robots parser `c631a64`; account/outbound/evidence modules `dd5dfa9`; frontend `6b1378f`; syntax checks `8da4c7e`; preflight `6fbda73`; evidence tests `cc57dee`.

## Earlier blockers and portable restoration


The local development branch is `codex/beta-hardening-2026-10-29`, based on main commit `eb2831c93c1bc5a3a25118e71f25fd249648db57`.

Publishing was attempted and blocked: shell Git had no write credentials; the connected GitHub integration returned 403, Resource not accessible by integration, for branch creation. No remote development branch, GitHub commit or PR was created. No main merge or production deployment occurred.

Reconnect/authorize the GitHub integration with repository Contents read/write and Pull Requests write access for AbdulHafeez222/seo-ai-tool. Do not share access tokens in chat. ChatGPT plugin approval settings cannot grant missing GitHub App installation permissions.

The delivery archive includes the current tracked source, reports, and an incremental Git bundle preserving all development commits. It contains no node_modules or .env file. The bundle requires the baseline repository history.

To restore on a machine where GitHub write access works, first clone the existing repository and then run these commands from that clone, substituting the actual bundle path:

```sh
git bundle verify /path/to/seo-ai-beta-changes.bundle
git fetch /path/to/seo-ai-beta-changes.bundle codex/beta-hardening-2026-10-29:codex/beta-hardening-2026-10-29
git switch codex/beta-hardening-2026-10-29
npm ci
npm run check
npm test
git push -u origin codex/beta-hardening-2026-10-29
```

Open a draft PR against main. Use a title such as "Beta hardening: scan isolation, evidence accuracy and regression coverage". Link docs/AUDIT.md, docs/RELEASE_READINESS.md and docs/MIGRATIONS.md in the description. Include the 20 passing Node 22 tests and 0-vulnerability dependency audit, plus the failed Chromium download and unexecuted live Atlas/SMTP/PSI/Docker acceptance checks. Do not mark it ready to launch or merge/deploy without owner approval.

## Latest deployment attempt — 2026-10-29

The owner authorized one deployment after final checks. Commit `f548ca5` preserves the existing application features, adds explicit Railway Docker/readiness configuration, disables production autoCreate, and provides `scripts/release-preflight.mjs` for secret-safe connectivity/catalog checks. All 21 Node 22 regression tests pass.

Hosting variables for JWT, MongoDB, HTTPS origin and production mode were present in the read-only preflight. Atlas was not verified: local DNS resolution fails even for a public control domain. Browser installation received an HTML unavailable response instead of a ZIP. Neither result proves those services fail on Railway. Browser egress isolation and live reset delivery remain unverified/disabled. No customer rows were read, collections created or indexes built.

PLAYWRIGHT_BROWSERS_PATH was aligned with the Docker image using skipDeploys, triggering no build. The later CLI upload stopped at a sign-in wall; a login-only device authorization was started. No new deployment is confirmed. After authentication, upload the exact local branch to the existing service, not main and not a new project. Do not redeploy the old main source to publish these local changes.

## Follow-up after owner sign-in confirmation

The owner confirmed the device sign-in. Resuming the local CLI session failed because this environment blocks network access to `https://backboard.railway.com:443`; this does not establish whether authentication completed. The connected Railway plugin can still inspect the existing service, whose latest deployment remains the old failed `b0b046f2-05ef-402e-a54d-93612c39f560`. No new deployment/build is confirmed.

The supported GitHub fallback was attempted once: creating the dedicated development branch returned 403 `Resource not accessible by integration`. No branch, commit or PR was published. Do not redeploy the unchanged main source. Browser-based repository publishing is a separate fallback requiring explicit owner approval under the browser tool instructions; it has not been initialized. All 21 executed local regression tests and release source remain preserved.
