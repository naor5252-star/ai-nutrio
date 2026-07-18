import { PDFDocument, StandardFonts } from "pdf-lib";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../auth/session";

export const exportRoutes = new Hono<AppEnv>();
exportRoutes.use("*", requireAuth);

exportRoutes.get("/:format", async (context) => {
  const format = z.enum(["json", "csv", "pdf"]).parse(context.req.param("format"));
  const user = context.get("user");
  const meals = await context.env.DB.prepare(
    "SELECT id, occurred_at, local_date, category, title, total_calories, total_protein_grams, total_carbohydrate_grams, total_fat_grams, total_fiber_grams FROM meals WHERE owner_user_id = ? ORDER BY occurred_at",
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const measurements = await context.env.DB.prepare(
    "SELECT measured_at, weight_kg, source FROM weight_measurements WHERE owner_user_id = ? ORDER BY measured_at",
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const payload = {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    meals: meals.results,
    weightMeasurements: measurements.results,
  };

  if (format === "json") {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "attachment; filename=nutrition-export.json",
      },
    });
  }
  if (format === "csv") {
    const header = [
      "date",
      "time",
      "category",
      "title",
      "calories",
      "protein_g",
      "carbs_g",
      "fat_g",
      "fiber_g",
    ];
    const lines = meals.results.map((meal) =>
      [
        meal.local_date,
        meal.occurred_at,
        meal.category,
        meal.title,
        meal.total_calories,
        meal.total_protein_grams,
        meal.total_carbohydrate_grams,
        meal.total_fat_grams,
        meal.total_fiber_grams,
      ]
        .map(csvCell)
        .join(","),
    );
    return new Response(`\uFEFF${header.join(",")}\n${lines.join("\n")}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=nutrition-export.csv",
      },
    });
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([595, 842]);
  let y = 800;
  page.drawText("Personal Nutrition Export", { x: 40, y, size: 18, font });
  y -= 28;
  page.drawText(`Generated: ${payload.exportedAt}`, { x: 40, y, size: 10, font });
  y -= 24;
  for (const meal of meals.results) {
    if (y < 60) {
      page = pdf.addPage([595, 842]);
      y = 800;
    }
    const line = `${String(meal.local_date)} | ${String(meal.title)} | kcal ${String(meal.total_calories ?? "unknown")} | protein ${String(meal.total_protein_grams ?? "unknown")}g`;
    page.drawText(line.replaceAll(/[^\x20-\x7E]/gu, "?"), {
      x: 40,
      y,
      size: 9,
      font,
      maxWidth: 510,
    });
    y -= 16;
  }
  const bytes = await pdf.save();
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=nutrition-export.pdf",
    },
  });
});

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
