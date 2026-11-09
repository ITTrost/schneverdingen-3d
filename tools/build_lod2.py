#!/usr/bin/env python3
"""LoD2-Gebäudemodelle des LGLN (CityGML) in kompakte Binärkacheln für den Browser umwandeln.

Aufruf:
    python3 tools/build_lod2.py <ordner-mit-gml> data/lod2

Quelle: LGLN, 3D-Gebäudemodelle LoD2, https://opengeodata.lgln.niedersachsen.de (CC BY 4.0)
Kacheln: https://lod2.opengeodata.lgln.niedersachsen.de/LoD2_32_<E>_<N>_1_ni.gml

Ausgabe je 1-km-Kachel:
  <E>_<N>.bin   Geometrie (Format siehe write_tile)
  <E>_<N>.json  Gebäudeliste (Adresse, Funktion, Dachform, Höhe)
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


def build_tile(path):
    verts, norms, info, us, bids, tris = [], [], [], [], [], []
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
        if rec['h'] is None:
            rec['h'] = round(float(top - ground), 1)
        bid = len(records)
        records.append(rec)
        small = (top - ground) < 3.6 or (rec['fc'] or '').startswith('51009') or rec['fc'] == '31001_2463'
        seed = zlib.crc32(rec['id'].encode()) & 0xFF
        for kind, ring in polys:
            loc = to_local(ring)
            loc[:, 2] -= ground
            tri, n, ring2 = triangulate(loc)
            if tri is None:
                continue
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
            flags = (1 if small else 0)
            info.append(np.repeat(np.array([[kind, seed, flags, 0]], dtype=np.uint8), len(ring2), axis=0))
            us.append(u)
            bids.append(np.full(len(ring2), bid, dtype=np.uint16))
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
    }, records


def write_tile(geo, out_bin):
    """Binärformat (little endian):
    Kopf: 'SV3D', uint32 nVerts, uint32 nIdx, float32 cx, cy (Kachelmitte, lokale Meter), float32 quant
    Daten: int16[3n] pos, int8[4n] normal, uint8[4n] info, int16[n] u (dm), uint16[n] bid,
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
        if big:
            f.write(b'\0' * ((-f.tell()) % 4))  # Uint32-Indizes auf 4 Byte ausrichten
        f.write(idx.astype(np.uint32 if big else np.uint16).tobytes())
        # auf 4 Byte auffüllen
        f.write(b'\0' * ((-f.tell()) % 4))
    return c


def main():
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    index = []
    files = sorted(glob.glob(os.path.join(src, 'LoD2_32_*_1_ni.gml')))
    for i, path in enumerate(files):
        name = os.path.basename(path)
        e, n = name.split('_')[2:4]
        key = f'{e}_{n}'
        geo, records = build_tile(path)
        if geo is None:
            continue
        c = write_tile(geo, os.path.join(dst, key + '.bin'))
        with open(os.path.join(dst, key + '.json'), 'w') as f:
            json.dump(records, f, ensure_ascii=False, separators=(',', ':'))
        V = geo['pos']
        index.append({
            'k': key, 'n': len(records), 'v': len(V),
            'b': [round(float(x), 1) for x in [V[:, 0].min(), V[:, 1].min(), V[:, 0].max(), V[:, 1].max()]],
            'kb': round(os.path.getsize(os.path.join(dst, key + '.bin')) / 1024),
        })
        print(f'[{i + 1}/{len(files)}] {key}: {len(records)} Gebäude, {len(V)} Punkte', flush=True)
    with open(os.path.join(dst, 'index.json'), 'w') as f:
        json.dump({'origin': ORIGIN, 'quant': QUANT, 'tiles': index,
                   'source': 'LGLN, 3D-Gebäudemodelle LoD2 (CC BY 4.0)'}, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
