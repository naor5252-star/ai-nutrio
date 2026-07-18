import { z } from "zod";
import { CONFIDENCE_LEVELS } from "../constants/domain";

const confidenceSchema = z.enum(CONFIDENCE_LEVELS);

export const mealAnalysisItemSchema = z.object({
  temporaryId: z.string().min(1).max(100),
  candidateNameHe: z.string().min(1).max(160),
  candidateNameEn: z.string().max(160).optional(),
  alternativeCandidates: z.array(z.string().max(160)).max(5).optional(),
  estimatedQuantity: z.number().finite().nonnegative().max(10_000).nullable(),
  estimatedUnit: z.string().max(60).nullable(),
  estimatedGrams: z.number().finite().nonnegative().max(10_000).nullable(),
  foodIdentityConfidence: confidenceSchema,
  quantityConfidence: confidenceSchema,
  nutritionConfidence: confidenceSchema.default("low"),
  plausibleCaloriesMin: z.number().finite().nonnegative().max(20_000).nullable().default(null),
  plausibleCaloriesMax: z.number().finite().nonnegative().max(20_000).nullable().default(null),
  notes: z.array(z.string().max(300)).max(8).optional(),
});

export const mealAnalysisResultSchema = z.object({
  analysisVersion: z.string().min(1).max(50),
  detectedItems: z.array(mealAnalysisItemSchema).min(1).max(30),
  overallConfidence: confidenceSchema,
  clarificationQuestions: z
    .array(
      z.object({
        questionId: z.string().min(1).max(100),
        questionHe: z.string().min(1).max(300),
        answerOptions: z.array(z.string().max(120)).max(8).optional(),
      }),
    )
    .max(8)
    .optional(),
  needsAnotherImage: z.boolean(),
  anotherImageReasonHe: z.string().max(300).optional(),
});

export type MealAnalysisResult = z.infer<typeof mealAnalysisResultSchema>;

export const analysisWorkflowParamsSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
});

export type AnalysisWorkflowParams = z.infer<typeof analysisWorkflowParamsSchema>;
