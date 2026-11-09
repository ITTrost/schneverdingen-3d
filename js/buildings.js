// LoD2-Gebäude des LGLN als Three.js-Ebene in MapLibre.
// Geometrie kommt vorberechnet aus data/lod2 (siehe tools/build_lod2.py).
import * as THREE from '../vendor/three/three.module.min.js';

const DATA = 'data/lod2/';
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
out vec3 vN;
out vec3 vP;
out float vU;
out vec4 vInfo;
out float vBid;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  vN = aNormal.xyz;
  vU = aU * 0.1;
  vInfo = aInfo;
  vBid = aBid;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uNight;
uniform float uTile;
uniform float uSelTile;
uniform float uSel;
in vec3 vN;
in vec3 vP;
in float vU;
in vec4 vInfo;
in float vBid;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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

void main() {
  vec3 n = normalize(vN);
  float kind = vInfo.x;
  float seed = vInfo.y;
  float small = vInfo.z;
  bool wall = kind < 0.5;
  vec3 base;
  if (wall) {
    base = small > 0.5 ? mix(vec3(0.55, 0.52, 0.47), vec3(0.42, 0.33, 0.25), step(5.0, mod(seed, 10.0))) : wallColor(seed);
  } else if (n.z > 0.97) {
    base = vec3(0.47, 0.47, 0.46) + (hash(vec2(seed, 1.0)) - 0.5) * 0.08; // Flachdach
  } else {
    base = roofColor(seed);
  }

  float diff = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uGround, uSky, n.z * 0.5 + 0.5);
  float ao = wall ? mix(0.6, 1.0, smoothstep(0.0, 3.0, vP.z)) : 1.0;
  // Dächer: leichte Streifen entlang der Ziegelreihen
  if (!wall && n.z < 0.97) base *= 0.94 + 0.06 * step(0.5, fract(vP.z * 3.0));
  vec3 street = vec3(0.32, 0.24, 0.14) * uNight * (1.0 - smoothstep(0.0, 9.0, vP.z)) * (wall ? 1.0 : 0.0);
  vec3 col = base * (amb * ao + uSun * diff * 1.15 + street + vec3(0.05, 0.06, 0.09) * uNight);

  // Fenster
  if (wall && small < 0.5 && abs(n.z) < 0.4) {
    float z = vP.z - 0.9;
    float row = floor(z / 3.0);
    float fz = fract(z / 3.0);
    float cell = floor(vU / 2.7);
    float fx = fract(vU / 2.7);
    // Pixelgröße der Fassade in Metern: weit weg werden Fenster zu einem Mittelwert
    float px = max(fwidth(vU), fwidth(vP.z));
    float far = smoothstep(0.35, 0.9, px);
    vec3 glass = mix(vec3(0.15, 0.19, 0.24), uSky, 0.25) * (0.7 + 0.5 * diff);
    if (z > 0.0 && fz < 0.46 && fx > 0.28 && fx < 0.72 && vU > 0.9) {
      float h = hash(vec2(cell + vBid * 13.17 + uTile * 3.1, row + seed * 0.37));
      vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.88, 0.62), hash(vec2(h, row)));
      float lit = step(h, 0.45) * uNight;
      vec3 win = mix(glass, warm * 1.25, lit);
      vec3 avg = mix(col, mix(glass, warm, 0.45 * uNight), 0.22);
      col = mix(win, avg, far);
    } else if (z > 0.0) {
      vec3 avg = mix(col, mix(glass, vec3(1.0, 0.8, 0.5), 0.45 * uNight), 0.22);
      col = mix(col, avg, far);
    }
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
  const ready = fetch(DATA + 'index.json').then((r) => r.json()).then((d) => {
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

  async function loadTile(t) {
    const entry = { state: 'loading' };
    tiles.set(t.k, entry);
    loading++;
    onProgress?.(loading);
    try {
      const [buf, records] = await Promise.all([
        fetch(DATA + t.k + '.bin').then((r) => r.arrayBuffer()),
        fetch(DATA + t.k + '.json').then((r) => r.json()),
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
      if (n > 65535 && off % 4) off += 4 - (off % 4); // Uint32-Indizes sind ausgerichtet
      const idx = n > 65535 ? take(Uint32Array, ni) : take(Uint16Array, ni);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aNormal', new THREE.BufferAttribute(nrm, 4, true));
      geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
      geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
      geo.setAttribute('aBid', new THREE.BufferAttribute(bid, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { ...uniforms, uTile: { value: t.i } },
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
      const t = new THREE.Matrix4().makeTranslation(o[0], o[1], 0)
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
          m4.compose(new THREE.Vector3(t.x, t.y, 0), q, new THREE.Vector3(t.h, t.h, t.h));
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
    setVisible(v) {
      visible = v;
      for (const t of tiles.values()) if (t.mesh) t.mesh.visible = v;
      for (const m of treeMeshes) m.visible = v;
      map?.triggerRepaint();
    },
    get count() { return index ? index.tiles.reduce((s, t) => s + t.n, 0) : 0; },
  };
}
