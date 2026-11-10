#!/usr/bin/env python3
"""LoD2-Gebäudemodelle des LGLN (CityGML) in kompakte Binärkacheln für den Browser umwandeln.

Aufruf:
    python3 tools/build_lod2.py <ordner-mit-gml> data/lod2 [<dem.npz> [<ordner-mit-luftbildern>]]

Mit dem Höhenraster aus tools/build_dem.py bekommt jedes Gebäude seine Geländehöhe
(aus demselben Raster wie die Geländekacheln, damit Gebäude und Gelände zusammenpassen).

Quelle: LGLN, 3D-Gebäudemodelle LoD2, https://opengeodata.lgln.niedersachsen.de (CC BY 4.0)
Kacheln: https://lod2.opengeodata.lgln.niedersachsen.de/LoD2_32_<E>_<N>_1_ni.gml

Ausgabe je 1-km-Kachel:
  <E>_<N>.bin   Geometrie (Format siehe write_tile)
  <E>_<N>.json  Gebäudeliste (Adresse, Funktion, Dachform, Höhe)
  <E>_<N>.jpg   Dachtexturen aus dem Luftbild (Atlas), falls Luftbilder angegeben sind
und index.json mit allen Kacheln.

Koordinaten: lokale Meter relativ zu ORIGIN in Web-Mercator-Ausrichtung
(x nach Osten, y nach Norden, z nach oben, Höhe über Gebäudegrund).
"""
import glob
import json
import math
import os
import re
import struct
import sys
import zlib

import mapbox_earcut as earcut
import numpy as np
from lxml import etree
from pyproj import Transformer

ORIGIN = (9.79, 53.118)  # lon, lat – muss mit js/buildings.js übereinstimmen
QUANT = 0.02             # 2 cm je Einheit (Int16)
R = 6371008.8

NS = {
    'bldg': 'http://www.opengis.net/citygml/building/1.0',
    'gml': 'http://www.opengis.net/gml',
    'gen': 'http://www.opengis.net/citygml/generics/1.0',
    'core': 'http://www.opengis.net/citygml/1.0',
    'xal': 'urn:oasis:names:tc:ciq:xsdschema:xAL:2.0',
}
B = '{%s}' % NS['bldg']
G = '{%s}' % NS['gml']

to_wgs = Transformer.from_crs(25832, 4326, always_xy=True)


def merc(lon, lat):
    x = (lon + 180.0) / 360.0
    y = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / math.pi) / 2
    return x, y


MX0, MY0 = merc(np.array([ORIGIN[0]]), np.array([ORIGIN[1]]))
MX0, MY0 = float(MX0[0]), float(MY0[0])
METER = 1 / (2 * math.pi * R * math.cos(math.radians(ORIGIN[1])))  # Mercator-Einheiten je Meter


def to_local(xyz):
    """UTM32 (E, N, H) -> lokale Meter (x Ost, y Nord, z unverändert)."""
    lon, lat = to_wgs.transform(xyz[:, 0], xyz[:, 1])
    mx, my = merc(np.asarray(lon), np.asarray(lat))
    out = np.empty_like(xyz)
    out[:, 0] = (mx - MX0) / METER
    out[:, 1] = -(my - MY0) / METER
    out[:, 2] = xyz[:, 2]
    return out


# ALKIS-Gebäudefunktionen (Auswahl); sonst Gruppe nach Tausenderstelle
FUNCTIONS = {
    '31001_1000': 'Wohngebäude', '31001_1010': 'Wohnhaus', '31001_1020': 'Wohnheim',
    '31001_2463': 'Garage', '31001_3041': 'Kirche', '51009_1610': 'Überdachung',
}
GROUPS = {'1': 'Wohngebäude', '2': 'Gebäude für Wirtschaft oder Gewerbe', '3': 'Gebäude für öffentliche Zwecke'}
ROOFS = {
    'PolyFlatRoof': 'Flachdach', 'FlatRoof': 'Flachdach', 'GableRoof': 'Satteldach', 'HipRoof': 'Walmdach',
    'HipAndGableRoof': 'Krüppelwalmdach', 'HippedGableRoof': 'Krüppelwalmdach', 'GableAndHippedGRoof': 'Krüppelwalmdach',
    'LeanToRoof': 'Pultdach', 'PyramidRoof': 'Pyramidendach', 'TentRoof': 'Zeltdach', 'CutHipRoof': 'Walmdach',
    'CutGableRoof': 'Satteldach', 'GambrelRoof': 'Mansarddach', 'MansardRoof': 'Mansarddach',
}


