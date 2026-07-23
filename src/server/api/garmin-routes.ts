import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { nowIso } from "../repositories/db";
import { randomToken, secureUuid, sha256Hex } from "../security/crypto";
import { AppError } from "./errors";

const SHORTCUT_PROVIDER = "apple_health_shortcut";
const MAX_IMPORT_BYTES = 128 * 1024;

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const dateTimeSchema = z
  .string()
  .min(10)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "תאריך ושעה אינם תקינים");

const workoutSchema = z
  .object({
    sourceRecordId: z.string().min(1).max(200).optional(),
    workoutType: z.string().min(1).max(80),
    startAt: dateTimeSchema,
    endAt: dateTimeSchema,
    durationMinutes: z.number().positive().max(14_400),
    activeEnergyKcal: z.number().min(0).max(20_000).nullable().optional(),
    distanceKm: z.number().min(0).max(1_000).nullable().optional(),
    averageHeartRateBpm: z.number().min(20).max(250).nullable().optional(),
    maxHeartRateBpm: z.number().min(20).max(260).nullable().optional(),
  })
  .refine((value) => Date.parse(value.endAt) >= Date.parse(value.startAt), {
    path: ["endAt"],
    message: "שעת סיום האימון מוקדמת משעת ההתחלה",
  });

const shortcutImportSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  localDate: localDateSchema,
  generatedAt: dateTimeSchema.optional(),
  timezone: z.string().min(1).max(100).optional(),
  steps: z.number().int().min(0).max(200_000).nullable().optional(),
  activeEnergyKcal: z.number().min(0).max(20_000).nullable().optional(),
  restingEnergyKcal: z.number().min(0).max(20_000).nullable().optional(),
  walkingRunningDistanceKm: z.number().min(0).max(1_000).nullable().optional(),
  flightsClimbed: z.number().int().min(0).max(20_000).nullable().optional(),
  restingHeartRateBpm: z.number().min(20).max(250).nullable().optional(),
  averageHeartRateBpm: z.number().min(20).max(250).nullable().optional(),
  sleepMinutes: z.number().min(0).max(1_440).nullable().optional(),
  waterMl: z.number().min(0).max(30_000).nullable().optional(),
  weightKg: z.number().min(20).max(500).nullable().optional(),
  bodyFatPercentage: z.number().min(1).max(80).nullable().optional(),
  workouts: z.array(workoutSchema).max(50).optional(),
});

type ShortcutConnection = {
  id: string;
  user_id: string;
  status: string;
  last_successful_sync_at: string | null;
  last_error_code: string | null;
};

type DailySummary = {
  local_date: string;
  steps: number | null;
  active_energy_kcal: number | null;
  resting_energy_kcal: number | null;
  walking_running_distance_km: number | null;
  resting_heart_rate_bpm: number | null;
  sleep_minutes: number | null;
  weight_kg: number | null;
  body_fat_percentage: number | null;
  imported_at: string;
};

type WorkoutSummary = {
  workout_type: string;
  start_at: string;
  duration_minutes: number;
  active_energy_kcal: number | null;
  distance_km: number | null;
};

export const garminRoutes = new Hono<AppEnv>();

