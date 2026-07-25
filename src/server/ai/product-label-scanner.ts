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

export type ProductLabelResult = z.infer<typeof productLabelResultSchema>;

export type ProductLabelDebug = {
  stage: "ai" | "extract" | "schema" | "validate" | "complete";
  model: string;
  rawPreview: string | null;
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
      candidate: null,
      schemaIssues: [],
      normalized: null,
      error: "Workers AI is not available",
    });
  }

  try {
    raw = await options.env.AI.run(options.env.AI_STRONG_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a meticulous nutrition-table OCR specialist. Return JSON only. First understand table structure: identify row labels, column headers, and map each value to the correct row and column. Read Hebrew, Arabic and English. Preserve the printed basis. Never infer a number that is not visible. Do not identify the product, brand, or barcode. Partial extraction is valid and preferred over failure.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "קרא רק את טבלת הסימון התזונתי הנראית בתמונה.",
                "לפני חילוץ מספרים, זהה את כותרות העמודות ואת שורות הרכיבים. טבלה עשויה להכיל 100 גרם/100 מ״ל וגם מנה/חטיף בעמודות סמוכות.",
                "אם קיימת עמודת 100 גרם או 100 מ״ל, השתמש רק בה לערכי nutrients, הגדר baseQuantity=100 ו-baseUnit בהתאם, והחזר detectedBasis=per_100g או per_100ml.",
                "אם אין עמודת 100 גרם/מ״ל ויש רק מנה, השתמש בערכים המודפסים למנה, הגדר detectedBasis=per_serving ושמור servingWeight אם הוא נראה. אל תנרמל בניחוש.",
                "אנרגיה חייבת להיות kcal. אם מופיעים גם kJ וגם kcal, בחר רק kcal.",
                "מיפוי: סך השומנים -> fat, סך הפחמימות -> carbohydrate, חלבונים -> protein, סיבים תזונתיים -> fiber.",
                "אל תשתמש בשומן רווי במקום שומן כולל, בסוכרים במקום פחמימות, בנתרן כאנרגיה, או בכפיות סוכר כאחד מערכי nutrients.",
                "ערך שלא ניתן לקרוא בביטחון נשאר null. תא חסר לא מפיל את כל הסריקה.",
                "לכל nutrient החזר nutrientConfidence: high, medium, low או missing. missing חובה כאשר הערך null.",
                "אל תנסה לזהות מוצר, מותג או ברקוד. החזר תמיד suggestedNameHe=null, brand=null, barcode=null.",
                "החזר JSON עם suggestedNameHe, brand, barcode, baseQuantity, baseUnit, servingDescriptionHe, servingWeight, nutrients, nutrientConfidence, detectedBasis, confidence, warningsHe.",
                "בדיקת היגיון לדוגמה בלבד: אם בעמודת 100 גרם מופיעים 408 קלוריות, 14.5 שומן, 58 פחמימות, 11.1 סיבים ו-6.2 חלבון, אלו הערכים שיש לשייך לשדות המתאימים ולא לערכי המנה שבעמודה סמוכה.",
              ].join(" "),
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${options.contentType};base64,${arrayBufferToBase64(options.bytes)}`,
              },
            },
          ],
        },
      ],
      max_tokens: 1_800,
      temperature: 0.05,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "product_label_scan",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              suggestedNameHe: { type: ["string", "null"] },
              brand: { type: ["string", "null"] },
              barcode: { type: ["string", "null"] },
              baseQuantity: { type: "number" },
              baseUnit: { type: "string", enum: ["g", "ml"] },
              servingDescriptionHe: { type: ["string", "null"] },
              servingWeight: { type: ["number", "null"] },
              nutrients: {
                type: "object",
                additionalProperties: false,
                properties: {
                  energyKcal: { type: ["number", "null"] },
                  protein: { type: ["number", "null"] },
                  carbohydrate: { type: ["number", "null"] },
                  fat: { type: ["number", "null"] },
                  fiber: { type: ["number", "null"] },
                },
                required: ["energyKcal", "protein", "carbohydrate", "fat", "fiber"],
              },
              nutrientConfidence: {
                type: "object",
                additionalProperties: false,
                properties: {
                  energyKcal: { type: "string", enum: ["high", "medium", "low", "missing"] },
                  protein: { type: "string", enum: ["high", "medium", "low", "missing"] },
                  carbohydrate: { type: "string", enum: ["high", "medium", "low", "missing"] },
                  fat: { type: "string", enum: ["high", "medium", "low", "missing"] },
                  fiber: { type: "string", enum: ["high", "medium", "low", "missing"] },
                },
                required: ["energyKcal", "protein", "carbohydrate", "fat", "fiber"],
              },
              detectedBasis: {
                type: "string",
                enum: ["per_100g", "per_100ml", "per_serving", "unknown"],
              },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              warningsHe: { type: "array", items: { type: "string" } },
            },
            required: [
              "suggestedNameHe",
              "brand",
              "barcode",
              "baseQuantity",
              "baseUnit",
              "servingDescriptionHe",
              "servingWeight",
              "nutrients",
              "nutrientConfidence",
              "detectedBasis",
              "confidence",
              "warningsHe",
            ],
          },
        },
      },
    });

    stage = "extract";
    candidate = extractCandidate(raw);
    if (candidate === null) throw new Error("AI label scan returned invalid JSON");

    stage = "schema";
    const parsed = productLabelResultSchema.safeParse(candidate);
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
        schemaIssues: schemaIssues.slice(0, 10),
      },
    });
    throw new ProductLabelScanError(errorMessage, debug);
  }
}

function previewRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.slice(0, 8_000);
  } catch {
    return "[unserializable AI response]";
  }
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
