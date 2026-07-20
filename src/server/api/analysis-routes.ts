import { Hono } from "hono";
import { z } from "zod";
import { manualMealSchema } from "../../shared/schemas/api";
import type { MealAnalysisResult } from "../../shared/schemas/meal-analysis";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { AppError } from "./errors";
import { addDaysIso, nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { createManualMeal } from "../services/meal-service";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const analysisRoutes = new Hono<AppEnv>();
analysisRoutes.use("*", requireAuth);

analysisRoutes.post("/jobs", requireCsrf, async (context) => {
  const input = z
    .object({
      clientMutationId: z.string().uuid(),
      jobType: z.enum(["meal", "label"]).default("meal"),
    })
    .parse(await context.req.json());
  const user = context.get("user");
  const existing = await context.env.DB.prepare(
    "SELECT id, status FROM analysis_jobs WHERE owner_user_id = ? AND client_mutation_id = ?",
  )
    .bind(user.id, input.clientMutationId)
    .first<{ id: string; status: string }>();
  if (existing)
    return context.json({ jobId: existing.id, status: existing.status, idempotentReplay: true });
  const jobId = secureUuid();
  const now = nowIso();
  await context.env.DB.prepare(
    "INSERT INTO analysis_jobs (id, owner_user_id, job_type, status, client_mutation_id, created_at, updated_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?)",
  )
    .bind(jobId, user.id, input.jobType, input.clientMutationId, now, now)
    .run();
  return context.json({ jobId, status: "uploading" }, 201);
});

analysisRoutes.post("/jobs/text", requireCsrf, async (context) => {
  const input = z
    .object({
      clientMutationId: z.string().uuid(),
      text: z.string().trim().min(2).max(2_000),
    })
    .parse(await context.req.json());
  const user = context.get("user");
  const existing = await context.env.DB.prepare(
    "SELECT id, status FROM analysis_jobs WHERE owner_user_id = ? AND client_mutation_id = ?",
  )
    .bind(user.id, input.clientMutationId)
    .first<{ id: string; status: string }>();
  if (existing) {
    return context.json({
      jobId: existing.id,
      status: existing.status,
      idempotentReplay: true,
    });
  }

  const jobId = secureUuid();
  const now = nowIso();
  await context.env.DB.prepare(
    "INSERT INTO analysis_jobs (id, owner_user_id, job_type, status, client_mutation_id, created_at, updated_at) VALUES (?, ?, 'meal', 'queued', ?, ?, ?)",
  )
    .bind(jobId, user.id, input.clientMutationId, now, now)
    .run();

  try {
    const instance = await context.env.MEAL_ANALYSIS.create({
      id: jobId,
      params: { jobId, userId: user.id, mealText: input.text },
    });
    await context.env.DB.prepare(
      "UPDATE analysis_jobs SET workflow_instance_id = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
    )
      .bind(instance.id, nowIso(), jobId, user.id)
      .run();
  } catch {
    await context.env.DB.prepare(
      "UPDATE analysis_jobs SET status = 'failed', error_code = 'TEXT_ANALYSIS_START_FAILED', error_message_he = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
    )
      .bind("לא הצלחנו להתחיל את ניתוח הטקסט. אפשר לנסות שוב.", nowIso(), jobId, user.id)
      .run();
    throw new AppError({
      status: 503,
      code: "TEXT_ANALYSIS_START_FAILED",
      messageHe: "לא הצלחנו להתחיל את ניתוח הטקסט. אפשר לנסות שוב.",
    });
  }

  return context.json({ jobId, status: "queued" }, 202);
});

analysisRoutes.post("/jobs/manual", requireCsrf, async (context) => {
  const input = z.object({ clientMutationId: z.string().uuid() }).parse(await context.req.json());
  const user = context.get("user");
  const existing = await context.env.DB.prepare(
    "SELECT id, status FROM analysis_jobs WHERE owner_user_id = ? AND client_mutation_id = ?",
  )
    .bind(user.id, input.clientMutationId)
    .first<{ id: string; status: string }>();
  if (existing) {
    return context.json({
      jobId: existing.id,
      status: existing.status,
      idempotentReplay: true,
    });
  }

  const jobId = secureUuid();
  const now = nowIso();
  const result = manualEntryResult();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO analysis_jobs (id, owner_user_id, job_type, status, client_mutation_id, overall_confidence, analysis_version, completed_at, created_at, updated_at) VALUES (?, ?, 'meal', 'needs_user_input', ?, 'high', 'manual-entry-v1', ?, ?, ?)",
    ).bind(jobId, user.id, input.clientMutationId, now, now, now),
    context.env.DB.prepare(
      "INSERT INTO analysis_results (analysis_job_id, result_json, source_model, model_route, validated, created_at) VALUES (?, ?, NULL, 'disabled', 1, ?)",
    ).bind(jobId, JSON.stringify(result), now),
  ]);

  return context.json({ jobId, status: "needs_user_input" }, 201);
});

