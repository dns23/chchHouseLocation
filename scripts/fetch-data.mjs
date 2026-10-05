// Downloads the places for every layer in js/layers.js from OpenStreetMap
// (Overpass API) and writes data/pois.json, which the web app loads first.
//
// Usage: node scripts/fetch-data.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { LAYERS, fetchFromOverpass } from '../js/layers.js';

const out = new URL('../data/pois.json', import.meta.url);
const data = await fetchFromOverpass(fetch);
for (const l of LAYERS) console.log(`${l.label}: ${data.layers[l.id].length}`);
await mkdir(new URL('.', out), { recursive: true });
await writeFile(out, JSON.stringify(data));
console.log(`Wrote ${out.pathname}`);
