// public/sw.js
/* Minimal service worker for phone-only web push (PWA) */

self.addEventListener('install', (event) => {
  // Activate updated SW immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Control any open clients right away
  event.waitUntil(self.clients.claim());
});

/**
 * Expected push payload (JSON):
 * {
 *   "title": "New text from Jane Doe",
 *   "body": "Hey, can we talk at 3pm?",
 *   "url": "/app/messages/CONTACT_ID",  // where to navigate on click
 *   "tag": "msg-contact-123",           // optional to group/replace
 *   "badge": "/favicon-32x32.png",      // optional
 *   "icon": "/android-chrome-192x192.png" // optional
 * }
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // Fallback if a non-JSON payload ever arrives
    data = { title: 'Remie CRM', body: event.data && event.data.text ? event.data.text() : '' };
  }

  const title = data.title || 'Remie CRM';
  const options = {
    body: data.body || '',
    icon: data.icon || '/android-chrome-192x192.png',
    badge: data.badge || '/favicon-32x32.png',
    tag: data.tag,               // lets the browser coalesce similar notifications
    renotify: !!data.renotify,   // optional
    data: {
      // preserve the URL we want to open/focus on click
      url: data.url || '/app',
      // carry through any other fields if needed
      ...data,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification && event.notification.data && event.notification.data.url) || '/app';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const origin = self.location.origin;
    const target = new URL(targetUrl, origin).href;

    // If a client with our app is already open, focus it (and optionally navigate)
    for (const client of allClients) {
      try {
        // If it's already on the target (or same origin app shell), just focus it
        if (client.url === target || client.url.startsWith(origin + '/')) {
          await client.focus();
          // Optionally ask client to navigate to target via postMessage (app can listen)
          client.postMessage({ type: 'OPEN_URL', url: target });
          return;
        }
      } catch {}
    }

    // Otherwise open a new window/tab
    await self.clients.openWindow(target);
  })());
});
