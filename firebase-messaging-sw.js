/* Firebase Cloud Messaging service worker.
   index.html registers this as /firebase-messaging-sw.js?cfg=<encoded firebase config> */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

let cfg = {};
try { cfg = JSON.parse(new URL(self.location).searchParams.get('cfg') || '{}'); } catch (e) {}

if (cfg.apiKey) {
  firebase.initializeApp(cfg);
  const messaging = firebase.messaging();

  // Messages that carry a "notification" block are shown by the browser
  // automatically. Only handle data-only messages here to avoid duplicates.
  messaging.onBackgroundMessage(payload => {
    if (payload.notification) return;
    const d = payload.data || {};
    self.registration.showNotification(d.title || 'Pranaya ♥ Shiva', {
      body: d.body || '',
      icon: '/192.png',
      badge: '/192.png'
    });
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow('/');
    })
  );
});
