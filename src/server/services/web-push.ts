import type { RuntimeEnv } from "../context";
import { nowIso } from "../repositories/db";

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
};

export type PushSendResult = {
  sent: number;
  invalidated: number;
  failed: number;
  failures: string[];
};

export async function sendPayloadlessPushToUser(
  env: RuntimeEnv,
  userId: string,
): Promise<PushSendResult> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return { sent: 0, invalidated: 0, failed: 0, failures: [] };
  }

  const subscriptions = await env.DB.prepare(
    `SELECT id, endpoint
       FROM push_subscriptions
      WHERE owner_user_id = ? AND invalidated_at IS NULL`,
  )
    .bind(userId)
    .all<PushSubscriptionRow>();

  let sent = 0;
  let invalidated = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const subscription of subscriptions.results) {
    try {
      const response = await fetch(subscription.endpoint, {
        method: "POST",
        headers: await createVapidHeaders(env, subscription.endpoint),
      });

      if (response.ok) {
        sent += 1;
        await env.DB.prepare("UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?")
          .bind(nowIso(), subscription.id)
          .run();
      } else if (response.status === 404 || response.status === 410) {
        invalidated += 1;
        await env.DB.prepare("UPDATE push_subscriptions SET invalidated_at = ? WHERE id = ?")
          .bind(nowIso(), subscription.id)
          .run();
      } else {
        failed += 1;
        failures.push(await describePushFailure(response));
      }
    } catch (error) {
      failed += 1;
      failures.push(error instanceof Error ? error.message : "Push request failed");
    }
  }

  return { sent, invalidated, failed, failures };
}

async function createVapidHeaders(env: RuntimeEnv, endpoint: string): Promise<Headers> {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) throw new Error("VAPID is not configured");

  const header = encodeText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = encodeText(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1_000) + 12 * 60 * 60,
      sub: env.APP_BASE_URL.replace(/\/$/u, ""),
    }),
  );
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${encodeBytes(new Uint8Array(signature))}`;

  const headers = new Headers();
  headers.set("TTL", "60");
  headers.set("Urgency", "normal");
  headers.set("Authorization", `vapid t=${jwt}, k=${publicKey}`);
  headers.set("Crypto-Key", `p256ecdsa=${publicKey}`);
  return headers;
}

async function describePushFailure(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  let reason = body || response.statusText || "Unknown push error";

  if (body) {
    try {
      const parsed = JSON.parse(body) as { reason?: unknown };
      if (typeof parsed.reason === "string" && parsed.reason.trim()) {
        reason = parsed.reason.trim();
      }
    } catch {
      reason = body.slice(0, 160);
    }
  }

  const apnsId = response.headers.get("apns-id") ?? response.headers.get("apns-request-id");
  return `${reason} · HTTP ${response.status}${apnsId ? ` · APNs ${apnsId}` : ""}`;
}

async function importPrivateKey(value: string): Promise<CryptoKey> {
  const bytes = decode(value);
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.importKey("pkcs8", data, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

function encodeText(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
