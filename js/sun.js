/* ComfortRoute — solar position (standard suncalc/NOAA equations) + heuristic shade estimation. */
'use strict';
const Sun = (() => {
  const RAD = Math.PI / 180;
  // Days since J2000
  const toDays = date => date.getTime() / 86400000 - 0.5 + 2440588 - 2451545;
  const solarMeanAnomaly = d => RAD * (357.5291 + 0.98560028 * d);

  function eclipticLongitude(M) {
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return M + C + RAD * 102.9372 + Math.PI;
  }

  /**
   * Sun position for a date/time and location.
   * @returns {{azimuth:number, altitude:number}} compass azimuth (0=N, 90=E, 180=S) and
   *          altitude in degrees (negative below horizon).
   */
  function position(date, lat, lng) {
    const lw = RAD * -lng;
    const phi = RAD * lat;
    const d = toDays(date);
    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    const e = RAD * 23.4397;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const st = RAD * (280.16 + 360.9856235 * d) - lw;
    const H = st - ra;
    const sph = Math.sin(phi), cph = Math.cos(phi);
    const sdc = Math.sin(dec), cdc = Math.cos(dec);
    const alt = Math.asin(sph * sdc + cph * cdc * Math.cos(H));
    // Compass azimuth from North (0=N, 90=E, clockwise), correct for both hemispheres:
    const az = Math.atan2(-cdc * Math.sin(H), cph * sdc - sph * cdc * Math.cos(H));
    return { azimuth: ((az / RAD) + 360) % 360, altitude: alt / RAD };
  }

  function shadeGivenSun(point, buildings, sun) {
    if (sun.altitude <= 4) return 1; // night / twilight → UV ≈ 0 anyway
    const shadowAz = (sun.azimuth + 180) % 360;
    const tanAlt = Math.tan(sun.altitude * RAD);
    let best = 0;
    for (const b of buildings) {
      const dist = Geo.haversine(point, b);
      if (dist > 80) continue;
      const shadowLen = b.height / tanAlt;
      if (dist > shadowLen) continue;
      const brg = Geo.bearing(b, point);
      let diff = Math.abs(brg - shadowAz);
      if (diff > 180) diff = 360 - diff;
      if (diff > 60) continue; // roughly on the anti-solar side of the building
      const cov = (1 - dist / shadowLen) * Math.cos(diff * RAD);
      if (cov > best) best = cov;
    }
    return Geo.clamp(best, 0, 1);
  }

  /**
   * Heuristic shade score for a point (0 = full sun, 1 = fully shaded) using nearby
   * building centroids + heights. Approximation: shadow length = height / tan(altitude);
   * a point is "shaded" when it lies on the anti-solar side of a tall-enough building.
   * @param {{lat:number, lon:number}} point
   * @param {Array<{lat:number, lon:number, height:number}>} buildings
   * @param {Date} date
   */
  function shadeAt(point, buildings, date) {
    const sun = position(date, point.lat, point.lon);
    return { shade: shadeGivenSun(point, buildings, sun), sun };
  }

  // Effective UV at a shaded point, splitting direct vs diffuse (scattered) UV.
  // Direct beam is blocked by shade; diffuse sky UV is only partially reduced
  // (shaded ground still sees much of the sky + ground reflection). Measurements
  // put full-shade transmission around 20–35% of ambient — a plain "shade blocks
  // 90%" rule underestimates it, so we model both components explicitly.
  //   direct component : UV × directFrac × (1 − shade)
  //   diffuse component: UV × diffuseFrac × (1 − 0.45 × shade)
  // Diffuse fraction rises as the sun gets lower (more scattering path).
  function effectiveUV(uv, shade, altDeg) {
    if (uv == null) return null;
    const sinAlt = Math.sin((altDeg == null ? 45 : altDeg) * RAD);
    const diffuse = Math.min(0.55, 0.36 + 0.15 * (1 - Math.max(0, sinAlt)));
    const direct = 1 - diffuse;
    const shade = Math.max(0, Math.min(1, shade));
    return uv * (direct * (1 - shade) + diffuse * (1 - 0.45 * shade));
  }

  return { position, shadeAt, shadeGivenSun, effectiveUV };
})();