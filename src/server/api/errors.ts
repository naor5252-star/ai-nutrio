import type { Context } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "../context";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageHe: string;
  readonly retryable: boolean;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(options: {
    status: number;
    code: string;
    messageHe: string;
    retryable?: boolean;
    fieldErrors?: Record<string, string[]>;
  }) {
    super(options.messageHe);
    this.name = "AppError";
    this.status = options.status;
    this.code = options.code;
    this.messageHe = options.messageHe;
    this.retryable = options.retryable ?? false;
    if (options.fieldErrors !== undefined) this.fieldErrors = options.fieldErrors;
  }
}

function zodFieldErrors(error: ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    result[key] = [...(result[key] ?? []), issue.message];
  }
  return result;
}

export function apiErrorResponse(context: Context<AppEnv>, error: unknown): Response {
  const correlationId = context.get("correlationId") ?? crypto.randomUUID();
  if (error instanceof AppError) {
    return context.json(
      {
        error: {
          code: error.code,
          messageHe: error.messageHe,
          correlationId,
          retryable: error.retryable,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
      },
      error.status as 400,
    );
  }
  if (error instanceof ZodError) {
    return context.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          messageHe: "יש כמה פרטים שצריך לתקן",
          correlationId,
          fieldErrors: zodFieldErrors(error),
          retryable: false,
        },
      },
      400,
    );
  }
  console.error(JSON.stringify({ severity: "error", event: "unhandled_error", correlationId }));
  return context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        messageHe: "לא הצלחנו להשלים את הפעולה. המידע שכבר נשמר לא אבד.",
        correlationId,
        retryable: true,
      },
    },
    500,
  );
}
