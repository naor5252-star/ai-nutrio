import { Hono } from "hono";
import { measurementSchema } from "../../shared/schemas/api";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";

export const measurementRoutes = new Hono<AppEnv>();
measurementRoutes.use("*", requireAuth);

measurementRoutes.get("/", async (context) => {
  const userId = context.get("user").id;
  const [weights, body] = await Promise.all([
    context.env.DB.prepare(
      "SELECT id, measured_at, weight_kg, source FROM weight_measurements WHERE owner_user_id = ? ORDER BY measured_at",
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      "SELECT id, measured_at, body_fat_percentage, muscle_mass_kg, source FROM body_composition_measurements WHERE owner_user_id = ? ORDER BY measured_at",
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
  ]);
  return context.json({ weights: weights.results, bodyComposition: body.results });
});

measurementRoutes.post("/", requireCsrf, async (context) => {
  const input = measurementSchema.parse(await context.req.json());
  const userId = context.get("user").id;
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (input.weightKg !== undefined) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO weight_measurements (id, owner_user_id, measured_at, weight_kg, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)",
      ).bind(secureUuid(), userId, input.measuredAt, input.weightKg, now),
      context.env.DB.prepare(
        "UPDATE user_profiles SET current_weight_kg = ?, updated_at = ?, version = version + 1, updated_by = ? WHERE user_id = ?",
      ).bind(input.weightKg, now, userId, userId),
    );
  }
  if (input.bodyFatPercentage !== undefined || input.muscleMassKg !== undefined) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO body_composition_measurements (id, owner_user_id, measured_at, body_fat_percentage, muscle_mass_kg, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)",
      ).bind(
        secureUuid(),
        userId,
        input.measuredAt,
        input.bodyFatPercentage ?? null,
        input.muscleMassKg ?? null,
        now,
      ),
    );
  }
  await context.env.DB.batch(statements);
  return context.json({ ok: true }, 201);
});
