/* ComfortRoute — loop-based route finder for Brisbane.
 * User picks a start point + distance; app generates 2–3 loop routes and ranks them
 * by conditions at the current moment (shade, UV, hills, traffic signals, water stops). */
'use strict';

(() => {
  const $ = id => document.getElementById(id);

  /* ================= map ================= */
  const map = L.map('map', { zoomControl: false }).setView([-27.4768, 153.0252], 15);
  // OpenStreetMap standard raster tiles — free, no API key, no registration required.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    maxZoom: 19
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const DEFAULT_START = { lat: -27.4782, lon: 153.0233, label: 'South Bank, Brisbane' };

  const state = {
    start: { ...DEFAULT_START },
    distKm: 3,
    sun: 'balanced',
    hills: 'balanced',
    sig: true,
    waterReq: false,
    seatsReq: false,
    avoidStairs: false,
    loops: [],
    selected: -1,
    busy: false,
    enrichRun: 0,
    startMarker: null,
    routeLayer: L.layerGroup().addTo(map),
    poiLayer: L.layerGroup().addTo(map),
    waterWays: [],
    end: null,
    endMarker: null,
    routeTarget: null,
    pinMode: 'start',
    pin: null,
    hour: null,
    bridgeWays: []
  };

  const setStatus = (msg, isError) => {
    $('status').textContent = msg || '';
    $('status').classList.toggle('error', !!isError);
    const rs = $('result-status'); // results view has its own status line
    rs.textContent = msg || '';
    rs.classList.toggle('error', !!isError);
  };

  /* ================= weather chip ================= */
  function fmtClock(d) {
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ap}`;
  }
  async function loadWeather() {
    try {
      const uvData = await API.uvToday(state.start.lat, state.start.lon);
      const { uv, temp } = API.uvAt(uvData, activeHour());
      $('wx-chip').textContent = `${fmtClock(Math.round(activeHour() * 60))} · ${Math.round(temp)}°C · UV ${uv.toFixed(1)}`;
    } catch {
      $('wx-chip').textContent = fmtClock(Math.round(activeHour() * 60));
    }
  }

  /* ================= time of day =================
   * null = follow the clock; otherwise a float hour (0–23.75) chosen by the
   * user. Sun position, shade and UV all key off this so a run can be
   * planned for later in the day. */
  const activeHour = () => {
    if (state.hour != null) return state.hour;
    const n = new Date();
    return n.getHours() + n.getMinutes() / 60;
  };
  function activeDate() {
    const h = activeHour();
    const d = new Date();
    d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
    return d;
  }
  function syncTimeUI() {
    const h = activeHour(), mins = Math.round(h * 60), label = fmtClock(mins);
    $('time-slider').value = h;
    $('time-out').textContent = label;
    $('time-slider2').value = h;
    $('time-out2').textContent = label;
  }
  function setHour(h, src) {
    state.hour = h;
    syncTimeUI();
    loadWeather(); // chip shows the selected time's UV/temperature
    // Live re-shade in the results view when the data is already loaded.
    if (liveCtx && state.loops.length && !$('panel-results').hidden) {
      const uv = liveCtx.uvData ? API.uvAt(liveCtx.uvData, h).uv : null;
      const sun = Sun.position(activeDate(), state.start.lat, state.start.lon);
      state.loops.forEach(l => applyShade(l, liveCtx.buildings || [], uv, sun));
      const prev = state.loops[state.selected];
      const t = state.routeTarget || state.distKm * 1000;
      state.loops.sort((a, b) => scoreLoop(b, t) - scoreLoop(a, t));
      state.selected = state.loops.indexOf(prev);
      renderCards();
      drawRoutes();
    }
    void src;
  }
  $('time-slider').addEventListener('input', e => setHour(parseFloat(e.target.value)));
  $('time-slider2').addEventListener('input', e => setHour(parseFloat(e.target.value)));
  $('btn-now').addEventListener('click', () => {
    const n = new Date();
    setHour(n.getHours() + n.getMinutes() / 60);
    state.hour = null; // follow the clock again
    syncTimeUI();
    loadWeather();
  });

  /* ================= start point ================= */
  // Accept Leaflet latlng (lat/lng), geolocation coords (latitude/longitude)
  // or plain {lat, lon} — mixing these up is what broke map-tap pins before.
  function normPt(p) {
    return { lat: p.lat ?? p.latitude, lon: p.lon ?? p.lng ?? p.longitude };
  }
  // Custom teardrop map pin, anchored at its tip so it marks the exact click point.
  function pinIcon(color, title) {
    return L.divIcon({
      className: '',
      html: `<svg width="30" height="41" viewBox="0 0 30 41" role="img" aria-label="${title}"><path d="M15 0C6.7 0 0 6.7 0 15c0 10.6 15 26 15 26s15-15.4 15-26C30 6.7 23.3 0 15 0z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="#fff"/></svg>`,
      iconSize: [30, 41], iconAnchor: [15, 39], popupAnchor: [0, -38]
    });
  }
  function setStart(p, label) {
    const q = normPt(p);
    state.start = { lat: q.lat, lon: q.lon, label };
    if (state.startMarker) state.startMarker.remove();
    state.startMarker = L.marker([q.lat, q.lon], {
      icon: pinIcon('#0b3d91', 'Start point'),
      title: 'Start point', alt: 'Start point'
    }).addTo(map);
    $('start-label').textContent = 'Start: ' + label;
    loadWater(); // keep river/water data warm for the new area (non-blocking)
  }

  /* ================= end point (point-to-point mode) ================= */
  function setEnd(p, label) {
    const q = normPt(p);
    state.end = { lat: q.lat, lon: q.lon, label };
    if (state.endMarker) state.endMarker.remove();
    state.endMarker = L.marker([q.lat, q.lon], {
      icon: pinIcon('#0a7d33', 'End point'),
      title: 'End point', alt: 'End point'
    }).addTo(map);
    const el = $('end-label');
    el.hidden = false;
    el.textContent = 'End: ' + label;
  }
  function clearEnd() {
    state.end = null;
    if (state.endMarker) { state.endMarker.remove(); state.endMarker = null; }
    $('end-label').hidden = true;
    if (state.pin && state.pin.role === 'end') { state.pin = null; $('pin-card').hidden = true; }
  }
  $('same-end').addEventListener('change', e => {
    if (e.target.checked) {
      clearEnd();
      $('dist-hint').textContent = 'Your loop will be about this long.';
    } else {
      $('end-row').hidden = false;
      $('end-input').focus();
      $('dist-hint').textContent = 'Priority: routes aim for this total distance — we take the long way round if the direct walk is shorter.';
    }
  });

  // Debounced place search wired to a text input + result listbox.
  function wireSearch(inputId, listId, onPick) {
    const input = $(inputId), list = $(listId);
    let timer = null;
    const close = () => { list.hidden = true; };
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 3) { close(); return; }
      list.innerHTML = '<div class="search-note">Searching…</div>';
      list.hidden = false;
      try {
        const hits = await API.geocode(q);
        list.innerHTML = '';
        if (!hits.length) {
          const d = document.createElement('div');
          d.className = 'search-note';
          d.textContent = 'No matches in Brisbane — try another name.';
          list.appendChild(d);
        }
        hits.forEach(h => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'search-hit';
          b.setAttribute('role', 'option');
          b.textContent = h.label;
          b.addEventListener('click', () => { close(); input.value = ''; onPick(h); });
          list.appendChild(b);
        });
      } catch {
        list.innerHTML = '<div class="search-note">Location search is unavailable right now — tap the map instead.</div>';
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 450); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
    input.addEventListener('blur', () => setTimeout(close, 250)); // let the click land first
  }
  wireSearch('start-input', 'start-results', h => {
    setStart(h, h.label);
    map.setView([h.lat, h.lon], 16);
  });
  wireSearch('end-input', 'end-results', h => {
    setEnd(h, h.label);
    if (state.startMarker) {
      map.fitBounds(L.latLngBounds([state.start, state.end].map(p => [p.lat, p.lon])).pad(0.3));
    }
  });

  /* ================= pin dropping (no typing needed) ================= */
  function setPinMode(m) {
    state.pinMode = m;
    $('pin-start').setAttribute('aria-pressed', String(m === 'start'));
    $('pin-end').setAttribute('aria-pressed', String(m === 'end'));
    // Dropping an end pin implies point-to-point mode.
    if (m === 'end' && $('same-end').checked) {
      $('same-end').checked = false;
      $('same-end').dispatchEvent(new Event('change'));
    }
  }
  $('pin-start').addEventListener('click', () => setPinMode('start'));
  $('pin-end').addEventListener('click', () => setPinMode('end'));

  /* ================= dropped-pin card (precise coordinates) ================= */
  function showPinCard(lat, lon, role) {
    state.pin = { lat, lon, role };
    $('pin-card-title').textContent = role === 'end' ? '🟩 End pin dropped' : '🟢 Start pin dropped';
    $('pin-coords').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    $('pin-card').hidden = false;
  }
  const pinLabel = p => `pin ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

  map.on('click', e => {
    if (state.busy || !$('panel-setup').offsetParent) return; // ignore in results view
    const lat = e.latlng.lat, lon = e.latlng.lng;
    const label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    if (state.pinMode === 'end') { setEnd(e.latlng, label); showPinCard(lat, lon, 'end'); }
    else { setStart(e.latlng, label); showPinCard(lat, lon, 'start'); }
  });

  // Reassign the dropped pin without tapping the map again.
  $('pin-use-start').addEventListener('click', () => {
    if (!state.pin) return;
    setStart(state.pin, pinLabel(state.pin));
    state.pin.role = 'start';
    $('pin-card-title').textContent = '🟢 Start pin dropped';
  });
  $('pin-use-end').addEventListener('click', () => {
    if (!state.pin) return;
    if ($('same-end').checked) { $('same-end').checked = false; $('same-end').dispatchEvent(new Event('change')); }
    setEnd(state.pin, pinLabel(state.pin));
    state.pin.role = 'end';
    $('pin-card-title').textContent = '🟩 End pin dropped';
  });
  // Clear → remove the pin so a fresh start or end pin can be placed.
  $('pin-clear').addEventListener('click', () => {
    if (!state.pin) return;
    const role = state.pin.role;
    state.pin = null;
    $('pin-card').hidden = true;
    if (role === 'end') clearEnd();
    else setStart(DEFAULT_START, DEFAULT_START.label);
    setStatus('Pin cleared — choose 🟢 Start pin or 🟩 End pin, then tap the map to place a new one.');
  });

  $('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus('Geolocation is not available in this browser.', true); return; }
    setStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setStart(pos.coords, 'your location');
        map.setView([pos.coords.latitude, pos.coords.longitude], 16);
        setStatus('');
      },
      () => setStatus('Could not get your location — tap the map instead.', true),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  /* ================= inputs ================= */
  function setDist(km) {
    state.distKm = km;
    $('dist-out').textContent = km + ' km';
    $('dist-slider').value = km;
    document.querySelectorAll('#dist-chips .chip-btn').forEach(b =>
      b.setAttribute('aria-pressed', String(parseFloat(b.dataset.km) === km)));
  }
  document.querySelectorAll('#dist-chips .chip-btn').forEach(b =>
    b.addEventListener('click', () => setDist(parseFloat(b.dataset.km))));
  $('dist-slider').addEventListener('input', e => setDist(parseFloat(e.target.value)));

  // Preference chips: one bound group per state key; picks re-rank instantly
  // when conditions are already loaded.
  function bindPrefChips(id, key) {
    document.querySelectorAll(`#${id} .chip-btn`).forEach(b =>
      b.addEventListener('click', () => {
        state[key] = key === 'sig' ? b.dataset.sig === 'on'
          : key === 'waterReq' ? b.dataset.water === 'on'
          : key === 'seatsReq' ? b.dataset.seat === 'on'
          : key === 'avoidStairs' ? b.dataset.stairs === 'avoid'
          : b.dataset[key];
        document.querySelectorAll(`#${id} .chip-btn`).forEach(x =>
          x.setAttribute('aria-pressed', String(x === b)));
        // Re-rank instantly when conditions are already loaded.
        if (state.loops.length && state.loops[0].shadePct != null && !$('panel-results').hidden) {
          const prev = state.loops[state.selected];
          const t = state.routeTarget || state.distKm * 1000;
          state.loops.sort((x, y) => scoreLoop(y, t) - scoreLoop(x, t));
          state.selected = state.loops.indexOf(prev);
          renderCards();
          drawRoutes();
        }
      }));
  }
  bindPrefChips('sun-chips', 'sun');
  bindPrefChips('hill-chips', 'hills');
  bindPrefChips('sig-chips', 'sig');
  bindPrefChips('water-chips', 'waterReq');
  bindPrefChips('seat-chips', 'seatsReq');
  bindPrefChips('stairs-chips', 'avoidStairs');

  $('btn-back').addEventListener('click', () => {
    state.enrichRun++; // cancel any background enrichment
    state.loops = [];
    state.selected = -1;
    state.routeLayer.clearLayers();
    state.poiLayer.clearLayers();
    $('panel-results').hidden = true;
    $('panel-setup').hidden = false;
    setStatus('');
  });
  /* ================= loop generation ================= */
  // Radius of an n-waypoint loop whose on-street length ≈ target metres.
  function loopRadius(n, target) {
    const perim = 2 * n * Math.sin(Math.PI / n);   // polygon perimeter / r
    return target / (perim * 1.4);                 // 1.4 = measured street detour factor (Brisbane)
  }

  function onWater(p, limitM) {
    // A point on a bridge deck is legitimately over water — never flag it.
    for (const b of state.bridgeWays) {
      if (Geo.pointToLineDist(p, b.pts) < 30) return false;
    }
    for (const w of state.waterWays) {
      if (w.tags.natural === 'water'
        ? Geo.pointInPoly(p, w.pts)
        : (w.tags.waterway === 'river' || w.tags.waterway === 'canal') &&
          Geo.pointToLineDist(p, w.pts) < limitM) return true;
    }
    return false;
  }

  // True when the route itself crosses open water (no bridge under that stretch).
  function crossesWater(pts) {
    for (let i = 0; i < pts.length; i += 3) {
      if (onWater(pts[i], 40)) return true;
    }
    return false;
  }

  function makeCandidate(target) {
    let wps = [];
    for (let tries = 0; tries < 12; tries++) {
      const n = Math.random() < 0.5 ? 3 : 4;
      const r = loopRadius(n, target) * (0.9 + Math.random() * 0.2);
      const theta0 = Math.random() * 2 * Math.PI;
      wps = [];
      for (let i = 0; i < n; i++) {
        const th = theta0 + i * 2 * Math.PI / n + (Math.random() - 0.5) * 0.5;
        wps.push({
          lat: state.start.lat + (r / 111320) * Math.sin(th),
          lon: state.start.lon + (r / (111320 * Math.cos(state.start.lat * Math.PI / 180))) * Math.cos(th)
        });
      }
      // Only place waypoints on land → loops cross the river on bridges, never over it.
      if (!wps.some(w => onWater(w, 90))) break;
    }
    return [state.start, ...wps, state.start];
  }

  async function generateLoops(target) {
    // One parallel batch of candidates → routes on screen in ~1 s.
    const collect = async n => {
      const batch = Array.from({ length: n }, () => makeCandidate(target));
      const results = await Promise.allSettled(batch.map(b => API.routeVia(b)));
      return results.filter(r => r.status === 'fulfilled').map(r => r.value);
    };
    let cands = await collect(8);
    if (!cands.length) return [];
    // Prefer loops that stay out of the water (bridge crossings only).
    const dry = cands.filter(c => !crossesWater(c.pts));
    if (dry.length) cands = dry;
    let pool = cands.slice().sort((a, b) => Math.abs(a.dist - target) - Math.abs(b.dist - target));
    // Deduplicate near-identical loops.
    let uniq = [];
    for (const c of pool) {
      if (!uniq.some(u => overlapFrac(u.pts, c.pts) > 0.55)) uniq.push(c);
    }
    if (uniq.length < 3) { // rare: one retry with a fresh batch
      cands = cands.concat(await collect(4));
      const dry2 = cands.filter(c => !crossesWater(c.pts));
      if (dry2.length) cands = dry2;
      pool = cands.slice().sort((a, b) => Math.abs(a.dist - target) - Math.abs(b.dist - target));
      uniq = [];
      for (const c of pool) {
        if (!uniq.some(u => overlapFrac(u.pts, c.pts) > 0.55)) uniq.push(c);
      }
    }
    return uniq.slice(0, 5);
  }

  // Fraction of a's points lying within 40 m of b's line.
  function overlapFrac(a, b) {
    let hit = 0, n = 0;
    for (let i = 0; i < a.length; i += 5) {
      n++;
      if (Geo.pointToLineDist(a[i], b) < 40) hit++;
    }
    return n ? hit / n : 0;
  }

  /* ============ long-way-round (distance is the priority) ============
   * Start and end may be close together, but the user asked for a longer
   * run: place a via point on the ellipse whose focal sum equals the
   * straight-line length needed so the snapped street route lands close
   * to the requested distance. */
  async function generateDetours(targetM, directDist) {
    const A = state.start, B = state.end;
    const chord = Geo.haversine(A, B);
    const detour = Math.max(directDist / chord, 1.15); // street factor vs straight line
    const geoTarget = targetM / detour;                // straight-line length to aim for
    const a = geoTarget / 2;                           // semi-major axis (focal sum = 2a)
    const c = chord / 2;                               // focal distance
    if (a <= c * 1.06) return [];                      // target unreachable even with max detour
    const b = Math.sqrt(a * a - c * c);                // semi-minor axis
    const midLat = (A.lat + B.lat) / 2, midLon = (A.lon + B.lon) / 2;
    // Unit chord vector in metres (east, north) + perpendicular.
    const ex = (B.lon - A.lon) * 111320 * Math.cos(A.lat * Math.PI / 180);
    const ny = (B.lat - A.lat) * 111320;
    const len = Math.hypot(ex, ny) || 1;
    const ux = ex / len, uy = ny / len;
    const vx = -uy, vy = ux;
    const toLL = (x, y) => ({
      lat: midLat + (x * uy + y * vy) / 111320,
      lon: midLon + (x * ux + y * vx) / (111320 * Math.cos(midLat * Math.PI / 180))
    });
    const vias = [];
    for (let i = 0; i < 40 && vias.length < 8; i++) {
      const t = Math.random() * 2 * Math.PI;
      const v = toLL(a * Math.cos(t), b * Math.sin(t)); // |Av| + |vB| = geoTarget
      if (onWater(v, 90)) continue;                     // via points stay on land
      if (Geo.haversine(v, A) < 200 || Geo.haversine(v, B) < 200) continue;
      vias.push(v);
    }
    if (!vias.length) return [];
    const results = await Promise.allSettled(vias.map(v => API.routeVia([A, v, B])));
    let cands = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!cands.length) return [];
    const near = cands.filter(r => r.dist > targetM * 0.85 && r.dist < targetM * 1.15);
    if (near.length) cands = near;
    const dry = cands.filter(r => !crossesWater(r.pts));
    if (dry.length) cands = dry;
    const uniq = [];
    for (const r of cands.slice().sort((x, y) => Math.abs(x.dist - targetM) - Math.abs(y.dist - targetM))) {
      if (!uniq.some(u => overlapFrac(u.pts, r.pts) > 0.6)) uniq.push(r);
    }
    return uniq.slice(0, 5);
  }

  // Resample a polyline every `step` metres, tagging each point with its distance.
  function resample(pts, step) {
    const out = [{ ...pts[0], d: 0 }];
    let prev = pts[0], acc = 0;
    for (let i = 1; i < pts.length; i++) {
      let cur = pts[i];
      let seg = Geo.haversine(prev, cur);
      while (acc + seg >= step) {
        const t = (step - acc) / seg;
        const np = { lat: prev.lat + (cur.lat - prev.lat) * t, lon: prev.lon + (cur.lon - prev.lon) * t };
        out.push({ ...np, d: out.length * step });
        prev = np;
        seg = Geo.haversine(prev, cur);
        acc = 0;
      }
      acc += seg;
      prev = cur;
    }
    return out;
  }

  /* ================= analysis (conditions right now) =================
     Split into per-dataset steps so each metric appears on the cards as soon
     as its data arrives: signals → POIs (water/benches) → paths (trails/
     stairs) → indoor → shade/UV (buildings are the slowest query) → grade. */
  function getSamples(loop, step = 40) {
    if (!loop._samples) loop._samples = resample(loop.pts, step);
    return loop._samples;
  }
  function applyShade(loop, buildings, uv, sun) {
    const samples = getSamples(loop);
    const shades = samples.map(s => Sun.shadeGivenSun(s, buildings, sun));
    loop.samples = samples.map((s, i) => ({ ...s, shade: shades[i] }));
    loop.shadePct = shades.reduce((a, b) => a + b, 0) / shades.length;
    loop.uvEff = uv == null ? null : Sun.effectiveUV(uv, loop.shadePct);
  }
  function applySignals(loop, signals) {
    loop.signals = signals.filter(sig => Geo.pointToLineDist(sig, loop.pts) < 30).length;
    loop.signalsPerKm = loop.signals / (loop.dist / 1000);
  }
  function applyIndoor(loop, indoor) {
    loop.indoor = indoor.some(w => {
      for (let i = 0; i < loop.pts.length; i += 4) {
        if (Geo.pointToLineDist(loop.pts[i], w.pts) < 12) return true;
      }
      return false;
    });
  }
  function applyAmenities(loop, water, benches) {
    const samples = getSamples(loop);
    const total = loop.dist;

    // Water stops along the loop + largest gap between them.
    const stops = water
      .map(w => {
        let best = Infinity, bestD = 0;
        for (const s of samples) {
          const d = Geo.haversine(s, w);
          if (d < best) { best = d; bestD = s.d; }
        }
        return best < 35 ? bestD : null;
      })
      .filter(d => d !== null)
      .sort((a, b) => a - b);
    loop.waterCount = stops.length;
    let maxGap = total;
    let prevD = 0;
    const marks = [...stops, total];
    for (const d of marks) { maxGap = Math.max(maxGap, d - prevD); prevD = d; }
    loop.maxGapKm = maxGap / 1000;

    // Benches / rest points along the loop + largest gap between them.
    const benchStops = benches
      .map(b => {
        let best = Infinity, bestD = 0;
        for (const s of samples) {
          const d = Geo.haversine(s, b);
          if (d < best) { best = d; bestD = s.d; }
        }
        return best < 30 ? bestD : null;
      })
      .filter(d => d !== null)
      .sort((a, b) => a - b);
    loop.benchCount = benchStops.length;
    let benchGap = total, benchPrev = 0;
    const benchMarks = [...benchStops, total];
    for (const d of benchMarks) { benchGap = Math.max(benchGap, d - benchPrev); benchPrev = d; }
    loop.benchGapKm = benchGap / 1000;
  }
  function applyTrails(loop, paths) {
    const samples = getSamples(loop);
    // Stairs (highway=steps) within 12 m of the loop — matters for wheelchairs,
    // strollers and injured runners.
    loop.stepsHit = paths.filter(w => w.kind === 'steps').some(w => {
      for (let i = 0; i < loop.pts.length; i += 4) {
        if (Geo.pointToLineDist(loop.pts[i], w.pts) < 12) return true;
      }
      return false;
    });

    // Trail vs road character: fraction of the loop on walking/running paths
    // (within 20 m) and on busy corridors (within 20 m) — PT corridors are
    // excluded from foot routing by the router itself. Sidewalk footways hug
    // roads, so each sample is classified by its NEAREST way, and sidewalk/
    // crossing footways never count as trails. Per-way bounding boxes keep
    // this fast even with ~10k OSM ways in view.
    const pad = 20 / 111320; // ~20 m in degrees
    const index = ways => ways.map(w => {
      let mLa = 90, xLa = -90, mLo = 180, xLo = -180;
      for (const p of w.pts) {
        if (p.lat < mLa) mLa = p.lat; if (p.lat > xLa) xLa = p.lat;
        if (p.lon < mLo) mLo = p.lon; if (p.lon > xLo) xLo = p.lon;
      }
      return { w, mLa, xLa, mLo, xLo };
    });
    const isSidewalk = w => w.footway === 'sidewalk' || w.footway === 'crossing' || w.footway === 'link';
    const trailWays = paths.filter(w => API.TRAIL_RE.test(w.kind) && !isSidewalk(w));
    const busyWays = paths.filter(w => !API.TRAIL_RE.test(w.kind) || isSidewalk(w));
    const trails = index(trailWays);
    const busy = index(busyWays);
    const bestDist = (s, arr) => {
      let best = Infinity;
      for (const b of arr) {
        if (s.lat < b.mLa - pad || s.lat > b.xLa + pad || s.lon < b.mLo - pad || s.lon > b.xLo + pad) continue;
        const d = Geo.pointToLineDist(s, b.w.pts);
        if (d < best) best = d;
      }
      return best;
    };
    let onTrail = 0, onBusy = 0;
    for (const s of samples) {
      const dt = bestDist(s, trails), db = bestDist(s, busy);
      if (dt <= 20 && dt <= db) onTrail++;
      else if (db <= 20) onBusy++;
    }
    const n = samples.length || 1;
    loop.trailPct = onTrail / n;
    loop.busyPct = onBusy / n;
  }
  // Elevation → gradient stats (sampled ~every 120 m, capped).
  async function applyGrade(loop) {
    const samples = getSamples(loop);
    const stride = 3;
    const ePts = samples.filter((_, i) => i % stride === 0).slice(0, 150);
    loop.meanGrade = 0; loop.maxGrade = 0; loop.climb = 0;
    try {
      const elevs = await API.elevations(ePts);
      let climb = 0, worst = 0, sum = 0, cnt = 0;
      for (let i = stride; i < samples.length; i += stride) {
        const j = Math.min(elevs.length - 1, Math.round(i / stride));
        const k = j - 1;
        if (k < 0) continue;
        const dh = elevs[j] - elevs[k];
        const dx = stride * 40;
        if (dh > 0) climb += dh;
        const g = Math.abs(dh) / dx * 100;
        sum += g; cnt++;
        if (g > worst) worst = g;
      }
      loop.climb = climb;
      loop.meanGrade = cnt ? sum / cnt : 0;
      loop.maxGrade = worst;
    } catch { /* leave grade stats at 0 if the elevation API fails */ }
  }
  /* ================= scoring ================= */
  // Additive preference scoring: each preference contributes 0..1; "balanced"
  // options contribute a neutral constant so they don't skew the ranking.
  function scoreLoop(a, target) {
    const distPen = Math.abs(a.dist - target) / target;
    // Missing metrics score neutral (0.5) so partially-measured loops rank
    // sensibly while the rest of the data streams in.
    const shadeS = a.shadePct == null ? 0.5 : a.shadePct;
    const uvS = a.uvEff == null ? 0.5 : Geo.clamp(1 - a.uvEff / 9, 0, 1);
    const flatS = (a.meanGrade == null ? 0.5 : Geo.clamp(1 - a.meanGrade / 5, 0, 1)) * 0.6 +
                  (a.maxGrade == null ? 0.5 : Geo.clamp(1 - a.maxGrade / 12, 0, 1)) * 0.4;
    const sigS = a.signalsPerKm == null ? 0.5 : Geo.clamp(1 - a.signalsPerKm / 3, 0, 1);
    const waterS = a.waterCount ? Geo.clamp(1 - a.maxGapKm / (state.waterReq ? 1.5 : 3), 0, 1) : 0;
    const benchS = a.benchCount ? Geo.clamp(1 - a.benchGapKm / (state.seatsReq ? 1.0 : 2), 0, 1) : 0;

    // Sunlight: sunny → favour open sun & high UV; shaded → favour shade & low UV.
    let sunScore;
    if (state.sun === 'sunny') sunScore = 0.6 * (1 - shadeS) + 0.4 * (1 - uvS);
    else if (state.sun === 'shaded') sunScore = 0.6 * shadeS + 0.4 * uvS;
    else sunScore = 0.5 * shadeS + 0.5 * uvS; // balanced

    // Hills: avoid → flat is best; seek → climbs & steep sections are the point.
    let hillScore;
    if (state.hills === 'avoid') hillScore = flatS;
    else if (state.hills === 'seek') hillScore = 0.75 * (1 - flatS) + 0.25 * Geo.clamp(a.maxGrade / 12, 0, 1);
    else hillScore = 0.5; // balanced (neutral)

    // Signals: hard minimisation when on, neutral otherwise.
    const sigScore = state.sig ? sigS : 0.5;

    // Trail character: prefer walking/running paths, penalise busy corridors
    // (public-transport corridors aren't routable on foot anyway).
    const trailScore = Geo.clamp((a.trailPct || 0) * 1.2 - (a.busyPct || 0) * 0.8, 0, 1);

    // Amenity requirement: when water or benches are needed, they become the
    // dominant factor; otherwise water is a light preference and benches neutral.
    let s;
    if (state.waterReq || state.seatsReq) {
      const wW = state.waterReq ? 0.25 : 0.05;
      const bW = state.seatsReq ? 0.25 : 0.05;
      s = 0.20 * sunScore + 0.15 * hillScore + 0.10 * trailScore + 0.05 * sigScore + wW * waterS + bW * benchS;
    } else {
      s = 0.35 * sunScore + 0.25 * hillScore + 0.20 * trailScore + 0.10 * sigScore + 0.10 * waterS;
    }
    s -= distPen * 0.5;
    if (a.indoor) s = -1; // hard rule: never route through buildings
    if (state.waterReq && a.waterCount === 0) s -= 2; // hard rule: no taps → bottom of the list
    if (state.seatsReq && a.benchCount === 0) s -= 1.5; // hard rule: nowhere to rest
    if (state.avoidStairs && a.stepsHit) s -= 3; // hard rule: stairs are a no-go
    return s;
  }

  /* ================= rendering ================= */
  function shadeColor(v) {
    return v >= 0.55 ? '#1565d8' : v <= 0.25 ? '#d97400' : '#6b7280';
  }

  function drawRoutes() {
    state.routeLayer.clearLayers();
    state.poiLayer.clearLayers();
    state.loops.forEach((loop, i) => {
      if (i === state.selected && loop.samples) {
        for (let k = 1; k < loop.samples.length; k++) {
          L.polyline([[loop.samples[k - 1].lat, loop.samples[k - 1].lon], [loop.samples[k].lat, loop.samples[k].lon]],
            { color: shadeColor(loop.samples[k].shade), weight: 6, opacity: 0.95 }).addTo(state.routeLayer);
        }
        loop.waterMarks.forEach(w =>
          L.circleMarker([w.lat, w.lon], { radius: 8, color: '#0b3d91', weight: 2, fillColor: '#7cc0ff', fillOpacity: 1 })
            .bindTooltip(w.name, { direction: 'top' })
            .addTo(state.poiLayer));
      } else {
        const sel = i === state.selected;
        const line = L.polyline(loop.pts.map(p => [p.lat, p.lon]),
          { color: sel ? '#0b3d91' : '#9ca3af', weight: sel ? 6 : 4, opacity: sel ? 0.9 : 0.75 }).addTo(state.routeLayer);
        line.on('click', () => selectLoop(i));
      }
    });
  }

  function selectLoop(i, fit = true) {
    state.selected = i;
    drawRoutes();
    if (!fit) return;
    const loop = state.loops[i];
    map.fitBounds(L.latLngBounds(loop.pts.map(p => [p.lat, p.lon])).pad(0.1));
    document.querySelectorAll('.card').forEach((c, k) => {
      c.classList.toggle('selected', k === i);
      c.setAttribute('aria-pressed', String(k === i));
    });
  }
  function renderCards() {
    const box = $('cards');
    box.innerHTML = '';
    const nz = (v, f) => (v == null ? '…' : f(v));
    state.loops.forEach((loop, i) => {
      const mins = Math.round(loop.distKm * 5.5);
      const measured = loop.shadePct != null;
      const btn = document.createElement('button');
      btn.className = 'card' + (i === state.selected ? ' selected' : '');
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('aria-pressed', String(i === state.selected));
      btn.setAttribute('aria-label',
        `Route ${i + 1}: ${loop.distKm.toFixed(1)} kilometres, about ${mins} minutes. ` +
        (measured
          ? `${Math.round(loop.shadePct * 100)} percent shaded, UV ${loop.uvEff.toFixed(1)}. ` +
            `${Math.round((loop.trailPct || 0) * 100)} percent on paths or trails. ` +
            `Maximum grade ${Math.round(loop.maxGrade)} percent, ${loop.climb ? Math.round(loop.climb) + ' metres of climbing, ' : ''}` +
            `${loop.signals} traffic signals, ${loop.waterCount} water stops, ${loop.benchCount} benches.` +
            (state.waterReq && !loop.waterCount ? ' Warning: no water taps on this route.' : '') +
            (state.seatsReq && !loop.benchCount ? ' Warning: no benches on this route.' : '') +
            (state.avoidStairs && loop.stepsHit ? ' Warning: includes stairs.' : '') +
            (loop.indoor ? ' Warning: passes through buildings.' : '')
          : 'Measuring shade, hills and traffic signals.'));
      btn.innerHTML =
        `<span class="rank">#${i + 1}</span>
         <span class="stats">
           <strong>${loop.distKm.toFixed(1)} km · ≈${mins} min run</strong>
           <span>🌳 ${nz(loop.shadePct, v => Math.round(v * 100) + '% shaded')}</span>
           <span>🌿 ${nz(loop.trailPct, v => Math.round(v * 100) + '% trails')}</span>
           <span>☀️ ${nz(loop.uvEff, v => 'UV ' + v.toFixed(1))}</span>
           <span>⛰️ ${nz(loop.maxGrade, v => Math.round(v) + '% max · ' + Math.round(loop.climb) + ' m up')}</span>
           <span>🚦 ${nz(loop.signals, v => v + ' signals')}</span>
           <span>💧 ${nz(loop.waterCount, v => v + ' water' + (state.waterReq && v === 0 ? ' ⚠' : ''))}</span>
           <span>🪑 ${nz(loop.benchCount, v => v + ' benches' + (state.seatsReq && v === 0 ? ' ⚠' : ''))}</span>
         </span>` +
        (loop.indoor ? '<span class="warn">⚠ Passes through buildings</span>' : '') +
        (measured && state.waterReq && !loop.waterCount ? '<span class="warn">⚠ No water taps en route</span>' : '') +
        (measured && state.seatsReq && !loop.benchCount ? '<span class="warn">⚠ No benches en route</span>' : '') +
        (measured && state.avoidStairs && loop.stepsHit ? '<span class="warn">⚠ Stairs on route</span>' : '');
      btn.addEventListener('click', () => selectLoop(i));
      box.appendChild(btn);
    });
  }
  /* ================= main flow ================= */
  // Stage 1 shows routes instantly; stage 2 fills in conditions in the background.
  function initPlaceholders(loop, target) {
    loop.distKm = loop.dist / 1000;
    loop.fit = Math.abs(loop.dist - target) / target;
    loop.shadePct = null;
    loop.uvEff = null;
    loop.signals = null;
    loop.signalsPerKm = null;
    loop.waterCount = null;
    loop.waterMarks = [];
    loop.benchCount = null;
    loop.benchGapKm = null;
    loop.stepsHit = null;
    loop.trailPct = null;
    loop.busyPct = 0;
    loop.maxGrade = null;
    loop.climb = null;
    loop.indoor = false;
  }

  // Water features cached per ~1 km grid cell (warmed at boot and on start moves).
  const waterCache = new Map();
  function loadWater() {
    const s = state.start;
    const key = `${s.lat.toFixed(2)},${s.lon.toFixed(2)}`;
    if (!waterCache.has(key)) {
      const pad = (state.distKm / 2 + 1.2) / 111;
      const q = v => (Math.round(v * 1000) / 1000).toFixed(3);
      const bbox = `${q(s.lat - pad)},${q(s.lon - pad)},${q(s.lat + pad)},${q(s.lon + pad)}`;
      waterCache.set(key, API.water(bbox).then(ways => {
        if (key === `${state.start.lat.toFixed(2)},${state.start.lon.toFixed(2)}`) {
          state.waterWays = ways.filter(w => w.tags.waterway || w.tags.natural === 'water');
          state.bridgeWays = ways.filter(w => w.tags.bridge);
        }
        return ways;
      }).catch(() => []));
    }
    return waterCache.get(key);
  }

  // Condition data: individual promises per dataset, so each metric renders
  // the moment its data lands (cached per area per session).
  const ctxCache = new Map();
  let liveCtx = null; // cached buildings + UV for live time-of-day re-shading
  function loadContext() {
    const s = state.start;
    const key = `${s.lat.toFixed(3)},${s.lon.toFixed(3)},${Math.round(state.distKm)}`;
    if (!ctxCache.has(key)) {
      const pad = (state.distKm / 2 + 0.6) / 111;
      const q = v => (Math.round(v * 1000) / 1000).toFixed(3);
      const bbox = `${q(s.lat - pad)},${q(s.lon - pad)},${q(s.lat + pad)},${q(s.lon + pad)}`;
      const safe = p => p.catch(() => null);
      ctxCache.set(key, {
        uvP: safe(API.uvToday(s.lat, s.lon)),
        buildingsP: safe(API.buildings(bbox)),
        signalsP: safe(API.signals(bbox)),
        poisP: safe(API.pois(bbox)),
        indoorP: safe(API.indoor(bbox)),
        pathsP: safe(API.paths(bbox))
      });
    }
    return ctxCache.get(key);
  }

  async function enrichLoops(target) {
    const run = ++state.enrichRun;
    const alive = () => run === state.enrichRun && !$('panel-results').hidden;
    const rerank = () => {
      if (!alive()) return false;
      const prev = state.loops[state.selected];
      state.loops.sort((a, b) => scoreLoop(b, target) - scoreLoop(a, target));
      state.selected = state.loops.indexOf(prev);
      renderCards();
      drawRoutes();
      return true;
    };
    try {
      const ctx = loadContext();
      const uvData = await ctx.uvP;
      const uv = uvData ? API.uvAt(uvData, activeHour()).uv : null;
      const sun = Sun.position(activeDate(), state.start.lat, state.start.lon);

      // Per-dataset pipeline: apply to every loop and refresh the cards the
      // moment each dataset arrives — no waiting for the slowest query.
      const jobs = [
        ctx.signalsP.then(signals => {
          if (!alive() || !signals) return;
          state.loops.forEach(l => applySignals(l, signals));
          rerank();
        }),
        ctx.poisP.then(pois => {
          if (!alive()) return;
          const water = (pois ? pois.filter(p => p.type === 'water') : []).concat(SEED_POIS.filter(p => p.type === 'water'));
          const benches = (pois ? pois.filter(p => p.type === 'bench') : []).concat(SEED_POIS.filter(p => p.type === 'bench'));
          state.loops.forEach(l => {
            applyAmenities(l, water, benches);
            l.waterMarks = water.filter(w => Geo.pointToLineDist(w, l.pts) < 35);
          });
          rerank();
        }),
        ctx.pathsP.then(paths => {
          if (!alive() || !paths) return;
          state.loops.forEach(l => applyTrails(l, paths));
          rerank();
        }),
        ctx.indoorP.then(indoor => {
          if (!alive() || !indoor) return;
          state.loops.forEach(l => applyIndoor(l, indoor));
          rerank();
        }),
        ctx.buildingsP.then(buildings => {
          if (!alive()) return;
          liveCtx = { buildings: buildings || [], uvData }; // enables live time slider re-shading
          state.loops.forEach(l => applyShade(l, buildings || [], uv, sun));
          rerank();
        }),
        (async () => {
          for (const l of state.loops.slice()) {
            if (!alive()) return;
            await applyGrade(l);
          }
          rerank();
        })()
      ];
      await Promise.all(jobs);
      if (!alive() || !rerank()) return;
      if (state.waterReq && !state.loops.some(l => l.waterCount > 0)) {
        setStatus('No water taps found near these loops — try a longer distance or move the start point closer to parks or the river.', true);
      } else if (state.waterReq && !state.loops[0].waterCount) {
        setStatus('None of the top routes pass a water tap — check the ⚠ badge or search again for more options.', true);
      } else if (state.seatsReq && !state.loops.some(l => l.benchCount > 0)) {
        setStatus('No benches found near these loops — try a longer distance or a riverside/park start point.', true);
      } else if (state.seatsReq && !state.loops[0].benchCount) {
        setStatus('None of the top routes pass a bench — check the ⚠ badge or search again.', true);
      } else if (state.avoidStairs && state.loops.every(l => l.stepsHit)) {
        setStatus('All of these loops include stairs — try moving the start point or a different distance.', true);
      } else {
        setStatus('');
      }
    } catch {
      if (run === state.enrichRun) setStatus('Could not load conditions — showing routes ranked by distance fit.', true);
    }
  }

  $('btn-find').addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    $('btn-find').disabled = true;
    const endPt = state.end;
    const isLoop = !endPt || Geo.haversine(state.start, endPt) < 150;
    const target = isLoop ? state.distKm * 1000 : 0;
    try {
      setStatus(isLoop ? 'Finding loops…' : 'Finding routes…');
      state.waterWays = await loadWater(); // usually instant (warmed at boot)
      let picks;
      if (isLoop) {
        picks = await generateLoops(target);
        if (!picks.length) throw new Error('Could not build a loop of that distance here — try moving the start point or changing the distance.');
        picks.forEach(l => initPlaceholders(l, target));
        $('results-title').textContent = 'Loop options';
        $('cards').setAttribute('aria-label', 'Suggested loop routes');
      } else {
        // Point-to-point: the requested distance is the priority.
        const direct = await API.route(state.start, endPt, false);
        const directDist = direct[0] ? direct[0].dist : Geo.haversine(state.start, endPt);
        if (target > directDist * 1.25) {
          // Far apart in distance terms → wander through nearby paths to hit it.
          picks = await generateDetours(target, directDist);
          if (!picks.length) throw new Error(`Couldn't stretch a route between those places to ${state.distKm} km — they're only ${(directDist / 1000).toFixed(1)} km apart. Try a shorter distance or a loop instead.`);
          picks.forEach(r => initPlaceholders(r, target)); // fit = distance accuracy
          $('results-title').textContent = `Long-way-round · ${state.distKm} km start → end`;
          $('cards').setAttribute('aria-label', 'Suggested long routes from start to end');
        } else {
          picks = await API.route(state.start, endPt, true);
          const dry = picks.filter(r => !crossesWater(r.pts));
          if (dry.length) picks = dry; // bridge crossings only, never over water
          const uniq = [];
          for (const r of picks) {
            if (!uniq.some(u => overlapFrac(u.pts, r.pts) > 0.7)) uniq.push(r);
          }
          picks = uniq;
          if (!picks.length) throw new Error('No walking route found between those points — try moving the end pin somewhere reachable on foot.');
          picks.forEach(r => initPlaceholders(r, r.dist)); // fit = 0 → keep OSRM's order
          $('results-title').textContent = target < directDist * 0.95
            ? `Shortest start → end (target ${state.distKm} km is below the ${(directDist / 1000).toFixed(1)} km direct walk)`
            : 'Start → End routes';
          $('cards').setAttribute('aria-label', 'Suggested routes');
        }
      }
      state.routeTarget = isLoop ? target : (picks[0] ? picks[0].dist : target);
      picks.sort((a, b) => a.fit - b.fit);
      state.loops = picks.slice(0, 3);
      state.selected = 0;

      $('panel-setup').hidden = true;
      $('panel-results').hidden = false;
      renderCards();
      drawRoutes();
      selectLoop(0);
      document.querySelector('.card')?.focus();
      setStatus('Routes ready — measuring conditions…');
      loadWeather();
      enrichLoops(state.routeTarget); // background, not awaited
    } catch (err) {
      setStatus(err.message || 'Something went wrong — please try again.', true);
    } finally {
      state.busy = false;
      $('btn-find').disabled = false;
    }
  });

  /* ================= boot ================= */
  setStart(DEFAULT_START, DEFAULT_START.label);
  setDist(3);
  syncTimeUI();
  loadWeather();
  loadWater(); // warm river/water data so the first search is fast
})();




