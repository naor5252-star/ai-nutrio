# Architecture Overview

## Style

A Cloudflare-first modular monolith keeps deployment and operations simple while preserving boundaries between HTTP transport, domain rules, repositories, AI providers, workflows and scheduled jobs. The browser never receives OAuth tokens or server session tokens.

## Component diagram

```mermaid
flowchart TB
  iPhone[iPhone installed PWA] -->|HTTPS /api/v1| Worker[Cloudflare Worker + Hono]
  iPhone -->|Static assets| Assets[Workers Static Assets]
  iPhone -->|offline entities/blobs| IDB[(IndexedDB)]
  Worker --> D1[(D1 relational data)]
  Worker --> R2[(Private R2 media)]
  Worker --> AI[Workers AI model router]
  Worker --> Email[Cloudflare Email Service]
  Worker --> Workflow[Cloudflare Workflow]
  Workflow --> R2
  Workflow --> AI
  Workflow --> D1
  Cron[Cron Triggers] --> Worker
  Google[Google OAuth] --> Worker
  Apple[Apple adapter / flag] -.disabled until configured.-> Worker
  Garmin[Garmin provider / flag] -.disabled until approved.-> Worker
```

## Meal analysis sequence

```mermaid
sequenceDiagram
  actor U as User
  participant P as iPhone PWA
  participant W as Worker API
  participant R as Private R2
  participant F as Workflow
  participant A as Workers AI
  participant D as D1

  U->>P: Photograph one or more angles
  P->>P: Compress and strip metadata
  P->>W: Create analysis job
  W->>D: queued job owned by user
  loop each image
    P->>W: Upload validated image
    W->>R: private/user/job object
    W->>D: image reference only
  end
  P->>W: Start job with idempotency key
  W->>F: create(jobId,userId)
  W-->>P: 202 pending diary state
  F->>D: validate owner/status
  F->>R: read image objects
  F->>A: fast structured vision request
  F->>F: Zod validate, confidence/complexity decision
  opt escalation required
    F->>A: stronger structured request
  end
  F->>D: save result, provenance and status
  P->>W: Poll with backoff / later Push
  W-->>P: validated draft
  U->>P: Confirm or correct
  P->>W: Save meal
  W->>D: immutable item nutrient snapshots + revision
```

## Authentication sequence

```mermaid
sequenceDiagram
  actor U as User
  participant B as Browser
  participant W as Worker
  participant D as D1
  participant E as Email/Google

  alt Magic link
    U->>B: Enter email
    B->>W: request + optional Turnstile
    W->>D: store hash(single-use, short expiry)
    W->>E: send link
    U->>W: consume raw token
    W->>D: compare hash, mark used atomically
  else Google OAuth
    B->>W: start
    W->>D: state hash + nonce + PKCE verifier
    W-->>B: Google authorization URL
    E-->>W: code + state
    W->>E: server-side token exchange
    W->>W: verify issuer/audience/signature/expiry/nonce
    W->>D: consume OAuth state
  end
  W->>D: rotate/create hashed session
  W-->>B: Secure HttpOnly SameSite cookie + CSRF token in session response
```

## Retention diagram

```mermaid
flowchart LR
  Image[Meal/product image] -->|7 days| DeleteImage[Logical block + R2 lifecycle/cron delete]
  Chat[Full AI message] -->|7 days| Summary[Delete text; retain approved summary/facts]
  Revision[Meal revision] -->|7 days| Current[Keep current meal state only]
  Invite[Invitation] -->|24 hours| Expired[Invalid and cleanup]
  Export[Temporary export] -->|up to 24 hours| DeleteExport[Delete object/reference]
  Account[Account deletion] --> Immediate[Sessions, private data, AI, Garmin, Push and R2 deleted immediately]
```

## ER diagram (core relationships)

```mermaid
erDiagram
  USERS ||--o{ AUTH_IDENTITIES : has
  USERS ||--o{ SESSIONS : owns
  HOUSEHOLDS ||--o{ HOUSEHOLD_MEMBERS : contains
  USERS ||--o| HOUSEHOLD_MEMBERS : joins
  USERS ||--o| USER_PROFILES : owns
  USERS ||--o{ NUTRITION_TARGET_VERSIONS : calculates
  USERS ||--o{ MEALS : owns
  MEALS ||--|{ MEAL_ITEMS : contains
  MEAL_ITEMS ||--o{ MEAL_ITEM_NUTRIENTS : snapshots
  USERS ||--o{ ANALYSIS_JOBS : owns
  ANALYSIS_JOBS ||--o{ ANALYSIS_JOB_IMAGES : references
  ANALYSIS_JOBS ||--o| ANALYSIS_RESULTS : produces
  USERS ||--o{ AI_CONVERSATIONS : owns
  AI_CONVERSATIONS ||--o{ AI_MESSAGES : contains
  USERS ||--o{ WEIGHT_MEASUREMENTS : records
  HOUSEHOLDS ||--|| SHOPPING_LISTS : has
  SHOPPING_LISTS ||--o{ SHOPPING_LIST_ITEMS : contains
  FOODS ||--o{ FOOD_NUTRIENTS : defines
  FOODS ||--o{ FOOD_BARCODES : identifies
```

## Authorization invariants

- Personal queries always include `owner_user_id = authenticated user`.
- Cross-user misses return 404 rather than revealing existence.
- Household membership is never substituted for personal ownership.
- Shared products preserve creator ownership; other members duplicate instead of editing canonical data.
- Shopping updates require matching household and LWW metadata.
