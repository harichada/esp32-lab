// Seeded breadboard circuits, including jumpers that run along each other.
// Both layouts must draw the netlist: no merged nets and no split nets.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'netlist.js', 'schematic.js', 'tests/viewaudit.js']) require('../js/' + f.replace('tests/', '../tests/'));
const { layout, toSvg } = globalThis.Schematic;
const A = globalThis.ViewAudit;
const P = globalThis.Parts;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const ROW_Y = { a: 40, b: 50, c: 60, d: 70, e: 80, f: 110, g: 120, h: 130, i: 140, j: 150 };
const ROWS = Object.keys(ROW_Y);
function hole(col, row) { return { x: 10 + (col - 1) * 10, y: ROW_Y[row] }; }

function circuit(rng, n) {
  const parts = [{ id: 'BB1', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 30 } }];
  const taken = new Set();
  const pins = [];
  const occupy = (p) => {
    const list = P.T[p.type].pins(p).map((pin) => Object.assign({ name: pin.name }, P.pinWorld(p, pin)));
    if (list.some((pin) => taken.has(pin.x + ',' + pin.y))) return false;
    if (list.some((pin) => pin.x < 10 || pin.x > 300 || pin.y < 0 || pin.y > 190)) return false;
    for (const pin of list) taken.add(pin.x + ',' + pin.y);
    pins.push(...list.map((pin) => ({ part: p.id, name: pin.name, x: pin.x, y: pin.y })));
    parts.push(p);
    return true;
  };
  const kinds = [
    { type: 'resistor', span: 4, props: { r: 1000 } },
    { type: 'led', span: 1, props: { color: 'red' } },
    { type: 'battery', span: 4, props: {} },
  ];
  const nParts = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < nParts; i++) {
    const kind = kinds[Math.floor(rng() * (rng() < 0.75 ? 2 : 3))];
    let placed = false;
    for (let attempt = 0; attempt < 30 && !placed; attempt++) {
      const col = 1 + Math.floor(rng() * (24 - kind.span));
      const row = ROWS[Math.floor(rng() * ROWS.length)];
      const at = hole(col, row);
      const id = kind.type.slice(0, 3).toUpperCase() + (i + 1);
      placed = occupy({ id: id, type: kind.type, x: at.x, y: at.y, rot: 0, props: Object.assign({}, kind.props) });
    }
  }
  const wires = [];
  const add = (a, b, pts, color) => {
    wires.push({ id: 'w' + wires.length, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, pts: pts || [], color: color || 'green' });
  };
  const nWires = Math.min(pins.length, 1 + Math.floor(rng() * 5));
  for (let i = 0; i < nWires && pins.length >= 2; i++) {
    const a = pins[Math.floor(rng() * pins.length)];
    const b = pins[Math.floor(rng() * pins.length)];
    if (a === b) continue;
    if (rng() < 0.5) add(a, b, [], 'green');
    else {
      const lane = 200 + Math.floor(rng() * 4) * 10;
      add(a, b, [{ x: a.x, y: lane }, { x: b.x, y: lane }], 'orange');
    }
  }
  // Two jumpers on the same lane, overlapping in the middle, on different holes.
  const lane = 20 + (n % 5) * 10;
  const x0 = 20 + (n % 7) * 10;
  add(hole(1 + (n % 4), 'a'), { x: x0 + 80, y: lane }, [{ x: hole(1 + (n % 4), 'a').x, y: lane }], 'yellow');
  add(hole(3 + (n % 4), 'f'), { x: x0 + 140, y: lane }, [{ x: hole(3 + (n % 4), 'f').x, y: lane }], 'blue');
  // A second pair that runs back along the first jumper.
  add({ x: x0 + 40, y: lane }, hole(6 + (n % 3), 'j'), [], 'red');
  return { name: 'fuzz ' + n, parts: parts, wires: wires };
}

test('seeded breadboard fuzz: breadboard and tidy drawings match the netlist', () => {
  const rng = mulberry32(20261114);
  const CASES = 200;
  const problems = [];
  let tidyNets = 0;
  let sheets = 0;
  for (let n = 0; n < CASES; n++) {
    const proj = circuit(rng, n);
    for (const mode of [true, false]) {
      let model = null;
      let svg = '';
      try {
        model = layout(proj, { match: mode });
        svg = toSvg(model);
      } catch (e) {
        problems.push('case ' + n + (mode ? ' match ' : ' tidy ') + e.message);
        continue;
      }
      if (mode) {
        if (model.sheetFallback) sheets += 1;
        else tidyNets += (model.tidyNets || []).length;
      }
      const report = A.auditProject(proj, svg);
      for (const p of report.problems) {
        problems.push('case ' + n + (mode ? ' match ' : ' tidy ') + p.kind + ' ' + (p.pin || p.part || ''));
      }
    }
  }
  console.log('fuzz fallbacks: ' + tidyNets + ' nets, ' + sheets + ' sheets, ' + CASES + ' cases');
  assert.deepStrictEqual(problems, []);
});
