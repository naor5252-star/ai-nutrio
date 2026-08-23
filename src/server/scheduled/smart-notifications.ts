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
};

type Slot = {
  type: "smart_morning" | "smart_afternoon" | "smart_evening";
  label: "morning" | "afternoon" | "evening";
  localDate: string;
};

type TargetRow = {
  effective_calories: number | null;
  effective_protein_grams: number | null;
};

type PersonalContextRow = {
  display_name: string | null;
  primary_goal: string | null;
};

type MealAggregateRow = {
  calories: number | null;
  protein: number | null;
  meal_count: number;
};

type HealthRow = {
  active_energy_kcal: number | null;
  resting_energy_kcal: number | null;
  steps: number | null;
  walking_running_distance_km: number | null;
};

type WorkoutAggregateRow = {
  workout_count: number;
  duration_minutes: number | null;
};

type RecentMessageRow = {
  title: string;
  body: string;
};

type DailySnapshot = {
  date: string;
  meals: {
    calories: number;
    proteinGrams: number;
    mealCount: number;
  };
  activity: {
    steps: number | null;
    activeEnergyKcal: number | null;
    restingEnergyKcal: number | null;
    walkingRunningDistanceKm: number | null;
    workoutCount: number;
    workoutDurationMinutes: number;
  };
};

type AiNotification = {
  title: string;
  body: string;
};

export async function runSmartPushNotifications(
  env: RuntimeEnv,
  correlationId: string,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  if (env.AI_ENABLED !== "true" || !isAiBinding(env.AI)) {
    logEvent({
      severity: "warn",
      event: "smart_push_ai_unavailable",
      correlationId,
      outcome: "skipped",
      details: { reason: "AI_REQUIRED_FOR_ALL_SMART_NOTIFICATIONS" },
    });
    return;
  }

  const users = await env.DB.prepare(
    `SELECT
       u.id, u.timezone,
       np.morning_enabled, np.morning_time,
       np.afternoon_enabled, np.afternoon_time,
       np.evening_enabled, np.evening_time
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
  let aiSkippedUsers = 0;

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

    const notification = await buildAiNotification(env, user, slot, correlationId);
    if (!notification) {
      aiSkippedUsers += 1;
      continue;
    }

    const messageId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO push_notification_messages
         (id, owner_user_id, notification_type, title, body, target_url, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, '/', ?, ?)`,
      ).bind(
        messageId,
        user.id,
        slot.type,
        notification.title,
        notification.body,
        createdAt,
        expiresAt,
      ),
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
        result.sent > 0 ? null : (result.failures[0] ?? "PUSH_NOT_SENT").slice(0, 200),
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
    details: {
      candidates: users.results.length,
      sentUsers,
      aiSkippedUsers,
    },
  });
}

