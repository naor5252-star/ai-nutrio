import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RuntimeEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { addDaysIso, nowIso, parseJson } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { detectSafetyCategory, safetyResponseHe } from "../ai/safety";
import { generateCoachReply } from "../ai/text-generator";
import { logEvent } from "../services/logger";

export const coachRoutes = new Hono<AppEnv>();
coachRoutes.use("*", requireAuth);

coachRoutes.get("/next", async (context) => {
  const user = context.get("user");
  const date = z.string().date().parse(context.req.query("date"));
  const totals = await context.env.DB.prepare(
    `SELECT SUM(total_calories) AS calories, SUM(total_protein_grams) AS protein,
            SUM(total_carbohydrate_grams) AS carbs, SUM(total_fat_grams) AS fat,
            SUM(total_fiber_grams) AS fiber
       FROM meals WHERE owner_user_id = ? AND local_date = ?`,
  )
    .bind(user.id, date)
    .first<{
      calories: number | null;
      protein: number | null;
      carbs: number | null;
      fat: number | null;
      fiber: number | null;
    }>();
  const target = await context.env.DB.prepare(
    `SELECT effective_calories, effective_protein_grams, carbohydrate_grams, fat_grams, fiber_grams, warning_codes_json
       FROM nutrition_target_versions WHERE user_id = ? ORDER BY effective_from DESC LIMIT 1`,
  )
    .bind(user.id)
    .first<{
      effective_calories: number;
      effective_protein_grams: number;
      carbohydrate_grams: number;
      fat_grams: number;
      fiber_grams: number;
      warning_codes_json: string;
    }>();
  if (!target) {
    return context.json({
      headlineHe: "נתחיל מהבסיס",
      messageHe: "כדאי להשלים כמה פרטים קצרים בפרופיל כדי שאוכל להציג מה נשאר להיום.",
      actionHe: "השלמת פרופיל",
      actionPath: "/settings",
    });
  }
  const calories = totals?.calories ?? 0;
  const protein = totals?.protein ?? 0;
  const remainingCalories = Math.max(0, target.effective_calories - calories);
  const remainingProtein = Math.max(0, target.effective_protein_grams - protein);
  const warnings = parseJson<string[]>(target.warning_codes_json, []);
  return context.json({
    headlineHe: remainingProtein > 20 ? "בארוחה הבאה כדאי לשלב חלבון" : "היום מתקדם יפה",
    messageHe:
      remainingProtein > 20
        ? `נשארו בערך ${Math.round(remainingProtein)} גרם חלבון ו-${Math.round(remainingCalories)} קלוריות לפי היעד שהגדרת. אפשר לבחור מנה פשוטה עם מקור חלבון וירקות.`
        : `נשארו בערך ${Math.round(remainingCalories)} קלוריות. אפשר לבחור לפי הרעב וההעדפות שלך—אין צורך “לפצות” על ארוחות קודמות.`,
    actionHe: "רעיונות לארוחה",
    remaining: { calories: remainingCalories, proteinGrams: remainingProtein },
    targetWarning: warnings.length > 0,
    disclaimerHe: "המידע הוא תמיכה כללית באורח חיים ואינו ייעוץ רפואי.",
  });
});