def function_name(code):
    if not code:
        return 'Gebäude'
    if code in FUNCTIONS:
        return FUNCTIONS[code]
    if code.startswith('31001_'):
        return GROUPS.get(code[6], 'Gebäude')
    return 'Bauwerk'


def poslist(el):
    vals = np.array(el.text.split(), dtype=np.float64)
    return vals.reshape(-1, 3)


def triangulate(ring):
    """Ebenes 3D-Polygon (n x 3, geschlossen) -> Dreiecksindizes, Normale."""
    if np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    if len(ring) < 3:
        return None, None, ring
    # Newell-Normale
    n = np.zeros(3)
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    ln = np.linalg.norm(n)
    if ln < 1e-9:
        return None, None, ring
    n /= ln
    ax = int(np.argmax(np.abs(n)))
    keep = [i for i in range(3) if i != ax]
    pts2 = ring[:, keep].astype(np.float64)
    if len(ring) == 3:
        idx = np.array([0, 1, 2], dtype=np.uint32)
    else:
        idx = earcut.triangulate_float64(pts2, np.array([len(ring)], dtype=np.uint32))
    if len(idx) == 0:
        return None, None, ring
    # Dreiecke so ausrichten, dass sie zur Newell-Normale passen
    t = ring[idx.reshape(-1, 3)]
    fn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    flip = (fn @ n) < 0
    tri = idx.reshape(-1, 3).copy()
    tri[flip] = tri[flip][:, [0, 2, 1]]
    return tri, n, ring


def attr(bel, name):
    for sa in bel.iter('{%s}stringAttribute' % NS['gen']):
        if sa.get('name') == name:
            v = sa.find('gen:value', NS)
            return v.text if v is not None else None
    return None


def building_record(bel):
    street = bel.findtext('.//xal:ThoroughfareName', namespaces=NS)
    num = bel.findtext('.//xal:ThoroughfareNumber', namespaces=NS)
    func = bel.findtext('bldg:function', namespaces=NS)
    roof = attr(bel, 'DachtypName')
    h = bel.findtext('bldg:measuredHeight', namespaces=NS)
    if street:
        street = re.sub(r'\s*\([^)]*\)', '', street).strip()  # "Großenweder Weg (Schneverd.)"
    return {
        'id': bel.get(G + 'id'),
        'a': ' '.join(x for x in [street, num] if x) or None,
        'f': function_name(func),
        'fc': func,
        'r': ROOFS.get(roof, roof),
        'h': round(float(h), 1) if h else None,
    }


def surfaces(bel):
    """Alle Wand- und Dachflächen eines Gebäudes inkl. Gebäudeteile."""
    out = []
    for kind, tag in ((0, 'WallSurface'), (1, 'RoofSurface')):
        for s in bel.iter(B + tag):
            for pl in s.iter(G + 'posList'):
                # nur Außenringe (die LGLN-Daten haben keine Innenringe)
                if pl.getparent().getparent().tag == G + 'exterior':
                    out.append((kind, poslist(pl)))
    grounds = [poslist(pl) for s in bel.iter(B + 'GroundSurface') for pl in s.iter(G + 'posList')]
    return out, grounds


def footprint_area(grounds):
    a = 0.0
    for g in grounds:
        x, y = g[:, 0], g[:, 1]
        a += abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2
    return a


# Fassadenklassen (info[2]) – gleiche Nummern wie im Shader (js/buildings.js)
F_HOUSE, F_SHED, F_HALL, F_FARM, F_CHURCH, F_HEIDEHOF = 0, 1, 2, 3, 4, 5


