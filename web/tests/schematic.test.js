// Schematic layout: orthogonal wires, shared nets, no breadboard, project untouched.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'sim.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'schematic.js']) require('../js/' + f);
const { layout } = globalThis.Schematic;
const E = globalThis.Examples;

function clone(p) { return JSON.parse(JSON.stringify(p)); }
function segHits(a, b, r) {
  if (a.x === b.x) {
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return a.x > r.x && a.x < r.x2 && y1 > r.y + 0.5 && y0 < r.y2 - 0.5;
  }
  if (a.y === b.y) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    return a.y > r.y && a.y < r.y2 && x1 > r.x + 0.5 && x0 < r.x2 - 0.5;
  }
  return true; // non-orthogonal
}
function audit(model, label) {
  assert.ok(model.symbols.length, label + ' has symbols');
  assert.ok(!model.symbols.some((s) => s.part.type === 'breadboard'), label + ' hides the breadboard');
  const rects = model.symbols.map((s) => ({ x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h, id: s.id }));
  for (const pl of model.polys) {
    for (let i = 1; i < pl.pts.length; i++) {
      const a = pl.pts[i - 1], b = pl.pts[i];
      assert.ok(a.x === b.x || a.y === b.y, label + ' wire not orthogonal ' + JSON.stringify([a, b]));
      for (const r of rects) assert.ok(!segHits(a, b, r), label + ' wire crosses ' + r.id);
    }
  }
  // different nets must not share a grid edge
  const edges = new Map();
  for (const pl of model.polys) {
    for (let i = 1; i < pl.pts.length; i++) {
      const a = pl.pts[i - 1], b = pl.pts[i];
      const horiz = a.y === b.y;
      const step = horiz ? (b.x >= a.x ? 10 : -10) : (b.y >= a.y ? 10 : -10);
      const n = Math.round(Math.abs(horiz ? b.x - a.x : b.y - a.y) / 10);
      let x = a.x, y = a.y;
      for (let k = 0; k < n; k++) {
        const x0 = x, y0 = y;
        if (horiz) x += step; else y += step;
        const key = horiz ? 'h:' + y + ':' + Math.min(x0, x) : 'v:' + x + ':' + Math.min(y0, y);
        if (edges.has(key) && edges.get(key) !== pl.net) assert.fail(label + ' nets ' + edges.get(key) + ' and ' + pl.net + ' overlap ' + key);
        edges.set(key, pl.net);
      }
    }
  }
}

function connected(model, net) {
  const pts = [];
  for (const pl of model.polys) if (pl.net === net) for (const p of pl.pts) pts.push(p.x + ',' + p.y);
  return new Set(pts);
}

test('blink LED schematic: ESP32, resistor, LED, orthogonal, GND symbols, project unchanged', () => {
  const raw = E.EX.blink();
  const before = JSON.stringify(raw);
  const model = layout(raw);
  assert.strictEqual(JSON.stringify(raw), before);
  audit(model, 'blink');
  const types = model.symbols.map((s) => s.part.type).sort();
  assert.deepStrictEqual(types, ['esp32', 'led', 'resistor']);
  const r = model.symbols.find((s) => s.id === 'R1');
  assert.ok(r && /220/.test(r.value), r && r.value);
  const led = model.symbols.find((s) => s.part.type === 'led');
  const cpin = led.terms.find((t) => t.name === 'C');
  assert.strictEqual(cpin.rail, 'gnd');
  assert.ok(model.rails.some((g) => g.kind === 'gnd' && g.pid === led.id));
  assert.ok(model.rails.some((g) => g.kind === 'gnd' && g.pid === 'esp'));
  // resistor and LED share a wired net
  const rn = r.terms.map((t) => t.net);
  const ln = led.terms.filter((t) => t.wire).map((t) => t.net);
  assert.ok(rn.some((n) => ln.includes(n)), 'series net');
  assert.ok(!model.fallback, 'blink routed cleanly');
});

test('resistor divider + DMM schematic connects the midpoint', () => {
  const raw = E.EX.b_divider();
  const before = clone(raw);
  const model = layout(raw);
  assert.deepStrictEqual(raw.parts.map((p) => p.x), before.parts.map((p) => p.x));
  assert.strictEqual(raw.wires.length, before.wires.length);
  audit(model, 'divider');
  assert.ok(model.symbols.some((s) => s.part.type === 'bench'));
  assert.ok(model.symbols.some((s) => s.id === 'DMM1'));
  assert.ok(model.symbols.some((s) => s.id === 'R3'));
  const r1 = model.symbols.find((s) => s.id === 'R1');
  const r2 = model.symbols.find((s) => s.id === 'R2');
  const dmm = model.symbols.find((s) => s.id === 'DMM1');
  const mid = r1.terms.map((t) => t.net).find((n) => r2.terms.some((t) => t.net === n));
  assert.ok(mid !== undefined, 'R1-R2 net');
  assert.ok(dmm.terms.some((t) => t.net === mid), 'DMM on divider');
  const reach = connected(model, mid);
  for (const s of [r1, r2, dmm]) {
    const pin = s.terms.find((t) => t.net === mid);
    assert.ok(reach.has(pin.x + ',' + pin.y) || reach.has(pin.sx + ',' + pin.sy), s.id + ' midpoint reached');
  }
  assert.ok(model.rails.some((g) => g.kind === 'gnd'));
  assert.ok(/10k/.test(r1.value), r1.value);
  assert.ok(!model.fallback, 'divider routed cleanly');
});

test('555 blinker schematic shows the timer, passives, and supply flags', () => {
  const raw = E.EX.ic_555blink();
  const before = JSON.stringify({ p: raw.parts, w: raw.wires });
  const model = layout(raw);
  assert.strictEqual(JSON.stringify({ p: raw.parts, w: raw.wires }), before);
  audit(model, '555');
  const u = model.symbols.find((s) => s.part.type === 'ne555');
  assert.ok(u, '555 symbol');
  for (const name of ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC']) assert.ok(u.terms.some((t) => t.name === name), name);
  assert.strictEqual(u.terms.find((t) => t.name === 'GND').rail, 'gnd');
  assert.strictEqual(u.terms.find((t) => t.name === 'VCC').rail, 'flag');
  assert.ok(model.symbols.some((s) => s.part.type === 'led'));
  assert.ok(model.symbols.some((s) => s.part.type === 'battery9v' || s.kind === 'BAT'));
  assert.ok(model.symbols.filter((s) => s.kind === 'R' || s.part.type === 'resistor').length >= 3);
  const out = u.terms.find((t) => t.name === 'OUT');
  assert.ok(out.wire, 'OUT is wired');
  const reach = connected(model, out.net);
  assert.ok(reach.size > 1, 'OUT net has a wire');
  assert.ok(!model.fallback, '555 routed cleanly');
});

test('two-transistor flasher lays out without crossing bodies', () => {
  const model = layout(E.EX.b_blink());
  audit(model, 'astable');
  assert.strictEqual(model.symbols.filter((s) => s.kind === 'NPN').length, 2);
  assert.ok(model.symbols.filter((s) => s.part.type === 'led').length === 2);
  assert.ok(model.symbols.some((s) => s.kind === 'C' && s.elec));
});
