/* ComfortRoute — external data APIs (all free, no API keys required).
 *  - Routing:   OSRM foot profile hosted by FOSSGIS (used by openstreetmap.org)
 *  - Map data:  OpenStreetMap via Overpass API (traffic signals, buildings, roads, POIs, indoor ways)
 *  - Weather:   Open-Meteo (hourly UV index, temperature, point elevations)
 * Responses are cached in memory; Overpass requests are rate-limited and retried across mirrors. */
'use strict';
const API = (() => {
  const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const cache = new Map();     // query -> parsed JSON (per session)
  const inflight = new Map();  // query -> in-flight promise
  let lastOverpassAt = 0;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function overpass(query) {
    const hit = cache.get(query);
    if (hit) return hit;
    if (inflight.has(query)) return inflight.get(query);
    // Race all mirrors in parallel — first successful JSON wins. When the
    // primary endpoint is slow or down this cuts latency to the fastest host.
    const p = Promise.any(OVERPASS_URLS.map(async url => {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query })
      });
      if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
      return res.json();
    })).then(json => {
      cache.set(query, json);
      return json;
    }).catch(err => {
      throw new Error('Overpass request failed: ' +
        (err && err.errors ? err.errors.map(e => e.message).join('; ') : (err && err.message) || err));
    }).finally(() => inflight.delete(query));
    inflight.set(query, p);
    return p;
  }

  // Overpass bbox string "south,west,north,east" padded around two points.
  function bboxStr(a, b, padDeg = 0.004) {
    const s = Math.min(a.lat, b.lat) - padDeg;
    const w = Math.min(a.lon, b.lon) - padDeg;
    const n = Math.max(a.lat, b.lat) + padDeg;
    const e = Math.max(a.lon, b.lon) + padDeg;
    return `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  }

  // Traffic signals (nodes) for signal-minimising route scoring.
  async function signals(bbox) {
    const q = `[out:json][timeout:25];node[highway=traffic_signals](${bbox});out body;`;
    const els = (await overpass(q)).elements || [];
    return els.map(e => ({ lat: e.lat, lon: e.lon }));
  }

  // Building footprints with height (m). Centroid-only approximation for shade casting.
  async function buildings(bbox) {
    const q = `[out:json][timeout:40];way[building](${bbox});out geom;`;
    const els = (await overpass(q)).elements || [];
    const out = [];
    for (const w of els) {
      const g = w.geometry;
      if (!g || g.length < 3) continue;
      let slat = 0, slon = 0;
      for (const p of g) { slat += p.lat; slon += p.lon; }
      const t = w.tags || {};
      let h = parseFloat(t.height);
      if (!isFinite(h) && t['building:levels']) h = parseFloat(t['building:levels']) * 3.2 + 1;
      if (!isFinite(h)) h = 10;
      if (h < 6) continue; // skip low structures (roofs, garages) — negligible shade
      out.push({ lat: slat / g.length, lon: slon / g.length, height: h });
    }
    return out;
  }

  // Road network for the viewport shade/steepness layers.
  const ROAD_FILTER = '"^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|living_street|unclassified|pedestrian|footway|path|cycleway|steps|service)$"';
  async function roads(bbox) {
    const q = `[out:json][timeout:40];way[highway~${ROAD_FILTER}](${bbox});out geom;`;
    const els = (await overpass(q)).elements || [];
    return els
      .map(w => ({ name: (w.tags || {}).name || '', pts: (w.geometry || []).map(p => ({ lat: p.lat, lon: p.lon })) }))
      .filter(r => r.pts.length > 1);
  }

  // Amenities: water taps/fountains, benches, air-conditioned public spaces.
  async function pois(bbox) {
    const q = `[out:json][timeout:30];(
      node[amenity~"^(drinking_water|fountain|bench|library|community_centre)$"](${bbox});
      way[amenity~"^(drinking_water|fountain|bench|library|community_centre)$"](${bbox});
    );out center;`;
    const els = (await overpass(q)).elements || [];
    const out = [];
    for (const e of els) {
      const lat = e.lat !== undefined ? e.lat : (e.center && e.center.lat);
      const lon = e.lon !== undefined ? e.lon : (e.center && e.center.lon);
      if (!isFinite(lat)) continue;
      const t = e.tags || {};
      let type = 'bench';
      if (t.amenity === 'drinking_water' || t.amenity === 'fountain') type = 'water';
      else if (t.amenity === 'library' || t.amenity === 'community_centre') type = 'cool';
      if (type === 'water' && t.fountain === 'swimming_pool') continue; // decorative pools aren't water stops
      out.push({
        id: 'osm-' + e.type + e.id, type, lat, lon,
        name: t.name || (type === 'water' ? 'Water tap / fountain' : type === 'bench' ? 'Bench' : 'Air-conditioned public space'),
        dog: t.dog === 'yes',
        source: 'osm'
      });
    }
    return out;
  }

  // Water features + bridges. River/canal centrelines & water polygons keep loop
  // waypoints on land and flag river-crossing routes; bridge ways exempt the
  // legitimate bridge decks from being flagged as "on the water".
  async function water(bbox) {
    const q = `[out:json][timeout:25];(
      way[waterway~"^(river|canal|stream)$"](${bbox});
      way[natural=water](${bbox});
      way[highway][bridge~"^(yes|viaduct|aqueduct|boardwalk|footway|covered)$"](${bbox});
    );out geom;`;
    const els = (await overpass(q)).elements || [];
    return els
      .map(w => ({ pts: (w.geometry || []).map(p => ({ lat: p.lat, lon: p.lon })), tags: w.tags || {} }))
      .filter(r => r.pts.length > 1);
  }

  // Walking/running trail network vs busy corridors — lets routes favour paths
  // (Riverwalk, park trails, boardwalks) over main roads. Sidewalk/crossing
  // footways are flagged separately: they hug roads and must NOT count as trails.
  const TRAIL_KINDS = '^(footway|path|cycleway|pedestrian|steps|track|bridleway|pier)$';
  const BUSY_KINDS = '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$';
  async function paths(bbox) {
    const q = `[out:json][timeout:25];(
      way[highway~"${TRAIL_KINDS}"](${bbox});
      way[highway~"${BUSY_KINDS}"](${bbox});
    );out geom;`;
    const els = (await overpass(q)).elements || [];
    return els
      .map(w => ({
        kind: (w.tags || {}).highway || '',
        footway: (w.tags || {}).footway || '',
        pts: (w.geometry || []).map(p => ({ lat: p.lat, lon: p.lon }))
      }))
      .filter(r => r.pts.length > 1);
  }

  // Text location search (Nominatim), bounded to greater Brisbane.
  async function geocode(query) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6' +
      '&viewbox=152.70,-28.20,153.40,-27.30&bounded=1&q=' + encodeURIComponent(query);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
    const json = await res.json();
    return json.map(r => ({
      lat: +r.lat,
      lon: +r.lon,
      label: (r.display_name || '').split(',').slice(0, 3).join(', ').trim() || query
    }));
  }

  // Indoor/through-building ways: used to detect (and penalise) routes passing inside buildings.
  async function indoor(bbox) {
    const q = `[out:json][timeout:30];(
      way[indoor](${bbox});
      way[highway=corridor](${bbox});
      way[conveying](${bbox});
    );out geom;`;
    const els = (await overpass(q)).elements || [];
    return els
      .map(w => ({ pts: (w.geometry || []).map(p => ({ lat: p.lat, lon: p.lon })), tags: w.tags || {} }))
      .filter(r => r.pts.length > 1);
  }

  // Walking/running route with alternatives (foot profile → follows paths & parks, avoids roads).
  async function route(a, b, alternatives = true) {
    const coords = `${a.lon},${a.lat};${b.lon},${b.lat}`;
    const urls = [
      `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?alternatives=${alternatives}&overview=full&geometries=geojson`,
      `https://router.project-osrm.org/route/v1/foot/${coords}?alternatives=${alternatives}&overview=full&geometries=geojson`
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
        const json = await res.json();
        if (json.code !== 'Ok' || !json.routes.length) throw new Error('No route found (OSRM: ' + json.code + ')');
        return json.routes.map(r => ({
          dist: r.distance,
          dur: r.duration,
          pts: r.geometry.coordinates.map(c => ({ lat: c[1], lon: c[0] }))
        }));
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Routing request failed');
  }

  // Hourly UV index + temperature + humidity (re-fetched when older than 30 min).
  let uvCache = null;
  async function uvToday(lat, lon) {
    if (uvCache && Date.now() - uvCache.ts < 30 * 60 * 1000) return uvCache.data;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=uv_index,temperature_2m,relative_humidity_2m&timezone=auto&forecast_days=1`;
    const json = await (await fetch(url)).json();
    uvCache = {
      ts: Date.now(),
      data: {
        hours: json.hourly.time.map(t => parseInt(t.slice(11, 13), 10)),
        uv: json.hourly.uv_index.map(v => v || 0),
        temp: json.hourly.temperature_2m,
        humidity: (json.hourly.relative_humidity_2m || []).map(v => v == null ? null : v)
      }
    };
    return uvCache.data;
  }

  function uvAt(uvData, hourFloat) {
    const i = Geo.clamp(Math.round(hourFloat), 0, uvData.uv.length - 1);
    return { uv: uvData.uv[i], temp: uvData.temp[i], humidity: uvData.humidity ? uvData.humidity[i] : null };
  }

  // Point elevations (metres) — batched 100 coords per request.
  async function elevations(points) {
    const out = [];
    for (let i = 0; i < points.length; i += 100) {
      const chunk = points.slice(i, i + 100);
      const lat = chunk.map(p => p.lat.toFixed(5)).join(',');
      const lon = chunk.map(p => p.lon.toFixed(5)).join(',');
      const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
      if (!res.ok) throw new Error('Elevation HTTP ' + res.status);
      const json = await res.json();
      out.push(...json.elevation);
    }
    return out;
  }

  // Multi-point route (single best match, no alternatives) — used to close loops:
  // start → waypoint(s) → start in one request.
  async function routeVia(points) {
    const coords = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const urls = [
      `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson`,
      `https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&geometries=geojson`
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
        const json = await res.json();
        if (json.code !== 'Ok' || !json.routes.length) throw new Error('No route (OSRM: ' + json.code + ')');
        const r = json.routes[0];
        return { dist: r.distance, dur: r.duration, pts: r.geometry.coordinates.map(c => ({ lat: c[1], lon: c[0] })) };
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Routing request failed');
  }

  // Heat-warning check. Uses observed/forecast temperature (Open-Meteo, a
  // BOM-equivalent source) because BOM's official warnings feed requires
  // registration and is not CORS-friendly in-browser. Returns a structured
  // warning the recommendation engine can consume. Degrades gracefully — if
  // weather data is unavailable it returns an inactive warning, not a throw.
  async function heatWarning(lat, lon) {
  try {
    const data = await uvToday(lat, lon);
    if (!data || !data.temp || !data.hours) return { active: false, severity: 'none', source: 'open-meteo', text: null };
    const now = new Date().getHours();
    let maxTemp = -Infinity;
    for (let i = 0; i < data.temp.length; i++) {
      if (data.hours[i] >= now && data.temp[i] != null && data.temp[i] > maxTemp) maxTemp = data.temp[i];
    }
    if (maxTemp === -Infinity || maxTemp == null) return { active: false, severity: 'none', source: 'open-meteo', text: null };
    if (maxTemp >= 40) return { active: true, severity: 'extreme', source: 'open-meteo', text: 'Extreme heat — forecast peak ' + maxTemp + 'C today.' };
    if (maxTemp >= 35) return { active: true, severity: 'high', source: 'open-meteo', text: 'Heatwave conditions — forecast peak ' + maxTemp + 'C today.' };
    if (maxTemp >= 32) return { active: true, severity: 'moderate', source: 'open-meteo', text: 'Hot conditions — forecast peak ' + maxTemp + 'C today.' };
    return { active: false, severity: 'none', source: 'open-meteo', text: null };
  } catch {
    return { active: false, severity: 'none', source: 'open-meteo', text: null, error: true };
  }
}

  return { bboxStr, signals, buildings, roads, pois, geocode, water, paths, indoor, route, routeVia, uvToday, uvAt, elevations, heatWarning,
           TRAIL_RE: new RegExp(TRAIL_KINDS) };
})();