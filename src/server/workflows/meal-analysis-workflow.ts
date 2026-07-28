import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  analysisWorkflowParamsSchema,
  type AnalysisWorkflowParams,
  type MealAnalysisResult,
} from "../../shared/schemas/meal-analysis";
import type { RuntimeEnv } from "../context";
import {
  analyzeMealImages,
  analyzeMealText,
  type FoodCatalogEntry,
  type ImageInput,
} from "../ai/model-router";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { logEvent } from "../services/logger";

type ImageReference = { key: string; contentType: string; sizeBytes: number };

export class MealAnalysisWorkflow extends WorkflowEntrypoint<RuntimeEnv, AnalysisWorkflowParams> {
  override async run(
    event: WorkflowEvent<AnalysisWorkflowParams>,
    step: WorkflowStep,
  ): Promise<{ status: string }> {
    const params = analysisWorkflowParamsSchema.parse(event.payload);
    const mealText = params.mealText;
    const startedAt = Date.now();
    try {
      await step.do(
        "validate ownership and start",
        { retries: { limit: 2, delay: "2 seconds", backoff: "linear" } },
        async () => {
          const job = await this.env.DB.prepare(
            "SELECT owner_user_id, status FROM analysis_jobs WHERE id = ?",
          )
            .bind(params.jobId)
            .first<{ owner_user_id: string; status: string }>();
          if (!job || job.owner_user_id !== params.userId)
            throw new Error("Analysis job ownership validation failed");
          if (["cancelled", "expired"].includes(job.status))
            throw new Error("Analysis job cannot be processed");
          await this.env.DB.prepare(
            "UPDATE analysis_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND owner_user_id = ?",
          )
            .bind(nowIso(), params.jobId, params.userId)
            .run();
          return { ok: true };
        },
      );

      const catalog = await step.do("load food catalog for meal analysis", async () =>
        loadFoodCatalog(this.env, params.userId),
      );

      let route: Awaited<ReturnType<typeof analyzeMealImages>>;
      if (mealText) {
        route = await step.do(
          "analyze meal text and validate output",
          {
            retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
            timeout: "3 minutes",
          },
          async () => analyzeMealText(this.env, mealText, catalog),
        );
      } else {
        const references = await step.do("validate R2 references", async () => {
          const rows = await this.env.DB.prepare(
            `SELECT mo.r2_object_key AS key, mo.content_type AS contentType, mo.size_bytes AS sizeBytes
               FROM analysis_job_images aji
               JOIN media_objects mo ON mo.id = aji.media_object_id
              WHERE aji.analysis_job_id = ? AND mo.owner_user_id = ? AND mo.deleted_at IS NULL AND mo.logical_expires_at > ?
              ORDER BY aji.image_order`,
          )
            .bind(params.jobId, params.userId, nowIso())
            .all<ImageReference>();
          if (rows.results.length === 0) throw new Error("No valid images found");
          for (const reference of rows.results) {
            if (reference.sizeBytes > 5 * 1024 * 1024)
              throw new Error("Image exceeds maximum size");
            const head = await this.env.MEDIA.head(reference.key);
            if (!head) throw new Error("R2 image missing");
          }
          return rows.results;
        });

        route = await step.do(
          "analyze images and validate output",
          {
            retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
            timeout: "3 minutes",
          },
          async () => {
            const images: ImageInput[] = [];
            for (const reference of references) {
              const object = await this.env.MEDIA.get(reference.key);
              if (!object) throw new Error("R2 image disappeared during analysis");
              images.push({
                contentType: reference.contentType,
                bytes: await object.arrayBuffer(),
              });
            }
            return analyzeMealImages(this.env, images);
          },
        );
      }

      route = { ...route, result: enrichResultWithCatalog(route.result, catalog) };

      await step.do(
        "persist validated result",
        { retries: { limit: 3, delay: "2 seconds", backoff: "linear" } },
        async () => {
          const now = nowIso();
          const statements: D1PreparedStatement[] = [
            this.env.DB.prepare("DELETE FROM analysis_candidates WHERE analysis_job_id = ?").bind(
              params.jobId,
            ),
            this.env.DB.prepare(
              "DELETE FROM analysis_clarifications WHERE analysis_job_id = ?",
            ).bind(params.jobId),
            this.env.DB.prepare(
              `INSERT INTO analysis_results (analysis_job_id, result_json, source_model, model_route, validated, created_at)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(analysis_job_id) DO UPDATE SET result_json = excluded.result_json, source_model = excluded.source_model,
               model_route = excluded.model_route, validated = 1, created_at = excluded.created_at`,
            ).bind(params.jobId, JSON.stringify(route.result), route.model, route.route, now),
          ];
          route.result.detectedItems.forEach((item, index) => {
            statements.push(
              this.env.DB.prepare(
                `INSERT INTO analysis_candidates (
                id, analysis_job_id, temporary_id, candidate_name_he, candidate_name_en, alternatives_json,
                estimated_quantity, estimated_unit, estimated_grams, identity_confidence, quantity_confidence,
                nutrition_confidence, plausible_calories_min, plausible_calories_max, notes_json, sort_order
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).bind(
                secureUuid(),
                params.jobId,
                item.temporaryId,
                item.candidateNameHe,
                item.candidateNameEn ?? null,
                JSON.stringify(item.alternativeCandidates ?? []),
                item.estimatedQuantity,
                item.estimatedUnit,
                item.estimatedGrams,
                item.foodIdentityConfidence,
                item.quantityConfidence,
                item.nutritionConfidence,
                item.plausibleCaloriesMin,
                item.plausibleCaloriesMax,
                JSON.stringify(item.notes ?? []),
                index,
              ),
            );
          });
          for (const question of route.result.clarificationQuestions ?? []) {
            statements.push(
              this.env.DB.prepare(
                "INSERT INTO analysis_clarifications (id, analysis_job_id, question_he, answer_options_json, created_at) VALUES (?, ?, ?, ?, ?)",
              ).bind(
                secureUuid(),
                params.jobId,
                question.questionHe,
                JSON.stringify(question.answerOptions ?? []),
                now,
              ),
            );
          }
          await this.env.DB.batch(statements);
          return { itemCount: route.result.detectedItems.length };
        },
      );

      const status = requiresUserInput(route.result) ? "needs_user_input" : "completed";
      await step.do("complete job", async () => {
        const now = nowIso();
        await this.env.DB.prepare(
          "UPDATE analysis_jobs SET status = ?, overall_confidence = ?, analysis_version = ?, updated_at = ?, completed_at = ? WHERE id = ? AND owner_user_id = ?",
        )
          .bind(
            status,
            route.result.overallConfidence,
            route.result.analysisVersion,
            now,
            now,
            params.jobId,
            params.userId,
          )
          .run();
        return { status };
      });

      logEvent({
        severity: "info",
        event: "meal_analysis_completed",
        correlationId: event.instanceId,
        userId: params.userId,
        jobId: params.jobId,
        durationMs: Date.now() - startedAt,
        outcome: status,
      });
      return { status };
    } catch (error) {
      await this.env.DB.prepare(
        "UPDATE analysis_jobs SET status = 'failed', error_code = 'ANALYSIS_FAILED', error_message_he = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
      )
        .bind(
          mealText
            ? "לא הצלחנו לנתח את תיאור הארוחה. אפשר לנסות שוב או להזין ידנית."
            : "לא הצלחנו לנתח את התמונה. התמונה נשמרה זמנית ואפשר לנסות שוב.",
          nowIso(),
          params.jobId,
          params.userId,
        )
        .run();
      logEvent({
        severity: "error",
        event: "meal_analysis_failed",
        correlationId: event.instanceId,
        userId: params.userId,
        jobId: params.jobId,
        durationMs: Date.now() - startedAt,
        outcome: error instanceof Error ? error.name : "unknown",
        retryable: true,
        details: {
          errorMessage:
            error instanceof Error ? error.message.slice(0, 500) : "Unknown workflow error",
          fastModel: this.env.AI_FAST_MODEL,
          strongModel: this.env.AI_STRONG_MODEL,
          inputMode: mealText ? "text" : "image",
        },
      });
      throw error;
    }
  }
}

function requiresUserInput(result: MealAnalysisResult): boolean {
  return (
    result.overallConfidence === "low" ||
    result.needsAnotherImage ||
    result.detectedItems.some(
      (item) =>
        item.foodIdentityConfidence === "low" ||
        item.quantityConfidence === "low" ||
        item.nutritionConfidence === "low",
    )
  );
}

type CatalogRow = Omit<FoodCatalogEntry, "servingOptions">;
type ServingRow = {
  foodId: string;
  labelHe: string;
  unit: string;
  baseAmount: number | null;
  baseUnit: "g" | "ml";
};

async function loadFoodCatalog(env: RuntimeEnv, userId: string): Promise<FoodCatalogEntry[]> {
  const foods = await env.DB.prepare(
    `SELECT f.id, f.canonical_name_he AS nameHe, f.canonical_name_en AS nameEn, f.brand,
       COALESCE((SELECT fn.base_quantity FROM food_nutrients fn WHERE fn.food_id=f.id ORDER BY fn.created_at DESC LIMIT 1),100) AS baseQuantity,
       COALESCE((SELECT fn.base_unit FROM food_nutrients fn WHERE fn.food_id=f.id ORDER BY fn.created_at DESC LIMIT 1),'g') AS baseUnit,
       (SELECT fn.normalized_value FROM food_nutrients fn WHERE fn.food_id=f.id AND fn.nutrient_code='energy_kcal' ORDER BY fn.created_at DESC LIMIT 1) AS energyKcal,
       (SELECT fn.normalized_value FROM food_nutrients fn WHERE fn.food_id=f.id AND fn.nutrient_code='protein' ORDER BY fn.created_at DESC LIMIT 1) AS proteinGrams,
       (SELECT fn.normalized_value FROM food_nutrients fn WHERE fn.food_id=f.id AND fn.nutrient_code='carbohydrate' ORDER BY fn.created_at DESC LIMIT 1) AS carbohydrateGrams,
       (SELECT fn.normalized_value FROM food_nutrients fn WHERE fn.food_id=f.id AND fn.nutrient_code='fat' ORDER BY fn.created_at DESC LIMIT 1) AS fatGrams,
       (SELECT fn.normalized_value FROM food_nutrients fn WHERE fn.food_id=f.id AND fn.nutrient_code='fiber' ORDER BY fn.created_at DESC LIMIT 1) AS fiberGrams
     FROM foods f
     WHERE f.owner_household_id=(SELECT hm.household_id FROM household_members hm WHERE hm.user_id=? LIMIT 1)
        OR (f.owner_household_id IS NULL AND f.is_shared=1)
     ORDER BY CASE WHEN f.owner_household_id IS NULL THEN 1 ELSE 0 END, f.updated_at DESC LIMIT 120`,
  )
    .bind(userId)
    .all<CatalogRow>();

  const servings = await env.DB.prepare(
    `SELECT fs.food_id AS foodId, fs.description_he AS labelHe, fs.unit, fs.grams_or_ml AS baseAmount,
       COALESCE((SELECT fn.base_unit FROM food_nutrients fn WHERE fn.food_id=f.id ORDER BY fn.created_at DESC LIMIT 1),'g') AS baseUnit
     FROM food_servings fs JOIN foods f ON f.id=fs.food_id
     WHERE (f.owner_household_id=(SELECT hm.household_id FROM household_members hm WHERE hm.user_id=? LIMIT 1)
        OR (f.owner_household_id IS NULL AND f.is_shared=1))
       AND fs.grams_or_ml IS NOT NULL AND fs.grams_or_ml>0
     ORDER BY fs.created_at DESC`,
  )
    .bind(userId)
    .all<ServingRow>();

  const byFood = new Map<string, FoodCatalogEntry["servingOptions"]>();
  for (const row of servings.results) {
    if (row.baseAmount === null) continue;
    const list = byFood.get(row.foodId) ?? [];
    if (list.length < 7)
      list.push({
        labelHe: row.labelHe,
        unit: row.unit,
        baseAmount: row.baseAmount,
        baseUnit: row.baseUnit,
      });
    byFood.set(row.foodId, list);
  }
  return foods.results.map((food) => ({ ...food, servingOptions: byFood.get(food.id) ?? [] }));
}

function enrichResultWithCatalog(
  result: MealAnalysisResult,
  catalog: FoodCatalogEntry[],
): MealAnalysisResult {
  return {
    ...result,
    detectedItems: result.detectedItems.map((item) => {
      const match = findCatalogMatch(item, catalog);
      if (!match)
        return {
          ...item,
          nutritionSource: "ai_estimate",
          servingOptions: item.servingOptions ?? [baseServing("g")],
        };
      const baseAmount = resolveBaseAmount(item, match);
      const dbNutrition = baseAmount === null ? null : scaleCatalogNutrition(match, baseAmount);
      const calories = dbNutrition?.energyKcal ?? null;
      return {
        ...item,
        candidateNameHe: match.nameHe,
        matchedFoodId: match.id,
        nutritionSource: dbNutrition ? "database" : "ai_estimate",
        nutrition: dbNutrition ?? item.nutrition,
        nutritionBasis: {
          baseQuantity: match.baseQuantity,
          baseUnit: match.baseUnit,
          energyKcal: match.energyKcal,
          proteinGrams: match.proteinGrams,
          carbohydrateGrams: match.carbohydrateGrams,
          fatGrams: match.fatGrams,
          fiberGrams: match.fiberGrams,
        },
        servingOptions: [baseServing(match.baseUnit), ...match.servingOptions].slice(0, 8),
        nutritionConfidence: dbNutrition ? "high" : item.nutritionConfidence,
        plausibleCaloriesMin: calories ?? item.plausibleCaloriesMin,
        plausibleCaloriesMax: calories ?? item.plausibleCaloriesMax,
        notes: [
          ...(item.notes ?? []),
          dbNutrition
            ? `הערכים התזונתיים חושבו מהמאגר: ${match.nameHe}`
            : `נמצאה התאמה במאגר: ${match.nameHe}. בחר מנה או כמות לחישוב.`,
        ],
      };
    }),
  };
}

function baseServing(baseUnit: "g" | "ml"): FoodCatalogEntry["servingOptions"][number] {
  return {
    labelHe: baseUnit === "ml" ? "מ״ל" : "גרמים",
    unit: baseUnit === "ml" ? "מ״ל" : "גרם",
    baseAmount: 1,
    baseUnit,
  };
}

function resolveBaseAmount(
  item: MealAnalysisResult["detectedItems"][number],
  match: FoodCatalogEntry,
): number | null {
  if (match.baseUnit === "g" && item.estimatedGrams !== null) return item.estimatedGrams;
  if (item.estimatedQuantity !== null && item.estimatedUnit) {
    const unit = normalizeFoodName(item.estimatedUnit);
    const serving = match.servingOptions.find(
      (option) =>
        normalizeFoodName(option.unit) === unit || normalizeFoodName(option.labelHe).includes(unit),
    );
    if (serving) return item.estimatedQuantity * serving.baseAmount;
  }
  return null;
}

function scaleCatalogNutrition(
  food: FoodCatalogEntry,
  amount: number,
): NonNullable<MealAnalysisResult["detectedItems"][number]["nutrition"]> {
  const factor = amount / food.baseQuantity;
  const scale = (value: number | null) =>
    value === null ? null : Math.round(value * factor * 10) / 10;
  return {
    energyKcal: scale(food.energyKcal),
    proteinGrams: scale(food.proteinGrams),
    carbohydrateGrams: scale(food.carbohydrateGrams),
    fatGrams: scale(food.fatGrams),
    fiberGrams: scale(food.fiberGrams),
  };
}

function findCatalogMatch(
  item: MealAnalysisResult["detectedItems"][number],
  catalog: FoodCatalogEntry[],
): FoodCatalogEntry | null {
  const names = [
    item.candidateNameHe,
    item.candidateNameEn ?? "",
    ...(item.alternativeCandidates ?? []),
  ]
    .map(normalizeFoodName)
    .filter(Boolean);
  for (const name of names) {
    const exact = catalog.find(
      (food) =>
        normalizeFoodName(food.nameHe) === name || normalizeFoodName(food.nameEn ?? "") === name,
    );
    if (exact) return exact;
  }
  for (const name of names) {
    const contained = catalog.find((food) =>
      [food.nameHe, food.nameEn ?? ""]
        .map(normalizeFoodName)
        .filter(Boolean)
        .some(
          (candidate) =>
            candidate.length >= 3 &&
            name.length >= 3 &&
            (name.includes(candidate) || candidate.includes(name)),
        ),
    );
    if (contained) return contained;
  }
  return null;
}

function normalizeFoodName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("he-IL")
    .replace(/[״"'׳.,:;()-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