def facade_class(rec, height, area, roof):
    fc = rec['fc'] or ''
    flat = roof == 'Flachdach'
    if fc.startswith('51') or fc == '31001_2463' or height < 3.6:
        return F_SHED                                    # Überdachung, Garage, Schuppen
    if fc.startswith('31001_304'):
        return F_CHURCH                                  # Kirche, Kapelle
    if fc == '31001_1210':
        return F_HEIDEHOF                                # Wohnhaus eines Hofes
    if fc.startswith('31001_27'):
        return F_FARM                                    # Stall, Scheune, Betriebsgebäude
    if fc.startswith('31001_2') and (area > 450 or (flat and area > 250)):
        return F_HALL                                    # Gewerbe-, Lager-, Markthalle
    if fc == '31001_2000' and area < 70:
        return F_SHED                                    # Nebengebäude ohne eigene Funktion
    return F_HOUSE


class Dem:
    def __init__(self, path):
        d = np.load(path)
        self.z, self.e0, self.n1, self.res = d['z'], float(d['e0']), float(d['n1']), float(d['res'])

    def at(self, e, n):
        c = (e - self.e0) / self.res - 0.5
        r = (self.n1 - n) / self.res - 0.5
        c0, r0 = int(np.floor(c)), int(np.floor(r))
        fc, fr = c - c0, r - r0
        z = self.z
        c0 = min(max(c0, 0), z.shape[1] - 2)
        r0 = min(max(r0, 0), z.shape[0] - 2)
        return float((z[r0, c0] * (1 - fc) + z[r0, c0 + 1] * fc) * (1 - fr)
                     + (z[r0 + 1, c0] * (1 - fc) + z[r0 + 1, c0 + 1] * fc) * fr)


SKIRT = 4.0  # Wände so weit unter den Boden ziehen, dass an Hängen keine Lücken entstehen


def build_tile(path, dem=None):
    verts, norms, info, us, bids, tris, bases, utms = [], [], [], [], [], [], [], []
    roof_boxes = {}  # bid -> [Emin, Nmin, Emax, Nmax] der Dachflächen
    records = []
    nverts = 0
    for _, bel in etree.iterparse(path, tag=B + 'Building'):
        if bel.getparent().tag != '{%s}cityObjectMember' % NS['core']:
            continue  # Gebäudeteile werden über das Gebäude erfasst
        polys, grounds = surfaces(bel)
        if not polys:
            bel.clear()
            continue
        allz = np.concatenate([p[:, 2] for _, p in polys])
        ground = min(g[:, 2].min() for g in grounds) if grounds else allz.min()
        top = allz.max()
        rec = building_record(bel)
        if grounds:
            gc = np.concatenate(grounds)
            ge, gn = float(gc[:, 0].mean()), float(gc[:, 1].mean())
        else:
            ge, gn = float(polys[0][1][:, 0].mean()), float(polys[0][1][:, 1].mean())
        base = dem.at(ge, gn) if dem else 0.0
        rec['z'] = round(float(ground), 1)  # Bodenhöhe m NHN laut LoD2
        if rec['h'] is None:
            rec['h'] = round(float(top - ground), 1)
        bid = len(records)
        records.append(rec)
        cls = facade_class(rec, top - ground, footprint_area(grounds), rec['r'])
        seed = zlib.crc32(rec['id'].encode()) & 0xFF
        for kind, ring in polys:
            loc = to_local(ring)
            loc[:, 2] -= ground
            tri, n, ring2 = triangulate(loc)
            if tri is None:
                continue
            utm = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
            if kind == 1:
                b = roof_boxes.setdefault(bid, [np.inf, np.inf, -np.inf, -np.inf])
                b[0] = min(b[0], utm[:, 0].min()); b[1] = min(b[1], utm[:, 1].min())
                b[2] = max(b[2], utm[:, 0].max()); b[3] = max(b[3], utm[:, 1].max())
            if kind == 0:
                ring2 = ring2.copy()
                ring2[ring2[:, 2] < 0.05, 2] = -SKIRT
            # Fassadenkoordinate u: Abstand entlang der Wand (horizontal)
            if kind == 0:
                d = np.array([-n[1], n[0]])
                dl = np.linalg.norm(d)
                d = d / dl if dl > 1e-6 else np.array([1.0, 0.0])
                u = (ring2[:, :2] - ring2[0, :2]) @ d
                u -= u.min()
            else:
                u = np.zeros(len(ring2))
            verts.append(ring2)
            norms.append(np.repeat(n[None, :], len(ring2), axis=0))
            flags = cls
            info.append(np.repeat(np.array([[kind, seed, flags, 0]], dtype=np.uint8), len(ring2), axis=0))
            us.append(u)
            bids.append(np.full(len(ring2), bid, dtype=np.uint16))
            bases.append(np.full(len(ring2), round(base * 10), dtype=np.int16))
            utms.append(utm[:, :2])
            tris.append(tri + nverts)
            nverts += len(ring2)
        bel.clear()
        while bel.getprevious() is not None:
            del bel.getparent()[0]
    if not verts:
        return None, records
    V = np.concatenate(verts)
    return {
        'pos': V, 'nrm': np.concatenate(norms), 'info': np.concatenate(info),
        'u': np.concatenate(us), 'bid': np.concatenate(bids), 'idx': np.concatenate(tris).astype(np.uint32),
        'base': np.concatenate(bases), 'utm': np.concatenate(utms), 'roof_boxes': roof_boxes,
    }, records


