type StoredTextValue = {
  kind: "text";
  value: string;
};

type StoredFileValue = {
  kind: "file";
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
};

type StoredFormValue = StoredTextValue | StoredFileValue;

type StoredBody =
  | { kind: "json"; value: unknown }
  | { kind: "formData"; entries: Array<[string, StoredFormValue]> }
  | { kind: "urlSearchParams"; entries: Array<[string, string]> }
  | { kind: "text"; value: string }
  | {
      kind: "blob";
      name: string;
      type: string;
      lastModified: number;
      blob: Blob;
    };

type DailyAiInput = {
  id: string;
  dateKey: string;
  createdAt: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: StoredBody;
};

const DB_NAME = "rega-tov-daily-ai-inputs";
const DB_VERSION = 1;
const STORE_NAME = "inputs";
const CHANGE_EVENT = "rega-tov:daily-ai-inputs-changed";
const PANEL_ID = "rega-tov-ai-input-panel";
const BUTTON_ID = "rega-tov-ai-input-button";

const TEXT_KEYS = [
  "text",
  "prompt",
  "message",
  "description",
  "caption",
  "query",
  "note",
  "notes",
  "input",
  "meal",
  "content",
];

const IMAGE_KEYS = [
  "image",
  "images",
  "photo",
  "photos",
  "picture",
  "file",
  "files",
  "attachment",
  "attachments",
];

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("dateKey", "dateKey", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
  });
}

async function purgeOldRecords() {
  const db = await openDb();
  const today = localDateKey();
  let deletedAny = false;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }

      const value = cursor.value as DailyAiInput;
      if (value.dateKey !== today) {
        deletedAny = true;
        cursor.delete();
      }
      cursor.continue();
    };

    request.onerror = () => reject(request.error ?? new Error("Failed to purge old AI inputs"));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to purge old AI inputs"));
    };
  });

  if (deletedAny) {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
}

async function saveRecord(record: DailyAiInput) {
  await purgeOldRecords();
  await withStore("readwrite", (store) => store.put(record));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

async function deleteRecord(id: string) {
  await withStore("readwrite", (store) => store.delete(id));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

async function listTodayRecords(): Promise<DailyAiInput[]> {
  await purgeOldRecords();
  const all = await withStore<DailyAiInput[]>("readonly", (store) => store.getAll());
  return all
    .filter((item) => item.dateKey === localDateKey())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const runtimeAuthHeaders = new Map<string, string>();

function rememberRuntimeAuthHeaders(headers: Headers) {
  for (const name of ["authorization", "x-api-key", "x-auth-token", "x-csrf-token"]) {
    const value = headers.get(name);
    if (value) {
      runtimeAuthHeaders.set(name, value);
    }
  }
}

function safeHeaders(headers: Headers) {
  const allowed = new Set([
    "accept",
    "content-type",
    "x-csrf-token",
    "x-requested-with",
  ]);

  return Array.from(headers.entries()).filter(([name]) =>
    allowed.has(name.toLowerCase()),
  );
}

function parseJsonText(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function formDataToStored(formData: FormData): Promise<StoredBody> {
  const entries: Array<[string, StoredFormValue]> = [];

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      entries.push([key, { kind: "text", value }]);
      continue;
    }

    entries.push([
      key,
      {
        kind: "file",
        name: value.name || "image",
        type: value.type || "application/octet-stream",
        lastModified: value.lastModified || Date.now(),
        blob: value,
      },
    ]);
  }

  return { kind: "formData", entries };
}

async function snapshotBody(request: Request, init?: RequestInit): Promise<StoredBody | null> {
  const explicitBody = init?.body;

  if (explicitBody instanceof FormData) {
    return formDataToStored(explicitBody);
  }

  if (explicitBody instanceof URLSearchParams) {
    return {
      kind: "urlSearchParams",
      entries: Array.from(explicitBody.entries()),
    };
  }

  if (explicitBody instanceof Blob) {
    return {
      kind: "blob",
      name: explicitBody instanceof File ? explicitBody.name : "image",
      type: explicitBody.type || "application/octet-stream",
      lastModified: explicitBody instanceof File ? explicitBody.lastModified : Date.now(),
      blob: explicitBody,
    };
  }

  if (typeof explicitBody === "string") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = parseJsonText(explicitBody);
      if (parsed !== null) {
        return { kind: "json", value: parsed };
      }
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      return {
        kind: "urlSearchParams",
        entries: Array.from(new URLSearchParams(explicitBody).entries()),
      };
    }

    return { kind: "text", value: explicitBody };
  }

  if (!request.body) {
    return null;
  }

  const clone = request.clone();
  const contentType = clone.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    try {
      return formDataToStored(await clone.formData());
    } catch {
      return null;
    }
  }

  try {
    const text = await clone.text();
    if (!text) {
      return null;
    }

    if (contentType.includes("application/json")) {
      const parsed = parseJsonText(text);
      if (parsed !== null) {
        return { kind: "json", value: parsed };
      }
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      return {
        kind: "urlSearchParams",
        entries: Array.from(new URLSearchParams(text).entries()),
      };
    }

    return { kind: "text", value: text };
  } catch {
    return null;
  }
}

