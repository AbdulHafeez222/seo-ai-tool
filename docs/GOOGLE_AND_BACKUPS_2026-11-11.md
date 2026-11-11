# Google Search Console and backup rehearsal

Candidate `10.4-beta-google-ready` adds a free, read-only Google connection and an automated encrypted backup/restore rehearsal. No paid model/search provider, SMTP provider, billing activation or infrastructure upgrade is included. Existing hosting and API quotas still apply.

## Google workflow

Search Performance now has CSV and Google source modes. In Google mode an authenticated user can connect, load accessible properties, choose Pages or Queries, fetch a baseline/current period, and disconnect. Dates, device and country reuse the existing form. Four-language UI, mobile layouts, private exports and zero scan-quota charges remain supported.

The connection requests only `https://www.googleapis.com/auth/webmasters.readonly`, not Google email/profile or Search Console write access. Each user has independent encrypted credentials. Every fetch rechecks property access and constrains the page filter to the project's exact hosts; a larger domain grant cannot pull unrelated subdomain traffic. URL-prefix properties also retain Google's own prefix boundary. Every project URL must belong to the chosen property.

Requests use finalized web-search data, one dimension, Pacific dates, an end date at least three days old, and `all` or three-letter country codes. Up to 2,000 returned rows and 384 KiB normalized data are retained. A 2,001st row rejects the pull instead of silently truncating; narrow the period/filter. Empty valid responses remain zero observations, not fabricated metrics. API omissions/anonymized queries still prevent treating these totals as whole-property totals. Average position is not a live ranking.

Each saved period records CSV versus direct-API provenance. Google data is labeled as fetched with granted property access, not necessarily ownership. Comparisons are withheld across different sources, properties, page filters, dimensions, devices, countries or overlapping periods. Fetching does not create a scan report, reserve a scan unit, or contact an AI model. Fetching is user-triggered; scheduled automatic synchronization is not implemented.

## Owner configuration, no paid account required

1. In an owner-managed Google Cloud project, enable the **Google Search Console API**. Configure the OAuth consent screen, required product/privacy information and the read-only scope. Add controlled test users first; follow Google's verification/publishing requirements for a public external app. Google consent approval is separate from this code delivery. Testing-mode grants may expire after seven days.
2. Create a **Web application** OAuth client. Register exactly this authorized redirect URI for the current deployment:

   `https://seo-ai-tool-production-ab4f.up.railway.app/integrations/gsc/callback`

3. In Railway's service environment settings, enter `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET`. Generate a separate 32-byte key with `openssl rand -base64 32` and enter it as `GSC_TOKEN_ENCRYPTION_KEY`. Keep the key stable and back it up separately from the database. Do not reuse `JWT_SECRET`, paste secrets into chat, or commit them. The existing canonical HTTPS `APP_ORIGIN` must match the redirect origin exactly, without a trailing slash.
4. Set `GSC_ENABLED=true` only after all settings and consent/test-user configuration are ready. Before public enablement, use a controlled Google account to connect, load a known property, fetch an old settled period, compare it with the same filters in Search Console, and disconnect. Check that token values never appear in responses or logs. This live Google-provider verification has **not** been performed without owner credentials.
5. Leave `GSC_ENABLED=false` to disable connection/fetching. CSV imports continue working. A missing/invalid configuration fails closed; it never falls back to a paid service. Disconnect can still remove local credentials when configuration or a key is missing.

