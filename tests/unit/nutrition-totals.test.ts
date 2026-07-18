import { describe, expect, it } from "vitest";
import { sumNutrients, type NullableNutrients } from "../../src/shared/nutrition/totals";

const complete = (overrides: Partial<NullableNutrients> = {}): NullableNutrients => ({
  calories: 100,
  proteinGrams: 10,
  carbohydrateGrams: 12,
  fatGrams: 3,
  fiberGrams: 2,
  sugarGrams: 4,
  sodiumMilligrams: 50,
  ...overrides,
});

describe("nutrition totals", () => {
  it("sums known values", () => {
    const result = sumNutrients([complete(), complete({ calories: 200, proteinGrams: 20 })]);
    expect(result.calories).toBe(300);
    expect(result.proteinGrams).toBe(30);
    expect(result.partialNutrients).toEqual([]);
  });

  it("marks a total partial and never converts unknown to zero", () => {
    const result = sumNutrients([
      complete(),
      complete({ fiberGrams: null, sodiumMilligrams: null }),
    ]);
    expect(result.fiberGrams).toBe(2);
    expect(result.sodiumMilligrams).toBe(50);
    expect(result.partialNutrients).toContain("fiberGrams");
    expect(result.partialNutrients).toContain("sodiumMilligrams");
  });

  it("returns null when every component is unknown", () => {
    const result = sumNutrients([complete({ sugarGrams: null }), complete({ sugarGrams: null })]);
    expect(result.sugarGrams).toBeNull();
    expect(result.partialNutrients).toContain("sugarGrams");
  });

  it("handles an empty meal as unknown, not a fake zero", () => {
    const result = sumNutrients([]);
    expect(result.calories).toBeNull();
    expect(result.partialNutrients).toContain("calories");
  });
});
