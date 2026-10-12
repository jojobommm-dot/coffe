"""
Рисует офлайн-карту Перми для первого экрана из данных OpenStreetMap.

Как у онлайн-карт: карта заранее нарисована готовыми картинками-плитками на несколько
уровней масштаба. Сайт грузит только видимые куски нужного уровня и подгружает остальные,
когда карту двигают. Готовые картинки браузер показывает быстро даже на слабой видеокарте
(сложный вектор на каждом кадре перерисовывался бы с рывками).

Как собирается:
  1) из данных OSM рисуется векторная карта (SVG) в трёх детализациях — tools/osm-cache/vector/
  2) Chrome рендерит её в картинки WebP 512×512 — images/web/map/{уровень}/{x}-{y}.webp
  3) js/map-data.js — границы карты и уровни, чтобы сайт ставил метки по координатам

Запуск (нужен Python 3 и библиотеки: pip install shapely playwright; рендерит установленный Chrome):
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
TILE = 1000           # сторона векторной плитки в единицах (≈ 8,5 км)
RASTER_TILE = 512     # сторона картинки-плитки, пикселей
# Уровни масштаба (пикселей на единицу) и детализация каждого — см. DETAIL ниже.
# Сайт берёт уровень под масштаб и плотность экрана; уровень 0 (весь город) — подложка.
LEVELS = [
    {"scale": 0.25, "detail": "low"},
    {"scale": 0.5, "detail": "mid"},
    {"scale": 1, "detail": "full"},
    {"scale": 2, "detail": "full"},
]

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

    print("Рисую векторную карту…")
    road_geom = {k: merged(v, 0.7 if k == "minor" else 0.5) for k, v in cls.items()}
    green_geom = {}
    for k in ("forest", "cemetery", "park"):
        geom = unary_union(groups[k]).difference(water_all).intersection(FRAME).simplify(1.2, preserve_topology=True)
        green_geom[k] = unary_union([p for p in polys_of(geom) if p.area >= 600])
    water_geom = unary_union([p for p in polys_of(water_all.simplify(0.8, preserve_topology=True)) if p.area >= 50])
    river_geom, stream_geom = merged(water_lines["river"], 0.8), merged(water_lines["small"], 0.8)

    # --- микрорайоны ---
    places, place_pts = [], []
    for el in data["places"]:
        name = el.get("tags", {}).get("name")
        if el["type"] != "node" or el["tags"].get("place") not in ("suburb", "quarter") or not name or len(name) > 20:
            continue
        x, y = proj(el["lon"], el["lat"])
        if 30 < x < WIDTH - 30 and 30 < y < HEIGHT - 30:
            hw = len(name) * 6 + 20
            places.append((x, y, name.upper()))
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
        streets.append((seg, label))

    # --- «р. Кама» вдоль русла ---
    kama_lines = []
    if kama:
        km = linemerge(MultiLineString(kama)).intersection(FRAME.buffer(-150))
        kama_lines = sorted(lines_of(km), key=lambda l: -l.length)[:1]

    # --- векторные плитки для каждого уровня детализации ---
    vec_root = os.path.join(CACHE, "vector")
    for detail in sorted({lv["detail"] for lv in LEVELS}):
        write_vector(detail, os.path.join(vec_root, detail), green_geom, water_geom, river_geom, stream_geom,
                     road_geom, border, places, streets, kama_lines)

    # --- готовые картинки для сайта ---
    print("Рендерю картинки WebP через Chrome…")
    render_raster(vec_root)

    js = (
        "/* Офлайн-карта Перми: готовые картинки images/web/map/{z}/{x}-{y}.webp на несколько уровней масштаба.\n"
        "   Файл создан tools/build_map.py — не правьте вручную. */\n"
        "window.FASTCUP_MAP = {\n"
        "  width: %s, height: %s,   // размер карты в единицах (1 единица ≈ 8,5 м)\n"
        "  tile: %d,                  // сторона картинки, пикселей\n"
        "  levels: [%s],   // пикселей на единицу для уровней 0…%d\n"
        '  tiles: "images/web/map/{z}/{x}-{y}.webp",\n'
        "  south: %s, west: %s, north: %s, east: %s   // область карты, градусы\n"
        "};\n" % (WIDTH, fmt(HEIGHT), RASTER_TILE, ", ".join(str(lv["scale"]) for lv in LEVELS), len(LEVELS) - 1, S, W_, N, E)
    )
    open(OUT_JS, "w", encoding="utf-8", newline="\n").write(js)
    print("Готово: %s" % os.path.relpath(OUT_JS, ROOT))


# Уровни детализации векторной карты: что рисовать и насколько толще линии/крупнее подписи
DETAIL = {
    # весь город: только крупные дороги, линии толще, подписи — только Кама
    "low": {"roads": ("major", "secondary", "rail"), "width": 2.6, "rivers": 2.2, "streams": False,
            "places": None, "streets": False, "kama": 56},
    # район: все дороги, подписи микрорайонов
    "mid": {"roads": ("major", "secondary", "tertiary", "minor", "rail"), "width": 1.7, "rivers": 1.5, "streams": True,
            "places": 22, "streets": False, "kama": 34},
    # улицы: всё, как в векторной карте
    "full": {"roads": ("major", "secondary", "tertiary", "minor", "rail"), "width": 1, "rivers": 1, "streams": True,
             "places": 13, "streets": True, "kama": 20},
}


def write_vector(detail, out_dir, green_geom, water_geom, river_geom, stream_geom, road_geom, border, places, streets, kama_lines):
    opt = DETAIL[detail]
    k = opt["width"]
    g_line = 'fill="none" stroke-linecap="round" stroke-linejoin="round"'
    layers = []  # (атрибуты SVG, геометрия, полигон?, резать по плитке?)
    for name in ("forest", "cemetery", "park"):
        layers.append(('fill="%s"' % C[name], green_geom[name], True, True))
    layers.append(('%s stroke="%s" stroke-width="%s"' % (g_line, C["water_line"], fmt(5 * opt["rivers"])), river_geom, False, True))
    if opt["streams"]:
        layers.append(('%s stroke="%s" stroke-width="2.2"' % (g_line, C["water_line"]), stream_geom, False, True))
    layers.append(('fill="%s"' % C["water"], water_geom, True, True))
    road_style = [
        ("rail", C["rail"], 2.2, None), ("minor", C["minor"], 1.6, None),
        ("tertiary", C["tertiary"], 2.8, C["casing"]), ("secondary", C["secondary"], 3.8, C["casing"]),
        ("major", C["major"], 5.2, C["major_casing"]),
    ]
    road_style = [r for r in road_style if r[0] in opt["roads"]]
    for name, col, wdt, casing in road_style:  # сначала обводки, потом заливки — перекрёстки без швов
        if casing:
            layers.append(('%s stroke="%s" stroke-width="%s"' % (g_line, casing, fmt((wdt + 1.6) * k)), road_geom[name], False, True))
    for name, col, wdt, casing in road_style:
        dash = ' stroke-dasharray="%s %s"' % (fmt(6 * k), fmt(5 * k)) if name == "rail" else ""
        # пунктир не режем по плиткам, иначе на стыках собьётся рисунок штрихов
        layers.append(('%s stroke="%s" stroke-width="%s"%s' % (g_line, col, fmt(wdt * k), dash), road_geom[name], False, name != "rail"))
    if border is not None:
        layers.append(('%s stroke="%s" stroke-width="%s" stroke-dasharray="%s %s" opacity=".7"'
                       % (g_line, C["boundary"], fmt(3 * k), fmt(16 * k), fmt(9 * k)), border, False, False))

    # подписи: (область, defs, текст, группа)
    labels = []
    if opt["places"]:
        fs = opt["places"]
        for x, y, name in places:
            hw = len(name) * fs * 0.5 + 10
            labels.append((box(x - hw, y - fs, x + hw, y + fs / 2), "", '<text x="%s" y="%s">%s</text>' % (fmt(x), fmt(y), esc(name)), "place"))
    if opt["streets"]:
        for i, (seg, label) in enumerate(streets):
            labels.append((seg.buffer(12), '<path id="s%d" d="%s"/>' % (i, ring_d(seg.coords, False)),
                           '<text><textPath href="#s%d" startOffset="50%%">%s</textPath></text>' % (i, esc(label)), "street"))
    fk = opt["kama"]
    for ln in kama_lines:
        n = max(1, int(ln.length // (fk * 45)))
        for i in range(n):
            at, half = ln.length * (i + 0.5) / n, fk * 3.5
            seg = LineString([ln.interpolate(at - half + j * 2 * half / 8).coords[0] for j in range(9)]).simplify(fk / 5)
            if seg.coords[0][0] > seg.coords[-1][0]:
                seg = LineString(list(seg.coords)[::-1])
            pid = "k%d" % i
            labels.append((seg.buffer(fk), '<path id="%s" d="%s"/>' % (pid, ring_d(seg.coords, False)),
                           '<text><textPath href="#%s" startOffset="50%%">р. Кама</textPath></text>' % pid, "kama"))

    halo = 'paint-order="stroke" stroke="%s" stroke-linejoin="round"' % C["land"]
    font = 'font-family="Inter, Segoe UI, Arial, sans-serif"'
    groups = {
        "street": '<g %s font-size="12.5" font-weight="500" fill="%s" %s stroke-width="3" text-anchor="middle">' % (font, C["street_label"], halo),
        "kama": '<g %s font-size="%s" font-style="italic" fill="%s" text-anchor="middle" letter-spacing="%s">' % (font, fk, C["water_label"], fmt(fk / 20)),
        "place": '<g %s font-size="%s" font-weight="600" fill="%s" %s stroke-width="%s" text-anchor="middle" letter-spacing="%s">'
                 % (font, opt["places"] or 13, C["place_label"], halo, fmt((opt["places"] or 13) * 0.27), fmt((opt["places"] or 13) * 0.12)),
    }

    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "*.svg")):
        os.remove(old)
    cols, rows = math.ceil(WIDTH / TILE), math.ceil(HEIGHT / TILE)
    total = 0
    for ty in range(rows):
        for tx in range(cols):
            x0, y0 = tx * TILE, ty * TILE
            tw, th = min(TILE, WIDTH - x0), min(TILE, HEIGHT - y0)
            tbox = box(x0, y0, x0 + tw, y0 + th)
            cut = tbox.buffer(30 * k, join_style=2)  # с запасом: толстые линии не обрываются на краю плитки
            out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s %s %s %s" width="%s" height="%s">'
                   % (fmt(x0), fmt(y0), fmt(tw), fmt(th), fmt(tw), fmt(th))]
            here = [lb for lb in labels if lb[0].intersects(tbox)]
            defs = "".join(lb[1] for lb in here)
            if defs:
                out.append("<defs>" + defs + "</defs>")
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
            for kind in ("street", "kama", "place"):
                texts = "".join(lb[2] for lb in here if lb[3] == kind)
                if texts:
                    out.append(groups[kind] + texts + "</g>")
            out.append("</svg>")
            svg = "\n".join(out) + "\n"
            total += len(svg.encode())
            open(os.path.join(out_dir, "%d-%d.svg" % (tx, ty)), "w", encoding="utf-8", newline="\n").write(svg)
    print("  вектор «%s»: %d КБ" % (detail, total // 1024))


# векторные плитки уровня грузим в страницу один раз: картинки из blob не «портят» canvas, в отличие от file://
LOAD_JS = """async (list) => {
  window.__imgs = await Promise.all(list.map(t => new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img); img.onerror = bad;
    img.src = URL.createObjectURL(new Blob([t], {type: "image/svg+xml"}));
  })));
  return window.__imgs.length;
}"""

RENDER_JS = """({cols, unit, s, mapW, mapH, x0, y0, w, h}) => {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const u0 = x0 / s, v0 = y0 / s, u1 = (x0 + w) / s, v1 = (y0 + h) / s;
  for (let r = Math.floor(v0 / unit); r <= Math.min(Math.ceil(mapH / unit) - 1, Math.floor(v1 / unit)); r++)
    for (let q = Math.floor(u0 / unit); q <= Math.min(cols - 1, Math.floor(u1 / unit)); q++) {
      const img = window.__imgs[r * cols + q];
      const tw = Math.min(unit, mapW - q * unit), th = Math.min(unit, mapH - r * unit);
      ctx.drawImage(img, (q * unit - u0) * s, (r * unit - v0) * s, tw * s, th * s);
    }
  return c.toDataURL("image/webp", 0.8).split(",")[1];
}"""


def render_raster(vec_root):
    import base64
    from playwright.sync_api import sync_playwright

    for old in glob.glob(os.path.join(OUT_DIR, "*.svg")) + glob.glob(os.path.join(OUT_DIR, "*", "*.webp")):
        os.remove(old)
    cols, rows = math.ceil(WIDTH / TILE), math.ceil(HEIGHT / TILE)
    with sync_playwright() as pw:
        try:
            br = pw.chromium.launch(channel="chrome")   # установленный Chrome
        except Exception:
            br = pw.chromium.launch()                   # или: python -m playwright install chromium
        page = br.new_page()
        page.goto("about:blank")
        for z, lv in enumerate(LEVELS):
            s = lv["scale"]
            vec = os.path.join(vec_root, lv["detail"])
            page.evaluate(LOAD_JS, [open(os.path.join(vec, "%d-%d.svg" % (q, r)), encoding="utf-8").read()
                                    for r in range(rows) for q in range(cols)])
            pw_w, pw_h = WIDTH * s, HEIGHT * s
            tcols, trows = math.ceil(pw_w / RASTER_TILE), math.ceil(pw_h / RASTER_TILE)
            zdir = os.path.join(OUT_DIR, str(z))
            os.makedirs(zdir, exist_ok=True)
            size = 0
            for ty in range(trows):
                for tx in range(tcols):
                    x0, y0 = tx * RASTER_TILE, ty * RASTER_TILE
                    w = int(min(RASTER_TILE, math.ceil(pw_w - x0)))
                    h = int(min(RASTER_TILE, math.ceil(pw_h - y0)))
                    b64 = page.evaluate(RENDER_JS, {"cols": cols, "unit": TILE, "s": s,
                                                    "mapW": WIDTH, "mapH": HEIGHT, "x0": x0, "y0": y0, "w": w, "h": h})
                    raw = base64.b64decode(b64)
                    size += len(raw)
                    open(os.path.join(zdir, "%d-%d.webp" % (tx, ty)), "wb").write(raw)
            print("  уровень %d (%s пикс/ед., «%s»): %d картинок %dx%d, %d КБ"
                  % (z, str(s), lv["detail"], tcols * trows, tcols, trows, size // 1024))
        br.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
