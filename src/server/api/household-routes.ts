import { Hono } from "hono";
import { z } from "zod";
import { emailSchema } from "../../shared/schemas/api";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { AppError } from "./errors";
import { addHoursIso, nowIso } from "../repositories/db";
import { randomToken, secureUuid, sha256Hex } from "../security/crypto";
import { requireHouseholdId } from "../domain/authorization";
import { sendApplicationEmail } from "../email/email-provider";

export const householdRoutes = new Hono<AppEnv>();
householdRoutes.use("*", requireAuth);

householdRoutes.get("/current", async (context) => {
  const user = context.get("user");
  if (!user.householdId) return context.json({ household: null, members: [] });
  const household = await context.env.DB.prepare(
    "SELECT id, name, created_at FROM households WHERE id = ?",
  )
    .bind(user.householdId)
    .first<Record<string, unknown>>();
  const members = await context.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name, hm.role, hm.joined_at FROM household_members hm JOIN users u ON u.id = hm.user_id WHERE hm.household_id = ?",
  )
    .bind(user.householdId)
    .all<Record<string, unknown>>();
  return context.json({ household, members: members.results });
});

householdRoutes.post("/", requireCsrf, async (context) => {
  const user = context.get("user");
  if (user.householdId)
    throw new AppError({
      status: 409,
      code: "HOUSEHOLD_EXISTS",
      messageHe: "כבר קיים משק בית לחשבון הזה",
    });
  const input = z
    .object({ name: z.string().trim().min(1).max(80).default("הבית שלנו") })
    .parse(await context.req.json().catch(() => ({})));
  const householdId = secureUuid();
  const now = nowIso();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO households (id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(householdId, input.name, user.id, now, now),
    context.env.DB.prepare(
      "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    ).bind(householdId, user.id, now),
    context.env.DB.prepare(
      "INSERT INTO shopping_lists (id, household_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(secureUuid(), householdId, now, now),
  ]);
  return context.json({ id: householdId, name: input.name }, 201);
});

householdRoutes.post("/invite", requireCsrf, async (context) => {
  const user = context.get("user");
  const householdId = requireHouseholdId(user.householdId);
  const input = z.object({ email: emailSchema }).parse(await context.req.json());
  if (input.email === user.email.toLowerCase())
    throw new AppError({
      status: 400,
      code: "INVITE_SELF",
      messageHe: "אי אפשר להזמין את אותה כתובת",
    });
  const token = randomToken(32);
  const now = nowIso();
  await context.env.DB.prepare(
    "INSERT INTO household_invitations (id, household_id, invited_email, invited_by_user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      secureUuid(),
      householdId,
      input.email,
      user.id,
      await sha256Hex(token),
      addHoursIso(24),
      now,
    )
    .run();
  const url = `${context.env.APP_BASE_URL}/household/invite?token=${encodeURIComponent(token)}`;
  const delivery = await sendApplicationEmail({
    env: context.env,
    correlationId: context.get("correlationId"),
    message: {
      to: input.email,
      subject: "הזמנה להצטרף למשק הבית ברגע טוב",
      text: `ההזמנה תקפה ל-24 שעות: ${url}`,
      html: `<div dir="rtl"><h1>הזמנה למשק הבית</h1><p><a href="${url}">הצטרפות לרגע טוב</a></p><p>ההזמנה תקפה ל-24 שעות.</p></div>`,
    },
  });
  return context.json({
    ok: true,
    ...(context.env.ENVIRONMENT !== "production" && !delivery.sent
      ? { developmentInvitationUrl: url }
      : {}),
  });
});

householdRoutes.post("/accept", requireCsrf, async (context) => {
  const user = context.get("user");
  if (user.householdId)
    throw new AppError({
      status: 409,
      code: "ALREADY_IN_HOUSEHOLD",
      messageHe: "החשבון כבר שייך למשק בית",
    });
  const input = z.object({ token: z.string().min(20).max(200) }).parse(await context.req.json());
  const invitation = await context.env.DB.prepare(
    "SELECT id, household_id, invited_email FROM household_invitations WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(input.token), nowIso())
    .first<{ id: string; household_id: string; invited_email: string }>();
  if (!invitation || invitation.invited_email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError({
      status: 400,
      code: "INVITATION_INVALID",
      messageHe: "ההזמנה אינה תקינה, פגה או מיועדת לכתובת אחרת",
    });
  }
  const now = nowIso();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
    ).bind(invitation.household_id, user.id, now),
    context.env.DB.prepare(
      "UPDATE household_invitations SET accepted_at = ?, accepted_by_user_id = ? WHERE id = ? AND accepted_at IS NULL",
    ).bind(now, user.id, invitation.id),
  ]);
  return context.json({ ok: true, householdId: invitation.household_id });
});
