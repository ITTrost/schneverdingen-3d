// LoD2-Gebäude des LGLN als Three.js-Ebene in MapLibre.
// Geometrie kommt vorberechnet aus data/lod2 (siehe tools/build_lod2.py).
import * as THREE from '../vendor/three/three.module.min.js';
import { v } from './config.js';

const DATA = 'data/lod2/';
export const EXAG = 4;
export const REF = 30; // Bezugshöhe m NHN: Höhen werden ab hier gerechnet, damit sie in Int16 passen // Überhöhung des Geländes – muss zu terrain.exaggeration in main.js passen
const R = 6371008.8;

const VERT = /* glsl */ `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
in vec3 position;
in vec4 aNormal;
in vec4 aInfo;
in float aU;
in float aBid;
in float aBase;
in vec2 aUv;
uniform float uExag;
out vec2 vUv;
out vec3 vN;
out vec3 vP;
out float vU;
flat out vec4 vInfo;   // flat: Ganzzahlwerte nicht interpolieren (sonst 37,9999 statt 38 -> Rauschen)
flat out float vBid;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  vP.z -= (aBase * 0.1 - 30.0) * uExag; // Höhe über dem Gebäudegrund (30 = REF)
  vN = aNormal.xyz;
  vU = aU * 0.1;
  vInfo = aInfo;
  vBid = aBid;
  vUv = aUv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uNight;
uniform float uTile;
uniform float uSelTile;
uniform float uSel;
uniform sampler2D uRoofTex;
uniform float uHasTex;
uniform sampler2D uStyle;   // je Gebäude (x) und Gebäudeteil (y): rgb Farbe, a = Material | Fenster << 4
in vec2 vUv;
in vec3 vN;
in vec3 vP;
in float vU;
flat in vec4 vInfo;
flat in float vBid;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// ---------- Materialien (uv = Meter entlang der Wand, Höhe über Grund; px = Meter je Bildpunkt) ----------
// Klinker im Läuferverband: 24 × 7,1 cm, Fugen 1 cm
vec3 brick(vec2 uv, vec3 c, float px) {
  float row = floor(uv.y / 0.083);
  float x = uv.x / 0.25 + mod(row, 2.0) * 0.5;
  float id = floor(x);
  float joint = max(step(fract(uv.y / 0.083), 0.13), step(fract(x), 0.05));
  vec3 b = c * (0.86 + 0.28 * hash(vec2(id, row)));
  vec3 detail = mix(b, vec3(0.70, 0.68, 0.63), joint * 0.85);
  // Fugen nur zeigen, solange ein Bildpunkt kleiner als etwa ein Drittel einer Steinlage ist (sonst Flimmern)
  return mix(detail, c * 0.97 + 0.03, smoothstep(0.008, 0.025, px));
}
// Feldsteinmauer: unregelmäßige, runde Steine in hellem Mörtel
vec3 fieldstone(vec2 uv, vec3 c, float px) {
  vec2 p = uv / 0.42;
  vec2 g = floor(p);
  float d1 = 9.0, d2 = 9.0; vec2 cell = g;
  for (int i = -1; i <= 1; i++) for (int k = -1; k <= 1; k++) {
    vec2 o = g + vec2(float(i), float(k));
    vec2 q = o + 0.15 + 0.7 * vec2(hash(o), hash(o + 7.3));
    float d = length(p - q);
    if (d < d1) { d2 = d1; d1 = d; cell = o; } else if (d < d2) d2 = d;
  }
  float h = hash(cell + 3.1);
  vec3 stone = mix(mix(vec3(0.52, 0.50, 0.48), vec3(0.62, 0.50, 0.44), step(0.55, h)), vec3(0.40, 0.38, 0.37), step(0.85, h));
  stone = mix(stone, c, 0.35) * (0.85 + 0.3 * hash(cell + 9.7));
  float mortar = 1.0 - smoothstep(0.06, 0.14, d2 - d1);
  vec3 detail = mix(stone, vec3(0.74, 0.72, 0.67), mortar);
  return mix(detail, mix(c, vec3(0.72), 0.2), smoothstep(0.05, 0.14, px));
}
// Senkrechte Bretter (Holz, unbehandelt)
vec3 boards(vec2 uv, vec3 c, float px) {
  float id = floor(uv.x / 0.17);
  float groove = step(fract(uv.x / 0.17), 0.07);
  vec3 b = c * (0.84 + 0.3 * hash(vec2(id, 1.7))) * (0.95 + 0.05 * sin(uv.y * 7.0 + id * 3.0));
  return mix(mix(b, b * 0.55, groove), c * 0.93, smoothstep(0.015, 0.05, px));
}
// Fachwerk: dunkle Balken, Gefache in der Farbe c
vec3 timber(vec2 uv, vec3 c, float px) {
  float beamX = 1.0 - step(0.12, fract(uv.x / 1.1));
  float beamZ = 1.0 - step(0.10, fract((uv.y + 0.15) / 1.35));
  vec3 fill = brick(uv, c, px);
  return mix(fill, vec3(0.20, 0.15, 0.11), max(beamX, beamZ) * (1.0 - smoothstep(0.08, 0.25, px) * 0.6));
}

// Fassaden: überwiegend Klinker (typisch für die Heide), dazu Putz
vec3 wallColor(float s) {
  float k = mod(s, 10.0);
  if (k < 3.0) return vec3(0.56, 0.27, 0.20);   // roter Klinker
  if (k < 5.0) return vec3(0.46, 0.22, 0.17);   // dunkler Klinker
  if (k < 6.0) return vec3(0.62, 0.36, 0.25);   // heller Klinker
  if (k < 8.0) return vec3(0.89, 0.87, 0.82);   // weißer Putz
  if (k < 9.0) return vec3(0.83, 0.77, 0.64);   // Sandputz
  return vec3(0.75, 0.74, 0.71);                // grauer Putz
}
vec3 roofColor(float s) {
  float k = mod(floor(s / 10.0), 7.0);
  if (k < 3.0) return vec3(0.60, 0.24, 0.16);   // rote Tonziegel
  if (k < 4.0) return vec3(0.45, 0.19, 0.14);   // dunkelrot
  if (k < 6.0) return vec3(0.24, 0.25, 0.27);   // anthrazit
  return vec3(0.40, 0.29, 0.22);                // braun
}

// Spitzbogenfenster: x quer (Meter, 0 = Mitte), z Höhe; Breite w, unten z0, Kämpfer zs, Spitze z1
float pointed(float x, float z, float w, float z0, float zs, float z1) {
  if (z < z0 || z > z1 || abs(x) > w * 0.5) return 0.0;
  if (z < zs) return 1.0;
  float t = (z - zs) / (z1 - zs);
  return step(abs(x), w * 0.5 * sqrt(max(0.0, 1.0 - t * t)) - w * 0.5 * t * 0.35);
}

void main() {
  vec3 n = normalize(vN);
  float kind = floor(vInfo.x + 0.5);
  float seed = floor(vInfo.y + 0.5);
  // Fassadenklasse aus tools/build_lod2.py: 0 Wohnhaus, 1 Nebengebäude, 2 Halle, 3 Stall/Scheune, 4 Kirche, 5 Heidehof
  float cls = floor(vInfo.z + 0.5);
  float infoW = floor(vInfo.w + 0.5);
  float hasTex = mod(infoW, 2.0);
  float part = min(floor(infoW / 2.0), float(textureSize(uStyle, 0).y - 1));
  vec4 st = texelFetch(uStyle, ivec2(int(vBid + 0.5), int(part)), 0);
  float sa = floor(st.a * 255.0 + 0.5);
  float mat = mod(sa, 16.0);          // 0 Regel, 1 Klinker, 2 Putz, 3 Feldstein, 4 Holz, 5 Fachwerk
  float win = floor(sa / 16.0);       // 0 Regel, 1 keine, 2 Wohnhaus, 3 Kirche, 4 Kirchturm, 5 Lichtband
  bool wall = kind < 0.5;
  vec2 uv = vec2(vU, vP.z);
  float px = max(fwidth(vU), fwidth(vP.z));
  vec3 base;
  if (wall && mat > 0.5) {
    vec3 c = st.rgb;
    base = mat < 1.5 ? brick(uv, c, px) : mat < 2.5 ? c : mat < 3.5 ? fieldstone(uv, c, px) : mat < 4.5 ? boards(uv, c, px) : timber(uv, c, px);
  } else if (wall) {
    if (cls == 1.0) {
      base = mix(vec3(0.55, 0.52, 0.47), vec3(0.42, 0.33, 0.25), step(5.0, mod(seed, 10.0)));
    } else if (cls == 2.0) {
      // Blechverkleidung, waagerechte Sicken, unten ein Sockel
      float k = mod(seed, 4.0);
      base = k < 1.0 ? vec3(0.80, 0.81, 0.80) : k < 2.0 ? vec3(0.62, 0.66, 0.68) : k < 3.0 ? vec3(0.70, 0.67, 0.60) : vec3(0.43, 0.50, 0.46);
      base *= mix(0.93 + 0.07 * step(0.5, fract(vP.z * 4.0)), 0.965, smoothstep(0.03, 0.09, px));
      if (vP.z < 0.9) base = vec3(0.50, 0.49, 0.47);
    } else if (cls == 3.0) {
      // Stall und Scheune: dunkle Holzschalung oder roter Klinker
      base = mod(seed, 3.0) < 1.5 ? boards(uv, vec3(0.30, 0.22, 0.16), px) : brick(uv, vec3(0.50, 0.24, 0.17), px);
    } else if (cls == 4.0) {
      base = brick(uv, vec3(0.55, 0.25, 0.18), px); // Backstein
    } else if (cls == 5.0) {
      base = timber(uv, vec3(0.58, 0.28, 0.20), px); // Heidehof
    } else {
      base = wallColor(seed);
      if (mod(seed, 10.0) < 6.0) base = brick(uv, base, px);
    }
  } else if (n.z > 0.97) {
    base = vec3(0.47, 0.47, 0.46) + (hash(vec2(seed, 1.0)) - 0.5) * 0.08; // Flachdach
  } else {
    base = mat > 0.5 && st.rgb != vec3(0.0) ? st.rgb : roofColor(seed);
  }

  float diff = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uGround, uSky, n.z * 0.5 + 0.5);
  float ao = wall ? mix(0.6, 1.0, smoothstep(0.0, 3.0, vP.z)) : 1.0;
  vec3 col;
  if (!wall && uHasTex > 0.5 && hasTex > 0.5) {
    // Dach aus dem Luftbild: Licht und Schatten sind im Foto schon enthalten,
    // daher nur abgeschwächt beleuchten
    vec3 tex = texture(uRoofTex, vUv).rgb;
    col = tex * (amb * 0.55 + uSun * (0.55 + 0.45 * diff)) * 1.12 + tex * vec3(0.03, 0.035, 0.05) * uNight;
  } else {
    // Dächer ohne Luftbild: leichte Streifen entlang der Ziegelreihen
    if (!wall && n.z < 0.97) base *= 0.94 + 0.06 * step(0.5, fract(vP.z * 3.0));
    vec3 street = vec3(0.32, 0.24, 0.14) * uNight * (1.0 - smoothstep(0.0, 9.0, vP.z)) * (wall ? 1.0 : 0.0);
    col = base * (amb * ao + uSun * diff * 1.15 + street + vec3(0.05, 0.06, 0.09) * uNight);
  }

  // Fensterart: aus der Stil-Tabelle oder aus der Fassadenklasse
  if (win < 0.5) win = (cls == 0.0 || cls == 5.0) ? 2.0 : cls == 2.0 ? 5.0 : cls == 4.0 ? 3.0 : 1.0;
  float far = smoothstep(0.35, 0.9, px);
  vec3 glass = mix(vec3(0.15, 0.19, 0.24), uSky, 0.25) * (0.7 + 0.5 * diff);

  if (wall && win == 2.0 && abs(n.z) < 0.4) {
    float z = vP.z - 0.9;
    float row = floor(z / 3.0);
    float fz = fract(z / 3.0);
    float cell = floor(vU / 2.7);
    float fx = fract(vU / 2.7);
    if (z > 0.0 && fz < 0.46 && fx > 0.28 && fx < 0.72 && vU > 0.9) {
      float h = hash(vec2(cell + vBid * 13.17 + uTile * 3.1, row + seed * 0.37));
      vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.88, 0.62), hash(vec2(h, row)));
      float lit = step(h, 0.45) * uNight;
      vec3 win2 = mix(glass, warm * 1.25, lit);
      vec3 avg = mix(col, mix(glass, warm, 0.45 * uNight), 0.22);
      col = mix(win2, avg, far);
    } else if (z > 0.0) {
      vec3 avg = mix(col, mix(glass, vec3(1.0, 0.8, 0.5), 0.45 * uNight), 0.22);
      col = mix(col, avg, far);
    }
  }

  // Lichtband (Halle), Spitzbogenfenster (Kirche), Schallöffnungen (Kirchturm)
  if (wall && abs(n.z) < 0.4 && win >= 3.0) {
    vec3 warm = vec3(1.0, 0.8, 0.5);
    float on = 0.0;
    if (win == 5.0) {
      on = step(3.0, vP.z) * step(vP.z, 3.9) * step(0.08, fract(vU / 1.5));
    } else if (win == 3.0) {
      float x = (fract(vU / 3.6) - 0.5) * 3.6;
      on = pointed(x, vP.z, 1.0, 2.4, 6.0, 7.2);
    } else {
      float x = (fract(vU / 3.4) - 0.5) * 3.4;
      on = max(pointed(x, vP.z, 0.7, 9.0, 11.5, 12.4),           // schmale Turmfenster
               pointed(x, vP.z, 1.3, 27.5, 31.0, 32.6));          // große Schallöffnungen im Achteck
    }
    vec3 w = mix(glass, warm * 1.1, uNight * (win == 5.0 ? 0.25 : 0.5));
    if (win == 4.0 && vP.z > 20.0) w = vec3(0.08, 0.07, 0.07); // offene Schallöffnung: dunkel
    col = mix(col, mix(w, mix(col, w, 0.25), far), on);
  }

  if (abs(uTile - uSelTile) < 0.5 && abs(vBid - uSel) < 0.5) {
    col = mix(col, vec3(0.62, 0.22, 0.6), 0.6) + vec3(0.06, 0.0, 0.06);
  }
  outColor = vec4(col, 1.0);
}`;

