#!/usr/bin/env python3
"""Geschäfte und Straßen aus den OpenFreeMap-Vektorkacheln (OpenStreetMap) für ein Gebiet sammeln.

Aufruf:
    python3 tools/osm_context.py <ausgabe.json> [W,S,E,N]

Ergebnis: {"pois": [[lon, lat, klasse, unterklasse, name], …], "roads": [[klasse, [[lon, lat], …]], …]}
Wird von tools/build_lod2.py genutzt, um Ladenfronten an die Straßenseite der Geschäftshäuser zu setzen.
Daten: © OpenStreetMap-Mitwirkende (ODbL).
"""
import json
import math
import subprocess
import sys

import mapbox_vector_tile as mvt

Z = 14
ROAD_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path'}


def tile_xy(lon, lat):
    n = 2 ** Z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def to_lonlat(x, y, gx, gy, ext):
    n = 2 ** Z
    lon = (x + gx / ext) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1 - gy / ext) / n))))
    return [round(lon, 7), round(lat, 7)]


def lines(geom):
    if geom['type'] == 'LineString':
        return [geom['coordinates']]
    if geom['type'] == 'MultiLineString':
        return geom['coordinates']
    return []


def main():
    out = sys.argv[1]
    w, s, e, n = [float(v) for v in sys.argv[2].split(',')] if len(sys.argv) > 2 else (9.60, 53.02, 9.96, 53.23)
    tmpl = json.loads(subprocess.run(['curl', '-s', '-m', '30', 'https://tiles.openfreemap.org/planet'],
                                     capture_output=True, text=True).stdout)['tiles'][0]
    x0, y0 = tile_xy(w, n)
    x1, y1 = tile_xy(e, s)
    pois, roads, seen = [], [], set()
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            data = subprocess.run(['curl', '-s', '-m', '60', '--compressed', '--retry', '3', tmpl.format(z=Z, x=x, y=y)],
                                  capture_output=True).stdout
            try:
                t = mvt.decode(data)
            except Exception:
                print('Kachel fehlt', x, y)
                continue
            if 'poi' in t:
                ext = t['poi']['extent']
                for f in t['poi']['features']:
                    if f['geometry']['type'] != 'Point':
                        continue
                    p = f['properties']
                    ll = to_lonlat(x, y, *f['geometry']['coordinates'], ext)
                    key = (p.get('name'), round(ll[0], 5), round(ll[1], 5))
                    if key in seen:
                        continue
                    seen.add(key)
                    pois.append([*ll, p.get('class'), p.get('subclass'), p.get('name')])
            if 'transportation' in t:
                ext = t['transportation']['extent']
                for f in t['transportation']['features']:
                    cls = f['properties'].get('class')
                    if cls not in ROAD_CLASSES:
                        continue
                    if cls == 'path' and f['properties'].get('subclass') not in ('pedestrian', 'footway'):
                        continue
                    for line in lines(f['geometry']):
                        roads.append([cls, [to_lonlat(x, y, gx, gy, ext) for gx, gy in line]])
    json.dump({'pois': pois, 'roads': roads}, open(out, 'w'), separators=(',', ':'))
    print(len(pois), 'POIs,', len(roads), 'Straßenstücke ->', out)


if __name__ == '__main__':
    main()
