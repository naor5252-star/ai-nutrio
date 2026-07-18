import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf, revokeCurrentSession } from "../auth/session";
import { nowIso } from "../repositories/db";

export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use("*", requireAuth);

accountRoutes.delete("/", requireCsrf, async (context) => {
  const user = context.get("user");
  const prefix = `private/${user.id}/`;
  let cursor: string | undefined;
  do {
    const listing = await context.env.MEDIA.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    if (listing.objects.length > 0)
      await context.env.MEDIA.delete(listing.objects.map((object) => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  const household = user.householdId;
  await revokeCurrentSession(context);
  await context.env.DB.prepare("UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowIso(), nowIso(), user.id)
    .run();
  await context.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  if (household) {
    const remaining = await context.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM household_members WHERE household_id = ?",
    )
      .bind(household)
      .first<{ count: number }>();
    if ((remaining?.count ?? 0) === 0)
      await context.env.DB.prepare("DELETE FROM households WHERE id = ?").bind(household).run();
  }
  return context.json({ ok: true, deletedPermanently: true });
});
