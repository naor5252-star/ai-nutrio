import {
  mealAnalysisResultSchema,
  type MealAnalysisResult,
} from "../../shared/schemas/meal-analysis";
import type { RuntimeEnv } from "../context";

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

export async function analyzeMealImages(
  env: RuntimeEnv,
  images: ImageInput[],
): Promise<AiRouteResult> {
  if (env.AI_ENABLED !== "true")
    return { result: disabledResult(), model: null, route: "disabled" };
  const aiValue: unknown = env.AI;
  if (!isGenericAiBinding(aiValue))
    return { result: disabledResult(), model: null, route: "disabled" };

  const fastModel = env.AI_FAST_MODEL;
  const fastRaw = await aiValue.run(fastModel, createVisionPayload(images, false));
  const fastParsed = parseModelResponse(fastRaw);
  if (fastParsed && !needsEscalation(fastParsed)) {
    return { result: fastParsed, model: fastModel, route: "fast" };
  }

  const strongModel = env.AI_STRONG_MODEL;
  const strongRaw = await aiValue.run(strongModel, createVisionPayload(images, true));
  const strongParsed = parseModelResponse(strongRaw);
  if (strongParsed) return { result: strongParsed, model: strongModel, route: "fast_then_strong" };
  if (fastParsed) return { result: fastParsed, model: fastModel, route: "fast" };
  return {
    result: disabledResult("המודל לא החזיר תשובה תקינה. אפשר להזין את הארוחה ידנית."),
    model: strongModel,
    route: "fast_then_strong",
  };
}

function createVisionPayload(images: ImageInput[], strong: boolean): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: [
        "נתח את התמונות כארוחה אחת. החזר JSON בלבד לפי הסכמה.",
        "אל תמציא ערכים מדויקים. כאשר הכמות או הזהות אינן ודאיות, השתמש בביטחון נמוך ובטווח סביר.",
        "פרק את הארוחה לרכיבים נפרדים. הנח שכל המזון בתמונה נאכל.",
        strong
          ? "בדוק במיוחד סתירות בין זוויות, מנות מורכבות ורטבים גלויים."
          : "בצע זיהוי ראשוני מהיר.",
      ].join(" "),
    },
  ];
  for (const image of images.slice(0, 4)) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.contentType};base64,${arrayBufferToBase64(image.bytes)}` },
    });
  }
  return {
    messages: [
      {
        role: "system",
        content:
          "You are a cautious nutrition image analyzer. Return Hebrew food names and never diagnose.",
      },
      { role: "user", content },
    ],
    max_tokens: 2_500,
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "meal_analysis",
        strict: true,
        schema: {
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
                  alternativeCandidates: { type: "array", items: { type: "string" } },
                  estimatedQuantity: { type: ["number", "null"] },
                  estimatedUnit: { type: ["string", "null"] },
                  estimatedGrams: { type: ["number", "null"] },
                  foodIdentityConfidence: { type: "string", enum: ["high", "medium", "low"] },
                  quantityConfidence: { type: "string", enum: ["high", "medium", "low"] },
                  nutritionConfidence: { type: "string", enum: ["high", "medium", "low"] },
                  plausibleCaloriesMin: { type: ["number", "null"] },
                  plausibleCaloriesMax: { type: ["number", "null"] },
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
                ],
              },
            },
            overallConfidence: { type: "string", enum: ["high", "medium", "low"] },
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
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === "object" && first !== null) {
      const message = readUnknownField(first, "message");
      if (typeof message === "object" && message !== null) {
        const content = readUnknownField(message, "content");
        if (typeof content === "string") return stripCodeFence(content);
        if (Array.isArray(content)) {
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

function needsEscalation(result: MealAnalysisResult): boolean {
  return (
    result.overallConfidence === "low" ||
    result.needsAnotherImage ||
    result.detectedItems.length > 8 ||
    result.detectedItems.some(
      (item) => item.foodIdentityConfidence === "low" || item.quantityConfidence === "low",
    )
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
