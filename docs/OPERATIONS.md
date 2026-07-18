# Operational Runbook

## Pre-deploy

1. `npm ci`
2. `npm run ci`
3. Confirm generated binding types match `wrangler.jsonc`.
4. Review migration for backward compatibility and no destructive edits.
5. Confirm D1/R2/AI/Workflow/Email bindings exist.
6. Confirm required secrets and feature flags.

## Deploy

```bash
npx wrangler d1 migrations apply ai-nutrition-advisor-db --remote
npx wrangler deploy
```

Never deploy if migration validation, tests or build fail. The GitHub workflow performs these gates in order.

## Health checks

- Open `/api/v1/auth/session` and verify a structured response/correlation ID.
- Verify static assets and client route SPA fallback.
- Create a local/manual diary entry.
- Submit an analysis job and inspect structured Workflow logs.
- Confirm expired R2 objects are blocked even before deletion.
- Review email/Push delivery records without logging message bodies.

## Structured log fields

`timestamp`, `severity`, `event`, `correlationId`, internal `userId` when necessary, `jobId`, duration, outcome and retryable state. Never log raw tokens, private keys, images, Garmin tokens or full conversations.

## Incident handling

- **Auth anomaly:** revoke sessions, rotate the relevant secret, inspect `account_security_events` and audit logs.
- **Cross-user risk:** disable affected route/feature, preserve logs, test ownership predicates, deploy fix before re-enabling.
- **AI malformed output:** model router falls back/marks low confidence; update schema/prompt without bypassing validation.
- **Workflow retry storm:** inspect job idempotency/status, stop manual retries and correct the failing step.
- **R2 retention miss:** block access logically, run cleanup, verify lifecycle policy and audit affected keys.

## D1 recovery

Use Cloudflare’s current D1 recovery/time-travel capabilities available to the account. Before restoration:

1. Record current database ID, schema version and target timestamp/bookmark.
2. Stop writes or put the app in maintenance mode.
3. Inspect the proposed restore point on a copy where available.
4. Restore and validate ownership counts, recent meals, sessions and migration metadata.
5. Re-enable writes and monitor errors.

For reversal, retain the pre-restore bookmark/point and repeat validation. R2 temporary images are not reconstructed by D1 recovery; diary snapshots remain usable without them.

## Troubleshooting

- **Wrangler asks for remote credentials during unit tests:** ensure `vitest.config.ts` is used; unit tests must not load the Cloudflare Vite plugin.
- **Blank client route:** verify `assets.not_found_handling` is SPA and Static Assets are included in the build.
- **Magic link not delivered:** check `EMAIL_ENABLED`, verified sender and Email binding; response intentionally avoids account enumeration.
- **Analysis remains queued:** inspect Workflow binding/class name, R2 image references and `analysis_jobs.updated_at`.
- **Offline capture missing:** verify IndexedDB quota/persistence and reopen the installed PWA while online.
- **Migration fails:** do not edit an applied migration; add the next numbered expand-and-contract migration.
