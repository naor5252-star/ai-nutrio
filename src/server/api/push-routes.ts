import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { sendPayloadlessPushToUser } from "../services/web-push";
import { AppError } from "./errors";

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

const preferencesSchema = z.object({
  pushEnabled: z.boolean(),
  morningEnabled: z.boolean(),
  morningTime: timeSchema,
  afternoonEnabled: z.boolean(),
  afternoonTime: timeSchema,
  eveningEnabled: z.boolean(),
  eveningTime: timeSchema,
  aiPersonalized: z.boolean(),
  timezone: z.string().min(1).max(100).optional(),
});

type PreferenceRow = {
  push_enabled: number;
  morning_enabled: number;
  morning_time: string;
  afternoon_enabled: number;
  afternoon_time: string;
  evening_enabled: number;
  evening_time: string;
  ai_personalized: number;
};

export const pushRoutes = new Hono<AppEnv>();
pushRoutes.use("*", requireAuth);

pushRoutes.get("/config", (context) =>
  context.json({
    vapidPublicKey: context.env.VAPID_PUBLIC_KEY ?? null,
    configured: Boolean(context.env.VAPID_PUBLIC_KEY && context.env.VAPID_PRIVATE_KEY),
  }),
);

pushRoutes.get("/preferences", async (context) => {
  const userId = context.get("user").id;
  const [row, subscriptions] = await Promise.all([
    context.env.DB.prepare(
      `SELECT push_enabled, morning_enabled, morning_time,
              afternoon_enabled, afternoon_time,
              evening_enabled, evening_time, ai_personalized
       FROM notification_preferences
       WHERE user_id = ?`,
    )
      .bind(userId)
      .first<PreferenceRow>(),
    context.env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM push_subscriptions
       WHERE owner_user_id = ? AND invalidated_at IS NULL`,
    )
      .bind(userId)
      .first<{ count: number }>(),
  ]);

  return context.json({
    pushEnabled: row?.push_enabled === 1,
    morningEnabled: row?.morning_enabled !== 0,
    morningTime: row?.morning_time ?? "08:00",
    afternoonEnabled: row?.afternoon_enabled !== 0,
    afternoonTime: row?.afternoon_time ?? "15:00",
    eveningEnabled: row?.evening_enabled !== 0,
    eveningTime: row?.evening_time ?? "20:00",
    aiPersonalized: row?.ai_personalized !== 0,
    activeSubscriptions: subscriptions?.count ?? 0,
  });
});

pushRoutes.put("/preferences", requireCsrf, async (context) => {
  const input = preferencesSchema.parse(await context.req.json());
  const userId = context.get("user").id;
  const now = nowIso();

  await context.env.DB.prepare(
    `INSERT INTO notification_preferences (
       user_id, push_enabled, analysis_notifications,
       daily_summary_enabled, daily_summary_time,
       weekly_summary_enabled, weekly_summary_day, weekly_summary_time,
       updated_at,
       morning_enabled, morning_time,
       afternoon_enabled, afternoon_time,
       evening_enabled, evening_time,
       ai_personalized
     ) VALUES (?, ?, 1, 1, '20:00', 1, 0, '20:00', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       push_enabled = excluded.push_enabled,
       morning_enabled = excluded.morning_enabled,
       morning_time = excluded.morning_time,
       afternoon_enabled = excluded.afternoon_enabled,
       afternoon_time = excluded.afternoon_time,
       evening_enabled = excluded.evening_enabled,
       evening_time = excluded.evening_time,
       ai_personalized = excluded.ai_personalized,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      input.pushEnabled ? 1 : 0,
      now,
      input.morningEnabled ? 1 : 0,
      input.morningTime,
      input.afternoonEnabled ? 1 : 0,
      input.afternoonTime,
      input.eveningEnabled ? 1 : 0,
      input.eveningTime,
      input.aiPersonalized ? 1 : 0,
    )
    .run();

  if (input.timezone) {
    await context.env.DB.prepare("UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?")
      .bind(input.timezone, now, userId)
      .run();
  }

  return context.json({ ok: true });
});

pushRoutes.post("/subscriptions", requireCsrf, async (context) => {
  const input = z
    .object({
      endpoint: z.string().url().max(2_000),
      keys: z.object({
        p256dh: z.string().min(1).max(1_000),
        auth: z.string().min(1).max(1_000),
      }),
    })
    .parse(await context.req.json());

  const user = context.get("user");
  const now = nowIso();

  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO push_subscriptions
       (id, owner_user_id, endpoint, p256dh, auth_secret, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         p256dh = excluded.p256dh,
         auth_secret = excluded.auth_secret,
         user_agent = excluded.user_agent,
         invalidated_at = NULL`,
    ).bind(
      secureUuid(),
      user.id,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      context.req.header("user-agent") ?? null,
      now,
    ),
    context.env.DB.prepare(
      `INSERT INTO notification_preferences (
         user_id, push_enabled, analysis_notifications,
         daily_summary_enabled, daily_summary_time,
         weekly_summary_enabled, weekly_summary_day, weekly_summary_time,
         updated_at,
         morning_enabled, morning_time,
         afternoon_enabled, afternoon_time,
         evening_enabled, evening_time,
         ai_personalized
       ) VALUES (?, 1, 1, 1, '20:00', 1, 0, '20:00', ?, 1, '08:00', 1, '15:00', 1, '20:00', 1)
       ON CONFLICT(user_id) DO UPDATE SET
         push_enabled = 1,
         updated_at = excluded.updated_at`,
    ).bind(user.id, now),
  ]);

  return context.json({ ok: true }, 201);
});

pushRoutes.delete("/subscriptions", requireCsrf, async (context) => {
  const input = z.object({ endpoint: z.string().url().max(2_000) }).parse(await context.req.json());
  await context.env.DB.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND owner_user_id = ?",
  )
    .bind(input.endpoint, context.get("user").id)
    .run();
  return context.json({ ok: true });
});

pushRoutes.post("/test", requireCsrf, async (context) => {
  if (!context.env.VAPID_PUBLIC_KEY || !context.env.VAPID_PRIVATE_KEY) {
    throw new AppError({
      status: 503,
      code: "PUSH_NOT_CONFIGURED",
      messageHe: "התראות Push עדיין לא הוגדרו בשרת",
    });
  }

  const userId = context.get("user").id;
  const now = nowIso();

  await context.env.DB.prepare(
    `INSERT INTO push_notification_messages
     (id, owner_user_id, notification_type, title, body, target_url, created_at, expires_at)
     VALUES (?, ?, 'test', ?, ?, '/', ?, ?)`,
  )
    .bind(
      secureUuid(),
      userId,
      "רגע טוב · בדיקת התראות 🌱",
      "מעולה — ההתראות עובדות. מכאן רגע טוב יכול לשלוח לך עדכונים חכמים במהלך היום.",
      now,
      new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    )
    .run();

  const result = await sendPayloadlessPushToUser(context.env, userId);
  if (result.sent === 0) {
    const detail = result.failures[0] ?? "לא התקבלה סיבת שגיאה משירות ה-Push";
    throw new AppError({
      status: 409,
      code: "PUSH_DELIVERY_FAILED",
      messageHe: `שליחת ההתראה נכשלה: ${detail}`,
    });
  }

  return context.json({ ok: true, sent: result.sent });
});

pushRoutes.get("/pending", async (context) => {
  const notification = await context.env.DB.prepare(
    `SELECT id, title, body, target_url, created_at
     FROM push_notification_messages
     WHERE owner_user_id = ? AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(context.get("user").id, nowIso())
    .first<{
      id: string;
      title: string;
      body: string;
      target_url: string;
      created_at: string;
    }>();

  context.header("cache-control", "no-store");

  return context.json({
    notification: notification
      ? {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          url: notification.target_url,
          createdAt: notification.created_at,
        }
      : null,
  });
});
