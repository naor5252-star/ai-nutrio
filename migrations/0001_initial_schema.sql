PRAGMA foreign_keys = ON;

CREATE TABLE schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO schema_metadata (key, value, updated_at) VALUES ('schema_version', '1', CURRENT_TIMESTAMP);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'he',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'magic_link', 'demo')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider, provider_subject)
);

CREATE TABLE auth_oauth_states (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  redirect_after TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  user_agent_hash TEXT,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user_active ON sessions(user_id, expires_at, revoked_at);

CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_magic_links_email_created ON magic_link_tokens(email, created_at);

CREATE TABLE account_security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY(household_id, user_id)
);

CREATE TABLE household_invitations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL COLLATE NOCASE,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth TEXT NOT NULL,
  sex_for_formula TEXT NOT NULL CHECK (sex_for_formula IN ('male', 'female')),
  height_cm REAL NOT NULL,
  current_weight_kg REAL NOT NULL,
  target_weight_kg REAL,
  activity_level TEXT NOT NULL,
  primary_goal TEXT NOT NULL,
  goal_intensity TEXT NOT NULL,
  manual_calorie_target REAL,
  manual_protein_target REAL,
  warning_acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  diet_type TEXT,
  kosher_preference TEXT,
  liked_foods_json TEXT,
  disliked_foods_json TEXT,
  approximate_budget TEXT,
  preferred_meal_count INTEGER,
  typical_meal_times_json TEXT,
  cooking_preferences_json TEXT,
  sleeping_hours_json TEXT,
  eating_habits TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_type TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  details_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_user_goals_user ON user_goals(user_id);

CREATE TABLE nutrition_target_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  formula_version TEXT NOT NULL,
  calculation_inputs_json TEXT NOT NULL,
  bmr REAL NOT NULL,
  maintenance_calories REAL NOT NULL,
  calculated_calories REAL NOT NULL,
  manual_calorie_target REAL,
  effective_calories REAL NOT NULL,
  calculated_protein_grams REAL NOT NULL,
  manual_protein_target REAL,
  effective_protein_grams REAL NOT NULL,
  fat_grams REAL NOT NULL,
  carbohydrate_grams REAL NOT NULL,
  fiber_grams REAL NOT NULL,
  warning_codes_json TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_targets_user_effective ON nutrition_target_versions(user_id, effective_from DESC);

CREATE TABLE dashboard_card_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_key TEXT NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, card_key)
);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  analysis_notifications INTEGER NOT NULL DEFAULT 1,
  daily_summary_enabled INTEGER NOT NULL DEFAULT 1,
  daily_summary_time TEXT NOT NULL DEFAULT '20:00',
  weekly_summary_enabled INTEGER NOT NULL DEFAULT 1,
  weekly_summary_day INTEGER NOT NULL DEFAULT 0,
  weekly_summary_time TEXT NOT NULL DEFAULT '20:00',
  updated_at TEXT NOT NULL
);

