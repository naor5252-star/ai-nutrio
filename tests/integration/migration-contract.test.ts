import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("D1 migration contract", () => {
  it("contains all required core tables and ownership indexes", async () => {
    const sql = await readFile("migrations/0001_initial_schema.sql", "utf8");
    for (const table of [
      "users",
      "sessions",
      "households",
      "household_members",
      "user_profiles",
      "nutrition_target_versions",
      "foods",
      "meals",
      "meal_items",
      "analysis_jobs",
      "analysis_results",
      "ai_conversations",
      "weight_measurements",
      "garmin_connections",
      "push_subscriptions",
      "shopping_list_items",
      "audit_events",
      "idempotency_records",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain("idx_meals_owner_local_date");
    expect(sql).toContain("idx_analysis_jobs_owner_status");
  });

  it("retains meal revisions independently of meal deletion", async () => {
    const sql = await readFile("migrations/0001_initial_schema.sql", "utf8");
    const revisionBlock = sql.slice(
      sql.indexOf("CREATE TABLE meal_revisions"),
      sql.indexOf("CREATE TABLE favorite_meals"),
    );
    expect(revisionBlock).not.toContain("REFERENCES meals(id) ON DELETE CASCADE");
  });
});