analysisRoutes.put("/jobs/:jobId/images/:index", requireCsrf, async (context) => {
  const user = context.get("user");
  const jobId = z.string().uuid().parse(context.req.param("jobId"));
  const imageIndex = z.coerce.number().int().min(0).max(3).parse(context.req.param("index"));
  const job = await context.env.DB.prepare(
    "SELECT status FROM analysis_jobs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(jobId, user.id)
    .first<{ status: string }>();
  if (!job)
    throw new AppError({ status: 404, code: "ANALYSIS_NOT_FOUND", messageHe: "הניתוח לא נמצא" });
  if (!["uploading", "queued", "failed"].includes(job.status)) {
    throw new AppError({
      status: 409,
      code: "ANALYSIS_ALREADY_STARTED",
      messageHe: "הניתוח כבר התחיל ולא ניתן להחליף תמונות",
    });
  }
  const contentType = (context.req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new AppError({
      status: 415,
      code: "IMAGE_TYPE_INVALID",
      messageHe: "אפשר להעלות תמונת JPEG, PNG או WebP",
    });
  }
  const declaredLength = Number(context.req.header("content-length") ?? "0");
  if (declaredLength > MAX_IMAGE_BYTES)
    throw new AppError({
      status: 413,
      code: "IMAGE_TOO_LARGE",
      messageHe: "התמונה גדולה מדי. נסה לצלם מחדש.",
    });
  const bytes = await context.req.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError({
      status: 413,
      code: "IMAGE_TOO_LARGE",
      messageHe: "התמונה ריקה או גדולה מדי. נסה לצלם מחדש.",
    });
  }
  if (!matchesFileSignature(new Uint8Array(bytes), contentType)) {
    throw new AppError({
      status: 415,
      code: "IMAGE_SIGNATURE_INVALID",
      messageHe: "הקובץ אינו תמונה תקינה",
    });
  }
  const mediaId = secureUuid();
  const objectKey = `private/${user.id}/${jobId}/${mediaId}`;
  const now = nowIso();
  const expiresAt = addDaysIso(Number(context.env.IMAGE_RETENTION_DAYS));
  await context.env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType },
    customMetadata: { ownerUserId: user.id, analysisJobId: jobId, logicalExpiresAt: expiresAt },
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO media_objects (id, owner_user_id, r2_object_key, media_type, content_type, size_bytes, uploaded_at, logical_expires_at) VALUES (?, ?, ?, 'analysis_image', ?, ?, ?, ?)",
    ).bind(mediaId, user.id, objectKey, contentType, bytes.byteLength, now, expiresAt),
    context.env.DB.prepare(
      `INSERT INTO analysis_job_images (analysis_job_id, media_object_id, image_order) VALUES (?, ?, ?)
       ON CONFLICT(analysis_job_id, image_order) DO UPDATE SET media_object_id = excluded.media_object_id`,
    ).bind(jobId, mediaId, imageIndex),
  ]);
  return context.json({ ok: true, mediaId, imageIndex });
});