function hasTextLikeKey(key: string) {
  const normalized = key.toLowerCase();
  return TEXT_KEYS.some((candidate) => normalized === candidate || normalized.includes(candidate));
}

function hasImageLikeKey(key: string) {
  const normalized = key.toLowerCase();
  return IMAGE_KEYS.some((candidate) => normalized === candidate || normalized.includes(candidate));
}

function bodyHasAiFields(body: StoredBody): boolean {
  if (body.kind === "formData") {
    return body.entries.some(
      ([key, value]) =>
        hasTextLikeKey(key) ||
        hasImageLikeKey(key) ||
        value.kind === "file",
    );
  }

  if (body.kind === "urlSearchParams") {
    return body.entries.some(
      ([key]) => hasTextLikeKey(key) || hasImageLikeKey(key),
    );
  }

  if (body.kind === "blob") {
    return body.type.startsWith("image/");
  }

  if (body.kind === "text") {
    return body.value.trim().length > 0;
  }

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!isRecord(value)) {
      return false;
    }

    return Object.entries(value).some(
      ([key, child]) =>
        hasTextLikeKey(key) ||
        hasImageLikeKey(key) ||
        visit(child),
    );
  };

  return visit(body.value);
}

function looksLikeAiRequest(request: Request, body: StoredBody) {
  const method = request.method.toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(request.url, window.location.href);
  } catch {
    return false;
  }

  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    return false;
  }

  const path = url.pathname.toLowerCase();
  const blocked = [
    "/auth",
    "/login",
    "/logout",
    "/signup",
    "/register",
    "/settings",
    "/profile",
    "/favorite",
    "/merge",
  ];

  if (blocked.some((piece) => path.includes(piece))) {
    return false;
  }

  const aiPathHints = [
    "/ai",
    "analy",
    "coach",
    "chat",
    "vision",
    "meal",
    "food",
    "nutrition",
    "photo",
    "image",
    "estimate",
    "scan",
  ];

  return aiPathHints.some((piece) => path.includes(piece)) || bodyHasAiFields(body);
}

function normalizeStoredUrl(request: Request) {
  try {
    const url = new URL(request.url, window.location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return request.url;
  }
}

async function captureRequest(request: Request, init?: RequestInit) {
  const body = await snapshotBody(request, init);
  if (!body || !looksLikeAiRequest(request, body)) {
    return;
  }

  const record: DailyAiInput = {
    id: crypto.randomUUID(),
    dateKey: localDateKey(),
    createdAt: new Date().toISOString(),
    url: normalizeStoredUrl(request),
    method: request.method.toUpperCase(),
    headers: safeHeaders(request.headers),
    body,
  };

  await saveRecord(record);
}

function extractJsonText(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractJsonText(item);
      if (found) return found;
    }
    return "";
  }

  if (!isRecord(value)) {
    return "";
  }

  for (const [key, child] of Object.entries(value)) {
    if (hasTextLikeKey(key) && typeof child === "string") {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    const found = extractJsonText(child);
    if (found) return found;
  }

  return "";
}

function extractText(body: StoredBody): string {
  if (body.kind === "text") {
    return body.value;
  }

  if (body.kind === "json") {
    return extractJsonText(body.value);
  }

  if (body.kind === "formData") {
    const preferred = body.entries.find(
      ([key, value]) => hasTextLikeKey(key) && value.kind === "text",
    );
    if (preferred?.[1].kind === "text") {
      return preferred[1].value;
    }

    const first = body.entries.find(([, value]) => value.kind === "text");
    return first?.[1].kind === "text" ? first[1].value : "";
  }

  if (body.kind === "urlSearchParams") {
    const preferred = body.entries.find(([key]) => hasTextLikeKey(key));
    return preferred?.[1] ?? body.entries[0]?.[1] ?? "";
  }

  return "";
}

