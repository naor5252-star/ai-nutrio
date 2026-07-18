export type ApiError = {
  error: {
    code: string;
    messageHe: string;
    correlationId: string;
    fieldErrors?: Record<string, string[]>;
    retryable?: boolean;
  };
};

export type SessionUser = {
  id: string;
  email: string;
  householdId: string | null;
};

export type SessionResponse = {
  authenticated: boolean;
  user: SessionUser | null;
  csrfToken: string | null;
  features: {
    demoAuth: boolean;
    googleAuth: boolean;
    appleAuth: boolean;
    garmin: boolean;
    ai: boolean;
    email: boolean;
  };
};