coachRoutes.get("/today", async (context) => {
  const user = context.get("user");
  const timezoneRow = await context.env.DB.prepare("SELECT timezone FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ timezone: string }>();

  const timezone = timezoneRow?.timezone?.trim() || "Asia/Jerusalem";
  const today = coachLocalDate(new Date(), timezone);

  const conversations = await context.env.DB.prepare(
    `SELECT id, created_at
     FROM ai_conversations
     WHERE owner_user_id = ?
     ORDER BY created_at DESC
     LIMIT 20`,
  )
    .bind(user.id)
    .all<{ id: string; created_at: string }>();

  const conversation =
    conversations.results.find(
      (item) => coachLocalDate(new Date(item.created_at), timezone) === today,
    ) ?? null;

  if (!conversation) {
    return context.json({
      localDate: today,
      conversationId: null,
      messages: [],
    });
  }

  const messages = await context.env.DB.prepare(
    `SELECT id, role, content_text, created_at
     FROM ai_messages
     WHERE conversation_id = ? AND owner_user_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(conversation.id, user.id)
    .all<{ id: string; role: string; content_text: string; created_at: string }>();

  return context.json({
    localDate: today,
    conversationId: conversation.id,
    messages: messages.results
      .filter(
        (
          message,
        ): message is {
          id: string;
          role: "user" | "assistant";
          content_text: string;
          created_at: string;
        } => message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: message.content_text,
        createdAt: message.created_at,
      })),
  });
});

coachRoutes.post("/messages", requireCsrf, async (context) => {
  const input = z
    .object({
      conversationId: z.string().uuid().nullable().optional(),
      clientRequestId: z.string().uuid().optional(),
      message: z.string().trim().min(1).max(4_000),
    })
    .parse(await context.req.json());
  const user = context.get("user");
  const safety = detectSafetyCategory(input.message);
  const now = nowIso();
  const idempotencyKey = input.clientRequestId
    ? `coach:${user.id}:${input.clientRequestId}`
    : null;

  if (idempotencyKey) {
    const replay = await context.env.DB.prepare(
      `SELECT response_json
       FROM idempotency_records
       WHERE idempotency_key = ?
         AND owner_user_id = ?
         AND operation = 'coach_message'
         AND expires_at > ?
       LIMIT 1`,
    )
      .bind(idempotencyKey, user.id, now)
      .first<{ response_json: string | null }>();

    if (replay?.response_json) {
      try {
        return context.json(
          JSON.parse(replay.response_json) as {
            conversationId: string;
            response: string;
            safetyCategory: string | null;
          },
        );
      } catch {
        // Ignore a malformed stale replay and process a fresh request.
      }
    }
  }
  const conversationId = input.conversationId ?? secureUuid();
  if (!input.conversationId) {
    await context.env.DB.prepare(
      "INSERT INTO ai_conversations (id, owner_user_id, title, created_at, updated_at, full_text_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        conversationId,
        user.id,
        input.message.slice(0, 80),
        now,
        now,
        addDaysIso(Number(context.env.CHAT_RETENTION_DAYS)),
      )
      .run();
  } else {
    const owned = await context.env.DB.prepare(
      "SELECT id FROM ai_conversations WHERE id = ? AND owner_user_id = ?",
    )
      .bind(conversationId, user.id)
      .first<{ id: string }>();
    if (!owned) return context.notFound();
  }
  let response: string;

  if (safety) {
    response = safetyResponseHe(safety);
  } else {
    const historyResult = await context.env.DB.prepare(
      `SELECT role, content_text, created_at
       FROM ai_messages
       WHERE conversation_id = ? AND owner_user_id = ?
       ORDER BY created_at DESC
       LIMIT 12`,
    )
      .bind(conversationId, user.id)
      .all<{ role: string; content_text: string; created_at: string }>();

    let appDataContext: unknown;

    try {
      appDataContext = await loadCoachWeekContext(context.env, user.id);
    } catch (error) {
      logEvent({
        severity: "error",
        event: "coach_week_context_failed",
        correlationId: context.get("correlationId"),
        outcome: "fallback_context",
        retryable: true,
        details: {
          errorMessage:
            error instanceof Error ? error.message.slice(0, 400) : "unknown context error",
        },
      });

      appDataContext = await loadMinimalCoachContext(context.env, user.id).catch(() => ({
        dataAvailable: false,
        note: "נתוני האפליקציה לא היו זמינים לרגע. אין להמציא נתונים.",
      }));
    }

    const conversationHistory = [...historyResult.results]
      .reverse()
      .filter(
        (
          message,
        ): message is { role: "user" | "assistant"; content_text: string; created_at: string } =>
          message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({
        role: message.role,
        content: message.content_text,
        createdAt: message.created_at,
      }));

    try {
      response = await generateCoachReply({
        env: context.env,
        userMessage: input.message,
        correlationId: context.get("correlationId"),
        appDataContext,
        conversationHistory,
      });
    } catch (error) {
      logEvent({
        severity: "error",
        event: "coach_ai_unexpected_failure",
        correlationId: context.get("correlationId"),
        outcome: "safe_response",
        retryable: true,
        details: {
          errorMessage:
            error instanceof Error ? error.message.slice(0, 400) : "unknown AI error",
        },
      });

      response =
        "לא הצלחתי להשלים את התשובה הפעם. הנתונים שלך שמורים — נסה לשלוח שוב בעוד רגע.";
    }
  }
  const expiresAt = addDaysIso(Number(context.env.CHAT_RETENTION_DAYS));
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      "INSERT INTO ai_messages (id, conversation_id, owner_user_id, role, content_text, safety_classification, created_at, expires_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)",
    ).bind(secureUuid(), conversationId, user.id, input.message, safety, now, expiresAt),
    context.env.DB.prepare(
      "INSERT INTO ai_messages (id, conversation_id, owner_user_id, role, content_text, safety_classification, created_at, expires_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)",
    ).bind(secureUuid(), conversationId, user.id, response, safety, now, expiresAt),
    context.env.DB.prepare(
      "UPDATE ai_conversations SET updated_at = ? WHERE id = ? AND owner_user_id = ?",
    ).bind(now, conversationId, user.id),
  ];
  if (safety) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO ai_safety_events (id, owner_user_id, category, action_taken, correlation_id, created_at) VALUES (?, ?, ?, 'refused_and_redirected', ?, ?)",
      ).bind(secureUuid(), user.id, safety, context.get("correlationId"), now),
    );
  }
  const responsePayload = {
    conversationId,
    response,
    safetyCategory: safety,
  };

  if (idempotencyKey) {
    statements.push(
      context.env.DB.prepare(
        `INSERT OR REPLACE INTO idempotency_records
         (idempotency_key, owner_user_id, operation, request_hash, response_status, response_json, expires_at, created_at)
         VALUES (?, ?, 'coach_message', ?, 200, ?, ?, ?)`,
      ).bind(
        idempotencyKey,
        user.id,
        await coachRequestHash(input.message, input.conversationId ?? null),
        JSON.stringify(responsePayload),
        addDaysIso(1),
        now,
      ),
    );
  }

  await context.env.DB.batch(statements);
  return context.json(responsePayload);
});

coachRoutes.delete("/memory", requireCsrf, async (context) => {
  const userId = context.get("user").id;
  await context.env.DB.batch([
    context.env.DB.prepare("DELETE FROM ai_conversations WHERE owner_user_id = ?").bind(userId),
    context.env.DB.prepare("DELETE FROM ai_memory_summaries WHERE owner_user_id = ?").bind(userId),
    context.env.DB.prepare("DELETE FROM ai_structured_memories WHERE owner_user_id = ?").bind(
      userId,
    ),
  ]);
  return context.json({ ok: true });
});

type CoachUserRow = {
  timezone: string;
  display_name: string | null;
  primary_goal: string | null;
  diet_type: string | null;
};

type CoachTargetRow = {
  effective_calories: number | null;
  effective_protein_grams: number | null;
  carbohydrate_grams: number | null;
  fat_grams: number | null;
  fiber_grams: number | null;
};

type CoachMealDayRow = {
  local_date: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  meal_count: number;
};

type CoachHealthDayRow = {
  local_date: string;
  steps: number | null;
  active_energy_kcal: number | null;
  resting_energy_kcal: number | null;
  distance_km: number | null;
  sleep_minutes: number | null;
};

type CoachWorkoutDayRow = {
  local_date: string;
  workout_count: number | null;
  workout_minutes: number | null;
  workout_energy_kcal: number | null;
};

type CoachTodayMealRow = {
  occurred_at: string;
  category: string;
  title: string;
  calories: number | null;
  protein: number | null;
  item_names: string | null;
};

async function loadCoachWeekContext(env: RuntimeEnv, userId: string): Promise<unknown> {
  const userRow = await env.DB.prepare(
    `SELECT u.timezone, u.display_name, up.primary_goal, pref.diet_type
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     LEFT JOIN user_preferences pref ON pref.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<CoachUserRow>();

  const timezone = userRow?.timezone?.trim() || "Asia/Jerusalem";
  const today = localDateForTimezone(new Date(), timezone);
  const from = shiftCoachDate(today, -6);
  const yesterday = shiftCoachDate(today, -1);
  const currentWeekFrom = shiftCoachDate(today, -coachDayOfWeek(today));

  const [target, mealDays, healthDays, workoutDays, todayMeals] = await Promise.all([
    env.DB.prepare(
      `SELECT effective_calories, effective_protein_grams,
              carbohydrate_grams, fat_grams, fiber_grams
       FROM nutrition_target_versions
       WHERE user_id = ?
       ORDER BY effective_from DESC
       LIMIT 1`,
    )
      .bind(userId)
      .first<CoachTargetRow>(),
    env.DB.prepare(
      `SELECT local_date,
              COALESCE(SUM(total_calories), 0) AS calories,
              COALESCE(SUM(total_protein_grams), 0) AS protein,
              COALESCE(SUM(total_carbohydrate_grams), 0) AS carbs,
              COALESCE(SUM(total_fat_grams), 0) AS fat,
              COALESCE(SUM(total_fiber_grams), 0) AS fiber,
              COUNT(*) AS meal_count
       FROM meals
       WHERE owner_user_id = ? AND local_date BETWEEN ? AND ?
       GROUP BY local_date`,
    )
      .bind(userId, from, today)
      .all<CoachMealDayRow>(),
    env.DB.prepare(
      `SELECT local_date,
              MAX(steps) AS steps,
              MAX(active_energy_kcal) AS active_energy_kcal,
              MAX(resting_energy_kcal) AS resting_energy_kcal,
              MAX(walking_running_distance_km) AS distance_km,
              MAX(sleep_minutes) AS sleep_minutes
       FROM health_daily_summaries
       WHERE owner_user_id = ? AND local_date BETWEEN ? AND ?
       GROUP BY local_date`,
    )
      .bind(userId, from, today)
      .all<CoachHealthDayRow>(),
    env.DB.prepare(
      `SELECT local_date,
              MAX(workout_count) AS workout_count,
              MAX(workout_minutes) AS workout_minutes,
              MAX(workout_energy_kcal) AS workout_energy_kcal
       FROM (
         SELECT substr(start_at, 1, 10) AS local_date,
                source,
                COUNT(*) AS workout_count,
                COALESCE(SUM(duration_minutes), 0) AS workout_minutes,
                COALESCE(SUM(active_energy_kcal), 0) AS workout_energy_kcal
         FROM health_workouts
         WHERE owner_user_id = ?
           AND substr(start_at, 1, 10) BETWEEN ? AND ?
         GROUP BY substr(start_at, 1, 10), source
       )
       GROUP BY local_date`,
    )
      .bind(userId, from, today)
      .all<CoachWorkoutDayRow>(),
    env.DB.prepare(
      `SELECT m.occurred_at, m.category, m.title,
              m.total_calories AS calories,
              m.total_protein_grams AS protein,
              GROUP_CONCAT(mi.name_he, ' | ') AS item_names
       FROM meals m
       LEFT JOIN meal_items mi ON mi.meal_id = m.id
       WHERE m.owner_user_id = ? AND m.local_date = ?
       GROUP BY m.id
       ORDER BY m.occurred_at ASC
       LIMIT 12`,
    )
      .bind(userId, today)
      .all<CoachTodayMealRow>(),
  ]);

  const mealsByDate = new Map(mealDays.results.map((row) => [row.local_date, row]));
  const healthByDate = new Map(healthDays.results.map((row) => [row.local_date, row]));
  const workoutsByDate = new Map(workoutDays.results.map((row) => [row.local_date, row]));

  const days = coachDateRange(from, today).map((date) => {
    const meals = mealsByDate.get(date);
    const health = healthByDate.get(date);
    const workouts = workoutsByDate.get(date);

    return {
      date,
      meals: {
        calories: coachRound(meals?.calories ?? 0),
        proteinGrams: coachRound(meals?.protein ?? 0),
        carbohydrateGrams: coachRound(meals?.carbs ?? 0),
        fatGrams: coachRound(meals?.fat ?? 0),
        fiberGrams: coachRound(meals?.fiber ?? 0),
        mealCount: meals?.meal_count ?? 0,
      },
      activity: {
        steps: coachRoundNullable(health?.steps ?? null),
        activeEnergyKcal: coachRoundNullable(health?.active_energy_kcal ?? null),
        restingEnergyKcal: coachRoundNullable(health?.resting_energy_kcal ?? null),
        walkingRunningDistanceKm: coachRoundOne(health?.distance_km ?? null),
        sleepMinutes: coachRoundNullable(health?.sleep_minutes ?? null),
        workoutCount: coachRound(workouts?.workout_count ?? 0),
        workoutMinutes: coachRound(workouts?.workout_minutes ?? 0),
        workoutActiveEnergyKcal: coachRoundNullable(workouts?.workout_energy_kcal ?? null),
      },
    };
  });

  const todaySnapshot = days.find((day) => day.date === today);
  const yesterdaySnapshot = days.find((day) => day.date === yesterday);
  const currentWeek = days.filter((day) => day.date >= currentWeekFrom);

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    localDate: today,
    localTime: localTimeForTimezone(new Date(), timezone),
    profile: {
      firstName: coachFirstName(userRow?.display_name ?? null),
      primaryGoal: userRow?.primary_goal ?? null,
      dietType: userRow?.diet_type ?? null,
    },
    targets: {
      calories: coachRoundNullable(target?.effective_calories ?? null),
      proteinGrams: coachRoundNullable(target?.effective_protein_grams ?? null),
      carbohydrateGrams: coachRoundNullable(target?.carbohydrate_grams ?? null),
      fatGrams: coachRoundNullable(target?.fat_grams ?? null),
      fiberGrams: coachRoundNullable(target?.fiber_grams ?? null),
    },
    today: {
      summary: todaySnapshot ?? null,
      meals: todayMeals.results.map((meal) => ({
        occurredAt: meal.occurred_at,
        category: meal.category,
        title: meal.title.slice(0, 120),
        items: coachSplitItems(meal.item_names),
        calories: coachRoundNullable(meal.calories),
        proteinGrams: coachRoundNullable(meal.protein),
      })),
    },
    yesterday: yesterdaySnapshot ?? null,
    currentWeek: {
      from: currentWeekFrom,
      through: today,
      days: currentWeek,
    },
    lastSevenDays: {
      from,
      through: today,
      days,
    },
  };
}

function localDateForTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localTimeForTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function shiftCoachDate(localDate: string, days: number): string {
  const date = new Date(`${localDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function coachDayOfWeek(localDate: string): number {
  return new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
}

function coachDateRange(from: string, through: string): string[] {
  const dates: string[] = [];
  let current = from;

  while (current <= through && dates.length < 7) {
    dates.push(current);
    current = shiftCoachDate(current, 1);
  }

  return dates;
}

function coachSplitItems(value: string | null): string[] {
  if (!value) return [];

  return value
    .split(" | ")
    .map((item) => item.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 15);
}

function coachFirstName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? (trimmed.split(/\s+/u)[0] ?? null) : null;
}

function coachRound(value: number): number {
  return Math.round(value);
}

function coachRoundNullable(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function coachRoundOne(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function coachLocalDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return `${get("year")}-${get("month")}-${get("day")}`;
}


async function loadMinimalCoachContext(
  env: RuntimeEnv,
  userId: string,
): Promise<unknown> {
  const timezoneRow = await env.DB.prepare("SELECT timezone FROM users WHERE id = ?")
    .bind(userId)
    .first<{ timezone: string }>();

  const timezone = timezoneRow?.timezone?.trim() || "Asia/Jerusalem";
  const localDate = localDateForTimezone(new Date(), timezone);

  const [target, totals] = await Promise.all([
    env.DB.prepare(
      `SELECT effective_calories, effective_protein_grams,
              carbohydrate_grams, fat_grams, fiber_grams
       FROM nutrition_target_versions
       WHERE user_id = ?
       ORDER BY effective_from DESC
       LIMIT 1`,
    )
      .bind(userId)
      .first<CoachTargetRow>(),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(total_calories), 0) AS calories,
         COALESCE(SUM(total_protein_grams), 0) AS protein,
         COALESCE(SUM(total_carbohydrate_grams), 0) AS carbs,
         COALESCE(SUM(total_fat_grams), 0) AS fat,
         COALESCE(SUM(total_fiber_grams), 0) AS fiber,
         COUNT(*) AS meal_count
       FROM meals
       WHERE owner_user_id = ? AND local_date = ?`,
    )
      .bind(userId, localDate)
      .first<Omit<CoachMealDayRow, "local_date">>(),
  ]);

  return {
    fallbackContext: true,
    timezone,
    localDate,
    targets: target ?? null,
    today: totals ?? null,
  };
}

async function coachRequestHash(
  message: string,
  conversationId: string | null,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${conversationId ?? "new"}\n${message}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
