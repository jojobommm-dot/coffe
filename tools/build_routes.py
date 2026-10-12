"""
Собирает граф пеших дорог Перми для приложения (app/): по нему телефон сам, без интернета,
строит пеший маршрут до ближайшего автомата.

Берёт из OpenStreetMap всё, где можно пройти пешком: улицы, тротуары, дорожки, лестницы,
пешеходные зоны, дворовые проезды. Перекрёстки становятся узлами графа, куски дорог между
ними — рёбрами с длиной в метрах и формой линии (чтобы нарисовать маршрут на карте).
Оставляется только самая большая связная сеть: оторванные кусочки (дорожка внутри
закрытой территории и т. п.) не годятся для маршрута.

Результат: app/data/walk-graph.bin (формат — см. write_graph ниже и app/route-worker.js).

Запуск (нужен Python 3 и shapely: pip install shapely):
  python tools/build_routes.py              скачать данные OSM (если ещё нет) и собрать граф
  python tools/build_routes.py --refresh    скачать данные заново
Область и проекция — те же, что у карты (tools/build_map.py).
"""
import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

from shapely.geometry import LineString

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_map import BBOX, CACHE, HEIGHT, OVERPASS, ROOT, WIDTH, proj  # noqa: E402

OUT = os.path.join(ROOT, "app", "data", "walk-graph.bin")

# где можно идти пешком; автомагистрали не берём, а также всё, где пешеходам нельзя
WALK = ("footway|path|pedestrian|steps|living_street|residential|service|unclassified|track|cycleway|"
        "corridor|road|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|trunk|trunk_link")
QUERY = ('[out:json][timeout:300];way["highway"~"^(%s)$"]["foot"!~"^(no|private)$"]'
         '["access"!~"^(private|no)$"]["area"!="yes"](%s);out body;>;out skel qt;')
Q = 8  # координаты храним в 1/8 единицы карты (≈1 м): умещаются в Uint16


def fetch_part(i, bbox, refresh):
    path = os.path.join(CACHE, "walk-%d.json" % i)
    if os.path.exists(path) and not refresh:
        return json.load(open(path, encoding="utf-8"))
    os.makedirs(CACHE, exist_ok=True)
    data = urllib.parse.urlencode({"data": QUERY % (WALK, "%s,%s,%s,%s" % bbox)}).encode()
    for attempt in range(10):
        server = OVERPASS[attempt % len(OVERPASS)]
        try:
            req = urllib.request.Request(server, data=data, headers={"User-Agent": "fastcup-map-builder/1.0"})
            raw = urllib.request.urlopen(req, timeout=360).read()
            res = json.loads(raw)
            open(path, "wb").write(raw)
            print("  часть %d: %d КБ" % (i, len(raw) // 1024))
            return res
        except Exception as e:  # Overpass часто перегружен — пробуем другой сервер
            print("  %s (часть %d): %s — пробую другой сервер" % (server.split("/")[2], i, e))
            time.sleep(10)
    sys.exit("Не удалось скачать пешие дороги, часть %d" % i)


def haversine(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def main():
    refresh = "--refresh" in sys.argv
    s, w, n, e = BBOX
    ms, mw = (s + n) / 2, (w + e) / 2
    # город большой — качаем четырьмя частями, иначе Overpass не успевает
    parts = [(s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)]
    print("Пешие дороги из OSM…")
    nodes, ways = {}, {}
    for i, bb in enumerate(parts):
        for el in fetch_part(i, bb, refresh)["elements"]:
            if el["type"] == "node":
                nodes[el["id"]] = (el["lat"], el["lon"])
            elif el["type"] == "way":
                ways[el["id"]] = el["nodes"]
    print("  путей %d, точек %d" % (len(ways), len(nodes)))

    # узлы графа: перекрёстки (точка в двух путях и больше) и концы путей
    use = defaultdict(int)
    for refs in ways.values():
        for r in refs:
            use[r] += 1
    junction = set(r for r, c in use.items() if c > 1)
    for refs in ways.values():
        junction.add(refs[0]); junction.add(refs[-1])

    # рёбра: куски путей между узлами
    edges = []  # (узел A, узел B, [точки OSM])
    for refs in ways.values():
        refs = [r for r in refs if r in nodes]
        if len(refs) < 2:
            continue
        start = 0
        for k in range(1, len(refs)):
            if refs[k] in junction:
                if refs[k] != refs[start]:
                    edges.append((refs[start], refs[k], refs[start:k + 1]))
                start = k

    # оставляем самую большую связную сеть
    adj = defaultdict(list)
    for a, b, _ in edges:
        adj[a].append(b); adj[b].append(a)
    best, seen = set(), set()
    for v in adj:
        if v in seen:
            continue
        comp, stack = set([v]), [v]
        seen.add(v)
        while stack:
            u = stack.pop()
            for t in adj[u]:
                if t not in seen:
                    seen.add(t); comp.add(t); stack.append(t)
        if len(comp) > len(best):
            best = comp
    edges = [ed for ed in edges if ed[0] in best]
    print("  связная сеть: узлов %d, рёбер %d (отброшено мелких кусков: %d узлов)" % (len(best), len(edges), len(adj) - len(best)))

    # номера узлов и упаковка
    ids = {}
    node_xy = []
    for a, b, _ in edges:
        for v in (a, b):
            if v not in ids:
                ids[v] = len(ids)
                x, y = proj(nodes[v][1], nodes[v][0])
                node_xy.append((x, y))
    edge_rows, geom = [], []
    for a, b, refs in edges:
        pts = [nodes[r] for r in refs]
        meters = sum(haversine(p, q) for p, q in zip(pts, pts[1:]))
        xy = [proj(lo, la) for la, lo in pts]
        if len(xy) > 2:  # форма линии упрощается (≈4 м) — для рисования маршрута этого хватает
            xy = list(LineString(xy).simplify(0.5).coords)
        edge_rows.append((ids[a], ids[b], meters, len(geom)))
        geom.extend(xy[1:-1])
    write_graph(node_xy, edge_rows, geom)


def q(v, top):
    return max(0, min(65535, int(round(min(max(v, 0), top) * Q))))


def write_graph(node_xy, edge_rows, geom):
    """Формат (little-endian):
      заголовок: "FCWG", версия u32, узлов u32, рёбер u32, точек формы u32, Q u32
      узлы:  x u16, y u16 (в 1/Q единицы карты)
      рёбра: A u32, B u32, длина f32 (метры), начало формы u32 (номер первой промежуточной точки)
      форма: x u16, y u16 — промежуточные точки рёбер подряд; у ребра i они от start[i] до start[i+1]
    """
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(b"FCWG" + struct.pack("<5I", 1, len(node_xy), len(edge_rows), len(geom), Q))
        f.write(b"".join(struct.pack("<2H", q(x, WIDTH), q(y, HEIGHT)) for x, y in node_xy))
        f.write(b"".join(struct.pack("<2If I", a, b, m, g) for a, b, m, g in edge_rows))
        f.write(b"".join(struct.pack("<2H", q(x, WIDTH), q(y, HEIGHT)) for x, y in geom))
    size = os.path.getsize(OUT)
    import gzip
    gz = len(gzip.compress(open(OUT, "rb").read()))
    print("Готово: %s — %d КБ (сжатым при передаче ≈ %d КБ)" % (os.path.relpath(OUT, ROOT), size // 1024, gz // 1024))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
