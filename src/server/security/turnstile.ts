import { AppError } from "../api/errors";

export async function verifyTurnstile(options: {
  secret: string | undefined;
  token: string | undefined;
  remoteIp: string | undefined;
  idempotencyKey: string;
}): Promise<void> {
  if (!options.secret) return;
  if (!options.token) {
    throw new AppError({
      status: 400,
      code: "TURNSTILE_REQUIRED",
      messageHe: "צריך להשלים את בדיקת האבטחה",
    });
  }
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: options.secret,
      response: options.token,
      remoteip: options.remoteIp,
      idempotency_key: options.idempotencyKey,
    }),
  });
  const parsed: unknown = await response.json();
  if (!isTurnstileSuccess(parsed)) {
    throw new AppError({
      status: 400,
      code: "TURNSTILE_FAILED",
      messageHe: "בדיקת האבטחה לא הושלמה. נסה שוב.",
    });
  }
}

function isTurnstileSuccess(value: unknown): value is { success: true } {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "success") === true;
}
