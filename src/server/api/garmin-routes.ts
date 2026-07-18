import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { AppError } from "./errors";

export const garminRoutes = new Hono<AppEnv>();
garminRoutes.use("*", requireAuth);

garminRoutes.get("/status", async (context) => {
  const connection = await context.env.DB.prepare(
    "SELECT status, last_successful_sync_at, last_error_code, updated_at FROM garmin_connections WHERE user_id = ?",
  )
    .bind(context.get("user").id)
    .first<Record<string, unknown>>();
  return context.json({
    enabled: context.env.GARMIN_ENABLED === "true",
    approvedProviderConfigured: Boolean(
      context.env.GARMIN_CLIENT_ID && context.env.GARMIN_CLIENT_SECRET,
    ),
    connection,
    messageHe:
      context.env.GARMIN_ENABLED === "true"
        ? "האינטגרציה מוגדרת. נתוני Garmin לעולם לא משנים יעדים בלי אישור."
        : "Garmin מושבת עד לקבלת אישור ופרטי גישה. שאר האפליקציה פועלת כרגיל.",
  });
});

garminRoutes.post("/sync", requireCsrf, (context) => {
  if (context.env.GARMIN_ENABLED !== "true" || !context.env.GARMIN_CLIENT_ID) {
    throw new AppError({
      status: 503,
      code: "GARMIN_DISABLED",
      messageHe: "Garmin עדיין לא הופעל. אין פגיעה במידע התזונתי שלך.",
    });
  }
  throw new AppError({
    status: 501,
    code: "GARMIN_APPROVAL_REQUIRED",
    messageHe: "הסנכרון יופעל לאחר אישור Garmin וחיבור Data Feed.",
  });
});
