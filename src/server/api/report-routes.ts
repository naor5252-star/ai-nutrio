import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../auth/session";

export const reportRoutes = new Hono<AppEnv>();
reportRoutes.use("*", requireAuth);

reportRoutes.get("/daily", async (context) => {
  const date = z.string().date().parse(context.req.query("date"));
  const userId = context.get("user").id;
  const [meals, target] = await Promise.all([
    context.env.DB.prepare(
      `SELECT id, occurred_at, category, title, total_calories, total_protein_grams,
              total_carbohydrate_grams, total_fat_grams, total_fiber_grams, partial_nutrients_json
         FROM meals WHERE owner_user_id = ? AND local_date = ? ORDER BY occurred_at`,
    )
      .bind(userId, date)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      "SELECT effective_calories, effective_protein_grams, carbohydrate_grams, fat_grams, fiber_grams FROM nutrition_target_versions WHERE user_id = ? ORDER BY effective_from DESC LIMIT 1",
    )
      .bind(userId)
      .first<Record<string, unknown>>(),
  ]);
  return context.json({ date, meals: meals.results, target });
});

reportRoutes.get("/weekly", async (context) => {
  const from = z.string().date().parse(context.req.query("from"));
  const userId = context.get("user").id;
  const rows = await context.env.DB.prepare(
    `SELECT local_date, COUNT(*) AS meals,
            SUM(total_calories) AS calories, SUM(total_protein_grams) AS protein,
            SUM(total_carbohydrate_grams) AS carbs, SUM(total_fat_grams) AS fat, SUM(total_fiber_grams) AS fiber
       FROM meals WHERE owner_user_id = ? AND local_date >= ? AND local_date < date(?, '+7 days')
      GROUP BY local_date ORDER BY local_date`,
  )
    .bind(userId, from, from)
    .all<Record<string, unknown>>();
  return context.json({
    from,
    days: rows.results,
    caveatHe: "ממוצעים כוללים רק מידע שתועד; ערכים לא ידועים אינם מחושבים כאפס.",
  });
});
