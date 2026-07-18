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
    "המאמן האישי אינו זמין כרגע. אפשר עדיין להשתמש ביומן וביעדים, ולנסות שוב בעוד כמה דקות.";

  if (options.env.AI_ENABLED !== "true" || !isAiBinding(options.env.AI)) {
    return fallback;
  }

  try {
    const raw = await options.env.AI.run(options.env.AI_STRONG_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "אתה מאמן תזונה כללי בעברית. היה ידידותי, מעשי ולא שיפוטי. אל תאבחן ואל תטפל במחלות. אל תמציא ערכים תזונתיים מדויקים. כאשר חסר מידע, אמור זאת בבירור. אל תשתמש בשפה של עונש, פיצוי או אוכל אסור.",
        },
        { role: "user", content: options.userMessage },
      ],
      max_completion_tokens: 700,
      temperature: 0.35,
      chat_template_kwargs: { thinking: false },
    });

    const response = extractText(raw);
    if (!response) throw new Error("AI model returned no text");
    return response;
  } catch (error) {
    logEvent({
      severity: "error",
      event: "coach_ai_failed",
      correlationId: options.correlationId,
      outcome: error instanceof Error ? error.name : "unknown",
      retryable: true,
      details: {
        errorMessage:
          error instanceof Error ? error.message.slice(0, 500) : "Unknown AI provider error",
        model: options.env.AI_STRONG_MODEL,
      },
    });
    return fallback;
  }
}

function isAiBinding(value: unknown): value is GenericAiBinding {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "run") === "function"
  );
}

function readUnknownField(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function extractText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw !== "object" || raw === null) return null;

  const response = readUnknownField(raw, "response");
  if (typeof response === "string") return response.trim() || null;

  const choices = readUnknownField(raw, "choices");
  if (!isUnknownArray(choices) || choices.length === 0) return null;

  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;

  const message = readUnknownField(first, "message");
  if (typeof message === "object" && message !== null) {
    const content = readUnknownField(message, "content");
    if (typeof content === "string") return content.trim() || null;
    if (isUnknownArray(content)) {
      const combined = content
        .map((part) => {
          if (typeof part !== "object" || part === null) return "";
          const text = readUnknownField(part, "text");
          return typeof text === "string" ? text : "";
        })
        .join("")
        .trim();
      return combined || null;
    }
  }

  const text = readUnknownField(first, "text");
  return typeof text === "string" && text.trim() ? text.trim() : null;
}
