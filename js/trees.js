// Bäume aus den Kartendaten erzeugen: Wälder dicht, Parks und Gärten locker, Heide mit einzelnen Kiefern.
// Positionen sind zufällig, aber stabil (gleiche Stelle -> gleicher Baum).
import { EXAG, REF } from './buildings.js';

const SRC = 'openmaptiles';
const MAX_TREES = 32000;
const NEAR = 1600; // Meter um die Kartenmitte, volle Dichte
const FAR = 3800;  // bei weiter Sicht: größerer Umkreis, lockerer

function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a];
    const [xb, yb] = ring[b];
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
const inPolygon = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((r) => inRing(x, y, r));

/** Einfaches Raster für schnelle Nachbarschaftstests (Gebäude, Straßen). */
class Grid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(minx, miny, maxx, maxy, item) {
    const c = this.cell;
    for (let i = Math.floor(minx / c); i <= Math.floor(maxx / c); i++) {
      for (let j = Math.floor(miny / c); j <= Math.floor(maxy / c); j++) {
        const k = this.key(i, j);
        if (!this.m.has(k)) this.m.set(k, []);
        this.m.get(k).push(item);
      }
    }
  }
  near(x, y) { return this.m.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))) || []; }
}

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const polygons = (f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);

export function initTrees(map, buildings) {
  let last = null;
  let timer;

  function generate() {
    const zoom = map.getZoom();
    const far = zoom < 14.5;
    const RADIUS = far ? FAR : NEAR;
    const sparse = far ? 1.9 : 1; // Abstand der Bäume bei weiter Sicht vergrößern
    if (zoom < 12.8) {
      if (last) { buildings.setTrees([]); last = null; }
      return;
    }
    const c = map.getCenter();
    const [cx, cy] = buildings.toLocal(c.lng, c.lat);
    if (last && last[2] === far && Math.hypot(cx - last[0], cy - last[1]) < (far ? 900 : 450)) return;
    last = [cx, cy, far];

    const local = (ring) => ring.map(([lng, lat]) => buildings.toLocal(lng, lat));
    const near = (ring) => ring.some(([x, y]) => Math.abs(x - cx) < RADIUS * 1.3 && Math.abs(y - cy) < RADIUS * 1.3);

    // Hindernisse: Gebäude (Umrisse) und Straßen
    const blocked = new Grid(40);
    for (const f of map.querySourceFeatures(SRC, { sourceLayer: 'building' })) {
      for (const poly of polygons(f)) {
        const r = local(poly[0]);
        if (!near(r)) continue;
        const xs = r.map((p) => p[0]);
        const ys = r.map((p) => p[1]);
        blocked.add(Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2,
          { box: [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2] });
      }
    }
    for (const f of map.querySourceFeatures(SRC, { sourceLayer: 'transportation' })) {
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      const w = ['primary', 'secondary', 'trunk', 'rail'].includes(f.properties.class) ? 7 : 4.5;
      for (const line of lines) {
        const l = local(line);
        for (let i = 1; i < l.length; i++) {
          const [a, b] = [l[i - 1], l[i]];
          blocked.add(Math.min(a[0], b[0]) - w, Math.min(a[1], b[1]) - w, Math.max(a[0], b[0]) + w, Math.max(a[1], b[1]) + w, { seg: [a, b], w });
        }
      }
    }
    const free = (x, y) => !blocked.near(x, y).some((o) => (o.box
      ? x > o.box[0] && x < o.box[2] && y > o.box[1] && y < o.box[3]
      : segDist(x, y, o.seg[0], o.seg[1]) < o.w));

    // Flächen mit Baumdichte: Abstand in Metern, Anteil Kiefern, Belegung
    const areas = [];
    for (const f of map.querySourceFeatures(SRC, { sourceLayer: 'landcover' })) {
      const p = f.properties;
      let spec = null;
      if (p.class === 'wood') spec = { step: 8, pine: 0.7, fill: 0.85 };
      else if (p.subclass === 'heath') spec = { step: 26, pine: 0.95, fill: 0.18 };
      else if (['park', 'garden', 'cemetery', 'village_green'].includes(p.subclass)) spec = { step: 14, pine: 0.25, fill: 0.5 };
      if (spec) for (const poly of polygons(f)) areas.push({ rings: poly, spec });
    }
    for (const f of map.querySourceFeatures(SRC, { sourceLayer: 'landuse' })) {
      if (f.properties.class !== 'residential') continue;
      for (const poly of polygons(f)) areas.push({ rings: poly, spec: { step: 17, pine: 0.3, fill: 0.42, garden: true } });
    }

    const seen = new Set();
    const trees = [];
    for (const { rings, spec } of areas) {
      const lr = rings.map(local);
      if (!near(lr[0])) continue;
      const xs = lr[0].map((p) => p[0]);
      const ys = lr[0].map((p) => p[1]);
      const s = Math.round(spec.step * sparse);
      const x0 = Math.max(Math.min(...xs), cx - RADIUS);
      const x1 = Math.min(Math.max(...xs), cx + RADIUS);
      const y0 = Math.max(Math.min(...ys), cy - RADIUS);
      const y1 = Math.min(Math.max(...ys), cy + RADIUS);
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
        for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
          const key = `${s}:${i}:${j}`;
          if (seen.has(key)) continue;
          if (hash(i, j, s) > spec.fill) continue;
          const x = (i + 0.15 + 0.7 * hash(i, j, 11)) * s;
          const y = (j + 0.15 + 0.7 * hash(i, j, 13)) * s;
          if (Math.hypot(x - cx, y - cy) > RADIUS) continue;
          if (!inPolygon(x, y, lr)) continue;
          if (!free(x, y)) continue;
          seen.add(key);
          const pine = hash(i, j, 17) < spec.pine;
          const base = spec.garden ? (pine ? 9 : 8) : pine ? 15 : 13;
          trees.push({
            x, y, pine,
            h: base * (0.75 + 0.5 * hash(i, j, 19)),
            rot: hash(i, j, 23) * Math.PI * 2,
            shade: hash(i, j, 29),
            d: Math.hypot(x - cx, y - cy),
          });
        }
      }
    }
    trees.sort((a, b) => a.d - b.d);
    const chosen = trees.slice(0, MAX_TREES);
    // Geländehöhe (überhöht, absolut) wie bei den Gebäuden
    const center = map.transform.elevation || 0;
    for (const t of chosen) {
      const e = map.queryTerrainElevation(buildings.toLngLat(t.x, t.y));
      t.z = e == null ? 0 : e + center - REF * EXAG; // gleiche Bezugshöhe wie die Gebäude
    }
    buildings.setTrees(chosen);
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(generate, 250); };
  map.on('moveend', schedule);
  map.on('idle', () => { if (!last) schedule(); });
  return { refresh: () => { last = null; schedule(); } };
}
