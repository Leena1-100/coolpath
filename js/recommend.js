/* ComfortRoute — Safety Recommendation Engine.
 *
 * Turns a selected route + current environmental conditions into a clear,
 * actionable safety recommendation. Not raw numbers — plain-language risk.
 *
 * SCORING MODEL (additive, 0-100):
 *   uv        0-30   UV exposure along the route (index x unshaded fraction x duration)
 *   heat      0-25   Heat stress from temperature + humidity (heat index)
 *   exertion  0-20   Metabolic heat from distance + steepness
 *   water     0-15   Dehydration risk: no water stops on a hot/long route
 *   timing    0-10   Departure during peak-UV hours (10am-2pm)
 *
 * RISK LEVELS (score thresholds, adjustable per persona):
 *   0-25  Low      26-50  Moderate      51-75  High      76-100  Extreme
 *
 * OPEN-QUESTION DECISIONS (resolved here, documented for review):
 *   1. Weighting → the constants below. UV dominates because it's the most
 *      immediately harmful + avoidable factor on a shaded-route app.
 *   2. Heat-wave override → YES. An active BOM/heat warning floors the risk at
 *      High (never shows Low during a heat wave), regardless of other factors.
 *   3. Persona → supported. 'general' (default), 'sun-sensitive' (stricter UV
 *      thresholds), 'mobility-limited' (stricter exertion + rest thresholds).
 *
 * Accessibility: the engine returns TEXT for every risk level. The UI must
 * never convey risk by color alone — always pair the level with its label text.
 */
