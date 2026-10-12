/* ================================================================
   Работа приложения без интернета (service worker).
   При установке сохраняет на телефоне всё нужное: страницу, скрипты, точки, граф пеших дорог
   и все картинки карты (≈ 3,5 МБ). Дальше:
     - картинки карты — сразу из сохранённого (они не меняются, пока не пересобрана карта);
     - остальное — сразу из сохранённого, а в фоне обновляется из сети (новые точки из
       js/points.js появятся при следующем запуске).
   Пересобрали карту или граф (tools/build_map.py, tools/build_routes.py) — увеличьте VERSION.
   ================================================================ */
self.window = self;                  // js/map-data.js пишет в window, а здесь его нет
importScripts("../js/map-data.js"); // FASTCUP_MAP: уровни и размеры картинок карты

var VERSION = "1";
var CORE = "fastcup-app-" + VERSION;
var TILES = "fastcup-tiles-" + VERSION;
var FILES = [
  "./", "index.html", "app.css", "app.js", "route-worker.js", "manifest.webmanifest", "data/walk-graph.bin",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-180.png",
  "../js/points.js", "../js/map-data.js", "../js/omap.js", "../css/omap.css",
  "../images/web/logo-light.png", "../images/web/favicon.png"
];

function tileUrls() {
  var M = self.FASTCUP_MAP, out = [];
  M.levels.forEach(function (s, z) {
    var cols = Math.ceil(M.width * s / M.tile), rows = Math.ceil(M.height * s / M.tile);
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++)
      out.push("../" + M.tiles.replace("{z}", z).replace("{x}", c).replace("{y}", r));
  });
  return out;
}

/* скачать список по несколько файлов за раз; ошибки отдельных картинок не мешают установке */
function fetchAll(cache, urls, parallel) {
  var i = 0;
  function next() {
    if (i >= urls.length) return Promise.resolve();
    var url = urls[i++];
    return fetch(url).then(function (res) { if (res.ok) return cache.put(url, res); })
      .catch(function () {}).then(next);
  }
  var workers = [];
  for (var k = 0; k < parallel; k++) workers.push(next());
  return Promise.all(workers);
}

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CORE).then(function (c) { return c.addAll(FILES); })
      .then(function () { return caches.open(TILES); })
      .then(function (c) { return fetchAll(c, tileUrls(), 6); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf("fastcup-") === 0 && k !== CORE && k !== TILES; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (req.url.indexOf("/images/web/map/") !== -1) {         // картинки карты: сначала сохранённые
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res.ok) { var copy = res.clone(); caches.open(TILES).then(function (c) { c.put(req, copy); }); }
        return res;
      });
    }));
    return;
  }

  // остальное: сразу из сохранённого, в фоне — свежая версия из сети
  e.respondWith(caches.open(CORE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () {
        return hit || (req.mode === "navigate" ? cache.match("index.html") : Response.error());
      });
      return hit || net;
    });
  }));
});