function replaceJsonText(value: unknown, text: string): unknown {
  if (Array.isArray(value)) {
    let replaced = false;
    const next = value.map((item) => {
      if (replaced) return item;
      const candidate = replaceJsonText(item, text);
      if (candidate !== item) {
        replaced = true;
      }
      return candidate;
    });
    return replaced ? next : value;
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const [key, child] of Object.entries(value)) {
    if (hasTextLikeKey(key) && typeof child === "string") {
      return { ...value, [key]: text };
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const candidate = replaceJsonText(child, text);
    if (candidate !== child) {
      return { ...value, [key]: candidate };
    }
  }

  return value;
}

function setText(body: StoredBody, text: string): StoredBody {
  if (body.kind === "text") {
    return { ...body, value: text };
  }

  if (body.kind === "json") {
    const replaced = replaceJsonText(body.value, text);
    if (replaced !== body.value) {
      return { kind: "json", value: replaced };
    }

    if (isRecord(body.value)) {
      return { kind: "json", value: { ...body.value, text } };
    }

    return { kind: "json", value: { text, original: body.value } };
  }

  if (body.kind === "formData") {
    const entries = body.entries.map(
      ([key, value]) => [key, value] as [string, StoredFormValue],
    );
    const index = entries.findIndex(
      ([key, value]) => hasTextLikeKey(key) && value.kind === "text",
    );

    if (index >= 0) {
      entries[index] = [entries[index][0], { kind: "text", value: text }];
    } else {
      entries.push(["text", { kind: "text", value: text }]);
    }

    return { kind: "formData", entries };
  }

  if (body.kind === "urlSearchParams") {
    const entries = body.entries.map(([key, value]) => [key, value] as [string, string]);
    const index = entries.findIndex(([key]) => hasTextLikeKey(key));

    if (index >= 0) {
      entries[index] = [entries[index][0], text];
    } else {
      entries.push(["text", text]);
    }

    return { kind: "urlSearchParams", entries };
  }

  return body;
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed reading image"));
    reader.readAsDataURL(file);
  });
}

