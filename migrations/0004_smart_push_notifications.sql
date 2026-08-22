ALTER TABLE notification_preferences ADD COLUMN morning_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_preferences ADD COLUMN morning_time TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE notification_preferences ADD COLUMN afternoon_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_preferences ADD COLUMN afternoon_time TEXT NOT NULL DEFAULT '15:00';
ALTER TABLE notification_preferences ADD COLUMN evening_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_preferences ADD COLUMN evening_time TEXT NOT NULL DEFAULT '20:00';
ALTER TABLE notification_preferences ADD COLUMN ai_personalized INTEGER NOT NULL DEFAULT 1;

CREATE TABLE push_notification_messages (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_push_notification_messages_owner_created
  ON push_notification_messages(owner_user_id, created_at DESC);
