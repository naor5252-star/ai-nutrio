# Setup Guide

## Cloudflare

1. Create a Worker-enabled Cloudflare account.
2. Run `npx wrangler login` on a trusted development machine or configure an API token in CI.
3. Create D1 and R2 resources.
4. Replace the placeholder D1 ID in `wrangler.jsonc`.
5. Set the production URL and verified email sender.
6. Run `npm run cf-types` after every binding change.
7. Apply migrations before deployment.

The project uses one Worker with Static Assets. `/api/*` and auth callbacks run Worker-first; client routes use SPA fallback.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply ai-nutrition-advisor-db --local
npm run dev
```

Set `ENABLE_DEMO_AUTH=true` and `ENVIRONMENT=development` only in `.dev.vars` for local onboarding. Never enable demo auth in production.

## Secrets

All runtime secrets use `wrangler secret put`; do not place them in `wrangler.jsonc`, `.dev.vars.example` or GitHub variables. Rotate secrets after any suspected exposure and revoke existing sessions when rotating the session secret.

## Google Sign-In

- Create a Web OAuth client.
- Register exactly the production callback `/api/v1/auth/google/callback`.
- Set client ID, client secret and redirect URI as Cloudflare secrets.
- The implementation validates state hash, PKCE, nonce, signature, issuer, audience and expiry.

## Apple Sign-In

Apple remains disabled until a Developer account, Primary App ID, Services ID, domain, return URL, private key, Team ID, Key ID and client identifier are available. Set the secrets, implement/verify the signed client-secret exchange, test Apple private-email relay, then set `APPLE_ENABLED=true`. The disabled route is intentional and must not be presented as working before this validation.

## Email

Configure Cloudflare Email Routing/Email Service and verify `EMAIL_FROM`. Bind `EMAIL` in Wrangler, then set `EMAIL_ENABLED=true`. Test delivery, SPF/DKIM alignment and bounce handling before production invitations.

## Web Push

Generate VAPID keys and store the private key as a secret. The client registers subscriptions only after a user gesture. Production delivery still requires completing the server-side VAPID sender and invalid-subscription cleanup noted in implementation status.

## Garmin

Do not enable production Garmin without Garmin approval, client credentials, callback and data-feed authorization. Keep `GARMIN_ENABLED=false` otherwise. The provider boundary and disabled UX preserve all core functionality.

## GitHub Actions

Repository secrets:

- `CLOUDFLARE_API_TOKEN` with least privilege for Worker deploy, D1 migration and R2/binding use.
- `CLOUDFLARE_ACCOUNT_ID`.

Repository variables:

- `CLOUDFLARE_D1_DATABASE_ID`
- `APP_BASE_URL`
- `EMAIL_FROM`

Protect `main`; require the CI workflow and forbid direct secret files.

## Install on iPhone

1. Open the HTTPS production URL in Safari.
2. Tap Share.
3. Tap **Add to Home Screen**.
4. Confirm the name “רגע טוב”.
5. Open from the new icon, not the original Safari tab.
6. Use the in-app notification action before Safari asks for Push permission.

Camera access is requested only when the user chooses to photograph a meal/product.
