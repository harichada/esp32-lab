// Default Tidy geometry must match v66 (main 2c42601).
// The renderer is loaded from `git show 2c42601:web/js/schematic.js` when that
// commit is in the clone. tests/fixtures/schematic-v66.js is that same file,
// byte for byte, and is the fallback when the commit is not present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'netlist.js', 'schematic.js']) require('../js/' + f);

const repo = path.join(__dirname, '../..');
const fixturePath = path.join(__dirname, 'fixtures/schematic-v66.js');
const fixture = fs.readFileSync(fixturePath, 'utf8');
let fromGit = null;
try {
  fromGit = execFileSync('git', ['show', '2c42601:web/js/schematic.js'], { cwd: repo, encoding: 'utf8' });
} catch (e) { fromGit = null; }

function normSeg(a, b) {
  const p = [a.x, a.y];
  const q = [b.x, b.y];
  if (p[0] > q[0] || (p[0] === q[0] && p[1] > q[1])) return q.concat(p).join(',');
  return p.concat(q).join(',');
}

function geometry(model) {
  const parts = (model.symbols || []).map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    kind: s.kind,
    pins: (s.terms || []).map((t) => ({
      name: t.name, x: t.x, y: t.y, dir: t.dir, lx: t.lx, ly: t.ly,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.x - b.x || a.y - b.y),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const pinsOf = new Map();
  for (const s of model.symbols || []) for (const t of s.terms || []) {
    if (t.net == null) continue;
    if (!pinsOf.has(t.net)) pinsOf.set(t.net, []);
    pinsOf.get(t.net).push(s.id + '.' + t.name);
  }
  const segsOf = new Map();
  for (const pl of model.polys || []) {
    if (!segsOf.has(pl.net)) segsOf.set(pl.net, []);
    const pts = pl.pts || [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x === pts[i - 1].x && pts[i].y === pts[i - 1].y) continue;
      segsOf.get(pl.net).push(normSeg(pts[i - 1], pts[i]));
    }
  }
  const dotsOf = new Map();
  for (const d of model.dots || []) {
    if (!dotsOf.has(d.net)) dotsOf.set(d.net, []);
    dotsOf.get(d.net).push(d.x + ',' + d.y);
  }
  const nets = [];
  const ids = new Set([...pinsOf.keys(), ...segsOf.keys(), ...dotsOf.keys()]);
  for (const net of ids) {
    nets.push({
      pins: (pinsOf.get(net) || []).slice().sort(),
      segs: (segsOf.get(net) || []).slice().sort(),
      dots: (dotsOf.get(net) || []).slice().sort(),
    });
  }
  nets.sort((a, b) => a.pins.join('|').localeCompare(b.pins.join('|')));
  return { parts, nets };
}

test('default Tidy geometry matches v66 for every example', () => {
  if (fromGit != null) assert.equal(fixture, fromGit, 'tests/fixtures/schematic-v66.js is not the file at 2c42601');
  const src = fromGit || fixture;
  assert.ok(src.includes('function layout(proj)'), 'v66 schematic has no layout(proj)');
  const current = globalThis.Schematic;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const savedExports = module.exports;
    vm.runInThisContext(src, { filename: 'schematic-v66.js' });
    module.exports = savedExports;
    const v66 = globalThis.Schematic;
    globalThis.Schematic = current;
    assert.notStrictEqual(v66, current);
    const keys = globalThis.Examples.LIST.map((row) => row[0]);
    assert.ok(keys.length >= 42, 'examples ' + keys.length);
    const problems = [];
    const clone = (proj) => JSON.parse(JSON.stringify(proj));
    for (const key of keys) {
      const proj = globalThis.Examples.EX[key]();
      let oldGeom, nowGeom, explicit;
      try {
        oldGeom = geometry(v66.layout(clone(proj)));
        nowGeom = geometry(current.layout(clone(proj)));
        explicit = geometry(current.layout(clone(proj), { match: false }));
      } catch (e) {
        problems.push(key + ' ' + e.message);
        continue;
      }
      if (JSON.stringify(nowGeom) !== JSON.stringify(oldGeom)) problems.push(key + ' default differs from v66');
      if (JSON.stringify(explicit) !== JSON.stringify(oldGeom)) problems.push(key + ' match:false differs from v66');
    }
    assert.deepStrictEqual(problems, []);
  } finally {
    console.warn = warn;
    globalThis.Schematic = current;
  }
});
