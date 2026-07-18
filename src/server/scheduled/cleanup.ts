import type { RuntimeEnv } from "../context";
import { nowIso } from "../repositories/db";
import { logEvent } from "../services/logger";

export async function runCleanup(env: RuntimeEnv, correlationId: string): Promise<void> {
  const now = nowIso();
  const expiredMedia = await env.DB.prepare(
    "SELECT id, r2_object_key FROM media_objects WHERE logical_expires_at <= ? AND deleted_at IS NULL LIMIT 500",
  )
    .bind(now)
    .all<{ id: string; r2_object_key: string }>();
  if (expiredMedia.results.length > 0) {
    await env.MEDIA.delete(expiredMedia.results.map((item) => item.r2_object_key));
    const statements = expiredMedia.results.map((item) =>
      env.DB.prepare("UPDATE media_objects SET deleted_at = ? WHERE id = ?").bind(now, item.id),
    );
    await env.DB.batch(statements);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_messages WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM meal_revisions WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "DELETE FROM household_invitations WHERE expires_at <= ? AND accepted_at IS NULL",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM magic_link_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
    ).bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(
      now,
    ),
    env.DB.prepare("DELETE FROM idempotency_records WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "DELETE FROM auth_oauth_states WHERE expires_at <= ? OR used_at IS NOT NULL",
    ).bind(now),
  ]);
  logEvent({
    severity: "info",
    event: "scheduled_cleanup_completed",
    correlationId,
    outcome: "success",
    details: { deletedMedia: expiredMedia.results.length },
  });
}

export async function prepareDueSummaries(env: RuntimeEnv, correlationId: string): Promise<void> {
  const users = await env.DB.prepare(
    "SELECT u.id, u.timezone, np.daily_summary_time, np.daily_summary_enabled FROM users u JOIN notification_preferences np ON np.user_id = u.id WHERE u.deleted_at IS NULL AND np.daily_summary_enabled = 1",
  ).all<{
    id: string;
    timezone: string;
    daily_summary_time: string;
    daily_summary_enabled: number;
  }>();
  logEvent({
    severity: "info",
    event: "summary_schedule_checked",
    correlationId,
    outcome: "success",
    details: { candidates: users.results.length },
  });
}
