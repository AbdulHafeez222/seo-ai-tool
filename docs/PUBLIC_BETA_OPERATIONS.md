# Public beta operations — 16 November 2026

## Status

Google sign-in and a Search Console import were confirmed working by the owner. Public OAuth publishing/verification has not been confirmed. Billing stays disabled. Browser rendering stays disabled until network isolation is verified.

The public uptime workflow lives on the default branch at `.github/workflows/public-beta-uptime.yml`. It checks `/api/status` and `/health/ready` at minutes 17 and 47, with retries for sleeping-instance cold starts. GitHub schedules are best effort and may be delayed or disabled for inactive repositories. Configure your GitHub Actions notification preferences to receive failures, and verify receipt. It is an availability probe, not scan, storage, email or Google-provider monitoring. It consumes GitHub Actions minutes and wakes the sleeping Railway app; review free-tier usage.

## Recovery activation

No SMTP variables were present at inspection. Existing code requires TLS SMTP on port 465. Put these values directly into Railway secrets:

```
SMTP_HOST=<your provider's TLS SMTP hostname>
SMTP_USER=<your SMTP username>
SMTP_PASSWORD=<your SMTP password or app password>
MAIL_FROM=<a sender your provider permits>
PASSWORD_RESET_ENABLED=false
```

Do not use your normal Google password. A Google SMTP setup, if chosen, requires the account's supported app-password/2-step-verification setup. Never commit credentials. Do not create a paid provider without the owner's choice.

Before enabling recovery, provision/review the `passwordresets` collection with a TTL index on `expiresAt` (`expireAfterSeconds: 0`) through an authorized database operator. Production automatic collection/index creation is disabled. Review existing indexes before adding; do not drop or rebuild unique indexes. Expiry is enforced in application queries even when TTL deletion is delayed. The new isolated acceptance test covers expiry, superseding requests, concurrent replay, enumeration-resistant responses, and password/key/JWT revocation. SMTP delivery in that test is intercepted; it is not real delivery evidence.

After SMTP and collection setup, set `PASSWORD_RESET_ENABLED=true` and deploy. Use a controlled inbox to request recovery; confirm receipt and sender, follow the link, change the password, reject reuse/expiry, reject the old password, log in with the new password, and delete the test account. Do not send reset messages to customers as a test.

## Production backups

Production backups are NOT configured. The existing `scripts/backup-rehearsal.mjs` operates only on synthetic loopback databases and must retain its production-URI guard.

Select a protected destination outside the app container and a separate stable backup encryption key. The GSC encryption key and JWT secret must also be recoverable from a separate secure store. A Railway container's filesystem is not durable backup storage; a database JSON export is not a complete database backup.

Prefer the database provider's managed backup facility when available on the existing plan. Check its consistency guarantees, retention and restore capabilities before relying on it. If unavailable, choose an operator-controlled encrypted dump process and a maintenance window. Stop all app and external writers before an offline dump, or use a provider-supported consistent snapshot/oplog procedure. Do not assume a dump during live writes is consistent. Do not pay for an upgrade without the owner's choice.

Concrete acceptance procedure:

1. Record the source database, approved maintenance window, all writers, destination, key custodian and retention policy.
2. Create a consistent BSON archive using a dedicated least-privilege backup credential and current MongoDB Database Tools. Keep secrets out of shell history, process arguments and logs. Encrypt before sending it to storage; use private temporary permissions if any plaintext is unavoidable and remove temporary files on all exit paths.
3. Record ciphertext checksum, completion time, archive size and backup result without customer records or credentials. Schedule the approved process daily and alert on failure or a missing backup older than 24 hours. Monitor destination capacity and retention cleanup. A schedule template is not an active backup.
4. Restore into a separate, empty NONPRODUCTION database with isolated credentials. Never point a rehearsal at the production URI and do not use `--drop` on a customer database.
5. Verify collection counts, indexes, account/project ownership, saved reports and Google token decryption without calling Google. Keep the restored app off the public network.
6. Before any actual production recovery, invalidate restored sessions/API keys and reset tokens and review Google grants so obsolete restored credentials cannot be revived. Document deletions that must be re-applied. Production restore/cutover is a separate operation.

The owner must choose the destination and retention before a truthful privacy retention statement can be published. A monthly restore rehearsal and a daily backup are the proposed beta operating policy, not an already active guarantee.

## Google public release

Confirm the public operator name, support email, homepage, privacy policy and terms. Publish complete pages without placeholders on the app's canonical domain and link them visibly from the homepage and sign-up flow. In the same Google Cloud project used by `GSC_CLIENT_ID`, enter those URLs under Google Auth Platform Branding. Configure authorized domains according to Google's domain-ownership requirements; a provider-owned Railway hostname may require an owned custom domain for verification. Do not claim ownership of railway.app.

Keep only `webmasters.readonly`, confirm the exact callback `/integrations/gsc/callback`, and request Production audience/publishing. Complete the verification steps shown by Google, which may include domain verification and a scope-use demonstration. Google controls approval; changing Railway variables does not publish an OAuth app. Test with an account outside the test-user list only after publishing allows it. Testing-mode grants may expire; reconnect when necessary.

## Beta cohort and exit criteria

Invite 5–10 named people only after sender/recipient details are supplied. Prepare the message and checklist first. Keep billing off. Track issues with reproduction steps, affected feature, device/browser, expected/actual behavior and a request ID if available; never collect passwords, reset links, API keys or Google tokens.

Every tester should try signup/login, a scan, opening a saved report, desktop/mobile layout, Google connect/import/disconnect, account export and deletion. Controlled users should test password recovery once delivery works. Test ownership with two separate accounts. The first cohort should report blockers before widening access. Full commercial readiness is not implied by beta deployment or a passing uptime check.
