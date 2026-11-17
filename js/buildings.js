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
in float aFh;
uniform float uExag;
out vec2 vUv;
flat out float vFh;
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
  vFh = aFh * 0.1;
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
uniform sampler2D uStyle;
// Zusatzwerte je Gebäude (Spalte = Gebäude):
//  Zeile 0: rgb Dachfarbe, a: Bit 7 = statt Luftbild, Bits 0-6 = Wand nur bis zu dieser Höhe (dm), darüber Dach
//  Zeile 1: rgb Markisenfarbe, a = Bits: 1 Farbe gesetzt, 2 Laden rundum, 4 kein Laden, 8 Markise ohne Streifen,
//           16 eigenes Dach (Modelldach und Wand oberhalb von 'bis' ausblenden)
//  Zeile 2: rgb Fensterrahmen (0 = keiner), a = Fensterabstand (Bits 0-1: 0 normal, 1 eng, 2 weit) | Breite << 2 (0 = Standard)
uniform sampler2D uExtra;   // je Gebäude (x) und Gebäudeteil (y): rgb Farbe, a = Material | Fenster << 4
in vec2 vUv;
flat in float vFh;
in vec3 vN;
in vec3 vP;
in float vU;
flat in vec4 vInfo;
flat in float vBid;
out vec4 outColor;

