# רגע טוב — AI Nutrition Advisor PWA

אפליקציית תזונה אישית, בעברית ובכיוון RTL, המיועדת קודם כול ל-iPhone ומותקנת כ-PWA. המאגר הוא modular monolith אחד ל-Cloudflare Workers: React/Vite בצד הלקוח, Hono בצד השרת, D1, R2, Workers AI, Workflows, Static Assets ו-Cron Triggers.

> **חשוב:** זהו כלי wellness ותמיכה תזונתית. הוא אינו מאבחן, מטפל או מחליף רופא/ה או דיאטנ/ית מוסמכ/ת.

## מה כבר עובד במאגר

- מעטפת PWA מלאה: manifest, service worker, offline shell, IndexedDB, queue לפעולות ולתמונות.
- ממשק Hebrew RTL ייחודי ומותאם למסך iPhone צר, עם ניווט תחתון ופעולת צילום מרכזית.
- Magic Link חד-פעמי ומוצפן, Google OAuth authorization-code + PKCE, sessions ב-HttpOnly cookie ו-CSRF.
- משק בית לשני משתמשים, הזמנה חד-פעמית והרשאות owner/household בצד השרת.
- פרופיל, יעדים ונוסחאות Mifflin–St Jeor עם versioning, manual override ואזהרות.
- יומן ארוחות, שכפול, מועדפים, snapshot תזונתי, ערכים חסרים כ-`null` ו-total חלקי.
- צילום עד ארבע תמונות, דחיסה מקומית, R2 פרטי, analysis job ו-Cloudflare Workflow.
- Workers AI model router עם fast/strong route, structured output ו-Zod validation.
- מוצר ידני, חיפוש, ברקוד, provenance, מדידות, רשימת קניות משותפת, דוחות וייצוא JSON/CSV/PDF.
- AI coach משולב עם safety checks דטרמיניסטיים ושמירת שיחות לשבעה ימים.
- ניקוי מתוזמן של תמונות, שיחות, revisions, invitations, sessions ו-idempotency records.
- Garmin ו-Apple מאחורי feature flags ובמצב מושבת ברור עד לקבלת אישורים וסודות.

סטטוס מפורט וכנה נמצא ב-[docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).

## התחלה מקומית

דרישות: Node.js 22+, npm, חשבון Cloudflare עבור Workers AI remote בעת בדיקת AI בפועל.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run cf-types
npm run validate:migrations
npx wrangler d1 migrations apply ai-nutrition-advisor-db --local
npm run dev
```

ללא ספק AI פעיל, שאר האפליקציה ממשיכה לפעול והניתוח חוזר כטיוטה בעלת ביטחון נמוך שדורשת אישור.

## בדיקות ואיכות

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run validate:migrations
npm run build
```

כל הפקודות יחד:

```bash
npm run ci
```

בדיקת WebKit:

```bash
npx playwright install webkit
npm run build
npm run test:e2e
```

## יצירת משאבי Cloudflare

```bash
npx wrangler d1 create ai-nutrition-advisor-db
npx wrangler r2 bucket create ai-nutrition-advisor-media
```

העתק את `database_id` שהתקבל אל `wrangler.jsonc`, ועדכן `APP_BASE_URL` ו-`EMAIL_FROM`. לאחר מכן:

```bash
npx wrangler d1 migrations apply ai-nutrition-advisor-db --remote
npm run deploy
```

## סודות נדרשים

```bash
npx wrangler secret put SESSION_SIGNING_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

Apple ו-Garmin אופציונליים ומפורטים ב-[docs/SETUP.md](docs/SETUP.md).

## GitHub Actions

ה-workflow ב-`.github/workflows/deploy.yml` מריץ formatting, lint, typecheck, tests, migration validation ו-build. רק לאחר הצלחה הוא מחיל migration ומפרסם ל-Cloudflare. יש להגדיר:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- Repository variables: `D1_DATABASE_ID`, `R2_BUCKET_NAME`, `APP_BASE_URL`, `EMAIL_FROM`

## מבנה

```text
src/client      React, RTL UI, PWA and offline sync
src/server      Hono API, auth, services, Workflow, scheduled jobs
src/shared      contracts, schemas, nutrition rules and units
migrations      numbered immutable D1 migrations
tests           unit, contract, integration and WebKit E2E
docs            SRS, architecture, API, design, setup and operations
```

## תיעוד

- [SRS summary](docs/SRS-SUMMARY.md)
- [Architecture and diagrams](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Design system and accessibility](docs/DESIGN-SYSTEM.md)
- [Cloudflare, OAuth, email, Push, Garmin and iPhone setup](docs/SETUP.md)
- [Security and data retention](docs/SECURITY-RETENTION.md)
- [Operational runbook and D1 recovery](docs/OPERATIONS.md)
- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Known limitations](docs/KNOWN-LIMITATIONS.md)
