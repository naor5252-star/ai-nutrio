import { z } from "zod";
import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

const nullableNutrient = z.number().finite().nonnegative().nullable().catch(null);
const nutrientConfidence = z.enum(["high", "medium", "low", "missing"]).catch("missing");

const productLabelResultSchema = z.object({
  suggestedNameHe: z.string().trim().max(160).nullable().catch(null),
  brand: z.string().trim().max(120).nullable().catch(null),
  barcode: z
    .string()
    .regex(/^\d{8,14}$/u)
    .nullable()
    .catch(null),
  baseQuantity: z.number().finite().positive().max(10_000).catch(100),
  baseUnit: z.enum(["g", "ml"]).catch("g"),
  servingDescriptionHe: z.string().trim().max(120).nullable().catch(null),
  servingWeight: z.number().finite().positive().max(10_000).nullable().catch(null),
  nutrients: z.object({
    energyKcal: nullableNutrient,
    protein: nullableNutrient,
    carbohydrate: nullableNutrient,
    fat: nullableNutrient,
    fiber: nullableNutrient,
  }),
  nutrientConfidence: z.object({
    energyKcal: nutrientConfidence,
    protein: nutrientConfidence,
    carbohydrate: nutrientConfidence,
    fat: nutrientConfidence,
    fiber: nutrientConfidence,
  }),
  detectedBasis: z.enum(["per_100g", "per_100ml", "per_serving", "unknown"]).catch("unknown"),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
  warningsHe: z.array(z.string().max(240)).max(10).catch([]),
});

const compactProductLabelAiSchema = z.object({
  basis: z.enum(["per_100g", "per_100ml", "per_serving", "unknown"]),
  baseQuantity: z.number().finite().positive().max(10_000).nullable(),
  baseUnit: z.enum(["g", "ml"]),
  servingWeight: z.number().finite().positive().max(10_000).nullable(),
  nutrients: z.object({
    energyKcal: nullableNutrient,
    protein: nullableNutrient,
    carbohydrate: nullableNutrient,
    fat: nullableNutrient,
    fiber: nullableNutrient,
  }),
  confidence: z.enum(["high", "medium", "low"]),
  warningsHe: z.array(z.string().max(240)).max(10).catch([]),
});

type CompactProductLabelAiResult = z.infer<typeof compactProductLabelAiSchema>;

export type ProductLabelResult = z.infer<typeof productLabelResultSchema>;

export type ProductLabelDebug = {
  stage: "ai" | "extract" | "schema" | "validate" | "complete";
  model: string;
  rawPreview: string | null;
  rawContent: string | null;
  finishReason: string | null;
  candidate: unknown;
  schemaIssues: string[];
  normalized: ProductLabelResult | null;
  error: string | null;
};

export class ProductLabelScanError extends Error {
  readonly debug: ProductLabelDebug;

