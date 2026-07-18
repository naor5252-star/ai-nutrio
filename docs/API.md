# API Documentation

Base path: `/api/v1`. JSON errors use:

```ts
type ApiError = {
  error: {
    code: string;
    messageHe: string;
    correlationId: string;
    fieldErrors?: Record<string, string[]>;
    retryable?: boolean;
  };
};
```

State-changing requests require the server session cookie and `x-csrf-token`. Clients should also send `x-correlation-id` and an idempotency/client-mutation ID where supported.

## Authentication

| Method | Path                       | Purpose                                    |
| ------ | -------------------------- | ------------------------------------------ |
| GET    | `/auth/session`            | Current user, CSRF token and feature flags |
| POST   | `/auth/magic-link/request` | Issue single-use 15-minute link            |
| GET    | `/auth/magic-link/consume` | Consume link and rotate session            |
| GET    | `/auth/google/start`       | Start OAuth + PKCE                         |
| GET    | `/auth/google/callback`    | Verify callback and establish session      |
| GET    | `/auth/apple/start`        | Feature-flagged activation boundary        |
| POST   | `/auth/logout`             | Revoke current session                     |

## Household/profile

- `POST /households/` create household.
- `POST /households/invitations` invite by email for 24 hours.
- `POST /households/invitations/accept` accept the one-time token.
- `GET|PUT /profile/` read/update profile and generate a target version.

## Meals and analysis

- `GET /meals/?date=YYYY-MM-DD`
- `GET /meals/:mealId`
- `POST /meals/` manual/confirmed meal with immutable nutrient snapshots.
- `POST /meals/:mealId/duplicate`
- `POST|DELETE /meals/:mealId/favorite`
- `DELETE /meals/:mealId`
- `POST /analysis/jobs`
- `PUT /analysis/jobs/:jobId/images/:index`
- `POST /analysis/jobs/:jobId/start`
- `GET /analysis/jobs/:jobId`
- `POST /analysis/jobs/:jobId/retry`
- `POST /analysis/jobs/:jobId/confirm`

Analysis states: `queued`, `uploading`, `processing`, `needs_user_input`, `completed`, `failed`, `cancelled`, `expired`.

## Products

- `GET /products/search?q=` ranks prior/household/local results.
- `GET /barcodes/:barcode`
- `POST /products/` creates a household product after explicit confirmation.
- `DELETE /products/:foodId` creator only.

Every nutrient stores normalized value/unit plus original display text and source (`label`, `database`, `manual`, `ai_estimate`).

## Coach, reports and measurements

- `GET /coach/next-action`
- `GET|POST /coach/conversations/:conversationId/messages`
- `DELETE /coach/memory`
- `GET /reports/daily?date=`
- `GET /reports/weekly?start=`
- `GET|POST /measurements/weight`
- `GET|POST /measurements/body-composition`

## Shared and platform features

- `GET|POST|PATCH|DELETE /shopping-list/...`
- `GET /garmin/status`, `POST /garmin/sync`
- `POST|DELETE /push/subscriptions`
- `GET /export/json|csv|pdf`
- `DELETE /account/` permanent immediate deletion.

## Pagination and versioning

List routes are designed for `limit` and cursor additions without breaking contracts. API version is carried by the URL; nutrition and AI analysis use separate formula/analysis versions in stored records.