CREATE TABLE foods (
  id TEXT PRIMARY KEY,
  canonical_name_he TEXT NOT NULL,
  canonical_name_en TEXT,
  brand TEXT,
  owner_household_id TEXT REFERENCES households(id) ON DELETE CASCADE,
  creator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_foods_names ON foods(canonical_name_he, brand);

CREATE TABLE food_sources (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('label', 'database', 'manual', 'ai_estimate')),
  provider_name TEXT,
  external_id TEXT,
  license_attribution TEXT,
  raw_snapshot_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE food_nutrients (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES food_sources(id) ON DELETE CASCADE,
  nutrient_code TEXT NOT NULL,
  normalized_value REAL,
  normalized_unit TEXT NOT NULL,
  base_quantity REAL NOT NULL,
  base_unit TEXT NOT NULL,
  original_display_value TEXT,
  original_precision INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(food_id, source_id, nutrient_code, base_quantity, base_unit)
);

CREATE TABLE food_servings (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  description_he TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  grams_or_ml REAL,
  source_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE food_barcodes (
  barcode TEXT PRIMARY KEY,
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  confirmed_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE food_unit_conversions (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  from_unit TEXT NOT NULL,
  from_quantity REAL NOT NULL,
  grams_or_ml REAL,
  source_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE household_food_ownership (
  food_id TEXT PRIMARY KEY REFERENCES foods(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE food_usage_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  used_at TEXT NOT NULL,
  quantity REAL,
  unit TEXT
);
CREATE INDEX idx_food_usage_user_recent ON food_usage_history(user_id, used_at DESC);

CREATE TABLE meals (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  category TEXT NOT NULL,
  custom_category_name TEXT,
  title TEXT NOT NULL,
  notes TEXT,
  analysis_job_id TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  total_calories REAL,
  total_protein_grams REAL,
  total_carbohydrate_grams REAL,
  total_fat_grams REAL,
  total_fiber_grams REAL,
  partial_nutrients_json TEXT NOT NULL DEFAULT '[]',
  client_mutation_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, client_mutation_id)
);
CREATE INDEX idx_meals_owner_local_date ON meals(owner_user_id, local_date, occurred_at);

CREATE TABLE meal_items (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_id TEXT REFERENCES foods(id) ON DELETE SET NULL,
  name_he TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  grams REAL,
  source_type TEXT NOT NULL,
  identity_confidence TEXT,
  quantity_confidence TEXT,
  nutrition_confidence TEXT,
  source_snapshot_json TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE meal_item_nutrients (
  id TEXT PRIMARY KEY,
  meal_item_id TEXT NOT NULL REFERENCES meal_items(id) ON DELETE CASCADE,
  nutrient_code TEXT NOT NULL,
  value REAL,
  unit TEXT NOT NULL,
  original_display_value TEXT,
  source_type TEXT NOT NULL,
  is_partial INTEGER NOT NULL DEFAULT 0,
  UNIQUE(meal_item_id, nutrient_code)
);

CREATE TABLE meal_revisions (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  previous_snapshot_json TEXT NOT NULL,
  new_snapshot_json TEXT NOT NULL,
  revision_source TEXT NOT NULL CHECK (revision_source IN ('user', 'ai', 'system')),
  reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_meal_revisions_expiry ON meal_revisions(expires_at);

CREATE TABLE favorite_meals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, meal_id)
);

CREATE TABLE frequent_food_statistics (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_key TEXT NOT NULL,
  display_name_he TEXT NOT NULL,
  use_count INTEGER NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY(user_id, food_key)
);

CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  logical_expires_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_media_expiry ON media_objects(logical_expires_at, deleted_at);

CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL DEFAULT 'meal',
  status TEXT NOT NULL,
  workflow_instance_id TEXT,
  overall_confidence TEXT,
  error_code TEXT,
  error_message_he TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  analysis_version TEXT,
  client_mutation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(owner_user_id, client_mutation_id)
);
CREATE INDEX idx_analysis_jobs_owner_status ON analysis_jobs(owner_user_id, status, updated_at DESC);

CREATE TABLE analysis_job_images (
  analysis_job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  media_object_id TEXT NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  image_order INTEGER NOT NULL,
  PRIMARY KEY(analysis_job_id, media_object_id),
  UNIQUE(analysis_job_id, image_order)
);

CREATE TABLE analysis_candidates (
  id TEXT PRIMARY KEY,
  analysis_job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  temporary_id TEXT NOT NULL,
  candidate_name_he TEXT NOT NULL,
  candidate_name_en TEXT,
  alternatives_json TEXT,
  estimated_quantity REAL,
  estimated_unit TEXT,
  estimated_grams REAL,
  identity_confidence TEXT NOT NULL,
  quantity_confidence TEXT NOT NULL,
  nutrition_confidence TEXT NOT NULL,
  plausible_calories_min REAL,
  plausible_calories_max REAL,
  notes_json TEXT,
  sort_order INTEGER NOT NULL
);

CREATE TABLE analysis_clarifications (
  id TEXT PRIMARY KEY,
  analysis_job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  question_he TEXT NOT NULL,
  answer_options_json TEXT,
  answer_json TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE analysis_results (
  analysis_job_id TEXT PRIMARY KEY REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  source_model TEXT,
  model_route TEXT NOT NULL,
  validated INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  full_text_expires_at TEXT NOT NULL
);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_text TEXT NOT NULL,
  safety_classification TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_ai_messages_expiry ON ai_messages(expires_at);

CREATE TABLE ai_memory_summaries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE SET NULL,
  summary_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_structured_memories (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_key TEXT NOT NULL,
  memory_value_json TEXT NOT NULL,
  approved_by_user INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, memory_key)
);

CREATE TABLE ai_safety_events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE weight_measurements (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measured_at TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_weight_owner_date ON weight_measurements(owner_user_id, measured_at);

CREATE TABLE body_composition_measurements (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measured_at TEXT NOT NULL,
  body_fat_percentage REAL,
  muscle_mass_kg REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_body_owner_date ON body_composition_measurements(owner_user_id, measured_at);

CREATE TABLE garmin_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  last_successful_sync_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE garmin_sync_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  imported_record_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE garmin_daily_metrics (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  steps INTEGER,
  floors REAL,
  sleep_seconds INTEGER,
  stress_average REAL,
  body_battery REAL,
  respiration REAL,
  pulse_oxygen REAL,
  source_snapshot_json TEXT,
  UNIQUE(owner_user_id, local_date)
);

CREATE TABLE garmin_activities (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_activity_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_seconds INTEGER,
  distance_meters REAL,
  pace_seconds_per_km REAL,
  average_heart_rate REAL,
  active_calories REAL,
  source_snapshot_json TEXT,
  UNIQUE(owner_user_id, provider_activity_id)
);

CREATE TABLE garmin_raw_event_references (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(owner_user_id, provider_event_id)
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  invalidated_at TEXT
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  related_entity_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE scheduled_summary_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  daily_time TEXT NOT NULL,
  weekly_day INTEGER NOT NULL,
  weekly_time TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shopping_lists (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL UNIQUE REFERENCES households(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shopping_list_items (
  id TEXT PRIMARY KEY,
  shopping_list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  food_id TEXT REFERENCES foods(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  purchased INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  client_mutation_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shopping_list_id, client_mutation_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events(created_at DESC);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  r2_object_key TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_idempotency_expiry ON idempotency_records(expires_at);
