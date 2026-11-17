// Bearbeitungsmodus (Aufruf mit ?bearbeiten): Gebäude anklicken, Aussehen einstellen, als landmarks.json exportieren.
// Änderungen werden im Browser zwischengespeichert, bis sie exportiert und ins Repository übernommen sind.
import { escapeHtml } from './config.js';

const STORE = 'sv-bearbeitung';

const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const save = (edits) => { try { localStorage.setItem(STORE, JSON.stringify(edits)); } catch { /* privat/gesperrt */ } };

const sel = (id, options, value) => `<select id="${id}">${options.map(([v, l]) => `<option value="${v}"${v === (value ?? '') ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const color = (id, value, on) => `<span class="ed-color"><input type="checkbox" id="${id}-on"${on ? ' checked' : ''} aria-label="verwenden"><input type="color" id="${id}" value="${value || '#999999'}"></span>`;

export function initEditor({ map, buildings }) {
  const edits = load();                       // id -> Eintrag oder null (= gelöscht)
  const panel = document.createElement('aside');
  panel.className = 'panel editor';
  panel.setAttribute('aria-label', 'Bearbeitungsmodus');
  document.body.appendChild(panel);
  document.body.classList.add('editing');
  let current = null;                         // { id, rec }

  buildings.ready.then(() => {
    for (const [id, entry] of Object.entries(edits)) buildings.setLandmark(id, entry);
    renderIdle();
  });

  function changedCount() { return Object.keys(edits).length; }

  function footer() {
    return `<div class="ed-foot">
      <p class="hint">${changedCount()} geänderte Gebäude, im Browser gespeichert.</p>
      <div class="ed-buttons">
        <button class="btn btn-small" id="ed-copy"${changedCount() ? '' : ' disabled'}>JSON kopieren</button>
        <button class="btn btn-small" id="ed-download">landmarks.json speichern</button>
        <button class="btn btn-small btn-quiet" id="ed-clear"${changedCount() ? '' : ' disabled'}>Alle Änderungen verwerfen</button>
      </div>
      <p class="hint" id="ed-msg" role="status"></p>
    </div>`;
  }

  function wireFooter() {
    const msg = panel.querySelector('#ed-msg');
    panel.querySelector('#ed-copy')?.addEventListener('click', async () => {
      const txt = JSON.stringify(Object.entries(edits).map(([id, e]) => e || { id, geloescht: true }), null, 1);
      try { await navigator.clipboard.writeText(txt); msg.textContent = 'Kopiert.'; } catch { msg.textContent = 'Kopieren nicht möglich, bitte „speichern“ verwenden.'; }
    });
    panel.querySelector('#ed-download').addEventListener('click', () => {
      const all = [...buildings.landmarks().values()];
      const out = { hinweis: 'Exportiert aus dem Bearbeitungsmodus von Schneverdingen 3D. Datei nach data/landmarks.json kopieren.', gebaeude: all };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
      a.download = 'landmarks.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      msg.textContent = 'Datei gespeichert. Sie ersetzt data/landmarks.json im Repository.';
    });
    panel.querySelector('#ed-clear')?.addEventListener('click', (e) => {
      if (e.currentTarget.dataset.sure !== '1') { e.currentTarget.dataset.sure = '1'; e.currentTarget.textContent = 'Wirklich verwerfen?'; return; }
      for (const id of Object.keys(edits)) delete edits[id];
      save(edits);
      location.reload();
    });
  }

  function renderIdle() {
    panel.innerHTML = `<h2>Bearbeitungsmodus</h2>
      <p class="hint">Ein Gebäude anklicken, um sein Aussehen einzustellen. Änderungen sind sofort in der Karte zu sehen.</p>${footer()}`;
    wireFooter();
  }

  function renderForm() {
    const { id, rec } = current;
    const e = buildings.landmark(id) || {};
    const f = typeof e.fenster === 'object' ? e.fenster : { art: e.fenster };
    const l = e.laden || {};
    panel.innerHTML = `<h2>${escapeHtml(e.name || rec.a || rec.f)}</h2>
      <p class="hint">${escapeHtml(rec.f)} · ${escapeHtml(rec.r || '')} · ${rec.h} m${rec.l ? ' · ' + escapeHtml(rec.l.join(', ')) : ''}<br>ID ${escapeHtml(id)}</p>
      <form class="ed-form" id="ed-form">
        <label>Name <input id="ed-name" type="text" value="${escapeHtml(e.name || '')}" placeholder="${escapeHtml(rec.a || '')}"></label>
        <fieldset><legend>Wand</legend>
          <label>Material ${sel('ed-mat', [['', 'automatisch'], ['klinker', 'Klinker'], ['putz', 'Putz'], ['feldstein', 'Feldstein'], ['holz', 'Holz'], ['fachwerk', 'Fachwerk']], e.wand?.material)}</label>
          <label>Farbe ${color('ed-wcol', e.wand?.farbe, !!e.wand?.farbe)}</label>
          <label>Dach beginnt bei (m) <input id="ed-bis" type="number" min="0" max="12" step="0.1" value="${e.wand?.bis ?? ''}" placeholder="–"></label>
        </fieldset>
        <fieldset><legend>Fenster</legend>
          <label>Art ${sel('ed-fart', [['', 'automatisch'], ['wohnhaus', 'Wohnhaus'], ['keine', 'keine'], ['kirche', 'Kirche'], ['lichtband', 'Lichtband']], f.art)}</label>
          <label>Abstand ${sel('ed-fabst', [['', 'normal (2,7 m)'], ['eng', 'eng (1,35 m)'], ['weit', 'weit (5,4 m)']], f.abstand)}</label>
          <label>Breite <input id="ed-fbr" type="range" min="0" max="0.9" step="0.05" value="${f.breite ?? 0}"><output id="ed-fbr-o">${f.breite ? Math.round(f.breite * 100) + ' %' : 'Standard'}</output></label>
          <label>Rahmen ${color('ed-frahmen', f.rahmen || '#ffffff', !!f.rahmen)}</label>
        </fieldset>
        <fieldset><legend>Laden im Erdgeschoss</legend>
          <label>Ladenfront ${sel('ed-lmod', [['', 'automatisch (Straßenseite)'], ['rundum', 'rundum'], ['aus', 'keine']], l.modus)}</label>
          <label>Markise ${color('ed-lmark', l.markise, !!l.markise)}</label>
          <label class="ed-check"><input type="checkbox" id="ed-lstr"${l.streifen === false ? '' : ' checked'}> gestreift</label>
          <label>Schild <input id="ed-lschild" type="text" value="${escapeHtml(l.schild || '')}" placeholder="z. B. ${escapeHtml(rec.l?.[0] || 'Bäckerei')}"></label>
          <label>Schildfarben ${color('ed-lsf', l.schildFarbe || '#2b2b2b', true)} ${color('ed-ltf', l.textFarbe || '#ffffff', true)}</label>
        </fieldset>
        <fieldset><legend>Dach</legend>
          <label>Eigene Farbe statt Luftbild ${color('ed-dach', e.dach?.farbe || '#5a4436', !!e.dach?.farbe)}</label>
          <label class="ed-check"><input type="checkbox" id="ed-walm"${e.dach?.form === 'walm' ? ' checked' : ''}> eigenes Walmdach ab „Dach beginnt bei“</label>
          <label>Dachneigung (°) <input id="ed-neig" type="number" min="15" max="60" step="1" value="${e.dach?.neigung ?? 38}"></label>
          <label>Traufe ${color('ed-traufe', e.dach?.traufe || '#f3f0ea', !!e.dach?.traufe)}</label>
        </fieldset>
        <label>Quelle <input id="ed-quelle" type="text" value="${escapeHtml(e.quelle || '')}" placeholder="z. B. eigenes Foto, 11/2026"></label>
        <div class="ed-buttons">
          <button type="button" class="btn btn-small btn-quiet" id="ed-reset">Auf automatisch zurücksetzen</button>
        </div>
      </form>${footer()}`;
    const form = panel.querySelector('#ed-form');
    form.addEventListener('input', apply);
    form.addEventListener('change', apply);
    panel.querySelector('#ed-reset').addEventListener('click', () => {
      edits[id] = null;
      save(edits);
      buildings.setLandmark(id, null);
      renderForm();
    });
    wireFooter();
  }

  /** Formular -> Eintrag; unbekannte Felder (bogen, schilder, teile …) bleiben erhalten. */
  function apply() {
    const { id } = current;
    const $ = (s) => panel.querySelector(s);
    const on = (s) => $(s + '-on')?.checked;
    const prev = buildings.landmark(id) || {};
    const e = { ...prev, id };
    e.name = $('#ed-name').value.trim() || undefined;
    const wand = { ...(prev.wand || {}) };
    wand.material = $('#ed-mat').value || undefined;
    wand.farbe = on('#ed-wcol') ? $('#ed-wcol').value : undefined;
    wand.bis = $('#ed-bis').value ? Number($('#ed-bis').value) : undefined;
    e.wand = clean(wand);
    const br = Number($('#ed-fbr').value);
    $('#ed-fbr-o').textContent = br ? Math.round(br * 100) + ' %' : 'Standard';
    e.fenster = clean({ art: $('#ed-fart').value || undefined, abstand: $('#ed-fabst').value || undefined,
      breite: br || undefined, rahmen: on('#ed-frahmen') ? $('#ed-frahmen').value : undefined });
    const schild = $('#ed-lschild').value.trim();
    e.laden = clean({ ...(prev.laden || {}), modus: $('#ed-lmod').value || undefined, markise: on('#ed-lmark') ? $('#ed-lmark').value : undefined,
      streifen: $('#ed-lstr').checked ? undefined : false, schild: schild || undefined,
      schildFarbe: schild ? $('#ed-lsf').value : undefined, textFarbe: schild ? $('#ed-ltf').value : undefined });
    const walm = $('#ed-walm').checked;
    e.dach = clean({ ...(prev.dach || {}), farbe: on('#ed-dach') || walm ? $('#ed-dach').value : undefined,
      form: walm ? 'walm' : undefined, neigung: walm ? Number($('#ed-neig').value) : undefined,
      traufe: walm && on('#ed-traufe') ? $('#ed-traufe').value : undefined });
    if (walm && !wand.bis) { e.wand = clean({ ...wand, bis: 3.5 }); $('#ed-bis').value = 3.5; }
    e.quelle = $('#ed-quelle').value.trim() || undefined;
    const entry = clean(e);
    edits[id] = entry;
    save(edits);
    buildings.setLandmark(id, entry);
    panel.querySelector('.ed-foot .hint').textContent = `${changedCount()} geänderte Gebäude, im Browser gespeichert.`;
  }

  function clean(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined && !(v && typeof v === 'object' && !Object.keys(v).length)) out[k] = v;
    return Object.keys(out).length ? out : undefined;
  }

  map.on('click', (ev) => {
    const hit = buildings.pick(ev.point);
    if (!hit) return;
    current = { id: hit.record.id, rec: hit.record };
    renderForm();
  });
}
