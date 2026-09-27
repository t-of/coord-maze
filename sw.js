// オフライン用のサービスワーカー (登録は src/offline.js)。
//
// 自分のファイルは network-first (つながっていれば常に最新、圏外なら保存しておいた版)。
// Google Fonts は変わらないので cache-first。
//
// 読み込み URL には ?v=<ハッシュ> が付いている (tools/stamp.mjs)。圏外のときは
// ?v= を無視して探すので、SHELL には版なしの URL を並べておけば足りる。
//
// 注意: キャッシュ (CacheStorage) は t-of.github.io のすべてのアプリで共有されている。
// 古いキャッシュを消すときは、必ず自分の PREFIX で始まるものだけを消す。
// keys.filter(k => k !== CACHE) のように書くと、ほかのアプリのキャッシュまで消してしまう。

const PREFIX = 'coord-maze-';

// --- ここから下の 2 つは node tools/stamp.mjs が書く (手で直さない) ---
const VERSION = '96de65c2';
const SHELL = [
  './',
  './index.html',
  './tutorial.html',
  './src/coord.js',
  './src/coordboard.js',
  './src/hmaze.js',
  './src/mazend.js',
  './src/offline.js',
  './src/puzzle.js',
  './src/records.js',
  './src/rng.js',
  './src/save.js',
  './src/share.js',
  './src/sound.js',
  './src/starfield.js',
  './src/tutorial.js',
  './src/ui.js',
  './css/coord.css',
  './css/space.css',
  './css/tutorial.css',
  './webapp-kit/webapp-kit.js',
  './webapp-kit/webapp-kit.css',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './icons/maskable-512.png',
];
// --- ここまで ---

const CACHE = `${PREFIX}${VERSION}`;
const FONT_CACHE = `${PREFIX}fonts`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith(PREFIX) && k !== CACHE && k !== FONT_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // このアプリのフォルダの外 (ポータルやほかのアプリ) には手を出さない
    if (!url.href.startsWith(self.registration.scope)) return;
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONT_CACHE));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
