# ComfortRoute — shaded loop running routes (Brisbane)

App-style web app that recommends **loop routes** (no destination needed): pick a start point
and a distance (2–10 km or custom), and get **3 loop options** ranked by conditions
**at the current moment** — shade, effective UV, steepness, traffic signals, water stops.

## Run
```bash
cd comfortroute && python3 -m http.server 8080
# open http://localhost:8080
```

## How it works
- **Loop builder** — places 3–4 waypoints on a circle around your start (size derived from the
  requested distance) and routes start → waypoints → start with the OSRM foot profile, keeping
  candidates within ±15% of the requested distance, deduplicating overlapping loops.
- **Conditions scoring** (right now, not a time slider): shade % per 40 m sample from OSM
  building heights + solar position (southern-hemisphere-correct), effective UV
  (Open-Meteo) reduced ~90% in shade, mean/max grade (Open-Meteo elevation), traffic signals
  within 30 m, water stops every X km, and a hard **no-through-building** rule
  (indoor/corridor/escalator ways disqualify a loop).
- **Priorities**: Balanced · Max shade · Flattest · Fewest signals.
- Selected loop is drawn color-coded by shade (blue = shaded, gray = mixed, orange = sunny);
  gray lines = other options (tap to switch). Water stops on the selected loop get markers.

## Files
- `index.html`, `css/styles.css` — app UI (bottom sheet, WCAG 2.1 AA: 44px+ targets, contrast, ARIA)
- `js/geo.js` — haversine/bearing/point-to-line helpers
- `js/sun.js` — solar position + shade estimation
- `js/apis.js` — OSRM routing, Overpass (buildings, signals, POIs, indoor ways), Open-Meteo (UV, elevation)
- `js/data.js` — seeded Brisbane water/bench/A/C POIs (merged with live OSM data)
- `js/app.js` — loop generation, scoring, rendering

All data sources are free and keyless.