garminRoutes.post("/shortcut/import", async (context) => {
  const contentLength = Number(context.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_BYTES) {
    throw new AppError({
      status: 413,
      code: "HEALTH_IMPORT_TOO_LARGE",
      messageHe: "חבילת נתוני הבריאות גדולה מדי",
    });
  }

  const authorization = context.req.header("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/iu.exec(authorization.trim());
  const token = match?.[1];
  if (!token || token.length < 32 || token.length > 200) {
    throw new AppError({
      status: 401,
      code: "HEALTH_IMPORT_UNAUTHORIZED",
      messageHe: "מפתח החיבור חסר או אינו תקין",
    });
  }

  const tokenHash = await sha256Hex(token);
  const connection = await context.env.DB.prepare(
    `SELECT id, user_id, status, last_successful_sync_at, last_error_code
       FROM health_shortcut_connections
      WHERE provider = ? AND token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(SHORTCUT_PROVIDER, tokenHash)
    .first<ShortcutConnection>();

  if (!connection) {
    throw new AppError({
      status: 401,
      code: "HEALTH_IMPORT_TOKEN_REVOKED",
      messageHe: "מפתח החיבור אינו פעיל. צור מפתח חדש בהגדרות.",
    });
  }

  let rawInput: unknown;
  try {
    rawInput = await context.req.json();
  } catch {
    throw new AppError({
      status: 400,
      code: "HEALTH_IMPORT_JSON_INVALID",
      messageHe: "ה־Shortcut לא שלח JSON תקין",
    });
  }

  const input = shortcutImportSchema.parse(rawInput);
  const now = nowIso();
  const generatedAt = input.generatedAt ?? now;
  const timezone = input.timezone ?? "Asia/Jerusalem";
  const workouts = input.workouts ?? [];
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO health_daily_summaries (
         id, owner_user_id, source, local_date, timezone, generated_at,
         steps, active_energy_kcal, resting_energy_kcal,
         walking_running_distance_km, flights_climbed,
         resting_heart_rate_bpm, average_heart_rate_bpm,
         sleep_minutes, water_ml, weight_kg, body_fat_percentage,
         raw_json, imported_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_user_id, source, local_date) DO UPDATE SET
         timezone = excluded.timezone,
         generated_at = excluded.generated_at,
         steps = excluded.steps,
         active_energy_kcal = excluded.active_energy_kcal,
         resting_energy_kcal = excluded.resting_energy_kcal,
         walking_running_distance_km = excluded.walking_running_distance_km,
         flights_climbed = excluded.flights_climbed,
         resting_heart_rate_bpm = excluded.resting_heart_rate_bpm,
         average_heart_rate_bpm = excluded.average_heart_rate_bpm,
         sleep_minutes = excluded.sleep_minutes,
         water_ml = excluded.water_ml,
         weight_kg = excluded.weight_kg,
         body_fat_percentage = excluded.body_fat_percentage,
         raw_json = excluded.raw_json,
         imported_at = excluded.imported_at,
         updated_at = excluded.updated_at`,
    ).bind(
      secureUuid(),
      connection.user_id,
      SHORTCUT_PROVIDER,
      input.localDate,
      timezone,
      generatedAt,
      input.steps ?? null,
      input.activeEnergyKcal ?? null,
      input.restingEnergyKcal ?? null,
      input.walkingRunningDistanceKm ?? null,
      input.flightsClimbed ?? null,
      input.restingHeartRateBpm ?? null,
      input.averageHeartRateBpm ?? null,
      input.sleepMinutes ?? null,
      input.waterMl ?? null,
      input.weightKg ?? null,
      input.bodyFatPercentage ?? null,
      JSON.stringify(input),
      now,
      now,
    ),
  ];

  for (const workout of workouts) {
    const sourceRecordId =
      workout.sourceRecordId ??
      (await sha256Hex(
        [
          workout.workoutType,
          workout.startAt,
          workout.endAt,
          String(workout.durationMinutes),
          String(workout.distanceKm ?? ""),
        ].join("|"),
      ));

    statements.push(
      context.env.DB.prepare(
        `INSERT INTO health_workouts (
           id, owner_user_id, source, source_record_id, workout_type,
           start_at, end_at, duration_minutes, active_energy_kcal,
           distance_km, average_heart_rate_bpm, max_heart_rate_bpm,
           raw_json, imported_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_user_id, source, source_record_id) DO UPDATE SET
           workout_type = excluded.workout_type,
           start_at = excluded.start_at,
           end_at = excluded.end_at,
           duration_minutes = excluded.duration_minutes,
           active_energy_kcal = excluded.active_energy_kcal,
           distance_km = excluded.distance_km,
           average_heart_rate_bpm = excluded.average_heart_rate_bpm,
           max_heart_rate_bpm = excluded.max_heart_rate_bpm,
           raw_json = excluded.raw_json,
           imported_at = excluded.imported_at,
           updated_at = excluded.updated_at`,
      ).bind(
        secureUuid(),
        connection.user_id,
        SHORTCUT_PROVIDER,
        sourceRecordId,
        workout.workoutType,
        workout.startAt,
        workout.endAt,
        workout.durationMinutes,
        workout.activeEnergyKcal ?? null,
        workout.distanceKm ?? null,
        workout.averageHeartRateBpm ?? null,
        workout.maxHeartRateBpm ?? null,
        JSON.stringify(workout),
        now,
        now,
      ),
    );
  }

  statements.push(
    context.env.DB.prepare(
      `UPDATE health_shortcut_connections
          SET status = 'active',
              last_successful_sync_at = ?,
              last_error_code = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).bind(now, now, connection.id),
  );

  await context.env.DB.batch(statements);

  return context.json({
    ok: true,
    importedDailySummaries: 1,
    importedWorkouts: workouts.length,
    syncedAt: now,
  });
});

garminRoutes.get("/status", requireAuth, async (context) => {
  const userId = context.get("user").id;
  const [officialConnection, shortcutConnection, latestDaily, recentWorkouts] = await Promise.all([
    context.env.DB.prepare(
      `SELECT status, last_successful_sync_at, last_error_code, updated_at
           FROM garmin_connections
          WHERE user_id = ?`,
    )
      .bind(userId)
      .first<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT id, user_id, status, last_successful_sync_at, last_error_code
           FROM health_shortcut_connections
          WHERE user_id = ? AND provider = ? AND revoked_at IS NULL`,
    )
      .bind(userId, SHORTCUT_PROVIDER)
      .first<ShortcutConnection>(),
    context.env.DB.prepare(
      `SELECT local_date, steps, active_energy_kcal, resting_energy_kcal,
                walking_running_distance_km, resting_heart_rate_bpm,
                sleep_minutes, weight_kg, body_fat_percentage, imported_at
           FROM health_daily_summaries
          WHERE owner_user_id = ? AND source = ?
          ORDER BY local_date DESC
          LIMIT 1`,
    )
      .bind(userId, SHORTCUT_PROVIDER)
      .first<DailySummary>(),
    context.env.DB.prepare(
      `SELECT workout_type, start_at, duration_minutes,
                active_energy_kcal, distance_km
           FROM health_workouts
          WHERE owner_user_id = ? AND source = ?
          ORDER BY start_at DESC
          LIMIT 5`,
    )
      .bind(userId, SHORTCUT_PROVIDER)
      .all<WorkoutSummary>(),
  ]);

  const shortcutConfigured = shortcutConnection !== null;
  const shortcutActive = shortcutConnection?.status === "active";

  return context.json({
    enabled: context.env.GARMIN_ENABLED === "true",
    approvedProviderConfigured: Boolean(
      context.env.GARMIN_CLIENT_ID && context.env.GARMIN_CLIENT_SECRET,
    ),
    connection: officialConnection,
    shortcutBridge: {
      configured: shortcutConfigured,
      status: shortcutConnection?.status ?? "not_connected",
      lastSuccessfulSyncAt: shortcutConnection?.last_successful_sync_at ?? null,
      lastErrorCode: shortcutConnection?.last_error_code ?? null,
      importUrl: `${context.env.APP_BASE_URL.replace(/\/$/u, "")}/api/v1/garmin/shortcut/import`,
      latestDaily: latestDaily
        ? {
            localDate: latestDaily.local_date,
            steps: latestDaily.steps,
            activeEnergyKcal: latestDaily.active_energy_kcal,
            restingEnergyKcal: latestDaily.resting_energy_kcal,
            walkingRunningDistanceKm: latestDaily.walking_running_distance_km,
            restingHeartRateBpm: latestDaily.resting_heart_rate_bpm,
            sleepMinutes: latestDaily.sleep_minutes,
            weightKg: latestDaily.weight_kg,
            bodyFatPercentage: latestDaily.body_fat_percentage,
            importedAt: latestDaily.imported_at,
          }
        : null,
      recentWorkouts: recentWorkouts.results.map((workout) => ({
        workoutType: workout.workout_type,
        startAt: workout.start_at,
        durationMinutes: workout.duration_minutes,
        activeEnergyKcal: workout.active_energy_kcal,
        distanceKm: workout.distance_km,
      })),
    },
    messageHe: shortcutActive
      ? "הגשר דרך Apple Health פעיל. הנתונים אינם משנים יעדים תזונתיים אוטומטית."
      : shortcutConfigured
        ? "הגשר דרך Apple Health מוכן ומחכה לסנכרון הראשון מה־Shortcut."
        : "עד לקבלת אישור Garmin אפשר לסנכרן בחינם דרך Apple Health ו־Shortcuts.",
  });
});

