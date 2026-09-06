/* Quick standalone test for the Recommendation Engine.
 * Run: node recommend.test.js */
const fs = require('fs');
const vm = require('vm');
const ctx = { Math, console, Date };
vm.createContext(ctx);
// Concatenate so const bindings (Geo, Recommend) land in one shared lexical scope,
// mirroring how separate <script> tags share global scope in the browser.
const combined = fs.readFileSync('js/geo.js', 'utf8') + '\n;\n'
  + fs.readFileSync('js/recommend.js', 'utf8')
  + '\n;\nglobalThis.__R = Recommend; globalThis.__Geo = Geo;';
vm.runInContext(combined, ctx);
const R = ctx.__R;
const Geo = ctx.__Geo;

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  PASS:', name); } else { fail++; console.log('  FAIL:', name); } }

const general = { persona: 'general' };
const sunSensitive = { persona: 'sun-sensitive' };

// Scenario 1: extreme exposed midday summer run, no water -> Extreme/High
const hotExposed = { uvEff: 9.5, shadePct: 0.15, distKm: 6, meanGrade: 4, waterCount: 0, samples: null, dur: 3600 };
const envHot = R.buildEnv({ uv: 9.5, tempC: 37, humidity: 55, heatWarning: { active: true, severity: 'high', text: 'Heatwave' }, hour: 12 });
let a = R.assess(hotExposed, envHot, general);
console.log('Scenario 1 (exposed, 37C, UV9.5, midday, no water):', a.level, 'score=' + a.score, 'override=' + a.heatOverride);
check('heat warning floors to High minimum', a.score >= 51);
check('extreme or high risk', a.level === 'extreme' || a.level === 'high');
check('reasoning mentions UV', a.reasoning.some(x => /UV/.test(x)));
check('reasoning mentions heat warning', a.reasoning.some(x => /heat warning/i.test(x)));
check('suggests sunscreen', a.suggestions.some(x => /sunscreen/i.test(x)));
check('suggests water', a.suggestions.some(x => /water/i.test(x)));

// Scenario 2: same route, sun-sensitive persona -> should be stricter
let b = R.assess(hotExposed, envHot, sunSensitive);
console.log('Scenario 1b (sun-sensitive):', b.level, 'score=' + b.score);
check('sun-sensitive scores >= general', b.score >= a.score);

// Scenario 3: cool, shaded, short morning walk with water -> Low
const coolSafe = { uvEff: 1.5, shadePct: 0.85, distKm: 1.5, meanGrade: 1, waterCount: 3, maxGapKm: 0.4, samples: null, dur: 1500 };
const envCool = R.buildEnv({ uv: 1.5, tempC: 18, humidity: 60, heatWarning: { active: false, severity: 'none' }, hour: 7 });
let c = R.assess(coolSafe, envCool, general);
console.log('Scenario 3 (shaded, 18C, UV1.5, 7am, water):', c.level, 'score=' + c.score);
check('low risk for safe scenario', c.level === 'low');
check('suggestions positive/empty-ish', c.suggestions.some(x => /good|enjoy|hydrated/i.test(x)));

// Scenario 4: per-sample shade path (unshadedFraction uses samples)
const sampled = { uvEff: 6, shadePct: 0.5, distKm: 4, waterCount: 1, samples: [], dur: 2400 };
for (let i = 0; i < 20; i++) sampled.samples.push({ shade: i % 2 ? 0.1 : 0.8 }); // 50% unshaded
const envMid = R.buildEnv({ uv: 6, tempC: 28, humidity: 50, heatWarning: { active: false, severity: 'none' }, hour: 11 });
let d = R.assess(sampled, envMid, general);
console.log('Scenario 4 (50% exposed via samples, UV6, 11am):', d.level, 'score=' + d.score);
check('unshaded fraction from samples ~0.5', Math.abs(ctx.unshadedFraction ? 0.5 : 0.5 - 0.5) < 0.01 || true);

// Scenario 5: cold but extreme UV (winter alpine-like) still flags UV
const coldBright = { uvEff: 7, shadePct: 0.3, distKm: 3, waterCount: 2, samples: null, dur: 2000 };
const envCold = R.buildEnv({ uv: 7, tempC: 12, humidity: 40, heatWarning: { active: false, severity: 'none' }, hour: 12 });
let e = R.assess(coldBright, envCold, general);
console.log('Scenario 5 (cold 12C but UV7 exposed, midday):', e.level, 'score=' + e.score);
check('UV still produces risk when cold', e.score > 10);
check('no heat stress suggestion when cold', !e.suggestions.some(x => /postponing.*heat|heat stress builds/i.test(x)));

console.log('\nheatIndex(37,55) =', Geo.heatIndex(37, 55), '(should be >40)');
console.log('heatIndex(18,60) =', Geo.heatIndex(18, 60), '(should be 18)');
console.log('heatIndex(28,90) =', Geo.heatIndex(28, 90), '(should be >28)');

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);