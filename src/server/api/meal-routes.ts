import { Hono } from "hono";
import { z } from "zod";
import { manualMealSchema } from "../../shared/schemas/api";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { AppError } from "./errors";
import { createManualMeal, loadMealWithItems } from "../services/meal-service";
import { addDaysIso, nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";

export const mealRoutes = new Hono<AppEnv>();
mealRoutes.use("*", requireAuth);

mealRoutes.get("/", async (context) => {
  const date = z.string().date().parse(context.req.query("date"));
  const user = context.get("user");
  const meals = await context.env.DB.prepare(
    `SELECT id, occurred_at, local_date, category, custom_category_name, title, notes, analysis_job_id, favorite,
            total_calories, total_protein_grams, total_carbohydrate_grams, total_fat_grams, total_fiber_grams,
            partial_nutrients_json, version, updated_at
       FROM meals WHERE owner_user_id = ? AND local_date = ? ORDER BY occurred_at`,
  )
    .bind(user.id, date)
    .all<Record<string, unknown>>();
  return context.json({ date, meals: meals.results });
});

mealRoutes.get("/:id", async (context) => {
  const meal = await loadMealWithItems(
    context.env,
    context.get("user").id,
    context.req.param("id"),
  );
  if (!meal)
    throw new AppError({ status: 404, code: "MEAL_NOT_FOUND", messageHe: "הארוחה לא נמצאה" });
  return context.json({ meal });
});

mealRoutes.post("/", requireCsrf, async (context) => {
  const input = manualMealSchema.parse(await context.req.json());
  const existing = await context.env.DB.prepare(
    "SELECT id, local_date FROM meals WHERE owner_user_id = ? AND client_mutation_id = ?",
  )
    .bind(context.get("user").id, input.clientMutationId)
    .first<{ id: string; local_date: string }>();
  if (existing)
    return context.json({
      id: existing.id,
      localDate: existing.local_date,
      idempotentReplay: true,
    });
  const result = await createManualMeal(context.env, context.get("user").id, input);
  return context.json(result, 201);
});

mealRoutes.post("/:id/favorite", requireCsrf, async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const result = await context.env.DB.prepare(
    "UPDATE meals SET favorite = 1, updated_at = ?, updated_by = ? WHERE id = ? AND owner_user_id = ?",
  )
    .bind(nowIso(), user.id, id, user.id)
    .run();
  if (result.meta.changes === 0)
    throw new AppError({ status: 404, code: "MEAL_NOT_FOUND", messageHe: "הארוחה לא נמצאה" });
  await context.env.DB.prepare(
    "INSERT OR IGNORE INTO favorite_meals (user_id, meal_id, created_at) VALUES (?, ?, ?)",
  )
    .bind(user.id, id, nowIso())
    .run();
  return context.json({ ok: true });
});

mealRoutes.post("/:id/duplicate", requireCsrf, async (context) => {
  const source = await loadMealWithItems(
    context.env,
    context.get("user").id,
    context.req.param("id"),
  );
  if (!source)
    throw new AppError({ status: 404, code: "MEAL_NOT_FOUND", messageHe: "הארוחה לא נמצאה" });
  const input = z
    .object({ occurredAt: z.string().datetime(), clientMutationId: z.string().uuid() })
    .parse(await context.req.json());
  const sourceItems = Array.isArray(source.items) ? source.items : [];
  const items = sourceItems.map((item) => {
    if (typeof item !== "object" || item === null)
      throw new AppError({
        status: 500,
        code: "SNAPSHOT_INVALID",
        messageHe: "לא ניתן לשכפל את הארוחה",
      });
    const snapshot: unknown = Reflect.get(item, "source_snapshot_json") as unknown;
    const parsed: unknown = typeof snapshot === "string" ? JSON.parse(snapshot) : null;
    return z
      .object({
        nameHe: z.string(),
        quantity: z.number(),
        unit: z.string(),
        grams: z.number().nullable(),
        calories: z.number().nullable(),
        proteinGrams: z.number().nullable(),
        carbohydrateGrams: z.number().nullable(),
        fatGrams: z.number().nullable(),
        fiberGrams: z.number().nullable(),
        sourceType: z.enum(["label", "database", "manual", "ai_estimate"]),
      })
      .parse(parsed);
  });
  const created = await createManualMeal(context.env, context.get("user").id, {
    clientMutationId: input.clientMutationId,
    occurredAt: input.occurredAt,
    category: z
      .enum(["breakfast", "lunch", "dinner", "snack", "drink", "custom"])
      .parse(source.category),
    customCategoryName:
      typeof source.custom_category_name === "string" ? source.custom_category_name : null,
    title: typeof source.title === "string" ? source.title : "ארוחה קודמת",
    notes: typeof source.notes === "string" ? source.notes : null,
    items,
  });
  return context.json(created, 201);
});

mealRoutes.delete("/:id", requireCsrf, async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const snapshot = await loadMealWithItems(context.env, user.id, id);
  if (!snapshot)
    throw new AppError({ status: 404, code: "MEAL_NOT_FOUND", messageHe: "הארוחה לא נמצאה" });
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO meal_revisions (id, meal_id, previous_snapshot_json, new_snapshot_json, revision_source, reason, expires_at, created_at) VALUES (?, ?, ?, '{}', 'user', 'delete', ?, ?)",
    ).bind(secureUuid(), id, JSON.stringify(snapshot), addDaysIso(7), nowIso()),
    context.env.DB.prepare("DELETE FROM meals WHERE id = ? AND owner_user_id = ?").bind(
      id,
      user.id,
    ),
  ]);
  return context.json({ ok: true });
});
