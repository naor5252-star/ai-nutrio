import type { ApiError, SessionResponse } from "../../shared/contracts/api";
import { listPendingMutations, queueMutation, removePendingMutation } from "../offline/db";

let csrfToken: string | null = null;

export class ClientApiError extends Error {
  constructor(
    readonly code: string,
    readonly messageHe: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(messageHe);
  }
}

export function setCsrfToken(value: string | null): void {
  csrfToken = value;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  options: { queueOffline?: boolean } = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type") && typeof init.body === "string")
    headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken)
    headers.set("x-csrf-token", csrfToken);
  headers.set("x-correlation-id", crypto.randomUUID());

  if (!navigator.onLine && options.queueOffline && typeof init.body === "string") {
    await queueMutation({
      id: crypto.randomUUID(),
      url: path,
      method: method as "POST" | "PUT" | "PATCH" | "DELETE",
      body: JSON.parse(init.body) as unknown,
      createdAt: new Date().toISOString(),
    });
    return { queuedOffline: true } as T;
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (options.queueOffline && typeof init.body === "string") {
      await queueMutation({
        id: crypto.randomUUID(),
        url: path,
        method: method as "POST" | "PUT" | "PATCH" | "DELETE",
        body: JSON.parse(init.body) as unknown,
        createdAt: new Date().toISOString(),
      });
      return { queuedOffline: true } as T;
    }
    throw error;
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiError | null;
    throw new ClientApiError(
      payload?.error.code ?? "REQUEST_FAILED",
      payload?.error.messageHe ?? "לא הצלחנו להשלים את הפעולה",
      response.status,
      payload?.error.retryable ?? false,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function loadSession(): Promise<SessionResponse> {
  const session = await apiRequest<SessionResponse>("/api/v1/auth/session");
  setCsrfToken(session.csrfToken);
  return session;
}

export async function syncPendingMutations(): Promise<number> {
  const pending = await listPendingMutations();
  let synced = 0;
  for (const mutation of pending) {
    try {
      await apiRequest(mutation.url, {
        method: mutation.method,
        body: JSON.stringify(mutation.body),
      });
      await removePendingMutation(mutation.id);
      synced += 1;
    } catch {
      break;
    }
  }
  return synced;
}
