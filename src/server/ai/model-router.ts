import { z } from "zod";
import {
  mealAnalysisResultSchema,
  type MealAnalysisResult,
} from "../../shared/schemas/meal-analysis";
import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

export type ImageInput = {
  contentType: string;
  bytes: ArrayBuffer;
};

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

const visionAiResultSchema = z.object({
  suggestedTitleHe: z.string().trim().min(1).max(160),
  totals: z.object({
    calories: z.number().finite().nonnegative().max(20_000),
    protein: z.number().finite().nonnegative().max(2_000),
    carbohydrates: z.number().finite().nonnegative().max(5_000),
    fat: z.number().finite().nonnegative().max(2_000),
    fiber: z.number().finite().nonnegative().max(1_000),
  }),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        grams: z.number().finite().positive().max(10_000),
        nutrition: z.object({
          calories: z.number().finite().nonnegative().max(20_000),
          protein: z.number().finite().nonnegative().max(2_000),
          carbohydrates: z.number().finite().nonnegative().max(5_000),
          fat: z.number().finite().nonnegative().max(2_000),
          fiber: z.number().finite().nonnegative().max(1_000),
        }),
      }),
    )
    .min(1)
    .max(20),
});

type VisionAiResult = z.infer<typeof visionAiResultSchema>;

type AiRouteResult = {
  result: MealAnalysisResult;
  model: string | null;
  route: "disabled" | "fast" | "fast_then_strong";
};

export type FoodServingOption = {
  labelHe: string;
  unit: string;
  baseAmount: number;
  baseUnit: "g" | "ml";
};

export type FoodCatalogEntry = {
  id: string;
  nameHe: string;
  nameEn: string | null;
  brand: string | null;
  baseQuantity: number;
  baseUnit: "g" | "ml";
  energyKcal: number | null;
  proteinGrams: number | null;
  carbohydrateGrams: number | null;
  fatGrams: number | null;
  fiberGrams: number | null;
  servingOptions: FoodServingOption[];
};

export async function analyzeMealImages(
  env: RuntimeEnv,
  images: ImageInput[],
): Promise<AiRouteResult> {
  if (env.AI_ENABLED !== "true")
    return { result: disabledResult(), model: null, route: "disabled" };
  const aiValue: unknown = env.AI;
  if (!isGenericAiBinding(aiValue))
    return { result: disabledResult(), model: null, route: "disabled" };

  const strongModel = env.AI_STRONG_MODEL;
  let strongRaw = await tryRunAiModel(
    aiValue,
    strongModel,
    createVisionPayload(images, false),
    "meal_image_strong_ai_failed",
  );
  let strongParsed = strongRaw === null ? null : parseVisionModelResponse(strongRaw);

  if (!strongParsed && strongRaw !== null && readFinishReason(strongRaw) === "length") {
    const retryRaw = await tryRunAiModel(
      aiValue,
      strongModel,
      createVisionPayload(images, true),
      "meal_image_strong_ai_retry_failed",
    );
    if (retryRaw !== null) {
      strongRaw = retryRaw;
      strongParsed = parseVisionModelResponse(retryRaw);
    }
  }

  const rawAiJson = strongRaw === null ? undefined : serializeRawModelOutput(strongRaw);
  const rawAiContent = strongRaw === null ? undefined : readRawModelContent(strongRaw);
  const rawAiFinishReason = strongRaw === null ? undefined : readFinishReason(strongRaw);

  if (strongParsed) {
    return {
      result: mapVisionResult(strongParsed, rawAiJson, rawAiContent, rawAiFinishReason),
      model: strongModel,
      route: "fast_then_strong",
    };
  }

  return {
    result: {
      ...disabledResult("המודל החזיר תשובה שלא הצלחנו לפרש. התגובה המקורית מוצגת למטה."),
      ...(rawAiJson ? { rawAiJson } : {}),
      ...(rawAiContent ? { rawAiContent } : {}),
      ...(rawAiFinishReason ? { rawAiFinishReason } : {}),
    },
    model: strongModel,
    route: "fast_then_strong",
  };
}

