import { createRemoteJWKSet, jwtVerify } from "jose";
import { Hono } from "hono";
import { z } from "zod";
import { emailSchema } from "../../shared/schemas/api";
import type { AppEnv } from "../context";
import { AppError } from "../api/errors";
import {
  createSession,
  optionalSession,
  requireAuth,
  requireCsrf,
  revokeCurrentSession,
} from "./session";
import { addHoursIso, nowIso } from "../repositories/db";
import { randomToken, secureUuid, sha256Base64Url, sha256Hex } from "../security/crypto";
import { verifyTurnstile } from "../security/turnstile";
import { sendApplicationEmail } from "../email/email-provider";

const magicLinkRequestSchema = z.object({
  email: emailSchema,
  turnstileToken: z.string().max(2_048).optional(),
});

const demoSchema = z.object({ email: emailSchema.default("demo@example.com") });

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/session", async (context) => {
  const session = await optionalSession(context);
  return context.json({
    authenticated: session !== null,
    user: session?.user ?? null,
    csrfToken: session?.csrfToken ?? null,
    features: {
      demoAuth: context.env.ENVIRONMENT !== "production" && context.env.ENABLE_DEMO_AUTH === "true",
      googleAuth: Boolean(context.env.GOOGLE_CLIENT_ID && context.env.GOOGLE_CLIENT_SECRET),
      appleAuth: context.env.APPLE_ENABLED === "true",
      garmin: context.env.GARMIN_ENABLED === "true",
      ai: context.env.AI_ENABLED === "true",
      email: context.env.EMAIL_ENABLED === "true",
    },
  });
});

authRoutes.post("/magic-link/request", async (context) => {
  const input = magicLinkRequestSchema.parse(await context.req.json());
  const correlationId = context.get("correlationId");
  await verifyTurnstile({
    secret: context.env.TURNSTILE_SECRET_KEY,
    token: input.turnstileToken,
    remoteIp: context.req.header("cf-connecting-ip"),
    idempotencyKey: correlationId,
  });

  const recent = await context.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM magic_link_tokens WHERE email = ? AND created_at > datetime('now', '-15 minutes')",
  )
    .bind(input.email)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 5) {
    throw new AppError({
      status: 429,
      code: "MAGIC_LINK_RATE_LIMIT",
      messageHe: "נשלחו כמה קישורים לאחרונה. נסה שוב בעוד כמה דקות.",
    });
  }

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = nowIso();
  await context.env.DB.prepare(
    "INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, requested_ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      secureUuid(),
      input.email,
      tokenHash,
      addHoursIso(0.25),
      await sha256Hex(context.req.header("cf-connecting-ip") ?? "unknown"),
      now,
    )
    .run();

  const url = `${context.env.APP_BASE_URL}/api/v1/auth/magic-link/consume?token=${encodeURIComponent(token)}`;
  const delivery = await sendApplicationEmail({
    env: context.env,
    correlationId,
    message: {
      to: input.email,
      subject: "קישור הכניסה שלך לרגע טוב",
      text: `הקישור תקף ל-15 דקות וניתן לשימוש פעם אחת: ${url}`,
      html: `<div dir="rtl"><h1>הכניסה שלך מוכנה</h1><p>הקישור תקף ל-15 דקות וניתן לשימוש פעם אחת.</p><p><a href="${url}">כניסה לרגע טוב</a></p></div>`,
    },
  });

  return context.json({
    ok: true,
    messageHe: "אם הכתובת תקינה, קישור כניסה נשלח אליה.",
    ...(context.env.ENVIRONMENT !== "production" && !delivery.sent
      ? { developmentMagicUrl: url }
      : {}),
  });
});

authRoutes.get("/magic-link/consume", async (context) => {
  const token = context.req.query("token");
  if (!token)
    throw new AppError({
      status: 400,
      code: "MAGIC_LINK_MISSING",
      messageHe: "קישור הכניסה אינו תקין",
    });
  const tokenHash = await sha256Hex(token);
  const row = await context.env.DB.prepare(
    "SELECT id, email FROM magic_link_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(tokenHash, nowIso())
    .first<{ id: string; email: string }>();
  if (!row)
    throw new AppError({
      status: 400,
      code: "MAGIC_LINK_EXPIRED",
      messageHe: "הקישור כבר נוצל או שפג תוקפו. אפשר לבקש קישור חדש.",
    });

  const now = nowIso();
  let user = await context.env.DB.prepare(
    "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL",
  )
    .bind(row.email)
    .first<{ id: string }>();
  if (!user) {
    user = { id: secureUuid() };
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(user.id, row.email, now, now),
      context.env.DB.prepare(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, created_at) VALUES (?, ?, 'magic_link', ?, ?, ?)",
      ).bind(secureUuid(), user.id, row.email, row.email, now),
    ]);
  }
  await context.env.DB.prepare(
    "UPDATE magic_link_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
  )
    .bind(now, row.id)
    .run();
  await createSession(context, user.id);
  return context.redirect("/");
});

authRoutes.post("/demo", async (context) => {
  if (context.env.ENVIRONMENT === "production" || context.env.ENABLE_DEMO_AUTH !== "true") {
    throw new AppError({
      status: 404,
      code: "FEATURE_DISABLED",
      messageHe: "מצב הפיתוח אינו פעיל",
    });
  }
  const input = demoSchema.parse(await context.req.json().catch(() => ({})));
  const now = nowIso();
  let user = await context.env.DB.prepare(
    "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL",
  )
    .bind(input.email)
    .first<{ id: string }>();
  if (!user) {
    user = { id: secureUuid() };
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, 'משתמש לדוגמה', ?, ?)",
      ).bind(user.id, input.email, now, now),
      context.env.DB.prepare(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, created_at) VALUES (?, ?, 'demo', ?, ?, ?)",
      ).bind(secureUuid(), user.id, input.email, input.email, now),
    ]);
  }
  const session = await createSession(context, user.id);
  return context.json({ ok: true, csrfToken: session.csrfToken });
});

