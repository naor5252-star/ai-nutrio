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
  const strongRaw = await tryRunAiModel(
    aiValue,
    strongModel,
    createVisionPayload(images, true),
    "meal_image_strong_ai_failed",
  );
  const strongParsed = strongRaw === null ? null : parseModelResponse(strongRaw);

  if (strongParsed) {
    return {
      result: strongParsed,
      model: strongModel,
      route: "fast_then_strong",
    };
  }

  return {
    result: disabledResult("המודל לא החזיר תשובה תקינה. אפשר להזין את הארוחה ידנית."),
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
  const basePayload = createVisionPayload([], strong);
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
    .join("\n");
  Reflect.deleteProperty(basePayload, "max_tokens");
  return {
    ...basePayload,
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
          "פצל רק מאכלים שהמשתמש ציין במפורש. אל תפרק מנה מוכנה למרכיבים פנימיים שלא צוינו.",
          "שמור כמויות ויחידות שנכתבו. המר לגרמים רק כאשר ההמרה סבירה וברורה.",
          "כאשר כמות חסרה, החזר estimatedQuantity ו-estimatedGrams כ-null וסמן quantityConfidence כ-low.",
          "החזר nutrition עם energyKcal, proteinGrams, carbohydrateGrams, fatGrams, fiberGrams עבור הכמות שזוהתה. ערך שלא ניתן להעריך סביר יהיה null.",
          "הערך טווח קלוריות שמרני. אל תנחש שמן, רוטב, תוספת, מותג או שיטת בישול שלא צוינו.",
          catalogText
            ? `מאגר מזונות זמין. העדף התאמה למאגר על פני הערכת AI כאשר השם מתאים:\n${catalogText}`
            : "לא הועבר מאגר מזונות זמין.",
          "החזר JSON בלבד לפי הסכמה.",
        ].join(" "),
      },
    ],
    max_tokens: strong ? 2_400 : 1_800,
    temperature: 0,
  };
}

function createVisionPayload(images: ImageInput[], strong: boolean): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: [
        "נתח את כל התמונות כארוחה אחת והחזר JSON בלבד לפי הסכמה.",
        "השתמש בכל הזוויות, אך אל תספור את אותו רכיב יותר מפעם אחת.",
        "זהה כל רכיב אכיל שנראה בתמונה בנפרד. במנה מורכבת הפרד רק רכיבים שניתן להבחין בהם חזותית; אחרת השאר אותה כמנה אחת.",
        "הערך כמות ומשקל בעזרת גודל הצלחת, הסכו״ם, האריזה והפרספקטיבה. אל תמציא דיוק שאינו נתמך בתמונה.",
        "התחשב במאכלים ובמידות מנה נפוצים בישראל, אך אל תנחש מותג או מרכיב נסתר.",
        "שמן, רוטב, ציפוי ושיטת בישול יש לציין רק כאשר יש להם סימן חזותי ברור. במקרה של ספק השתמש בביטחון נמוך ובטווח קלוריות רחב.",
        "לכל רכיב החזר nutrition עם קלוריות, חלבון, פחמימות, שומן וסיבים עבור הכמות שזוהתה. אלה ערכי fallback בלבד; השרת יעדיף את מאגר המזונות אם נמצאה התאמה.",
        strong
          ? "בצע בדיקה שנייה מכוונת: חפש רכיבים קטנים, רטבים, כפילויות בין תמונות וסתירות בין זהות, משקל וקלוריות."
          : "בצע מיפוי חזותי ראשוני זהיר לפני חישוב הכמויות.",
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
          "You are a precise, conservative food-vision specialist for meal logging. Return Hebrew food names, use all image evidence, avoid double counting, and never diagnose.",
      },
      { role: "user", content },
    ],
    max_tokens: strong ? 3_200 : 2_700,
    temperature: 0.05,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          analysisVersion: { type: "string" },
          detectedItems: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                temporaryId: { type: "string" },
                candidateNameHe: { type: "string" },
                candidateNameEn: { type: "string" },
                alternativeCandidates: {
                  type: "array",
                  items: { type: "string" },
                },
                estimatedQuantity: { type: ["number", "null"] },
                estimatedUnit: { type: ["string", "null"] },
                estimatedGrams: { type: ["number", "null"] },
                foodIdentityConfidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                quantityConfidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                nutritionConfidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                plausibleCaloriesMin: { type: ["number", "null"] },
                plausibleCaloriesMax: { type: ["number", "null"] },
                nutrition: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    energyKcal: { type: ["number", "null"] },
                    proteinGrams: { type: ["number", "null"] },
                    carbohydrateGrams: { type: ["number", "null"] },
                    fatGrams: { type: ["number", "null"] },
                    fiberGrams: { type: ["number", "null"] },
                  },
                  required: [
                    "energyKcal",
                    "proteinGrams",
                    "carbohydrateGrams",
                    "fatGrams",
                    "fiberGrams",
                  ],
                },
                notes: { type: "array", items: { type: "string" } },
              },
              required: [
                "temporaryId",
                "candidateNameHe",
                "estimatedQuantity",
                "estimatedUnit",
                "estimatedGrams",
                "foodIdentityConfidence",
                "quantityConfidence",
                "nutritionConfidence",
                "plausibleCaloriesMin",
                "plausibleCaloriesMax",
                "nutrition",
              ],
            },
          },
          overallConfidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          clarificationQuestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                questionId: { type: "string" },
                questionHe: { type: "string" },
                answerOptions: { type: "array", items: { type: "string" } },
              },
              required: ["questionId", "questionHe"],
            },
          },
          needsAnotherImage: { type: "boolean" },
          anotherImageReasonHe: { type: "string" },
        },
        required: ["analysisVersion", "detectedItems", "overallConfidence", "needsAnotherImage"],
      },
    },
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
