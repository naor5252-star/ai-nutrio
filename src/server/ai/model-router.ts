import { z } from "zod";
import type { MealAnalysisResult } from "../../shared/schemas/meal-analysis";
import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

export type ImageInput = {
  contentType: string;
  bytes: ArrayBuffer;
};

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

const simpleMealAiResultSchema = z.object({
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

type SimpleMealAiResult = z.infer<typeof simpleMealAiResultSchema>;

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

  const strongModel = env.AI_STRONG_MODEL;
  let strongRaw = await tryRunAiModel(
    aiValue,
    strongModel,
    createVisionPayload(images, false),
    "meal_image_strong_ai_failed",
  );
  let strongParsed = strongRaw === null ? null : parseSimpleMealModelResponse(strongRaw);

  if (!strongParsed && strongRaw !== null && readFinishReason(strongRaw) === "length") {
    const retryRaw = await tryRunAiModel(
      aiValue,
      strongModel,
      createVisionPayload(images, true),
      "meal_image_strong_ai_retry_failed",
    );
    if (retryRaw !== null) {
      strongRaw = retryRaw;
      strongParsed = parseSimpleMealModelResponse(retryRaw);
    }
  }

  const rawAiJson = strongRaw === null ? undefined : serializeRawModelOutput(strongRaw);
  const rawAiContent = strongRaw === null ? undefined : readRawModelContent(strongRaw);
  const rawAiFinishReason = strongRaw === null ? undefined : readFinishReason(strongRaw);

  if (strongParsed) {
    return {
      result: mapSimpleMealResult(
        strongParsed,
        "image",
        rawAiJson,
        rawAiContent,
        rawAiFinishReason,
      ),
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
  const fastAttempt = await runSimpleTextModel(aiValue, fastModel, description, "meal_text_fast_ai");

  if (fastAttempt.parsed) {
    return {
      result: mapSimpleMealResult(
        fastAttempt.parsed,
        "text",
        serializeRawModelOutput(fastAttempt.raw),
        readRawModelContent(fastAttempt.raw),
        readFinishReason(fastAttempt.raw),
      ),
      model: fastModel,
      route: "fast",
    };
  }

  const strongModel = env.AI_STRONG_MODEL;
  if (strongModel !== fastModel) {
    const strongAttempt = await runSimpleTextModel(
      aiValue,
      strongModel,
      description,
      "meal_text_strong_ai",
    );

    if (strongAttempt.parsed) {
      return {
        result: mapSimpleMealResult(
          strongAttempt.parsed,
          "text",
          serializeRawModelOutput(strongAttempt.raw),
          readRawModelContent(strongAttempt.raw),
          readFinishReason(strongAttempt.raw),
        ),
        model: strongModel,
        route: "fast_then_strong",
      };
    }

    return {
      result: attachRawAiDebug(
        fallbackTextResult(
          description,
          "ה־AI החזיר תשובה שלא הצלחנו לפרש. התגובה המקורית מוצגת למטה.",
        ),
        strongAttempt.raw ?? fastAttempt.raw,
      ),
      model: strongModel,
      route: "fast_then_strong",
    };
  }

  return {
    result: attachRawAiDebug(
      fallbackTextResult(
        description,
        "ה־AI החזיר תשובה שלא הצלחנו לפרש. התגובה המקורית מוצגת למטה.",
      ),
      fastAttempt.raw,
    ),
    model: fastModel,
    route: "fast",
  };
}

async function runSimpleTextModel(
  aiValue: GenericAiBinding,
  model: string,
  description: string,
  eventPrefix: string,
): Promise<{ raw: unknown; parsed: SimpleMealAiResult | null }> {
  let raw = await tryRunAiModel(
    aiValue,
    model,
    createTextPayload(description, false),
    `${eventPrefix}_failed`,
  );
  let parsed = raw === null ? null : parseSimpleMealModelResponse(raw);

  if (!parsed && raw !== null && readFinishReason(raw) === "length") {
    const retryRaw = await tryRunAiModel(
      aiValue,
      model,
      createTextPayload(description, true),
      `${eventPrefix}_retry_failed`,
    );
    if (retryRaw !== null) {
      raw = retryRaw;
      parsed = parseSimpleMealModelResponse(retryRaw);
    }
  }

  return { raw, parsed };
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

function createTextPayload(
  description: string,
  retryAfterTruncation: boolean,
): Record<string, unknown> {
  return {
    messages: [
      {
        role: "system",
        content:
          "You analyze written meal descriptions for nutrition logging. Your final answer must be only the requested compact JSON object, with Hebrew food names and no explanation.",
      },
      {
        role: "user",
        content: [
          `נתח את תיאור הארוחה הבא: "${description}".`,
          "אל תציג הסבר, reasoning, markdown או code fences בתשובה הסופית.",
          "החזר רק אובייקט JSON קומפקטי אחד.",
          'המבנה חייב להיות בדיוק: {"suggestedTitleHe":"כותרת קצרה בעברית","totals":{"calories":123,"protein":12,"carbohydrates":20,"fat":5,"fiber":3},"items":[{"name":"שם המאכל בעברית","grams":123,"nutrition":{"calories":123,"protein":12,"carbohydrates":20,"fat":5,"fiber":3}}]}.',
          "suggestedTitleHe צריך לתאר בקצרה את הארוחה כולה.",
          "totals חייב להיות סכום הערכים של כל הפריטים בארוחה.",
          "כלול רק מאכלים ומשקאות שהמשתמש כתב במפורש. אל תמציא פריטים שלא צוינו.",
          "אם המשתמש כתב כמות, משקל או יחידה — השתמש בהם.",
          "אם המשתמש לא כתב משקל, בצע best-effort estimate סביר לפי גודל מנה מקובל בישראל והחזר grams כמספר.",
          "לכל פריט החזר ערכים תזונתיים עבור כל הכמות שנאכלה — לא ל-100 גרם.",
          "החזר best-effort עבור קלוריות, חלבון, פחמימות, שומן וסיבים. אל תחזיר null.",
          "במנה מורכבת שהמשתמש כתב כשם מנה אחד, שמור אותה כפריט אחד אלא אם המשתמש פירט את הרכיבים בנפרד.",
          "אין להשתמש במאגר המזונות של האפליקציה ואין צורך להתאים למוצר קיים.",
          retryAfterTruncation
            ? "זו בקשה חוזרת אחרי תשובה שנקטעה: היה קצר במיוחד והחזר מיד את ה-JSON בלבד."
            : "בצע את החישוב פנימית ואז החזר מיד את ה-JSON בלבד.",
        ].join(" "),
      },
    ],
    response_format: { type: "json_object" },
    reasoning_effort: "low",
    max_completion_tokens: retryAfterTruncation ? 3_000 : 1_800,
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

function parseSimpleMealModelResponse(raw: unknown): SimpleMealAiResult | null {
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

  const parsed = simpleMealAiResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function mapSimpleMealResult(
  result: SimpleMealAiResult,
  source: "image" | "text",
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
      notes: [
        source === "image"
          ? "הערכה ישירה מתמונת הארוחה באמצעות AI."
          : "הערכה ישירה מתיאור הארוחה באמצעות AI.",
      ],
    };
  });

  return {
    analysisVersion: source === "image" ? "meal-image-ai-simple-v1" : "meal-text-ai-simple-v1",
    suggestedTitleHe: result.suggestedTitleHe,
    detectedItems,
    overallConfidence: "medium",
    needsAnotherImage: false,
    ...(rawAiJson ? { rawAiJson } : {}),
    ...(rawAiContent ? { rawAiContent } : {}),
    ...(rawAiFinishReason ? { rawAiFinishReason } : {}),
  };
}

function attachRawAiDebug(result: MealAnalysisResult, raw: unknown): MealAnalysisResult {
  if (raw === null) return result;
  const rawAiJson = serializeRawModelOutput(raw);
  const rawAiContent = readRawModelContent(raw);
  const rawAiFinishReason = readFinishReason(raw);
  return {
    ...result,
    ...(rawAiJson ? { rawAiJson } : {}),
    ...(rawAiContent ? { rawAiContent } : {}),
    ...(rawAiFinishReason ? { rawAiFinishReason } : {}),
  };
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