authRoutes.get("/google/start", async (context) => {
  if (!context.env.GOOGLE_CLIENT_ID || !context.env.GOOGLE_REDIRECT_URI) {
    throw new AppError({
      status: 503,
      code: "GOOGLE_DISABLED",
      messageHe: "הכניסה עם Google עדיין לא הוגדרה",
    });
  }
  const state = randomToken(32);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  await context.env.DB.prepare(
    "INSERT INTO auth_oauth_states (id, provider, state_hash, nonce, pkce_verifier, expires_at, created_at) VALUES (?, 'google', ?, ?, ?, ?, ?)",
  )
    .bind(secureUuid(), await sha256Hex(state), nonce, verifier, addHoursIso(0.25), nowIso())
    .run();
  const params = new URLSearchParams({
    client_id: context.env.GOOGLE_CLIENT_ID,
    redirect_uri: context.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "select_account",
  });
  return context.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

authRoutes.get("/google/callback", async (context) => {
  if (
    !context.env.GOOGLE_CLIENT_ID ||
    !context.env.GOOGLE_CLIENT_SECRET ||
    !context.env.GOOGLE_REDIRECT_URI
  ) {
    throw new AppError({
      status: 503,
      code: "GOOGLE_DISABLED",
      messageHe: "הכניסה עם Google עדיין לא הוגדרה",
    });
  }
  const code = context.req.query("code");
  const state = context.req.query("state");
  if (!code || !state)
    throw new AppError({
      status: 400,
      code: "OAUTH_CALLBACK_INVALID",
      messageHe: "החזרה מ-Google אינה תקינה",
    });
  const stateHash = await sha256Hex(state);
  const oauthState = await context.env.DB.prepare(
    "SELECT id, nonce, pkce_verifier FROM auth_oauth_states WHERE provider = 'google' AND state_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(stateHash, nowIso())
    .first<{ id: string; nonce: string; pkce_verifier: string }>();
  if (!oauthState)
    throw new AppError({
      status: 400,
      code: "OAUTH_STATE_MISMATCH",
      messageHe: "פג תוקף הכניסה. נסה שוב.",
    });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: context.env.GOOGLE_CLIENT_ID,
      client_secret: context.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: context.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: oauthState.pkce_verifier,
    }),
  });
  const tokenJson: unknown = await tokenResponse.json();
  const idToken = readStringField(tokenJson, "id_token");
  if (!tokenResponse.ok || !idToken)
    throw new AppError({
      status: 400,
      code: "OAUTH_TOKEN_FAILED",
      messageHe: "לא הצלחנו לאמת את הכניסה עם Google",
    });

  const verification = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: context.env.GOOGLE_CLIENT_ID,
  });
  if (verification.payload.nonce !== oauthState.nonce) {
    throw new AppError({
      status: 400,
      code: "OAUTH_NONCE_MISMATCH",
      messageHe: "לא הצלחנו לאמת את הכניסה עם Google",
    });
  }
  const subject = verification.payload.sub;
  const email =
    typeof verification.payload.email === "string"
      ? verification.payload.email.toLowerCase()
      : null;
  if (!subject || !email)
    throw new AppError({
      status: 400,
      code: "OAUTH_PROFILE_INVALID",
      messageHe: "Google לא החזיר כתובת אימייל תקינה",
    });

  const now = nowIso();
  let identity = await context.env.DB.prepare(
    "SELECT user_id FROM auth_identities WHERE provider = 'google' AND provider_subject = ?",
  )
    .bind(subject)
    .first<{ user_id: string }>();
  let userId = identity?.user_id;
  if (!userId) {
    const existing = await context.env.DB.prepare(
      "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL",
    )
      .bind(email)
      .first<{ id: string }>();
    userId = existing?.id ?? secureUuid();
    const statements: D1PreparedStatement[] = [];
    if (!existing)
      statements.push(
        context.env.DB.prepare(
          "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).bind(userId, email, now, now),
      );
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, created_at) VALUES (?, ?, 'google', ?, ?, ?)",
      ).bind(secureUuid(), userId, subject, email, now),
    );
    await context.env.DB.batch(statements);
    identity = { user_id: userId };
  }
  await context.env.DB.prepare("UPDATE auth_oauth_states SET used_at = ? WHERE id = ?")
    .bind(now, oauthState.id)
    .run();
  await createSession(context, userId);
  return context.redirect("/");
});

authRoutes.get("/apple/start", (context) => {
  if (context.env.APPLE_ENABLED !== "true") {
    throw new AppError({
      status: 503,
      code: "APPLE_DISABLED",
      messageHe: "הכניסה עם Apple תופעל לאחר השלמת הגדרות Apple Developer",
    });
  }
  throw new AppError({
    status: 501,
    code: "APPLE_CONFIGURATION_REQUIRED",
    messageHe: "יש להשלים את פרטי Apple לפני הפעלה",
  });
});

authRoutes.post("/logout", requireAuth, requireCsrf, async (context) => {
  await revokeCurrentSession(context);
  return context.json({ ok: true });
});

function readStringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field: unknown = Reflect.get(value, key) as unknown;
  return typeof field === "string" ? field : null;
}