Official references: [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), and [usage limits](https://developers.google.com/webmaster-tools/limits).

## Security and storage

Optional `users.gscGrant` and `users.gscPending` strings are excluded from ordinary queries. They are AES-256-GCM envelopes authenticated to the account ID and purpose, with separate random nonces. The refresh/access tokens and PKCE verifier never reach the browser. No collection, index, bulk migration or historical rewrite is required.

OAuth state has 256 bits of randomness, a ten-minute expiry, a hashed stored value, a session credential stamp, PKCE-S256 and atomic one-use consumption. The cross-site callback returns to a fixed app URL; an authenticated same-origin POST performs the exchange. This preserves existing Strict session cookies rather than weakening them for Google. The browser immediately removes code/state fragments from history. Logout, password/key changes, a superseding connection, account deletion and disconnect cannot revive a late grant. Compare-and-set guards also prevent an in-flight refresh from reattaching disconnected credentials.

Disconnect removes local tokens before attempting remote revocation. If Google is unavailable or the key is lost, the UI reports that remote revocation is unconfirmed and directs the user to Google Account permissions. Saved search data remains until explicitly cleared/project-deleted/account-deleted. Account deletion removes local credentials with the user document; disconnect first to request remote revocation. Restoring an old database may restore obsolete credentials/sessions, so production recovery requires session invalidation and consent review, not blindly starting the restored application.

New routes share the existing authenticated free-workflow throttle. Provider URLs are fixed HTTPS endpoints, redirects are disabled, responses/timeouts are bounded, and upstream errors are normalized without exposing request bodies, tokens or client secrets. No credentials are included in account JSON exports.

## Real encrypted dump/restore rehearsal

`scripts/backup-rehearsal.mjs` uses official MongoDB Database Tools 100.20.1 against the isolated local replica set only. Its URI guard rejects production, alternate hosts, authentication parameters and other databases before any database or dump access. It creates unique source and restore namespaces, uses actual BSON archive dump/restore commands, compares every document and index, checks relationships, reopens a restored versioned report, verifies a restored password hash and unique index, and decrypts a restored synthetic Google grant. Both temporary databases and plaintext files are removed.

The on-disk archive is AES-256-GCM encrypted. The test reads it back, rejects a wrong key and tampered ciphertext, verifies decryption before invoking restore, and checks its digest. CI downloads the exact tool archive and verifies SHA-256 `8f25dcd1d769560fae1b5e724dc0c5eba54f2410dd293a9bab62be055507e521`. Only the fixture-only JSON verification manifest is uploaded as the backup CI artifact, not credentials or archives.

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27019/seo_beta_acceptance?replicaSet=beta-test' \
MONGODB_TOOLS_BIN=/path/to/mongodb-database-tools/bin \
node scripts/backup-rehearsal.mjs
```

The fixture output is `work/backup-rehearsal/results.json`; the optional `BACKUP_REHEARSAL_OUTPUT` changes its location. `BACKUP_ENCRYPTION_KEY` can supply a canonical base64 32-byte rehearsal key. Otherwise a one-run key is generated and not retained; the remaining synthetic encrypted archive is test evidence, not a recoverable production backup.

## Production backup boundary

No production database was copied, restored, migrated, dropped or bulk-edited by this rehearsal. It proves the toolchain and application data round trip on fixtures, not restoration of the live Atlas deployment under concurrent writes. No scheduled/off-site production backup, recovery-time commitment or production RPO is claimed.

For a real free-tier backup, the owner must approve a maintenance window and a secure encrypted destination, quiesce **all** writers (including workers and other database clients), and create an operator-controlled dump using current Atlas-supported tools/permissions. Free tiers may not support managed snapshots or oplog-based consistency; do not assume a plain dump of an actively written database is consistent. Keep encryption keys and application secrets in a separately protected recovery store. Rehearse decrypt/restore into a distinct nonproduction Atlas database, verify records/indexes/reports and account isolation, document retention and session invalidation, and obtain separate approval before any production restore/cutover. The guarded fixture rehearsal deliberately cannot be pointed at production as a shortcut.

## Verification boundary

Local real-MongoDB tests cover state replay/expiry, wrong accounts, session changes, superseding consent, token refresh, missing keys, project filters, provider failures, oversized results, and disconnect races. Chromium exercises a complete cross-site OAuth round trip, API fetch, provenance, disconnect, four locales at desktop/mobile widths and zero additional scan units. Google authorization/API responses in those tests are controlled fixtures, not a live Google grant. Native-language editorial review remains separate.
