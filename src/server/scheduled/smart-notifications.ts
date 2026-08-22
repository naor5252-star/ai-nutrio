import type { RuntimeEnv } from "../context";
import { nowIso } from "../repositories/db";
import { logEvent } from "../services/logger";
import { sendPayloadlessPushToUser } from "../services/web-push";

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type NotificationUser = {
  id: string;
  timezone: string;
  morning_enabled: number;
  morning_time: string;
  afternoon_enabled: number;
  afternoon_time: string;
  evening_enabled: number;
  evening_time: string;
  ai_personalized: number;
};

type Slot = {
  type: "smart_morning" | "smart_afternoon" | "smart_evening";
  label: "morning" | "afternoon" | "evening";
  title: string;
  localDate: string;
};

type TargetRow = {
  effective_calories: number | null;
  effective_protein_grams: number | null;
};

type MealRow = {
  calories: number | null;
  protein: number | null;
  meal_count: number;
};

type HealthRow = {
  active_energy_kcal: number | null;
  resting_energy_kcal: number | null;
  steps: number | null;
};

export async function runSmartPushNotifications(
  env: RuntimeEnv,
  correlationId: string,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  const users = await env.DB.prepare(
    `SELECT
       u.id, u.timezone,
       np.morning_enabled, np.morning_time,
       np.afternoon_enabled, np.afternoon_time,
       np.evening_enabled, np.evening_time,
       np.ai_personalized
     FROM users u
     JOIN notification_preferences np ON np.user_id = u.id
     WHERE u.deleted_at IS NULL
       AND np.push_enabled = 1
       AND EXISTS (
         SELECT 1
           FROM push_subscriptions ps
          WHERE ps.owner_user_id = u.id
            AND ps.invalidated_at IS NULL
       )`,
  ).all<NotificationUser>();

  let sentUsers = 0;

  for (const user of users.results) {
    const clock = localClock(new Date(), user.timezone);
    const slot = dueSlot(user, clock.localDate, clock.minutes);
    if (!slot) continue;

    const existing = await env.DB.prepare(
      `SELECT id FROM notification_deliveries
        WHERE owner_user_id = ?
          AND notification_type = ?
          AND related_entity_id = ?
          AND status IN ('queued', 'sent', 'delivered')
        LIMIT 1`,
    )
      .bind(user.id, slot.type, slot.localDate)
      .first<{ id: string }>();
    if (existing) continue;

    const body = await buildMessage(env, user, slot);
    const messageId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO push_notification_messages
         (id, owner_user_id, notification_type, title, body, target_url, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, '/', ?, ?)`,
      ).bind(messageId, user.id, slot.type, slot.title, body, createdAt, expiresAt),
      env.DB.prepare(
        `INSERT INTO notification_deliveries
         (id, owner_user_id, notification_type, channel, status, related_entity_id, error_code, created_at, delivered_at)
         VALUES (?, ?, ?, 'push', 'queued', ?, NULL, ?, NULL)`,
      ).bind(deliveryId, user.id, slot.type, slot.localDate, createdAt),
    ]);

    const result = await sendPayloadlessPushToUser(env, user.id);
    await env.DB.prepare(
      "UPDATE notification_deliveries SET status = ?, error_code = ? WHERE id = ?",
    )
      .bind(
        result.sent > 0 ? "sent" : "failed",
        result.sent > 0 ? null : "PUSH_NOT_SENT",
        deliveryId,
      )
      .run();

    if (result.sent > 0) sentUsers += 1;
  }

  logEvent({
    severity: "info",
    event: "smart_push_schedule_checked",
    correlationId,
    outcome: "success",
    details: { candidates: users.results.length, sentUsers },
  });
}

async function buildMessage(env: RuntimeEnv, user: NotificationUser, slot: Slot): Promise<string> {
  const [target, meals, health] = await Promise.all([
    env.DB.prepare(
      `SELECT effective_calories, effective_protein_grams
       FROM nutrition_target_versions
       WHERE user_id = ?
       ORDER BY effective_from DESC
       LIMIT 1`,
    )
      .bind(user.id)
      .first<TargetRow>(),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(total_calories), 0) AS calories,
         COALESCE(SUM(total_protein_grams), 0) AS protein,
         COUNT(*) AS meal_count
       FROM meals
       WHERE owner_user_id = ? AND local_date = ?`,
    )
      .bind(user.id, slot.localDate)
      .first<MealRow>(),
    env.DB.prepare(
      `SELECT active_energy_kcal, resting_energy_kcal, steps
       FROM health_daily_summaries
       WHERE owner_user_id = ?
         AND source = 'apple_health_shortcut'
         AND local_date = ?
       LIMIT 1`,
    )
      .bind(user.id, slot.localDate)
      .first<HealthRow>(),
  ]);

  const intake = meals?.calories ?? 0;
  const protein = meals?.protein ?? 0;
  const targetCalories = target?.effective_calories ?? null;
  const targetProtein = target?.effective_protein_grams ?? null;
  const remainingCalories = targetCalories === null ? null : Math.max(0, targetCalories - intake);
  const remainingProtein = targetProtein === null ? null : Math.max(0, targetProtein - protein);
  const burned =
    health && (health.active_energy_kcal !== null || health.resting_energy_kcal !== null)
      ? (health.active_energy_kcal ?? 0) + (health.resting_energy_kcal ?? 0)
      : null;
  const balance = burned === null ? null : burned - intake;

  const fallback = fallbackMessage({
    slot: slot.label,
    intake,
    protein,
    targetCalories,
    targetProtein,
    remainingCalories,
    remainingProtein,
    burned,
    balance,
  });

  if (user.ai_personalized !== 1 || env.AI_ENABLED !== "true" || !isAiBinding(env.AI)) {
    return fallback;
  }

  try {
    const raw = await env.AI.run(env.AI_FAST_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "אתה המאמן האישי של אפליקציית 'רגע טוב'. נסח הודעת Push אחת בעברית טבעית, חמה וקצרה, עד 190 תווים. המטרה היא לכוון לפעולה אחת קטנה ורלוונטית עכשיו — לא להקריא דוח מספרי. השתמש בנתונים רק כדי להבין את המצב. אל תכתוב כמה נצרך וכמה נשאר אלא אם מספר אחד באמת מוסיף ערך. העדף ניסוחים כמו 'בארוחה הבאה כדאי לתת מקום לחלבון', 'נראה שהיום מתקדם מאוזן', 'אם אתה רעב בערב, בחר משהו קל ומשביע'. אל תהיה שיפוטי, אל תייצר לחץ, אל תמציא נתונים ואל תיתן ייעוץ רפואי.",
        },
        {
          role: "user",
          content: JSON.stringify({
            timeOfDay: slot.label,
            date: slot.localDate,
            intakeCalories: round(intake),
            proteinGrams: round(protein),
            targetCalories: round(targetCalories),
            targetProteinGrams: round(targetProtein),
            remainingCalories: round(remainingCalories),
            remainingProteinGrams: round(remainingProtein),
            burnedCalories: round(burned),
            calorieBalance: round(balance),
            steps: round(health?.steps ?? null),
            mealCount: meals?.meal_count ?? 0,
            fallback,
          }),
        },
      ],
      max_tokens: 120,
      temperature: 0.35,
    });

    return cleanText(readText(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

function fallbackMessage(input: {
  slot: "morning" | "afternoon" | "evening";
  intake: number;
  protein: number;
  targetCalories: number | null;
  targetProtein: number | null;
  remainingCalories: number | null;
  remainingProtein: number | null;
  burned: number | null;
  balance: number | null;
}): string {
  const proteinPace =
    input.targetProtein && input.targetProtein > 0 ? input.protein / input.targetProtein : null;
  const intakePace =
    input.targetCalories && input.targetCalories > 0 ? input.intake / input.targetCalories : null;

  if (input.slot === "morning") {
    return "בוקר טוב 🌱 תן לפתיחה של היום להיות פשוטה: משהו שאתה אוהב, עם חלבון טוב, כדי להגיע רגוע יותר לארוחה הבאה.";
  }

  if (input.slot === "afternoon") {
    if (proteinPace !== null && proteinPace < 0.45) {
      return "אמצע היום 🌿 בארוחה הבאה כדאי לתת קצת יותר מקום לחלבון — זה יעזור לך לסיים את היום בצורה נוחה יותר.";
    }

    if (intakePace !== null && intakePace > 0.8) {
      return "היום כבר די מלא מבחינת אוכל 🌿 אם תהיה רעב בהמשך, לך על משהו קל ומשביע במקום לנסות 'לפצות'.";
    }

    return "נראה שהיום מתקדם יפה 🌿 תמשיך רגיל, ובארוחה הבאה תבחר משהו שישאיר אותך שבע ונוח להמשך.";
  }

  if (proteinPace !== null && proteinPace < 0.75) {
    return "לקראת סיום היום 🌙 אם עוד בא לך משהו, עדיף לבחור נשנוש או ארוחה קטנה עם חלבון — בלי להעמיס.";
  }

  if (input.balance !== null && input.balance >= 0) {
    return "סיום טוב ליום 🌙 אין צורך לרדוף אחרי מספרים עכשיו. אם אתה שבע ומרגיש טוב — זה מקום מצוין לעצור בו.";
  }

  return "סיכום ערב 🌙 קח מהיום דבר אחד שעבד לך טוב, ותנסה לשחזר אותו גם מחר. לא צריך שכל יום יהיה מושלם.";
}

function dueSlot(user: NotificationUser, localDate: string, currentMinutes: number): Slot | null {
  const candidates = [
    {
      enabled: user.morning_enabled === 1,
      time: user.morning_time,
      type: "smart_morning" as const,
      label: "morning" as const,
      title: "רגע טוב · בוקר טוב 🌱",
    },
    {
      enabled: user.afternoon_enabled === 1,
      time: user.afternoon_time,
      type: "smart_afternoon" as const,
      label: "afternoon" as const,
      title: "רגע טוב · אמצע היום 🌿",
    },
    {
      enabled: user.evening_enabled === 1,
      time: user.evening_time,
      type: "smart_evening" as const,
      label: "evening" as const,
      title: "רגע טוב · סיכום ערב 🌙",
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.enabled) continue;
    const targetMinutes = parseTime(candidate.time);
    if (targetMinutes === null) continue;
    const delta = currentMinutes - targetMinutes;
    if (delta >= 0 && delta < 15) {
      return {
        type: candidate.type,
        label: candidate.label,
        title: candidate.title,
        localDate,
      };
    }
  }
  return null;
}

function localClock(date: Date, timeZone: string): { localDate: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return {
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function isAiBinding(value: unknown): value is GenericAiBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

function readText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["response", "result", "content", "text"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function cleanText(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 220) : null;
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