export async function analyzeMealText(
  env: RuntimeEnv,
  description: string,
  catalog: FoodCatalogEntry[] = [],
): Promise<AiRouteResult> {
  if (env.AI_ENABLED !== "true") {
    return {
      result: fallbackTextResult(description, "ניתוח טקסט באמצעות AI אינו זמין כרגע."),
      model: null,
      route: "disabled",
    };
  }

  const aiValue: unknown = env.AI;
  if (!isGenericAiBinding(aiValue)) {
    return {
      result: fallbackTextResult(description, "ניתוח טקסט באמצעות AI אינו זמין כרגע."),
      model: null,
      route: "disabled",
    };
  }

  const fastModel = env.AI_FAST_MODEL;
  const fastParsed = await tryAnalyzeTextWithModel(aiValue, fastModel, description, false, catalog);

  if (fastParsed) {
    return {
      result: normalizeTextResult(fastParsed),
      model: fastModel,
      route: "fast",
    };
  }

  const strongModel = env.AI_STRONG_MODEL;
  if (strongModel !== fastModel) {
    const strongParsed = await tryAnalyzeTextWithModel(
      aiValue,
      strongModel,
      description,
      true,
      catalog,
    );

    if (strongParsed) {
      return {
        result: normalizeTextResult(strongParsed),
        model: strongModel,
        route: "fast_then_strong",
      };
    }
  }

  return {
    result: fallbackTextResult(
      description,
      "ה־AI לא החזיר מבנה תקין. התיאור נשמר וניתן לפצל אותו ידנית.",
    ),
    model: null,
    route: "disabled",
  };
}

async function tryAnalyzeTextWithModel(
  aiValue: GenericAiBinding,
  model: string,
  description: string,
  strong: boolean,
  catalog: FoodCatalogEntry[],
): Promise<MealAnalysisResult | null> {
  const startedAt = Date.now();

  try {
    const raw = await aiValue.run(model, createTextPayload(description, strong, catalog));
    return parseModelResponse(raw);
  } catch (error) {
    logEvent({
      severity: "error",
      event: "meal_text_ai_model_failed",
      correlationId: crypto.randomUUID(),
      durationMs: Date.now() - startedAt,
      outcome: error instanceof Error ? error.name : "unknown",
      retryable: true,
      details: {
        model,
        strong,
        errorMessage: formatAiError(error),
      },
    });
    return null;
  }
}

async function tryRunAiModel(
  aiValue: GenericAiBinding,
  model: string,
  input: Record<string, unknown>,
  event: string,
): Promise<unknown> {
  const startedAt = Date.now();

  try {
    return await aiValue.run(model, input);
  } catch (error) {
    logEvent({
      severity: "error",
      event,
      correlationId: crypto.randomUUID(),
      durationMs: Date.now() - startedAt,
      outcome: error instanceof Error ? error.name : "unknown",
      retryable: true,
      details: {
        model,
        errorMessage: formatAiError(error),
      },
    });
    return null;
  }
}

function serializeRawModelOutput(raw: unknown): string {
  return serializeUnknown(raw);
}

function readRawModelContent(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  if (Reflect.has(raw, "response")) {
    const response = readUnknownField(raw, "response");
    if (typeof response === "string") return response;
  }

  const choices = readUnknownField(raw, "choices");
  if (!isUnknownArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = readUnknownField(first, "message");
  if (typeof message !== "object" || message === null) return undefined;
  const content = readUnknownField(message, "content");
  return typeof content === "string" ? content : undefined;
}

function readFinishReason(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const choices = readUnknownField(raw, "choices");
  if (!isUnknownArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const finishReason = readUnknownField(first, "finish_reason");
  return typeof finishReason === "string" ? finishReason : undefined;
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function formatAiError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 1_000);
  }

  return String(error).slice(0, 1_000);
}

function normalizeTextResult(result: MealAnalysisResult): MealAnalysisResult {
  const normalized = {
    ...result,
    analysisVersion: "meal-text-v2",
    needsAnotherImage: false,
  };
  delete normalized.anotherImageReasonHe;
  return normalized;
}

