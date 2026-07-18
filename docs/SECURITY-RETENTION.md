# Security Assumptions and Data Retention

## Baseline

- HTTPS at Cloudflare edge.
- Hashed, non-predictable session and magic-link tokens.
- Secure HttpOnly SameSite cookies and CSRF header validation.
- OAuth state, nonce and PKCE.
- Zod validation for external JSON and model output.
- Private R2 object keys under per-user prefixes.
- MIME, file-size and magic-signature validation before storage.
- Browser canvas recompression removes ordinary EXIF metadata.
- Structured logs redact tokens, images and full conversations.
- Secrets live in Cloudflare Secrets; deployment credentials live in encrypted GitHub secrets.

No HIPAA, medical-device, ISO, GDPR certification or clinical-validation claim is made.

## Ownership threat model

The principal risk is accidental household leakage. Every private route binds the authenticated user ID in the database query. A household ID only grants access to explicitly shared resources. Unauthorized lookups return a non-enumerating 404.

## Retention policy

| Data                      | Retention                                           |
| ------------------------- | --------------------------------------------------- |
| Meal/product images       | 7 days, logical access block plus cleanup/lifecycle |
| Full AI messages          | 7 days                                              |
| AI summary/approved facts | Until user deletes AI memory/account                |
| Meal revisions            | 7 days                                              |
| Household invitations     | 24 hours                                            |
| Magic links               | 15 minutes, single use                              |
| Temporary exports         | Maximum 24 hours when persisted                     |
| Current diary snapshots   | Until user/account deletion                         |
| Account deletion          | Immediate and permanent after one confirmation      |

Scheduled cleanup is defense in depth; logical expiry must be checked at read time so an overdue physical deletion never restores access.

## AI safety

Deterministic checks intercept extreme restriction, purging, deliberate dehydration, dangerous supplement use, diagnosis requests and emergency language. Safety responses override motivational persona and do not provide dangerous instructions. Production deployment should connect emergency copy to approved locale-specific guidance without storing sensitive prompts in logs.

## Residual risks

- Image recognition and portion estimates can be wrong; low confidence requires human review.
- Browser persistent storage is not guaranteed by iOS and may be evicted.
- External food datasets may be incomplete or licensed with attribution conditions.
- Cloudflare account controls, DNS, email reputation and GitHub branch protection are operational responsibilities outside source code.
