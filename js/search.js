// Suche: kuratierte Orte zuerst, dann Photon (OSM) innerhalb des Gemeindegebiets.
import { BBOX, PHOTON_URL, normalize, escapeHtml, fetchJson, inBbox } from './config.js';

const KIND_DE = {
  building: 'Gebäude', house: 'Adresse', street: 'Straße', amenity: 'Einrichtung', shop: 'Geschäft',
  tourism: 'Tourismus', leisure: 'Freizeit', highway: 'Straße', place: 'Ort', natural: 'Natur',
  railway: 'Bahn', historic: 'Historisch', office: 'Büro', craft: 'Handwerk', landuse: 'Fläche',
};

export function initSearch({ input, list, places, onSelect }) {
  let results = [];
  let active = -1;
  let timer;
  let seq = 0;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };

  const render = (items, emptyText) => {
    results = items;
    active = items.length ? 0 : -1;
    list.innerHTML = items.length
      ? items.map((r, i) => `
        <li role="option" id="sr-${i}" aria-selected="${i === active}" data-i="${i}">
          <span class="r-name">${escapeHtml(r.name)}</span><span class="r-kind">${escapeHtml(r.kind)}</span>
          ${r.sub ? `<span class="r-sub">${escapeHtml(r.sub)}</span>` : ''}
        </li>`).join('')
      : `<li class="r-empty">${escapeHtml(emptyText || 'Nichts gefunden.')}</li>`;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `sr-${active}` : '');
  };

  const localMatches = (q) => {
    const nq = normalize(q);
    return places.filter((p) => [p.name, ...(p.aliases || [])].some((n) => normalize(n).includes(nq)))
      .map((p) => ({ name: p.name, kind: p.kind, sub: 'Sehenswert in Schneverdingen', lngLat: [p.lon, p.lat], zoom: p.zoom, local: true }));
  };

  const photon = async (q) => {
    const url = `${PHOTON_URL}/api?q=${encodeURIComponent(q)}&lang=de&limit=8&bbox=${BBOX.join(',')}`;
    const data = await fetchJson(url, {}, 8000);
    const seen = new Set();
    return data.features
      .filter((f) => inBbox(f.geometry.coordinates))
      .filter(({ properties: p }) => p.postcode === '29640'
        || [p.city, p.name, p.locality, p.district].includes('Schneverdingen'))
      .filter(({ properties: p }) => {
        const key = [p.name, p.street, p.housenumber].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((f) => {
        const p = f.properties;
        const street = [p.street, p.housenumber].filter(Boolean).join(' ');
        const name = p.name || street || p.city;
        const sub = [p.name ? street : '', p.district || p.locality, p.postcode && `${p.postcode} ${p.city || ''}`.trim()].filter(Boolean).join(', ');
        return {
          name,
          kind: p.housenumber && !p.name ? 'Adresse' : (KIND_DE[p.osm_key] || 'Ort'),
          sub,
          lngLat: f.geometry.coordinates,
          extent: p.extent,
          zoom: p.osm_key === 'highway' ? 17 : 18,
        };
      });
  };

  const run = async (q) => {
    const my = ++seq;
    const local = localMatches(q);
    if (local.length) render(local);
    try {
      const remote = await photon(q);
      if (my !== seq) return;
      const seen = new Set(local.map((r) => normalize(r.name)));
      render([...local, ...remote.filter((r) => !seen.has(normalize(r.name)))].slice(0, 10),
        'Keine Treffer in Schneverdingen.');
    } catch {
      if (my !== seq) return;
      render(local, 'Die Adresssuche ist gerade nicht erreichbar. Bekannte Orte findest du trotzdem, z. B. „Pietzmoor“.');
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(() => run(q), 250);
  });

  const choose = (i) => {
    const r = results[i];
    if (!r) return;
    seq++; // laufende Anfragen verwerfen, damit die Liste zu bleibt
    clearTimeout(timer);
    input.value = r.name;
    close();
    input.blur();
    onSelect(r);
  };

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !results.length) {
      if (e.key === 'Escape') close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      input.setAttribute('aria-activedescendant', `sr-${active}`);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(Math.max(active, 0));
    } else if (e.key === 'Escape') {
      close();
    }
  });

  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && results.length) render(results); });
}
