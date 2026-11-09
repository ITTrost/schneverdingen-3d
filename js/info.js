// Info-Panel: Gebäude anklicken → Adresse, Höhe, Entfernungen, Umgebung.
import { LANDMARKS, PHOTON_URL, distance, formatDistance, escapeHtml, fetchJson, overpass } from './config.js';

const CATEGORIES = [
  { name: 'Bus & Bahn', test: (t) => t.highway === 'bus_stop' || t.public_transport === 'platform' || t.railway === 'station' || t.railway === 'halt' },
  { name: 'Essen & Trinken', test: (t) => ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream', 'biergarten'].includes(t.amenity) },
  { name: 'Einkaufen', test: (t) => !!t.shop || t.amenity === 'marketplace' },
  { name: 'Gesundheit', test: (t) => ['pharmacy', 'doctors', 'dentist', 'hospital', 'clinic', 'veterinary'].includes(t.amenity) || !!t.healthcare },
  { name: 'Bildung & Kinder', test: (t) => ['school', 'kindergarten', 'library', 'college', 'childcare'].includes(t.amenity) },
  { name: 'Freizeit & Tourismus', test: (t) => !!t.tourism || !!t.leisure || ['theatre', 'cinema', 'arts_centre', 'community_centre'].includes(t.amenity) },
  { name: 'Öffentlich & Dienste', test: (t) => ['townhall', 'police', 'fire_station', 'post_office', 'bank', 'atm', 'place_of_worship', 'toilets'].includes(t.amenity) || !!t.office },
];

const TILE_CLASS_DE = {
  bus: 'Bus & Bahn', railway: 'Bus & Bahn',
  restaurant: 'Essen & Trinken', cafe: 'Essen & Trinken', fast_food: 'Essen & Trinken', bar: 'Essen & Trinken', beer: 'Essen & Trinken', ice_cream: 'Essen & Trinken',
  shop: 'Einkaufen', grocery: 'Einkaufen', bakery: 'Einkaufen', clothing_store: 'Einkaufen', alcohol_shop: 'Einkaufen', hairdresser: 'Einkaufen',
  pharmacy: 'Gesundheit', doctors: 'Gesundheit', dentist: 'Gesundheit', hospital: 'Gesundheit',
  school: 'Bildung & Kinder', college: 'Bildung & Kinder', library: 'Bildung & Kinder', kindergarten: 'Bildung & Kinder',
  park: 'Freizeit & Tourismus', attraction: 'Freizeit & Tourismus', museum: 'Freizeit & Tourismus', lodging: 'Freizeit & Tourismus', campsite: 'Freizeit & Tourismus', swimming: 'Freizeit & Tourismus', playground: 'Freizeit & Tourismus',
  town_hall: 'Öffentlich & Dienste', police: 'Öffentlich & Dienste', fire_station: 'Öffentlich & Dienste', post: 'Öffentlich & Dienste', bank: 'Öffentlich & Dienste', place_of_worship: 'Öffentlich & Dienste',
};

const RADIUS = 300;

export function initInfo({ map, panel, body, closeBtn, onOpen, buildings }) {
  let seq = 0;

  const close = () => {
    panel.hidden = true;
    map.getSource('sv-selected')?.setData({ type: 'FeatureCollection', features: [] });
    buildings?.select(null);
  };
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  // Die Kacheln fassen benachbarte Gebäude oft zu einem MultiPolygon zusammen.
  // Hervorgehoben wird nur der Teil, der den Punkt enthält (sonst der nächstgelegene).
  function pickPart(geometry, lngLat) {
    if (geometry.type !== 'MultiPolygon') return geometry;
    const inRing = ([x, y], ring) => {
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a];
        const [xb, yb] = ring[b];
        if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
      }
      return inside;
    };
    const hit = geometry.coordinates.find((poly) => inRing(lngLat, poly[0]));
    if (hit) return { type: 'Polygon', coordinates: hit };
    let best = null;
    let bestD = Infinity;
    for (const poly of geometry.coordinates) {
      const d = Math.min(...poly[0].map((p) => distance(lngLat, p)));
      if (d < bestD) { bestD = d; best = poly; }
    }
    return { type: 'Polygon', coordinates: best };
  }

  function highlight(feature, lngLat) {
    map.getSource('sv-selected').setData({
      type: 'FeatureCollection',
      features: feature ? [{ type: 'Feature', properties: feature.properties, geometry: pickPart(feature.geometry, lngLat) }] : [],
    });
  }

  async function reverse(lngLat) {
    try {
      const d = await fetchJson(`${PHOTON_URL}/reverse?lon=${lngLat[0]}&lat=${lngLat[1]}&lang=de&limit=1`, {}, 8000);
      const p = d.features?.[0]?.properties;
      if (!p) return null;
      return {
        name: p.name,
        line: [[p.street, p.housenumber].filter(Boolean).join(' '), [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        district: p.district || p.locality,
      };
    } catch {
      return null;
    }
  }

  async function nearbyOverpass(lngLat) {
    const [lon, lat] = lngLat;
    const a = `(around:${RADIUS},${lat},${lon})`;
    const q = `[out:json][timeout:20];(nwr${a}[amenity][name];nwr${a}[shop][name];nwr${a}[tourism][name];nwr${a}[leisure][name];nwr${a}[healthcare][name];node(around:600,${lat},${lon})[highway=bus_stop];);out center tags 120;`;
    const data = await overpass(q, 20000);
    return data.elements.map((el) => {
      const t = el.tags || {};
      const pos = el.type === 'node' ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
      const cat = CATEGORIES.find((c) => c.test(t));
      return pos && cat ? { name: t.name || (t.highway === 'bus_stop' ? 'Bushaltestelle' : ''), cat: cat.name, pos, d: distance(lngLat, pos) } : null;
    }).filter((x) => x && x.name);
  }

  function nearbyTiles(lngLat) {
    const feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'poi' });
    const seen = new Set();
    return feats.map((f) => {
      const pos = f.geometry.type === 'Point' ? f.geometry.coordinates : null;
      const name = f.properties.name;
      const cat = TILE_CLASS_DE[f.properties.class] || TILE_CLASS_DE[f.properties.subclass];
      if (!pos || !name || !cat) return null;
      const key = name + cat;
      if (seen.has(key)) return null;
      seen.add(key);
      const d = distance(lngLat, pos);
      return d <= (cat === 'Bus & Bahn' ? 600 : RADIUS) ? { name, cat, pos, d } : null;
    }).filter(Boolean);
  }

  function renderNearby(items, source) {
    const el = body.querySelector('.near');
    if (!items.length) {
      el.innerHTML = `<p class="hint">Im Umkreis von ${RADIUS} m sind in OpenStreetMap keine benannten Einrichtungen eingetragen.</p>`;
      return;
    }
    items.sort((a, b) => a.d - b.d);
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.cat)) groups.set(it.cat, []);
      const g = groups.get(it.cat);
      if (g.length < 5 && !g.some((x) => x.name === it.name)) g.push(it);
    }
    const order = CATEGORIES.map((c) => c.name).filter((n) => groups.has(n));
    el.innerHTML = order.map((cat) => `
      <h3>${escapeHtml(cat)}</h3>
      <ul>${groups.get(cat).map((it) => `
        <li><span><button class="linkish" data-lng="${it.pos[0]}" data-lat="${it.pos[1]}">${escapeHtml(it.name)}</button></span><span>${formatDistance(it.d)}</span></li>`).join('')}
      </ul>`).join('')
      + `<p class="source">Umgebung: ${source}</p>`;
    el.querySelectorAll('button.linkish').forEach((b) => b.addEventListener('click', () => {
      map.flyTo({ center: [Number(b.dataset.lng), Number(b.dataset.lat)], zoom: Math.max(map.getZoom(), 17.5), essential: true });
    }));
  }

  /** Panel für einen Punkt (und optional ein Gebäude-Feature) öffnen. */
  async function show({ lngLat, feature, building, title }) {
    const my = ++seq;
    highlight(building ? null : feature, lngLat);
    buildings?.select(building || null);
    onOpen?.();
    panel.hidden = false;

    const rec = building?.record;
    const h = rec ? rec.h : feature?.properties?.render_height;
    const levels = !rec && h ? Math.max(1, Math.round(h / 3)) : null;
    if (rec && !title) title = rec.a || rec.f;
    const dRathaus = distance(lngLat, LANDMARKS.rathaus.lngLat);
    const dBahnhof = distance(lngLat, LANDMARKS.bahnhof.lngLat);

    body.innerHTML = `
      <p class="eyebrow">${rec ? escapeHtml(rec.f) : feature ? 'Gebäude' : 'Ort'}</p>
      <h2 class="title">${escapeHtml(title || 'Wird geladen …')}</h2>
      <p class="addr loading">Adresse wird gesucht …</p>
      <dl class="facts">
        <div class="fact"><dt>Höhe</dt><dd>${h ? `${rec ? h.toLocaleString('de-DE') : `ca. ${Math.round(h)}`} m` : '–'}</dd></div>
        <div class="fact"><dt>Rathaus</dt><dd>${formatDistance(dRathaus)}</dd></div>
        <div class="fact"><dt>Bahnhof</dt><dd>${formatDistance(dBahnhof)}</dd></div>
      </dl>
      ${rec ? `<p class="hint" style="margin:-6px 0 10px">${escapeHtml(rec.r || 'Dachform unbekannt')} · Daten: LGLN, 3D-Gebäudemodell LoD2</p>` : ''}
      ${levels ? `<p class="hint" style="margin:-6px 0 10px">Etwa ${levels} ${levels === 1 ? 'Geschoss' : 'Geschosse'} (geschätzt aus der Höhe)</p>` : ''}
      <div class="near"><p class="loading">Umgebung im Umkreis von ${RADIUS} m wird geladen …</p></div>`;

    reverse(lngLat).then((addr) => {
      if (my !== seq) return;
      const titleEl = body.querySelector('.title');
      const addrEl = body.querySelector('.addr');
      addrEl.classList.remove('loading');
      if (!addr) {
        if (!title) titleEl.textContent = feature ? 'Gebäude' : 'Ort';
        addrEl.textContent = 'Keine Adresse gefunden.';
        return;
      }
      if (!title) titleEl.textContent = addr.name || addr.line.split(',')[0] || 'Gebäude';
      addrEl.textContent = [addr.line, addr.district && `Ortsteil ${addr.district}`].filter(Boolean).join(' · ');
    });

    try {
      const items = await nearbyOverpass(lngLat);
      if (my !== seq) return;
      renderNearby(items, 'OpenStreetMap (Overpass API), Stand heute');
    } catch {
      if (my !== seq) return;
      renderNearby(nearbyTiles(lngLat), 'OpenStreetMap-Kartenkacheln (vereinfacht, Live-Abfrage gerade nicht erreichbar)');
    }
  }

  // Klick auf Gebäude
  map.on('click', (e) => {
    const hit = buildings?.pick(e.point);
    if (hit) {
      show({ lngLat: hit.lngLat, building: hit });
      return;
    }
    const feats = map.queryRenderedFeatures(e.point, { layers: ['building-3d', 'building'].filter((id) => map.getLayer(id)) });
    if (!feats.length) return;
    show({ lngLat: [e.lngLat.lng, e.lngLat.lat], feature: feats[0] });
  });
  for (const id of ['building-3d', 'building']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }

  /** Gebäude am Punkt finden (nach einer Kamerafahrt). */
  function buildingAt(lngLat) {
    const pt = map.project(lngLat);
    const hit = buildings?.pick(pt);
    if (hit) return { building: hit };
    const feats = map.queryRenderedFeatures([[pt.x - 4, pt.y - 4], [pt.x + 4, pt.y + 4]],
      { layers: ['building-3d', 'building'].filter((id) => map.getLayer(id)) });
    return feats[0] || null;
  }

  return { show, close, buildingAt };
}
