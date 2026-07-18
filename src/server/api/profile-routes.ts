import { Hono } from "hono";
import { profileInputSchema } from "../../shared/schemas/api";
import { calculateNutritionTargets } from "../../shared/nutrition/rules";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { ageOnDate } from "../domain/time";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";

export const profileRoutes = new Hono<AppEnv>();
profileRoutes.use("*", requireAuth);

profileRoutes.get("/", async (context) => {
  const user = context.get("user");
  const profile = await context.env.DB.prepare("SELECT * FROM user_profiles WHERE user_id = ?")
    .bind(user.id)
    .first<Record<string, unknown>>();
  const targets = await context.env.DB.prepare(
    "SELECT * FROM nutrition_target_versions WHERE user_id = ? ORDER BY effective_from DESC LIMIT 1",
  )
    .bind(user.id)
    .first<Record<string, unknown>>();
  return context.json({ profile, targets });
});

profileRoutes.put("/", requireCsrf, async (context) => {
  const input = profileInputSchema.parse(await context.req.json());
  const user = context.get("user");
  const now = nowIso();
  const ageYears = ageOnDate(input.dateOfBirth);
  const targets = calculateNutritionTargets({
    ageYears,
    sexForFormula: input.sexForFormula,
    heightCm: input.heightCm,
    currentWeightKg: input.currentWeightKg,
    activityLevel: input.activityLevel,
    primaryGoal: input.primaryGoal,
    intensity: input.goalIntensity,
    manualCalorieTarget: input.manualCalorieTarget ?? null,
    manualProteinTarget: input.manualProteinTarget ?? null,
  });
  if (targets.warningCodes.includes("NEGATIVE_CARBOHYDRATE_REMAINDER")) {
    return context.json(
      {
        error: {
          code: "INVALID_MACRO_TARGETS",
          messageHe:
            "יעדי החלבון והשומן משאירים ערך פחמימות שלילי. צריך לעדכן את היעדים לפני השמירה.",
          correlationId: context.get("correlationId"),
          retryable: false,
        },
      },
      422,
    );
  }

  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO user_profiles (
        user_id, date_of_birth, sex_for_formula, height_cm, current_weight_kg, target_weight_kg,
        activity_level, primary_goal, goal_intensity, manual_calorie_target, manual_protein_target,
        created_at, updated_at, version, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        date_of_birth = excluded.date_of_birth,
        sex_for_formula = excluded.sex_for_formula,
        height_cm = excluded.height_cm,
        current_weight_kg = excluded.current_weight_kg,
        target_weight_kg = excluded.target_weight_kg,
        activity_level = excluded.activity_level,
        primary_goal = excluded.primary_goal,
        goal_intensity = excluded.goal_intensity,
        manual_calorie_target = excluded.manual_calorie_target,
        manual_protein_target = excluded.manual_protein_target,
        updated_at = excluded.updated_at,
        version = user_profiles.version + 1,
        updated_by = excluded.updated_by`,
    ).bind(
      user.id,
      input.dateOfBirth,
      input.sexForFormula,
      input.heightCm,
      input.currentWeightKg,
      input.targetWeightKg ?? null,
      input.activityLevel,
      input.primaryGoal,
      input.goalIntensity,
      input.manualCalorieTarget ?? null,
      input.manualProteinTarget ?? null,
      now,
      now,
      user.id,
    ),
    context.env.DB.prepare(
      `INSERT INTO nutrition_target_versions (
        id, user_id, formula_version, calculation_inputs_json, bmr, maintenance_calories,
        calculated_calories, manual_calorie_target, effective_calories, calculated_protein_grams,
        manual_protein_target, effective_protein_grams, fat_grams, carbohydrate_grams, fiber_grams,
        warning_codes_json, effective_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      secureUuid(),
      user.id,
      targets.formulaVersion,
      JSON.stringify({ ...input, ageYears }),
      targets.bmr,
      targets.maintenanceCalories,
      targets.calculatedCalories,
      targets.manualCalorieTarget,
      targets.effectiveCalories,
      targets.calculatedProteinGrams,
      targets.manualProteinTarget,
      targets.effectiveProteinGrams,
      targets.fatGrams,
      targets.carbohydrateGrams,
      targets.fiberGrams,
      JSON.stringify(targets.warningCodes),
      now,
      now,
    ),
    context.env.DB.prepare("UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?").bind(
      input.timezone,
      now,
      user.id,
    ),
  ]);
  return context.json({
    profile: input,
    targets,
    warningDisplayed: targets.warningCodes.length > 0,
  });
});
