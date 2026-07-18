import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { secureUuid } from "./crypto";

export const correlationMiddleware: MiddlewareHandler<AppEnv> = async (context, next) => {
  const incoming = context.req.header("x-correlation-id");
  const correlationId = incoming && incoming.length <= 100 ? incoming : secureUuid();
  context.set("correlationId", correlationId);
  await next();
  context.header("x-correlation-id", correlationId);
};

export const securityHeadersMiddleware: MiddlewareHandler<AppEnv> = async (context, next) => {
  await next();
  context.header("x-content-type-options", "nosniff");
  context.header("referrer-policy", "strict-origin-when-cross-origin");
  context.header("permissions-policy", "camera=(self), microphone=(), geolocation=()");
  context.header("cross-origin-opener-policy", "same-origin");
  context.header(
    "content-security-policy",
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://accounts.google.com https://oauth2.googleapis.com; frame-src https://challenges.cloudflare.com; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
  );
};
