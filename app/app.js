/* ================================================================
   Приложение Fastcup: где я + пеший маршрут до ближайшего автомата.
   Карта — js/omap.js, точки — js/points.js, маршрут считает route-worker.js
   по графу пеших дорог data/walk-graph.bin (tools/build_routes.py). Без интернета — sw.js.
   ================================================================ */
(function () {
  "use strict";
  var POINTS = window.FASTCUP_POINTS || [];
  var MAP = window.FASTCUP_MAP;
  var WALK_M_PER_MIN = 80;        // ≈ 4,8 км/ч
  var REROUTE_M = 15;             // пересчитываем маршрут, когда прошли больше
  var KEEP_CHOICE_M = 500;        // выбранная вручную точка держится, пока не ушли дальше — потом снова ближайшая

  function $(id) { return document.getElementById(id); }
  var sheet = $("sheet"), statusEl = $("status"), card = $("card"), locateBtn = $("locate");

  var me = null, meMarker = null, gpsOk = false, manual = false;
  var lastFrom = null, follow = false, firstShown = false;
  var results = null, sel = -1;   // результаты маршрута (по возрастанию расстояния) и выбранная точка
  var chosenAt = null;            // где был посетитель, когда сам выбрал точку
  var ready = false, routeId = 0, routeFailed = false;
  var pins = [];

  function status(text) { statusEl.textContent = text || ""; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtDist(m) { return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + " м" : (m / 1000).toFixed(1).replace(".", ",") + " км"; }
  function distance(a, b) { // метры по прямой
    var R = 6371000, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function inMap(c) { return c[0] > MAP.south && c[0] < MAP.north && c[1] > MAP.west && c[1] < MAP.east; }

  if (!MAP || !window.FastcupMap) { status("Не удалось загрузить карту."); return; }

  /* ---------- карта ---------- */
  function wide() { return window.innerWidth >= 700; }
  var omap = FastcupMap($("map"), {
    data: MAP, base: "../", oneFinger: true, wheel: true, maxScale: 4,
    // свободная от шапки и карточки часть экрана — туда помещаем маршрут
    margin: function () { return wide() ? [90, 70, 40, 420] : [90, 20, sheet.offsetHeight + 30, 20]; },
    onUserMove: function () { setFollow(false); },
    onTap: function (c) { if (!gpsOk) setMe(c, 0, true); },
    onError: function () { status("Карта не загрузилась. Проверьте интернет и откройте приложение ещё раз."); }
  });

  POINTS.forEach(function (p, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "omap__pin";
    b.title = p.title;
    b.setAttribute("aria-label", p.title + ", " + p.address);
    b.innerHTML = FastcupMap.PIN;
    b.addEventListener("click", function () { if (results && find(i)) { sel = i; chosenAt = me; show(true); } });
    pins.push(b);
  });
  omap.fit(POINTS.length ? POINTS.map(function (p) { return p.coords; }) : null, false);
  POINTS.forEach(function (p, i) { omap.addMarker(pins[i], p.coords); });

  // кнопка «где я» стоит над карточкой: следим за её высотой
  function placeLocate() { document.documentElement.style.setProperty("--sheet-h", sheet.offsetHeight + "px"); }
  if (window.ResizeObserver) new ResizeObserver(placeLocate).observe(sheet);
  placeLocate();

  /* ---------- маршрут в фоне ---------- */
  var worker = new Worker("route-worker.js");
  worker.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === "ready") { ready = true; requestRoute(); }
    else if (msg.type === "error") { routeFailed = true; requestRoute(); }
    else if (msg.type === "route" && msg.id === routeId) { window.__routeMs = msg.ms; onRoute(msg.results); }
  };
  worker.postMessage({ type: "init", url: "data/walk-graph.bin", mpu: omap.metersPerUnit });

  function requestRoute() {
    if (!me || !POINTS.length) return;
    if (routeFailed) { // граф не загрузился — хотя бы ближайшие по прямой
      onRoute(POINTS.map(function (p, i) { return { i: i, meters: distance(me, p.coords), straight: true }; }));
      return;
    }
    if (!ready) { status("Готовим пешие маршруты…"); return; }
    routeId++;
    worker.postMessage({
      type: "route", id: routeId, from: omap.toXY(me),
      targets: POINTS.map(function (p) { return omap.toXY(p.coords); })
    });
  }

  function onRoute(list) {
    results = list.filter(function (r) { return r.meters != null; }).sort(function (a, b) { return a.meters - b.meters; });
    if (!results.length) { status("Не нашли пешего пути до точек. Попробуйте выбрать место на карте."); return; }
    if (chosenAt && me && distance(chosenAt, me) > KEEP_CHOICE_M) chosenAt = null;
    if (!chosenAt || !find(sel)) sel = results[0].i;
    status(manual ? "Старт выбран на карте. Нажмите на карту ещё раз, чтобы его сменить." : "");
    show(!firstShown);
    firstShown = true;
  }
  function find(i) { for (var k = 0; results && k < results.length; k++) if (results[k].i === i) return results[k]; return null; }

  /* Показать выбранную точку: карточка, линия маршрута, подсветка метки. fit — подвинуть карту к маршруту */
  function show(fit) {
    var r = find(sel); if (!r) return;
    var p = POINTS[r.i];
    card.hidden = false;
    $("kicker").textContent = r.i === results[0].i ? "Ближайший кофе" : "Ещё одна точка";
    $("title").textContent = p.title;
    $("addr").textContent = p.address + (p.hours ? " · " + p.hours : "");
    $("dist").textContent = fmtDist(r.meters);
    $("time").textContent = r.straight ? "по прямой" : "≈ " + Math.max(1, Math.round(r.meters / WALK_M_PER_MIN)) + " мин пешком";
    $("next").hidden = results.length < 2;
    omap.setRoute(r.points || [omap.toXY(me), omap.toXY(p.coords)]);
    pins.forEach(function (b, k) { b.firstChild.classList.toggle("is-selected", k === r.i); });
    if (fit) fitRoute(r);
  }
  function fitRoute(r) {
    var pts = r.points ? r.points.map(function (q) { return omap.fromXY(q[0], q[1]); }) : [me, POINTS[r.i].coords];
    setFollow(false);
    omap.fit(pts, false, true);
  }

  $("show").addEventListener("click", function () { var r = find(sel); if (r) fitRoute(r); });
  $("next").addEventListener("click", function () {
    if (!results) return;
    var k = results.indexOf(find(sel));
    sel = results[(k + 1) % results.length].i;
    chosenAt = me;
    show(true);
  });

  /* ---------- где я ---------- */
  function setMe(c, acc, isManual) {
    me = c;
    manual = !!isManual;
    if (!meMarker) {
      var dot = document.createElement("div");
      dot.className = "omap__me";
      dot.title = "Вы здесь";
      dot.innerHTML = '<div class="fc-me"></div>';
      meMarker = omap.addMarker(dot, c);
    } else omap.moveMarker(meMarker, c);
    omap.setAccuracy(acc ? c : null, acc || 0);
    if (follow) omap.fit([c], true, true);
    if (!lastFrom || isManual || distance(lastFrom, c) > REROUTE_M) { lastFrom = c; requestRoute(); }
  }

  function setFollow(on) { follow = on; locateBtn.classList.toggle("is-follow", on); }
  locateBtn.addEventListener("click", function () {
    if (!me) { startGps(); return; }
    setFollow(true);
    omap.fit([me], false, true);
  });

  var watching = false;
  function startGps() {
    if (!("geolocation" in navigator)) { status("Телефон не сообщает, где вы. Нажмите на карту, чтобы выбрать, откуда идти."); return; }
    if (watching) return;
    watching = true;
    status("Определяем, где вы…");
    navigator.geolocation.watchPosition(function (pos) {
      var c = [pos.coords.latitude, pos.coords.longitude];
      if (!inMap(c)) {
        gpsOk = false;
        if (!manual) status("Вы сейчас не в Перми. Нажмите на карту, чтобы выбрать, откуда идти.");
        return;
      }
      gpsOk = true;
      setMe(c, pos.coords.accuracy, false);
    }, function (err) {
      watching = err.code !== 1;
      if (me && gpsOk) return; // временная ошибка — оставляем последнее место
      gpsOk = false;
      status(err.code === 1
        ? "Нет доступа к геопозиции. Разрешите её для этого сайта — или нажмите на карту, чтобы указать, где вы."
        : "Не удалось определить, где вы. Нажмите на карту, чтобы выбрать, откуда идти.");
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  if (!POINTS.length) status("Точек на карте пока нет.");
  else startGps();

  /* ---------- установка на телефон ---------- */
  var installBtn = $("install"), tip = $("installTip"), deferred = null;
  var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; installBtn.hidden = false; });
  window.addEventListener("appinstalled", function () { installBtn.hidden = true; tip.hidden = true; });
  if (ios && !standalone) installBtn.hidden = false; // на iPhone установка — через «Поделиться»
  installBtn.addEventListener("click", function () {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; installBtn.hidden = true; });
    } else tip.hidden = !tip.hidden;
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
})();
