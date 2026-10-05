/* global L */
import { LAYERS, BBOX, fetchFromOverpass } from './layers.js';

const CELL_M = 40;          // grid resolution in metres
const MAX_RADIUS = 2000;    // slider max in metres
const CACHE_KEY = 'chch-pois-v1';
const SETTINGS_KEY = 'chch-settings-v1';

// Sequential ramp for the combined score (low -> high), YlGnBu-like.
const RAMP = ['#ffffcc', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#0c2c84'];

const DEFAULTS = {
  mode: 'score',
  saturation: 3,
  opacity: 0.6,
  showPois: false,
  layers: Object.fromEntries(LAYERS.map((l) => [l.id, { enabled: true, radius: l.defaultRadius, weight: l.defaultWeight }])),
};

let settings = loadSettings();
let data = null;           // { layers: { id: [[lat, lon, name]] }, ... }
let projected = {};        // id -> Float64Array [x0, y0, x1, y1, ...] in grid metres
let counts = {};           // id -> Uint16Array per grid cell

// ---------- Map ----------

const map = L.map('map', { zoomControl: true, preferCanvas: true })
  .fitBounds([[BBOX.south + 0.06, BBOX.west + 0.08], [BBOX.north - 0.06, BBOX.east - 0.06]]);

// Optional: CARTO basemaps need a free API key since Aug 2026 (https://carto.com/basemaps).
// Paste one here to add the CARTO light map; otherwise only keyless OpenStreetMap tiles are offered.
const CARTO_API_KEY = '';

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const basemaps = {
  // Greyscaled via CSS (.tiles-grey) so the coloured overlay stands out.
  'OpenStreetMap (grey)': L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR, className: 'tiles-grey' }),
  'OpenStreetMap': L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }),
};
if (CARTO_API_KEY) {
  basemaps['Light (CARTO)'] = L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`, {
    maxZoom: 19, subdomains: 'abcd',
    attribution: `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
  });
}
basemaps['OpenStreetMap (grey)'].addTo(map);
L.control.layers(basemaps, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

// ---------- Grid (Web Mercator, so the image lines up exactly with tiles) ----------

const proj = L.Projection.SphericalMercator;
const midLat = (BBOX.north + BBOX.south) / 2;
const k = Math.cos((midLat * Math.PI) / 180); // mercator metres -> ground metres
const nw = proj.project(L.latLng(BBOX.north, BBOX.west));
const se = proj.project(L.latLng(BBOX.south, BBOX.east));
// Grid coordinates: ground metres, x east from west edge, y south from north edge.
const W = Math.ceil(((se.x - nw.x) * k) / CELL_M);
const H = Math.ceil(((nw.y - se.y) * k) / CELL_M);
const gridBounds = L.latLngBounds(
  proj.unproject(L.point(nw.x, nw.y - (H * CELL_M) / k)),
  proj.unproject(L.point(nw.x + (W * CELL_M) / k, nw.y)),
);

function toGrid(lat, lon) {
  const p = proj.project(L.latLng(lat, lon));
  return [(p.x - nw.x) * k, (nw.y - p.y) * k];
}

const canvas = document.createElement('canvas');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(W, H);
const overlay = L.imageOverlay(canvas.toDataURL(), gridBounds, { interactive: false, className: 'score-overlay' }).addTo(map);

// Count, for every cell, how many places of a layer are within `radius` metres.
function stampCounts(id, radius) {
  const arr = counts[id] || (counts[id] = new Uint16Array(W * H));
  arr.fill(0);
  if (radius <= 0) return arr;
  const pts = projected[id];
  const r2 = radius * radius;
  for (let p = 0; p < pts.length; p += 2) {
    const x = pts[p], y = pts[p + 1];
    const j0 = Math.max(0, Math.ceil((y - radius) / CELL_M - 0.5));
    const j1 = Math.min(H - 1, Math.floor((y + radius) / CELL_M - 0.5));
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * CELL_M - y;
      const half = Math.sqrt(Math.max(0, r2 - dy * dy));
      const i0 = Math.max(0, Math.ceil((x - half) / CELL_M - 0.5));
      const i1 = Math.min(W - 1, Math.floor((x + half) / CELL_M - 0.5));
      const row = j * W;
      for (let i = i0; i <= i1; i++) arr[row + i]++;
    }
  }
  return arr;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RAMP_LUT = (() => {
  const stops = RAMP.map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = (v / 255) * (stops.length - 1);
    const a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), f = t - a;
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * f;
  }
  return lut;
})();

