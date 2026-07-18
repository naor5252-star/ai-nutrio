import type { SessionUser } from "../shared/contracts/api";

export type RuntimeSecrets = {
  TURNSTILE_SECRET_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  GARMIN_CLIENT_ID?: string;
  GARMIN_CLIENT_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  SESSION_SIGNING_SECRET?: string;
};

export type RuntimeVariables = {
  ENVIRONMENT: string;
  ENABLE_DEMO_AUTH: string;
  EMAIL_ENABLED: string;
  EMAIL_FROM: string;
  APP_BASE_URL: string;
  APPLE_ENABLED: string;
  GARMIN_ENABLED: string;
  AI_ENABLED: string;
  AI_FAST_MODEL: string;
  AI_STRONG_MODEL: string;
  IMAGE_RETENTION_DAYS: string;
  CHAT_RETENTION_DAYS: string;
  REVISION_RETENTION_DAYS: string;
};

export type RuntimeEnv = Omit<Env, keyof RuntimeVariables> & RuntimeVariables & RuntimeSecrets;

export type AppVariables = {
  correlationId: string;
  user: SessionUser;
  sessionRowId: string;
  csrfToken: string;
};

export type AppEnv = {
  Bindings: RuntimeEnv;
  Variables: AppVariables;
};
