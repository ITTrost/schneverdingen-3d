#!/usr/bin/env python3
"""Kameralage aus wenigen Punktzuordnungen bestimmen (Gebäudeecke <-> Bildpunkt).

Aufruf: python3 tools/solve_camera.py <dem.npz> <bild-id> <arbeitsordner> "E,N,Z:x,y" "E,N,Z:x,y" ...
E, N in UTM32, Z in m NHN; x, y in Pixeln des Mapillary-Bildes (thumb_2048). Kamerahöhe über Grund und
Rollen bleiben fest, gesucht werden Position (Ost, Nord), Gieren und Nicken. Gibt die Korrektur für
tools/facade_photo.py aus.
"""
import sys, os, numpy as np
from scipy import optimize
sys.path.insert(0, os.path.dirname(__file__))
import facade_photo as FP

dem = FP.Dem(sys.argv[1])
cam = FP.Camera(sys.argv[2], dem, None, sys.argv[3])
pairs = []
for a in sys.argv[4:]:
    w, p = a.split(':')
    pairs.append((np.array([float(x) for x in w.split(',')]), np.array([float(x) for x in p.split(',')])))
P = np.array([w for w, _ in pairs]); X = np.array([p for _, p in pairs])

def apply(c):
    yaw, pitch, de, dn, roll, fs = c
    e, n = FP.to_utm.transform(*cam.meta['computed_geometry']['coordinates'])
    k = FP.Camera.__new__(FP.Camera); k.__dict__.update(cam.__dict__)
    k.pos = np.array([e + de, n + dn, dem.at(e + de, n + dn) + FP.CAM_HEIGHT])
    R = FP.rot(cam.meta['computed_rotation']) @ FP.axis_rot((0, 0, 1), -yaw)
    k.R = FP.axis_rot((0, 0, 1), roll) @ FP.axis_rot((1, 0, 0), pitch) @ R
    k.f = cam.f * fs
    return k

def resid(c):
    p2, z = apply(c).project(P)
    r = (p2 - X).ravel()
    # schwache Vorgaben: Rollen und Brennweite nur wenig verändern
    return np.concatenate([r, np.where(z < 1, 1e3, 0), [c[4] * 3, (c[5] - 1) * 200]])

best = None
for yaw0 in range(-90, 91, 10):
    for d0 in [(dx, dy) for dx in (-40, -20, 0, 20, 40) for dy in (-40, -20, 0, 20, 40)]:
        r = optimize.least_squares(resid, [yaw0, 0, *d0, 0, 1], loss='soft_l1', f_scale=5)
        if best is None or r.cost < best.cost:
            best = r
yaw, pitch, de, dn, roll, fs = best.x
print(f'Rollen {roll:.2f}°, Brennweite x{fs:.3f}')
res = resid(best.x)[:2 * len(P)].reshape(-1, 2)
print('Restfehler je Punkt (px):', np.round(np.linalg.norm(res, axis=1), 1).tolist())
print(f'KORREKTUR {yaw:.3f},{pitch:.3f},{roll:.3f},{de:.3f},{dn:.3f},0,{fs:.4f}')
