# SRS Summary

## Purpose

“רגע טוב” is a private household nutrition-support PWA for two initial members. It records meals and packaged products, estimates nutrition from images, preserves exact/manual/database/AI provenance, tracks targets and measurements, and offers non-judgmental Hebrew coaching.

## Product boundaries

The product is for general wellness only. It does not diagnose, treat, cure, provide emergency care, or replace a physician or registered dietitian. Allergy management, water tracking, recipes, meal planning, Apple Health, native apps and public SaaS billing are outside MVP scope.

## Primary actors

- **Personal user:** owns profile, targets, diary, body data, reports, AI conversations and optional Garmin connection.
- **Household member:** may reuse shared products/meals and collaboratively edit the shopping list, but cannot access the other member’s private records.
- **Scheduled system:** expires short-lived data and evaluates local-time summary schedules.
- **External providers:** Google, Apple, email, Workers AI, food datasets, Push and Garmin through isolated adapters/flags.

## Critical functional requirements

1. Passwordless authentication and server-managed sessions.
2. Strict resource ownership for all personal data.
3. Versioned Mifflin–St Jeor targets and explicit manual overrides.
4. Meal and label capture with human confirmation for low confidence.
5. Unknown nutrient values remain unknown and make totals partial.
6. Private R2 media with seven-day logical and physical expiry.
7. Offline capture/mutation queues synchronized on reopen/reconnect/manual action.
8. Hebrew RTL, one-handed iPhone layout and progressive disclosure.
9. Deterministic AI safety before and after generation.
10. Immediate permanent account deletion.

## Key non-functional requirements

- Cloudflare-first modular monolith.
- Strict TypeScript, Zod at external boundaries, no request state in module globals.
- Accessible semantic HTML, practical WCAG 2.2 AA, reduced motion and text equivalents.
- Idempotent asynchronous analysis and structured observability.
- CI blocks deployment when quality gates fail.
- External integrations fail closed and do not block core diary functionality.

## Acceptance focus

The highest-priority vertical slice is: open app → photograph meal → see pending item → receive validated components → correct uncertain results → save immutable nutrition snapshots.