async function buildAiNotification(
  env: RuntimeEnv,
  user: NotificationUser,
  slot: Slot,
  correlationId: string,
): Promise<AiNotification | null> {
  const yesterday = addDays(slot.localDate, -1);
  const weekday = dayOfWeek(slot.localDate);
  const weekendApproach = weekday === 4 || weekday === 5;
  const weekStart = startOfIsraeliWeek(slot.localDate);
  const weekDates = dateRange(weekStart, slot.localDate);

  try {
    const [target, personalContext, today, previousDay, recentMessages, weekSnapshots] =
      await Promise.all([
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
          `SELECT u.display_name, up.primary_goal
           FROM users u
           LEFT JOIN user_profiles up ON up.user_id = u.id
           WHERE u.id = ?
           LIMIT 1`,
        )
          .bind(user.id)
          .first<PersonalContextRow>(),
        loadDailySnapshot(env, user.id, slot.localDate),
        loadDailySnapshot(env, user.id, yesterday),
        env.DB.prepare(
          `SELECT title, body
           FROM push_notification_messages
           WHERE owner_user_id = ?
             AND notification_type IN ('smart_morning', 'smart_afternoon', 'smart_evening')
           ORDER BY created_at DESC
           LIMIT 6`,
        )
          .bind(user.id)
          .all<RecentMessageRow>(),
        weekendApproach
          ? Promise.all(weekDates.map((date) => loadDailySnapshot(env, user.id, date)))
          : Promise.resolve([] as DailySnapshot[]),
      ]);

    const firstName = extractFirstName(personalContext?.display_name ?? null);
    const model =
      weekendApproach || slot.label === "evening" ? env.AI_STRONG_MODEL : env.AI_FAST_MODEL;

    const raw = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: `אתה המאמן האישי של אפליקציית "רגע טוב".
כל הניתוח והניסוח חייבים להתבצע על ידך מתוך הנתונים שסופקו. אין מנגנון חוקים שמחליט עבורך מה חשוב.

המטרה: לכתוב התראת Push אחת קצרה, אישית ומכוונת לפעולה שמתאימה למצב של המשתמש עכשיו.

כללי ניתוח:
1. בכל הודעה השווה את היום הנוכחי ליום הקודם, בהתאם לשעה ביום ולכמות הנתונים שכבר קיימת היום.
2. בבוקר, כשהיום עדיין כמעט ריק, השתמש בעיקר ביום הקודם כדי להציע התחלה טובה יותר להיום.
3. באמצע היום, בדוק אם דפוס היום שונה מהיום הקודם והאם יש פעולה קטנה שכדאי לעשות בארוחה או בפעילות הבאה.
4. בערב, סכם את המשמעות של היום ביחס לאתמול והצע דבר אחד לקחת למחר.
5. כאשר weekendApproach=true, נתח גם את כל נתוני השבוע מתחילת השבוע ועד היום. חפש דפוס אמיתי שחוזר על עצמו והצע אסטרטגיה מעשית לסוף השבוע.
6. נתוני יעד, קלוריות, חלבון, צעדים, פעילות ושריפה הם חומר לניתוח מאחורי הקלעים. אל תקריא דוח מספרי. הצג מספר רק אם מספר יחיד באמת עוזר להחלטה.
7. אל תמציא מידע. אם חסרים נתונים, היה זהיר ואל תסיק מסקנה חזקה.
8. השתמש בשם הפרטי רק אם זה נשמע טבעי, ולא בכל הודעה.
9. אל תחזור על ניסוח או רעיון מההתראות האחרונות.
10. אל תהיה שיפוטי, אל תדבר על "פיצוי", אל תעודד דילוג על ארוחות ואל תיתן ייעוץ רפואי.
11. השפה צריכה להרגיש כמו מאמן אנושי שמכיר את הנתונים, לא כמו מערכת אנליטיקה.

החזר JSON בלבד, בלי Markdown:
{"title":"כותרת קצרה בעברית","body":"הודעה בעברית עד 220 תווים"}

גם הכותרת וגם גוף ההודעה חייבים להיכתב על ידך.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            timeOfDay: slot.label,
            localDate: slot.localDate,
            firstName,
            primaryGoal: personalContext?.primary_goal ?? null,
            targets: {
              calories: round(target?.effective_calories ?? null),
              proteinGrams: round(target?.effective_protein_grams ?? null),
            },
            today,
            previousDay,
            weekendApproach,
            weekContext: weekendApproach
              ? {
                  weekStartsOn: "Sunday",
                  from: weekStart,
                  through: slot.localDate,
                  days: weekSnapshots,
                }
              : null,
            recentNotifications: recentMessages.results.map((message) => ({
              title: message.title,
              body: message.body,
            })),
            task: "נתח את המידע בעצמך ובחר רק את התובנה והפעולה שהכי מועילות למשתמש ברגע הזה.",
          }),
        },
      ],
      max_tokens: 260,
      temperature: 0.55,
    });

    return parseAiNotification(raw);
  } catch (error) {
    logEvent({
      severity: "warn",
      event: "smart_push_ai_generation_failed",
      correlationId,
      outcome: "skipped",
      details: {
        slot: slot.label,
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      },
    });
    return null;
  }
}

async function loadDailySnapshot(
  env: RuntimeEnv,
  userId: string,
  date: string,
): Promise<DailySnapshot> {
  const [meals, health, workouts] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(total_calories), 0) AS calories,
         COALESCE(SUM(total_protein_grams), 0) AS protein,
         COUNT(*) AS meal_count
       FROM meals
       WHERE owner_user_id = ? AND local_date = ?`,
    )
      .bind(userId, date)
      .first<MealAggregateRow>(),
    env.DB.prepare(
      `SELECT
         active_energy_kcal,
         resting_energy_kcal,
         steps,
         walking_running_distance_km
       FROM health_daily_summaries
       WHERE owner_user_id = ?
         AND source = 'apple_health_shortcut'
         AND local_date = ?
       LIMIT 1`,
    )
      .bind(userId, date)
      .first<HealthRow>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS workout_count,
         COALESCE(SUM(duration_minutes), 0) AS duration_minutes
       FROM health_workouts
       WHERE owner_user_id = ?
         AND substr(start_at, 1, 10) = ?`,
    )
      .bind(userId, date)
      .first<WorkoutAggregateRow>(),
  ]);

  return {
    date,
    meals: {
      calories: round(meals?.calories ?? 0) ?? 0,
      proteinGrams: round(meals?.protein ?? 0) ?? 0,
      mealCount: meals?.meal_count ?? 0,
    },
    activity: {
      steps: round(health?.steps ?? null),
      activeEnergyKcal: round(health?.active_energy_kcal ?? null),
      restingEnergyKcal: round(health?.resting_energy_kcal ?? null),
      walkingRunningDistanceKm: roundOne(health?.walking_running_distance_km ?? null),
      workoutCount: workouts?.workout_count ?? 0,
      workoutDurationMinutes: round(workouts?.duration_minutes ?? 0) ?? 0,
    },
  };
}

function parseAiNotification(value: unknown): AiNotification {
  const direct = readDirectMessage(value);
  if (direct) return direct;

  const text = readText(value);
  if (!text) throw new Error("AI returned no text");

  const cleaned = text
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();

  const parsed = JSON.parse(cleaned) as unknown;
  const message = readDirectMessage(parsed);
  if (!message) throw new Error("AI returned invalid notification JSON");
  return message;
}

function readDirectMessage(value: unknown): AiNotification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const title = typeof record.title === "string" ? cleanLine(record.title, 70) : null;
  const body = typeof record.body === "string" ? cleanLine(record.body, 220) : null;

  if (!title || !body) return null;
  return { title, body };
}

function dueSlot(user: NotificationUser, localDate: string, currentMinutes: number): Slot | null {
  const candidates = [
    {
      enabled: user.morning_enabled === 1,
      time: user.morning_time,
      type: "smart_morning" as const,
      label: "morning" as const,
    },
    {
      enabled: user.afternoon_enabled === 1,
      time: user.afternoon_time,
      type: "smart_afternoon" as const,
      label: "afternoon" as const,
    },
    {
      enabled: user.evening_enabled === 1,
      time: user.evening_time,
      type: "smart_evening" as const,
      label: "evening" as const,
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

function startOfIsraeliWeek(localDate: string): string {
  return addDays(localDate, -dayOfWeek(localDate));
}

function dateRange(from: string, through: string): string[] {
  const dates: string[] = [];
  let current = from;

  while (current <= through && dates.length < 7) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

function addDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(localDate: string): number {
  return new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
}

function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function extractFirstName(displayName: string | null): string | null {
  if (!displayName) return null;
  const trimmed = displayName.trim();
  return trimmed ? (trimmed.split(/\s+/u)[0] ?? null) : null;
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

function cleanLine(value: string, maxLength: number): string | null {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function roundOne(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}
