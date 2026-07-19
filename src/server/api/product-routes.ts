import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { scanProductLabel } from "../ai/product-label-scanner";
import { requireHouseholdId } from "../domain/authorization";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { AppError } from "./errors";

const MAX_LABEL_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

const PRODUCT_NUTRIENT_PROJECTION = `
  (SELECT fn.normalized_value FROM food_nutrients fn
    WHERE fn.food_id = f.id AND fn.nutrient_code = 'energy_kcal'
    ORDER BY fn.created_at DESC LIMIT 1) AS energy_kcal,
  (SELECT fn.normalized_value FROM food_nutrients fn
    WHERE fn.food_id = f.id AND fn.nutrient_code = 'protein'
    ORDER BY fn.created_at DESC LIMIT 1) AS protein,
  (SELECT fn.normalized_value FROM food_nutrients fn
    WHERE fn.food_id = f.id AND fn.nutrient_code = 'carbohydrate'
    ORDER BY fn.created_at DESC LIMIT 1) AS carbohydrate,
  (SELECT fn.normalized_value FROM food_nutrients fn
    WHERE fn.food_id = f.id AND fn.nutrient_code = 'fat'
    ORDER BY fn.created_at DESC LIMIT 1) AS fat,
  (SELECT fn.normalized_value FROM food_nutrients fn
    WHERE fn.food_id = f.id AND fn.nutrient_code = 'fiber'
    ORDER BY fn.created_at DESC LIMIT 1) AS fiber,
  COALESCE((SELECT fn.base_quantity FROM food_nutrients fn
    WHERE fn.food_id = f.id ORDER BY fn.created_at DESC LIMIT 1), 100) AS base_quantity,
  COALESCE((SELECT fn.base_unit FROM food_nutrients fn
    WHERE fn.food_id = f.id ORDER BY fn.created_at DESC LIMIT 1), 'g') AS base_unit,
  COALESCE((SELECT fs.source_type FROM food_sources fs
    WHERE fs.food_id = f.id ORDER BY fs.created_at DESC LIMIT 1), 'manual') AS source_type`;

export const productRoutes = new Hono<AppEnv>();
productRoutes.use("*", requireAuth);

productRoutes.get("/", async (context) => {
  const user = context.get("user");
  const rows = await context.env.DB.prepare(
    `SELECT f.id, f.canonical_name_he, f.canonical_name_en, f.brand, f.updated_at,
            fb.barcode, ${PRODUCT_NUTRIENT_PROJECTION}
       FROM foods f
       LEFT JOIN food_barcodes fb ON fb.food_id = f.id
      WHERE f.owner_household_id = ?
      ORDER BY f.updated_at DESC, f.canonical_name_he
      LIMIT 100`,
  )
    .bind(user.householdId)
    .all<Record<string, unknown>>();
  return context.json({ products: rows.results });
});

productRoutes.get("/search", async (context) => {
  const user = context.get("user");
  const query = z.string().trim().min(1).max(100).parse(context.req.query("q"));
  const like = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = await context.env.DB.prepare(
    `SELECT f.id, f.canonical_name_he, f.canonical_name_en, f.brand, f.is_shared,
            fb.barcode, ${PRODUCT_NUTRIENT_PROJECTION},
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
    `SELECT f.id, f.canonical_name_he, f.canonical_name_en, f.brand, fb.barcode,
            ${PRODUCT_NUTRIENT_PROJECTION}
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

productRoutes.post("/label/scan", requireCsrf, async (context) => {
  const contentType = (context.req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new AppError({
      status: 415,
      code: "LABEL_IMAGE_TYPE_INVALID",
      messageHe: "אפשר לצלם תווית בפורמט JPEG, PNG או WebP",
    });
  }
  const declaredLength = Number(context.req.header("content-length") ?? "0");
  if (declaredLength > MAX_LABEL_IMAGE_BYTES) {
    throw new AppError({
      status: 413,
      code: "LABEL_IMAGE_TOO_LARGE",
      messageHe: "התמונה גדולה מדי. נסה לצלם מחדש.",
    });
  }
  const bytes = await context.req.arrayBuffer();
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_LABEL_IMAGE_BYTES ||
    !matchesImageSignature(new Uint8Array(bytes), contentType)
  ) {
    throw new AppError({
      status: 415,
      code: "LABEL_IMAGE_INVALID",
      messageHe: "לא הצלחנו לקרוא את קובץ התמונה",
    });
  }
  try {
    const scan = await scanProductLabel({
      env: context.env,
      contentType,
      bytes,
      correlationId: context.get("correlationId"),
    });
    return context.json({ scan });
  } catch {
    throw new AppError({
      status: 502,
      code: "LABEL_SCAN_FAILED",
      messageHe: "לא הצלחנו לקרוא את התווית אוטומטית. אפשר למלא את הערכים ידנית.",
      retryable: true,
    });
  }
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

function matchesImageSignature(bytes: Uint8Array, contentType: string): boolean {
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
