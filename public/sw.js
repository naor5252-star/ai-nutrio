const SHELL_CACHE = "rega-tov-shell-v26";
const RUNTIME_CACHE = "rega-tov-runtime-v26";
const SHELL = ["/", "/offline.html", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => ![SHELL_CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match("/offline.html"))),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(showLatestPushNotification());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            if ("navigate" in client) await client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

async function showLatestPushNotification() {
  let notification = {
    id: "generic",
    title: "רגע טוב 🌱",
    body: "יש לך עדכון חדש. פתח את רגע טוב כדי לראות אותו.",
    url: "/",
  };

  try {
    const response = await fetch("/api/v1/push/pending", {
      credentials: "include",
      cache: "no-store",
    });
    if (response.ok) {
      const payload = await response.json();
      if (payload.notification) notification = payload.notification;
    }
  } catch {
    // Privacy-safe fallback if the app session is temporarily unavailable.
  }

  await self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: `rega-tov-${notification.id}`,
    data: { url: notification.url || "/" },
  });
}
