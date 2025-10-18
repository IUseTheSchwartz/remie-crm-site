// public/sw.js
/* Minimal service worker for phone-only web push (PWA)
   iOS-safe: no skipWaiting(), no clients.claim() to avoid auto reloads. */

self.addEventListener('install', (event) => {
  // Let the SW install quietly; it will take control on the next navigation/open.
  // (Avoid self.skipWaiting() to prevent iOS PWA refresh loops.)
});

self.addEventListener('activate', (event) => {
  // Do not call clients.claim() here — iOS PWAs can still force a reload when claiming.
});

/**
 * Expected push payload (JSON):
 * {
 *   "title": "New text from Jane Doe",
 *   "body": "Hey, can we talk at 3pm?",
 *   "url": "/app/messages/CONTACT_ID",
 *   "tag": "msg-contact-123",           // optional
 *   "badge": "/favicon-32x32.png",      // optional
 *   "icon": "/android-chrome-192x192.png" // optional
 * }
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Remie CRM', body: event.data && event.data.text ? event.data.text() : '' };
  }

  const title = data.title || 'Remie CRM';
  const options = {
    body: data.body || '',
    icon: data.icon || '/android-chrome-192x192.png',
    badge: data.badge || '/favicon-32x32.png',
    tag: data.tag,
    renotify: !!data.renotify,
    data: {
      url: data.url || '/app',
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

    for (const client of allClients) {
      try {
        if (client.url === target || client.url.startsWith(origin + '/')) {
          await client.focus();
          client.postMessage({ type: 'OPEN_URL', url: target });
          return;
        }
      } catch {}
    }

    await self.clients.openWindow(target);
  })());
});