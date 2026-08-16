import { Hono } from "hono";
import { z } from "zod";
import { manualMealSchema, mealUpdateSchema } from "../../shared/schemas/api";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { AppError } from "./errors";
import { createManualMeal, loadMealWithItems, updateManualMeal } from "../services/meal-service";
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

mealRoutes.patch("/:id", requireCsrf, async (context) => {
  const input = mealUpdateSchema.parse(await context.req.json());
  const updated = await updateManualMeal(
    context.env,
    context.get("user").id,
    context.req.param("id"),
    input,
  );
  if (!updated) {
    throw new AppError({ status: 404, code: "MEAL_NOT_FOUND", messageHe: "הארוחה לא נמצאה" });
  }
  return context.json(updated);
});

mealRoutes.post("/merge", requireCsrf, async (context) => {
  const user = context.get("user");
  const input = z
    .object({
      mealIds: z
        .array(z.string().uuid())
        .min(2)
        .max(10)
        .refine((mealIds) => new Set(mealIds).size === mealIds.length, {
          message: "יש לבחור ארוחות שונות לאיחוד",
        }),
    })
    .parse(await context.req.json());

  const snapshots = await Promise.all(
    input.mealIds.map((mealId) => loadMealWithItems(context.env, user.id, mealId)),
  );

  if (snapshots.some((meal) => meal === null)) {
    throw new AppError({
      status: 404,
      code: "MEAL_NOT_FOUND",
      messageHe: "אחת הארוחות שנבחרו לא נמצאה",
    });
  }

  const sourceMeals = snapshots.filter((meal): meal is Record<string, unknown> => meal !== null);
  const localDates = new Set(
    sourceMeals.map((meal) => (typeof meal.local_date === "string" ? meal.local_date : "")),
  );

  if (localDates.size !== 1 || localDates.has("")) {
    throw new AppError({
      status: 400,
      code: "MEALS_MUST_SHARE_DATE",
      messageHe: "אפשר לאחד רק ארוחות מאותו יום",
    });
  }

  sourceMeals.sort(
    (left, right) =>
      Date.parse(String(left.occurred_at ?? "")) - Date.parse(String(right.occurred_at ?? "")),
  );

  const target = sourceMeals[0];
  if (!target) {
    throw new AppError({
      status: 400,
      code: "MERGE_MEALS_EMPTY",
      messageHe: "לא נבחרו ארוחות לאיחוד",
    });
  }

  const itemSchema = manualMealSchema.shape.items.element;
  const mergedItems: Array<z.infer<typeof itemSchema>> = [];

  for (const meal of sourceMeals) {
    const items = Array.isArray(meal.items) ? meal.items : [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) {
        throw new AppError({
          status: 500,
          code: "MEAL_SNAPSHOT_INVALID",
          messageHe: "לא הצלחנו לקרוא את רכיבי אחת הארוחות",
        });
      }

      const rawSnapshot: unknown = Reflect.get(item, "source_snapshot_json");
      if (typeof rawSnapshot !== "string") {
        throw new AppError({
          status: 500,
          code: "MEAL_SNAPSHOT_INVALID",
          messageHe: "לא הצלחנו לקרוא את רכיבי אחת הארוחות",
        });
      }

      try {
        mergedItems.push(itemSchema.parse(JSON.parse(rawSnapshot) as unknown));
      } catch {
        throw new AppError({
          status: 500,
          code: "MEAL_SNAPSHOT_INVALID",
          messageHe: "לא הצלחנו לקרוא את רכיבי אחת הארוחות",
        });
      }
    }
  }

  if (mergedItems.length === 0 || mergedItems.length > 50) {
    throw new AppError({
      status: 400,
      code: "MERGED_MEAL_ITEMS_INVALID",
      messageHe:
        mergedItems.length > 50
          ? "יש יותר מדי רכיבים בארוחות שנבחרו. אפשר לאחד עד 50 רכיבים."
          : "אין רכיבים שאפשר לאחד",
    });
  }

  const titles = [
    ...new Set(
      sourceMeals
        .map((meal) => (typeof meal.title === "string" ? meal.title.trim() : ""))
        .filter(Boolean),
    ),
  ];
  const mergedTitle = titles.join(" + ").slice(0, 160) || "ארוחה מאוחדת";

  const notes = [
    ...new Set(
      sourceMeals
        .map((meal) => (typeof meal.notes === "string" ? meal.notes.trim() : ""))
        .filter(Boolean),
    ),
  ];
  const mergedNotes = notes.length > 0 ? notes.join("\n").slice(0, 1_000) : null;

  const targetId = z.string().uuid().parse(target.id);
  const updated = await updateManualMeal(context.env, user.id, targetId, {
    occurredAt: manualMealSchema.shape.occurredAt.parse(target.occurred_at),
    category: manualMealSchema.shape.category.parse(target.category),
    customCategoryName:
      typeof target.custom_category_name === "string" ? target.custom_category_name : null,
    title: mergedTitle,
    notes: mergedNotes,
    items: mergedItems,
  });

  if (!updated) {
    throw new AppError({
      status: 404,
      code: "MEAL_NOT_FOUND",
      messageHe: "הארוחה לא נמצאה",
    });
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  for (const source of sourceMeals.slice(1)) {
    const sourceId = z.string().uuid().parse(source.id);
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO meal_revisions (id, meal_id, previous_snapshot_json, new_snapshot_json, revision_source, reason, expires_at, created_at) VALUES (?, ?, ?, ?, 'user', 'delete', ?, ?)",
      ).bind(
        secureUuid(),
        sourceId,
        JSON.stringify(source),
        JSON.stringify({ mergedIntoMealId: targetId }),
        addDaysIso(7),
        now,
      ),
      context.env.DB.prepare("DELETE FROM meals WHERE id = ? AND owner_user_id = ?").bind(
        sourceId,
        user.id,
      ),
    );
  }

  if (statements.length > 0) {
    await context.env.DB.batch(statements);
  }

  return context.json({
    ok: true,
    id: targetId,
    localDate: updated.localDate,
    mergedMeals: sourceMeals.length,
  });
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
