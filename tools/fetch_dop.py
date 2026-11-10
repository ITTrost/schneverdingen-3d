#!/usr/bin/env python3
"""Luftbilder (DOP20 des LGLN) für die Gebäudekacheln laden.

Aufruf:
    python3 tools/fetch_dop.py <ordner-mit-gml> <zielordner>

Je 1-km-Kachel ein JPEG mit 25 cm Auflösung und 30 m Rand (für Gebäude, die über die
Kachelgrenze ragen): <zielordner>/<E>_<N>.jpg. Vorhandene Dateien werden übersprungen.

Quelle: LGLN, DOP20 (CC BY 4.0), https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms
"""
import concurrent.futures as cf
import glob
import os
import subprocess
import sys

WMS = ('https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms?SERVICE=WMS&VERSION=1.3.0'
       '&REQUEST=GetMap&LAYERS=ni_dop20&STYLES=&CRS=EPSG:25832&BBOX={b}&WIDTH={w}&HEIGHT={w}&FORMAT=image/jpeg')
RES = 0.25
MARGIN = 30


def bbox(e_km, n_km):
    e, n = e_km * 1000 - MARGIN, n_km * 1000 - MARGIN
    return e, n, e + 1000 + 2 * MARGIN, n + 1000 + 2 * MARGIN


def fetch(key, out):
    path = os.path.join(out, key + '.jpg')
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return key, 'vorhanden'
    e, n = map(int, key.split('_'))
    b = bbox(e, n)
    w = round((b[2] - b[0]) / RES)
    url = WMS.format(b=','.join(f'{v:.0f}' for v in b), w=w)
    tmp = path + '.part'
    r = subprocess.run(['curl', '-s', '-m', '600', '--retry', '4', '-o', tmp, '-w', '%{http_code} %{content_type}', url],
                       capture_output=True, text=True)
    if not r.stdout.startswith('200 image/jpeg'):
        return key, 'Fehler ' + r.stdout
    os.replace(tmp, path)
    return key, 'ok'


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    keys = ['_'.join(os.path.basename(f).split('_')[2:4]) for f in sorted(glob.glob(os.path.join(src, 'LoD2_32_*_1_ni.gml')))]
    with cf.ThreadPoolExecutor(3) as ex:
        for i, (key, status) in enumerate(ex.map(lambda k: fetch(k, out), keys)):
            print(f'[{i + 1}/{len(keys)}] {key}: {status}', flush=True)


if __name__ == '__main__':
    main()
