// Schematic layout: orthogonal wires, shared nets, no breadboard, project untouched.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'schematic.js']) require('../js/' + f);
const { layout } = globalThis.Schematic;
const E = globalThis.Examples;
const P = globalThis.Parts;

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
function segClosed(a, b, r) {
  if (a.x === b.x) {
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return a.x >= r.x && a.x <= r.x2 && y1 >= r.y && y0 <= r.y2;
  }
  if (a.y === b.y) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    return a.y >= r.y && a.y <= r.y2 && x1 >= r.x && x0 <= r.x2;
  }
  return true;
}
function isPinLead(a, b, s) {
  const touches = s.terms.some((t) => (t.x === a.x && t.y === a.y) || (t.x === b.x && t.y === b.y));
  if (!touches) return false;
  return !segHits(a, b, { x: s.x + 0.5, y: s.y + 0.5, x2: s.x + s.w - 0.5, y2: s.y + s.h - 0.5 });
}
function textOverlap(a, b) {
  return Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 1;
}
function audit(model, label, checkEdges) {
  assert.ok(model.symbols.length, label + ' has symbols');
  assert.ok(!model.symbols.some((s) => s.part.type === 'breadboard'), label + ' hides the breadboard');
  for (const pl of model.polys) {
    for (let i = 1; i < pl.pts.length; i++) {
      const a = pl.pts[i - 1], b = pl.pts[i];
      assert.ok(a.x === b.x || a.y === b.y, label + ' wire not orthogonal ' + JSON.stringify([a, b]));
      for (const s of model.symbols) {
        if (isPinLead(a, b, s)) continue;
        const r = { x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h };
        assert.ok(!segClosed(a, b, r), label + ' wire crosses ' + s.id + ' ' + JSON.stringify([a, b]));
      }
    }
  }
  for (const d of model.dots) {
    for (const s of model.symbols) {
      assert.ok(!(d.x >= s.x && d.x <= s.x + s.w && d.y >= s.y && d.y <= s.y + s.h), label + ' junction on ' + s.id);
    }
  }
  const texts = model.texts || [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    assert.ok(!textOverlap(texts[i], texts[j]), label + ' text overlap "' + texts[i].text + '" / "' + texts[j].text + '"');
  }
  for (const t of texts) {
    for (const s of model.symbols) {
      if (t.own === s.id) continue;
      assert.ok(!textOverlap(t, { x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h }), label + ' text "' + t.text + '" overlaps ' + s.id);
    }
    for (const r of model.rails) if (r.kind === 'gnd') {
      assert.ok(!textOverlap(t, r), label + ' text "' + t.text + '" overlaps a ground symbol');
    }
  }
  if (checkEdges === false) return;
  // different nets must not share a grid edge
  const edgeMap = new Map();
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
        if (edgeMap.has(key) && edgeMap.get(key) !== pl.net) assert.fail(label + ' nets ' + edgeMap.get(key) + ' and ' + pl.net + ' overlap ' + key);
        edgeMap.set(key, pl.net);
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

test('555 power pins are spaced so their labels do not collide', () => {
  const model = layout(E.EX.ic_555blink());
  const u = model.symbols.find((s) => s.part.type === 'ne555');
  const reset = u.terms.find((t) => t.name === 'RESET');
  const vcc = u.terms.find((t) => t.name === 'VCC');
  assert.ok(Math.abs(reset.x - vcc.x) >= 40, 'RESET and VCC pins ' + reset.x + ' ' + vcc.x);
  assert.strictEqual(reset.dir, 't');
  assert.strictEqual(vcc.dir, 't');
  const ctrl = u.terms.find((t) => t.name === 'CTRL');
  assert.strictEqual(ctrl.nc, true);
  assert.strictEqual(ctrl.rail, null);
  assert.strictEqual(ctrl.netName, '');
});

test('loose parts park below the circuit and open pins are not supply flags', () => {
  const p = JSON.parse(JSON.stringify(E.EX.ic_555blink()));
  function add(type, id, x, y, props) {
    const d = P.T[type];
    p.parts.push({ id, type, x, y, rot: 0, props: Object.assign({}, d.props, props || {}) });
  }
  add('ecap', 'C2', 40, 40, { c: '10u' });
  add('resistor', 'RES1', 40, 120, { r: 220 });
  add('crystal', 'Y1', 800, 40, { f: '16M' });
  add('capacitor', 'CAP1', 900, 40, { c: '1u' });
  const y = p.parts.find((q) => q.id === 'Y1');
  const c = p.parts.find((q) => q.id === 'CAP1');
  const py = P.pinWorld(y, P.T.crystal.pins(y)[1]);
  const pc = P.pinWorld(c, P.T.capacitor.pins(c)[0]);
  p.wires.push({ id: 'wloose', a: { x: py.x, y: py.y }, b: { x: pc.x, y: pc.y }, pts: [], color: 'green' });
  const model = layout(p);
  audit(model, 'loose');
  const loose = model.symbols.filter((s) => s.parked);
  assert.deepStrictEqual(loose.map((s) => s.id).sort(), ['C2', 'CAP1', 'RES1', 'Y1']);
  const mainBottom = Math.max(...model.symbols.filter((s) => !s.parked).map((s) => s.y + s.h));
  for (const s of loose) assert.ok(s.y >= mainBottom + 40, s.id + ' parked at ' + s.y + ' vs ' + mainBottom);
  const ys = loose.map((s) => s.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 40, 'loose parts share one row');
  for (const s of loose) for (const t of s.terms) {
    assert.notStrictEqual(t.rail, 'flag', s.id + '.' + t.name + ' flagged ' + t.netName);
    assert.ok(!t.netName, s.id + '.' + t.name + ' labeled ' + t.netName);
  }
  const xtal = model.symbols.find((s) => s.id === 'Y1');
  assert.ok(xtal.terms.some((t) => t.nc));
  assert.ok(xtal.terms.some((t) => t.wire));
  const bat = model.symbols.find((s) => s.id === 'BAT1');
  assert.ok(!bat.parked, 'battery that feeds the 555 stays with the circuit');
  assert.strictEqual(bat.terms.find((t) => t.name === '+').rail, 'flag');
});

test('every example: text boxes do not overlap and wires stay outside symbol bodies', () => {
  const keys = E.LIST.map((row) => row[0]);
  assert.ok(keys.length >= 20, 'example list loaded');
  const problems = [];
  for (const key of keys) {
    const fn = E.EX[key];
    if (typeof fn !== 'function') continue;
    let proj;
    try { proj = fn(); } catch (e) { problems.push(key + ' example threw ' + e.message); continue; }
    if (!proj || !(proj.parts || []).some((p) => p.type !== 'breadboard' && p.type !== 'label')) continue;
    try { audit(layout(proj), key, false); }
    catch (e) { problems.push(e.message); }
  }
  assert.deepStrictEqual(problems, []);
});
