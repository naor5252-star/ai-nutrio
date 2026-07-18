import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { requireHouseholdId } from "../domain/authorization";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { AppError } from "./errors";

const nutrientInputSchema = z.object({
  nutrientCode: z.string().min(1).max(80),
  normalizedValue: z.number().finite().nonnegative().nullable(),
  normalizedUnit: z.string().min(1).max(30),
  originalDisplayValue: z.string().max(80).nullable().optional(),
});

const productInputSchema = z.object({
  nameHe: z.string().trim().min(1).max(160),
  nameEn: z.string().trim().max(160).nullable().optional(),
  brand: z.string().trim().max(120).nullable().optional(),
  barcode: z
    .string()
    .regex(/^\d{8,14}$/u)
    .nullable()
    .optional(),
  baseQuantity: z.number().finite().positive().max(10_000).default(100),
  baseUnit: z.enum(["g", "ml"]),
  servingDescriptionHe: z.string().trim().max(120).nullable().optional(),
  servingWeight: z.number().finite().positive().max(10_000).nullable().optional(),
  sourceType: z.enum(["label", "manual"]),
  nutrients: z.array(nutrientInputSchema).min(1).max(100),
});

export const productRoutes = new Hono<AppEnv>();
productRoutes.use("*", requireAuth);

productRoutes.get("/search", async (context) => {
  const user = context.get("user");
  const query = z.string().trim().min(1).max(100).parse(context.req.query("q"));
  const like = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = await context.env.DB.prepare(
    `SELECT f.id, f.canonical_name_he, f.canonical_name_en, f.brand, f.is_shared,
            fb.barcode,
            CASE WHEN EXISTS (SELECT 1 FROM food_usage_history h WHERE h.user_id = ? AND h.food_id = f.id) THEN 0
                 WHEN f.owner_household_id = ? THEN 1 ELSE 2 END AS rank_group
       FROM foods f
       LEFT JOIN food_barcodes fb ON fb.food_id = f.id
      WHERE (f.owner_household_id IS NULL OR f.owner_household_id = ?)
        AND (f.canonical_name_he LIKE ? ESCAPE '\\' OR f.canonical_name_en LIKE ? ESCAPE '\\' OR f.brand LIKE ? ESCAPE '\\' OR fb.barcode = ?)
      ORDER BY rank_group, f.canonical_name_he
      LIMIT 40`,
  )
    .bind(user.id, user.householdId, user.householdId, like, like, like, query)
    .all<Record<string, unknown>>();
  return context.json({ results: rows.results });
});

productRoutes.get("/barcode/:barcode", async (context) => {
  const barcode = z
    .string()
    .regex(/^\d{8,14}$/u)
    .parse(context.req.param("barcode"));
  const user = context.get("user");
  const product = await context.env.DB.prepare(
    `SELECT f.id, f.canonical_name_he, f.canonical_name_en, f.brand, fb.barcode
       FROM food_barcodes fb JOIN foods f ON f.id = fb.food_id
      WHERE fb.barcode = ? AND (f.owner_household_id IS NULL OR f.owner_household_id = ?)`,
  )
    .bind(barcode, user.householdId)
    .first<Record<string, unknown>>();
  if (!product)
    throw new AppError({
      status: 404,
      code: "BARCODE_NOT_FOUND",
      messageHe: "המוצר עדיין לא נמצא. אפשר לצלם תווית או ליצור אותו ידנית.",
    });
  const nutrients = await context.env.DB.prepare(
    `SELECT fn.nutrient_code, fn.normalized_value, fn.normalized_unit, fn.base_quantity, fn.base_unit,
            fn.original_display_value, fs.source_type
       FROM food_nutrients fn JOIN food_sources fs ON fs.id = fn.source_id
      WHERE fn.food_id = ?
      ORDER BY CASE fs.source_type WHEN 'label' THEN 0 WHEN 'database' THEN 1 WHEN 'manual' THEN 2 ELSE 3 END`,
  )
    .bind(product.id)
    .all<Record<string, unknown>>();
  return context.json({ product, nutrients: nutrients.results });
});

productRoutes.post("/", requireCsrf, async (context) => {
  const input = productInputSchema.parse(await context.req.json());
  const user = context.get("user");
  const householdId = requireHouseholdId(user.householdId);
  if (input.barcode) {
    const existing = await context.env.DB.prepare(
      "SELECT food_id FROM food_barcodes WHERE barcode = ?",
    )
      .bind(input.barcode)
      .first<{ food_id: string }>();
    if (existing)
      throw new AppError({
        status: 409,
        code: "BARCODE_EXISTS",
        messageHe: "כבר קיים מוצר עם הברקוד הזה",
      });
  }
  const foodId = secureUuid();
  const sourceId = secureUuid();
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      "INSERT INTO foods (id, canonical_name_he, canonical_name_en, brand, owner_household_id, creator_user_id, is_shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    ).bind(
      foodId,
      input.nameHe,
      input.nameEn ?? null,
      input.brand ?? null,
      householdId,
      user.id,
      now,
      now,
    ),
    context.env.DB.prepare(
      "INSERT INTO food_sources (id, food_id, source_type, provider_name, raw_snapshot_json, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
    ).bind(sourceId, foodId, input.sourceType, JSON.stringify(input), now),
    context.env.DB.prepare(
      "INSERT INTO household_food_ownership (food_id, household_id, creator_user_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(foodId, householdId, user.id, now),
  ];
  if (input.barcode) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO food_barcodes (barcode, food_id, source_type, confirmed_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(input.barcode, foodId, input.sourceType, user.id, now),
    );
  }
  if (input.servingDescriptionHe && input.servingWeight) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO food_servings (id, food_id, description_he, quantity, unit, grams_or_ml, source_type, created_at) VALUES (?, ?, ?, 1, 'serving', ?, ?, ?)",
      ).bind(
        secureUuid(),
        foodId,
        input.servingDescriptionHe,
        input.servingWeight,
        input.sourceType,
        now,
      ),
    );
  }
  for (const nutrient of input.nutrients) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO food_nutrients (
          id, food_id, source_id, nutrient_code, normalized_value, normalized_unit, base_quantity, base_unit,
          original_display_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        secureUuid(),
        foodId,
        sourceId,
        nutrient.nutrientCode,
        nutrient.normalizedValue,
        nutrient.normalizedUnit,
        input.baseQuantity,
        input.baseUnit,
        nutrient.originalDisplayValue ?? null,
        now,
      ),
    );
  }
  await context.env.DB.batch(statements);
  return context.json({ id: foodId }, 201);
});

productRoutes.delete("/:id", requireCsrf, async (context) => {
  const user = context.get("user");
  const id = z.string().uuid().parse(context.req.param("id"));
  const ownership = await context.env.DB.prepare(
    "SELECT creator_user_id FROM household_food_ownership WHERE food_id = ?",
  )
    .bind(id)
    .first<{ creator_user_id: string }>();
  if (!ownership || ownership.creator_user_id !== user.id) {
    throw new AppError({
      status: 403,
      code: "CREATOR_REQUIRED",
      messageHe: "רק מי שיצר את המוצר יכול למחוק אותו. אפשר לשכפל ולערוך עותק.",
    });
  }
  await context.env.DB.prepare("DELETE FROM foods WHERE id = ?").bind(id).run();
  return context.json({ ok: true });
});
