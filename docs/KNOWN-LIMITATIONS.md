# Known Limitations

1. Cloudflare resource IDs, production domain and provider credentials are placeholders by design.
2. Apple and Garmin are safely disabled, not simulated as production integrations.
3. Label capture shares the image-analysis infrastructure, but a dedicated OCR/table reconciliation flow and database conflict UI remain to be completed.
4. Web Push subscriptions are stored and the service worker can receive notifications; the server VAPID delivery implementation is not complete.
5. Email requires a verified Cloudflare sender and production delivery testing.
6. PDF export is intentionally simple and uses ASCII-safe text because embedded Hebrew font licensing/assets are not committed.
7. External food datasets are not bundled; licenses and attribution must be selected before ingestion.
8. Background sync follows iOS limitations: synchronization happens on reconnect, reopen or explicit action, not continuous execution.
9. Real iPhone and independent usability acceptance criteria remain operational tasks; source code cannot truthfully certify them.
10. This repository is a strong production foundation and working vertical slice, not a truthful claim that every item in the master specification has already passed production acceptance.
