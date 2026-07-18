import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { SessionUser } from "../../shared/contracts/api";
import type { AppEnv } from "../context";
import { AppError } from "../api/errors";
import { addDaysIso, nowIso } from "../repositories/db";
import { randomToken, secureUuid, sha256Hex } from "../security/crypto";

const SESSION_COOKIE = "__Host-rega_tov_session";
const SESSION_DAYS = 30;

type SessionDbRow = {
  session_row_id: string;
  user_id: string;
  email: string;
  csrf_token: string;
  expires_at: string;
  household_id: string | null;
};

export async function createSession(
  context: Context<AppEnv>,
  userId: string,
): Promise<{ csrfToken: string }> {
  const rawToken = randomToken(32);
  const hash = await sha256Hex(rawToken);
  const csrfToken = randomToken(24);
  const id = secureUuid();
  const now = nowIso();
  const expiresAt = addDaysIso(SESSION_DAYS);
  const userAgent = context.req.header("user-agent") ?? "";
  const userAgentHash = await sha256Hex(userAgent);

  await context.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, session_hash, csrf_token, user_agent_hash, expires_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, hash, csrfToken, userAgentHash, expiresAt, now, now)
    .run();

  setCookie(context, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return { csrfToken };
}

export async function revokeCurrentSession(context: Context<AppEnv>): Promise<void> {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    await context.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
    )
      .bind(nowIso(), hash)
      .run();
  }
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true });
}

async function resolveSession(context: Context<AppEnv>): Promise<SessionDbRow | null> {
  const rawToken = getCookie(context, SESSION_COOKIE);
  if (!rawToken) return null;
  const hash = await sha256Hex(rawToken);
  return context.env.DB.prepare(
    `SELECT s.id AS session_row_id, u.id AS user_id, u.email, s.csrf_token, s.expires_at,
            hm.household_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
       LEFT JOIN household_members hm ON hm.user_id = u.id
      WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
  )
    .bind(hash, nowIso())
    .first<SessionDbRow>();
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (context, next) => {
  const row = await resolveSession(context);
  if (!row)
    throw new AppError({ status: 401, code: "AUTH_REQUIRED", messageHe: "צריך להתחבר כדי להמשיך" });
  const user: SessionUser = { id: row.user_id, email: row.email, householdId: row.household_id };
  context.set("user", user);
  context.set("sessionRowId", row.session_row_id);
  context.set("csrfToken", row.csrf_token);
  context.executionCtx.waitUntil(
    context.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(nowIso(), row.session_row_id)
      .run()
      .then(() => undefined),
  );
  await next();
};

export async function optionalSession(
  context: Context<AppEnv>,
): Promise<{ user: SessionUser; csrfToken: string } | null> {
  const row = await resolveSession(context);
  if (!row) return null;
  return {
    user: { id: row.user_id, email: row.email, householdId: row.household_id },
    csrfToken: row.csrf_token,
  };
}

export const requireCsrf: MiddlewareHandler<AppEnv> = async (context, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
    await next();
    return;
  }
  const supplied = context.req.header("x-csrf-token");
  if (!supplied || supplied !== context.get("csrfToken")) {
    throw new AppError({
      status: 403,
      code: "CSRF_FAILED",
      messageHe: "פג תוקף הפעולה. רענן את המסך ונסה שוב.",
    });
  }
  await next();
};
