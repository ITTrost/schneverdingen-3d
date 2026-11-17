#!/usr/bin/env python3
"""Fassadenfoto aus Mapillary entzerrt auf die Wände eines LoD2-Gebäudes legen.

Vorschau (Wände ins Foto zeichnen, Lage prüfen):
    python3 tools/facade_photo.py vorschau <gml-ordner> <dem.npz> <bild-id> <ausgabe.jpg> [korrektur]
Texturen erzeugen:
    python3 tools/facade_photo.py textur <gml-ordner> <dem.npz> <bild-id> <gebäude-id> data/fassaden [korrektur] [wände]

korrektur = "gier,nick,roll,ost,nord,hoehe" (Grad, Grad, Grad, Meter, Meter, Meter) – gleicht kleine Fehler
der von Mapillary berechneten Kameralage aus. wände = Nummern der Wände (aus der Vorschau), sonst alle
sichtbaren, die zur Kamera zeigen.

Ausgabe je Wand: data/fassaden/<gebäude>_<n>.jpg und ein Eintrag für data/landmarks.json ("fotos"),
der die Wand als Polygon mit Texturkoordinaten beschreibt (Länge, Breite, Höhe über Grund, u, v).
Fotos: Mapillary-Mitwirkende, CC BY-SA 4.0 – die Texturen stehen unter derselben Lizenz.
"""
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage
from shapely import contains_xy
from shapely.geometry import Polygon as _Poly


class Path:
    """Punkt-in-Polygon (Ersatz für matplotlib.path.Path)."""

    def __init__(self, pts):
        self.poly = _Poly(pts).buffer(0.01)

    def contains_points(self, p):
        return contains_xy(self.poly, p[:, 0], p[:, 1])

sys.path.insert(0, os.path.dirname(__file__))
from build_lod2 import B, NS, Dem, etree, surfaces  # noqa: E402

to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
to_wgs = Transformer.from_crs(25832, 4326, always_xy=True)
PX_PER_M = 48
CAM_HEIGHT = 1.5


def api(path):
    out = subprocess.run(['curl', '-s', '-m', '60', '-H', 'Authorization: Bearer proxy-injected',
                          'https://graph.mapillary.com/' + path], capture_output=True, text=True).stdout
    return json.loads(out)


