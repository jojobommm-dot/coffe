"""
Рисует офлайн-карту Перми для первого экрана из данных OpenStreetMap.

Карта нарезана на плитки (как у онлайн-карт): сайт грузит только те куски,
что видны на экране, и подгружает остальные, когда карту двигают.

Результат:
  images/web/map/{x}-{y}.svg  — плитки карты (вода, зелень, дороги, подписи, граница города)
  js/map-data.js              — границы карты и сетка плиток, чтобы сайт ставил метки по координатам

Запуск (нужен Python 3 и библиотека shapely: pip install shapely):
  python tools/build_map.py              скачать данные OSM (если ещё нет) и нарисовать
  python tools/build_map.py --refresh    скачать данные заново

Скачанные данные кэшируются в tools/osm-cache/ (папка в .gitignore).
Область карты — Пермский городской округ (BBOX ниже); дальше неё карту не сдвинуть.
Данные © участники OpenStreetMap, лицензия ODbL — подпись есть на карте на сайте.
"""
import glob
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

from shapely.geometry import LineString, MultiLineString, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", "osm-cache")
OUT_DIR = os.path.join(ROOT, "images", "web", "map")
OUT_JS = os.path.join(ROOT, "js", "map-data.js")

CITY_RELATION = 1084793  # Пермский городской округ в OSM
# Область карты: юг, запад, север, восток — границы городского округа с небольшим запасом
BBOX = (57.86, 55.79, 58.185, 56.665)
UNITS_PER_DEG = 7000  # единиц SVG на градус долготы; 1 единица ≈ 8,5 м на широте Перми
TILE = 1000           # сторона плитки в единицах (≈ 8,5 км)

# основной сервер и зеркала: если один перегружен, пробуем следующий
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
QUERIES = {
    "water": """
        way["natural"="water"]({b}); relation["natural"="water"]({b});
        way["waterway"="riverbank"]({b}); relation["waterway"="riverbank"]({b});
        way["landuse"="reservoir"]({b});
        way["waterway"~"^(river|stream|canal)$"]({b});""",
    "green": """
        way["leisure"~"^(park|garden)$"]({b}); relation["leisure"="park"]({b});
        way["landuse"~"^(forest|cemetery)$"]({b}); relation["landuse"="forest"]({b});
        way["natural"="wood"]({b}); relation["natural"="wood"]({b});""",
    "roads": """
        way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link)$"]({b});
        way["railway"="rail"][!"service"]({b});""",
    "streets": """
        way["highway"~"^(residential|unclassified|living_street|pedestrian)$"]({b});""",
    "places": """
        node["place"~"^(suburb|quarter)$"]({b});""",
    "boundary": """
        relation(%d);""" % CITY_RELATION,
}

# Цвета в тон сайта (тёплая бумага, приглушённая вода и зелень)
C = {
    "land": "#F2E4CF", "forest": "#E2DCBC", "park": "#E6E1C2", "cemetery": "#E4DAC6",
    "water": "#BCCDC6", "water_line": "#BCCDC6", "rail": "#C2AE9A", "boundary": "#B9876F",
    "minor": "#FBF3E7", "tertiary": "#FFF8EE", "secondary": "#FDEBCB", "major": "#F8D59F",
    "casing": "#E2C7A6", "major_casing": "#DDB284",
    "street_label": "#8C7260", "place_label": "#A68B76", "water_label": "#6F928B",
}


