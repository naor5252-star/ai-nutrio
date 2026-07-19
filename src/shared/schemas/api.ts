import { z } from "zod";
import {
  ACTIVITY_LEVELS,
  GOAL_INTENSITIES,
  MEAL_CATEGORIES,
  PRIMARY_GOALS,
} from "../constants/domain";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const profileInputSchema = z.object({
  dateOfBirth: z.string().date(),
  sexForFormula: z.enum(["male", "female"]),
  heightCm: z.number().finite().min(100).max(250),
  currentWeightKg: z.number().finite().min(25).max(400),
  targetWeightKg: z.number().finite().min(25).max(400).nullable().optional(),
  activityLevel: z.enum(ACTIVITY_LEVELS),
  primaryGoal: z.enum(PRIMARY_GOALS),
  goalIntensity: z.enum(GOAL_INTENSITIES),
  manualCalorieTarget: z
    .number()
    .int()
    .min(500)
    .max(10_000)
    .nullable()
    .optional(),
  manualProteinTarget: z.number().int().min(0).max(1_000).nullable().optional(),
  timezone: z.string().min(1).max(100),
});

export const manualMealSchema = z.object({
  clientMutationId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  category: z.enum(MEAL_CATEGORIES),
  customCategoryName: z.string().max(80).nullable().optional(),
  title: z.string().min(1).max(160),
  notes: z.string().max(1_000).nullable().optional(),
  items: z
    .array(
      z.object({
        foodId: z.string().uuid().nullable().optional(),
        nameHe: z.string().min(1).max(160),
        quantity: z.number().finite().nonnegative().max(10_000),
        unit: z.string().min(1).max(60),
        grams: z.number().finite().nonnegative().max(10_000).nullable(),
        calories: z.number().finite().nonnegative().max(20_000).nullable(),
        proteinGrams: z.number().finite().nonnegative().max(2_000).nullable(),
        carbohydrateGrams: z
          .number()
          .finite()
          .nonnegative()
          .max(5_000)
          .nullable(),
        fatGrams: z.number().finite().nonnegative().max(2_000).nullable(),
        fiberGrams: z.number().finite().nonnegative().max(1_000).nullable(),
        sourceType: z.enum(["label", "database", "manual", "ai_estimate"]),
      }),
    )
    .min(1)
    .max(50),
});

export const shoppingItemSchema = z.object({
  text: z.string().trim().min(1).max(160),
  quantity: z.number().finite().positive().max(10_000).default(1),
  unit: z.string().trim().min(1).max(60).default("יחידה"),
});

export const measurementSchema = z
  .object({
    measuredAt: z.string().datetime(),
    weightKg: z.number().finite().min(25).max(400).optional(),
    bodyFatPercentage: z.number().finite().min(1).max(80).optional(),
    muscleMassKg: z.number().finite().min(1).max(250).optional(),
  })
  .refine(
    (value) =>
      value.weightKg !== undefined ||
      value.bodyFatPercentage !== undefined ||
      value.muscleMassKg !== undefined,
    {
      message: "At least one measurement is required",
    },
  );
