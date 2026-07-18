import type { ActivityLevel, GoalIntensity, PrimaryGoal } from "../constants/domain";

export const NUTRITION_FORMULA_VERSION = "2026.07.1";
export const FIBER_TARGET_GRAMS = 25;

export const ACTIVITY_FACTORS: Readonly<Record<ActivityLevel, number>> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  extreme: 1.9,
};

const GOAL_ADJUSTMENTS: Readonly<Record<PrimaryGoal, Readonly<Record<GoalIntensity, number>>>> = {
  weight_loss: { moderate: -0.05, medium: -0.1, increased: -0.15 },
  fat_reduction: { moderate: -0.03, medium: -0.05, increased: -0.08 },
  maintenance: { moderate: 0, medium: 0, increased: 0 },
  performance: { moderate: 0, medium: 0.03, increased: 0.05 },
  muscle_gain: { moderate: 0.05, medium: 0.08, increased: 0.1 },
  general_nutrition: { moderate: 0, medium: 0, increased: 0 },
};

const PROTEIN_MIDPOINTS: Readonly<Record<PrimaryGoal, number>> = {
  weight_loss: 1.6,
  fat_reduction: 1.8,
  maintenance: 1.4,
  performance: 1.6,
  muscle_gain: 1.8,
  general_nutrition: 1.4,
};

const FAT_PERCENTAGES: Readonly<Record<PrimaryGoal, number>> = {
  weight_loss: 0.25,
  fat_reduction: 0.25,
  maintenance: 0.3,
  performance: 0.25,
  muscle_gain: 0.25,
  general_nutrition: 0.3,
};

export type BiologicalSexForFormula = "male" | "female";

export type NutritionTargetInput = {
  ageYears: number;
  sexForFormula: BiologicalSexForFormula;
  heightCm: number;
  currentWeightKg: number;
  activityLevel: ActivityLevel;
  primaryGoal: PrimaryGoal;
  intensity: GoalIntensity;
  manualCalorieTarget?: number | null;
  manualProteinTarget?: number | null;
};

export type NutritionTargets = {
  formulaVersion: string;
  bmr: number;
  maintenanceCalories: number;
  calculatedCalories: number;
  manualCalorieTarget: number | null;
  effectiveCalories: number;
  calculatedProteinGrams: number;
  manualProteinTarget: number | null;
  effectiveProteinGrams: number;
  fatGrams: number;
  carbohydrateGrams: number;
  fiberGrams: number;
  warningCodes: string[];
};

export function calculateBmr(
  input: Pick<NutritionTargetInput, "ageYears" | "sexForFormula" | "heightCm" | "currentWeightKg">,
): number {
  const sexAdjustment = input.sexForFormula === "male" ? 5 : -161;
  return 10 * input.currentWeightKg + 6.25 * input.heightCm - 5 * input.ageYears + sexAdjustment;
}

export function calculateNutritionTargets(input: NutritionTargetInput): NutritionTargets {
  const bmr = calculateBmr(input);
  const maintenanceCalories = bmr * ACTIVITY_FACTORS[input.activityLevel];
  const calculatedCalories =
    maintenanceCalories * (1 + GOAL_ADJUSTMENTS[input.primaryGoal][input.intensity]);
  const effectiveCalories = input.manualCalorieTarget ?? calculatedCalories;
  const calculatedProteinGrams = input.currentWeightKg * PROTEIN_MIDPOINTS[input.primaryGoal];
  const effectiveProteinGrams = input.manualProteinTarget ?? calculatedProteinGrams;
  const fatCalories = effectiveCalories * FAT_PERCENTAGES[input.primaryGoal];
  const fatGrams = fatCalories / 9;
  const remainingCalories = effectiveCalories - effectiveProteinGrams * 4 - fatCalories;
  const warningCodes: string[] = [];

  if (effectiveCalories < 1_200) warningCodes.push("CALORIES_UNUSUALLY_LOW");
  if (effectiveCalories > 5_000) warningCodes.push("CALORIES_UNUSUALLY_HIGH");
  if (remainingCalories < 0) warningCodes.push("NEGATIVE_CARBOHYDRATE_REMAINDER");

  return {
    formulaVersion: NUTRITION_FORMULA_VERSION,
    bmr,
    maintenanceCalories,
    calculatedCalories,
    manualCalorieTarget: input.manualCalorieTarget ?? null,
    effectiveCalories,
    calculatedProteinGrams,
    manualProteinTarget: input.manualProteinTarget ?? null,
    effectiveProteinGrams,
    fatGrams,
    carbohydrateGrams: Math.max(0, remainingCalories / 4),
    fiberGrams: FIBER_TARGET_GRAMS,
    warningCodes,
  };
}
