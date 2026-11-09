// Tageszeit: Sonnenstand für Schneverdingen, Gebäudelicht und Nachtstimmung der Grundkarte.
import { sunPosition, lighting, formatTime } from './sun.js';

const LAT = 53.118;
const LON = 9.79;

/** Ortszeit Schneverdingen (Europe/Berlin) als Stunden mit Nachkommastellen. */
function berlinHours(date = new Date()) {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h + m / 60;
}

/** Datum von heute mit der gewählten Berliner Uhrzeit. */
function dateAt(hours) {
  const now = new Date();
  const offset = (berlinHours(now) - (now.getUTCHours() + now.getUTCMinutes() / 60) + 24) % 24; // 1 oder 2
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCMinutes(Math.round((hours - offset) * 60));
  return d;
}

export function initDaytime({ map, buildings, slider, label, nowBtn }) {
  const style = map.getStyle();
  const firstSymbol = style.layers.find((l) => l.type === 'symbol')?.id;
  const below = map.getLayer('sv-lod2') ? 'sv-lod2' : firstSymbol; // Nachtschicht unter den Gebäuden
  const symbols = style.layers.filter((l) => l.type === 'symbol').map((l) => ({
    id: l.id,
    color: map.getPaintProperty(l.id, 'text-color'),
    halo: map.getPaintProperty(l.id, 'text-halo-color'),
  }));

  // Abdunklung über Flächen und Straßen, darunter bleiben die Ebenen erhalten
  map.addSource('sv-night', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[8.9, 52.6], [10.7, 52.6], [10.7, 53.7], [8.9, 53.7], [8.9, 52.6]]] } },
  });
  map.addLayer({ id: 'sv-night', type: 'fill', source: 'sv-night', paint: { 'fill-color': '#0a1424', 'fill-opacity': 0 } }, below);
  // Straßenbeleuchtung: warmer Schein entlang der Straßen
  map.addLayer({
    id: 'sv-streetlight', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 12,
    filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'trunk'], true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffc46b',
      'line-blur': ['interpolate', ['linear'], ['zoom'], 13, 3, 18, 18],
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 2, 18, 34],
      'line-opacity': 0,
    },
  }, below);
  map.addLayer({
    id: 'sv-streetline', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 12,
    filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'trunk', 'service'], true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#4a4f5a',
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.6, 18, 9],
      'line-opacity': 0,
    },
  }, 'sv-streetlight');

  let darkLabels = false;
  function setLabels(dark) {
    if (dark === darkLabels) return;
    darkLabels = dark;
    for (const s of symbols) {
      if (!map.getLayer(s.id)) continue;
      map.setPaintProperty(s.id, 'text-color', dark ? '#e9e4d8' : s.color);
      map.setPaintProperty(s.id, 'text-halo-color', dark ? '#0a1424' : s.halo);
    }
  }

  function apply(hours) {
    const sun = sunPosition(dateAt(hours), LAT, LON);
    const l = lighting(sun);
    buildings.setLighting(l);
    map.setPaintProperty('sv-night', 'fill-opacity', l.night * 0.8 + l.golden * 0.08 * (1 - l.night));
    map.setPaintProperty('sv-night', 'fill-color', l.night > 0.05 ? '#0a1424' : '#4a2a10');
    map.setPaintProperty('sv-streetlight', 'line-opacity', l.night * 0.42);
    map.setPaintProperty('sv-streetline', 'line-opacity', l.night * 0.9);
    setLabels(l.night > 0.5);
    try {
      map.setSky({
        'sky-color': l.night > 0.5 ? '#0b1528' : l.golden > 0.5 ? '#e7b48a' : '#a9c7e4',
        'horizon-color': l.night > 0.5 ? '#1b2740' : l.golden > 0.5 ? '#f3d2a8' : '#e6eef5',
        'fog-color': l.night > 0.5 ? '#0e1a2e' : '#eef1f2',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 0.85,
      });
    } catch { /* ältere MapLibre-Versionen ohne Himmel */ }
    label.textContent = formatTime(hours);
    label.title = `Sonnenhöhe ${Math.round(sun.altitude)}°`;
    document.body.classList.toggle('night', l.night > 0.5);
  }

  slider.addEventListener('input', () => apply(Number(slider.value)));
  nowBtn.addEventListener('click', () => {
    slider.value = String(Math.round(berlinHours() * 4) / 4);
    apply(Number(slider.value));
  });
  slider.value = String(Math.round(berlinHours() * 4) / 4);
  apply(Number(slider.value));
  return { apply };
}
