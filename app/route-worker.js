/* ================================================================
   Пеший маршрут без интернета — работает в фоне (Web Worker), чтобы не тормозить карту.
   Граф пеших дорог Перми: app/data/walk-graph.bin (собирает tools/build_routes.py).
   Все координаты — в единицах карты (как в js/omap.js), длины рёбер — в метрах.

   Сообщения:
     → { type: "init", url, mpu }        mpu — метров в единице карты
     ← { type: "ready", nodes, edges, ms } | { type: "error", message }
     → { type: "route", id, from: [x, y], targets: [[x, y], ...] }
     ← { type: "route", id, ms, results: [{ i, meters, points: [[x, y], ...] } | { i, meters: null }] }
   ================================================================ */
var G = null;          // граф
var MPU = 8.5;         // метров в единице карты
var CELL = 40;         // ячейка сетки поиска ближайшей дороги, единиц (≈ 340 м)
var grid = new Map();  // ячейка → [ребро, номер отрезка, ребро, номер отрезка, …]

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === "init") {
    MPU = msg.mpu || MPU;
    var t0 = performance.now();
    fetch(msg.url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      parse(buf);
      buildGrid();
      self.postMessage({ type: "ready", nodes: G.n, edges: G.m, ms: Math.round(performance.now() - t0) });
    }).catch(function (err) {
      self.postMessage({ type: "error", message: String(err && err.message || err) });
    });
  } else if (msg.type === "route" && G) {
    var t0 = performance.now(), results = route(msg.from, msg.targets);
    self.postMessage({ type: "route", id: msg.id, results: results, ms: Math.round(performance.now() - t0) });
  }
};

/* ---------- чтение графа (формат — tools/build_routes.py, write_graph) ---------- */
function parse(buf) {
  var dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "FCWG") throw new Error("не граф Fastcup");
  var n = dv.getUint32(8, true), m = dv.getUint32(12, true), g = dv.getUint32(16, true), Q = dv.getUint32(20, true);
  var off = 24, i;
  var nx = new Float32Array(n), ny = new Float32Array(n);
  for (i = 0; i < n; i++, off += 4) { nx[i] = dv.getUint16(off, true) / Q; ny[i] = dv.getUint16(off + 2, true) / Q; }
  var ea = new Uint32Array(m), eb = new Uint32Array(m), elen = new Float32Array(m), gs = new Uint32Array(m + 1);
  for (i = 0; i < m; i++, off += 16) {
    ea[i] = dv.getUint32(off, true); eb[i] = dv.getUint32(off + 4, true);
    elen[i] = dv.getFloat32(off + 8, true); gs[i] = dv.getUint32(off + 12, true);
  }
  gs[m] = g;
  var gx = new Float32Array(g), gy = new Float32Array(g);
  for (i = 0; i < g; i++, off += 4) { gx[i] = dv.getUint16(off, true) / Q; gy[i] = dv.getUint16(off + 2, true) / Q; }
  // смежность: для каждого узла — список рёбер (CSR)
  var deg = new Uint32Array(n + 1);
  for (i = 0; i < m; i++) { deg[ea[i] + 1]++; deg[eb[i] + 1]++; }
  for (i = 0; i < n; i++) deg[i + 1] += deg[i];
  var adj = new Uint32Array(2 * m), fill = deg.slice(0, n);
  for (i = 0; i < m; i++) { adj[fill[ea[i]]++] = i; adj[fill[eb[i]]++] = i; }
  G = { n: n, m: m, nx: nx, ny: ny, ea: ea, eb: eb, elen: elen, gs: gs, gx: gx, gy: gy, adjStart: deg, adj: adj };
}

/* точки ребра от узла A к узлу B */
function edgePts(e) {
  var pts = [[G.nx[G.ea[e]], G.ny[G.ea[e]]]];
  for (var k = G.gs[e]; k < G.gs[e + 1]; k++) pts.push([G.gx[k], G.gy[k]]);
  pts.push([G.nx[G.eb[e]], G.ny[G.eb[e]]]);
  return pts;
}

/* ---------- поиск ближайшей дороги ---------- */
function cellKey(cx, cy) { return cx * 4096 + cy; }