function activeLayers() {
  return LAYERS.filter((l) => settings.layers[l.id].enabled && settings.layers[l.id].weight > 0 && data);
}

// Score of one cell, 0..1: weighted average of each layer's min(count / saturation, 1).
function cellScore(idx, act, totalW) {
  let s = 0;
  for (const l of act) s += settings.layers[l.id].weight * Math.min(counts[l.id][idx] / settings.saturation, 1);
  return totalW > 0 ? s / totalW : 0;
}

let dirtyLayers = new Set(LAYERS.map((l) => l.id));
let frame = 0;
function scheduleRender(changedLayerId) {
  if (changedLayerId === '*') LAYERS.forEach((l) => dirtyLayers.add(l.id));
  else if (changedLayerId) dirtyLayers.add(changedLayerId);
  if (!frame) frame = requestAnimationFrame(render);
}

function render() {
  frame = 0;
  if (!data) return;
  for (const id of dirtyLayers) stampCounts(id, settings.layers[id].radius);
  dirtyLayers.clear();

  const act = activeLayers();
  const totalW = act.reduce((s, l) => s + settings.layers[l.id].weight, 0);
  const colors = act.map((l) => hexToRgb(l.color));
  const px = image.data;
  const op = settings.opacity * 255;
  const sat = settings.saturation;

  for (let idx = 0, o = 0; idx < W * H; idx++, o += 4) {
    const score = cellScore(idx, act, totalW);
    if (score <= 0) { px[o + 3] = 0; continue; }
    if (settings.mode === 'score') {
      const v = Math.round(score * 255) * 3;
      px[o] = RAMP_LUT[v]; px[o + 1] = RAMP_LUT[v + 1]; px[o + 2] = RAMP_LUT[v + 2];
    } else {
      // Blend each parameter's colour by its contribution to this cell.
      let r = 0, g = 0, b = 0, sum = 0;
      for (let n = 0; n < act.length; n++) {
        const w = settings.layers[act[n].id].weight * Math.min(counts[act[n].id][idx] / sat, 1);
        r += colors[n][0] * w; g += colors[n][1] * w; b += colors[n][2] * w; sum += w;
      }
      px[o] = r / sum; px[o + 1] = g / sum; px[o + 2] = b / sum;
    }
    px[o + 3] = op * (0.2 + 0.8 * score);
  }
  ctx.putImageData(image, 0, 0);
  overlay.setUrl(canvas.toDataURL());
  renderLegend();
}

// ---------- POI markers ----------

const poiGroup = L.layerGroup();
function buildPoiMarkers() {
  poiGroup.clearLayers();
  if (!data) return;
  for (const l of LAYERS) {
    if (!settings.layers[l.id].enabled) continue;
    for (const [lat, lon, name] of data.layers[l.id] || []) {
      L.circleMarker([lat, lon], { radius: 4, color: '#fff', weight: 1, fillColor: l.color, fillOpacity: 0.9 })
        .bindTooltip(`${name || '(unnamed)'} · ${l.label}`)
        .addTo(poiGroup);
    }
  }
}
function syncPoiVisibility() {
  if (settings.showPois) { buildPoiMarkers(); poiGroup.addTo(map); } else map.removeLayer(poiGroup);
}

// ---------- Click: inspect a location ----------

let probe = L.layerGroup().addTo(map);
map.on('click', (e) => inspect(e.latlng));
map.on('popupclose', () => probe.clearLayers());

