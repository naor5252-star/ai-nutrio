export const PRIMARY_GOALS = [
  "weight_loss",
  "fat_reduction",
  "maintenance",
  "performance",
  "muscle_gain",
  "general_nutrition",
] as const;

export type PrimaryGoal = (typeof PRIMARY_GOALS)[number];

export const ACTIVITY_LEVELS = [
  "sedentary",
  "light",
  "moderate",
  "very_active",
  "extreme",
] as const;

export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export const GOAL_INTENSITIES = ["moderate", "medium", "increased"] as const;
export type GoalIntensity = (typeof GOAL_INTENSITIES)[number];

export const MEAL_CATEGORIES = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "drink",
  "custom",
] as const;

export type MealCategory = (typeof MEAL_CATEGORIES)[number];

export const ANALYSIS_STATUSES = [
  "queued",
  "uploading",
  "processing",
  "needs_user_input",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const SOURCE_TYPES = ["label", "database", "manual", "ai_estimate"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
