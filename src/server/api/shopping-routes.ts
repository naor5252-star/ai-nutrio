import { Hono } from "hono";
import { z } from "zod";
import { shoppingItemSchema } from "../../shared/schemas/api";
import type { AppEnv } from "../context";
import { requireAuth, requireCsrf } from "../auth/session";
import { requireHouseholdId } from "../domain/authorization";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { AppError } from "./errors";

export const shoppingRoutes = new Hono<AppEnv>();
shoppingRoutes.use("*", requireAuth);

shoppingRoutes.get("/", async (context) => {
  const householdId = requireHouseholdId(context.get("user").householdId);
  const list = await context.env.DB.prepare("SELECT id FROM shopping_lists WHERE household_id = ?")
    .bind(householdId)
    .first<{ id: string }>();
  if (!list)
    throw new AppError({
      status: 404,
      code: "SHOPPING_LIST_NOT_FOUND",
      messageHe: "רשימת הקניות לא נמצאה",
    });
  const items = await context.env.DB.prepare(
    `SELECT sli.*, cu.email AS created_by_email, uu.email AS updated_by_email
       FROM shopping_list_items sli
       JOIN users cu ON cu.id = sli.created_by_user_id
       JOIN users uu ON uu.id = sli.updated_by_user_id
      WHERE shopping_list_id = ? ORDER BY purchased, updated_at DESC`,
  )
    .bind(list.id)
    .all<Record<string, unknown>>();
  return context.json({ listId: list.id, items: items.results });
});

shoppingRoutes.post("/items", requireCsrf, async (context) => {
  const input = shoppingItemSchema
    .extend({ clientMutationId: z.string().uuid() })
    .parse(await context.req.json());
  const user = context.get("user");
  const householdId = requireHouseholdId(user.householdId);
  const list = await context.env.DB.prepare("SELECT id FROM shopping_lists WHERE household_id = ?")
    .bind(householdId)
    .first<{ id: string }>();
  if (!list)
    throw new AppError({
      status: 404,
      code: "SHOPPING_LIST_NOT_FOUND",
      messageHe: "רשימת הקניות לא נמצאה",
    });
  const existing = await context.env.DB.prepare(
    "SELECT id FROM shopping_list_items WHERE shopping_list_id = ? AND client_mutation_id = ?",
  )
    .bind(list.id, input.clientMutationId)
    .first<{ id: string }>();
  if (existing) return context.json({ id: existing.id, idempotentReplay: true });
  const id = secureUuid();
  const now = nowIso();
  await context.env.DB.prepare(
    `INSERT INTO shopping_list_items (
      id, shopping_list_id, text, quantity, unit, created_by_user_id, updated_by_user_id,
      client_mutation_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      list.id,
      input.text,
      input.quantity,
      input.unit,
      user.id,
      user.id,
      input.clientMutationId,
      now,
      now,
    )
    .run();
  return context.json({ id }, 201);
});

shoppingRoutes.patch("/items/:id", requireCsrf, async (context) => {
  const input = z
    .object({
      quantity: z.number().finite().positive().max(10_000).optional(),
      unit: z.string().trim().min(1).max(60).optional(),
      purchased: z.boolean().optional(),
      updatedAt: z.string().datetime(),
      version: z.number().int().positive(),
    })
    .parse(await context.req.json());
  const user = context.get("user");
  const householdId = requireHouseholdId(user.householdId);
  const item = await context.env.DB.prepare(
    `SELECT sli.id, sli.quantity, sli.unit, sli.purchased, sli.updated_at, sli.version
       FROM shopping_list_items sli JOIN shopping_lists sl ON sl.id = sli.shopping_list_id
      WHERE sli.id = ? AND sl.household_id = ?`,
  )
    .bind(context.req.param("id"), householdId)
    .first<{
      id: string;
      quantity: number;
      unit: string;
      purchased: number;
      updated_at: string;
      version: number;
    }>();
  if (!item)
    throw new AppError({
      status: 404,
      code: "SHOPPING_ITEM_NOT_FOUND",
      messageHe: "הפריט לא נמצא",
    });
  if (new Date(input.updatedAt).getTime() < new Date(item.updated_at).getTime()) {
    return context.json({ id: item.id, version: item.version, ignoredAsStale: true });
  }
  const now = nowIso();
  await context.env.DB.prepare(
    "UPDATE shopping_list_items SET quantity = ?, unit = ?, purchased = ?, updated_by_user_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
  )
    .bind(
      input.quantity ?? item.quantity,
      input.unit ?? item.unit,
      input.purchased === undefined ? item.purchased : input.purchased ? 1 : 0,
      user.id,
      now,
      item.id,
    )
    .run();
  return context.json({ id: item.id, updatedAt: now, version: item.version + 1 });
});

shoppingRoutes.delete("/items/:id", requireCsrf, async (context) => {
  const householdId = requireHouseholdId(context.get("user").householdId);
  const result = await context.env.DB.prepare(
    "DELETE FROM shopping_list_items WHERE id = ? AND shopping_list_id IN (SELECT id FROM shopping_lists WHERE household_id = ?)",
  )
    .bind(context.req.param("id"), householdId)
    .run();
  if (result.meta.changes === 0)
    throw new AppError({
      status: 404,
      code: "SHOPPING_ITEM_NOT_FOUND",
      messageHe: "הפריט לא נמצא",
    });
  return context.json({ ok: true });
});
