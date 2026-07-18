import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";

export const pushRoutes = new Hono<AppEnv>();
pushRoutes.use("*", requireAuth);

pushRoutes.get("/config", (context) =>
  context.json({ vapidPublicKey: context.env.VAPID_PUBLIC_KEY ?? null }),
);

pushRoutes.post("/subscriptions", requireCsrf, async (context) => {
  const input = z
    .object({
      endpoint: z.string().url().max(2_000),
      keys: z.object({ p256dh: z.string().min(1).max(1_000), auth: z.string().min(1).max(1_000) }),
    })
    .parse(await context.req.json());
  const user = context.get("user");
  const now = nowIso();
  await context.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, owner_user_id, endpoint, p256dh, auth_secret, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET owner_user_id = excluded.owner_user_id, p256dh = excluded.p256dh,
       auth_secret = excluded.auth_secret, user_agent = excluded.user_agent, invalidated_at = NULL`,
  )
    .bind(
      secureUuid(),
      user.id,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      context.req.header("user-agent") ?? null,
      now,
    )
    .run();
  return context.json({ ok: true }, 201);
});

pushRoutes.delete("/subscriptions", requireCsrf, async (context) => {
  const input = z.object({ endpoint: z.string().url().max(2_000) }).parse(await context.req.json());
  await context.env.DB.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND owner_user_id = ?",
  )
    .bind(input.endpoint, context.get("user").id)
    .run();
  return context.json({ ok: true });
});
