#!/usr/bin/env python3
"""Geländemodell für Schneverdingen aus dem DGM1-WMS des LGLN bauen.

Aufruf:
    python3 tools/build_dem.py <arbeitsordner> data/dem

Der WMS liefert das DGM1 nur als Graustufenbild (8 Bit, absolut, aber nicht linear skaliert).
Die Umrechnung Grauwert -> Höhe ist an den Bodenhöhen von 32.954 LoD2-Gebäudeteilen kalibriert
(Median je Grauwert, Restabweichung 0,7 m), außerhalb der Tabelle linear fortgesetzt.
Ein Grauwert entspricht je nach Höhe einer Stufe von 1,2 bis 4 m. Die Grenzen zwischen den Stufen sind
Höhenlinien; dazwischen wird über die Abstände zur nächsten tieferen und höheren Stufe
interpoliert. So entsteht ein glattes Gelände ohne Terrassen.

Ausgabe:
  data/dem/{z}/{x}/{y}.png  Terrain-RGB-Kacheln (Mapbox-Kodierung) für MapLibre, z 10–13
  data/relief/{z}/{x}/{y}.png  Reliefschattierung (RGBA, 5-fach verstärkt), z 10–13
  <arbeitsordner>/dem.npz   Höhenraster (UTM32, 10 m) für tools/build_lod2.py

Quelle: LGLN, DGM1 (CC BY 4.0), https://opendata.lgln.niedersachsen.de/doorman/noauth/dgm_wms
"""
import io
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy import ndimage

WMS = ('https://opendata.lgln.niedersachsen.de/doorman/noauth/dgm_wms?SERVICE=WMS&VERSION=1.3.0'
       '&REQUEST=GetMap&LAYERS=ni_dgm1_grau&STYLES=&CRS=EPSG:25832&BBOX={b}&WIDTH={w}&HEIGHT={h}&FORMAT=image/png')
# Grauwert -> Höhe [m NHN]; Steigung unter/über der Tabelle in m je Grauwert
CALIB = [[73, 40.72], [74, 41.93], [75, 43.24], [76, 44.57], [77, 46.02], [78, 47.53], [79, 48.98], [80, 50.47], [81, 51.72], [82, 52.93], [83, 54.13], [84, 55.48], [85, 56.8], [86, 58.07], [87, 59.19], [88, 60.39], [89, 61.61], [90, 62.97], [91, 64.23], [92, 65.57], [93, 66.75], [94, 68.14], [95, 69.32], [96, 70.56], [97, 71.71], [98, 72.99], [99, 74.53], [100, 76.35], [101, 78.55], [102, 81.01], [103, 83.62], [104, 86.16], [105, 88.55], [106, 90.95], [107, 93.41], [108, 95.96], [109, 98.7], [110, 102.25], [111, 105.94], [112, 110.84], [113, 116.39]]
SLOPE_LO, SLOPE_HI = 1.362, 4.064


def gray_to_height(g):
    gs = np.array([a for a, _ in CALIB], dtype=float)
    zs = np.array([b for _, b in CALIB], dtype=float)
    g = np.asarray(g, dtype=float)
    z = np.interp(g, gs, zs)
    z = np.where(g < gs[0], zs[0] + (g - gs[0]) * SLOPE_LO, z)
    return np.where(g > gs[-1], zs[-1] + (g - gs[-1]) * SLOPE_HI, z)
RES = 10.0                                   # Meter je Rasterzelle
# Gebiet: Kartengrenzen aus js/main.js (Gemeinde + Rand), großzügig in UTM32
E0, N0, E1, N1 = 536000, 5872000, 568000, 5902000
LNG0, LAT0, LNG1, LAT1 = 9.58, 53.0, 9.99, 53.25  # Kachelbereich
ZOOMS = range(10, 14)


def fetch(workdir):
    path = os.path.join(workdir, 'gray.npy')
    if os.path.exists(path):
        return np.load(path)
    w = int((E1 - E0) / RES)
    h = int((N1 - N0) / RES)
    out = np.zeros((h, w), dtype=np.uint8)
    step = 500  # Pixel je Abruf (5 km)
    for r0 in range(0, h, step):
        for c0 in range(0, w, step):
            cw, ch = min(step, w - c0), min(step, h - r0)
            b = (E0 + c0 * RES, N1 - (r0 + ch) * RES, E0 + (c0 + cw) * RES, N1 - r0 * RES)
            url = WMS.format(b=','.join(f'{v:.0f}' for v in b), w=cw, h=ch)
            data = subprocess.run(['curl', '-s', '-m', '180', '--retry', '3', url], capture_output=True).stdout
            out[r0:r0 + ch, c0:c0 + cw] = np.array(Image.open(io.BytesIO(data)).convert('L'))
            print('WMS', r0, c0, flush=True)
    np.save(path, out)
    return out


