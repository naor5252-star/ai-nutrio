import { Hono } from "hono";
import { requireAuth } from "../auth/session";
import type { AppEnv } from "../context";
import { logEvent } from "../services/logger";

type GenericAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type ModelCheck = {
  status: "ok" | "failed" | "skipped";
  durationMs: number | null;
  responsePreview: string | null;
  error: string | null;
};

export const aiDiagnosticsRoutes = new Hono<AppEnv>();
aiDiagnosticsRoutes.use("*", requireAuth);

aiDiagnosticsRoutes.get("/", async (context) => {
  context.header("Cache-Control", "no-store");

  const correlationId = context.get("correlationId");
  const user = context.get("user");
  const aiEnabled = context.env.AI_ENABLED === "true";
  const aiValue: unknown = context.env.AI;
  const bindingAvailable = isGenericAiBinding(aiValue);

  const configuration = {
    aiEnabled,
    aiEnabledValue: context.env.AI_ENABLED,
    bindingAvailable,
    fastModel: context.env.AI_FAST_MODEL,
    strongModel: context.env.AI_STRONG_MODEL,
  };

  if (!aiEnabled || !bindingAvailable) {
    const skipped: ModelCheck = {
      status: "skipped",
      durationMs: null,
      responsePreview: null,
      error: !aiEnabled
        ? `AI_ENABLED is ${JSON.stringify(context.env.AI_ENABLED)}`
        : "AI binding is unavailable",
    };

    logEvent({
      severity: "warn",
      event: "ai_diagnostics_unavailable",
      correlationId,
      userId: user.id,
      outcome: "skipped",
      retryable: false,
      details: {
        aiEnabled,
        bindingAvailable,
        fastModel: context.env.AI_FAST_MODEL,
        strongModel: context.env.AI_STRONG_MODEL,
      },
    });

    return context.json({
      ok: false,
      checkedAt: new Date().toISOString(),
      correlationId,
      configuration,
      checks: {
        fast: skipped,
        strong: skipped,
      },
    });
  }

  const fast = await testModel(aiValue, context.env.AI_FAST_MODEL);
  const strong = await testModel(aiValue, context.env.AI_STRONG_MODEL);
  const ok = fast.status === "ok" && strong.status === "ok";

  logEvent({
    severity: ok ? "info" : "warn",
    event: "ai_diagnostics_completed",
    correlationId,
    userId: user.id,
    outcome: ok ? "ok" : "failed",
    retryable: !ok,
    details: {
      fastStatus: fast.status,
      strongStatus: strong.status,
      fastDurationMs: fast.durationMs,
      strongDurationMs: strong.durationMs,
      fastModel: context.env.AI_FAST_MODEL,
      strongModel: context.env.AI_STRONG_MODEL,
    },
  });

  return context.json({
    ok,
    checkedAt: new Date().toISOString(),
    correlationId,
    configuration,
    checks: {
      fast,
      strong,
    },
  });
});

async function testModel(
  ai: GenericAiBinding,
  model: string,
): Promise<ModelCheck> {
  const startedAt = Date.now();

  try {
    const raw = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: "Return a very short plain-text response.",
        },
        {
          role: "user",
          content: "Reply with exactly: AI_OK",
        },
      ],
      temperature: 0,
      max_tokens: 64,
    });

    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      responsePreview: previewRaw(raw),
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      responsePreview: null,
      error: errorMessage(error),
    };
  }
}

function isGenericAiBinding(value: unknown): value is GenericAiBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof Reflect.get(value, "run") === "function"
  );
}

function previewRaw(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1_500);
  } catch {
    return String(value).slice(0, 1_500);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 1_000);
  }

  return String(error).slice(0, 1_000);
}
