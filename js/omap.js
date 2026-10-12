/* ================================================================
   Офлайн-карта Перми — общий движок для сайта и приложения (app/).
   Карта — готовые картинки images/web/map/{уровень}/{x}-{y}.webp (tools/build_map.py),
   границы и уровни — js/map-data.js. Метки, маршрут и «вы здесь» рисуются поверх.

   Почему так устроено (важно для слабых видеокарт):
   - слой с картинками двигается и масштабируется только через transform (will-change) —
     видеокарта сдвигает готовый слой, ничего не перерисовывая;
   - обновление — не чаще раза за кадр; новый масштаб «фиксируется» один раз после жеста;
   - уровень картинок выбирается под масштаб и плотность экрана, уровень 0 — подложка.

   Использование:
     var map = FastcupMap(элемент, { data: window.FASTCUP_MAP, margin: fn, ... });
     map.fit([[широта, долгота], ...], keepScale, animate)
     var m = map.addMarker(элемент, [широта, долгота]); map.moveMarker(m, [..]); map.removeMarker(m)
     map.setRoute([[x, y], ...] в единицах карты | null); map.setAccuracy([широта, долгота] | null, метры)
   ================================================================ */
(function () {
  window.FastcupMap = function (el, opts) {
    var MAP = opts.data;
    var MIN_FIT = opts.minFitScale || 0.45, MAX_FIT = opts.maxFitScale || 2, MAX_SCALE = opts.maxScale || 3;
    var margin = opts.margin || function () { return [40, 40, 40, 40]; };
    var SVGNS = "http://www.w3.org/2000/svg";

    // ---- разметка ----
    el.classList.add("omap-host");
    if (opts.oneFinger) el.classList.add("omap-host--app");
    var plane = div("omap");                 // слой с картинками и маршрутом (двигает видеокарта)
    var tileLayer = div("omap__tiles");
    plane.appendChild(tileLayer);
    var routeSvg = document.createElementNS(SVGNS, "svg");
    routeSvg.setAttribute("class", "omap__route");
    routeSvg.setAttribute("viewBox", "0 0 " + MAP.width + " " + MAP.height);
    routeSvg.setAttribute("preserveAspectRatio", "none");
    routeSvg.innerHTML =
      '<circle class="omap__acc" r="0" cx="-99" cy="-99"/>' +
      '<path class="omap__route-casing" d=""/><path class="omap__route-line" d=""/>';
    plane.appendChild(routeSvg);
    var markerLayer = div("omap__markers");  // метки отдельным слоем — не раздуваются при зуме
    var zoom = div("omap__zoom");
    zoom.innerHTML = '<button type="button" data-zoom="in" aria-label="Приблизить карту">+</button>' +
                     '<button type="button" data-zoom="out" aria-label="Отдалить карту">−</button>';
    var hint = document.createElement("p");
    hint.className = "omap__hint";
    hint.setAttribute("aria-hidden", "true");
    hint.textContent = "Двигайте карту двумя пальцами";
    var attr = document.createElement("p");
    attr.className = "omap__attr";
    attr.innerHTML = 'Карта: © участники <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    [plane, markerLayer, zoom, hint, attr].forEach(function (n) { el.appendChild(n); });

    function div(cls) { var d = document.createElement("div"); d.className = cls; return d; }

    // ---- состояние ----
    var tiles = {}, levelEls = {}, level = -1, prevLevel = -1, tilesLoaded = 0, failed = false;
    var markers = [];
    var scale = 0, posX = 0, posY = 0, baseScale = 0, frame = 0, anim = 0;
    var view = null, userMoved = false;

    // ---- проекция: [широта, долгота] ↔ единицы карты (как в tools/build_map.py) ----
    function merc(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); }
    var mN = merc(MAP.north), mS = merc(MAP.south);
    function toXY(c) {
      return [(c[1] - MAP.west) / (MAP.east - MAP.west) * MAP.width, (mN - merc(c[0])) / (mN - mS) * MAP.height];
    }
    function fromXY(x, y) {
      var m = mN - y / MAP.height * (mN - mS);
      return [(2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI, MAP.west + x / MAP.width * (MAP.east - MAP.west)];
    }
    // метров в единице карты (на широте Перми)
    var metersPerUnit = 6378137 * (MAP.east - MAP.west) * Math.PI / 180 / MAP.width *
      Math.cos((MAP.north + MAP.south) / 2 * Math.PI / 180);

    function minScale() { return Math.max(el.clientWidth / MAP.width, el.clientHeight / MAP.height); }

    /* Карта всегда закрывает весь блок и не уводится за границы города */
    function clampView() {
      var cw = el.clientWidth, ch = el.clientHeight;
      scale = Math.min(MAX_SCALE, Math.max(scale, minScale()));
      posX = Math.min(0, Math.max(cw - MAP.width * scale, posX));
      posY = Math.min(0, Math.max(ch - MAP.height * scale, posY));
    }

    /* Нарисовать текущее положение: меняется только transform, картинки не перерисовываются */
    function render() {
      frame = 0;
      if (!scale) return; // блок карты ещё без размера
      if (!baseScale) commitScale();
      plane.style.transform = "translate3d(" + posX + "px," + posY + "px,0) scale(" + scale / baseScale + ")";
      for (var i = 0; i < markers.length; i++) {
        var m = markers[i];
        m.el.style.transform = "translate3d(" + (posX + m.x * scale) + "px," + (posY + m.y * scale) + "px,0)";
      }
      loadTiles();
    }

    /* Перерисовать слой в новом масштабе (чётко) — один раз после жеста, а не на каждом кадре */
    function commitScale() {
      baseScale = scale;
      plane.style.width = MAP.width * scale + "px";
      plane.style.height = MAP.height * scale + "px";
    }
    function settle() {
      if (baseScale !== scale) { commitScale(); render(); }
      loadTiles(true);
    }

    /* Обновить не чаще одного раза за кадр, сколько бы событий ни пришло */
    function update() {
      clampView();
      if (!frame) frame = requestAnimationFrame(render);
    }

    /* Плавный переход к масштабу s и сдвигу (x, y) */
    function animateTo(s, x, y) {
      cancelAnimationFrame(anim);
      var s0 = scale, x0 = posX, y0 = posY, t0 = performance.now();
      function step(now) {
        var t = Math.min(1, (now - t0) / 450), e = 1 - Math.pow(1 - t, 3);
        scale = s0 + (s - s0) * e; posX = x0 + (x - x0) * e; posY = y0 + (y - y0) * e;
        clampView();
        render();
        if (t < 1) anim = requestAnimationFrame(step); else { anim = 0; settle(); }
      }
      anim = requestAnimationFrame(step);
    }

    /* Перейти к виду: с анимацией или сразу */
    function goTo(s, x, y, animate) {
      var s0 = scale, x0 = posX, y0 = posY;
      scale = s; posX = x; posY = y;
      clampView();
      if (animate && baseScale) {
        var ts = scale, tx = posX, ty = posY;
        scale = s0; posX = x0; posY = y0;
        animateTo(ts, tx, ty);
      } else {
        cancelAnimationFrame(anim);
        commitScale();
        render();
      }
    }

    /* Какой уровень картинок нужен: чтобы на пиксель экрана приходилось не меньше пикселя картинки */
    function pickLevel() {
      var need = baseScale * (window.devicePixelRatio || 1);
      for (var z = 0; z < MAP.levels.length; z++) if (MAP.levels[z] >= need * 0.85) return z;
      return MAP.levels.length - 1;
    }

    /* Подгрузить видимые картинки. Уровень 0 (весь город) — подложка, поверх — чёткий уровень.
       prune — убрать картинки далеко за экраном, чтобы не держать память. */
    function loadTiles(prune) {
      var want = pickLevel();
      if (want !== level) {
        if (level > 0) prevLevel = level;
        level = want;
        Object.keys(levelEls).forEach(function (z) {
          z = +z;
          if (z !== 0 && z !== level && z !== prevLevel) { levelEls[z].remove(); delete levelEls[z]; delete tiles[z]; }
          else levelEls[z].style.zIndex = z === level ? 10 : z; // текущий уровень сверху, прежний — подложкой под ним
        });
      }
      loadLevel(0, false);
      if (level > 0) loadLevel(level, prune);
    }

    function loadLevel(z, prune) {
      var s = MAP.levels[z], T = MAP.tile, u = T / s;  // единиц карты на одну картинку
      var cols = Math.ceil(MAP.width * s / T), rows = Math.ceil(MAP.height * s / T);
      var u0 = -posX / scale - u / 2, u1 = (el.clientWidth - posX) / scale + u / 2;
      var v0 = -posY / scale - u / 2, v1 = (el.clientHeight - posY) / scale + u / 2;
      var c0 = Math.max(0, Math.floor(u0 / u)), c1 = Math.min(cols - 1, Math.floor(u1 / u));
      var r0 = Math.max(0, Math.floor(v0 / u)), r1 = Math.min(rows - 1, Math.floor(v1 / u));
      if (!levelEls[z]) {
        levelEls[z] = div("omap__lvl");
        levelEls[z].style.zIndex = z === level ? 10 : z;
        tileLayer.appendChild(levelEls[z]);
        tiles[z] = {};
      }
      var have = tiles[z];
      for (var r = r0; r <= r1; r++) {
        for (var c = c0; c <= c1; c++) {
          var key = c + "-" + r;
          if (have[key]) continue;
          var img = new Image();
          img.className = "omap__tile";
          img.alt = "";
          img.draggable = false;
          img.decoding = "async";
          var tw = Math.min(T, Math.ceil(MAP.width * s - c * T)) / s, th = Math.min(T, Math.ceil(MAP.height * s - r * T)) / s;
          img.style.left = c * u / MAP.width * 100 + "%";
          img.style.top = r * u / MAP.height * 100 + "%";
          // +1px — чтобы между соседними картинками не просвечивали щели
          img.style.width = "calc(" + tw / MAP.width * 100 + "% + 1px)";
          img.style.height = "calc(" + th / MAP.height * 100 + "% + 1px)";
          img.onload = function () { this.classList.add("is-loaded"); tilesLoaded++; };
          img.onerror = function () { if (!tilesLoaded && !failed && opts.onError) { failed = true; opts.onError(); } };
          img.src = (opts.base || "") + MAP.tiles.replace("{z}", z).replace("{x}", c).replace("{y}", r);
          have[key] = img;
          levelEls[z].appendChild(img);
        }
      }
      if (prune && z > 0) {
        Object.keys(have).forEach(function (key) {
          var cr = key.split("-"), c = +cr[0], r = +cr[1];
          if (c < c0 - 2 || c > c1 + 2 || r < r0 - 2 || r > r1 + 2) { have[key].remove(); delete have[key]; }
        });
      }
    }

    /* Показать точки pts в свободной части карты (margin — отступы под панели).
       keepScale — не менять масштаб, только сдвинуть. */
    function fit(pts, keepScale, animate) {
      if (!pts || !pts.length) pts = [fromXY(MAP.width / 2, MAP.height / 2)];
      view = pts;
      userMoved = false;
      var cw = el.clientWidth, ch = el.clientHeight;
      if (!cw || !ch) return;
      var m = margin();
      var x0 = m[3], x1 = cw - m[1], y0 = m[0], y1 = ch - m[2];
      if (x1 - x0 < 120) { x0 = 40; x1 = cw - 40; }
      if (y1 - y0 < 120) { y0 = 40; y1 = ch - 40; }
      var xy = pts.map(toXY);
      var xs = xy.map(function (q) { return q[0]; }), ys = xy.map(function (q) { return q[1]; });
      var bx0 = Math.min.apply(null, xs), bx1 = Math.max.apply(null, xs);
      var by0 = Math.min.apply(null, ys), by1 = Math.max.apply(null, ys);
      var s = scale;
      if (!(keepScale && scale)) {
        s = Math.min(MAX_FIT, (x1 - x0) / Math.max(bx1 - bx0, 1), (y1 - y0) / Math.max(by1 - by0, 1));
        s = Math.max(s, MIN_FIT, minScale());
      }
      goTo(s, (x0 + x1) / 2 - (bx0 + bx1) / 2 * s, (y0 + y1) / 2 - (by0 + by1) / 2 * s, animate);
    }

    /* Масштаб относительно точки (px, py) блока карты — она остаётся на месте */
    function zoomAt(newScale, px, py, animate) {
      var s = Math.min(MAX_SCALE, Math.max(newScale, minScale()));
      moved();
      goTo(s, px - (px - posX) * s / scale, py - (py - posY) * s / scale, animate);
    }
    function moved() {
      userMoved = true;
      if (opts.onUserMove) opts.onUserMove();
    }

    // ---- управление ----
    /* Перетаскивание: мышкой; на телефоне — одним пальцем в приложении, двумя на сайте */
    var drag = null, justDragged = false;
    el.addEventListener("pointerdown", function (e) {
      if ((e.pointerType === "touch" && !opts.oneFinger) || e.button !== 0 || e.target.closest(".omap__zoom, .omap__attr")) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, px: posX, py: posY, moved: false };
    });
    el.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 6) return; // короткое движение — это ещё нажатие на метку
        drag.moved = true;
        cancelAnimationFrame(anim);
        drag.px = posX; drag.py = posY;
        el.setPointerCapture(drag.id);
        el.classList.add("is-dragging");
        moved();
      }
      posX = drag.px + dx; posY = drag.py + dy;
      update();
    });
    function stop() {
      if (drag && drag.moved) { justDragged = true; setTimeout(function () { justDragged = false; }, 0); settle(); }
      drag = null;
      el.classList.remove("is-dragging");
    }
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    el.addEventListener("click", function (e) {
      // отпускание кнопки над меткой после перетаскивания не должно её выбирать
      if (justDragged) { e.stopPropagation(); e.preventDefault(); return; }
      if (opts.onTap && !e.target.closest(".omap__zoom, .omap__attr, .omap__pin, button, a")) {
        var r = el.getBoundingClientRect();
        opts.onTap(fromXY((e.clientX - r.left - posX) / scale, (e.clientY - r.top - posY) / scale));
      }
    }, true);

    /* Два пальца: двигаем и масштабируем; на сайте одним пальцем листается страница */
    var pinch = null, hintTimer;
    function touchInfo(e) {
      var r = el.getBoundingClientRect(), a = e.touches[0], b = e.touches[1];
      return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top,
               d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
    }
    el.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 2) return;
      cancelAnimationFrame(anim);
      drag = null; // второй палец превращает перетаскивание в масштабирование
      pinch = touchInfo(e);
      pinch.s = scale; pinch.px = posX; pinch.py = posY;
      el.classList.add("is-dragging");
      hint.classList.remove("is-visible");
      moved();
    }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      if (e.touches.length === 1 && !pinch) {
        if (opts.oneFinger) { e.preventDefault(); return; }
        hint.classList.add("is-visible"); // подсказываем, как двигать карту
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () { hint.classList.remove("is-visible"); }, 1500);
        return;
      }
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      var t = touchInfo(e);
      var s = Math.min(MAX_SCALE, Math.max(pinch.s * t.d / pinch.d, minScale()));
      posX = t.x - (pinch.x - pinch.px) * s / pinch.s;
      posY = t.y - (pinch.y - pinch.py) * s / pinch.s;
      scale = s;
      update();
    }, { passive: false });
    el.addEventListener("touchend", function (e) {
      if (e.touches.length < 2 && pinch) { pinch = null; el.classList.remove("is-dragging"); settle(); }
    });

    /* Колесо мыши (только в приложении: на сайте оно листает страницу) */
    if (opts.wheel) {
      var wheelTimer;
      el.addEventListener("wheel", function (e) {
        e.preventDefault();
        cancelAnimationFrame(anim);
        var r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        var s = Math.min(MAX_SCALE, Math.max(scale * Math.exp(-e.deltaY * 0.0015), minScale()));
        posX = px - (px - posX) * s / scale; posY = py - (py - posY) * s / scale; scale = s;
        moved();
        update();
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(settle, 200);
      }, { passive: false });
    }

    /* Кнопки «+» и «−»: масштаб вокруг середины свободной части карты */
    zoom.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var m = margin(), cw = el.clientWidth, ch = el.clientHeight;
        var cx = m[3] < cw - m[1] ? (m[3] + cw - m[1]) / 2 : cw / 2;
        zoomAt(scale * (btn.dataset.zoom === "in" ? 1.6 : 1 / 1.6), cx, (m[0] + ch - m[2]) / 2, true);
      });
    });

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (userMoved || !view) goTo(scale, posX, posY, false); else fit(view, false); }, 150);
    });

    // ---- метки, маршрут, точность ----
    function addMarker(node, c) {
      var xy = toXY(c), m = { el: node, x: xy[0], y: xy[1] };
      markers.push(m);
      markerLayer.appendChild(node);
      render();
      return m;
    }
    function moveMarker(m, c) { var xy = toXY(c); m.x = xy[0]; m.y = xy[1]; render(); }
    function removeMarker(m) { markers.splice(markers.indexOf(m), 1); m.el.remove(); }

    function setRoute(pts) {
      var d = "";
      if (pts && pts.length > 1) {
        d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
        for (var i = 1; i < pts.length; i++) d += "L" + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
      }
      routeSvg.querySelector(".omap__route-casing").setAttribute("d", d);
      routeSvg.querySelector(".omap__route-line").setAttribute("d", d);
    }
    function setAccuracy(c, meters) {
      var circle = routeSvg.querySelector(".omap__acc");
      if (!c) { circle.setAttribute("r", 0); return; }
      var xy = toXY(c);
      circle.setAttribute("cx", xy[0].toFixed(1));
      circle.setAttribute("cy", xy[1].toFixed(1));
      circle.setAttribute("r", Math.max(0, meters / metersPerUnit).toFixed(1));
    }

    function destroy() {
      [plane, markerLayer, zoom, hint, attr].forEach(function (n) { n.remove(); });
      el.classList.remove("omap-host", "omap-host--app");
    }

    return {
      toXY: toXY, fromXY: fromXY, metersPerUnit: metersPerUnit,
      fit: fit, goTo: goTo, addMarker: addMarker, moveMarker: moveMarker, removeMarker: removeMarker,
      setRoute: setRoute, setAccuracy: setAccuracy, destroy: destroy,
      zoomBy: function (f) { zoomAt(scale * f, el.clientWidth / 2, el.clientHeight / 2, true); },
      get userMoved() { return userMoved; }
    };
  };

  /* значок метки-стаканчика (для элементов .omap__pin) */
  window.FastcupMap.PIN =
    '<svg class="fc-pin" viewBox="0 0 46 56" aria-hidden="true">' +
    '<defs><linearGradient id="fcg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F8B867"/><stop offset=".5" stop-color="#EF8458"/><stop offset="1" stop-color="#C9505A"/></linearGradient></defs>' +
    '<path d="M23 55C23 55 3 34 3 21a20 20 0 0 1 40 0c0 13-20 34-20 34z" fill="url(#fcg)" stroke="#fff" stroke-width="2.5"/>' +
    '<path d="M15 14h16l-2 16h-12z" fill="#fff"/><rect x="13.5" y="11" width="19" height="3.5" rx="1.5" fill="#fff"/>' +
    '<rect x="16.5" y="19" width="13" height="5" fill="#C9505A" opacity=".55"/></svg>';
})();
