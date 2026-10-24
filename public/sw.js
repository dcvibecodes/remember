'use strict';

const CACHE = 'todo-v2.0.0';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/fonts/fraunces-latin-600.woff2',
  '/fonts/outfit-latin-var.woff2',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const fallback = await caches.match('/index.html');
          if (fallback) return fallback;
        }
        return Response.error();
      })
  );
});

function actionsSupported() {
  // Notification action buttons only exist on some platforms (Chrome on
  // desktop/Android). iOS PWAs do not reliably support them, so the in-app
  // Snooze/Complete buttons are the always-available path and these are a
  // progressive enhancement, never a requirement.
  try {
    return typeof Notification !== 'undefined'
      && Notification.prototype
      && 'actions' in Notification.prototype;
  } catch {
    return false;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const tag = data.tag || 'todo';
  const options = {
    body: data.body || 'You have a to-do due.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag,
    renotify: true,
    data: {
      url: data.url || '/#/today',
      reminderId: data.reminderId || null,
      occurrence: data.occurrence || null,
      sigComplete: data.sigComplete || null,
      sigSnooze: data.sigSnooze || null,
    },
  };
  if (data.reminderId && data.occurrence && actionsSupported()) {
    options.actions = [
      { action: 'complete', title: 'Complete' },
      { action: 'snooze', title: 'Snooze 1 hour' },
    ];
  }
  event.waitUntil(self.registration.showNotification(data.title || 'ToDo', options));
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  // Action buttons post a signed request: the service worker holds no
  // session or CSRF token, so the signature (bound to reminder + scheduled
  // occurrence + action) is the authorization.
  if ((event.action === 'complete' || event.action === 'snooze') && data.reminderId && data.occurrence) {
    const sig = event.action === 'complete' ? data.sigComplete : data.sigSnooze;
    event.notification.close();
    event.waitUntil(
      fetch('/api/push/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reminder_id: data.reminderId,
          occurrence_at: data.occurrence,
          action: event.action,
          sig,
        }),
      }).catch(() => {})
    );
    return;
  }

  event.notification.close();
  const target = data.url || '/#/today';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.navigate(new URL(target, self.location.origin).href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
