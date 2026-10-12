(function () {
  "use strict";
  var CFG = window.FASTCUP_CONFIG || {};
  var POINTS = window.FASTCUP_POINTS || [];
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isTouch = window.matchMedia("(pointer: coarse)").matches;

  /* ---------- контакты из config.js ---------- */
  document.querySelectorAll(".js-phone").forEach(function (a) {
    a.href = "tel:" + CFG.phoneHref;
    var span = a.querySelector("span");
    (span || a).textContent = CFG.phone;
  });
  document.querySelectorAll(".js-tg").forEach(function (a) { a.href = CFG.telegram; });
  document.querySelectorAll(".js-max").forEach(function (a) { a.href = CFG.max; });
  var y = document.getElementById("year"); if (y) y.textContent = new Date().getFullYear();

  /* ---------- мобильное меню ---------- */
  var burger = document.querySelector(".burger");
  var mnav = document.getElementById("mnav");
  function setMenu(open) {
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
    mnav.hidden = !open;
  }
  burger.addEventListener("click", function () { setMenu(mnav.hidden); });
  mnav.addEventListener("click", function (e) { if (e.target.tagName === "A") setMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !mnav.hidden) { setMenu(false); burger.focus(); } });

  /* ---------- выбор темы заявки по кнопке ---------- */
  document.querySelectorAll("[data-topic]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var r = document.querySelector('input[name="topic"][value="' + btn.dataset.topic + '"]');
      if (r) r.checked = true;
    });
  });

  /* ---------- подсветка меню: «пилюля» едет за курсором ---------- */
  var nav = document.querySelector(".nav");
  var pill = nav && nav.querySelector(".nav__pill");
  var navLinks = nav ? Array.prototype.slice.call(nav.querySelectorAll("a")) : [];
  var activeLink = null;
  function movePill(a) {
    if (!a) { nav.classList.remove("has-pill"); return; }
    pill.style.width = a.offsetWidth + "px";
    pill.style.transform = "translateX(" + a.offsetLeft + "px)";
    nav.classList.add("has-pill");
  }
  navLinks.forEach(function (a) {
    a.addEventListener("mouseenter", function () { movePill(a); });
    a.addEventListener("focus", function () { movePill(a); });
  });
  function restPill() { movePill(activeLink && activeLink.dataset.spy !== "top" ? activeLink : null); }
  if (nav) nav.addEventListener("mouseleave", restPill);

  /* какой раздел сейчас на экране */
  var spyTargets = navLinks.map(function (a) {
    var id = a.dataset.spy;
    return { a: a, el: id === "top" ? document.querySelector(".hero") : document.getElementById(id) };
  }).filter(function (t) { return t.el; });
  var totop = document.querySelector(".totop");
  var ring = totop && totop.querySelector(".totop__progress");
  var ticking = false;
  function onScroll() {
    ticking = false;
    var y = window.scrollY, vh = window.innerHeight, cur = null;
    spyTargets.forEach(function (t) { if (t.el.getBoundingClientRect().top <= vh * 0.4) cur = t.a; });
    if (cur !== activeLink) {
      if (activeLink) activeLink.classList.remove("is-active");
      activeLink = cur;
      if (activeLink) activeLink.classList.add("is-active");
      if (nav && !nav.matches(":hover")) movePill(activeLink && activeLink.dataset.spy !== "top" ? activeLink : null);
    }
    if (totop) {
      totop.classList.toggle("is-visible", y > vh * 0.8);
      var max = document.documentElement.scrollHeight - vh;
      ring.style.strokeDashoffset = String(157.08 * (1 - Math.min(1, y / (max || 1))));
    }
  }
  window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener("resize", restPill);
  onScroll();

  /* =========================================================
     КАРТА: своя офлайн-карта Перми (движок — js/omap.js) + метки автоматов поверх.
     Двигается мышкой (на телефоне двумя пальцами), не дальше границ города.
     ========================================================= */
  var nearestLabel = document.getElementById("nearestLabel");
  var nearestRoute = document.getElementById("nearestRoute");

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function distance(a, b) { // метры, формула гаверсинусов
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + " м" : (m / 1000).toFixed(1).replace(".", ",") + " км"; }
  function routeUrl(from, to) {
    return "https://yandex.ru/maps/?rtext=" + (from ? from.join(",") : "") + "~" + to.join(",") + "&rtt=pd";
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var count = POINTS.length;
  var nearestNext = document.getElementById("nearestNext");
  var me = null;          // координаты посетителя, если он разрешил геолокацию
  var order = POINTS.map(function (_, i) { return i; }); // порядок точек: ближайшие первыми
  var selected = -1;      // какая точка выбрана сейчас
  var mapEl = document.getElementById("map");
  var omap = null;         // карта (js/omap.js)
  var pins = [];

  nearestLabel.textContent = count + " " + plural(count, "автомат", "автомата", "автоматов") + " в Перми · определяем, где вы";

  /* Выбрать точку: обновить карточку, ссылку маршрута и подсветить метку на карте */
  function selectPoint(i, pan) {
    var p = POINTS[i]; if (!p) return;
    selected = i;
    var dist = me ? distance(me, p.coords) : null;
    var isNearest = me && i === order[0];
    var head = me
      ? (isNearest ? "Ближайший Fastcup" : "Fastcup") + " в <b>" + fmtDist(dist) + "</b> по прямой"
      : "<b>" + esc(p.title) + "</b>";
    nearestLabel.innerHTML = head + "<br>" + esc(p.address) + (p.hours ? " · " + esc(p.hours) : "");
    // Маршрут: от вас (если знаем где вы) до ВЫБРАННОЙ точки, пешком.
    // Без геолокации Яндекс Карты сами подставят ваше местоположение как начало маршрута.
    nearestRoute.href = routeUrl(me, p.coords);
    nearestRoute.hidden = false;
    nearestNext.hidden = count < 2;
    pins.forEach(function (b, k) { b.firstChild.classList.toggle("is-selected", k === i); });
    // показать посетителя и точку вместе; без геолокации — просто подвинуть карту к точке
    if (omap && pan) omap.fit(me ? [me, p.coords] : [p.coords], !me, true);
  }
  nearestNext.addEventListener("click", function () {
    var pos = order.indexOf(selected);
    selectPoint(order[(pos + 1) % order.length], true);
  });

  var PIN_SVG =
    '<svg class="fc-pin" viewBox="0 0 46 56" aria-hidden="true">' +
    '<defs><linearGradient id="fcg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F8B867"/><stop offset=".5" stop-color="#EF8458"/><stop offset="1" stop-color="#C9505A"/></linearGradient></defs>' +
    '<path d="M23 55C23 55 3 34 3 21a20 20 0 0 1 40 0c0 13-20 34-20 34z" fill="url(#fcg)" stroke="#fff" stroke-width="2.5"/>' +
    '<path d="M15 14h16l-2 16h-12z" fill="#fff"/><rect x="13.5" y="11" width="19" height="3.5" rx="1.5" fill="#fff"/>' +
    '<rect x="16.5" y="19" width="13" height="5" fill="#C9505A" opacity=".55"/></svg>';

  function panelMargin() {
    var panel = document.querySelector(".hero__panel");
    if (window.innerWidth <= 960) return [90, 40, 70, 40];  // панель под картой (см. @media 960px в style.css)
    var cupRight = window.innerWidth > 1080 ? 300 : 40;     // справа место под карточку стаканчика, если она видна
    return [110, cupRight, 90, panel.getBoundingClientRect().right + 40];
  }

  function initMap() {
    omap = FastcupMap(mapEl, { data: window.FASTCUP_MAP, margin: panelMargin, onError: mapFallback });
    POINTS.forEach(function (p, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "omap__pin";
      b.title = p.title;
      b.setAttribute("aria-label", p.title + ", " + p.address);
      b.innerHTML = PIN_SVG;
      // клик по метке = выбрать эту точку в карточке слева
      b.addEventListener("click", function () { selectPoint(i, false); });
      pins.push(b);
    });
    omap.fit(count ? POINTS.map(function (p) { return p.coords; }) : [CFG.mapCenter || [58.0105, 56.2294]], false);
    POINTS.forEach(function (p, i) { omap.addMarker(pins[i], p.coords); });

    function noGeo(msg) {
      if (count) selectPoint(0, false);
      nearestLabel.innerHTML = msg + "<br>" + nearestLabel.innerHTML;
    }
    if (!("geolocation" in navigator)) { noGeo("Нажмите на метку, чтобы выбрать точку"); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      me = [pos.coords.latitude, pos.coords.longitude];
      // сортируем точки по расстоянию от посетителя
      order.sort(function (a, b) { return distance(me, POINTS[a].coords) - distance(me, POINTS[b].coords); });
      if (!count) return;
      if (distance(me, POINTS[order[0]].coords) > 50000) { // человек не в Перми
        me = null;
        noGeo("Вы далеко от Перми, но наши автоматы ждут вас здесь");
        return;
      }
      var dot = document.createElement("div");
      dot.className = "omap__me";
      dot.title = "Вы здесь";
      dot.innerHTML = '<div class="fc-me"></div>';
      omap.addMarker(dot, me);
      selectPoint(order[0], true);
    }, function () {
      noGeo("Разрешите геопозицию, и мы найдём ближайший автомат");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function mapFallback() {
    if (omap) { omap.destroy(); omap = null; }
    var fb = document.getElementById("mapFallback");
    fb.innerHTML = '<p>Карта не загрузилась.<br>Наши точки:</p>';
    var ul = document.createElement("ul");
    ul.style.cssText = "list-style:none;padding:0;margin:16px 0 0;display:grid;gap:8px;font-size:15px;text-align:center";
    POINTS.forEach(function (p) {
      var li = document.createElement("li");
      li.innerHTML = '<a href="' + routeUrl(null, p.coords) + '" target="_blank" rel="noopener">' + esc(p.title) + "</a>";
      ul.appendChild(li);
    });
    fb.firstChild.appendChild(ul);
    if (count) selectPoint(0, false);
  }

  if (!window.FASTCUP_MAP || !window.FastcupMap) mapFallback();
  else initMap();

  /* =========================================================
     СТАКАНЧИК: при наведении за ним «взрывается» кофе
     ========================================================= */
  var section = document.getElementById("beans");
  var stage = document.getElementById("beansStage");
  var canvas = document.getElementById("beansCanvas");
  var hint = section && section.querySelector(".beans__hint");
  if (hint && isTouch) hint.textContent = "Коснитесь стаканчика";
  function setOpen(v) { stage.classList.toggle("is-open", v); }

  if (stage && (reduceMotion || !window.FASTCUP_BEANS)) {
    // без анимации: просто показываем зёрна и логотип
    section.classList.add("no-particles");
    stage.addEventListener("mouseenter", function () { setOpen(true); });
    stage.addEventListener("mouseleave", function () { setOpen(false); });
    stage.addEventListener("click", function () { setOpen(!stage.classList.contains("is-open")); });
  } else if (stage && canvas) {
    var ctx = canvas.getContext("2d");
    var img = new Image();
    var parts = [], W = 0, H = 0, dpr = 1, imgData, buf32, running = false, visible = false, open = false;
    var mouse = { x: -9999, y: -9999, r: 80, active: false };
    var cx = 0, cy = 0;

    function build() {
      var rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.round(rect.width * dpr); H = Math.round(rect.height * dpr);
      canvas.width = W; canvas.height = H;
      cx = W / 2; cy = H / 2;
      var inner = W / 1.24;
      var scale = Math.min(inner / img.width, (H / 1.24) / img.height);
      var iw = img.width * scale, ih = img.height * scale;
      var tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
      var t = tmp.getContext("2d"); t.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);
      var data = t.getImageData(0, 0, W, H).data;
      var step = Math.max(2, Math.round(3 * dpr));
      parts = [];
      for (var yy = 0; yy < H; yy += step) {
        for (var xx = 0; xx < W; xx += step) {
          var i = (yy * W + xx) * 4;
          if (data[i + 3] > 120) {
            // «спрятанная» позиция — внутри стаканчика
            var a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * W * 0.09;
            var sx = cx + Math.cos(a) * rr, sy = cy + Math.sin(a) * rr * 1.4;
            parts.push({ hx: xx, hy: yy, sx: sx, sy: sy, x: open ? xx : sx, y: open ? yy : sy, vx: 0, vy: 0,
              k: 0.035 + Math.random() * 0.03,
              c: (255 << 24) | (data[i + 2] << 16) | (data[i + 1] << 8) | data[i] });
          }
        }
      }
      parts.size = step;
      imgData = ctx.createImageData(W, H);
      buf32 = new Uint32Array(imgData.data.buffer);
      mouse.r = W * 0.09;
      draw();
    }

    function draw() {
      buf32.fill(0);
      var s = parts.size;
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k], px = p.x | 0, py = p.y | 0;
        if (px < 0 || py < 0 || px >= W - s || py >= H - s) continue;
        for (var dy = 0; dy < s; dy++) {
          var row = (py + dy) * W + px;
          for (var dx = 0; dx < s; dx++) buf32[row + dx] = p.c;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }

    function tick() {
      var moving = false, r = mouse.r, r2 = r * r;
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k];
        var tx = open ? p.hx : p.sx, ty = open ? p.hy : p.sy;
        if (open && mouse.active) {
          var dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
          if (d2 < r2 && d2 > 0.01) { var d = Math.sqrt(d2), f = (1 - d / r) * 6; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
        }
        p.vx += (tx - p.x) * p.k; p.vy += (ty - p.y) * p.k;
        p.vx *= 0.86; p.vy *= 0.86;
        p.x += p.vx; p.y += p.vy;
        if (!moving && (Math.abs(p.vx) > 0.04 || Math.abs(p.vy) > 0.04 || Math.abs(p.x - tx) > 0.6)) moving = true;
      }
      draw();
      if (moving && visible) requestAnimationFrame(tick);
      else { running = false; if (open && !moving) stage.classList.add("is-settled"); }
    }
    function kick() { if (!running && visible && parts.length) { running = true; stage.classList.remove("is-settled"); requestAnimationFrame(tick); } }

    function explode() {
      if (open) return;
      open = true; setOpen(true);
      // стартовый «выстрел» наружу от центра
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k], dx = p.hx - cx, dy = p.hy - cy, d = Math.sqrt(dx * dx + dy * dy) || 1;
        var f = 10 + Math.random() * 14;
        p.vx += (dx / d) * f; p.vy += (dy / d) * f - 4;
      }
      kick();
    }
    function collapse() { if (!open) return; open = false; setOpen(false); mouse.active = false; kick(); }

    function setMouse(e) {
      var rect = canvas.getBoundingClientRect();
      mouse.x = (e.clientX - rect.left) * dpr; mouse.y = (e.clientY - rect.top) * dpr;
      mouse.active = true; if (open) kick();
    }
    var cupEl = stage.querySelector(".cup3d");
    if (!isTouch) {
      cupEl.addEventListener("mouseenter", explode);           // наведение на стаканчик
      stage.addEventListener("pointermove", setMouse);         // зёрна уворачиваются от курсора
      stage.addEventListener("mouseleave", collapse);          // ушли — кофе вернулся в стакан
    }
    stage.addEventListener("click", function () { open ? collapse() : explode(); });
    stage.setAttribute("role", "button");
    stage.setAttribute("tabindex", "0");
    stage.setAttribute("aria-label", "Открыть стаканчик Fastcup");
    stage.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open ? collapse() : explode(); } });

    new IntersectionObserver(function (en) { visible = en[0].isIntersecting; if (visible) kick(); else if (open && isTouch) collapse(); }).observe(stage);
    var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(build, 200); });

    img.onload = function () {
      try { build(); }
      catch (err) { section.classList.add("no-particles"); parts = []; }
    };
    img.src = window.FASTCUP_BEANS;
  }

  /* =========================================================
     ФОРМА ЗАЯВКИ
     ========================================================= */
  var form = document.getElementById("leadForm");
  var status = document.getElementById("formStatus");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var el = form.elements;
    var name = el["name"].value.trim(), phone = el["phone"].value.trim();
    var bad = [];
    el["name"].setAttribute("aria-invalid", String(!name)); if (!name) bad.push(el["name"]);
    var phoneOk = phone.replace(/\D/g, "").length >= 10;
    el["phone"].setAttribute("aria-invalid", String(!phoneOk)); if (!phoneOk) bad.push(el["phone"]);
    if (bad.length) {
      status.className = "form__status is-err";
      status.textContent = !name ? "Укажите имя, чтобы мы знали, как к вам обращаться" : "Проверьте телефон: нужно минимум 10 цифр";
      bad[0].focus(); return;
    }
    var data = { name: name, phone: phone, topic: el["topic"].value, message: el["message"].value.trim(), page: location.href };
    var btn = form.querySelector("button[type=submit]");

    if (!CFG.formEndpoint) {
      var body = "Имя: " + data.name + "\nТелефон: " + data.phone + "\nТема: " + data.topic + "\n\n" + data.message;
      location.href = "mailto:" + CFG.email + "?subject=" + encodeURIComponent("Заявка с сайта: " + data.topic) + "&body=" + encodeURIComponent(body);
      status.className = "form__status is-ok";
      status.textContent = "Открыли письмо с заявкой. Отправьте его, и мы свяжемся с вами";
      return;
    }
    btn.disabled = true; btn.textContent = "Отправляем…";
    fetch(CFG.formEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      .then(function (r) { if (!r.ok) throw new Error(); })
      .then(function () {
        form.reset();
        status.className = "form__status is-ok";
        status.textContent = "Заявка отправлена. Перезвоним в течение рабочего дня";
      })
      .catch(function () {
        status.className = "form__status is-err";
        status.textContent = "Не получилось отправить. Позвоните нам или напишите в Telegram";
      })
      .finally(function () { btn.disabled = false; btn.textContent = "Отправить заявку"; });
  });
})();