function buildGrid() {
  for (var e = 0; e < G.m; e++) {
    var pts = edgePts(e);
    for (var s = 0; s < pts.length - 1; s++) {
      var a = pts[s], b = pts[s + 1];
      var cx0 = Math.floor(Math.min(a[0], b[0]) / CELL), cx1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      var cy0 = Math.floor(Math.min(a[1], b[1]) / CELL), cy1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (var cx = cx0; cx <= cx1; cx++) {
        for (var cy = cy0; cy <= cy1; cy++) {
          var k = cellKey(cx, cy), list = grid.get(k);
          if (!list) grid.set(k, list = []);
          list.push(e, s);
        }
      }
    }
  }
}

/* Ближайшая точка на дороге: ребро, место на нём (единиц от узла A) и сама точка */
function snap(x, y) {
  var best = null, cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cache = {};
  for (var r = 0; r <= 8; r++) {               // расширяем поиск кольцами ячеек (до ≈ 3 км)
    for (var i = cx - r; i <= cx + r; i++) {
      for (var j = cy - r; j <= cy + r; j++) {
        if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== r) continue;
        var list = grid.get(cellKey(i, j));
        if (!list) continue;
        for (var q = 0; q < list.length; q += 2) {
          var e = list[q], s = list[q + 1];
          var pts = cache[e] || (cache[e] = edgePts(e));
          var a = pts[s], b = pts[s + 1];
          var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
          var t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
          var px = a[0] + t * dx, py = a[1] + t * dy, d = Math.hypot(x - px, y - py);
          if (!best || d < best.d) best = { e: e, s: s, t: t, x: px, y: py, d: d };
        }
      }
    }
    if (best && best.d < r * CELL) break;       // ближе уже ничего не найдётся
  }
  if (!best) return null;
  var pts2 = cache[best.e], along = 0, total = 0;
  for (var k = 0; k < pts2.length - 1; k++) {
    var len = Math.hypot(pts2[k + 1][0] - pts2[k][0], pts2[k + 1][1] - pts2[k][1]);
    if (k < best.s) along += len;
    if (k === best.s) along += len * best.t;
    total += len;
  }
  best.offU = along;                             // единиц от узла A
  best.lenU = total;
  best.off = total ? along / total * G.elen[best.e] : 0; // метров от узла A
  return best;
}

