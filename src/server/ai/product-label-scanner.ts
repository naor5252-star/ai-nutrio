import { z } from "zod";
import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

const nullableNutrient = z
  .number()
  .finite()
  .nonnegative()
  .nullable()
  .catch(null);

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
  servingWeight: z
    .number()
    .finite()
    .positive()
    .max(10_000)
    .nullable()
    .catch(null),
  nutrients: z.object({
    energyKcal: nullableNutrient,
    protein: nullableNutrient,
    carbohydrate: nullableNutrient,
    fat: nullableNutrient,
    fiber: nullableNutrient,
  }),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
  warningsHe: z.array(z.string().max(240)).max(10).catch([]),
});

export type ProductLabelResult = z.infer<typeof productLabelResultSchema>;

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export async function scanProductLabel(options: {
  env: RuntimeEnv;
  contentType: string;
  bytes: ArrayBuffer;
  correlationId: string;
}): Promise<ProductLabelResult> {
  if (options.env.AI_ENABLED !== "true" || !isAiBinding(options.env.AI)) {
    throw new Error("Workers AI is not available");
  }

  try {
    const raw = await options.env.AI.run(options.env.AI_FAST_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You read packaged-food labels. Return JSON only. Never invent a value that is not visible. Use null for missing values.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "קרא את צילום המוצר או התווית.",
                "חלץ שם מוצר מוצע בעברית, מותג, ברקוד אם הוא נראה, והערכים התזונתיים לפי 100 גרם או 100 מ״ל.",
                "אם התווית היא למנה בלבד, שמור את משקל המנה ונסה לנרמל ל-100 רק כאשר ניתן לחשב בוודאות.",
                "החזר אובייקט JSON עם המפתחות suggestedNameHe, brand, barcode, baseQuantity, baseUnit, servingDescriptionHe, servingWeight, nutrients, confidence, warningsHe.",
                "בתוך nutrients החזר energyKcal, protein, carbohydrate, fat, fiber. ערך שאינו נראה חייב להיות null.",
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
      max_tokens: 1_400,
      temperature: 0.1,
    });

    const candidate = extractCandidate(raw);
    if (candidate === null)
      throw new Error("AI label scan returned invalid JSON");

    const parsed = productLabelResultSchema.safeParse(candidate);
    if (!parsed.success)
      throw new Error("AI label scan did not match the expected schema");
    return parsed.data;
  } catch (error) {
    logEvent({
      severity: "error",
      event: "product_label_scan_failed",
      correlationId: options.correlationId,
      outcome: error instanceof Error ? error.name : "unknown",
      retryable: true,
      details: {
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown label scan error",
        model: options.env.AI_FAST_MODEL,
      },
    });
    throw error;
  }
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
