#!/usr/bin/env python3
"""Kameralage eines Mapillary-Fotos an LoD2-Gebäude anpassen (Kanten im Foto <-> Gebäudeumrisse).

Aufruf: python3 tools/fit_camera.py <gml> <dem.npz> <bild-id> <gebäude-id,…> <arbeitsordner>
Gibt die Korrektur "gier,nick,roll,ost,nord,hoehe" für tools/facade_photo.py aus und schreibt eine Vorschau.
"""
import sys, os, numpy as np, cv2
from scipy import optimize
sys.path.insert(0, os.path.dirname(__file__))
import facade_photo as FP

gml, dem_path, image_id, bids, work = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(','), sys.argv[5]
dem = FP.Dem(dem_path)
cam0 = FP.Camera(image_id, dem, None, work)
gray = cv2.cvtColor(np.asarray(cam0.img), cv2.COLOR_RGB2GRAY)
gray = cv2.GaussianBlur(gray, (5, 5), 0)
edges = cv2.Canny(gray, 40, 110)
dist = cv2.distanceTransform(255 - edges, cv2.DIST_L2, 5)
segs = []
for bid in bids:
    for _, polys, grounds in FP.building_walls(gml, bid, cam0.pos, radius=200):
        for kind, ring, _ in polys:
            r = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
            for i in range(len(r)):
                a, b = r[i], r[(i + 1) % len(r)]
                if np.linalg.norm(a - b) > 0.8:
                    segs.append((a, b))
pts = np.concatenate([np.linspace(a, b, max(4, int(np.linalg.norm(a - b) * 4))) for a, b in segs])

def score(c, cam=None):
    cam = FP.Camera.__new__(FP.Camera)
    cam.__dict__.update(cam0.__dict__)
    yaw, pitch, roll, de, dn, dh = c
    m = cam0.meta
    import math
    e, n = FP.to_utm.transform(*m['computed_geometry']['coordinates'])
    cam.pos = np.array([e + de, n + dn, dem.at(e, n) + FP.CAM_HEIGHT + dh])
    R = FP.rot(m['computed_rotation']) @ FP.axis_rot((0, 0, 1), -yaw)
    R = FP.axis_rot((1, 0, 0), pitch) @ R
    cam.R = FP.axis_rot((0, 0, 1), roll) @ R
    p2, z = cam.project(pts)
    ok = (z > 1) & (p2[:, 0] > 0) & (p2[:, 0] < cam.W - 1) & (p2[:, 1] > 0) & (p2[:, 1] < cam.H - 1)
    if ok.sum() < 80:
        return 1e3
    d = dist[p2[ok, 1].astype(int), p2[ok, 0].astype(int)]
    # Punkte außerhalb des Bildes zählen nur, wenn sie vor der Kamera liegen sollten (Sichtfeld)
    front = (z > 1).mean()
    # Grenzen: Mapillary liegt selten mehr als ~8 m oder ~10° daneben; Kamerahöhe ±1 m, Rollen ±3°
    lim = np.array([12, 6, 3, 8, 8, 1.0])
    over = np.maximum(np.abs(np.asarray(c)) - lim, 0)
    return float(np.mean(np.minimum(d, 25.0))) + (1 - front) * 10 + 50 * float((over ** 2).sum()) + 0.02 * abs(roll)

best = None
rng = np.random.default_rng(1)
starts = [np.zeros(6)] + [np.array([rng.uniform(-8, 8), rng.uniform(-4, 4), 0, rng.uniform(-6, 6), rng.uniform(-6, 6), rng.uniform(-0.5, 0.8)]) for _ in range(40)]
for s in starts:
    r = optimize.minimize(score, s, method='Nelder-Mead', options={'maxiter': 600, 'xatol': 0.02, 'fatol': 0.01})
    if best is None or r.fun < best.fun:
        best = r
print('Ausgang', round(score(np.zeros(6)), 2), '-> angepasst', round(best.fun, 2))
print('KORREKTUR', ','.join(f'{x:.3f}' for x in best.x))
