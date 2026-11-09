// Kartenebenen: Definition, Einbau in den Stil und Schalter im Panel.
import { BBOX, overpass } from './config.js';

const SRC = 'openmaptiles';
const FONT = ['Noto Sans Regular'];

const ROAD_COLORS = [
  'match', ['get', 'class'],
  ['motorway', 'trunk'], '#c2412d',
  'primary', '#d9682b',
  'secondary', '#e09a2c',
  'tertiary', '#c9b52f',
  ['minor', 'service'], '#7d8a80',
  'track', '#9b7a4c',
  'path', '#9b7a4c',
  '#7d8a80',
];

export const LAYERS = [
  {
    id: 'aerial', name: 'Luftbild', desc: 'DOP20 des LGLN, 20 cm', swatch: 'linear-gradient(135deg,#5b6b47,#a39a7a)', on: false,
    layers: ['sv-aerial'],
  },
  {
    id: 'buildings', name: '3D-Gebäude', desc: 'LGLN-Gebäudemodell mit Dächern', swatch: 'linear-gradient(135deg,#9a3f2b 50%,#8e4a36 50%)', on: true,
    layers: [],
    toggle: (map, on, ctx) => {
      ctx.buildings.setVisible(on);
      if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', on ? 'none' : 'visible');
    },
  },
  {
    id: 'heath', name: 'Heideflächen', desc: 'Besenheide und Zwergstrauchheide', swatch: '#a35aa0', on: true,
    layers: ['sv-heath', 'sv-heath-line'],
  },
  {
    id: 'forest', name: 'Wald', desc: 'Kiefern- und Mischwald', swatch: '#3d7a52', on: false,
    layers: ['sv-forest'],
  },
  {
    id: 'water', name: 'Gewässer & Moore', desc: 'Seen, Bäche, Moorflächen', swatch: '#4f8fae', on: false,
    layers: ['sv-wetland', 'sv-water', 'sv-waterway'],
  },
  {
    id: 'reserve', name: 'Naturschutzgebiete', desc: 'u. a. NSG Lüneburger Heide', swatch: 'repeating-linear-gradient(45deg,#2e6b3f 0 3px,transparent 3px 6px)', on: false,
    layers: ['sv-reserve-fill', 'sv-reserve-line'],
  },
  {
    id: 'roads', name: 'Straßen nach Typ', desc: 'Bundes-, Landes-, Kreis-, Ortsstraßen', swatch: 'linear-gradient(90deg,#c2412d,#e09a2c,#c9b52f,#7d8a80)', on: false,
    layers: ['sv-roads'],
  },
  {
    id: 'transit', name: 'Bahn & Bus', desc: 'Heidebahn und Haltestellen', swatch: '#2b3a67', on: false,
    layers: ['sv-rail', 'sv-busstops', 'sv-busstop-labels'],
  },
  {
    id: 'hiking', name: 'Wanderwege', desc: 'Markierte Routen und Pfade', swatch: '#b4462a', on: false,
    layers: ['sv-paths', 'sv-routes-casing', 'sv-routes', 'sv-route-labels'],
    onEnable: loadHikingRoutes,
  },
  {
    id: 'boundary', name: 'Gemeindegrenze', desc: 'Stadtgebiet Schneverdingen', swatch: '#8d3f8a', on: true,
    layers: ['sv-boundary'],
  },
];

