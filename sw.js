/*
 * ours — sw.js (서비스 워커)
 * 휴대폰에 알림을 띄우고, 알림을 누르면 앱의 해당 화면을 열어 줘요.
 * 화면 저장(오프라인 캐시)은 하지 않아서, 사이트를 고치면 바로 새 버전이 보여요.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'ours';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icon.png',
    badge: 'icon.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        try { await w.navigate(target); } catch (e) { /* 같은 페이지면 무시 */ }
        return w.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