def rot(rv):
    rv = np.asarray(rv, float)
    th = np.linalg.norm(rv)
    k = rv / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def axis_rot(axis, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    x, y, z = axis
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


class Camera:
    def __init__(self, image_id, dem, corr=None, workdir='.'):
        m = api(f'{image_id}?fields=computed_geometry,computed_rotation,camera_parameters,width,height,thumb_2048_url,creator,captured_at')
        self.meta = m
        path = os.path.join(workdir, f'mly_{image_id}.jpg')
        if not os.path.exists(path):
            subprocess.run(['curl', '-s', '-m', '90', '-o', path, m['thumb_2048_url']], check=True)
        self.img = Image.open(path).convert('RGB')
        self.W, self.H = self.img.size
        yaw, pitch, roll, de, dn, dh = corr or (0, 0, 0, 0, 0, 0)
        lon, lat = m['computed_geometry']['coordinates']
        e, n = to_utm.transform(lon, lat)
        self.pos = np.array([e + de, n + dn, dem.at(e, n) + CAM_HEIGHT + dh])
        R = rot(m['computed_rotation'])  # Welt (Ost, Nord, oben) -> Kamera (x rechts, y unten, z vorwärts)
        # Korrekturen: Gieren um Weltachse oben, Nicken/Rollen um Kameraachsen
        R = R @ axis_rot((0, 0, 1), -yaw)
        R = axis_rot((1, 0, 0), pitch) @ R
        R = axis_rot((0, 0, 1), roll) @ R
        self.R = R
        self.f = m['camera_parameters'][0] * max(self.W, self.H)
        self.k1, self.k2 = m['camera_parameters'][1:3]
        # UTM-Gitter weicht vom geografischen Norden ab (Meridiankonvergenz); Mapillary rechnet in Ost/Nord
        lon2, lat2 = to_wgs.transform(e, n + 100)
        self.conv = math.atan2(math.radians(lon2 - lon) * math.cos(math.radians(lat)), math.radians(lat2 - lat))

    def project(self, p):
        """UTM-Punkte (N×3) -> Bildpunkte (N×2) und Tiefe."""
        d = np.asarray(p, float) - self.pos
        c, s = math.cos(self.conv), math.sin(self.conv)
        enu = np.stack([d[:, 0] * c - d[:, 1] * s, d[:, 0] * s + d[:, 1] * c, d[:, 2]], 1)
        q = (self.R @ enu.T).T
        z = q[:, 2]
        x, y = q[:, 0] / z, q[:, 1] / z
        r2 = x * x + y * y
        dist = 1 + self.k1 * r2 + self.k2 * r2 * r2
        return np.stack([self.W / 2 + self.f * x * dist, self.H / 2 + self.f * y * dist], 1), z


def building_walls(gml_dir, bid_or_none, cam_pos, radius=60):
    ek, nk = int(cam_pos[0] // 1000), int(cam_pos[1] // 1000)
    out = []
    for de in (-1, 0, 1):
        for dn in (-1, 0, 1):
            path = os.path.join(gml_dir, f'LoD2_32_{ek + de}_{nk + dn}_1_ni.gml')
            if not os.path.exists(path):
                continue
            for _, bel in etree.iterparse(path, tag=B + 'Building'):
                if bel.getparent().tag != '{%s}cityObjectMember' % NS['core']:
                    continue
                bid = bel.get('{http://www.opengis.net/gml}id')
                if bid_or_none and bid != bid_or_none:
                    bel.clear()
                    continue
                polys, grounds, _ = surfaces(bel)
                if grounds:
                    gc = np.concatenate(grounds)
                    centre = gc[:, :2].mean(0)
                    if np.linalg.norm(centre - cam_pos[:2]) < radius:
                        out.append((bid, polys, grounds))
                bel.clear()
    return out


def preview(gml, dem_path, image_id, out, corr):
    dem = Dem(dem_path)
    cam = Camera(image_id, dem, corr, os.path.dirname(out))
    im = cam.img.copy()
    d = ImageDraw.Draw(im)
    k = 0
    for bid, polys, grounds in building_walls(gml, None, cam.pos):
        for kind, ring, _ in polys:
            p2, z = cam.project(ring)
            if (z < 0.5).all():
                continue
            if (z < 0.5).any():   # teilweise hinter der Kamera: Kanten einzeln, nur sichtbare
                for i in range(len(ring) - 1):
                    seg = np.linspace(ring[i], ring[i + 1], 30)
                    q, zz = cam.project(seg)
                    q = q[zz > 0.5]
                    if len(q) > 1:
                        d.line([tuple(x) for x in q], fill=(255, 0, 255) if kind == 0 else (0, 255, 255), width=3)
                continue
            col = (255, 0, 255) if kind == 0 else (0, 255, 255)
            d.line([tuple(x) for x in p2], fill=col, width=3)
        c, z = cam.project(np.concatenate(grounds)[:, :3].mean(0, keepdims=True) + [0, 0, 3])
        if z[0] > 0.5 and 0 < c[0, 0] < cam.W and 0 < c[0, 1] < cam.H:
            d.text((c[0, 0], c[0, 1]), bid[-6:], fill='yellow')
        k += 1
    im.save(out, quality=88)
    print('Vorschau', out, '| Urheber', cam.meta['creator']['username'])


def wall_frame(ring):
    """Lokales Wandsystem: Ursprung unten links, Achse u waagerecht, v senkrecht (Meter)."""
    xy = ring[:, :2]
    D = np.linalg.norm(xy[:, None] - xy[None], axis=2)
    i0, i1 = np.unravel_index(int(D.argmax()), D.shape)
    a, b = xy[i0], xy[i1]
    ux = (b - a) / np.linalg.norm(b - a)
    z0 = ring[:, 2].min()
    u = (xy - a) @ ux
    v = ring[:, 2] - z0
    return a, ux, z0, u - u.min(), v, u.min()


def texture(gml, dem_path, image_id, bid, outdir, corr, only=None, fill_rgb=(225, 222, 214)):
    dem = Dem(dem_path)
    os.makedirs(outdir, exist_ok=True)
    cam = Camera(image_id, dem, corr, outdir + '/../../.cache' if False else os.path.dirname(os.path.abspath(outdir)))
    found = building_walls(gml, bid, cam.pos, radius=200)
    if not found:
        raise SystemExit('Gebäude nicht gefunden')
    _, polys, grounds = found[0]
    gc = np.concatenate(grounds)
    ground = gc[:, 2].min()
    base = dem.at(float(gc[:, 0].mean()), float(gc[:, 1].mean()))
    photo = np.asarray(cam.img).astype(np.float32)
    # Alle Wände des Gebäudes als mögliche Verdecker (Ebene + Polygon in Wandkoordinaten)
    occluders = []
    for kind, ring, _ in polys:
        if kind != 0:
            continue
        r = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
        a_, ux_, z0_, u_, v_, umin_ = wall_frame(r)
        occluders.append((a_, ux_, z0_, umin_, Path(np.stack([u_, v_], 1))))
    entries = []
    wi = -1
    for kind, ring, _ in polys:
        if kind != 0:
            continue
        wi += 1
        if only is not None and wi not in only:
            continue
        ring = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
        a, ux, z0, u, v, umin = wall_frame(ring)
        width, height = u.max(), v.max()
        if width < 1.5 or height < 1.5:
            continue
        # Wand muss zur Kamera zeigen
        nrm = np.array([-ux[1], ux[0]])
        mid = a + ux * (umin + width / 2)
        to_cam = cam.pos[:2] - mid
        if np.dot(nrm, to_cam) < 0:
            nrm = -nrm
        cosang = np.dot(nrm, to_cam) / np.linalg.norm(to_cam)
        if cosang < 0.25 and only is None:
            continue
        W, H = max(8, int(width * PX_PER_M)), max(8, int(height * PX_PER_M))
        uu, vv = np.meshgrid((np.arange(W) + 0.5) / PX_PER_M, height - (np.arange(H) + 0.5) / PX_PER_M)
        pts = np.stack([a[0] + ux[0] * (umin + uu), a[1] + ux[1] * (umin + uu), z0 + vv], -1).reshape(-1, 3)
        p2, z = cam.project(pts)
        inside = (z > 0.5) & (p2[:, 0] >= 0) & (p2[:, 0] < cam.W - 1) & (p2[:, 1] >= 0) & (p2[:, 1] < cam.H - 1)
        if inside.mean() < 0.6:
            print(f'Wand {wi}: nur {inside.mean():.0%} im Bild, übersprungen')
            continue
        tex = np.zeros((H * W, 3), np.float32)
        for ch in range(3):
            tex[:, ch] = ndimage.map_coordinates(photo[..., ch], [p2[:, 1], p2[:, 0]], order=1, mode='nearest')
        # Verdeckung durch andere Wände desselben Gebäudes: Strahl Kamera -> Wandpunkt schneiden
        hidden = ~inside
        C = cam.pos
        for a_, ux_, z0_, umin_, path in occluders:
            if np.allclose(a_, a) and np.allclose(ux_, ux):
                continue
            n_ = np.array([-ux_[1], ux_[0], 0.0])
            dirs = pts - C
            den = dirs @ n_
            with np.errstate(divide='ignore', invalid='ignore'):
                t = ((np.array([a_[0], a_[1], 0.0]) - C) @ n_) / den
            cand = (t > 0.02) & (t < 0.97) & np.isfinite(t)
            if not cand.any():
                continue
            X = C + dirs[cand] * t[cand, None]
            uu_ = (X[:, :2] - a_) @ ux_ - umin_
            vv_ = X[:, 2] - z0_
            hit = np.zeros(len(pts), bool)
            hit[np.where(cand)[0]] = path.contains_points(np.stack([uu_, vv_], 1))
            hidden |= hit
        tex[hidden] = np.array(fill_rgb, np.float32)
        if hidden.mean() > 0.6:
            print(f'Wand {wi}: zu {hidden.mean():.0%} verdeckt, übersprungen')
            continue
        tex = tex.reshape(H, W, 3)
        name = f'{bid}_{wi}.jpg'
        Image.fromarray(np.clip(tex, 0, 255).astype(np.uint8)).save(os.path.join(outdir, name), quality=85)
        # Polygon der Wand in Länge/Breite, Höhe über Gebäudegrund, Texturkoordinaten 0..1
        lon, lat = to_wgs.transform(ring[:, 0] + nrm[0] * 0.05, ring[:, 1] + nrm[1] * 0.05)  # 5 cm vor die Wand
        poly = [[round(lon[i], 8), round(lat[i], 8), round(float(ring[i, 2] - ground), 2),
                 round(float(u[i] / width), 4), round(float(v[i] / height), 4)] for i in range(len(ring))]
        entries.append({'bild': f'data/fassaden/{name}', 'wand': poly,
                        'normale': [round(float(nrm[0]), 4), round(float(nrm[1]), 4)]})
        print(f'Wand {wi}: {width:.1f} × {height:.1f} m -> {name} ({inside.mean():.0%} im Bild, {hidden.mean():.0%} verdeckt, {math.degrees(math.acos(min(1, cosang))):.0f}° schräg)')
    meta = {'basis': round(float(base), 2), 'quelle_foto': f'Mapillary, Bild {image_id}, Foto: {cam.meta["creator"]["username"]} (CC BY-SA 4.0)',
            'fotos': entries}
    print(json.dumps(meta, ensure_ascii=False)[:300])
    json.dump(meta, open(os.path.join(outdir, f'{bid}.json'), 'w'), ensure_ascii=False)


def parse_corr(s):
    return tuple(float(x) for x in s.split(',')) if s else None


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'vorschau':
        preview(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], parse_corr(sys.argv[6] if len(sys.argv) > 6 else ''))
    else:
        only = set(int(x) for x in sys.argv[8].split(',')) if len(sys.argv) > 8 and sys.argv[8] else None
        fill = tuple(int(sys.argv[9][i:i + 2], 16) for i in (1, 3, 5)) if len(sys.argv) > 9 else (225, 222, 214)
        texture(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], parse_corr(sys.argv[7] if len(sys.argv) > 7 else ''), only, fill)
