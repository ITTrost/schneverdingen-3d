#!/usr/bin/env python3
"""Fassadenfarben aus Mapillary-Straßenfotos messen – EXPERIMENTELL, Ergebnisse derzeit nicht verwendet.

Stand 11/2026: In Schneverdingen stammen die Mapillary-Bilder überwiegend von Dashcams (Blaustich durch
die Scheibe, ungenaue Kameralage, viele Verdeckungen durch Bäume und Autos). Eine Stichprobe ergab zu viele
Fehler (Klinkerhäuser als Putz erkannt), deshalb liegt keine data/facades.json im Repository. Die Karte
liest die Datei nur, wenn sie vorhanden ist.

Aufruf:
    python3 tools/facades_mapillary.py <ordner-mit-gml> <dem.npz> <arbeitsordner> data/facades.json [W,S,E,N]

Ablauf:
  1. Bilder im Gebiet über die Mapillary-Graph-API suchen (Token im Header, bei uns vom Proxy gesetzt).
  2. Je Bild die LoD2-Wände der Umgebung mit der von Mapillary berechneten Kameralage ins Foto
     projizieren (OpenSfM-Konvention), verdeckte Wände per Maler-Algorithmus entfernen.
  3. Aus der Mitte jeder sichtbaren Wand (1,8 m über Grund bis 9 m, seitlich 20 % Rand) die Pixel
     sammeln; Himmel, Grün, Schatten und Spitzlichter werden verworfen.
  4. Je Gebäude den Median über alle Bilder bilden und als Klinker oder Putz einordnen.

Ausgabe: {"gebaeude": {"<LoD2-ID>": ["#rrggbb", "klinker"|"putz", <Bilder>]}}
Lizenz: Die Fotos stammen von Mapillary-Mitwirkenden (CC BY-SA 4.0); die daraus abgeleiteten
Farben stehen deshalb ebenfalls unter CC BY-SA 4.0.
"""
import colorsys
import io
import json
import math
import os
import subprocess
import sys
import time
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(__file__))
from build_lod2 import B, NS, Dem, etree, surfaces  # noqa: E402

API = 'https://graph.mapillary.com'
TOKEN_HEADER = os.environ.get('MAPILLARY_AUTH', 'Authorization: Bearer proxy-injected')
FIELDS = 'id,computed_geometry,computed_rotation,camera_parameters,camera_type,thumb_1024_url,captured_at'
CAM_HEIGHT = 1.6       # Meter über Grund (Auto oder Fußgänger)
MAX_DIST = 35          # Meter (weiter weg: Kameralage zu ungenau, zu viel verdeckt)
MIN_YEAR = 2017
RES = (512, 288)       # Auflösung des Sichtbarkeitspuffers
MIN_IMAGES = 3         # so viele Fotos müssen ein Gebäude zeigen
MIN_AGREE = 0.75       # so einig müssen sie sich beim Material sein

to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
to_wgs = Transformer.from_crs(25832, 4326, always_xy=True)


def get(url, binary=False):
    for i in range(4):
        r = subprocess.run(['curl', '-s', '-m', '60', '-H', TOKEN_HEADER, url], capture_output=True)
        if r.returncode == 0 and r.stdout:
            return r.stdout if binary else json.loads(r.stdout)
        time.sleep(3 * (i + 1))
    raise RuntimeError('Abruf fehlgeschlagen: ' + url[:80])