  constructor(message: string, debug: ProductLabelDebug) {
    super(message);
    this.name = "ProductLabelScanError";
    this.debug = debug;
  }
}

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export async function scanProductLabel(options: {
  env: RuntimeEnv;
  contentType: string;
  bytes: ArrayBuffer;
  correlationId: string;
}): Promise<ProductLabelResult & { debug: ProductLabelDebug }> {
  let stage: ProductLabelDebug["stage"] = "ai";
  let raw: unknown = null;
  let candidate: unknown = null;
  let schemaIssues: string[] = [];
  let normalized: ProductLabelResult | null = null;

  if (options.env.AI_ENABLED !== "true" || !isAiBinding(options.env.AI)) {
    throw new ProductLabelScanError("Workers AI is not available", {
      stage,
      model: options.env.AI_STRONG_MODEL,
      rawPreview: null,
      rawContent: null,
      finishReason: null,
      candidate: null,
      schemaIssues: [],
      normalized: null,
      error: "Workers AI is not available",
    });
  }

  try {
    raw = await runProductLabelModel(options, false);
    candidate = extractCandidate(raw);

    if (candidate === null && extractFinishReason(raw) === "length") {
      raw = await runProductLabelModel(options, true);
      candidate = extractCandidate(raw);
    }

    stage = "extract";
    if (candidate === null) {
      const finishReason = extractFinishReason(raw);
      if (finishReason === "length") {
        throw new Error("AI output ended at the token limit before returning JSON");
      }
      throw new Error("AI label scan returned invalid JSON");
    }

    stage = "schema";
    const compactParsed = compactProductLabelAiSchema.safeParse(candidate);
    if (!compactParsed.success) {
      schemaIssues = compactParsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      );
      throw new Error("AI label scan did not match the compact response schema");
    }

    const mappedCandidate = mapCompactLabelResult(compactParsed.data);
    const parsed = productLabelResultSchema.safeParse(mappedCandidate);
    if (!parsed.success) {
      schemaIssues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      );
      throw new Error("AI label scan did not match the expected schema");
    }

    stage = "validate";
    normalized = normalizeLabelResult(parsed.data);
    if (!Object.values(normalized.nutrients).some((value) => value !== null)) {
      throw new Error("AI label scan did not find any supported nutrition value");
    }

    return {
      ...normalized,
      debug: {
        stage: "complete",
        model: options.env.AI_STRONG_MODEL,
        rawPreview: previewRaw(raw),
        rawContent: extractRawContent(raw),
        finishReason: extractFinishReason(raw),
        candidate,
        schemaIssues,
        normalized,
        error: null,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown label scan error";
    const debug: ProductLabelDebug = {
      stage,
      model: options.env.AI_STRONG_MODEL,
      rawPreview: previewRaw(raw),
      rawContent: extractRawContent(raw),
      finishReason: extractFinishReason(raw),
      candidate,
      schemaIssues,
      normalized,
      error: errorMessage,
    };

    logEvent({
      severity: "error",
      event: "product_label_scan_failed",
      correlationId: options.correlationId,
      outcome: error instanceof Error ? error.name : "unknown",
      retryable: true,
      details: {
        errorMessage: errorMessage.slice(0, 500),
        model: options.env.AI_STRONG_MODEL,
        stage,
        schemaIssues: schemaIssues.slice(0, 10).join(" | "),
      },
    });
    throw new ProductLabelScanError(errorMessage, debug);
  }
}

function previewRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.slice(0, 50_000);
  } catch {
    return "[unserializable AI response]";
  }
}

async function runProductLabelModel(
  options: {
    env: RuntimeEnv;
    contentType: string;
    bytes: ArrayBuffer;
    correlationId: string;
  },
  retryAfterTruncation: boolean,
): Promise<unknown> {
  if (!isAiBinding(options.env.AI)) throw new Error("Workers AI is not available");

  return options.env.AI.run(
    options.env.AI_STRONG_MODEL,
    createProductLabelPayload(options.contentType, options.bytes, retryAfterTruncation),
  );
}

