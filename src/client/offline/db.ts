import { openDB, type DBSchema } from "idb";

type PendingMutation = {
  id: string;
  url: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body: unknown;
  createdAt: string;
  attempts: number;
};

type PendingCapture = {
  id: string;
  files: Blob[];
  occurredAt: string;
  category: string;
  createdAt: string;
  status: "pending" | "syncing" | "failed";
};

type CachedEntity = {
  key: string;
  value: unknown;
  updatedAt: string;
};

interface NutritionDb extends DBSchema {
  pendingMutations: {
    key: string;
    value: PendingMutation;
    indexes: { "by-created": string };
  };
  pendingCaptures: {
    key: string;
    value: PendingCapture;
    indexes: { "by-created": string };
  };
  cache: {
    key: string;
    value: CachedEntity;
  };
}

const dbPromise = openDB<NutritionDb>("rega-tov", 1, {
  upgrade(db) {
    const mutations = db.createObjectStore("pendingMutations", { keyPath: "id" });
    mutations.createIndex("by-created", "createdAt");
    const captures = db.createObjectStore("pendingCaptures", { keyPath: "id" });
    captures.createIndex("by-created", "createdAt");
    db.createObjectStore("cache", { keyPath: "key" });
  },
});

export async function queueMutation(mutation: Omit<PendingMutation, "attempts">): Promise<void> {
  const db = await dbPromise;
  await db.put("pendingMutations", { ...mutation, attempts: 0 });
}

export async function listPendingMutations(): Promise<PendingMutation[]> {
  return (await dbPromise).getAllFromIndex("pendingMutations", "by-created");
}

export async function removePendingMutation(id: string): Promise<void> {
  await (await dbPromise).delete("pendingMutations", id);
}

export async function queueCapture(capture: PendingCapture): Promise<void> {
  await (await dbPromise).put("pendingCaptures", capture);
}

export async function listPendingCaptures(): Promise<PendingCapture[]> {
  return (await dbPromise).getAllFromIndex("pendingCaptures", "by-created");
}

export async function updateCapture(capture: PendingCapture): Promise<void> {
  await (await dbPromise).put("pendingCaptures", capture);
}

export async function removeCapture(id: string): Promise<void> {
  await (await dbPromise).delete("pendingCaptures", id);
}

export async function cacheValue(key: string, value: unknown): Promise<void> {
  await (await dbPromise).put("cache", { key, value, updatedAt: new Date().toISOString() });
}

export async function readCachedValue<T>(key: string): Promise<T | null> {
  const row = await (await dbPromise).get("cache", key);
  return (row?.value as T | undefined) ?? null;
}
