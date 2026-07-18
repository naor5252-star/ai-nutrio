export type LogLevel = "debug" | "info" | "warn" | "error";

type LogEvent = {
  severity: LogLevel;
  event: string;
  correlationId: string;
  userId?: string;
  jobId?: string;
  durationMs?: number;
  outcome?: string;
  retryable?: boolean;
  details?: Record<string, string | number | boolean | null>;
};

export function logEvent(event: LogEvent): void {
  const payload = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  if (event.severity === "error") console.error(payload);
  else if (event.severity === "warn") console.warn(payload);
  else console.log(payload);
}
