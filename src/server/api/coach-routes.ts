import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { addDaysIso, nowIso, parseJson } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { detectSafetyCategory, safetyResponseHe } from "../ai/safety";

export const coachRoutes = new Hono<AppEnv>();
coachRoutes.use("*", requireAuth);

coachRoutes.get("/next", async (context) => {
  const user = context.get("user");
  const date = z.string().date().parse(context.req.query("date"));
  const totals = await context.env.DB.prepare(
    `SELECT SUM(total_calories) AS calories, SUM(total_protein_grams) AS protein,
            SUM(total_carbohydrate_grams) AS carbs, SUM(total_fat_grams) AS fat,
            SUM(total_fiber_grams) AS fiber
       FROM meals WHERE owner_user_id = ? AND local_date = ?`,
  )
    .bind(user.id, date)
    .first<{
      calories: number | null;
      protein: number | null;
      carbs: number | null;
      fat: number | null;
      fiber: number | null;
    }>();
  const target = await context.env.DB.prepare(
    `SELECT effective_calories, effective_protein_grams, carbohydrate_grams, fat_grams, fiber_grams, warning_codes_json
       FROM nutrition_target_versions WHERE user_id = ? ORDER BY effective_from DESC LIMIT 1`,
  )
    .bind(user.id)
    .first<{
      effective_calories: number;
      effective_protein_grams: number;
      carbohydrate_grams: number;
      fat_grams: number;
      fiber_grams: number;
      warning_codes_json: string;
    }>();
  if (!target) {
    return context.json({
      headlineHe: "נתחיל מהבסיס",
      messageHe: "כדאי להשלים כמה פרטים קצרים בפרופיל כדי שאוכל להציג מה נשאר להיום.",
      actionHe: "השלמת פרופיל",
      actionPath: "/settings",
    });
  }
  const calories = totals?.calories ?? 0;
  const protein = totals?.protein ?? 0;
  const remainingCalories = Math.max(0, target.effective_calories - calories);
  const remainingProtein = Math.max(0, target.effective_protein_grams - protein);
  const warnings = parseJson<string[]>(target.warning_codes_json, []);
  return context.json({
    headlineHe: remainingProtein > 20 ? "בארוחה הבאה כדאי לשלב חלבון" : "היום מתקדם יפה",
    messageHe:
      remainingProtein > 20
        ? `נשארו בערך ${Math.round(remainingProtein)} גרם חלבון ו-${Math.round(remainingCalories)} קלוריות לפי היעד שהגדרת. אפשר לבחור מנה פשוטה עם מקור חלבון וירקות.`
        : `נשארו בערך ${Math.round(remainingCalories)} קלוריות. אפשר לבחור לפי הרעב וההעדפות שלך—אין צורך “לפצות” על ארוחות קודמות.`,
    actionHe: "רעיונות לארוחה",
    remaining: { calories: remainingCalories, proteinGrams: remainingProtein },
    targetWarning: warnings.length > 0,
    disclaimerHe: "המידע הוא תמיכה כללית באורח חיים ואינו ייעוץ רפואי.",
  });
});

coachRoutes.post("/messages", requireCsrf, async (context) => {
  const input = z
    .object({
      conversationId: z.string().uuid().nullable().optional(),
      message: z.string().trim().min(1).max(4_000),
    })
    .parse(await context.req.json());
  const user = context.get("user");
  const safety = detectSafetyCategory(input.message);
  const now = nowIso();
  const conversationId = input.conversationId ?? secureUuid();
  if (!input.conversationId) {
    await context.env.DB.prepare(
      "INSERT INTO ai_conversations (id, owner_user_id, title, created_at, updated_at, full_text_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        conversationId,
        user.id,
        input.message.slice(0, 80),
        now,
        now,
        addDaysIso(Number(context.env.CHAT_RETENTION_DAYS)),
      )
      .run();
  } else {
    const owned = await context.env.DB.prepare(
      "SELECT id FROM ai_conversations WHERE id = ? AND owner_user_id = ?",
    )
      .bind(conversationId, user.id)
      .first<{ id: string }>();
    if (!owned) return context.notFound();
  }
  const response = safety
    ? safetyResponseHe(safety)
    : "כדי לתת תשובה שימושית בלי להמציא ערכים, אני מסתמך על היעדים והארוחות שאישרת. אפשר לשאול למשל מה כדאי לשלב בארוחה הבאה או איך להוסיף יותר סיבים באופן מעשי.";
  const expiresAt = addDaysIso(Number(context.env.CHAT_RETENTION_DAYS));
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      "INSERT INTO ai_messages (id, conversation_id, owner_user_id, role, content_text, safety_classification, created_at, expires_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)",
    ).bind(secureUuid(), conversationId, user.id, input.message, safety, now, expiresAt),
    context.env.DB.prepare(
      "INSERT INTO ai_messages (id, conversation_id, owner_user_id, role, content_text, safety_classification, created_at, expires_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)",
    ).bind(secureUuid(), conversationId, user.id, response, safety, now, expiresAt),
    context.env.DB.prepare(
      "UPDATE ai_conversations SET updated_at = ? WHERE id = ? AND owner_user_id = ?",
    ).bind(now, conversationId, user.id),
  ];
  if (safety) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO ai_safety_events (id, owner_user_id, category, action_taken, correlation_id, created_at) VALUES (?, ?, ?, 'refused_and_redirected', ?, ?)",
      ).bind(secureUuid(), user.id, safety, context.get("correlationId"), now),
    );
  }
  await context.env.DB.batch(statements);
  return context.json({ conversationId, response, safetyCategory: safety });
});

coachRoutes.delete("/memory", requireCsrf, async (context) => {
  const userId = context.get("user").id;
  await context.env.DB.batch([
    context.env.DB.prepare("DELETE FROM ai_conversations WHERE owner_user_id = ?").bind(userId),
    context.env.DB.prepare("DELETE FROM ai_memory_summaries WHERE owner_user_id = ?").bind(userId),
    context.env.DB.prepare("DELETE FROM ai_structured_memories WHERE owner_user_id = ?").bind(
      userId,
    ),
  ]);
  return context.json({ ok: true });
});
