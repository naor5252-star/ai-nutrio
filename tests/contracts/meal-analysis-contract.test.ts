import { describe, expect, it } from "vitest";
import { mealAnalysisResultSchema } from "../../src/shared/schemas/meal-analysis";

const valid = {
  analysisVersion: "2026.07.1",
  detectedItems: [
    {
      temporaryId: "item-1",
      candidateNameHe: "פיתה",
      estimatedQuantity: 1,
      estimatedUnit: "יחידה",
      estimatedGrams: 100,
      foodIdentityConfidence: "high",
      quantityConfidence: "medium",
      nutritionConfidence: "medium",
      plausibleCaloriesMin: 220,
      plausibleCaloriesMax: 300,
    },
  ],
  overallConfidence: "medium",
  needsAnotherImage: false,
};

describe("meal AI structured output", () => {
  it("accepts a valid result", () => {
    expect(mealAnalysisResultSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    [
      "negative quantity",
      { ...valid, detectedItems: [{ ...valid.detectedItems[0], estimatedQuantity: -1 }] },
    ],
    ["invalid confidence", { ...valid, overallConfidence: "certain" }],
    [
      "impossible grams",
      { ...valid, detectedItems: [{ ...valid.detectedItems[0], estimatedGrams: 50_000 }] },
    ],
    ["missing items", { ...valid, detectedItems: [] }],
  ])("rejects %s", (_name, payload) => {
    expect(mealAnalysisResultSchema.safeParse(payload).success).toBe(false);
  });

  it("allows unknown quantities instead of fabricating exact values", () => {
    const payload = {
      ...valid,
      detectedItems: [
        {
          ...valid.detectedItems[0],
          estimatedQuantity: null,
          estimatedUnit: null,
          estimatedGrams: null,
          quantityConfidence: "low",
        },
      ],
      overallConfidence: "low",
    };
    expect(mealAnalysisResultSchema.safeParse(payload).success).toBe(true);
  });
});
