export function nowIso(): string {
  return new Date().toISOString();
}

export function addHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
}

export function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString();
}

export async function firstOrNull<T extends Record<string, unknown>>(
  statement: D1PreparedStatement,
): Promise<T | null> {
  return statement.first<T>();
}

export async function allRows<T extends Record<string, unknown>>(
  statement: D1PreparedStatement,
): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results;
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