// Bäume: instanziert, einfache Beleuchtung mit denselben Lichtwerten wie die Gebäude
const TREE_VERT = /* glsl */ `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
in vec3 position;
in vec3 normal;
in mat4 instanceMatrix;
in vec3 aColor;
out vec3 vN;
out vec3 vC;
out float vZ;
void main() {
  vec4 p = instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(instanceMatrix) * normal);
  vC = aColor;
  vZ = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;
const TREE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uNight;
in vec3 vN;
in vec3 vC;
in float vZ;
out vec4 outColor;
void main() {
  vec3 n = normalize(vN);
  float diff = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uGround, uSky, n.z * 0.5 + 0.5);
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.9, vZ));
  vec3 col = vC * (amb * ao * 1.1 + uSun * diff) + vec3(0.02, 0.03, 0.03) * uNight;
  outColor = vec4(col, 1.0);
}`;

/** Kiefer (Kegel) und Laubbaum (Kugel) mit Stamm, Höhe 1 (Skalierung je Instanz). */
function treeGeometries() {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.3, 5).rotateX(Math.PI / 2).translate(0, 0, 0.15);
  const pine = new THREE.ConeGeometry(0.2, 0.78, 7).rotateX(Math.PI / 2).translate(0, 0, 0.6);
  const leaf = new THREE.IcosahedronGeometry(0.3, 0).scale(1, 1, 1.15).translate(0, 0, 0.62);
  const merge = (a, b) => {
    const g = new THREE.BufferGeometry();
    const flat = (g) => (g.index ? g.toNonIndexed() : g).attributes.position.array;
    const pa = [...flat(a), ...flat(b)];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pa, 3));
    g.computeVertexNormals();
    return g;
  };
  return { pine: merge(trunk, pine), leaf: merge(trunk, leaf) };
}

