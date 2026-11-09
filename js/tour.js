// Heide-Tour: geführter Kameraflug mit Stationen.
import { reducedMotion } from './config.js';

const DWELL_MS = 9000;

export function initTour({ map, stops, el, startBtn, onStart, onEnd }) {
  const $ = (id) => document.getElementById(id);
  const title = $('tour-title');
  const kicker = $('tour-kicker');
  const count = $('tour-count');
  const text = $('tour-text');
  const bar = $('tour-bar');
  const playBtn = $('tour-play');

  let i = 0;
  let playing = false;
  let active = false;
  let timer = null;
  let raf = null;
  let token = 0;

  const clearTimers = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    timer = null;
  };

  const progress = (ms) => {
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / ms);
      bar.style.width = `${p * 100}%`;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  function go(n) {
    clearTimers();
    i = (n + stops.length) % stops.length;
    const s = stops[i];
    const my = ++token;
    kicker.textContent = s.kicker;
    count.textContent = `Station ${i + 1} von ${stops.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    bar.style.width = '0%';
    $('tour-prev').disabled = i === 0;
    $('tour-next').textContent = i === stops.length - 1 ? 'Von vorn' : 'Weiter';

    const cam = { center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing,
      padding: { top: 0, left: 0, right: 0, bottom: Math.round(el.offsetHeight * 0.8) } };
    if (reducedMotion) map.jumpTo(cam);
    else map.flyTo({ ...cam, duration: 5200, curve: 1.5, essential: true });

    map.once('moveend', () => {
      if (my !== token || !active) return;
      if (!reducedMotion) {
        // langsames Umkreisen während der Erzählung
        map.easeTo({ bearing: s.bearing + 25, duration: DWELL_MS, easing: (t) => t });
      }
      if (playing) {
        progress(DWELL_MS);
        timer = setTimeout(() => {
          if (i < stops.length - 1) go(i + 1);
          else setPlaying(false);
        }, DWELL_MS);
      }
    });
  }

  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? 'Pause' : 'Abspielen';
    playBtn.setAttribute('aria-pressed', String(!on));
    if (!on) {
      clearTimers();
      map.stop();
    } else {
      go(i);
    }
  }

  function start() {
    active = true;
    el.hidden = false;
    onStart?.();
    playing = true;
    playBtn.textContent = 'Pause';
    go(0);
    $('tour-next').focus();
  }

  function stop() {
    active = false;
    token++;
    clearTimers();
    map.stop();
    map.setPadding({ top: 0, left: 0, right: 0, bottom: 0 });
    el.hidden = true;
    onEnd?.();
    startBtn.focus();
  }

  startBtn.addEventListener('click', start);
  $('tour-stop').addEventListener('click', stop);
  $('tour-next').addEventListener('click', () => go(i === stops.length - 1 ? 0 : i + 1));
  $('tour-prev').addEventListener('click', () => go(i - 1));
  playBtn.addEventListener('click', () => setPlaying(!playing));
  document.addEventListener('keydown', (e) => {
    if (!active || e.target.closest('input')) return;
    if (e.key === 'Escape') stop();
    if (e.key === 'ArrowRight') go(i + 1);
    if (e.key === 'ArrowLeft' && i > 0) go(i - 1);
  });
  // Wer selbst die Karte bewegt, pausiert die Tour.
  map.on('dragstart', () => { if (active && playing) setPlaying(false); });

  return { start, stop, get active() { return active; } };
}
