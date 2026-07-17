/* ============================================================
   SERVICE WORKER — Джиттер-тест PWA
   Стратегия: Cache First для оффлайн-работы
   ============================================================ */

const CACHE_NAME = 'jitter-v1.3.0';

// Файлы, которые кэшируем при установке
const PRECACHE_URLS = [
  './index.html',
  './app.js',
  './sw.js',
  './manifest.json',
];

// ── Установка: кэшируем все файлы приложения ──────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => {
      // Активируем новый SW сразу, без ожидания закрытия вкладок
      return self.skipWaiting();
    })
  );
});

// ── Активация: удаляем старые кэши ───────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// ── Перехват запросов: Cache First ───────────────────────────
self.addEventListener('fetch', (event) => {
  // Обрабатываем только GET-запросы в рамках нашего origin
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Есть в кэше — отдаём сразу (оффлайн работает)
        return cachedResponse;
      }
      // Нет в кэше — идём в сеть и кэшируем результат
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Полный оффлайн — ничего не можем сделать
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
