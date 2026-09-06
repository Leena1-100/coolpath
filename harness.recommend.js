/* Validation harness: 4-stage protocol for the recommendation engine.
 * Dev-only tool (not part of the app). Run from /tmp/coolpath:
 *   npm i puppeteer-core   (dev-only; no package.json is committed)
 *   node harness.recommend.js
 * Stage 1: API connectivity incl. heatWarning. Stage 2: accuracy scenarios.
 * Stage 3: narrow viewport + a11y. Stage 4: crash tests. */
'use strict';
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8123;
const ROOT = __dirname;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
};

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      const url = req.url.split('?')[0];
      if (url === '/favicon.ico') { resp.writeHead(204); resp.end(); return; }
      const p = url === '/' ? '/index.html' : url;
      fs.readFile(ROOT + p, (e, d) => {
        if (e) { resp.writeHead(404); resp.end('nf'); return; }
        const ct = p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'text/html';
        resp.writeHead(200, { 'Content-Type': ct });
        resp.end(d);
      });
    });
    srv.listen(PORT, () => res(srv));
  });
}

async function newPage(browser, opts = {}) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const uv = opts.uv ?? 9.5, temp = opts.temp ?? 37, humid = opts.humid ?? 55;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    const abort = () => req.respond({ status: 500, contentType: 'text/plain', body: 'mock-500' });
    const json = o => req.respond({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(o),
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
    if (u.includes('open-meteo.com')) {
      if (opts.heatApiDown && u.includes('uv_index')) return abort();
      const hours = [], uu = [], tt = [], hh = [];
      for (let i = 0; i < 24; i++) {
        hours.push('2026-06-01T' + String(i).padStart(2, '0') + ':00');
        uu.push(uv); tt.push(temp); hh.push(humid);
      }
      return json({ hourly: { time: hours, uv_index: uu, temperature_2m: tt, relative_humidity_2m: hh } });
    }
    if (u.includes('overpass')) return json({ elements: [] });
    if (u.includes('nominatim')) return json([]);
    if (u.includes('osrm') || u.includes('routed-foot')) {
      // ~1 km square loop with enough points for per-sample shade sampling
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60 * 4;
        const seg = Math.floor(t) % 4, f = t % 1;
        const lat = -27.478 - 0.004 * (seg === 1 || seg === 2 ? (seg === 2 ? 1 : f) : 0);
        const lon = 153.023 + 0.005 * (seg === 0 ? f : seg === 3 ? 1 : seg === 2 ? 1 - f : 0);
        pts.push([lon, lat]);
      }
      return json({ code: 'Ok', routes: [{ distance: 1000, duration: 720, geometry: { coordinates: pts }, legs: [{ steps: [] }] }], waypoints: [] });
    }
    if (u.includes('elevation')) return json({ results: [{ elevation: 10 }, { elevation: 12 }] });
    if (u.includes('tile.openstreetmap.org')) return req.respond({ status: 200, contentType: 'image/png', body: Buffer.alloc(8) });
    req.continue();
  });
  return { page, errors };
}

