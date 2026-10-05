# Christchurch House Finder

An interactive, static web map of Christchurch, NZ for working out where in the city to buy a house.
Each parameter (cafés, pubs & bars, …) has a **walking-distance slider (0–2 km)** and an **importance weight**.
Every place draws a circle of that radius; where circles overlap the colour gets stronger, and the
weighted parameters combine into one score per 40 m grid cell.

- **Combined score** mode: one colour ramp, light = little in range, dark = lots of everything in range.
- **Parameter colours** mode: each parameter keeps its own colour, blended where they overlap.
- **Full marks at N places**: how many places in range count as "enough" (stops the CBD swamping everything).
- **Click anywhere** to see how many places are in range, the nearest one, and that spot's score.

Settings are remembered in your browser.

## Run locally

No build step. Any static file server works:

```sh
python3 -m http.server 8000      # then open http://localhost:8000
node scripts/fetch-data.mjs      # optional: download data/pois.json from OpenStreetMap
```

If `data/pois.json` is missing, the app downloads the data live from OpenStreetMap in the browser
(and caches it), so it works either way.

## Deploy to GitHub Pages

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` downloads fresh OpenStreetMap data,
   bundles it as `data/pois.json`, and deploys. It also re-runs weekly to keep the data current.

(Deploying straight from a branch also works. The app then fetches the data live on first visit.)

## Adding a parameter

Add an entry to `LAYERS` in `js/layers.js`, e.g.

```js
{
  id: 'supermarket', label: 'Supermarkets', color: '#15803d',
  defaultRadius: 1000, defaultWeight: 5,
  selectors: ['nwr["shop"="supermarket"]'],
  match: (t) => t.shop === 'supermarket',
},
```

The sliders, scoring, legend and popup pick it up automatically.

## Map data

**In use now**

| Data | Source | Licence |
|---|---|---|
| Cafés, pubs, bars | [OpenStreetMap](https://www.openstreetmap.org) via the [Overpass API](https://overpass-api.de) (`amenity=cafe`, `amenity=pub\|bar\|biergarten`) | ODbL |
| Basemap tiles | OpenStreetMap standard tiles (shown greyscale by default). [CARTO](https://carto.com/basemaps) is optional and needs a free API key: set `CARTO_API_KEY` in `js/app.js` | ODbL |

**Suggested next parameters**

*Points of interest (easy to add, from OpenStreetMap):*
- Supermarkets (`shop=supermarket`), bakeries, restaurants
- Parks and playgrounds (`leisure=park|playground`), beaches, Port Hills tracks
- Schools (`amenity=school`), childcare (`amenity=kindergarten`)
- Bus stops (`highway=bus_stop`), cycleways (Christchurch's Major Cycle Routes are mapped)
- Gyms, libraries, swimming pools (`leisure=sports_centre`, `amenity=library`)

*Christchurch and NZ open data (good as positive or negative layers):*
- **Hazards**: liquefaction vulnerability, flood management areas, coastal inundation, tsunami
  evacuation zones. Sources: [Christchurch City Council Open Data](https://opendata-christchurchcity.hub.arcgis.com/)
  and [Canterbury Maps](https://opendata.canterburymaps.govt.nz/) (ECan).
- **District Plan zoning** (residential density, the Medium Density Residential Standards): CCC Open Data.
- **Public transport**: Metro bus routes and timetables as GTFS from
  [Environment Canterbury](https://www.metroinfo.co.nz/), e.g. walking distance to a frequent route.
- **School zones**: Ministry of Education enrolment zones
  ([Education Counts](https://www.educationcounts.govt.nz/) / [data.govt.nz](https://catalogue.data.govt.nz/)).
- **Addresses, parcels, building outlines**: [LINZ Data Service](https://data.linz.govt.nz/) (CC BY 4.0).
- **Census and deprivation**: [Stats NZ](https://datafinder.stats.govt.nz/) meshblock and SA2 data;
  [NZDep2023](https://www.otago.ac.nz/wellington/research/groups/research-groups-in-the-department-of-public-health/hirp/socioeconomic-deprivation-indexes-nzdep-and-nzidep)
  index (University of Otago).
- **Crime**: [NZ Police data](https://www.police.govt.nz/about-us/publications-statistics/data-and-statistics/policedatanz) by area unit.
- **House prices**: QV / CoreLogic are commercial; Stats NZ and REINZ publish aggregates.

**Better walking distance**: distances are currently straight-line. For true walking times, precompute
isochrones from the OSM street network with [OSRM](https://project-osrm.org/),
[Valhalla](https://github.com/valhalla/valhalla) or [OpenRouteService](https://openrouteservice.org/)
and bundle them as GeoJSON.

## Project layout

```
index.html              page shell
css/style.css           styles (sidebar on desktop, bottom sheet on phones)
js/layers.js            parameter definitions + Overpass query (shared by app and script)
js/app.js               map, scoring grid, controls
scripts/fetch-data.mjs  builds data/pois.json from OpenStreetMap
vendor/leaflet/         Leaflet 1.9.4 (BSD-2), bundled so there is no CDN dependency
```