garminRoutes.post("/shortcut/token", requireAuth, requireCsrf, async (context) => {
  const userId = context.get("user").id;
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = nowIso();

  await context.env.DB.prepare(
    `INSERT INTO health_shortcut_connections (
       id, user_id, provider, token_hash, status,
       last_successful_sync_at, last_error_code,
       revoked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       token_hash = excluded.token_hash,
       status = 'pending',
       last_error_code = NULL,
       revoked_at = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(secureUuid(), userId, SHORTCUT_PROVIDER, tokenHash, now, now)
    .run();

  return context.json(
    {
      token,
      importUrl: `${context.env.APP_BASE_URL.replace(/\/$/u, "")}/api/v1/garmin/shortcut/import`,
      messageHe: "המפתח מוצג פעם אחת בלבד. שמור אותו בתוך ה־Shortcut ואל תשתף אותו.",
    },
    201,
  );
});

garminRoutes.delete("/shortcut/token", requireAuth, requireCsrf, async (context) => {
  const now = nowIso();
  await context.env.DB.prepare(
    `UPDATE health_shortcut_connections
        SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE user_id = ? AND provider = ? AND revoked_at IS NULL`,
  )
    .bind(now, now, context.get("user").id, SHORTCUT_PROVIDER)
    .run();

  return context.json({ ok: true });
});

garminRoutes.post("/sync", requireAuth, requireCsrf, (context) => {
  if (context.env.GARMIN_ENABLED !== "true" || !context.env.GARMIN_CLIENT_ID) {
    throw new AppError({
      status: 503,
      code: "GARMIN_DISABLED",
      messageHe: "Garmin עדיין לא הופעל. ניתן להשתמש בגשר החינמי דרך Apple Health.",
    });
  }

  throw new AppError({
    status: 501,
    code: "GARMIN_APPROVAL_REQUIRED",
    messageHe: "הסנכרון הרשמי יופעל לאחר אישור Garmin וחיבור Data Feed.",
  });
});