const float SHOP_GROUND = 3.8; // Höhe des Ladengeschosses (tools/build_lod2.py)

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
  vec4 ex1 = texelFetch(uExtra, ivec2(int(vBid + 0.5), 1), 0);
  vec4 ex2 = texelFetch(uExtra, ivec2(int(vBid + 0.5), 2), 0);
  float shopBits = floor(ex1.a * 255.0 + 0.5);
  bool shopWall = (infoW > 127.5 || mod(floor(shopBits / 2.0), 2.0) > 0.5) && mod(floor(shopBits / 4.0), 2.0) < 0.5;
  float part = min(mod(floor(infoW / 2.0), 64.0), float(textureSize(uStyle, 0).y - 1));
  vec4 st = texelFetch(uStyle, ivec2(int(vBid + 0.5), int(part)), 0);
  float sa = floor(st.a * 255.0 + 0.5);
  float mat = mod(sa, 16.0);          // 0 Regel, 1 Klinker, 2 Putz, 3 Feldstein, 4 Holz, 5 Fachwerk
  float win = floor(sa / 16.0);       // 0 Regel, 1 keine, 2 Wohnhaus, 3 Kirche, 4 Kirchturm, 5 Lichtband
  bool wall = kind < 0.5;
  vec2 uv = vec2(vU, vP.z);
  float px = max(fwidth(vU), fwidth(vP.z));
  vec4 rs = texelFetch(uExtra, ivec2(int(vBid + 0.5), 0), 0);
  float ra = floor(rs.a * 255.0 + 0.5);
  bool roofOverride = ra > 127.5;
  float wallTop = mod(ra, 128.0) * 0.1;
  bool ownRoof = mod(floor(shopBits / 16.0), 2.0) > 0.5;
  if (ownRoof && (!wall || (wallTop > 0.5 && vP.z > wallTop))) discard;   // wird durch das eigene Dach ersetzt
  bool roofBand = wall && wallTop > 0.5 && vP.z > wallTop;   // Wand oberhalb der Traufe als Dach zeichnen
  vec3 base;
  if (roofBand) {
    base = (roofOverride ? rs.rgb : vec3(0.32, 0.25, 0.21)) * (0.9 + 0.1 * step(0.5, fract(vP.z * 3.0)));
  } else if (wall && mat > 0.5) {
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
  if (!wall && roofOverride) {
    base = rs.rgb * (0.94 + 0.06 * step(0.5, fract(vP.z * 3.0)));
    col = base * (amb + uSun * diff * 1.15 + vec3(0.05, 0.06, 0.09) * uNight);
  } else if (!wall && uHasTex > 0.5 && hasTex > 0.5) {
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

  // Ladenfront im Erdgeschoss: Sockel, Schaufenster mit Sprossen, Markise, Schildband
  bool shopFront = shopWall && (cls == 0.0 || cls == 5.0) && abs(n.z) < 0.4 && vP.z < SHOP_GROUND;
  if (shopFront) {
    float z = vP.z;
    float k = mod(seed, 6.0);
    vec3 awn = k < 1.0 ? vec3(0.62, 0.13, 0.13) : k < 2.0 ? vec3(0.17, 0.36, 0.22) : k < 3.0 ? vec3(0.13, 0.22, 0.36)
             : k < 4.0 ? vec3(0.44, 0.11, 0.18) : k < 5.0 ? vec3(0.78, 0.69, 0.52) : vec3(0.30, 0.30, 0.31);
    if (mod(shopBits, 2.0) > 0.5) awn = ex1.rgb;
    bool plain = mod(floor(shopBits / 8.0), 2.0) > 0.5;
    vec3 lightIn = amb * ao + uSun * diff * 1.15;
    float frame = 1.0 - smoothstep(0.03, 0.12, px);      // Rahmen nur aus der Nähe
    float mull = step(fract(vU / 1.8), 0.045) * frame;
    bool hasFrameC = ex2.r + ex2.g + ex2.b > 0.01;
    vec3 inside = mix(vec3(0.16, 0.15, 0.14), vec3(1.0, 0.84, 0.58), 0.18 + 0.7 * uNight);
    vec3 shopGlass = mix(inside, uSky * 0.95, 0.45 * (1.0 - uNight)) * (0.8 + 0.35 * diff * (1.0 - uNight));
    if (z < 0.35) {
      col = vec3(0.30, 0.29, 0.28) * lightIn;                                   // Sockel
    } else if (z < SHOP_GROUND - 1.05) {
      col = mix(shopGlass + inside * 0.35 * uNight, (hasFrameC ? ex2.rgb : vec3(0.20, 0.20, 0.21)) * lightIn, mull);
    } else if (z < SHOP_GROUND - 0.45) {
      float stripe = plain ? 0.0 : step(0.5, fract(vU / 0.45)) * frame;          // Markise
      float drop = smoothstep(SHOP_GROUND - 1.05, SHOP_GROUND - 0.95, z);
      col = mix(awn, mix(awn, vec3(0.92, 0.90, 0.86), 0.55), stripe * 0.6) * lightIn * mix(0.7, 1.0, drop);
    } else {
      col = mix(base, base * 0.8, 0.5) * lightIn;                               // Schildband
    }
  }

  // Wohnfenster: Geschosshöhe aus den Daten, Fensterraster mittig in der Wand
  if (roofBand) win = 1.0;
  if (wall && win == 2.0 && abs(n.z) < 0.4 && !shopFront && vU >= 0.0) {
    float fh = max(vFh, 2.4);
    float z0 = shopWall ? SHOP_GROUND : 0.0;
    float z = vP.z - z0;
    float row = floor(z / fh);
    float fz = fract(z / fh);
    float ea = floor(ex2.a * 255.0 + 0.5);
    float sp = mod(ea, 4.0);
    float cw = sp == 1.0 ? 1.35 : sp == 2.0 ? 5.4 : 2.7;                 // Fensterachse in Metern
    float ww = floor(ea / 4.0) > 0.5 ? floor(ea / 4.0) / 63.0 : 0.44;    // Fensterbreite als Anteil der Achse
    float cell = floor(vU / cw);
    float fx = fract(vU / cw);
    float sill = 0.85 / fh, head = min(0.9, (0.85 + 1.35) / fh);
    float x0 = 0.5 - ww * 0.5, x1 = 0.5 + ww * 0.5;
    bool hasFrame = ex2.r + ex2.g + ex2.b > 0.01;
    float fr = 0.07 / cw, frz = 0.07 / fh;                                 // Rahmenbreite 7 cm
    if (hasFrame && z > 0.0 && fz > sill - frz && fz < head + frz && fx > x0 - fr && fx < x1 + fr
        && !(fz > sill && fz < head && fx > x0 && fx < x1)) {
      col = mix(ex2.rgb * (amb * ao + uSun * diff * 1.15), col, far);
    } else if (z > 0.0 && fz > sill && fz < head && fx > x0 && fx < x1) {
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
const SHOP_GROUND = 3.8; // Höhe des Ladengeschosses, wie im Shader und in tools/build_lod2.py
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
  // In Straßenfotos gemessene Fassadenfarben (tools/facades_mapillary.py): id -> [Farbe, Material, Bilder]
  let facades = new Map();
  // tools/facades_mapillary.py ist experimentell; data/facades.json wird derzeit nicht erzeugt
  const facadesReady = Promise.resolve();

  const ready = Promise.all([landmarksReady, facadesReady]).then(() => fetch(v(DATA + 'index.json'))).then((r) => r.json()).then((d) => {
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
    const extra = new Uint8Array(w * 3 * 4); // Zeilen siehe uExtra im Shader
    records.forEach((rec, bid) => {
      const fa = facades.get(rec.id);
      const lm = landmarks.get(rec.id) || (fa && { wand: { farbe: fa[0], material: fa[1] }, gemessen: true });
      if (!lm) return;
      const top = lm.wand?.bis ? Math.max(1, Math.min(127, Math.round(lm.wand.bis * 10))) : 0;
      extra.set([...(lm.dach?.farbe ? hexRgb(lm.dach.farbe) : [0, 0, 0]), (lm.dach?.farbe ? 128 : 0) | top], bid * 4);
      const laden = lm.laden || {};
      let bits = 0;
      if (laden.markise) bits |= 1;
      if (laden.modus === 'rundum') bits |= 2;
      if (laden.modus === 'aus') bits |= 4;
      if (laden.streifen === false) bits |= 8;
      if (lm.dach?.form === 'walm') bits |= 16;
      extra.set([...(laden.markise ? hexRgb(laden.markise) : [0, 0, 0]), bits], (w + bid) * 4);
      const fo = typeof lm.fenster === 'object' ? lm.fenster : {};
      const sp = { eng: 1, weit: 2 }[fo.abstand] || 0;
      const wb = fo.breite ? Math.max(1, Math.min(63, Math.round(fo.breite * 63))) : 0;
      extra.set([...(fo.rahmen ? hexRgb(fo.rahmen) : [0, 0, 0]), sp | (wb << 2)], (2 * w + bid) * 4);
      const heights = rec.p || [rec.h];
      for (let row = 0; row < rows; row++) {
        const h = heights[Math.min(row, heights.length - 1)] ?? rec.h;
        // spätere Regeln (höheres abHoehe) gewinnen
        const rule = [lm, ...(lm.teile || []).filter((t) => h != null && h >= t.abHoehe).sort((a, b) => a.abHoehe - b.abHoehe)]
          .reduce((acc, r) => ({ wand: r.wand || acc.wand, fenster: r.fenster || acc.fenster }), {});
        const fart = typeof rule.fenster === 'object' ? rule.fenster.art : rule.fenster;
        const [r, g, b] = hexRgb(rule.wand?.farbe);
        const o = (row * w + bid) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b;
        data[o + 3] = (MATERIALS[rule.wand?.material] || 0) | ((WINDOWS[fart] || 0) << 4);
      }
    });
    const tex = new THREE.DataTexture(data, w, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const exTex = new THREE.DataTexture(extra, w, 3, THREE.RGBAFormat, THREE.UnsignedByteType);
    exTex.minFilter = exTex.magFilter = THREE.NearestFilter;
    exTex.needsUpdate = true;
    return [tex, exTex];
  }

  // Entzerrte Fassadenfotos (data/landmarks.json -> fotos), 5 cm vor der LoD2-Wand
  const photoMeshes = [];
  const photoMat = (tex) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `
      precision highp float;
      uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
      in vec3 position; in vec2 uv; in vec3 normal;
      out vec2 vUv; out vec3 vN;
      void main() { vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uMap; uniform vec3 uSunDir; uniform vec3 uSun; uniform vec3 uSky; uniform vec3 uGround; uniform float uNight;
      in vec2 vUv; in vec3 vN; out vec4 outColor;
      void main() {
        vec3 tex = texture(uMap, vUv).rgb;
        float diff = max(dot(normalize(vN), uSunDir), 0.0);
        vec3 amb = mix(uGround, uSky, 0.5);
        // Licht steckt schon im Foto: nur leicht nachbeleuchten, nachts abdunkeln
        outColor = vec4(tex * (amb * 0.6 + uSun * (0.55 + 0.35 * diff)) * 1.12, 1.0);
      }`,
    uniforms: { uMap: { value: tex }, uSunDir: uniforms.uSunDir, uSun: uniforms.uSun, uSky: uniforms.uSky, uGround: uniforms.uGround, uNight: uniforms.uNight },
    side: THREE.DoubleSide,
  });
  function addFacadePhotos() {
    for (const lm of landmarks.values()) {
      if (!lm.fotos || lm.basis == null) continue;
      const lift = (lm.basis - REF) * EXAG;
      for (const f of lm.fotos) {
        const pts = f.wand.map(([lng, lat, h, u, vv]) => {
          const [x, y] = toLocal(lng, lat);
          return { x, y, z: h + lift, u, v: vv };
        });
        const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.u, p.v)), []);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.u, p.v]), 2));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [f.normale[0], f.normale[1], 0]), 3));
        geo.setIndex(tris.flat());
        const tex = texLoader.load(v(f.bild), () => map?.triggerRepaint());
        tex.colorSpace = THREE.NoColorSpace;
        tex.anisotropy = 8;
        const mesh = new THREE.Mesh(geo, photoMat(tex));
        mesh.frustumCulled = false;
        mesh.visible = visible;
        scene.add(mesh);
        photoMeshes.push(mesh);
      }
    }
  }

  // ---------- Schilder und Schriftbögen (data/landmarks.json: laden.schild, schilder, bogen) ----------
  const decor = new Map(); // Gebäude-ID -> [Mesh]
  const decorVisible = () => visible;
  const DECOR_VERT = `
    precision highp float;
    uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
    in vec3 position; in vec2 uv; in vec3 normal;
    out vec2 vUv; out vec3 vN;
    void main() { vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const DECOR_FRAG = `
    precision highp float;
    uniform sampler2D uMap; uniform vec3 uSunDir; uniform vec3 uSun; uniform vec3 uSky; uniform vec3 uGround; uniform float uNight;
    in vec2 vUv; in vec3 vN; out vec4 outColor;
    void main() {
      vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);   // Rückseite nicht spiegeln
      vec3 tex = texture(uMap, uv).rgb;
      vec3 n = normalize(gl_FrontFacing ? vN : -vN);
      float diff = max(dot(n, uSunDir), 0.0);
      vec3 amb = mix(uGround, uSky, 0.6);
      outColor = vec4(tex * (amb * 0.8 + uSun * (0.45 + 0.6 * diff)) + tex * uNight * 0.45, 1.0);
    }`;
  const decorMat = (tex) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: DECOR_VERT, fragmentShader: DECOR_FRAG, side: THREE.DoubleSide,
    uniforms: { uMap: { value: tex }, uSunDir: uniforms.uSunDir, uSun: uniforms.uSun, uSky: uniforms.uSky, uGround: uniforms.uGround, uNight: uniforms.uNight },
  });

  /** Schrift als Textur: Hintergrundfarbe, Textfarbe, Seitenverhältnis Breite/Höhe. */
  function textTexture(text, bg, fg, aspect, font = 'Bitter, Georgia, serif') {
    const H = 128;
    const W = Math.min(2048, Math.max(64, Math.round(H * aspect / 8) * 8));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    if (text) {
      let size = H * 0.66;
      g.font = `700 ${size}px ${font}`;
      while (g.measureText(text).width > W * 0.9 && size > 10) { size *= 0.92; g.font = `700 ${size}px ${font}`; }
      g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, W / 2, H * 0.54);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  }

  /** Wände eines Gebäudes nach Richtung gruppieren (lokale Meter, Höhe über Gebäudegrund). */
  function wallGroups(entry, bidx) {
    const { pos, nrm, info, bid, base, cx, cy, q } = entry.geo;
    const groups = new Map();
    let lift = 0;
    for (let i = 0; i < bid.length; i++) {
      if (bid[i] !== bidx || info[i * 4] !== 0) continue;
      const nx = nrm[i * 4] / 127, ny = nrm[i * 4 + 1] / 127, nz = nrm[i * 4 + 2] / 127;
      if (Math.abs(nz) > 0.3) continue;
      lift = (base[i] * 0.1 - REF) * EXAG;
      const az = (Math.atan2(nx, ny) * 180 / Math.PI + 360) % 360;
      const key = Math.round(az / 10) % 36;
      if (!groups.has(key)) groups.set(key, { nx: 0, ny: 0, pts: [], shop: false });
      const gr = groups.get(key);
      gr.nx += nx; gr.ny += ny;
      gr.pts.push([cx + pos[i * 3] * q, cy + pos[i * 3 + 1] * q]);
      if (info[i * 4 + 3] & 128) gr.shop = true;
    }
    return [...groups.values()].map((gr) => {
      const l = Math.hypot(gr.nx, gr.ny) || 1;
      const nx = gr.nx / l, ny = gr.ny / l, tx = -ny, ty = nx;
      const us = gr.pts.map(([x, y]) => x * tx + y * ty);
      const ds = gr.pts.map(([x, y]) => x * nx + y * ny);
      return { nx, ny, tx, ty, az: (Math.atan2(nx, ny) * 180 / Math.PI + 360) % 360,
        u0: Math.min(...us), u1: Math.max(...us), d: Math.max(...ds), shop: gr.shop, lift };
    }).filter((gr) => gr.u1 - gr.u0 > 0.8);
  }

  function pickWall(groups, richtung) {
    if (richtung != null) {
      const diff = (gr) => Math.abs(((gr.az - richtung + 540) % 360) - 180);
      return groups.slice().sort((a, b) => diff(a) - diff(b))[0];
    }
    const pool = groups.some((gr) => gr.shop) ? groups.filter((gr) => gr.shop) : groups;
    return pool.slice().sort((a, b) => (b.u1 - b.u0) - (a.u1 - a.u0))[0];
  }

  function addDecorMesh(id, positions, uvs, normal, indices, tex) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_, i) => normal[i % 3]), 3));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, decorMat(tex));
    mesh.frustumCulled = false;
    mesh.visible = decorVisible();
    scene.add(mesh);
    if (!decor.has(id)) decor.set(id, []);
    decor.get(id).push(mesh);
  }

  /** Flaches Schild vor einer Wand. */
  function addSign(id, wall, s) {
    const text = s.text || '';
    const width = s.breite || Math.min((wall.u1 - wall.u0) * 0.85, 0.6 + text.length * 0.3);
    const height = s.hoehe2 || 0.42;
    const zc = (s.hoehe ?? SHOP_GROUND - 0.22) + wall.lift;
    const uc = (wall.u0 + wall.u1) / 2 + (s.versatz || 0);
    const d = wall.d + (s.abstand ?? 0.06);
    const P = (du, dz) => [wall.nx * d + wall.tx * (uc + du), wall.ny * d + wall.ty * (uc + du), zc + dz];
    const pts = [P(-width / 2, -height / 2), P(width / 2, -height / 2), P(width / 2, height / 2), P(-width / 2, height / 2)];
    addDecorMesh(id, pts.flat(), [0, 0, 1, 0, 1, 1, 0, 1], [wall.nx, wall.ny, 0], [0, 1, 2, 0, 2, 3],
      textTexture(text, s.farbe || '#2b2b2b', s.textFarbe || '#ffffff', width / height));
  }

  /** Schriftbogen (z. B. „VENEZIA“) als gebogenes Band mit zwei Stützen. */
  function addArch(id, wall, b) {
    const B = b.breite || 4, R = b.stich || 1.0, band = b.band || 0.55;
    const z0 = (b.unten ?? SHOP_GROUND) + wall.lift;
    const uc = (wall.u0 + wall.u1) / 2 + (b.versatz || 0);
    const d = wall.d + (b.abstand ?? 0.35);
    const P = (du, z) => [wall.nx * d + wall.tx * (uc + du), wall.ny * d + wall.ty * (uc + du), z];
    const N = 32, pos = [], uv = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const th = Math.PI * (1 - i / N);
      pos.push(...P(Math.cos(th) * B / 2, z0 + Math.sin(th) * R + band * 0.5));            // außen
      pos.push(...P(Math.cos(th) * (B / 2 - band), z0 + Math.sin(th) * (R - band * 0.6))); // innen
      uv.push(i / N, 1, i / N, 0);
      if (i < N) idx.push(2 * i, 2 * i + 1, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 2);
    }
    const arcLen = Math.PI * (B / 2 + R) / 2;
    addDecorMesh(id, pos, uv, [wall.nx, wall.ny, 0], idx, textTexture(b.text || '', b.farbe || '#f4f1ea', b.textFarbe || '#b3261e', arcLen / band));
    // Stützen bis auf das Vordach
    const plain = textTexture('', b.farbe || '#f4f1ea', '#000', 1);
    for (const side of [-1, 1]) {
      const u = side * (B / 2 - band / 2), w = 0.07, zb = z0 - (b.stuetze ?? 0.5);
      const pts = [P(u - w, zb), P(u + w, zb), P(u + w, z0 + band * 0.5), P(u - w, z0 + band * 0.5)];
      addDecorMesh(id, pts.flat(), [0, 0, 1, 0, 1, 1, 0, 1], [wall.nx, wall.ny, 0], [0, 1, 2, 0, 2, 3], plain);
    }
  }

  /** Kachelmuster für Dachziegel (eine Textur = 8 × 8 Ziegel). */
  function tileTexture(hex) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const [r, gg, b] = hexRgb(hex || '#4e443b');
    for (let row = 0; row < 8; row++) {
      for (let k = 0; k < 9; k++) {
        const f = 0.82 + ((row * 7 + k * 13) % 9) / 30;
        g.fillStyle = `rgb(${r * f | 0},${gg * f | 0},${b * f | 0})`;
        const x = (k - (row % 2) * 0.5) * 32;
        g.fillRect(x, row * 32, 32, 32);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, row * 32, 2, 32);                    // Fuge senkrecht
      }
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(0, row * 32 + 27, 256, 5);                // Schatten unter jeder Ziegelreihe
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  }

  /** Eigenes Walmdach über der Grundfläche (konvexe Hülle, ausgerichtet am kleinsten umschließenden Rechteck). */
  function addHipRoof(id, entry, bidx, lm) {
    const { pos, info, bid, base, cx, cy, q } = entry.geo;
    const pts = [];
    let lift = 0;
    for (let i = 0; i < bid.length; i++) {
      if (bid[i] !== bidx || info[i * 4] !== 0) continue;
      pts.push([cx + pos[i * 3] * q, cy + pos[i * 3 + 1] * q]);
      lift = (base[i] * 0.1 - REF) * EXAG;
    }
    if (pts.length < 3) return;
    // konvexe Hülle (Monotone Chain)
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => { const h = []; for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
    let hull = [...half(pts), ...half(pts.slice().reverse())];
    // Überstand: Hülle nach außen schieben
    const over = lm.dach.ueberstand ?? 0.5;
    const c0 = hull.reduce((a, p) => [a[0] + p[0] / hull.length, a[1] + p[1] / hull.length], [0, 0]);
    hull = hull.map(([x, y]) => { const dx = x - c0[0], dy = y - c0[1], l = Math.hypot(dx, dy) || 1; return [x + dx / l * over, y + dy / l * over]; });
    // kleinstes umschließendes Rechteck -> First entlang der langen Seite
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
      const l = Math.hypot(x2 - x1, y2 - y1); if (l < 1e-6) continue;
      const ax = [(x2 - x1) / l, (y2 - y1) / l], ay = [-ax[1], ax[0]];
      const us = hull.map((p) => p[0] * ax[0] + p[1] * ax[1]), vs = hull.map((p) => p[0] * ay[0] + p[1] * ay[1]);
      const area = (Math.max(...us) - Math.min(...us)) * (Math.max(...vs) - Math.min(...vs));
      if (!best || area < best.area) best = { area, ax, ay, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
    }
    let { ax, ay, u0, u1, v0, v1 } = best;
    if (v1 - v0 > u1 - u0) { [ax, ay] = [ay, ax.map((x) => -x)]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
    const L = u1 - u0, W = v1 - v0, um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    const zE = (lm.wand?.bis ?? SHOP_GROUND) + lift;
    const zR = zE + (W / 2) * Math.tan(((lm.dach.neigung ?? 38) * Math.PI) / 180);
    const ridge = ([x, y]) => {
      const u = Math.max(um - (L - W) / 2, Math.min(um + (L - W) / 2, x * ax[0] + y * ax[1]));
      return [ax[0] * u + ay[0] * vm, ax[1] * u + ay[1] * vm, zR];
    };
    const posA = [], uvA = [], idx = [];
    const tileTex = tileTexture(lm.dach.farbe);
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const pa = [a[0], a[1], zE], pb = [b[0], b[1], zE], ra = ridge(a), rb = ridge(b);
      const ex = [b[0] - a[0], b[1] - a[1]], el = Math.hypot(...ex) || 1, e = [ex[0] / el, ex[1] / el];
      const nIn = [-e[1], e[0]];                                   // zur Mitte
      const quad = [pa, pb, rb, ra];
      const base0 = posA.length / 3;
      for (const p of quad) {
        posA.push(...p);
        const dist = (p[0] - a[0]) * nIn[0] + (p[1] - a[1]) * nIn[1];
        uvA.push(((p[0] - a[0]) * e[0] + (p[1] - a[1]) * e[1]) / 2.4, (dist / Math.cos(((lm.dach.neigung ?? 38) * Math.PI) / 180)) / 2.0);
      }
      idx.push(base0, base0 + 1, base0 + 2, base0, base0 + 2, base0 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvA, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, decorMat(tileTex));
    mesh.frustumCulled = false; mesh.visible = decorVisible(); scene.add(mesh);
    if (!decor.has(id)) decor.set(id, []);
    decor.get(id).push(mesh);
    // Traufbrett rundum
    const fascia = lm.dach.traufe;
    if (fascia) {
      const fp = [], fu = [], fi = [];
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length], k = fp.length / 3;
        fp.push(a[0], a[1], zE - 0.38, b[0], b[1], zE - 0.38, b[0], b[1], zE + 0.02, a[0], a[1], zE + 0.02);
        fu.push(0, 0, 1, 0, 1, 1, 0, 1);
        fi.push(k, k + 1, k + 2, k, k + 2, k + 3);
      }
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
      g2.setAttribute('uv', new THREE.Float32BufferAttribute(fu, 2));
      g2.setIndex(fi);
      g2.computeVertexNormals();
      const m2 = new THREE.Mesh(g2, decorMat(textTexture('', fascia, '#000', 1)));
      m2.frustumCulled = false; m2.visible = decorVisible(); scene.add(m2);
      decor.get(id).push(m2);
    }
  }

  function clearDecor(id) {
    for (const m of decor.get(id) || []) { scene.remove(m); m.geometry.dispose(); m.material.uniforms.uMap.value.dispose(); m.material.dispose(); }
    decor.delete(id);
  }

  function buildDecor(entry, bidx) {
    const rec = entry.records[bidx];
    const lm = landmarks.get(rec.id);
    clearDecor(rec.id);
    if (!lm || !scene) return;
    const signs = [...(lm.schilder || [])];
    if (lm.laden?.schild) signs.unshift({ text: lm.laden.schild, farbe: lm.laden.schildFarbe, textFarbe: lm.laden.textFarbe, richtung: lm.laden.richtung });
    if (lm.dach?.form === 'walm') addHipRoof(rec.id, entry, bidx, lm);
    if (!signs.length && !lm.bogen) { map?.triggerRepaint(); return; }
    const groups = wallGroups(entry, bidx);
    if (!groups.length) return;
    for (const s of signs) addSign(rec.id, pickWall(groups, s.richtung), s);
    if (lm.bogen) addArch(rec.id, pickWall(groups, lm.bogen.richtung), lm.bogen);
    map?.triggerRepaint();
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
      const fh = take(Uint8Array, n);
      // Geländehöhe (überhöht) direkt in die Positionen einrechnen, damit auch das Anklicken stimmt
      for (let i = 0; i < n; i++) pos[i * 3 + 2] += Math.round(((base[i] * 0.1 - REF) * EXAG) / q);
      if (off % 4) off += 4 - (off % 4); // Indizes sind auf 4 Byte ausgerichtet
      const idx = n > 65535 ? take(Uint32Array, ni) : take(Uint16Array, ni);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aNormal', new THREE.BufferAttribute(nrm, 4, true));
      geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
      geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
      geo.setAttribute('aBid', new THREE.BufferAttribute(bid, 1));
      geo.setAttribute('aBase', new THREE.BufferAttribute(base, 1));
      geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2, true));
      geo.setAttribute('aFh', new THREE.BufferAttribute(fh, 1));
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
          ...(([st, ex]) => ({ uStyle: { value: st }, uExtra: { value: ex } }))(styleTexture(records)),
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, cy, 0);
      mesh.scale.set(q, q, q);
      mesh.updateMatrixWorld(true);
      mesh.userData = { tile: t };
      mesh.visible = visible;
      scene.add(mesh);
      Object.assign(entry, { state: 'ready', mesh, records, tile: t, geo: { pos, nrm, info, bid, base, cx, cy, q } });
      records.forEach((rec, i) => { if (landmarks.has(rec.id)) buildDecor(entry, i); });
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
      addFacadePhotos();
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
    /** Aussehen eines Gebäudes setzen (null = zurück zur Regel) und sofort neu zeichnen. */
    setLandmark(id, entry) {
      if (entry) landmarks.set(id, entry); else landmarks.delete(id);
      for (const t of tiles.values()) {
        if (t.state !== 'ready') continue;
        const bidx = t.records.findIndex((r) => r.id === id);
        if (bidx < 0) continue;
        const u = t.mesh.material.uniforms;
        u.uStyle.value.dispose(); u.uExtra.value.dispose();
        [u.uStyle.value, u.uExtra.value] = styleTexture(t.records);
        buildDecor(t, bidx);
      }
      map?.triggerRepaint();
    },
    landmarks: () => landmarks,
    ready,
    facade: (id) => facades.get(id),
    toLngLat: (x, y) => toLngLat(x, y),
    setVisible(v) {
      visible = v;
      for (const t of tiles.values()) if (t.mesh) t.mesh.visible = v;
      for (const m of treeMeshes) m.visible = v;
      for (const m of photoMeshes) m.visible = v;
      for (const list of decor.values()) for (const m of list) m.visible = v;
      map?.triggerRepaint();
    },
    get count() { return index ? index.tiles.reduce((s, t) => s + t.n, 0) : 0; },
  };
}