def fetch(name, refresh):
    path = os.path.join(CACHE, name + ".json")
    if os.path.exists(path) and not refresh:
        return json.load(open(path, encoding="utf-8"))
    os.makedirs(CACHE, exist_ok=True)
    b = "{},{},{},{}".format(*BBOX)
    q = "[out:json][timeout:300];(" + QUERIES[name].format(b=b) + ");out " + ("center tags" if name == "places" else "geom") + ";"
    data = urllib.parse.urlencode({"data": q}).encode()
    for attempt in range(8):
        server = OVERPASS[attempt % len(OVERPASS)]
        try:
            req = urllib.request.Request(server, data=data, headers={"User-Agent": "fastcup-map-builder/1.0"})
            raw = urllib.request.urlopen(req, timeout=360).read()
            res = json.loads(raw)
            open(path, "wb").write(raw)
            print("  %s: %d КБ" % (name, len(raw) // 1024))
            return res
        except Exception as e:  # Overpass иногда занят — ждём и повторяем
            print("  %s (%s): %s — пробую другой сервер" % (server.split("/")[2], name, e))
            time.sleep(10)
    sys.exit("Не удалось скачать данные " + name)


# ---------- проекция (Web Mercator, как у онлайн-карт) ----------
R = 6378137.0
S, W_, N, E = BBOX
WIDTH = round((E - W_) * UNITS_PER_DEG)


def mx(lon):
    return R * math.radians(lon)


def my(lat):
    return R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


K = WIDTH / (mx(E) - mx(W_))
HEIGHT = round((my(N) - my(S)) * K, 1)
FRAME = box(0, 0, WIDTH, HEIGHT)


def proj(lon, lat):
    return ((mx(lon) - mx(W_)) * K, (my(N) - my(lat)) * K)


def way_coords(el):
    return [proj(p["lon"], p["lat"]) for p in el.get("geometry", []) if p]


def area_of(el):
    """Полигон из замкнутого пути или мультиполигона-отношения."""
    if el["type"] == "way":
        pts = way_coords(el)
        if len(pts) < 4 or pts[0] != pts[-1]:
            return None
        return Polygon(pts).buffer(0)
    outer, inner = [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        line = [proj(p["lon"], p["lat"]) for p in m["geometry"] if p]
        if len(line) >= 2:
            (inner if m.get("role") == "inner" else outer).append(LineString(line))
    if not outer:
        return None
    shape = unary_union(list(polygonize(linemerge(outer))))
    if inner:
        shape = shape.difference(unary_union(list(polygonize(linemerge(inner)))))
    return shape.buffer(0)


# ---------- вывод путей SVG: относительные команды, 1 знак после запятой ----------
def fmt(v):
    s = "%.1f" % v
    s = s.rstrip("0").rstrip(".") if "." in s else s
    if s.startswith("0."):
        s = s[1:]
    elif s.startswith("-0."):
        s = "-" + s[2:]
    return "0" if s in ("", "-0", "-") else s


def ring_d(coords, close):
    pts = [(round(x, 1), round(y, 1)) for x, y in coords]
    rel = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        dx, dy = x1 - x0, y1 - y0
        if dx == 0 and dy == 0:
            continue
        a, b = fmt(dx), fmt(dy)
        rel.append(a + ("" if b.startswith("-") else " ") + b)
    if not rel:
        return ""
    s = "M" + fmt(pts[0][0]) + " " + fmt(pts[0][1]) + "l" + " ".join(rel).replace(" -", "-")
    return s + ("z" if close else "")


def lines_of(geom):
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if hasattr(geom, "geoms"):
        return [g for sub in geom.geoms for g in lines_of(sub)]
    return []


def polys_of(geom):
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if hasattr(geom, "geoms"):
        return [g for sub in geom.geoms for g in polys_of(sub)]
    return []


def poly_d(geom, min_area=0):
    parts = []
    for p in polys_of(geom):
        if p.area < min_area:
            continue
        parts.append(ring_d(p.exterior.coords, True))
        for r in p.interiors:
            if Polygon(r).area >= min_area:
                parts.append(ring_d(r.coords, True))
    return "".join(x for x in parts if x)


def line_d(geom):
    return "".join(ring_d(ln.coords, False) for ln in lines_of(geom) if ln.length > 1)


def merged(lines, tol):
    if not lines:
        return None
    return unary_union([ln.simplify(tol) for ln in lines_of(linemerge(MultiLineString(lines)).intersection(FRAME))])


ABBR = [("улица ", "ул. "), (" улица", " ул."), ("проспект ", "пр. "), (" проспект", " пр."),
        ("шоссе ", "ш. "), (" шоссе", " ш."), ("бульвар ", "бул. "), (" бульвар", " бул."),
        ("набережная", "наб."), ("Набережная", "наб."), ("переулок", "пер."), ("площадь", "пл."), ("тракт", "тр.")]


def short(name):
    for a, b in ABBR:
        name = name.replace(a, b)
    return name


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main():
    refresh = "--refresh" in sys.argv
    print("Данные OSM…")
    data = {k: fetch(k, refresh)["elements"] for k in QUERIES}

    # --- вода ---
    water_polys, water_lines, kama = [], {"river": [], "small": []}, []
    for el in data["water"]:
        t = el.get("tags", {})
        if el["type"] == "way" and t.get("waterway") in ("river", "stream", "canal"):
            ln = way_coords(el)
            if len(ln) >= 2:
                water_lines["river" if t["waterway"] == "river" else "small"].append(LineString(ln))
                if t.get("name") == "Кама":
                    kama.append(LineString(ln))
            continue
        a = area_of(el)
        if a is not None and not a.is_empty:
            water_polys.append(a)
    water_all = unary_union(water_polys).intersection(FRAME)

    # --- зелень ---
    groups = {"forest": [], "park": [], "cemetery": []}
    for el in data["green"]:
        t = el.get("tags", {})
        kind = "cemetery" if t.get("landuse") == "cemetery" else "park" if t.get("leisure") else "forest"
        a = area_of(el)
        if a is not None and not a.is_empty:
            groups[kind].append(a)

    # --- дороги ---
    cls = {"major": [], "secondary": [], "tertiary": [], "minor": [], "rail": []}
    named = {}
    for el in data["roads"] + data["streets"]:
        t = el.get("tags", {})
        ln = way_coords(el)
        if len(ln) < 2:
            continue
        hw = t.get("highway", "")
        if t.get("railway") == "rail":
            k = "rail"
        elif hw.startswith(("motorway", "trunk", "primary")):
            k = "major"
        elif hw.startswith("secondary"):
            k = "secondary"
        elif hw == "tertiary":
            k = "tertiary"
        else:
            k = "minor"
        g = LineString(ln)
        cls[k].append(g)
        if k in ("major", "secondary", "tertiary") and t.get("name") and not hw.endswith("_link"):
            named.setdefault(t["name"], {"rank": k, "lines": []})["lines"].append(g)

    # --- граница города ---
    border = None
    for el in data["boundary"]:
        shape = area_of(el)
        if shape is not None and not shape.is_empty:
            border = unary_union([p.exterior for p in polys_of(shape)]).simplify(3)

    print("Рисую…")
    # слои в порядке отрисовки: (атрибуты SVG, геометрия, полигон?, резать по плитке?)
    g_line = 'fill="none" stroke-linecap="round" stroke-linejoin="round"'
    layers = []
    for k in ("forest", "cemetery", "park"):
        geom = unary_union(groups[k]).difference(water_all).intersection(FRAME).simplify(1.2, preserve_topology=True)
        layers.append(('fill="%s"' % C[k], unary_union([p for p in polys_of(geom) if p.area >= 600]), True, True))
    layers.append(('%s stroke="%s" stroke-width="5"' % (g_line, C["water_line"]), merged(water_lines["river"], 0.8), False, True))
    layers.append(('%s stroke="%s" stroke-width="2.2"' % (g_line, C["water_line"]), merged(water_lines["small"], 0.8), False, True))
    layers.append(('fill="%s"' % C["water"], unary_union([p for p in polys_of(water_all.simplify(0.8, preserve_topology=True)) if p.area >= 50]), True, True))
    road_style = [
        ("rail", C["rail"], 2.2, None), ("minor", C["minor"], 1.6, None),
        ("tertiary", C["tertiary"], 2.8, C["casing"]), ("secondary", C["secondary"], 3.8, C["casing"]),
        ("major", C["major"], 5.2, C["major_casing"]),
    ]
    road_geom = {k: merged(v, 0.7 if k == "minor" else 0.5) for k, v in cls.items()}
    for k, col, wdt, casing in road_style:  # сначала обводки, потом заливки — перекрёстки без швов
        if casing:
            layers.append(('%s stroke="%s" stroke-width="%s"' % (g_line, casing, fmt(wdt + 1.6)), road_geom[k], False, True))
    for k, col, wdt, casing in road_style:
        dash = ' stroke-dasharray="6 5"' if k == "rail" else ""
        # пунктир не режем по плиткам, иначе на стыках собьётся рисунок штрихов
        layers.append(('%s stroke="%s" stroke-width="%s"%s' % (g_line, col, fmt(wdt), dash), road_geom[k], False, k != "rail"))
    if border is not None:
        layers.append(('%s stroke="%s" stroke-width="3" stroke-dasharray="16 9" opacity=".7"' % (g_line, C["boundary"]), border, False, False))

    # --- микрорайоны ---
    places, place_pts = [], []
    for el in data["places"]:
        name = el.get("tags", {}).get("name")
        if el["type"] != "node" or el["tags"].get("place") not in ("suburb", "quarter") or not name or len(name) > 20:
            continue
        x, y = proj(el["lon"], el["lat"])
        if 30 < x < WIDTH - 30 and 30 < y < HEIGHT - 30:
            hw = len(name) * 6 + 20
            places.append((box(x - hw, y - 14, x + hw, y + 6), '<text x="%s" y="%s">%s</text>' % (fmt(x), fmt(y), esc(name.upper()))))
            place_pts.append((x, y, hw))

    # --- подписи улиц вдоль линий (самые длинные куски, без наложений) ---
    rank_order = {"major": 0, "secondary": 1, "tertiary": 2}
    cands = []
    for name, info in named.items():
        for ln in lines_of(linemerge(MultiLineString(info["lines"])).intersection(FRAME.buffer(-40))):
            label = short(name)
            need = len(label) * 7.4 + 60
            if ln.length >= need:
                cands.append((rank_order[info["rank"]], -ln.length, label, ln, need))
    cands.sort(key=lambda c: (c[0], c[1]))
    placed, streets, used = [], [], {}
    for rank, _, label, ln, need in cands:
        if used.get(label, 0) >= 3:
            continue
        # кусок нужной длины вокруг середины линии, сглаженный для ровного текста
        mid = ln.length / 2
        seg = LineString([ln.interpolate(mid - need / 2 + i * need / 12).coords[0] for i in range(13)]).simplify(3)
        c = seg.interpolate(0.5, normalized=True)
        if any(c.distance(p) < 230 for p in placed):
            continue
        if any(abs(c.x - px) < hw + need / 2 and abs(c.y - py) < 28 for px, py, hw in place_pts) or \
           any(seg.distance(LineString([(px - hw, py - 6), (px + hw, py - 6)])) < 14 for px, py, hw in place_pts):
            continue
        if seg.coords[0][0] > seg.coords[-1][0]:  # текст всегда слева направо
            seg = LineString(list(seg.coords)[::-1])
        placed.append(c)
        used[label] = used.get(label, 0) + 1
        pid = "s%d" % len(streets)
        streets.append((seg.buffer(12), '<path id="%s" d="%s"/>' % (pid, ring_d(seg.coords, False)),
                        '<text><textPath href="#%s" startOffset="50%%">%s</textPath></text>' % (pid, esc(label))))

    # --- «р. Кама» вдоль русла ---
    kamas = []
    if kama:
        km = linemerge(MultiLineString(kama)).intersection(FRAME.buffer(-150))
        for ln in sorted(lines_of(km), key=lambda l: -l.length)[:1]:
            for i in range(max(1, int(ln.length // 900))):
                at = ln.length * (i + 0.5) / max(1, int(ln.length // 900))
                seg = LineString([ln.interpolate(at - 70 + j * 140 / 8).coords[0] for j in range(9)]).simplify(4)
                if seg.coords[0][0] > seg.coords[-1][0]:
                    seg = LineString(list(seg.coords)[::-1])
                pid = "k%d" % len(kamas)
                kamas.append((seg.buffer(16), '<path id="%s" d="%s"/>' % (pid, ring_d(seg.coords, False)),
                              '<text><textPath href="#%s" startOffset="50%%">р. Кама</textPath></text>' % pid))

    # --- плитки ---
    os.makedirs(OUT_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUT_DIR, "*.svg")):
        os.remove(old)
    cols, rows = math.ceil(WIDTH / TILE), math.ceil(HEIGHT / TILE)
    halo = 'paint-order="stroke" stroke="%s" stroke-linejoin="round"' % C["land"]
    font = 'font-family="Inter, Segoe UI, Arial, sans-serif"'
    total = 0
    for ty in range(rows):
        for tx in range(cols):
            x0, y0 = tx * TILE, ty * TILE
            tw, th = min(TILE, WIDTH - x0), min(TILE, HEIGHT - y0)
            tbox = box(x0, y0, x0 + tw, y0 + th)
            cut = tbox.buffer(30, join_style=2)  # с запасом: толстые линии не обрываются на краю плитки
            out = [
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s %s %s %s" width="%s" height="%s">'
                % (fmt(x0), fmt(y0), fmt(tw), fmt(th), fmt(tw), fmt(th)),
                "<!-- Карта Перми для сайта Fastcup, плитка %d-%d. Данные © участники OpenStreetMap (ODbL). Собрано tools/build_map.py -->" % (tx, ty),
            ]
            st = [s for s in streets if s[0].intersects(tbox)]
            km = [s for s in kamas if s[0].intersects(tbox)]
            pl = [p for p in places if p[0].intersects(tbox)]
            if st or km:
                out.append("<defs>" + "".join(s[1] for s in st + km) + "</defs>")
            out.append('<rect x="%s" y="%s" width="%s" height="%s" fill="%s"/>' % (fmt(x0), fmt(y0), fmt(tw), fmt(th), C["land"]))
            for attrs, geom, is_poly, clip in layers:
                if geom is None or geom.is_empty:
                    continue
                if clip:
                    g = geom.intersection(cut)
                else:  # целые линии, задевающие плитку
                    g = unary_union([ln for ln in lines_of(geom) if ln.intersects(cut)]) if geom.intersects(cut) else None
                d = (poly_d(g) if is_poly else line_d(g)) if g is not None else ""
                if d:
                    out.append('<path %s d="%s"/>' % (attrs, d))
            if st:
                out.append('<g %s font-size="12.5" font-weight="500" fill="%s" %s stroke-width="3" text-anchor="middle">%s</g>'
                           % (font, C["street_label"], halo, "".join(s[2] for s in st)))
            if km:
                out.append('<g %s font-size="20" font-style="italic" fill="%s" text-anchor="middle" letter-spacing="1">%s</g>'
                           % (font, C["water_label"], "".join(s[2] for s in km)))
            if pl:
                out.append('<g %s font-size="13" font-weight="600" fill="%s" %s stroke-width="3.5" text-anchor="middle" letter-spacing="1.6">%s</g>'
                           % (font, C["place_label"], halo, "".join(p[1] for p in pl)))
            out.append("</svg>")
            svg = "\n".join(out) + "\n"
            total += len(svg.encode())
            open(os.path.join(OUT_DIR, "%d-%d.svg" % (tx, ty)), "w", encoding="utf-8", newline="\n").write(svg)

    js = (
        "/* Офлайн-карта Перми: плитки images/web/map/{x}-{y}.svg. Файл создан tools/build_map.py — не правьте вручную. */\n"
        "window.FASTCUP_MAP = {\n"
        "  width: %s, height: %s,   // размер карты в единицах SVG\n"
        "  tile: %d, cols: %d, rows: %d,   // сетка плиток\n"
        '  tiles: "images/web/map/{x}-{y}.svg",\n'
        "  south: %s, west: %s, north: %s, east: %s   // область карты, градусы\n"
        "};\n" % (WIDTH, fmt(HEIGHT), TILE, cols, rows, S, W_, N, E)
    )
    open(OUT_JS, "w", encoding="utf-8", newline="\n").write(js)
    print("Готово: %d плиток %dx%d, всего %d КБ, %d подписей улиц, %d микрорайонов"
          % (cols * rows, cols, rows, total // 1024, len(streets), len(places)))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
