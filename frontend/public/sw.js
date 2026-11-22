/**
 * PetCare AI / VetScribe — Service Worker for Web Push Notifications
 * ─────────────────────────────────────────────────────────────────
 * Handles background push notifications for appointment confirmations,
 * cancellations, reschedules, and 24-hour visit reminders.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'PetCare AI Appointment Update',
    body: 'You have a new update regarding your veterinary appointment.',
    url: '/owner-portal',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch (_) {
      payload.body = event.data.text() || payload.body;
    }
  }

  const options = {
    body: payload.body,
    icon: '/petpulse-badge.png',
    badge: '/petpulse-badge.png',
    tag: 'petcare-appointment-notice',
    renotify: true,
    data: {
      url: payload.url || '/owner-portal',
    },
    vibrate: [100, 50, 100],
    actions: [
      {
        action: 'open-portal',
        title: 'Open Portal',
      },
    ],
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetPath = (event.notification.data && event.notification.data.url) || '/owner-portal';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/owner-portal') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetPath);
      }
    })
  );
});

