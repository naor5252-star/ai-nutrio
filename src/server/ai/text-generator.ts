import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type Attempt = {
  model: string;
  label: string;
  input: Record<string, unknown>;
};

type ExtractedCompletion = {
  content: string | null;
  finishReason: string | null;
  hadReasoning: boolean;
};

export async function generateCoachReply(options: {
  env: RuntimeEnv;
  userMessage: string;
  correlationId: string;
}): Promise<string> {
  const fallback =
    "המאמן האישי אינו זמין כרגע. נסה שוב בעוד רגע — אם זה ממשיך, כדאי לבדוק את חיבור ה-AI.";

  if (options.env.AI_ENABLED !== "true" || !isAiBinding(options.env.AI)) {
    logEvent({
      severity: "error",
      event: "coach_ai_unavailable",
      correlationId: options.correlationId,
      outcome: "configuration_unavailable",
      retryable: true,
      details: {
        aiEnabled: options.env.AI_ENABLED,
        bindingAvailable: isAiBinding(options.env.AI),
      },
    });
    return fallback;
  }

  const messages = [
    {
      role: "system",
      content:
        "אתה המאמן האישי של אפליקציית 'רגע טוב'. ענה בעברית טבעית, חמה, מעשית ולא שיפוטית. אל תמציא נתונים. אל תשתמש בשפה של עונש, פיצוי או אוכל אסור. החזר תשובה סופית למשתמש בלבד; אל תחזיר reasoning, thoughts או ניתוח פנימי.",
    },
    { role: "user", content: options.userMessage },
  ];

  const attempts = buildAttempts(options.env, messages);

  for (const attempt of attempts) {
    try {
      const raw = await options.env.AI.run(attempt.model, attempt.input);
      const extracted = extractCompletion(raw);

      if (extracted.content) {
        if (attempt.label !== "fast-primary") {
          logEvent({
            severity: "warn",
            event: "coach_ai_retry_succeeded",
            correlationId: options.correlationId,
            outcome: "success",
            retryable: false,
            details: {
              attempt: attempt.label,
              model: attempt.model,
              finishReason: extracted.finishReason,
            },
          });
        }

        return extracted.content;
      }

      logEvent({
        severity: "warn",
        event: "coach_ai_empty_final",
        correlationId: options.correlationId,
        outcome: extracted.finishReason ?? "empty",
        retryable: true,
        details: {
          attempt: attempt.label,
          model: attempt.model,
          finishReason: extracted.finishReason,
          hadReasoning: extracted.hadReasoning,
        },
      });
    } catch (error) {
      logEvent({
        severity: "error",
        event: "coach_ai_model_failed",
        correlationId: options.correlationId,
        outcome: error instanceof Error ? error.name : "unknown",
        retryable: true,
        details: {
          attempt: attempt.label,
          model: attempt.model,
          errorMessage:
            error instanceof Error ? error.message.slice(0, 500) : "Unknown AI provider error",
        },
      });
    }
  }

  return fallback;
}

function buildAttempts(
  env: RuntimeEnv,
  messages: Array<{ role: string; content: string }>,
): Attempt[] {
  const attempts: Attempt[] = [];

  if (env.AI_FAST_MODEL.trim()) {
    attempts.push({
      model: env.AI_FAST_MODEL,
      label: "fast-primary",
      input: {
        messages,
        max_completion_tokens: 900,
        reasoning_effort: "low",
        temperature: 0.35,
      },
    });
  }

  if (env.AI_STRONG_MODEL.trim()) {
    attempts.push({
      model: env.AI_STRONG_MODEL,
      label: "strong-no-thinking",
      input: {
        messages,
        max_completion_tokens: 1_200,
        reasoning_effort: "low",
        chat_template_kwargs: {
          enable_thinking: false,
        },
        temperature: 0.35,
      },
    });
  }

  if (env.AI_FAST_MODEL.trim()) {
    attempts.push({
      model: env.AI_FAST_MODEL,
      label: "fast-simple-retry",
      input: {
        messages,
        max_completion_tokens: 1_400,
        temperature: 0.25,
      },
    });
  }

  return attempts;
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

function extractCompletion(raw: unknown): ExtractedCompletion {
  if (typeof raw === "string") {
    return {
      content: cleanText(raw),
      finishReason: null,
      hadReasoning: false,
    };
  }

  if (!raw || typeof raw !== "object") {
    return {
      content: null,
      finishReason: null,
      hadReasoning: false,
    };
  }

  const record = raw as Record<string, unknown>;

  for (const key of ["response", "output_text", "text"]) {
    const direct = cleanText(record[key]);
    if (direct) {
      return {
        content: direct,
        finishReason: null,
        hadReasoning: false,
      };
    }
  }

  const result = record.result;
  if (result && typeof result === "object") {
    const resultRecord = result as Record<string, unknown>;
    for (const key of ["response", "output_text", "text", "content"]) {
      const direct = cleanText(resultRecord[key]);
      if (direct) {
        return {
          content: direct,
          finishReason: null,
          hadReasoning: hasReasoning(resultRecord),
        };
      }
    }

    const nested = fromChoices(resultRecord.choices);
    if (nested.content || nested.hadReasoning || nested.finishReason) return nested;
  }

  return fromChoices(record.choices);
}

function fromChoices(value: unknown): ExtractedCompletion {
  if (!isUnknownArray(value) || value.length === 0) {
    return {
      content: null,
      finishReason: null,
      hadReasoning: false,
    };
  }

  const first: unknown = value[0];
  if (!first || typeof first !== "object") {
    return {
      content: null,
      finishReason: null,
      hadReasoning: false,
    };
  }

  const choice = first as Record<string, unknown>;
  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : null;

  const message = choice.message;
  if (message && typeof message === "object") {
    const messageRecord = message as Record<string, unknown>;
    return {
      content: cleanText(messageRecord.content),
      finishReason,
      hadReasoning: hasReasoning(messageRecord),
    };
  }

  return {
    content: cleanText(choice.text),
    finishReason,
    hadReasoning: hasReasoning(choice),
  };
}

function hasReasoning(record: Record<string, unknown>): boolean {
  for (const key of ["reasoning_content", "reasoning"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return true;
  }

  return false;
}

function cleanText(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned || null;
  }

  if (!isUnknownArray(value)) return null;

  const combined = value
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";

      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .join("")
    .trim();

  return combined || null;
}
