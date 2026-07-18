import type { z } from "zod";
import type { manualMealSchema } from "../../shared/schemas/api";
import { sumNutrients } from "../../shared/nutrition/totals";
import type { NullableNutrients } from "../../shared/nutrition/totals";
import type { RuntimeEnv } from "../context";
import { localDateFromIso } from "../domain/time";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";

type ManualMealInput = z.infer<typeof manualMealSchema>;

export async function createManualMeal(
  env: RuntimeEnv,
  userId: string,
  input: ManualMealInput,
): Promise<{ id: string; localDate: string }> {
  const user = await env.DB.prepare(
    "SELECT timezone FROM users WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(userId)
    .first<{ timezone: string }>();
  const timezone = user?.timezone ?? "Asia/Jerusalem";
  const localDate = localDateFromIso(input.occurredAt, timezone);
  const totals = sumNutrients(
    input.items.map<NullableNutrients>((item) => ({
      calories: item.calories,
      proteinGrams: item.proteinGrams,
      carbohydrateGrams: item.carbohydrateGrams,
      fatGrams: item.fatGrams,
      fiberGrams: item.fiberGrams,
      sugarGrams: null,
      sodiumMilligrams: null,
    })),
  );
  const mealId = secureUuid();
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO meals (
        id, owner_user_id, occurred_at, local_date, category, custom_category_name, title, notes,
        total_calories, total_protein_grams, total_carbohydrate_grams, total_fat_grams, total_fiber_grams,
        partial_nutrients_json, client_mutation_id, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      mealId,
      userId,
      input.occurredAt,
      localDate,
      input.category,
      input.customCategoryName ?? null,
      input.title,
      input.notes ?? null,
      totals.calories,
      totals.proteinGrams,
      totals.carbohydrateGrams,
      totals.fatGrams,
      totals.fiberGrams,
      JSON.stringify(totals.partialNutrients),
      input.clientMutationId,
      userId,
      now,
      now,
    ),
  ];

  input.items.forEach((item, index) => {
    const itemId = secureUuid();
    statements.push(
      env.DB.prepare(
        `INSERT INTO meal_items (
          id, meal_id, name_he, quantity, unit, grams, source_type, source_snapshot_json, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        itemId,
        mealId,
        item.nameHe,
        item.quantity,
        item.unit,
        item.grams,
        item.sourceType,
        JSON.stringify(item),
        index,
        now,
      ),
    );
    const nutrients: Array<[string, number | null, string]> = [
      ["energy_kcal", item.calories, "kcal"],
      ["protein", item.proteinGrams, "g"],
      ["carbohydrate", item.carbohydrateGrams, "g"],
      ["fat", item.fatGrams, "g"],
      ["fiber", item.fiberGrams, "g"],
    ];
    for (const [code, value, unit] of nutrients) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO meal_item_nutrients (id, meal_item_id, nutrient_code, value, unit, source_type, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(secureUuid(), itemId, code, value, unit, item.sourceType, value === null ? 1 : 0),
      );
    }
  });

  await env.DB.batch(statements);
  return { id: mealId, localDate };
}

export async function loadMealWithItems(
  env: RuntimeEnv,
  userId: string,
  mealId: string,
): Promise<Record<string, unknown> | null> {
  const meal = await env.DB.prepare("SELECT * FROM meals WHERE id = ? AND owner_user_id = ?")
    .bind(mealId, userId)
    .first<Record<string, unknown>>();
  if (!meal) return null;
  const items = await env.DB.prepare(
    "SELECT * FROM meal_items WHERE meal_id = ? ORDER BY sort_order",
  )
    .bind(mealId)
    .all<Record<string, unknown>>();
  return { ...meal, items: items.results };
}
