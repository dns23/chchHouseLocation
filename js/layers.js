// Shared configuration: used by the browser app (js/app.js) and by the
// data build script (scripts/fetch-data.mjs).
//
// To add a new parameter, add an entry to LAYERS:
//   - selectors: Overpass QL statements (without the bbox) that select the features
//   - match(tags): returns true if an OSM element's tags belong to this layer
//
// Everything else (sliders, scoring, legend, popups) is generated from this list.

// Christchurch urban area, incl. Lyttelton, Sumner, Belfast and Hornby.
export const BBOX = { south: -43.62, west: 172.45, north: -43.40, east: 172.80 };

export const LAYERS = [
  {
    id: 'cafe',
    label: 'Cafés',
    color: '#c2410c',
    defaultRadius: 800,
    defaultWeight: 5,
    selectors: ['nwr["amenity"="cafe"]'],
    match: (t) => t.amenity === 'cafe',
  },
  {
    id: 'bar',
    label: 'Pubs & bars',
    color: '#7c3aed',
    defaultRadius: 800,
    defaultWeight: 5,
    selectors: ['nwr["amenity"~"^(pub|bar|biergarten)$"]'],
    match: (t) => ['pub', 'bar', 'biergarten'].includes(t.amenity),
  },
];

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function buildOverpassQuery(layers = LAYERS, bbox = BBOX) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const stmts = layers.flatMap((l) => l.selectors.map((s) => `  ${s}(${b});`));
  return `[out:json][timeout:120];\n(\n${stmts.join('\n')}\n);\nout center tags;`;
}

// Convert an Overpass JSON response into { layerId: [[lat, lon, name], ...] }.
export function parseOverpass(json, layers = LAYERS) {
  const out = Object.fromEntries(layers.map((l) => [l.id, []]));
  for (const el of json.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const tags = el.tags || {};
    for (const l of layers) {
      if (l.match(tags)) {
        out[l.id].push([+lat.toFixed(6), +lon.toFixed(6), tags.name || '']);
      }
    }
  }
  return out;
}

export async function fetchFromOverpass(fetchImpl = fetch, layers = LAYERS, bbox = BBOX) {
  const query = buildOverpassQuery(layers, bbox);
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const json = await res.json();
      return {
        generated: new Date().toISOString(),
        osmTimestamp: json.osm3s?.timestamp_osm_base || null,
        source: 'OpenStreetMap contributors, via Overpass API (ODbL)',
        bbox,
        layers: parseOverpass(json, layers),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No Overpass endpoint reachable');
}