function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`; }

function inspect(latlng) {
  if (!data) return;
  probe.clearLayers();
  const rows = [];
  for (const l of LAYERS) {
    const cfg = settings.layers[l.id];
    let inRange = 0, best = Infinity, bestName = '';
    for (const [lat, lon, name] of data.layers[l.id] || []) {
      const d = map.distance(latlng, [lat, lon]);
      if (d <= cfg.radius) inRange++;
      if (d < best) { best = d; bestName = name; }
    }
    if (cfg.enabled && cfg.radius > 0) {
      L.circle(latlng, { radius: cfg.radius, color: l.color, weight: 1.5, fill: false, dashArray: '4 4', interactive: false }).addTo(probe);
    }
    rows.push(`<tr><td><span class="swatch" style="display:inline-block;background:${l.color}"></span> ${l.label}</td>
      <td class="num">${inRange} within ${fmtDist(cfg.radius)}</td></tr>
      <tr><td colspan="2" class="small">Nearest: ${best < Infinity ? `${escapeHtml(bestName || '(unnamed)')}, ${fmtDist(best)}` : '—'}</td></tr>`);
  }
  const [gx, gy] = toGrid(latlng.lat, latlng.lng);
  const i = Math.floor(gx / CELL_M), j = Math.floor(gy / CELL_M);
  let scoreTxt = '—';
  if (i >= 0 && j >= 0 && i < W && j < H) {
    const act = activeLayers();
    const totalW = act.reduce((s, l) => s + settings.layers[l.id].weight, 0);
    scoreTxt = `${Math.round(cellScore(j * W + i, act, totalW) * 100)}%`;
  }
  L.popup({ maxWidth: 300 })
    .setLatLng(latlng)
    .setContent(`<div class="popup"><strong>Score: ${scoreTxt}</strong><table>${rows.join('')}</table></div>`)
    .openOn(map);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Controls ----------

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k2, v] of Object.entries(attrs)) {
    if (k2 === 'class') e.className = v; else if (k2 in e) e[k2] = v; else e.setAttribute(k2, v);
  }
  for (const c of [].concat(children)) e.append(c);
  return e;
}

function buildLayerControls() {
  const root = document.getElementById('layer-controls');
  root.innerHTML = '';
  for (const l of LAYERS) {
    const cfg = settings.layers[l.id];
    const box = el('div', { class: 'layer' + (cfg.enabled ? '' : ' off') });

    const enabled = el('input', { type: 'checkbox', checked: cfg.enabled, 'aria-label': `Use ${l.label}` });
    const count = el('span', { class: 'count', id: `count-${l.id}` }, data ? `${(data.layers[l.id] || []).length} places` : '');
    box.append(el('label', { class: 'layer-head' }, [enabled, el('span', { class: 'swatch', style: `background:${l.color}` }), l.label, count]));

    const rOut = el('output');
    const radius = el('input', { type: 'range', min: 0, max: MAX_RADIUS, step: 50, value: cfg.radius });
    box.append(el('label', { class: 'slider' }, [el('span', {}, ['Walking distance ', rOut]), radius]));

    const wOut = el('output');
    const weight = el('input', { type: 'range', min: 0, max: 10, step: 1, value: cfg.weight });
    box.append(el('label', { class: 'slider' }, [el('span', {}, ['Importance ', wOut]), weight]));

    const sync = () => { rOut.textContent = fmtDist(cfg.radius); wOut.textContent = `${cfg.weight} / 10`; };
    sync();

    enabled.addEventListener('change', () => {
      cfg.enabled = enabled.checked;
      box.classList.toggle('off', !cfg.enabled);
      saveSettings(); scheduleRender(); if (settings.showPois) buildPoiMarkers();
    });
    radius.addEventListener('input', () => { cfg.radius = +radius.value; sync(); saveSettings(); scheduleRender(l.id); });
    weight.addEventListener('input', () => { cfg.weight = +weight.value; sync(); saveSettings(); scheduleRender(); });
    root.append(box);
  }
}

function bindGlobalControls() {
  const mode = document.getElementById('mode');
  const sat = document.getElementById('saturation');
  const op = document.getElementById('opacity');
  const pois = document.getElementById('show-pois');
  const sync = () => {
    mode.value = settings.mode; sat.value = settings.saturation; op.value = settings.opacity; pois.checked = settings.showPois;
    document.getElementById('sat-out').textContent = settings.saturation;
    document.getElementById('opacity-out').textContent = `${Math.round(settings.opacity * 100)}%`;
  };
  sync();
  mode.addEventListener('change', () => { settings.mode = mode.value; saveSettings(); scheduleRender(); });
  sat.addEventListener('input', () => { settings.saturation = +sat.value; sync(); saveSettings(); scheduleRender(); });
  op.addEventListener('input', () => { settings.opacity = +op.value; sync(); saveSettings(); scheduleRender(); });
  pois.addEventListener('change', () => { settings.showPois = pois.checked; saveSettings(); syncPoiVisibility(); });

  document.getElementById('reset').addEventListener('click', () => {
    settings = structuredClone(DEFAULTS);
    saveSettings(); sync(); buildLayerControls(); syncPoiVisibility(); scheduleRender('*');
  });
  document.getElementById('refresh').addEventListener('click', () => loadData({ live: true }));

  const panel = document.getElementById('panel');
  const toggle = document.getElementById('toggle-panel');
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    setTimeout(() => map.invalidateSize(), 50);
  });
}

function renderLegend() {
  const root = document.getElementById('legend');
  const sat = settings.saturation;
  const satTxt = `${sat} place${sat === 1 ? '' : 's'}`;
  if (settings.mode === 'score') {
    root.innerHTML = `<div class="ramp" style="background:linear-gradient(to right, ${RAMP.join(',')})"></div>
      <div class="ramp-labels"><span>Few in range</span><span>${satTxt}+ of everything</span></div>`;
  } else {
    root.innerHTML = activeLayers().map((l) =>
      `<div class="legend-item"><span class="swatch" style="background:${l.color}"></span>${l.label}</div>`).join('') +
      '<p class="small">Mixed colours mean several parameters cover the spot. Stronger colour means more places in range.</p>';
  }
}

// ---------- Settings persistence ----------

function loadSettings() {
  const s = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) {
      for (const key of ['mode', 'saturation', 'opacity', 'showPois']) if (key in saved) s[key] = saved[key];
      for (const id of Object.keys(s.layers)) Object.assign(s.layers[id], saved.layers?.[id] || {});
    }
  } catch { /* storage unavailable: use defaults */ }
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---------- Data loading ----------
// Order: bundled data/pois.json (built by GitHub Actions) -> browser cache -> live Overpass.

function setStatus(msg) { document.getElementById('status').textContent = msg; }

function useData(d, origin) {
  data = d;
  for (const l of LAYERS) {
    const pts = d.layers[l.id] || [];
    const arr = new Float64Array(pts.length * 2);
    pts.forEach(([lat, lon], n) => { const [x, y] = toGrid(lat, lon); arr[2 * n] = x; arr[2 * n + 1] = y; });
    projected[l.id] = arr;
    const c = document.getElementById(`count-${l.id}`);
    if (c) c.textContent = `${pts.length} places`;
  }
  const when = d.osmTimestamp || d.generated;
  setStatus(`${origin}. OSM data as of ${when ? new Date(when).toLocaleDateString() : 'unknown date'}.`);
  syncPoiVisibility();
  scheduleRender('*');
}

function hasAllLayers(d) {
  return d && d.layers && LAYERS.every((l) => Array.isArray(d.layers[l.id]));
}

async function loadData({ live = false } = {}) {
  const btn = document.getElementById('refresh');
  if (!live) {
    try {
      const res = await fetch('data/pois.json', { cache: 'no-cache' });
      if (res.ok) {
        const d = await res.json();
        if (hasAllLayers(d)) return useData(d, 'Loaded bundled data');
      }
    } catch { /* fall through */ }
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (hasAllLayers(cached)) return useData(cached, 'Loaded cached data');
    } catch { /* fall through */ }
  }
  btn.disabled = true;
  setStatus('Downloading places from OpenStreetMap (can take ~20 s)…');
  try {
    const d = await fetchFromOverpass(fetch);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
    useData(d, 'Loaded live from OpenStreetMap');
  } catch (e) {
    setStatus(`Couldn't load data: ${e.message}. Try "Refresh" again in a minute.`);
  } finally {
    btn.disabled = false;
  }
}

buildLayerControls();
bindGlobalControls();
renderLegend();
loadData();