/** Eigene Quellen und Ebenen in den geladenen Stil einbauen. */
export function installLayers(map, gemeinde, buildings) {
  const style = map.getStyle();
  const firstRoad = style.layers.find((l) => l['source-layer'] === 'transportation')?.id;
  const firstSymbol = style.layers.find((l) => l.type === 'symbol')?.id;

  // Einige POI-Symbole fehlen im Sprite des Grundstils: leer ersetzen statt Warnungen.
  map.on('styleimagemissing', (e) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  // Natural-Earth-Relief wird bei Stadt-Zoom nicht gebraucht.
  if (map.getLayer('natural_earth')) map.removeLayer('natural_earth');

  // Die OSM-Klötzchen werden durch das LGLN-Gebäudemodell ersetzt (js/buildings.js).
  if (map.getLayer('building-3d')) map.setLayoutProperty('building-3d', 'visibility', 'none');

  // Luftbild (LGLN, Open Data)
  map.addSource('lgln-dop', {
    type: 'raster',
    tiles: [
      'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
      + '&LAYERS=ni_dop20&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg',
    ],
    tileSize: 512,
    minzoom: 10,
    maxzoom: 20,
    attribution: '© <a href="https://ni-lgln-opengeodata.hub.arcgis.com/" target="_blank" rel="noopener">GeoBasis-DE/LGLN</a> (CC BY 4.0)',
  });
  map.addLayer({ id: 'sv-aerial', type: 'raster', source: 'lgln-dop', layout: { visibility: 'none' } }, firstRoad);

  const add = (layer, before = firstRoad) => map.addLayer({ ...layer, layout: { visibility: 'none', ...(layer.layout || {}) } }, before);

  add({ id: 'sv-forest', type: 'fill', source: SRC, 'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], 'wood'],
    paint: { 'fill-color': '#3d7a52', 'fill-opacity': 0.5 } });

  add({ id: 'sv-heath', type: 'fill', source: SRC, 'source-layer': 'landcover',
    filter: ['==', ['get', 'subclass'], 'heath'],
    paint: { 'fill-color': '#b04fb0', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.75, 17, 0.55] } });
  add({ id: 'sv-heath-line', type: 'line', source: SRC, 'source-layer': 'landcover',
    filter: ['==', ['get', 'subclass'], 'heath'],
    paint: { 'line-color': '#7d3279', 'line-width': 1, 'line-opacity': 0.6 } });

  add({ id: 'sv-wetland', type: 'fill', source: SRC, 'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], 'wetland'],
    paint: { 'fill-color': '#6f8f6a', 'fill-opacity': 0.55, 'fill-outline-color': '#3f6a5a' } });
  add({ id: 'sv-water', type: 'fill', source: SRC, 'source-layer': 'water',
    paint: { 'fill-color': '#3f86b0', 'fill-opacity': 0.85 } });
  add({ id: 'sv-waterway', type: 'line', source: SRC, 'source-layer': 'waterway',
    paint: { 'line-color': '#3f86b0', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 17, 4] } });

  add({ id: 'sv-reserve-fill', type: 'fill', source: SRC, 'source-layer': 'park',
    paint: { 'fill-color': '#2e6b3f', 'fill-opacity': 0.08 } });
  add({ id: 'sv-reserve-line', type: 'line', source: SRC, 'source-layer': 'park',
    paint: { 'line-color': '#2e6b3f', 'line-width': 2.2, 'line-dasharray': [3, 2], 'line-opacity': 0.85 } });

  map.addSource('sv-gemeinde', { type: 'geojson', data: gemeinde });
  add({ id: 'sv-boundary', type: 'line', source: 'sv-gemeinde',
    paint: { 'line-color': '#8d3f8a', 'line-width': 3, 'line-dasharray': [4, 2, 1, 2], 'line-opacity': 0.9 } },
  firstSymbol);

  // Linien über dem Grundstil, unter den Beschriftungen
  add({ id: 'sv-paths', type: 'line', source: SRC, 'source-layer': 'transportation',
    filter: ['match', ['get', 'class'], ['path', 'track'], true, false],
    paint: { 'line-color': '#9b5a2a', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 2.4], 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 } },
  firstSymbol);

  add({ id: 'sv-roads', type: 'line', source: SRC, 'source-layer': 'transportation',
    filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROAD_COLORS,
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, ['match', ['get', 'class'], ['primary', 'trunk'], 2.5, 'secondary', 2, 1],
        18, ['match', ['get', 'class'], ['primary', 'trunk'], 16, 'secondary', 13, 'tertiary', 11, 7]],
    } }, firstSymbol);

  add({ id: 'sv-rail', type: 'line', source: SRC, 'source-layer': 'transportation',
    filter: ['match', ['get', 'class'], ['rail', 'transit'], true, false],
    paint: { 'line-color': '#2b3a67', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 17, 5] } }, firstSymbol);

  // Wanderrouten (werden bei Bedarf per Overpass geladen)
  map.addSource('sv-hiking', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  add({ id: 'sv-routes-casing', type: 'line', source: 'sv-hiking',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 17, 8], 'line-opacity': 0.8 } }, firstSymbol);
  add({ id: 'sv-routes', type: 'line', source: 'sv-hiking',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'colour'], '#b4462a'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 17, 5] } }, firstSymbol);
  map.addLayer({ id: 'sv-route-labels', type: 'symbol', source: 'sv-hiking',
    layout: { visibility: 'none', 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'symbol-spacing': 400 },
    paint: { 'text-color': '#7a2c18', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });

  // Bushaltestellen (oberste Ebene)
  map.addLayer({ id: 'sv-busstops', type: 'circle', source: SRC, 'source-layer': 'poi',
    filter: ['match', ['get', 'class'], ['bus', 'railway'], true, false],
    layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 7], 'circle-color': '#2b3a67', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'sv-busstop-labels', type: 'symbol', source: SRC, 'source-layer': 'poi', minzoom: 14.5,
    filter: ['match', ['get', 'class'], ['bus', 'railway'], true, false],
    layout: { visibility: 'none', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
    paint: { 'text-color': '#2b3a67', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });

  // Hervorgehobenes Gebäude
  map.addSource('sv-selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'sv-selected-3d', type: 'fill-extrusion', source: 'sv-selected',
    paint: {
      'fill-extrusion-color': '#8d3f8a',
      'fill-extrusion-height': ['+', ['coalesce', ['get', 'render_height'], 6], 0.4],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.95,
    } }, firstSymbol);
  map.addLayer({ id: 'sv-selected-line', type: 'line', source: 'sv-selected',
    paint: { 'line-color': '#8d3f8a', 'line-width': 3 } }, firstSymbol);

  // Alles außerhalb der Gemeinde blass überdecken (oberste Ebene, auch über Beschriftungen).
  // MapLibre erkennt Löcher nur an der Drehrichtung: Außenringe gegen, Löcher im Uhrzeigersinn.
  const area = (ring) => ring.reduce((s, [x1, y1], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length];
    return s + (x1 * y2 - x2 * y1);
  }, 0);
  const ccw = (ring) => (area(ring) > 0 ? ring : [...ring].reverse());
  const cw = (ring) => (area(ring) < 0 ? ring : [...ring].reverse());
  const polys = gemeinde.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
  const outer = ccw([[8.9, 52.6], [10.7, 52.6], [10.7, 53.7], [8.9, 53.7], [8.9, 52.6]]);
  const mask = [
    [outer, ...polys.map((p) => cw(p[0]))], // Welt mit der Gemeinde als Loch
    ...polys.flatMap((p) => p.slice(1)).map((enclave) => [ccw(enclave)]), // Enklaven gehören nicht dazu
  ];
  map.addSource('sv-mask', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: mask } },
  });
  map.addLayer({ id: 'sv-mask', type: 'fill', source: 'sv-mask',
    paint: { 'fill-color': '#c9c3b6', 'fill-opacity': 0.85, 'fill-antialias': false } });
  map.moveLayer('sv-boundary'); // Grenzlinie über der Abdeckung

  // LGLN-Gebäude unter den Beschriftungen, damit Namen lesbar bleiben
  map.addLayer(buildings.layer, firstSymbol);
}