def reconstruct(gray):
    """Stufen -> glatte Höhen. 255 = keine Daten."""
    valid = gray < 255
    lv = gray.astype(np.int16)
    if not valid.all():  # Lücken mit dem nächsten gültigen Wert füllen
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        lv = lv[tuple(idx)]
    z = np.zeros(lv.shape, dtype=np.float32)
    for L in np.unique(lv):
        m = lv == L
        d_lo = ndimage.distance_transform_edt(~(lv < L)) if (lv < L).any() else None
        d_hi = ndimage.distance_transform_edt(~(lv > L)) if (lv > L).any() else None
        z_lo = (gray_to_height(L - 1) + gray_to_height(L)) / 2   # Höhenlinie zur Stufe darunter
        z_hi = (gray_to_height(L) + gray_to_height(L + 1)) / 2   # Höhenlinie zur Stufe darüber
        if d_lo is not None and d_hi is not None:
            t = d_lo[m] / (d_lo[m] + d_hi[m])
        elif d_lo is not None:   # Kuppe: von der Stufenkante bis zur halben Stufe ansteigen
            t = 0.5 + 0.5 * np.minimum(d_lo[m] / 30.0, 1.0)
        elif d_hi is not None:   # Senke
            t = 0.5 - 0.5 * np.minimum(d_hi[m] / 30.0, 1.0)
        else:
            t = np.full(m.sum(), 0.5)
        z[m] = z_lo + (z_hi - z_lo) * t
    return ndimage.gaussian_filter(z, 1.5)


def encode(h):
    v = np.clip(np.round((h + 10000) * 10), 0, 2 ** 24 - 1).astype(np.uint32)
    return np.dstack([(v >> 16) & 255, (v >> 8) & 255, v & 255]).astype(np.uint8)


def hillshade(z, zfactor=5.0, azimuth=315.0, altitude=40.0):
    """Schattierung 0..1 (flach = sin(Höhe)); Licht aus Nordwest."""
    dy, dx = np.gradient(z * zfactor, RES)          # Zeilen laufen nach Süden
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dy, dx)                    # Richtung des Gefälles
    az = math.radians(360.0 - azimuth + 90.0)
    alt = math.radians(altitude)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs, 0, 1), math.sin(alt)


def relief_rgba(h, flat):
    """Schatten dunkelbraun, Lichtseiten weiß, jeweils mit Transparenz."""
    d = h - flat
    rgba = np.zeros(h.shape + (4,), dtype=np.uint8)
    shade = d < 0
    rgba[shade, :3] = (52, 40, 28)
    rgba[~shade, :3] = (255, 252, 240)
    a = np.where(shade, np.clip(-d * 2.6, 0, 0.72), np.clip(d * 1.6, 0, 0.35))
    rgba[..., 3] = (a * 255).astype(np.uint8)
    return rgba


def write_tiles(z, out, zooms=ZOOMS, render=None):
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    n_tiles = 0
    for zoom in zooms:
        n = 2 ** zoom
        x0 = int((LNG0 + 180) / 360 * n)
        x1 = int((LNG1 + 180) / 360 * n)
        ty = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        y0, y1 = ty(LAT1), ty(LAT0)
        for tx in range(x0, x1 + 1):
            for tyy in range(y0, y1 + 1):
                # Pixelmitten der Kachel -> lon/lat -> UTM -> Raster
                px = (np.arange(256) + 0.5) / 256
                lon = (tx + px) / n * 360 - 180
                yy = (tyy + px) / n
                lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * yy))))
                LON, LAT = np.meshgrid(lon, lat)
                e, nn = to_utm.transform(LON, LAT)
                col = (e - E0) / RES - 0.5
                row = (N1 - nn) / RES - 0.5
                h = ndimage.map_coordinates(z, [row, col], order=1, mode='nearest')
                d = os.path.join(out, str(zoom), str(tx))
                os.makedirs(d, exist_ok=True)
                Image.fromarray(render(h) if render else encode(h)).save(os.path.join(d, f'{tyy}.png'), optimize=True)
                n_tiles += 1
    return n_tiles


def main():
    work, out = sys.argv[1], sys.argv[2]
    os.makedirs(work, exist_ok=True)
    gray = fetch(work)
    z = reconstruct(gray)
    np.savez_compressed(os.path.join(work, 'dem.npz'), z=z, e0=E0, n1=N1, res=RES)
    print(f'Höhen {z.min():.1f} – {z.max():.1f} m', flush=True)
    print('Kacheln', write_tiles(z, out))
    hs, flat = hillshade(z)
    rel = os.path.join(os.path.dirname(os.path.normpath(out)), 'relief')
    print('Reliefkacheln', write_tiles(hs, rel, range(10, 14), lambda h: relief_rgba(h, flat)))


if __name__ == '__main__':
    main()