/* кусок ребра между местами u0 и u1 (в единицах от узла A); если u0 > u1 — в обратную сторону */
function cutEdge(e, u0, u1) {
  var pts = edgePts(e), out = [], acc = 0, lo = Math.min(u0, u1), hi = Math.max(u0, u1);
  for (var k = 0; k < pts.length - 1; k++) {
    var a = pts[k], b = pts[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    var s0 = acc, s1 = acc + len;
    if (s1 >= lo && s0 <= hi && len > 0) {
      var t0 = Math.max(0, (lo - s0) / len), t1 = Math.min(1, (hi - s0) / len);
      if (!out.length) out.push([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
      out.push([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]);
    }
    acc = s1;
  }
  return u0 > u1 ? out.reverse() : out;
}

/* ---------- кратчайшие пути: Дейкстра от посетителя сразу до всех точек ---------- */
function route(from, targets) {
  var start = snap(from[0], from[1]);
  if (!start) return targets.map(function (_, i) { return { i: i, meters: null }; });
  var tg = targets.map(function (p, i) { var s = snap(p[0], p[1]); return { i: i, p: p, s: s, best: Infinity, via: null }; });

  var n = G.n, dist = new Float64Array(n), prev = new Int32Array(n), done = new Uint8Array(n);
  dist.fill(Infinity); prev.fill(-1);
  var heap = new Heap();
  var sa = G.ea[start.e], sb = G.eb[start.e], slen = G.elen[start.e];
  relaxStart(sa, start.off); relaxStart(sb, slen - start.off);
  function relaxStart(v, d) { if (d < dist[v]) { dist[v] = d; prev[v] = -2; heap.push(v, d); } }

  // какие точки «висят» на каком узле: когда узел найден окончательно — обновляем их расстояние
  var byNode = new Map();
  tg.forEach(function (t) {
    if (!t.s) return;
    var e = t.s.e, len = G.elen[e];
    [[G.ea[e], t.s.off, "a"], [G.eb[e], len - t.s.off, "b"]].forEach(function (x) {
      if (!byNode.has(x[0])) byNode.set(x[0], []);
      byNode.get(x[0]).push({ t: t, add: x[1], end: x[2] });
    });
    if (e === start.e) { t.best = Math.abs(t.s.off - start.off); t.via = "same"; } // на той же дороге
  });
  function maxBest() {
    var mx = 0;
    for (var i = 0; i < tg.length; i++) if (tg[i].s && tg[i].best > mx) mx = tg[i].best;
    return mx;
  }
  var limit = maxBest();

  while (heap.size) {
    var u = heap.popNode(), d = heap.lastKey;
    if (done[u]) continue;
    if (d >= limit) break;                         // все точки уже найдены
    done[u] = 1;
    var hang = byNode.get(u);
    if (hang) {
      hang.forEach(function (h) { if (d + h.add < h.t.best) { h.t.best = d + h.add; h.t.via = h.end; } });
      limit = maxBest();
    }
    for (var k = G.adjStart[u]; k < G.adjStart[u + 1]; k++) {
      var e = G.adj[k], v = G.ea[e] === u ? G.eb[e] : G.ea[e], nd = d + G.elen[e];
      if (nd < dist[v]) { dist[v] = nd; prev[v] = e; heap.push(v, nd); }
    }
  }

  var startLead = start.d * MPU;                    // от точки GPS до дороги
  return tg.map(function (t) {
    if (!t.s || t.best === Infinity) return { i: t.i, meters: null };
    var pts = [from, [start.x, start.y]];
    if (t.via === "same") {
      pts = pts.concat(cutEdge(start.e, start.offU, t.s.offU));
    } else {
      var end = t.via === "a" ? G.ea[t.s.e] : G.eb[t.s.e];
      var chain = [], v = end;                      // рёбра от посетителя к точке — идём назад по prev
      while (prev[v] >= 0) { var e = prev[v]; chain.push([e, v]); v = G.ea[e] === v ? G.eb[e] : G.ea[e]; }
      // v — узел стартового ребра, с которого начали: часть стартового ребра до него
      pts = pts.concat(cutEdge(start.e, start.offU, v === G.ea[start.e] ? 0 : start.lenU));
      for (var c = chain.length - 1; c >= 0; c--) {
        var ce = chain[c][0], to = chain[c][1], ep = edgePts(ce);
        if (G.ea[ce] === to) ep.reverse();            // ребро идём от B к A
        pts = pts.concat(ep);
      }
      pts = pts.concat(cutEdge(t.s.e, t.via === "a" ? 0 : t.s.lenU, t.s.offU));
    }
    pts.push([t.s.x, t.s.y], t.p);
    return { i: t.i, meters: t.best + startLead + t.s.d * MPU, points: simplifyDup(pts) };
  });
}

function simplifyDup(pts) {
  var out = [pts[0]];
  for (var i = 1; i < pts.length; i++) {
    var a = out[out.length - 1], b = pts[i];
    if (Math.abs(a[0] - b[0]) > 0.05 || Math.abs(a[1] - b[1]) > 0.05) out.push([+b[0].toFixed(2), +b[1].toFixed(2)]);
  }
  return out;
}

/* двоичная куча по возрастанию расстояния */
function Heap() { this.nodes = []; this.keys = []; this.size = 0; this.lastKey = 0; }
Heap.prototype.push = function (node, key) {
  var i = this.size++, n = this.nodes, k = this.keys;
  n[i] = node; k[i] = key;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (k[p] <= key) break;
    n[i] = n[p]; k[i] = k[p]; i = p;
  }
  n[i] = node; k[i] = key;
};
Heap.prototype.popNode = function () {
  var n = this.nodes, k = this.keys, top = n[0];
  this.lastKey = k[0];
  var last = --this.size, node = n[last], key = k[last], i = 0;
  while (true) {
    var l = 2 * i + 1, r = l + 1, m = i, mk = key;
    if (l < last && k[l] < mk) { m = l; mk = k[l]; }
    if (r < last && k[r] < mk) { m = r; mk = k[r]; }
    if (m === i) break;
    n[i] = n[m]; k[i] = k[m]; i = m;
  }
  n[i] = node; k[i] = key;
  return top;
};