'use strict';
const Recommend = (() => {
  const W = { uv: 30, heat: 25, exertion: 20, water: 15, timing: 10 };

  const BASE_LEVELS = [
    { max: 25, level: 'low', label: 'Low risk' },
    { max: 50, level: 'moderate', label: 'Moderate risk' },
    { max: 75, level: 'high', label: 'High risk' },
    { max: 100, level: 'extreme', label: 'Extreme risk' }
  ];

  const PERSONAS = {
    general: { thresholdMult: 1.0, weightMults: { uv: 1, heat: 1, exertion: 1, water: 1, timing: 1 } },
    'sun-sensitive': { thresholdMult: 0.8, weightMults: { uv: 1.5, heat: 1.1, exertion: 1, water: 1, timing: 1.2 } },
    'mobility-limited': { thresholdMult: 0.85, weightMults: { uv: 1, heat: 1.1, exertion: 1.5, water: 1.2, timing: 1 } }
  };
  const DEFAULT_PERSONA = 'general';
  function persona(name) { return PERSONAS[name] || PERSONAS[DEFAULT_PERSONA]; }

  function unshadedFraction(route) {
    const s = route.samples;
    if (s && s.length) {
      let sun = 0;
      for (const p of s) if (p.shade != null && p.shade < 0.4) sun++;
      return sun / s.length;
    }
    return route.shadePct == null ? 0.5 : 1 - route.shadePct;
  }

  function routeDurationHours(route) {
    if (route.dur != null) return route.dur / 3600;
    const km = route.distKm != null ? route.distKm : (route.dist || 0) / 1000;
    return km / 6;
  }

  function uvScore(route, env, wm) {
    const uv = route.uvEff != null ? route.uvEff : (env.uv != null ? env.uv : 0);
    const exposure = unshadedFraction(route);
    const hours = routeDurationHours(route);
    const load = Geo.clamp(uv, 0, 12) / 12;
    const durationFactor = Geo.clamp(hours / 1.5, 0.3, 2);
    const raw = load * (0.3 + 0.7 * exposure) * durationFactor;
    return Geo.clamp(raw, 0, 1) * W.uv * (wm.uv || 1);
  }

  function heatScore(route, env, wm) {
    const hi = env.heatIndex != null ? env.heatIndex : (env.tempC != null ? env.tempC : 20);
    let raw;
    if (hi < 27) raw = 0;
    else if (hi < 32) raw = 0.25 * ((hi - 27) / 5);
    else if (hi < 41) raw = 0.25 + 0.5 * ((hi - 32) / 9);
    else raw = 0.75 + 0.25 * Geo.clamp((hi - 41) / 6, 0, 1);
    return Geo.clamp(raw, 0, 1) * W.heat * (wm.heat || 1);
  }

  function exertionScore(route, wm) {
    const km = route.distKm != null ? route.distKm : (route.dist || 0) / 1000;
    const grade = route.meanGrade != null ? route.meanGrade : 0;
    const distLoad = Geo.clamp(km / 8, 0, 1);
    const gradeLoad = Geo.clamp(grade / 8, 0, 1);
    const raw = 0.4 * distLoad + 0.6 * gradeLoad;
    return Geo.clamp(raw, 0, 1) * W.exertion * (wm.exertion || 1);
  }

  function waterScore(route, env, wm) {
    const km = route.distKm != null ? route.distKm : (route.dist || 0) / 1000;
    const hot = (env.heatIndex != null ? env.heatIndex : (env.tempC || 20)) >= 27;
    const hasWater = (route.waterCount || 0) > 0;
    const gap = route.maxGapKm != null ? route.maxGapKm : km;
    if (!hot && km < 3) return 0;
    let raw;
    if (hasWater) raw = Geo.clamp((gap - 1.5) / 3, 0, 1) * 0.5;
    else raw = 0.4 + 0.6 * Geo.clamp(km / 5, 0, 1);
    return Geo.clamp(raw, 0, 1) * W.water * (wm.water || 1);
  }

  function timingScore(route, env, wm) {
    const h = env.hour != null ? env.hour : new Date().getHours();
    let raw;
    if (h >= 10 && h <= 14) raw = 1;
    else if (h >= 9 && h <= 15) raw = 0.6;
    else if (h >= 8 && h <= 16) raw = 0.3;
    else raw = 0.05;
    return raw * W.timing * (wm.timing || 1);
  }

  function buildReasoning(route, env) {
    const r = [];
    const uv = route.uvEff != null ? route.uvEff : (env.uv != null ? env.uv : 0);
    const unshaded = Math.round(unshadedFraction(route) * 100);
    if (uv >= 8 && unshaded > 40) r.push('Very high UV (' + uv.toFixed(1) + ') with ' + unshaded + '% of the route exposed to direct sun.');
    else if (uv >= 5 && unshaded > 40) r.push('Moderate UV (' + uv.toFixed(1) + ') but ' + unshaded + '% of the route is unshaded.');
    else if (uv >= 5) r.push('UV is ' + uv.toFixed(1) + ' but the route is mostly shaded.');
    else r.push('UV is low (' + uv.toFixed(1) + ').');

    const hi = env.heatIndex != null ? env.heatIndex : (env.tempC != null ? env.tempC : null);
    if (hi != null) {
      if (hi >= 38) r.push('It will feel like ' + hi + 'C - extreme heat stress.');
      else if (hi >= 32) r.push('It will feel like ' + hi + 'C - take it easy.');
      else if (hi >= 27) r.push('Warm: around ' + hi + 'C.');
    }

    const km = route.distKm != null ? route.distKm : (route.dist || 0) / 1000;
    if (route.meanGrade != null && route.meanGrade > 5) r.push('Hilly route (avg ' + Math.round(route.meanGrade) + '% grade) adds exertion.');
    if ((route.waterCount || 0) === 0 && (hi != null && hi >= 27 || km > 3)) r.push('No water taps along the route.');
    else if (route.maxGapKm != null && route.maxGapKm > 2) r.push('Longest stretch between water taps is ' + route.maxGapKm.toFixed(1) + ' km.');
    if (env.heatWarning && env.heatWarning.active) r.push('Active heat warning: ' + env.heatWarning.text);
    return r;
  }

  function buildSuggestions(route, env, level) {
    const s = [];
    const uv = route.uvEff != null ? route.uvEff : (env.uv != null ? env.uv : 0);
    const unshaded = Math.round(unshadedFraction(route) * 100);
    const h = env.hour != null ? env.hour : new Date().getHours();
    const hi = env.heatIndex != null ? env.heatIndex : (env.tempC != null ? env.tempC : null);
    const km = route.distKm != null ? route.distKm : (route.dist || 0) / 1000;

    if (uv >= 6) s.push('Apply SPF50+ sunscreen, wear a hat and UV-blocking sunglasses.');
    if (uv >= 8 && unshaded > 30) s.push('Seek shade where possible - consider a more shaded alternate route.');
    if (h >= 10 && h <= 14 && uv >= 5) s.push('Consider starting before 10am or after 2pm to avoid peak UV.');
    if ((route.waterCount || 0) === 0 && (km > 2 || (hi != null && hi >= 27))) s.push('Carry water - at least 500ml, more if it is hot or the route is long.');
    if (hi != null && hi >= 32) s.push('Slow your pace and take breaks in shade - heat stress builds quickly.');
    if (hi != null && hi >= 38) s.push('Strongly consider postponing to a cooler time of day.');
    if (route.meanGrade != null && route.meanGrade > 6 && hi != null && hi >= 27) s.push('Steep sections add exertion - take extra care in the heat.');
    if (env.heatWarning && env.heatWarning.severity === 'extreme') s.push('Extreme heat warning active - postponing this trip is the safest choice.');
    if (s.length === 0) s.push('Conditions look good. Enjoy your run and stay hydrated.');
    return s;
  }

  function levelFor(score, thresholdMult) {
    const adj = BASE_LEVELS.map(l => ({ level: l.level, label: l.label, max: l.max * thresholdMult }));
    for (const l of adj) if (score <= l.max) return l;
    return adj[adj.length - 1];
}

  /**
   * Assess a route and return a full safety recommendation.
   * @param {Object} route  - enriched loop (uvEff, shadePct, distKm, grade, water, samples, …)
   * @param {Object} env    - { uv, tempC, humidity, heatIndex, heatWarning, hour }
   * @param {Object} [opts] - { persona }
   * @returns {{level,label,score,factors,reasoning,suggestions,heatOverride}}
   */
  function assess(route, env, opts) {
    opts = opts || {};
    const p = persona(opts.persona);
    const wm = p.weightMults;
    const sub = {
      uv: uvScore(route, env, wm),
      heat: heatScore(route, env, wm),
      exertion: exertionScore(route, wm),
      water: waterScore(route, env, wm),
      timing: timingScore(route, env, wm)
    };
    let score = sub.uv + sub.heat + sub.exertion + sub.water + sub.timing;

    // Heat-wave override: an active heat warning floors risk at High.
    const heatFloor = env.heatWarning && env.heatWarning.active &&
      (env.heatWarning.severity === 'high' || env.heatWarning.severity === 'extreme');
    if (heatFloor && score < 51) score = 51;

    score = Math.round(Geo.clamp(score, 0, 100));
    const lvl = levelFor(score, p.thresholdMult);

    return {
      level: lvl.level,
      label: lvl.label,
      score,
      factors: [
        { name: 'UV exposure', value: Math.round(sub.uv), weight: W.uv * (wm.uv || 1) },
        { name: 'Heat stress', value: Math.round(sub.heat), weight: W.heat * (wm.heat || 1) },
        { name: 'Exertion', value: Math.round(sub.exertion), weight: W.exertion * (wm.exertion || 1) },
        { name: 'Water/dehydration', value: Math.round(sub.water), weight: W.water * (wm.water || 1) },
        { name: 'Time of day', value: Math.round(sub.timing), weight: W.timing * (wm.timing || 1) }
      ],
      reasoning: buildReasoning(route, env),
      suggestions: buildSuggestions(route, env, lvl.level),
      heatOverride: !!heatFloor
    };
  }

  // Build the env object the engine expects from app-layer inputs.
  function buildEnv(opts) {
    const hi = (opts.tempC != null && opts.humidity != null) ? Geo.heatIndex(opts.tempC, opts.humidity) : opts.tempC;
    return {
      uv: opts.uv, tempC: opts.tempC, humidity: opts.humidity,
      heatIndex: hi, heatWarning: opts.heatWarning || { active: false, severity: 'none' },
      hour: opts.hour
    };
  }

  return { assess, buildEnv, persona, PERSONAS, DEFAULT_PERSONA, WEIGHTS: W, BASE_LEVELS };
})();