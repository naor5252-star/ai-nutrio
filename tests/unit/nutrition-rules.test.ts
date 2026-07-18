import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FACTORS,
  FIBER_TARGET_GRAMS,
  NUTRITION_FORMULA_VERSION,
  calculateBmr,
  calculateNutritionTargets,
} from "../../src/shared/nutrition/rules";

describe("nutrition business rules", () => {
  it("calculates Mifflin–St Jeor for a male profile", () => {
    expect(
      calculateBmr({ ageYears: 35, sexForFormula: "male", heightCm: 170, currentWeightKg: 62.5 }),
    ).toBeCloseTo(1517.5, 5);
  });

  it("calculates Mifflin–St Jeor for a female profile", () => {
    expect(
      calculateBmr({ ageYears: 35, sexForFormula: "female", heightCm: 170, currentWeightKg: 62.5 }),
    ).toBeCloseTo(1351.5, 5);
  });

  it("uses the configured activity factor and goal adjustment", () => {
    const targets = calculateNutritionTargets({
      ageYears: 35,
      sexForFormula: "male",
      heightCm: 170,
      currentWeightKg: 62.5,
      activityLevel: "moderate",
      primaryGoal: "weight_loss",
      intensity: "medium",
    });
    expect(ACTIVITY_FACTORS.moderate).toBe(1.55);
    expect(targets.maintenanceCalories).toBeCloseTo(2352.125, 5);
    expect(targets.calculatedCalories).toBeCloseTo(2116.9125, 5);
    expect(targets.effectiveProteinGrams).toBe(100);
    expect(targets.fatGrams).toBeCloseTo(58.803, 3);
    expect(targets.carbohydrateGrams).toBeCloseTo(296.921, 3);
    expect(targets.fiberGrams).toBe(FIBER_TARGET_GRAMS);
    expect(targets.formulaVersion).toBe(NUTRITION_FORMULA_VERSION);
  });

  it("keeps calculated and manually overridden targets separate", () => {
    const targets = calculateNutritionTargets({
      ageYears: 35,
      sexForFormula: "male",
      heightCm: 170,
      currentWeightKg: 62.5,
      activityLevel: "light",
      primaryGoal: "maintenance",
      intensity: "moderate",
      manualCalorieTarget: 2_200,
      manualProteinTarget: 120,
    });
    expect(targets.manualCalorieTarget).toBe(2_200);
    expect(targets.effectiveCalories).toBe(2_200);
    expect(targets.manualProteinTarget).toBe(120);
    expect(targets.effectiveProteinGrams).toBe(120);
    expect(targets.calculatedCalories).not.toBe(2_200);
  });

  it("warns rather than silently saving a negative carbohydrate remainder", () => {
    const targets = calculateNutritionTargets({
      ageYears: 35,
      sexForFormula: "male",
      heightCm: 170,
      currentWeightKg: 62.5,
      activityLevel: "sedentary",
      primaryGoal: "muscle_gain",
      intensity: "moderate",
      manualCalorieTarget: 900,
      manualProteinTarget: 300,
    });
    expect(targets.carbohydrateGrams).toBe(0);
    expect(targets.warningCodes).toContain("NEGATIVE_CARBOHYDRATE_REMAINDER");
    expect(targets.warningCodes).toContain("CALORIES_UNUSUALLY_LOW");
  });
});
