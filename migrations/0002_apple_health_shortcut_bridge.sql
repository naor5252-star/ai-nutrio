CREATE TABLE health_shortcut_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  last_successful_sync_at TEXT,
  last_error_code TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider)
);

CREATE INDEX idx_health_shortcut_connections_user
  ON health_shortcut_connections(user_id, provider, status);

CREATE TABLE health_daily_summaries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  steps INTEGER,
  active_energy_kcal REAL,
  resting_energy_kcal REAL,
  walking_running_distance_km REAL,
  flights_climbed INTEGER,
  resting_heart_rate_bpm REAL,
  average_heart_rate_bpm REAL,
  sleep_minutes REAL,
  water_ml REAL,
  weight_kg REAL,
  body_fat_percentage REAL,
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_user_id, source, local_date)
);

CREATE INDEX idx_health_daily_summaries_user_date
  ON health_daily_summaries(owner_user_id, local_date DESC);

CREATE TABLE health_workouts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  duration_minutes REAL NOT NULL,
  active_energy_kcal REAL,
  distance_km REAL,
  average_heart_rate_bpm REAL,
  max_heart_rate_bpm REAL,
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_user_id, source, source_record_id)
);

CREATE INDEX idx_health_workouts_user_start
  ON health_workouts(owner_user_id, start_at DESC);