def find_images(bbox, work):
    path = os.path.join(work, 'images.json')
    if os.path.exists(path):
        return json.load(open(path))
    w, s, e, n = bbox
    out = {}
    step = 0.004
    lon = w
    while lon < e:
        lat = s
        while lat < n:
            q = f'{API}/images?bbox={lon},{lat},{min(lon + step, e)},{min(lat + step, n)}&fields={FIELDS}&limit=2000'
            for im in get(q).get('data', []):
                if im.get('camera_type') == 'perspective' and im.get('computed_rotation') and im.get('camera_parameters'):
                    if time.gmtime(im['captured_at'] / 1000).tm_year >= MIN_YEAR:
                        out[im['id']] = im
            lat += step
        lon += step
    images = list(out.values())
    # ausdünnen: höchstens ein Bild je 8 m und 45°-Richtungssektor (neuere bevorzugt)
    images.sort(key=lambda im: -im['captured_at'])
    seen, keep = set(), []
    for im in images:
        lon_, lat_ = im['computed_geometry']['coordinates']
        e_, n_ = to_utm.transform(lon_, lat_)
        R = rotation(im['computed_rotation'])
        fwd = R.T @ np.array([0, 0, 1.0])
        sector = int(((math.degrees(math.atan2(fwd[0], fwd[1])) + 360) % 360) // 45)
        key = (int(e_ // 8), int(n_ // 8), sector)
        if key not in seen:
            seen.add(key)
            keep.append(im)
    json.dump(keep, open(path, 'w'))
    return keep


def rotation(rv):
    rv = np.array(rv, dtype=float)
    th = np.linalg.norm(rv)
    if th < 1e-9:
        return np.eye(3)
    k = rv / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def load_walls(gml_dir, bbox):
    """Alle Wände im Gebiet: (Gebäude-ID, Ring UTM+Höhe, Grundhöhe)."""
    w, s, e, n = bbox
    e0, n0 = to_utm.transform(w, s)
    e1, n1 = to_utm.transform(e, n)
    walls = []
    for ek in range(int(e0 // 1000) - 1, int(e1 // 1000) + 2):
        for nk in range(int(n0 // 1000) - 1, int(n1 // 1000) + 2):
            path = os.path.join(gml_dir, f'LoD2_32_{ek}_{nk}_1_ni.gml')
            if not os.path.exists(path):
                continue
            for _, bel in etree.iterparse(path, tag=B + 'Building'):
                if bel.getparent().tag != '{%s}cityObjectMember' % NS['core']:
                    continue
                polys, grounds, _ = surfaces(bel)
                ground = min(g[:, 2].min() for g in grounds) if grounds else None
                bid = bel.get('{http://www.opengis.net/gml}id')
                for kind, ring, _ in polys:
                    if kind == 0 and ground is not None:
                        walls.append((bid, ring[:-1] if np.allclose(ring[0], ring[-1]) else ring, ground))
                bel.clear()
    print(len(walls), 'Wände geladen', flush=True)
    return walls


def wall_core(ring, ground):
    """Mittlerer Teil einer Wand als Viereck: seitlich 20 % Rand, Höhe 1,8 m bis 9 m über Grund."""
    xy = ring[:, :2]
    D = np.linalg.norm(xy[:, None] - xy[None], axis=2)
    i0, i1 = np.unravel_index(int(D.argmax()), D.shape)
    a, b = xy[i0], xy[i1]
    if np.linalg.norm(b - a) < 3.0:
        return None
    # Traufhöhe = niedrigere der beiden Wandkanten (Giebeldreiecke bleiben außen vor)
    za = ring[np.linalg.norm(xy - a, axis=1) < 0.5, 2].max()
    zb = ring[np.linalg.norm(xy - b, axis=1) < 0.5, 2].max()
    top = min(za, zb, ground + 9.0)
    lo = ground + 1.8
    if top - lo < 1.2:
        return None
    p0, p1 = a + (b - a) * 0.2, a + (b - a) * 0.8
    return np.array([[*p0, lo], [*p1, lo], [*p1, top], [*p0, top]])


def analyse(images, walls, dem, work):
    grid = defaultdict(list)
    for wi, (_, ring, _) in enumerate(walls):
        c = ring[:, :2].mean(0)
        grid[(int(c[0] // 50), int(c[1] // 50))].append(wi)
    samples = defaultdict(list)  # Gebäude -> [(Median-Farbe, Pixelzahl)]
    cache = os.path.join(work, 'img')
    os.makedirs(cache, exist_ok=True)
    for n_im, im in enumerate(images):
        lon0, lat0 = im['computed_geometry']['coordinates']
        E0, N0 = to_utm.transform(lon0, lat0)
        cam = np.array([E0, N0, dem.at(E0, N0) + CAM_HEIGHT])
        R = rotation(im['computed_rotation'])
        f = im['camera_parameters'][0]
        near = [wi for gx in range(int(E0 // 50) - 2, int(E0 // 50) + 3) for gy in range(int(N0 // 50) - 2, int(N0 // 50) + 3)
                for wi in grid.get((gx, gy), [])]
        cand = []
        for wi in near:
            bid, ring, ground = walls[wi]
            core = wall_core(ring, ground)
            if core is None:
                continue
            c = core.mean(0)
            dist = np.linalg.norm(c[:2] - cam[:2])
            if not (5 < dist < MAX_DIST):
                continue
            # Wand muss zur Kamera zeigen
            nrm = np.array([-(core[1, 1] - core[0, 1]), core[1, 0] - core[0, 0]])
            if abs(np.dot(nrm / np.linalg.norm(nrm), (cam[:2] - c[:2]) / dist)) < 0.35:
                continue
            cand.append((dist, bid, ring, core))
        if not cand:
            continue
        W, H = RES
        S = max(W, H)

        def proj(p):
            q = (R @ (p - cam).T).T
            if (q[:, 2] < 1.0).any():
                return None
            return [(W / 2 + f * S * x / z, H / 2 + f * S * y / z) for x, y, z in q]

        # Sichtbarkeit: weit -> nah zeichnen, ganze Wände als Verdecker
        idbuf = Image.new('I', (W, H), 0)
        draw = ImageDraw.Draw(idbuf)
        drawn = {}
        for k, (dist, bid, ring, core) in enumerate(sorted(cand, key=lambda t: -t[0])):
            full = proj(ring)
            if full:
                draw.polygon(full, fill=0)
            pc = proj(core)
            if pc:
                draw.polygon(pc, fill=k + 1)
                drawn[k + 1] = bid
        ids = np.array(idbuf)
        if not drawn or (ids > 0).sum() < 200:
            continue
        path = os.path.join(cache, im['id'] + '.jpg')
        if not os.path.exists(path):
            try:
                open(path, 'wb').write(get(im['thumb_1024_url'], binary=True))
            except Exception:
                continue
        try:
            photo = np.array(Image.open(path).convert('RGB').resize((W, H), Image.BILINEAR)).astype(int)
        except Exception:
            continue
        r, g, b = photo[..., 0], photo[..., 1], photo[..., 2]
        mx, mn = photo.max(2), photo.min(2)
        good = (mx > 45) & (mx < 245) & ~((g > r + 6) & (g > b)) & ~((b > r + 12) & (mx > 120))
        for k, bid in drawn.items():
            m = (ids == k) & good
            if m.sum() < 150:     # zu kleine oder stark verdeckte Wandflächen auslassen
                continue
            px = photo[m].astype(float)
            lum = px.mean(1)
            lo, hi = np.percentile(lum, [35, 95])
            px = px[(lum >= lo) & (lum <= hi)]          # Fenster, Schatten und Spitzlichter raus
            if len(px) < 30:
                continue
            red = (px[:, 0] - px[:, 2]) / (px.sum(1) + 1)
            brick = red > 0.07                            # Klinker bleibt auch im Schatten rötlich
            med_b = np.median(px[brick], 0) if brick.sum() >= 10 else None
            med_l = np.median(px[~brick], 0) if (~brick).sum() >= 10 else None
            samples[bid].append((float(brick.mean()), med_b, med_l, len(px)))
        if n_im % 25 == 0:
            print(f'[{n_im + 1}/{len(images)}] Gebäude mit Messungen: {len(samples)}', flush=True)
    return samples


def wmedian(cols, weights):
    cols, weights = np.array(cols), np.array(weights, dtype=float)
    out = []
    for ch in range(3):
        o = np.argsort(cols[:, ch])
        cw = np.cumsum(weights[o])
        out.append(cols[o, ch][np.searchsorted(cw, cw[-1] / 2)])
    return out


def normalize(rgb, material):
    """Farbton und Sättigung aus dem Foto, Helligkeit auf typische Werte des Materials (Belichtungsausgleich)."""
    h, s, v = colorsys.rgb_to_hsv(*[x / 255 for x in rgb])
    if material == 'klinker':
        s = min(max(s, 0.35), 0.72)
        v = min(max(v * 1.6, 0.36), 0.62)
    else:
        if 0.5 < h < 0.72:          # bläulicher Schattenstich bei hellem Putz
            s *= 0.3
        s = min(s, 0.28)
        v = min(max(v * 1.8, 0.62), 0.93)
    return [round(x * 255) for x in colorsys.hsv_to_rgb(h, s, v)]


def main():
    gml, dem_path, work, out = sys.argv[1:5]
    bbox = [float(x) for x in sys.argv[5].split(',')] if len(sys.argv) > 5 else [9.770, 53.105, 9.810, 53.131]
    os.makedirs(work, exist_ok=True)
    images = find_images(bbox, work)
    print(len(images), 'Bilder nach Ausdünnung', flush=True)
    walls = load_walls(gml, bbox)
    import pickle
    cache = os.path.join(work, f'samples_{MAX_DIST}.pkl')
    if os.path.exists(cache):
        samples = pickle.load(open(cache, 'rb'))
    else:
        samples = analyse(images, walls, Dem(dem_path), work)
        pickle.dump(dict(samples), open(cache, 'wb'))
    result = {}
    for bid, ss in samples.items():
        px = sum(s[3] for s in ss)
        if len(ss) < MIN_IMAGES:
            continue
        # jedes Foto stimmt ab; nur eindeutige Gebäude übernehmen
        votes = [s[0] > 0.45 for s in ss]
        share = sum(votes) / len(votes)
        if MIN_AGREE > share > 1 - MIN_AGREE:
            continue
        material = 'klinker' if share >= MIN_AGREE else 'putz'
        pick = [(s[1], s[3]) for s in ss if s[1] is not None] if material == 'klinker' else [(s[2], s[3]) for s in ss if s[2] is not None]
        if not pick:
            continue
        rgb = normalize(wmedian([c for c, _ in pick], [w for _, w in pick]), material)
        result[bid] = ['#%02x%02x%02x' % tuple(rgb), material, len(ss)]
    json.dump({'quelle': 'Gemessen in Straßenfotos von Mapillary-Mitwirkenden (CC BY-SA 4.0), tools/facades_mapillary.py',
               'lizenz': 'CC BY-SA 4.0', 'gebaeude': result}, open(out, 'w'), separators=(',', ':'))
    print(len(result), 'Gebäude mit Fassadenfarbe ->', out)


if __name__ == '__main__':
    main()