(async () => {
  const srv = await serve();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

  /* Stage 1: API connectivity */
  console.log('\n== Stage 1: API connectivity ==');
  {
    const { page, errors } = await newPage(browser);
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));
    const hw = await page.evaluate(() => API.heatWarning(-27.478, 153.023));
    ok('heatWarning returns shape', hw && typeof hw.active === 'boolean' && 'severity' in hw, JSON.stringify(hw));
    ok('heatWarning flags hot mock (37C→high)', hw.active === true && hw.severity === 'high');
    ok('no page errors at boot', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  /* Stage 2: accuracy */
  console.log('\n== Stage 2: accuracy ==');
  {
    const { page } = await newPage(browser, { uv: 9.5, temp: 37, humid: 55 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-find');
    await new Promise(r => setTimeout(r, 1500));
    // Pin departure to noon so the timing sub-score is deterministic.
    await page.evaluate(() => {
      const el = document.getElementById('time-slider2');
      el.value = 12; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 700));
    const res = await page.evaluate(() => ({
      hidden: document.getElementById('recommendation').hidden,
      label: document.getElementById('rec-label').textContent,
      badge: document.getElementById('rec-badge').textContent,
      bannerClass: document.getElementById('rec-banner').className,
      reasons: document.querySelectorAll('#rec-reasons li').length,
      sugg: document.querySelectorAll('#rec-suggestions li').length,
      sub: document.getElementById('rec-subline').textContent
    }));
    console.log('  banner:', res.label, '|', res.sub);
    ok('panel visible after search', res.hidden === false);
    ok('high/extreme on exposed midday', /High risk|Extreme risk/.test(res.label), res.label);
    ok('badge is text not blank', res.badge.length > 2, res.badge);
    ok('banner class matches level', /level-(high|extreme)/.test(res.bannerClass), res.bannerClass);
    ok('reasoning non-empty', res.reasons > 0);
    ok('suggestions non-empty', res.sugg > 0);
    await page.close();
  }
  {
    const { page } = await newPage(browser, { uv: 1.2, temp: 18, humid: 60 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-find');
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => {
      const el = document.getElementById('time-slider2');
      el.value = 19; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 700));
    const res = await page.evaluate(() => document.getElementById('rec-label').textContent);
    console.log('  banner:', res);
    ok('low risk shaded evening', /Low risk/.test(res), res);
    await page.close();
  }
  {
    // Persona: strong UV + mild temp (no heat floor), noon → sun-sensitive
    // multipliers (uv ×1.5, timing ×1.2) must lift the score.
    const { page } = await newPage(browser, { uv: 9.5, temp: 24, humid: 50 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-find');
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => {
      const el = document.getElementById('time-slider2');
      el.value = 12; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 700));
    const general = await page.evaluate(() => parseInt(document.getElementById('rec-subline').textContent.match(/Score (\d+)/)[1], 10));
    await page.select('#rec-persona-select', 'sun-sensitive');
    await new Promise(r => setTimeout(r, 300));
    const sensitive = await page.evaluate(() => parseInt(document.getElementById('rec-subline').textContent.match(/Score (\d+)/)[1], 10));
    ok('persona raises sun-sensitive score', sensitive > general, `${general} → ${sensitive}`);
    await page.close();
  }

  /* Stage 3: narrow viewport + a11y */
  console.log('\n== Stage 3: narrow viewport + a11y ==');
  {
    const { page } = await newPage(browser, { uv: 9.5, temp: 37 });
    await page.setViewport({ width: 360, height: 740 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-find');
    await new Promise(r => setTimeout(r, 1500));
    const res = await page.evaluate(() => {
      const b = document.getElementById('rec-banner');
      const label = document.getElementById('rec-label').textContent;
      const badge = document.getElementById('rec-badge').textContent;
      return {
        textOk: /risk/i.test(label) && badge.length > 2,
        bannerVisible: b.getBoundingClientRect().width > 0,
        overflowX: document.documentElement.scrollWidth <= window.innerWidth + 1,
        label
      };
    });
    ok('banner visible at 360px', res.bannerVisible);
    ok('risk conveyed as text (not color only)', res.textOk, res.label);
    ok('no horizontal overflow at 360px', res.overflowX);
    await page.close();
  }

  /* Stage 4: degradation */
  console.log('\n== Stage 4: degradation ==');
  {
    const { page, errors } = await newPage(browser, { uv: 8, temp: 33, heatApiDown: true });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-find');
    await new Promise(r => setTimeout(r, 1500));
    const res = await page.evaluate(() => ({
      hidden: document.getElementById('recommendation').hidden,
      label: document.getElementById('rec-label').textContent,
      cards: document.querySelectorAll('.card').length,
      status: document.getElementById('result-status').textContent,
      resultsHidden: document.getElementById('panel-results').hidden
    }));
    console.log('  4a debug:', JSON.stringify(res));
    ok('works with heat API down (cards render)', res.cards > 0);
    ok('banner still renders', res.hidden === false, res.label);
    ok('no pageerror (heat down)', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 2).join('|'));
    await page.close();
  }
  {
    const { page, errors } = await newPage(browser, { uv: null, temp: 25 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-find');
    await new Promise(r => setTimeout(r, 1500));
    const res = await page.evaluate(() => ({
      hidden: document.getElementById('recommendation').hidden,
      label: document.getElementById('rec-label').textContent
    }));
    ok('banner renders with UV missing', res.hidden === false, res.label);
    ok('no pageerror with UV missing', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 2).join('|'));
    await page.close();
  }

  await browser.close();
  srv.close();
  console.log(`\n=== HARNESS: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH', e); process.exit(1); });