let hikingState = 'idle';
async function loadHikingRoutes(map, setStatus) {
  if (hikingState === 'loaded' || hikingState === 'loading') return;
  hikingState = 'loading';
  setStatus('Wanderrouten werden aus OpenStreetMap geladen …');
  const [w, s, e, n] = BBOX;
  const q = `[out:json][timeout:40];relation["route"~"^(hiking|foot)$"](${s},${w},${n},${e});out tags geom;`;
  try {
    const data = await overpass(q, 45000);
    const features = data.elements.filter((el) => el.type === 'relation').map((rel) => ({
      type: 'Feature',
      properties: {
        name: rel.tags.name || rel.tags.ref || 'Wanderweg',
        colour: /^#[0-9a-f]{3,6}$/i.test(rel.tags.colour || '') ? rel.tags.colour : undefined,
        id: rel.id,
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: rel.members.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry.map((p) => [p.lon, p.lat])),
      },
    })).filter((f) => f.geometry.coordinates.length);
    map.getSource('sv-hiking').setData({ type: 'FeatureCollection', features });
    hikingState = 'loaded';
    const names = [...new Set(features.map((f) => f.properties.name))];
    setStatus(features.length
      ? `${features.length} markierte Routen, u. a. ${names.slice(0, 3).join(', ')}.`
      : 'Keine markierten Routen gefunden. Pfade und Feldwege werden trotzdem angezeigt.');
  } catch {
    hikingState = 'idle';
    setStatus('Markierte Routen konnten gerade nicht geladen werden (Overpass nicht erreichbar). Pfade und Feldwege werden trotzdem angezeigt. Zum erneuten Versuch die Ebene aus- und wieder einschalten.');
  }
}

/** Panel mit Schaltern aufbauen. */
export function buildLayerPanel(map, container, statusEl, ctx) {
  const setStatus = (t) => { statusEl.textContent = t; };
  const apply = (def, on) => {
    for (const id of def.layers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    def.toggle?.(map, on, ctx);
    if (on && def.onEnable) def.onEnable(map, setStatus);
    if (!on && def.id === 'hiking') setStatus('');
  };

  for (const def of LAYERS) {
    const row = document.createElement('label');
    row.className = 'layer';
    row.htmlFor = `layer-${def.id}`;
    row.innerHTML = `
      <span class="swatch" style="background:${def.swatch}"></span>
      <span class="layer-name">${def.name}<small>${def.desc}</small></span>
      <span class="switch"><input type="checkbox" id="layer-${def.id}" ${def.on ? 'checked' : ''}><span></span></span>`;
    const input = row.querySelector('input');
    input.addEventListener('change', () => apply(def, input.checked));
    container.appendChild(row);
    apply(def, def.on);
  }
}
