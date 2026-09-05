/* ComfortRoute — shared geo + formatting helpers. */
'use strict';
const Geo = (() => {
  const R = 6371000; // Earth radius (m)
  const toRad = d => d * Math.PI / 180;

  // Great-circle distance in meters between {lat, lon} points.
  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const la1 = toRad(a.lat);
    const la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Initial bearing in degrees (0 = North, clockwise).
  function bearing(a, b) {
    const la1 = toRad(a.lat);
    const la2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Point-to-segment distance in meters (local flat approximation, fine < ~2 km).
  function pointToSegDist(p, a, b) {
    const lat0 = toRad(a.lat);
    const my = 111320;
    const mx = 111320 * Math.cos(lat0);
    const px = (p.lon - a.lon) * mx;
    const py = (p.lat - a.lat) * my;
    const bx = (b.lon - a.lon) * mx;
    const by = (b.lat - a.lat) * my;
    const L2 = bx * bx + by * by;
    let t = L2 ? (px * bx + py * by) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx;
    const dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Min distance (m) from point to polyline [{lat, lon}].
  function pointToLineDist(p, line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const d = pointToSegDist(p, line[i - 1], line[i]);
      if (d < best) best = d;
    }
    return best;
  }

  // Ray-casting point-in-polygon test for [{lat, lon}] rings.
  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i].lat, xi = poly[i].lon;
      const yj = poly[j].lat, xj = poly[j].lon;
      if (((yi > pt.lat) !== (yj > pt.lat)) &&
          (pt.lon < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmtDist = m => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
  const pad2 = n => String(n).padStart(2, '0');
  const fmtClock = min => pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);

  return { haversine, bearing, pointToSegDist, pointToLineDist, pointInPoly, clamp, fmtDist, fmtClock };
})();