analysisRoutes.post("/jobs/:jobId/start", requireCsrf, async (context) => {
  const user = context.get("user");
  const jobId = z.string().uuid().parse(context.req.param("jobId"));
  const job = await context.env.DB.prepare(
    "SELECT status, (SELECT COUNT(*) FROM analysis_job_images WHERE analysis_job_id = analysis_jobs.id) AS image_count FROM analysis_jobs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(jobId, user.id)
    .first<{ status: string; image_count: number }>();
  if (!job)
    throw new AppError({ status: 404, code: "ANALYSIS_NOT_FOUND", messageHe: "הניתוח לא נמצא" });
  if (job.image_count < 1)
    throw new AppError({
      status: 400,
      code: "IMAGE_REQUIRED",
      messageHe: "צריך להוסיף לפחות תמונה אחת",
    });
  if (["processing", "completed", "needs_user_input"].includes(job.status))
    return context.json({ jobId, status: job.status, idempotentReplay: true });

  const instance = await context.env.MEAL_ANALYSIS.create({
    id: jobId,
    params: { jobId, userId: user.id },
  });
  await context.env.DB.prepare(
    "UPDATE analysis_jobs SET status = 'queued', workflow_instance_id = ?, error_code = NULL, error_message_he = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?",
  )
    .bind(instance.id, nowIso(), jobId, user.id)
    .run();
  return context.json({ jobId, status: "queued" }, 202);
});

analysisRoutes.get("/jobs/:jobId", async (context) => {
  const user = context.get("user");
  const jobId = z.string().uuid().parse(context.req.param("jobId"));
  const job = await context.env.DB.prepare(
    "SELECT id, job_type, status, overall_confidence, error_code, error_message_he, analysis_version, created_at, updated_at, completed_at FROM analysis_jobs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(jobId, user.id)
    .first<Record<string, unknown>>();
  if (!job)
    throw new AppError({ status: 404, code: "ANALYSIS_NOT_FOUND", messageHe: "הניתוח לא נמצא" });
  const result = await context.env.DB.prepare(
    "SELECT result_json, source_model, model_route FROM analysis_results WHERE analysis_job_id = ?",
  )
    .bind(jobId)
    .first<{ result_json: string; source_model: string | null; model_route: string }>();
  return context.json({
    job,
    result: result ? (JSON.parse(result.result_json) as unknown) : null,
    model: result?.source_model ?? null,
    modelRoute: result?.model_route ?? null,
  });
});

analysisRoutes.post("/jobs/:jobId/confirm", requireCsrf, async (context) => {
  const user = context.get("user");
  const jobId = z.string().uuid().parse(context.req.param("jobId"));
  const input = manualMealSchema.parse(await context.req.json());
  const job = await context.env.DB.prepare(
    "SELECT status FROM analysis_jobs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(jobId, user.id)
    .first<{ status: string }>();
  if (!job)
    throw new AppError({ status: 404, code: "ANALYSIS_NOT_FOUND", messageHe: "הניתוח לא נמצא" });
  if (!["needs_user_input", "completed"].includes(job.status)) {
    throw new AppError({
      status: 409,
      code: "ANALYSIS_NOT_READY",
      messageHe: "הניתוח עדיין לא מוכן לשמירה",
    });
  }
  const meal = await createManualMeal(context.env, user.id, input);
  await context.env.DB.prepare(
    "UPDATE meals SET analysis_job_id = ? WHERE id = ? AND owner_user_id = ?",
  )
    .bind(jobId, meal.id, user.id)
    .run();
  await context.env.DB.prepare(
    "UPDATE analysis_jobs SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ? AND owner_user_id = ?",
  )
    .bind(nowIso(), nowIso(), jobId, user.id)
    .run();
  return context.json({ mealId: meal.id, localDate: meal.localDate }, 201);
});

analysisRoutes.post("/jobs/:jobId/retry", requireCsrf, async (context) => {
  const user = context.get("user");
  const jobId = z.string().uuid().parse(context.req.param("jobId"));
  const job = await context.env.DB.prepare(
    "SELECT workflow_instance_id, status FROM analysis_jobs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(jobId, user.id)
    .first<{ workflow_instance_id: string | null; status: string }>();
  if (!job)
    throw new AppError({ status: 404, code: "ANALYSIS_NOT_FOUND", messageHe: "הניתוח לא נמצא" });
  if (job.status !== "failed")
    throw new AppError({
      status: 409,
      code: "RETRY_NOT_ALLOWED",
      messageHe: "אין צורך לנסות שוב כרגע",
    });
  if (job.workflow_instance_id) {
    const instance = await context.env.MEAL_ANALYSIS.get(job.workflow_instance_id);
    await instance.restart();
  } else {
    await context.env.MEAL_ANALYSIS.create({ id: jobId, params: { jobId, userId: user.id } });
  }
  await context.env.DB.prepare(
    "UPDATE analysis_jobs SET status = 'queued', retry_count = retry_count + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?",
  )
    .bind(nowIso(), jobId, user.id)
    .run();
  return context.json({ jobId, status: "queued" }, 202);
});

function manualEntryResult(): MealAnalysisResult {
  return {
    analysisVersion: "manual-entry-v1",
    detectedItems: [
      {
        temporaryId: secureUuid(),
        candidateNameHe: "רכיב להזנה",
        estimatedQuantity: null,
        estimatedUnit: null,
        estimatedGrams: null,
        foodIdentityConfidence: "high",
        quantityConfidence: "high",
        nutritionConfidence: "high",
        plausibleCaloriesMin: null,
        plausibleCaloriesMax: null,
        notes: [],
      },
    ],
    overallConfidence: "high",
    clarificationQuestions: [],
    needsAnotherImage: false,
  };
}

function matchesFileSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png")
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === "image/webp") {
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  return false;
}
