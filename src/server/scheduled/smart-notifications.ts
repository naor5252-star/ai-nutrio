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

type PersonalContextRow = {
  display_name: string | null;
  primary_goal: string | null;
};

type RecentMessageRow = {
  body: string;
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
  const [target, meals, health, personalContext, recentMessages] = await Promise.all([
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
    env.DB.prepare(
      `SELECT u.display_name, up.primary_goal
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
    )
      .bind(user.id)
      .first<PersonalContextRow>(),
    env.DB.prepare(
      `SELECT body
       FROM push_notification_messages
       WHERE owner_user_id = ?
         AND notification_type IN ('smart_morning', 'smart_afternoon', 'smart_evening')
       ORDER BY created_at DESC
       LIMIT 4`,
    )
      .bind(user.id)
      .all<RecentMessageRow>(),
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

  const proteinPace =
    targetProtein && targetProtein > 0 ? protein / targetProtein : null;
  const intakePace =
    targetCalories && targetCalories > 0 ? intake / targetCalories : null;
  const angle = chooseNotificationAngle({
    slot: slot.label,
    localDate: slot.localDate,
    proteinPace,
    intakePace,
    balance,
    mealCount: meals?.meal_count ?? 0,
  });
  const name = firstName(personalContext?.display_name ?? null);

  const fallback = fallbackMessage({
    slot: slot.label,
    localDate: slot.localDate,
    angle,
    name,
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
            "אתה המאמן האישי של אפליקציית 'רגע טוב'. כתוב הודעת Push אחת בעברית טבעית, חמה וקצרה, עד 190 תווים. המספרים הם חומר רקע בשבילך — אל תקריא דוח ואל תכתוב כמה נצרך וכמה נשאר, אלא אם מספר יחיד באמת נחוץ. התמקד ברעיון אחד מועיל עכשיו: חיזוק הרגל טוב, הצעה קטנה לארוחה הבאה, הקשבה לרעב ושובע, או מחשבה חיובית לסיום היום. השתמש בשם הפרטי רק לפעמים, לא בכל הודעה. אל תחזור על ניסוח מההודעות האחרונות. אל תהיה שיפוטי, אל תדבר על 'פיצוי', אל תייצר לחץ, אל תמציא נתונים ואל תיתן ייעוץ רפואי.",
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
            firstName: name,
            primaryGoal: personalContext?.primary_goal ?? null,
            coachingAngle: angle,
            recentNotificationBodies: recentMessages.results.map((message) => message.body),
            instruction:
              "כתוב מסר אחד אישי ומעשי לפי coachingAngle. אל תסכם את כל הנתונים ואל תחזור על ההודעות האחרונות.",
            fallback,
          }),
        },
      ],
      max_tokens: 120,
      temperature: 0.62,
    });

    return cleanText(readText(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

type CoachingAngle =
  | "gentle_start"
  | "protein_nudge"
  | "steady_momentum"
  | "light_evening"
  | "listen_to_hunger"
  | "close_the_day"
  | "fresh_start";

function chooseNotificationAngle(input: {
  slot: "morning" | "afternoon" | "evening";
  localDate: string;
  proteinPace: number | null;
  intakePace: number | null;
  balance: number | null;
  mealCount: number;
}): CoachingAngle {
  if (input.slot === "morning") {
    return deterministicPick(
      ["gentle_start", "fresh_start", "steady_momentum"] as const,
      `${input.localDate}:morning`,
    );
  }

  if (input.slot === "afternoon") {
    if (input.proteinPace !== null && input.proteinPace < 0.45) return "protein_nudge";
    if (input.intakePace !== null && input.intakePace > 0.82) return "light_evening";
    return deterministicPick(
      ["steady_momentum", "listen_to_hunger", "protein_nudge"] as const,
      `${input.localDate}:afternoon:${input.mealCount}`,
    );
  }

  if (input.proteinPace !== null && input.proteinPace < 0.75) return "protein_nudge";
  if (input.balance !== null && input.balance >= 0) return "listen_to_hunger";
  return deterministicPick(
    ["close_the_day", "steady_momentum", "fresh_start"] as const,
    `${input.localDate}:evening`,
  );
}

function fallbackMessage(input: {
  slot: "morning" | "afternoon" | "evening";
  localDate: string;
  angle: CoachingAngle;
  name: string | null;
}): string {
  const prefix =
    input.name && deterministicNumber(`${input.localDate}:${input.slot}:name`) % 3 === 0
      ? `${input.name}, `
      : "";

  const messages: Record<CoachingAngle, readonly string[]> = {
    gentle_start: [
      "פתח את היום פשוט 🌱 משהו שאתה אוהב, עם חלבון טוב לידו, יכול לעשות את ההמשך הרבה יותר רגוע.",
      "לא צריך בוקר מושלם ☀️ בחירה אחת משביעה ונוחה עכשיו מספיקה כדי להתחיל בכיוון טוב.",
      "תן לבוקר לעבוד בשבילך 🌱 ארוחה פשוטה ומשביעה עכשיו יכולה לחסוך רעב חזק בהמשך.",
    ],
    protein_nudge: [
      "בארוחה הבאה שווה לתת קצת יותר מקום לחלבון 🌿 בחירה קטנה עכשיו יכולה לסדר יפה את המשך היום.",
      "רעיון קטן להמשך: בחר משהו עם בסיס חלבוני טוב, ותוסיף לידו את מה שבא לך באמת לאכול.",
      "אם אתה מתכנן את הארוחה הבאה, תתחיל מהחלבון ומשם תבנה את השאר. פשוט וקל.",
    ],
    steady_momentum: [
      "נראה שהיום מתקדם בקצב טוב 🌿 אין צורך לשנות הרבה — פשוט להמשיך עם בחירות שנוחות לך.",
      "הכיוון טוב. בארוחה הבאה חפש בעיקר משהו שישביע אותך ושתהנה ממנו, בלי לסבך.",
      "עוד יום שנבנה מבחירות קטנות 🌱 תמשיך רגיל; עקביות חשובה יותר מארוחה 'מושלמת'.",
    ],
    light_evening: [
      "אם תהיה רעב בערב, לך על משהו קל ומשביע 🌙 אין צורך להפוך את שאר היום לפרויקט.",
      "להמשך הערב: תן לרעב להוביל. אם צריך משהו, בחר מנה פשוטה ונוחה ולא מתוך תחושת חובה.",
      "הערב יכול להישאר קליל 🌙 תאכל אם אתה רעב, ותבחר משהו שיעשה לך טוב בלי להעמיס.",
    ],
    listen_to_hunger: [
      "בדוק רגע איך אתה מרגיש 🌿 אם אתה שבע, אפשר לעצור. אם אתה רעב, מגיעה לך ארוחה אמיתית — לא רק 'להחזיק מעמד'.",
      "הרעב והשובע שלך חשובים יותר מעוד מספר על המסך. תן להם להוביל את הבחירה הבאה.",
      "לפני הארוחה הבאה, רגע אחד של בדיקה: רעב באמת, חשק, או פשוט הרגל? אין תשובה 'נכונה'.",
    ],
    close_the_day: [
      "סיום יום 🌙 קח איתך דבר אחד שעבד היום טוב ותנסה לשחזר אותו מחר. זה מספיק.",
      "לא צריך לסכם את היום בציון. אם הייתה בחירה אחת שעשתה לך טוב — זה הדבר ששווה לזכור למחר.",
      "היום נגמר, לא צריך לתקן אותו 🌙 מחר ממשיכים מאותה נקודה, עם עוד בחירה קטנה טובה.",
    ],
    fresh_start: [
      "יום חדש, בלי חשבונות מאתמול 🌱 תבחר עכשיו דבר אחד שיעשה את היום קצת יותר קל.",
      "מתחילים נקי ☀️ לא צריך תוכנית מושלמת — רק החלטה קטנה אחת שתשרת אותך היום.",
      "היום לא צריך להיראות כמו אתמול. תתחיל מבחירה אחת טובה שמתאימה לך עכשיו.",
    ],
  };

  const options = messages[input.angle];
  return `${prefix}${deterministicPick(options, `${input.localDate}:${input.slot}:${input.angle}`)}`;
}

function firstName(displayName: string | null): string | null {
  if (!displayName) return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/u)[0] ?? null;
}

function deterministicPick<T>(values: readonly T[], seed: string): T {
  return values[deterministicNumber(seed) % values.length]!;
}

function deterministicNumber(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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
