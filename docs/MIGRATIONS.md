# Database and compatibility review plan — not executed

## 11 November additive repair

The Google follow-up adds optional hidden `users.gscGrant` and `users.gscPending` encrypted strings. There is no new collection, index or bulk migration. Keep `GSC_ENABLED=false` until the independent encryption key and Google OAuth configuration are ready. Back up that key separately; losing it requires reconnecting accounts. See `GOOGLE_AND_BACKUPS_2026-11-11.md` for the fixture-only backup rehearsal, production restore boundaries and session/consent invalidation requirements.

The free-workflow follow-up adds optional project fields `performanceBaseline` and `performanceCurrent`, hidden from ordinary queries and bounded to 384 KiB each. Only explicit owner CSV imports write them; clearing imports unsets them. No new collection/index, backfill or bulk migration is required. See `FREE_WORKFLOWS_2026-11-11.md` for input limits, export boundaries and verification. Full-report JSON exports are not a replacement for a consistent database backup or tested restore.

The candidate adds optional `reports.snapshotJSON` and `reports.snapshotStatus` fields in the existing collection. Only new scans write them; no historical backfill or index is required. Snapshot strings are capped at 2 MiB and excluded from ordinary queries. Existing summary documents remain supported. Back up and rehearse restore before production release; no production schema or data migration was run here.

An additive `users.sessionVersion` defaults to zero when read. A successful logout increments it for that account and invalidates all its JWTs without rotating the API key. The credential-stamp format changed, so existing sessions must log in again after release. Password changes and API-key rotation retain their existing revocation behavior. No bulk rewrite is required. Rollback to an older application can revive older token semantics until those tokens expire; include this in the release's session invalidation plan.

The older planning sections below describe the baseline. Full snapshots and logout revocation have since been implemented and tested on an isolated local replica set; production acceptance is still required. See `REPAIR_2026-11-11.md`.

No production database connection, migration, index build, or deletion was performed. Production `autoIndex` and `autoCreate` are disabled in the connection config. Existing User/Report/Project/SiteCrawlJob persisted field definitions are retained.

## Proposed additive password-reset collection

`lib/accounts.js` proposes `passwordresets` with `userId`, SHA-256 `tokenHash` (no plaintext token), and `expiresAt`. `autoIndex:false`; recovery stays disabled by default. No production index is created at startup.

Before enabling recovery:

1. Back up the database and rehearse against a separate Atlas test database.
2. Review permissions, retention, privacy deletion and delivery. Approve the new collection.
3. After approval only, provision a TTL index on `expiresAt` with `expireAfterSeconds:0`, a unique index on `tokenHash`, and a lookup index on `userId`. Rehearse expiry and concurrent single-use behavior. Consumption checks expiry explicitly, independent of TTL cleanup.
4. Test SMTP with a controlled test inbox; cover invalid/expired/reused links, throttling, credential revocation and provider failures. No real customer email in development.
5. Enable `PASSWORD_RESET_ENABLED` only after acceptance. Rollback: disable recovery, deploy the previous approved branch, and handle reset records under reviewed retention procedures.

## Existing data/index checks

Verify unique indexes for `users.email` and `users.apiKey` before concurrent registrations. Production autoIndex no longer repairs missing indexes implicitly: this requires a reviewed administrative operation. Check duplicates read-only first; never auto-delete them. Test account-deletion transactions and injected rollback on an isolated Atlas replica set.

## Session and quota compatibility

New JWTs carry an HMAC stamp tied to the existing password hash and API key. Existing unstamped tokens are rejected; users log in again. Browser localStorage tokens are removed. Password changes, resets and key rotation revoke old JWTs and API keys. Ordinary logout clears the cookie; a previously stolen bearer remains valid until its 8-hour expiry or credential rotation. A persistent per-session revocation store remains a release decision for stricter session management.

No usage-ledger collection was added. Atomic reservations update existing `scansToday`/`lastScanReset` fields. Previously overlapping scans and stale counters may affect the transition window. Rehearse reset/concurrent reservations against an isolated DB. Failed attempts and unused reserved pages are charged; historical usage is not rewritten.

Reports remain summaries. Full-report persistence, per-request usage history, subscriptions and billing state require separate reviewed additive migrations. No plan-upgrade endpoint or live payments are included. Existing starter users remain supported.
