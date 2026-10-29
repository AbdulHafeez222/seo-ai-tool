# Database and compatibility review plan — not executed

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
