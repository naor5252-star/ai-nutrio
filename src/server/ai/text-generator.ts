import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export async function generateCoachReply(options: {
  env: RuntimeEnv;
  userMessage: string;
  correlationId: string;
}): Promise<string> {
  const fallback =
    "המאמן האישי אינו זמין כרגע. נסה שוב בעוד רגע — אם זה ממשיך, כדאי לבדוק את חיבור ה-AI.";

  if (options.env.AI_ENABLED !== "true" || !isAiBinding(options.env.AI)) {
    return fallback;
  }

  const models = [...new Set(
    [options.env.AI_STRONG_MODEL, options.env.AI_FAST_MODEL]
      .map((model) => model.trim())
      .filter(Boolean),
  )];

  for (const model of models) {
    try {
      const raw = await options.env.AI.run(model, {
        messages: [
          {
            role: "system",
            content:
              "אתה המאמן האישי של אפליקציית 'רגע טוב'. ענה בעברית טבעית, חמה, מעשית ולא שיפוטית. אל תמציא נתונים ואל תשתמש בשפה של עונש, פיצוי או אוכל אסור.",
          },
          { role: "user", content: options.userMessage },
        ],
        max_tokens: 700,
        temperature: 0.4,
      });

      const response = extractText(raw);
      if (!response) throw new Error("AI model returned no readable text");

      if (model !== options.env.AI_STRONG_MODEL) {
        logEvent({
          severity: "warn",
          event: "coach_ai_fallback_model_succeeded",
          correlationId: options.correlationId,
          outcome: "success",
          retryable: false,
          details: { model, preferredModel: options.env.AI_STRONG_MODEL },
        });
      }

      return response;
    } catch (error) {
      logEvent({
        severity: "error",
        event: "coach_ai_model_failed",
        correlationId: options.correlationId,
        outcome: error instanceof Error ? error.name : "unknown",
        retryable: true,
        details: {
          errorMessage:
            error instanceof Error ? error.message.slice(0, 500) : "Unknown AI provider error",
          model,
        },
      });
    }
  }

  return fallback;
}

function isAiBinding(value: unknown): value is GenericAiBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "run") === "function"
  );
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function extractText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;

  for (const key of ["response", "output_text", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (record.result && typeof record.result === "object") {
    const result = record.result as Record<string, unknown>;
    for (const key of ["response", "output_text", "text", "content"]) {
      const value = result[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  let choices: unknown[] = [];
  if (isUnknownArray(record.choices)) {
    choices = record.choices;
  } else if (record.result && typeof record.result === "object") {
    const result = record.result as Record<string, unknown>;
    if (isUnknownArray(result.choices)) choices = result.choices;
  }

  const first = choices[0];
  if (!first || typeof first !== "object") return null;

  const choice = first as Record<string, unknown>;
  const message = choice.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    const text = readContent(content);
    if (text) return text;
  }

  return readContent(choice.text);
}

function readContent(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isUnknownArray(value)) return null;

  const combined = value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string"
        ? record.text
        : typeof record.content === "string"
          ? record.content
          : "";
    })
    .join("")
    .trim();

  return combined || null;
}
