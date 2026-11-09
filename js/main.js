// Einstieg: Karte aufbauen und Module verbinden.
import { STYLE_URL, HOME, BBOX, reducedMotion } from './config.js';
import { installLayers, buildLayerPanel } from './layers.js';
import { initSearch } from './search.js';
import { initInfo } from './info.js';
import { initTour } from './tour.js';

const $ = (id) => document.getElementById(id);
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: HOME.center,
  zoom: HOME.zoom,
  pitch: HOME.pitch,
  bearing: HOME.bearing,
  maxPitch: 80,
  minZoom: 10,
  maxBounds: [[BBOX[0] - 0.25, BBOX[1] - 0.15], [BBOX[2] + 0.25, BBOX[3] + 0.15]],
  hash: 'karte',
  attributionControl: false,
  locale: {
    'NavigationControl.ResetBearing': 'Nach Norden ausrichten',
    'NavigationControl.ZoomIn': 'Hineinzoomen',
    'NavigationControl.ZoomOut': 'Herauszoomen',
    'FullscreenControl.Enter': 'Vollbild',
    'FullscreenControl.Exit': 'Vollbild beenden',
    'GeolocateControl.FindMyLocation': 'Mein Standort',
    'ScaleControl.Meters': 'm',
    'ScaleControl.Kilometers': 'km',
  },
});
window.svMap = map; // für Tests und Neugierige

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Karte: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · Suche: <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a>',
}), 'bottom-right');

const [places, stops] = await Promise.all([
  fetch('data/places.json').then((r) => r.json()),
  fetch('data/tour.json').then((r) => r.json()),
]);

// Kompakte Quellenangabe auf schmalen Bildschirmen zugeklappt starten
map.once('load', () => {
  if (window.innerWidth < 760) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});

map.on('style.load', () => {
  installLayers(map);
  buildLayerPanel(map, $('layer-list'), $('hiking-status'));
  setup();
});

function setup() {
  const layersPanel = $('layers');
  const layersToggle = $('layers-toggle');
  const setLayersOpen = (open) => {
    layersPanel.classList.toggle('open', open);
    layersToggle.setAttribute('aria-expanded', String(open));
  };
  layersToggle.addEventListener('click', () => setLayersOpen(!layersPanel.classList.contains('open')));

  const info = initInfo({
    map,
    panel: $('info'),
    body: $('info-body'),
    closeBtn: $('info-close'),
    onOpen: () => { if (isMobile()) setLayersOpen(false); },
  });

  initSearch({
    input: $('search-input'),
    list: $('search-results'),
    places,
    onSelect: (r) => {
      const cam = { center: r.lngLat, zoom: r.zoom || 17.5, pitch: 60, essential: true };
      if (r.extent && r.kind !== 'Adresse' && r.kind !== 'Gebäude') {
        const [w, n, e, s] = r.extent; // Photon: [minLon, maxLat, maxLon, minLat]
        map.fitBounds([[w, s], [e, n]], { padding: 80, pitch: 55, maxZoom: 17.5, duration: reducedMotion ? 0 : 2500 });
      } else if (reducedMotion) {
        map.jumpTo(cam);
      } else {
        map.flyTo({ ...cam, duration: 2500 });
      }
      map.once('moveend', () => {
        const feature = info.buildingAt(r.lngLat);
        info.show({ lngLat: r.lngLat, feature, title: r.name });
      });
    },
  });

  initTour({
    map,
    stops,
    el: $('tour'),
    startBtn: $('tour-start'),
    onStart: () => { document.body.classList.add('touring'); info.close(); setLayersOpen(false); },
    onEnd: () => document.body.classList.remove('touring'),
  });

  $('home-btn').addEventListener('click', () => {
    const cam = { ...HOME, essential: true };
    reducedMotion ? map.jumpTo(cam) : map.flyTo({ ...cam, duration: 2000 });
  });

  const pitchBtn = $('pitch-btn');
  const syncPitch = () => {
    const is3d = map.getPitch() > 5;
    pitchBtn.textContent = is3d ? '2D' : '3D';
    pitchBtn.title = is3d ? 'Draufsicht' : '3D-Ansicht';
  };
  pitchBtn.addEventListener('click', () => {
    const to3d = map.getPitch() <= 5;
    map.easeTo({ pitch: to3d ? 60 : 0, bearing: to3d ? map.getBearing() : 0, duration: reducedMotion ? 0 : 900 });
  });
  map.on('pitchend', syncPitch);
  syncPitch();
}