function createTextPayload(
  description: string,
  strong: boolean,
  catalog: FoodCatalogEntry[],
): Record<string, unknown> {
  const catalogText = catalog
    .slice(0, 80)
    .map((food) => {
      const basis = `${food.baseQuantity} ${food.baseUnit === "ml" ? "מ״ל" : "גרם"}`;
      const values = [
        food.energyKcal === null ? null : `${food.energyKcal} קל׳`,
        food.proteinGrams === null ? null : `${food.proteinGrams} חלבון`,
        food.carbohydrateGrams === null ? null : `${food.carbohydrateGrams} פחמימות`,
        food.fatGrams === null ? null : `${food.fatGrams} שומן`,
        food.fiberGrams === null ? null : `${food.fiberGrams} סיבים`,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      return `${food.nameHe}${food.brand ? ` (${food.brand})` : ""}: ${values} / ${basis}`;
    })
    .join("\\n");

  return {
    messages: [
      {
        role: "system",
        content:
          "You are a cautious nutrition meal-log parser. Convert only food explicitly stated by the user into structured meal components. Return Hebrew food names and JSON matching the requested schema. Never diagnose.",
      },
      {
        role: "user",
        content: [
          'הפוך את תיאור הארוחה הבא לרכיבים נפרדים: "' + description + '".',
          'הגדר analysisVersion כ-"meal-text-v2" ואת needsAnotherImage כ-false.',
          "החזר suggestedTitleHe ככותרת קצרה וטבעית בעברית עבור הארוחה.",
          "פצל רק מאכלים שהמשתמש ציין במפורש. אל תפרק מנה מוכנה למרכיבים פנימיים שלא צוינו.",
          "שמור כמויות ויחידות שנכתבו. המר לגרמים רק כאשר ההמרה סבירה וברורה.",
          "כאשר כמות חסרה, החזר estimatedQuantity ו-estimatedGrams כ-null וסמן quantityConfidence כ-low.",
          "החזר nutrition עם energyKcal, proteinGrams, carbohydrateGrams, fatGrams, fiberGrams עבור הכמות שזוהתה. ערך שלא ניתן להעריך סביר יהיה null.",
          "הערך טווח קלוריות שמרני. אל תנחש שמן, רוטב, תוספת, מותג או שיטת בישול שלא צוינו.",
          catalogText
            ? `מאגר מזונות זמין. העדף התאמה למאגר על פני הערכת AI כאשר השם מתאים:
${catalogText}`
            : "לא הועבר מאגר מזונות זמין.",
          "החזר JSON בלבד לפי הסכמה.",
        ].join(" "),
      },
    ],
    max_completion_tokens: strong ? 2_400 : 1_800,
    temperature: 0,
  };
}

function createVisionPayload(
  images: ImageInput[],
  retryAfterTruncation: boolean,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: [
        "נתח את כל התמונות כארוחה אחת.",
        "אל תציג הסבר, reasoning, markdown או code fences בתשובה הסופית.",
        "החזר רק אובייקט JSON קומפקטי אחד.",
        'המבנה חייב להיות בדיוק: {"suggestedTitleHe":"כותרת קצרה בעברית","totals":{"calories":123,"protein":12,"carbohydrates":20,"fat":5,"fiber":3},"items":[{"name":"שם המאכל בעברית","grams":123,"nutrition":{"calories":123,"protein":12,"carbohydrates":20,"fat":5,"fiber":3}}]}.',
        "suggestedTitleHe צריך לתאר בקצרה את הארוחה כולה.",
        "totals חייב להיות סכום הערכים של כל הפריטים בארוחה.",
        "לכל פריט החזר משקל מוערך בגרמים כמספר, ואת הערכים התזונתיים עבור כל הכמות שזוהתה — לא ל-100 גרם.",
        "הערך תמיד best-effort עבור קלוריות, חלבון, פחמימות, שומן וסיבים. אל תחזיר null.",
        "אין להשתמש במאגר מזונות של האפליקציה ואין צורך להתאים למוצר קיים.",
        "זהה מאכלים שנראים בתמונה. אל תמציא מותג או מרכיב נסתר.",
        "אל תספור אותו פריט פעמיים אם הוא מופיע ביותר מתמונה אחת.",
        "במנה מורכבת, שמור אותה כפריט אחד כאשר פיצול לרכיבים ייצור ניחוש מיותר.",
        "אם שמן או רוטב נראים בבירור, כלול אותם בהערכת הערכים; אם לא, אל תניח כמות גדולה של שמן נסתר.",
        retryAfterTruncation
          ? "זו בקשה חוזרת אחרי תשובה שנקטעה: היה קצר במיוחד והחזר מיד את ה-JSON בלבד."
          : "בצע את החישוב פנימית ואז החזר מיד את ה-JSON בלבד.",
      ].join(" "),
    },
  ];

  for (const image of images.slice(0, 4)) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${image.contentType};base64,${arrayBufferToBase64(image.bytes)}`,
      },
    });
  }

  return {
    messages: [
      {
        role: "system",
        content:
          "You analyze meal photos for nutrition logging. Your final answer must be only the requested compact JSON object, with Hebrew food names and no explanation.",
      },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
    reasoning_effort: "low",
    max_completion_tokens: retryAfterTruncation ? 6_000 : 4_000,
    temperature: 0,
  };
}

function parseVisionModelResponse(raw: unknown): VisionAiResult | null {
  const response = readResponseField(raw);
  if (response === null) return null;

  let candidate: unknown = response;
  if (typeof response === "string") {
    try {
      candidate = JSON.parse(stripCodeFence(response));
    } catch {
      return null;
    }
  }

  const parsed = visionAiResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function mapVisionResult(
  result: VisionAiResult,
  rawAiJson: string | undefined,
  rawAiContent: string | undefined,
  rawAiFinishReason: string | undefined,
): MealAnalysisResult {
  const detectedItems = result.items.map((item) => {
    const calories = item.nutrition.calories;
    return {
      temporaryId: crypto.randomUUID(),
      candidateNameHe: item.name,
      estimatedQuantity: item.grams,
      estimatedUnit: "גרם",
      estimatedGrams: item.grams,
      foodIdentityConfidence: "medium" as const,
      quantityConfidence: "medium" as const,
      nutritionConfidence: "medium" as const,
      plausibleCaloriesMin: Math.max(0, Math.round(calories * 0.8)),
      plausibleCaloriesMax: Math.round(calories * 1.2),
      nutrition: {
        energyKcal: calories,
        proteinGrams: item.nutrition.protein,
        carbohydrateGrams: item.nutrition.carbohydrates,
        fatGrams: item.nutrition.fat,
        fiberGrams: item.nutrition.fiber,
      },
      nutritionSource: "ai_estimate" as const,
      notes: ["הערכה ישירה מתמונת הארוחה באמצעות AI."],
    };
  });

  return {
    analysisVersion: "meal-image-ai-simple-v1",
    suggestedTitleHe: result.suggestedTitleHe,
    detectedItems,
    overallConfidence: "medium",
    needsAnotherImage: false,
    ...(rawAiJson ? { rawAiJson } : {}),
    ...(rawAiContent ? { rawAiContent } : {}),
    ...(rawAiFinishReason ? { rawAiFinishReason } : {}),
  };
}

function parseModelResponse(raw: unknown): MealAnalysisResult | null {
  const response = readResponseField(raw);
  if (response === null) return null;
  let candidate: unknown = response;
  if (typeof response === "string") {
    try {
      candidate = JSON.parse(response);
    } catch {
      return null;
    }
  }
  const parsed = mealAnalysisResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function readResponseField(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return null;

  if (Reflect.has(raw, "response")) {
    return readUnknownField(raw, "response");
  }

  const choices = readUnknownField(raw, "choices");
  if (isUnknownArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === "object" && first !== null) {
      const message = readUnknownField(first, "message");
      if (typeof message === "object" && message !== null) {
        const parsed = readUnknownField(message, "parsed");
        if (parsed !== undefined && parsed !== null) return parsed;
        const content = readUnknownField(message, "content");
        if (typeof content === "string") return stripCodeFence(content);
        if (isUnknownArray(content)) {
          const combined = content
            .map((part) => {
              if (typeof part !== "object" || part === null) return "";
              const value = readUnknownField(part, "text");
              return typeof value === "string" ? value : "";
            })
            .join("");
          if (combined) return stripCodeFence(combined);
        }
      }

      const text = readUnknownField(first, "text");
      if (typeof text === "string") return stripCodeFence(text);
    }
  }

  return raw;
}

function readUnknownField(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function isGenericAiBinding(value: unknown): value is GenericAiBinding {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "run") === "function"
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

function fallbackTextResult(description: string, note: string): MealAnalysisResult {
  const candidateNameHe = description.trim().slice(0, 160) || "רכיב להזנה ידנית";
  return {
    analysisVersion: "meal-text-fallback-v2",
    detectedItems: [
      {
        temporaryId: crypto.randomUUID(),
        candidateNameHe,
        estimatedQuantity: null,
        estimatedUnit: null,
        estimatedGrams: null,
        foodIdentityConfidence: "medium",
        quantityConfidence: "low",
        nutritionConfidence: "low",
        nutritionSource: "ai_estimate",
        plausibleCaloriesMin: null,
        plausibleCaloriesMax: null,
        notes: [note],
      },
    ],
    overallConfidence: "low",
    clarificationQuestions: [
      {
        questionId: "manual-split",
        questionHe: "האם תרצה לפצל את התיאור למספר רכיבים?",
      },
    ],
    needsAnotherImage: false,
  };
}

function disabledResult(
  note = "הניתוח האוטומטי אינו זמין כרגע. אפשר לתקן ולשמור ידנית.",
): MealAnalysisResult {
  return {
    analysisVersion: "disabled-provider-v1",
    detectedItems: [
      {
        temporaryId: crypto.randomUUID(),
        candidateNameHe: "פריט שלא זוהה",
        estimatedQuantity: null,
        estimatedUnit: null,
        estimatedGrams: null,
        foodIdentityConfidence: "low",
        quantityConfidence: "low",
        nutritionConfidence: "low",
        nutritionSource: "ai_estimate",
        plausibleCaloriesMin: null,
        plausibleCaloriesMax: null,
        notes: [note],
      },
    ],
    overallConfidence: "low",
    clarificationQuestions: [{ questionId: "manual-entry", questionHe: "מה מופיע בארוחה?" }],
    needsAnotherImage: false,
  };
}