function createProductLabelPayload(
  contentType: string,
  bytes: ArrayBuffer,
  retryAfterTruncation: boolean,
): Record<string, unknown> {
  return {
    messages: [
      {
        role: "system",
        content:
          "You read nutrition tables from product-label images. Return only one compact JSON object. Do not return prose, markdown, code fences, or explanations. Read Hebrew, Arabic and English. Never guess an unreadable number.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "קרא רק את טבלת הסימון התזונתי שבתמונה.",
              'החזר בדיוק במבנה הזה: {"basis":"per_100g","baseQuantity":100,"baseUnit":"g","servingWeight":null,"nutrients":{"energyKcal":293,"protein":9.16,"carbohydrate":54.4,"fat":4,"fiber":null},"confidence":"high","warningsHe":[]}.',
              "basis חייב להיות אחד: per_100g, per_100ml, per_serving, unknown.",
              "אם קיימת עמודת 100 גרם או 100 מ״ל, השתמש רק בה לערכי nutrients. עבור 100 גרם החזר baseQuantity=100 ו-baseUnit=g; עבור 100 מ״ל החזר baseQuantity=100 ו-baseUnit=ml.",
              "אם אין 100 גרם/מ״ל ויש רק מנה, החזר basis=per_serving. שמור servingWeight אם משקל המנה נראה.",
              "מיפוי: אנרגיה בקק״ל -> energyKcal; חלבונים -> protein; סך הפחמימות -> carbohydrate; סך השומנים -> fat; סיבים תזונתיים -> fiber.",
              "אל תשתמש בסוכרים במקום פחמימות, בשומן רווי במקום שומן כולל, בנתרן כאנרגיה או בכפיות סוכר כאחד מחמשת ערכי nutrients.",
              "אם ערך אינו מופיע או אינו קריא בביטחון, החזר null. עדיף null על ניחוש.",
              "אל תזהה שם מוצר, מותג או ברקוד. אל תחזיר שדות נוספים.",
              retryAfterTruncation
                ? "זו בקשה חוזרת לאחר שהפלט נקטע. החזר מיד JSON קצר בלבד, ללא שום הסבר."
                : "בצע את הקריאה פנימית והחזר מיד את ה-JSON בלבד.",
            ].join(" "),
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${contentType};base64,${arrayBufferToBase64(bytes)}`,
            },
          },
        ],
      },
    ],
    reasoning_effort: "low",
    max_completion_tokens: retryAfterTruncation ? 5_000 : 3_000,
    temperature: 0,
  };
}

function mapCompactLabelResult(result: CompactProductLabelAiResult): ProductLabelResult {
  const baseQuantity =
    result.basis === "per_100g" || result.basis === "per_100ml"
      ? 100
      : (result.baseQuantity ?? result.servingWeight ?? 100);

  const baseUnit =
    result.basis === "per_100g"
      ? ("g" as const)
      : result.basis === "per_100ml"
        ? ("ml" as const)
        : result.baseUnit;

  const nutrientConfidence = {
    energyKcal: result.nutrients.energyKcal === null ? ("missing" as const) : result.confidence,
    protein: result.nutrients.protein === null ? ("missing" as const) : result.confidence,
    carbohydrate: result.nutrients.carbohydrate === null ? ("missing" as const) : result.confidence,
    fat: result.nutrients.fat === null ? ("missing" as const) : result.confidence,
    fiber: result.nutrients.fiber === null ? ("missing" as const) : result.confidence,
  };

  return {
    suggestedNameHe: null,
    brand: null,
    barcode: null,
    baseQuantity,
    baseUnit,
    servingDescriptionHe: null,
    servingWeight: result.servingWeight,
    nutrients: result.nutrients,
    nutrientConfidence,
    detectedBasis: result.basis,
    confidence: result.confidence,
    warningsHe: result.warningsHe,
  };
}

function extractRawContent(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return null;

  if (typeof raw.response === "string") return raw.response;

  const choices = raw.choices;
  if (!isUnknownArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;

  const content = first.message.content;
  if (typeof content === "string") return content;
  if (!isUnknownArray(content)) return null;

  const combined = content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");

  return combined || null;
}

function normalizeLabelResult(result: ProductLabelResult): ProductLabelResult {
  const nutrientConfidence = { ...result.nutrientConfidence };

  for (const key of ["energyKcal", "protein", "carbohydrate", "fat", "fiber"] as const) {
    if (result.nutrients[key] === null) nutrientConfidence[key] = "missing";
  }

  return {
    ...result,
    suggestedNameHe: null,
    brand: null,
    barcode: null,
    nutrientConfidence,
  };
}

function isAiBinding(value: unknown): value is GenericAiBinding {
  return isRecord(value) && typeof value.run === "function";
}

function extractFinishReason(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const choices = raw.choices;
  if (!isUnknownArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  return typeof first.finish_reason === "string" ? first.finish_reason : null;
}

function extractCandidate(raw: unknown): unknown {
  if (typeof raw === "string") return parseJsonText(raw);
  if (!isRecord(raw)) return null;

  const response = raw.response;
  if (typeof response === "string") return parseJsonText(response);
  if (isRecord(response)) return response;

  const choices = raw.choices;
  if (!isUnknownArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;

  const message = first.message;
  if (isRecord(message)) {
    const content = message.content;
    if (typeof content === "string") return parseJsonText(content);
    if (isUnknownArray(content)) {
      const combined = content
        .map((part) => {
          if (!isRecord(part)) return "";
          return typeof part.text === "string" ? part.text : "";
        })
        .join("")
        .trim();
      if (combined) return parseJsonText(combined);
    }
  }

  return typeof first.text === "string" ? parseJsonText(first.text) : null;
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(stripCodeFence(value)) as unknown;
  } catch {
    return null;
  }
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
