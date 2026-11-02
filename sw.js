// Lưu vỏ app để mở nhanh và dùng được khi mạng chập chờn. Không bao giờ lưu cuộc gọi tới API.
const CACHE = 'ecs-v6';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/engine.js', 'js/ocr.js', 'js/store.js', 'js/export.js', 'js/zip.js', 'js/lock.js', 'js/vendor/exceljs.min.js', 'manifest.webmanifest', 'icons/icon.svg'];

self.addEventListener('install', (e) => {
  // no-store: bỏ qua bộ nhớ đệm của GitHub Pages (giữ bản cũ tới 10 phút) để luôn nhận bản mới nhất.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'no-store' }).then((r) => c.put(u, r))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Mạng trước, lỗi mạng thì dùng bản đã lưu: sửa code xong là thấy ngay, không kẹt bản cũ.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)),
  );
});
