// Sonnenstand und daraus abgeleitete Lichtstimmung für Schneverdingen.

const RAD = Math.PI / 180;

/** Sonnenhöhe und Azimut (Grad, Azimut von Nord im Uhrzeigersinn). Genauigkeit ca. 1°. */
export function sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // Tage seit J2000
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = (gmst * 15 + lon) * RAD;
  const ha = lst - ra;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { altitude: alt / RAD, azimuth: ((az / RAD) + 360) % 360 };
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Licht für eine Sonnenhöhe: Richtung (x Ost, y Nord, z oben), Farben, Nachtanteil 0–1. */
export function lighting({ altitude, azimuth }) {
  const night = 1 - smooth(-7, 1.5, altitude);
  const golden = 1 - smooth(2, 22, altitude);
  // Tagsüber Sonne, nachts ein schwaches Mondlicht aus Südosten
  const elev = Math.max(altitude, 8) * RAD;
  const az = (night > 0.5 ? 140 : azimuth) * RAD;
  const dir = [Math.sin(az) * Math.cos(elev), Math.cos(az) * Math.cos(elev), Math.sin(elev)];
  const daySun = mix([1.0, 0.97, 0.9], [1.0, 0.68, 0.42], golden).map((v) => v * 0.78);
  const sun = mix(daySun, [0.16, 0.2, 0.32], night);
  const sky = mix(mix([0.6, 0.66, 0.74], [0.6, 0.52, 0.55], golden * 0.6), [0.08, 0.1, 0.17], night);
  const ground = mix([0.42, 0.4, 0.35], [0.05, 0.05, 0.08], night);
  return { dir, sun, sky, ground, night, golden };
}

export function formatTime(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}