// Codes müssen zum Shader passen (FRAG: mat / win)
const MATERIALS = { klinker: 1, putz: 2, feldstein: 3, holz: 4, fachwerk: 5 };
const WINDOWS = { keine: 1, wohnhaus: 2, kirche: 3, kirchturm: 4, lichtband: 5 };
const MAX_PARTS = 64; // Teilnummer ist in tools/build_lod2.py auf 0–63 begrenzt
const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** lon/lat -> Mercator-Einheiten (0..1) */
function merc(lon, lat) {
  const x = (lon + 180) / 360;
  const y = (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2;
  return [x, y];
}

export function createBuildingLayer({ onProgress } = {}) {
  let map;
  let renderer;
  let scene;
  let camera;
  let index;
  let origin;
  let meter;
  let o;
  const tiles = new Map(); // key -> { mesh, records, state }
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.3, -0.5, 0.8).normalize() },
    uSun: { value: new THREE.Color(0.78, 0.76, 0.7) },
    uSky: { value: new THREE.Color(0.6, 0.66, 0.74) },
    uGround: { value: new THREE.Color(0.42, 0.4, 0.35) },
    uNight: { value: 0 },
    uExag: { value: EXAG },
    uSelTile: { value: -1 },
    uSel: { value: -1 },
  };
  let loading = 0;
  let visible = true;
  const treeMeshes = [];
  const treeGeo = treeGeometries();
  const treeMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: TREE_VERT, fragmentShader: TREE_FRAG,
    uniforms: { uSunDir: uniforms.uSunDir, uSun: uniforms.uSun, uSky: uniforms.uSky, uGround: uniforms.uGround, uNight: uniforms.uNight },
  });
  // Einzelgebäude mit eigenem Aussehen (data/landmarks.json): id -> Eintrag
  // Hinweis: Breite der Stil-Textur = Gebäude der Kachel (max. ~2.500, unter dem WebGL-Limit von 4.096)
  let landmarks = new Map();
  const landmarksReady = fetch(v('data/landmarks.json')).then((r) => r.json())
    .then((d) => { landmarks = new Map(d.gebaeude.map((g) => [g.id, g])); })
    .catch((e) => console.warn('landmarks.json nicht geladen', e));

  const ready = landmarksReady.then(() => fetch(v(DATA + 'index.json'))).then((r) => r.json()).then((d) => {
    index = d;
    index.tiles.forEach((t, i) => { t.i = i; });
    origin = d.origin;
    o = merc(origin[0], origin[1]);
    meter = 1 / (2 * Math.PI * R * Math.cos((origin[1] * Math.PI) / 180));
  });

  const toLocal = (lng, lat) => {
    const [x, y] = merc(lng, lat);
    return [(x - o[0]) / meter, -(y - o[1]) / meter];
  };
  const toLngLat = (x, y) => {
    const mx = x * meter + o[0];
    const my = -y * meter + o[1];
    const lng = mx * 360 - 180;
    const lat = (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * my) * Math.PI)) - 90;
    return [lng, lat];
  };

  const emptyTex = new THREE.DataTexture(new Uint8Array([128, 120, 110, 255]), 1, 1);
  emptyTex.needsUpdate = true;
  const texLoader = new THREE.TextureLoader();
  /** Dach-Atlas laden; bei Fehlern ohne Textur weiter. */
  function loadRoofTexture(url) {
    return texLoader.loadAsync(url).then((tex) => {
      tex.flipY = false;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      return tex;
    }).catch(() => null);
  }

  /** Stil-Tabelle einer Kachel: Spalte = Gebäude, Zeile = Gebäudeteil (0–7). */
  function styleTexture(records) {
    const w = Math.max(1, records.length);
    // Zeilen nur so viele, wie die Wahrzeichen dieser Kachel Teile haben (meist 1)
    const rows = Math.min(MAX_PARTS, Math.max(1, ...records.filter((r) => landmarks.has(r.id)).map((r) => (r.p || [0]).length)));
    const data = new Uint8Array(w * rows * 4);
    records.forEach((rec, bid) => {
      const lm = landmarks.get(rec.id);
      if (!lm) return;
      const heights = rec.p || [rec.h];
      for (let row = 0; row < rows; row++) {
        const h = heights[Math.min(row, heights.length - 1)] ?? rec.h;
        // spätere Regeln (höheres abHoehe) gewinnen
        const rule = [lm, ...(lm.teile || []).filter((t) => h != null && h >= t.abHoehe).sort((a, b) => a.abHoehe - b.abHoehe)]
          .reduce((acc, r) => ({ wand: r.wand || acc.wand, fenster: r.fenster || acc.fenster }), {});
        const [r, g, b] = hexRgb(rule.wand?.farbe);
        const o = (row * w + bid) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b;
        data[o + 3] = (MATERIALS[rule.wand?.material] || 0) | ((WINDOWS[rule.fenster] || 0) << 4);
      }
    });
    const tex = new THREE.DataTexture(data, w, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  async function loadTile(t) {
    const entry = { state: 'loading' };
    tiles.set(t.k, entry);
    loading++;
    onProgress?.(loading);
    try {
      const [buf, records, roofTex] = await Promise.all([
        fetch(v(DATA + t.k + '.bin')).then((r) => r.arrayBuffer()),
        fetch(v(DATA + t.k + '.json')).then((r) => r.json()),
        t.tex ? loadRoofTexture(v(DATA + t.k + '.jpg')) : null,
      ]);
      const dv = new DataView(buf);
      const n = dv.getUint32(4, true);
      const ni = dv.getUint32(8, true);
      const cx = dv.getFloat32(12, true);
      const cy = dv.getFloat32(16, true);
      const q = dv.getFloat32(20, true);
      let off = 24;
      const take = (Type, count) => {
        const arr = new Type(buf, off, count);
        off += count * Type.BYTES_PER_ELEMENT;
        return arr;
      };
      const pos = take(Int16Array, n * 3);
      const nrm = take(Int8Array, n * 4);
      const info = take(Uint8Array, n * 4);
      const u = take(Int16Array, n);
      const bid = take(Uint16Array, n);
      const base = take(Int16Array, n);
      const uv = take(Uint16Array, n * 2);
      // Geländehöhe (überhöht) direkt in die Positionen einrechnen, damit auch das Anklicken stimmt
      for (let i = 0; i < n; i++) pos[i * 3 + 2] += Math.round(((base[i] * 0.1 - REF) * EXAG) / q);
      if (n > 65535 && off % 4) off += 4 - (off % 4); // Uint32-Indizes sind ausgerichtet
      const idx = n > 65535 ? take(Uint32Array, ni) : take(Uint16Array, ni);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aNormal', new THREE.BufferAttribute(nrm, 4, true));
      geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
      geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
      geo.setAttribute('aBid', new THREE.BufferAttribute(bid, 1));
      geo.setAttribute('aBase', new THREE.BufferAttribute(base, 1));
      geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2, true));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          ...uniforms,
          uTile: { value: t.i },
          uRoofTex: { value: roofTex || emptyTex },
          uHasTex: { value: roofTex ? 1 : 0 },
          uStyle: { value: styleTexture(records) },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, cy, 0);
      mesh.scale.set(q, q, q);
      mesh.updateMatrixWorld(true);
      mesh.userData = { tile: t };
      mesh.visible = visible;
      scene.add(mesh);
      Object.assign(entry, { state: 'ready', mesh, records, tile: t });
    } catch (e) {
      tiles.delete(t.k);
      console.warn('Kachel', t.k, 'nicht geladen', e);
    } finally {
      loading--;
      onProgress?.(loading);
      map.triggerRepaint();
    }
  }

  function update() {
    if (!index || !map) return;
    const c = map.getCenter();
    const [x, y] = toLocal(c.lng, c.lat);
    const z = map.getZoom();
    const radius = z >= 16 ? 1300 : z >= 15 ? 2000 : z >= 14 ? 3200 : z >= 13 ? 5000 : 8000;
    const wanted = index.tiles
      .map((t) => {
        const tx = (t.b[0] + t.b[2]) / 2;
        const ty = (t.b[1] + t.b[3]) / 2;
        return { t, d: Math.hypot(tx - x, ty - y) };
      })
      .filter(({ t, d }) => d < radius && !tiles.has(t.k))
      .sort((a, b) => a.d - b.d);
    for (const { t } of wanted) {
      if (loading >= 4) break;
      loadTile(t).then(update);
    }
  }

  const layer = {
    id: 'sv-lod2',
    type: 'custom',
    renderingMode: '3d',
    async onAdd(m, gl) {
      map = m;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      await ready;
      map.on('moveend', update);
      update();
    },
    render(gl, matrix) {
      if (!o || !visible) return;
      const m = new THREE.Matrix4().fromArray(matrix);
      // Mit Gelände verschiebt MapLibre die Welt um die Höhe der Kartenmitte nach unten
      const elev = map.transform.elevation || 0;
      const t = new THREE.Matrix4().makeTranslation(o[0], o[1], (REF * EXAG - elev) * meter)
        .scale(new THREE.Vector3(meter, -meter, meter));
      camera.projectionMatrix = m.multiply(t);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };

  /** Gebäude unter einem Bildschirmpunkt finden. */
  function pick(point) {
    if (!camera || !visible) return null;
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const ndc = [(point.x / w) * 2 - 1, 1 - (point.y / h) * 2];
    const a = new THREE.Vector3(ndc[0], ndc[1], -1).applyMatrix4(camera.projectionMatrixInverse);
    const b = new THREE.Vector3(ndc[0], ndc[1], 1).applyMatrix4(camera.projectionMatrixInverse);
    const ray = new THREE.Raycaster(a, b.clone().sub(a).normalize());
    const meshes = [...tiles.values()].filter((t) => t.mesh).map((t) => t.mesh);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const entry = tiles.get(hit.object.userData.tile.k);
    const b2 = hit.object.geometry.attributes.aBid.getX(hit.face.a);
    return {
      tile: entry.tile.i,
      bid: b2,
      record: entry.records[b2],
      lngLat: toLngLat(hit.point.x, hit.point.y),
    };
  }

  return {
    layer,
    pick,
    select(sel) {
      uniforms.uSelTile.value = sel ? sel.tile : -1;
      uniforms.uSel.value = sel ? sel.bid : -1;
      map?.triggerRepaint();
    },
    setLighting(l) {
      uniforms.uSunDir.value.set(...l.dir).normalize();
      uniforms.uSun.value.setRGB(...l.sun);
      uniforms.uSky.value.setRGB(...l.sky);
      uniforms.uGround.value.setRGB(...l.ground);
      uniforms.uNight.value = l.night;
      map?.triggerRepaint();
    },
    /** Bäume setzen: Liste aus { x, y, h, pine, shade } in lokalen Metern. */
    setTrees(list) {
      for (const m of treeMeshes.splice(0)) { scene.remove(m); m.dispose(); }
      if (!scene) return;
      const groups = { pine: list.filter((t) => t.pine), leaf: list.filter((t) => !t.pine) };
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const zAxis = new THREE.Vector3(0, 0, 1);
      for (const [kind, items] of Object.entries(groups)) {
        if (!items.length) continue;
        const mesh = new THREE.InstancedMesh(treeGeo[kind], treeMat, items.length);
        const colors = new Float32Array(items.length * 3);
        items.forEach((t, i) => {
          q.setFromAxisAngle(zAxis, t.rot);
          m4.compose(new THREE.Vector3(t.x, t.y, (t.z || 0) - 0.6), q, new THREE.Vector3(t.h, t.h, t.h));
          mesh.setMatrixAt(i, m4);
          const c = kind === 'pine' ? [0.16, 0.27, 0.17] : [0.24, 0.38, 0.18];
          colors.set(c.map((v) => v * (0.8 + t.shade * 0.4)), i * 3);
        });
        mesh.geometry = mesh.geometry.clone();
        mesh.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
        mesh.frustumCulled = false;
        mesh.visible = visible;
        scene.add(mesh);
        treeMeshes.push(mesh);
      }
      map?.triggerRepaint();
    },
    toLocal: (lng, lat) => toLocal(lng, lat),
    landmark: (id) => landmarks.get(id),
    toLngLat: (x, y) => toLngLat(x, y),
    setVisible(v) {
      visible = v;
      for (const t of tiles.values()) if (t.mesh) t.mesh.visible = v;
      for (const m of treeMeshes) m.visible = v;
      map?.triggerRepaint();
    },
    get count() { return index ? index.tiles.reduce((s, t) => s + t.n, 0) : 0; },
  };
}