function replaceJsonImage(value: unknown, imageDataUrl: string): unknown {
  if (Array.isArray(value)) {
    let replaced = false;
    const next = value.map((item) => {
      if (replaced) return item;
      const candidate = replaceJsonImage(item, imageDataUrl);
      if (candidate !== item) {
        replaced = true;
      }
      return candidate;
    });
    return replaced ? next : value;
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const key of Object.keys(value)) {
    if (hasImageLikeKey(key)) {
      return { ...value, [key]: imageDataUrl };
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const candidate = replaceJsonImage(child, imageDataUrl);
    if (candidate !== child) {
      return { ...value, [key]: candidate };
    }
  }

  return value;
}

async function setImage(body: StoredBody, file: File): Promise<StoredBody> {
  if (body.kind === "formData") {
    const entries = body.entries.map(
      ([key, value]) => [key, value] as [string, StoredFormValue],
    );
    const storedFile: StoredFileValue = {
      kind: "file",
      name: file.name || "image",
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
      blob: file,
    };

    const index = entries.findIndex(
      ([key, value]) => hasImageLikeKey(key) || value.kind === "file",
    );

    if (index >= 0) {
      entries[index] = [entries[index][0], storedFile];
    } else {
      entries.push(["image", storedFile]);
    }

    return { kind: "formData", entries };
  }

  const imageDataUrl = await fileToDataUrl(file);

  if (body.kind === "json") {
    const replaced = replaceJsonImage(body.value, imageDataUrl);
    if (replaced !== body.value) {
      return { kind: "json", value: replaced };
    }

    if (isRecord(body.value)) {
      return { kind: "json", value: { ...body.value, image: imageDataUrl } };
    }

    return {
      kind: "json",
      value: { image: imageDataUrl, original: body.value },
    };
  }

  if (body.kind === "urlSearchParams") {
    const entries = body.entries.map(([key, value]) => [key, value] as [string, string]);
    const index = entries.findIndex(([key]) => hasImageLikeKey(key));

    if (index >= 0) {
      entries[index] = [entries[index][0], imageDataUrl];
    } else {
      entries.push(["image", imageDataUrl]);
    }

    return { kind: "urlSearchParams", entries };
  }

  if (body.kind === "blob") {
    return {
      kind: "blob",
      name: file.name || "image",
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
      blob: file,
    };
  }

  return body;
}

function headersForReplay(
  storedHeaders: Array<[string, string]>,
  body: StoredBody,
): Headers {
  const headers = new Headers(storedHeaders);

  for (const [name, value] of runtimeAuthHeaders) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  if (body.kind === "formData") {
    headers.delete("content-type");
  } else if (body.kind === "json") {
    headers.set("content-type", "application/json");
  } else if (body.kind === "urlSearchParams") {
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  } else if (body.kind === "blob" && body.type) {
    headers.set("content-type", body.type);
  }

  return headers;
}

function restoreBody(body: StoredBody): BodyInit {
  if (body.kind === "json") {
    return JSON.stringify(body.value);
  }

  if (body.kind === "text") {
    return body.value;
  }

  if (body.kind === "urlSearchParams") {
    return new URLSearchParams(body.entries);
  }

  if (body.kind === "blob") {
    return new File([body.blob], body.name, {
      type: body.type,
      lastModified: body.lastModified,
    });
  }

  const formData = new FormData();
  for (const [key, value] of body.entries) {
    if (value.kind === "text") {
      formData.append(key, value.value);
    } else {
      formData.append(
        key,
        new File([value.blob], value.name, {
          type: value.type,
          lastModified: value.lastModified,
        }),
      );
    }
  }
  return formData;
}

async function replayRecord(record: DailyAiInput, text: string, image?: File) {
  let body = setText(record.body, text);
  if (image) {
    body = await setImage(body, image);
  }

  const response = await window.fetch(record.url, {
    method: record.method,
    headers: headersForReplay(record.headers, body),
    body: restoreBody(body),
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function endpointLabel(url: string) {
  try {
    const parsed = new URL(url, window.location.href);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join(" / ") || "AI";
  } catch {
    return "AI";
  }
}

function injectStyles() {
  if (document.getElementById("rega-tov-ai-input-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "rega-tov-ai-input-styles";
  style.textContent = `
    #${BUTTON_ID} {
      position: fixed;
      z-index: 9998;
      left: 14px;
      bottom: 86px;
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
      background: Canvas;
      color: CanvasText;
    }

    #${PANEL_ID} {
      position: fixed;
      z-index: 9999;
      left: 12px;
      right: 12px;
      bottom: 138px;
      max-height: min(70vh, 620px);
      overflow: auto;
      direction: rtl;
      border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
      border-radius: 18px;
      padding: 14px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.2);
      background: Canvas;
      color: CanvasText;
    }

    #${PANEL_ID}[hidden] {
      display: none;
    }

    .rega-ai-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .rega-ai-head h2 {
      margin: 0;
      font-size: 1rem;
    }

    .rega-ai-close,
    .rega-ai-action,
    .rega-ai-delete {
      font: inherit;
      cursor: pointer;
      border-radius: 10px;
      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      background: Canvas;
      color: CanvasText;
    }

    .rega-ai-list {
      display: grid;
      gap: 10px;
    }

    .rega-ai-card {
      border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
      border-radius: 14px;
      padding: 12px;
      background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
    }

    .rega-ai-meta {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 0.82rem;
      opacity: 0.72;
    }

    .rega-ai-card textarea {
      width: 100%;
      min-height: 88px;
      resize: vertical;
      box-sizing: border-box;
      font: inherit;
      direction: rtl;
      border-radius: 10px;
      padding: 10px;
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      background: Canvas;
      color: CanvasText;
    }

    .rega-ai-file {
      margin-top: 8px;
      width: 100%;
      font: inherit;
    }

    .rega-ai-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }

    .rega-ai-action {
      font-weight: 700;
    }

    .rega-ai-delete {
      color: #a5382f;
    }

    .rega-ai-status {
      margin-inline-start: auto;
      font-size: 0.84rem;
    }

    .rega-ai-empty {
      margin: 0;
      padding: 12px 4px;
      opacity: 0.72;
    }

    @media (min-width: 700px) {
      #${PANEL_ID} {
        left: 24px;
        right: auto;
        width: min(520px, calc(100vw - 48px));
      }
    }
  `;
  document.head.appendChild(style);
}

async function renderPanel(panel: HTMLElement) {
  const list = panel.querySelector<HTMLElement>(".rega-ai-list");
  if (!list) {
    return;
  }

  const records = await listTodayRecords();
  list.replaceChildren();

  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "rega-ai-empty";
    empty.textContent = "עדיין אין קלטי AI שמורים מהיום.";
    list.appendChild(empty);
    return;
  }

  for (const record of records) {
    const card = document.createElement("article");
    card.className = "rega-ai-card";

    const meta = document.createElement("div");
    meta.className = "rega-ai-meta";

    const label = document.createElement("span");
    label.textContent = endpointLabel(record.url);

    const time = document.createElement("time");
    time.dateTime = record.createdAt;
    time.textContent = formatTime(record.createdAt);

    meta.append(label, time);

    const textarea = document.createElement("textarea");
    textarea.value = extractText(record.body);
    textarea.placeholder = "אפשר לערוך או להוסיף מלל לפני שליחה מחדש";
    textarea.setAttribute("aria-label", "מלל לשליחה מחדש");

    const file = document.createElement("input");
    file.className = "rega-ai-file";
    file.type = "file";
    file.accept = "image/*";
    file.setAttribute("aria-label", "הוספת או החלפת תמונה");

    const row = document.createElement("div");
    row.className = "rega-ai-row";

    const resend = document.createElement("button");
    resend.type = "button";
    resend.className = "rega-ai-action";
    resend.textContent = "שליחה מחדש";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "rega-ai-delete";
    remove.textContent = "מחיקה";

    const status = document.createElement("span");
    status.className = "rega-ai-status";
    status.setAttribute("role", "status");

    resend.addEventListener("click", async () => {
      resend.disabled = true;
      remove.disabled = true;
      status.textContent = "שולחים…";

      try {
        await replayRecord(record, textarea.value, file.files?.[0]);
        status.textContent = "נשלח ✓";
        file.value = "";
      } catch {
        status.textContent = "השליחה נכשלה";
      } finally {
        resend.disabled = false;
        remove.disabled = false;
      }
    });

    remove.addEventListener("click", async () => {
      remove.disabled = true;
      resend.disabled = true;
      status.textContent = "מוחקים…";

      try {
        await deleteRecord(record.id);
      } catch {
        status.textContent = "המחיקה נכשלה";
        remove.disabled = false;
        resend.disabled = false;
      }
    });

    row.append(resend, remove, status);
    card.append(meta, textarea, file, row);
    list.appendChild(card);
  }
}

function mountUi() {
  injectStyles();

  if (document.getElementById(BUTTON_ID) || document.getElementById(PANEL_ID)) {
    return;
  }

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = "קלטי AI מהיום";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", PANEL_ID);

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.hidden = true;
  panel.setAttribute("aria-label", "קלטי AI מהיום");

  const head = document.createElement("div");
  head.className = "rega-ai-head";

  const title = document.createElement("h2");
  title.textContent = "קלטי AI מהיום";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "rega-ai-close";
  close.textContent = "סגירה";

  const list = document.createElement("div");
  list.className = "rega-ai-list";

  head.append(title, close);
  panel.append(head, list);
  document.body.append(button, panel);

  const setOpen = async (open: boolean) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      await renderPanel(panel);
    }
  };

  button.addEventListener("click", () => {
    void setOpen(panel.hidden);
  });

  close.addEventListener("click", () => {
    void setOpen(false);
  });

  window.addEventListener(CHANGE_EVENT, () => {
    if (!panel.hidden) {
      void renderPanel(panel);
    }
  });
}

function scheduleMidnightPurge() {
  const now = new Date();
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    2,
    0,
  );
  const delay = Math.max(1000, tomorrow.getTime() - now.getTime());

  window.setTimeout(() => {
    void purgeOldRecords().finally(scheduleMidnightPurge);
  }, delay);
}

function installCapture() {
  const marker = "__regaTovDailyAiCaptureInstalled";
  const markedWindow = window as unknown as Window & Record<string, unknown>;

  if (markedWindow[marker]) {
    return;
  }
  markedWindow[marker] = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let request: Request | null = null;

    try {
      request =
        input instanceof Request
          ? new Request(input.clone(), init)
          : new Request(input, init);
      rememberRuntimeAuthHeaders(request.headers);
    } catch {
      request = null;
    }

    const response = originalFetch(input, init);

    if (request) {
      void captureRequest(request, init).catch(() => {
        // Input history is a convenience feature; capture failures must never block the app.
      });
    }

    return response;
  }) as typeof window.fetch;

  void purgeOldRecords().catch(() => {
    // Keep the main app functional even if IndexedDB is unavailable.
  });

  scheduleMidnightPurge();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountUi, { once: true });
  } else {
    mountUi();
  }
}

if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
  installCapture();
}
