/* 부산 수학여행 — 푸시 알림 서비스 워커
   페이지가 닫혀 있어도 서버(Supabase Edge Function)가 보낸 집합 알림을 받아서 띄워요. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '🚩 집합 알림', {
    body: d.body || '',
    tag: d.tag || 'meet',
    requireInteraction: true,   // 확인 누를 때까지 알림이 화면에 남아 있게 (안드로이드·PC)
    renotify: true,             // 같은 알림이 다시 와도 알림 소리·진동이 다시 울리게
    vibrate: [400, 200, 400, 200, 600],   // 휴대폰 '알림 소리'(시스템 알림음)와 진동으로 울림 — 미디어 소리 아님
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if (w.url.startsWith(self.registration.scope) && 'focus' in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
