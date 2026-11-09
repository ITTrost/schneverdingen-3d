// Gemeinsame Konstanten und kleine Helfer.

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// Gemeindegebiet Schneverdingen (OSM-Relation 357061), [W, S, E, N]
export const BBOX = [9.6252, 53.0322, 9.9377, 53.2195];

export const HOME = { center: [9.7905, 53.1182], zoom: 15.4, pitch: 58, bearing: -25 };

export const LANDMARKS = {
  rathaus: { name: 'Rathaus', lngLat: [9.7870262, 53.1198956] },
  bahnhof: { name: 'Bahnhof', lngLat: [9.7986264, 53.1105547] },
};

export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const PHOTON_URL = 'https://photon.komoot.io';

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Entfernung in Metern (Haversine). */
export function distance([lon1, lat1], [lon2, lat2]) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Text für die Suche vereinfachen (Groß/klein, Umlaute, Bindestriche). */
export function normalize(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[-.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function inBbox([lon, lat]) {
  return lon >= BBOX[0] && lon <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
}

/** fetch mit Zeitlimit. */
export async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Overpass-Abfrage mit Ausweich-Server und sessionStorage-Cache. */
export async function overpass(query, timeoutMs = 25000) {
  const key = 'ovp:' + query;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch { /* Speicher nicht verfügbar */ }
  let lastErr;
  for (const url of OVERPASS_URLS) {
    try {
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      }, timeoutMs);
      try { sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* voll oder gesperrt */ }
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
