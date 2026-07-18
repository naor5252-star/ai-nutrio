export type MealSummary = {
  id: string;
  occurred_at: string;
  local_date: string;
  category: string;
  title: string;
  total_calories: number | null;
  total_protein_grams: number | null;
  total_carbohydrate_grams: number | null;
  total_fat_grams: number | null;
  total_fiber_grams: number | null;
  partial_nutrients_json: string;
  favorite: number;
};

export type TargetRow = {
  effective_calories: number;
  effective_protein_grams: number;
  carbohydrate_grams: number;
  fat_grams: number;
  fiber_grams: number;
};

export type AnalysisItem = {
  temporaryId: string;
  candidateNameHe: string;
  estimatedQuantity: number | null;
  estimatedUnit: string | null;
  estimatedGrams: number | null;
  foodIdentityConfidence: "high" | "medium" | "low";
  quantityConfidence: "high" | "medium" | "low";
  nutritionConfidence: "high" | "medium" | "low";
  plausibleCaloriesMin: number | null;
  plausibleCaloriesMax: number | null;
  notes?: string[];
};

export type AnalysisResult = {
  analysisVersion: string;
  detectedItems: AnalysisItem[];
  overallConfidence: "high" | "medium" | "low";
  needsAnotherImage: boolean;
  anotherImageReasonHe?: string;
};