DOP_RES = 0.25    # Luftbild: Meter je Pixel (tools/fetch_dop.py)
DOP_MARGIN = 30   # Rand der Luftbildkacheln in Metern
ATLAS_MAX = 2048 * 2048  # höchstens so viele Pixel je Atlas


def make_atlas(geo, key, dop_dir, out_jpg):
    """Dächer aus dem Luftbild ausschneiden, in einen Atlas packen, UV je Dachecke setzen."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    e_km, n_km = map(int, key.split('_'))
    E0, N1 = e_km * 1000 - DOP_MARGIN, n_km * 1000 + 1000 + DOP_MARGIN
    dop = Image.open(os.path.join(dop_dir, key + '.jpg')).convert('RGB')
    boxes = geo['roof_boxes']
    if not boxes:
        return None
    pad = 2
    rects = {}
    for bid, (e0, n0, e1, n1) in boxes.items():
        x0 = int(np.floor((e0 - E0) / DOP_RES)) - pad
        y0 = int(np.floor((N1 - n1) / DOP_RES)) - pad
        x1 = int(np.ceil((e1 - E0) / DOP_RES)) + pad
        y1 = int(np.ceil((N1 - n0) / DOP_RES)) + pad
        rects[bid] = (x0, y0, x1, y1)
    total = sum((r[2] - r[0]) * (r[3] - r[1]) for r in rects.values())
    scale = max(1.0, math.sqrt(total * 1.25 / ATLAS_MAX))  # >1: Atlas verkleinern
    W = 2048
    while W > 256 and W * W / 2 > total * 1.4 / scale ** 2:
        W //= 2
    # Regalpacken: nach Höhe sortiert in Zeilen
    order = sorted(rects, key=lambda b: -(rects[b][3] - rects[b][1]))
    place = {}
    x = y = row_h = 0
    for bid in order:
        x0, y0, x1, y1 = rects[bid]
        w = max(1, math.ceil((x1 - x0) / scale))
        h = max(1, math.ceil((y1 - y0) / scale))
        if w > W:
            w = W
        if x + w > W:
            x, y, row_h = 0, y + row_h, 0
        place[bid] = (x, y, w, h)
        x += w
        row_h = max(row_h, h)
    H = y + row_h
    H = (H + 3) // 4 * 4
    atlas = Image.new('RGB', (W, H), (120, 110, 100))
    for bid, (ax, ay, w, h) in place.items():
        x0, y0, x1, y1 = rects[bid]
        crop = dop.crop((x0, y0, x1, y1))
        if crop.size != (w, h):
            crop = crop.resize((w, h), Image.LANCZOS)
        atlas.paste(crop, (ax, ay))
    atlas.save(out_jpg, quality=82, optimize=True, progressive=True)
    # UV je Dachecke (Wände bleiben 0)
    uv = np.zeros((len(geo['pos']), 2), dtype=np.uint16)
    roof = geo['info'][:, 0] == 1
    bids = geo['bid']
    for bid, (ax, ay, w, h) in place.items():
        m = roof & (bids == bid)
        if not m.any():
            continue
        x0, y0, x1, y1 = rects[bid]
        px = ((geo['utm'][m, 0] - E0) / DOP_RES - x0) * (w / (x1 - x0))
        py = ((N1 - geo['utm'][m, 1]) / DOP_RES - y0) * (h / (y1 - y0))
        uv[m, 0] = np.clip(np.round((ax + px) / W * 65535), 0, 65535)
        uv[m, 1] = np.clip(np.round((ay + py) / H * 65535), 0, 65535)
    geo['info'][roof, 3] = 1  # Dach hat Textur
    geo['uv'] = uv
    return W, H, scale


def write_tile(geo, out_bin):
    """Binärformat (little endian):
    Kopf: 'SV3D', uint32 nVerts, uint32 nIdx, float32 cx, cy (Kachelmitte, lokale Meter), float32 quant
    Daten: int16[3n] pos (z über Gebäudegrund), int8[4n] normal, uint8[4n] info, int16[n] u (dm),
          uint16[n] bid, int16[n] Geländehöhe (dm NHN), uint16[2n] Dach-UV (0..65535, Atlas),
          [Auffüllung auf 4 Byte, nur bei uint32], uint16|uint32[nIdx] idx
    """
    V = geo['pos']
    c = np.round((V[:, :2].min(0) + V[:, :2].max(0)) / 2)
    q = np.round((V - [c[0], c[1], 0]) / QUANT)
    assert np.abs(q).max() < 32767, 'Kachel zu groß für Int16'
    n = len(V)
    nrm = np.zeros((n, 4), dtype=np.int8)
    nrm[:, :3] = np.round(geo['nrm'] * 127)
    u = np.clip(np.round(geo['u'] * 10), -32767, 32767).astype(np.int16)
    idx = geo['idx'].ravel()
    big = n > 65535
    with open(out_bin, 'wb') as f:
        f.write(b'SV3D')
        f.write(struct.pack('<IIfff', n, len(idx), float(c[0]), float(c[1]), QUANT))
        f.write(q.astype(np.int16).tobytes())
        f.write(nrm.tobytes())
        f.write(geo['info'].tobytes())
        f.write(u.tobytes())
        f.write(geo['bid'].tobytes())
        f.write(geo['base'].tobytes())
        f.write(geo.get('uv', np.zeros((n, 2), dtype=np.uint16)).tobytes())
        if big:
            f.write(b'\0' * ((-f.tell()) % 4))  # Uint32-Indizes auf 4 Byte ausrichten
        f.write(idx.astype(np.uint32 if big else np.uint16).tobytes())
        # auf 4 Byte auffüllen
        f.write(b'\0' * ((-f.tell()) % 4))
    return c


def main():
    src, dst = sys.argv[1], sys.argv[2]
    dem = Dem(sys.argv[3]) if len(sys.argv) > 3 else None
    dop_dir = sys.argv[4] if len(sys.argv) > 4 else None
    os.makedirs(dst, exist_ok=True)
    index = []
    files = sorted(glob.glob(os.path.join(src, 'LoD2_32_*_1_ni.gml')))
    for i, path in enumerate(files):
        name = os.path.basename(path)
        e, n = name.split('_')[2:4]
        key = f'{e}_{n}'
        geo, records = build_tile(path, dem)
        if geo is None:
            continue
        atlas = None
        if dop_dir and os.path.exists(os.path.join(dop_dir, key + '.jpg')):
            atlas = make_atlas(geo, key, dop_dir, os.path.join(dst, key + '.jpg'))
        c = write_tile(geo, os.path.join(dst, key + '.bin'))
        with open(os.path.join(dst, key + '.json'), 'w') as f:
            json.dump(records, f, ensure_ascii=False, separators=(',', ':'))
        V = geo['pos']
        index.append({
            'k': key, 'n': len(records), 'v': len(V),
            'b': [round(float(x), 1) for x in [V[:, 0].min(), V[:, 1].min(), V[:, 0].max(), V[:, 1].max()]],
            'kb': round(os.path.getsize(os.path.join(dst, key + '.bin')) / 1024),
        })
        if atlas:
            index[-1]['tex'] = 1
            index[-1]['tkb'] = round(os.path.getsize(os.path.join(dst, key + '.jpg')) / 1024)
        print(f'[{i + 1}/{len(files)}] {key}: {len(records)} Gebäude, {len(V)} Punkte', flush=True)
    with open(os.path.join(dst, 'index.json'), 'w') as f:
        json.dump({'origin': ORIGIN, 'quant': QUANT, 'tiles': index,
                   'source': 'LGLN, 3D-Gebäudemodelle LoD2 und DOP20 (CC BY 4.0)'}, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
