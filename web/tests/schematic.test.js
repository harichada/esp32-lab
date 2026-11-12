// Schematic layout: orthogonal wires, shared nets, no breadboard, project untouched.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'schematic.js']) require('../js/' + f);
const { layout, pinNets, toSvg } = globalThis.Schematic;
const { Sim } = globalThis.SimCore;
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

// A real series string: one diode's cathode meets exactly one other diode's anode.
// The anode has to sit on the supply side and the two anodes must not face each other.
function seriesDiodeProblems(model) {
  const diodes = model.symbols.filter((s) => s.kind === 'LED' || s.kind === 'D');
  const onNet = new Map();
  for (const s of model.symbols) for (const t of s.terms) {
    if (!onNet.has(t.net)) onNet.set(t.net, []);
    onNet.get(t.net).push(s.id + '.' + t.name);
  }
  const problems = [];
  for (const led of diodes) {
    const a = led.terms.find((t) => t.name === 'A' || t.name === '+');
    const c = led.terms.find((t) => t && t !== a);
    if (!a || !c || (onNet.get(c.net) || []).length !== 2) continue;
    const mate = diodes.find((o) => o !== led && o.terms.some((t) => (t.name === 'A' || t.name === '+') && t.net === c.net));
    if (!mate) continue;
    const na = mate.terms.find((t) => (t.name === 'A' || t.name === '+') && t.net === c.net);
    const up = (led.flow || 1) > 0 ? 'l' : 'r';
    if ((a.dir === 'l' || a.dir === 'r') && (c.dir === 'l' || c.dir === 'r') && a.dir !== up) {
      problems.push(led.id + ' cathode is on the supply side of its anode');
    }
    const sameRow = Math.abs(a.y - na.y) <= 20;
    const anodesFace = sameRow && ((a.dir === 'r' && na.dir === 'l' && na.x > a.x) || (a.dir === 'l' && na.dir === 'r' && a.x > na.x));
    if (anodesFace) problems.push(led.id + ' and ' + mate.id + ' anodes face each other');
    if ((c.dir === 'l' || c.dir === 'r') && (na.dir === 'l' || na.dir === 'r')) {
      const faces = (c.dir === 'r' && na.dir === 'l' && na.x >= c.x) || (c.dir === 'l' && na.dir === 'r' && na.x <= c.x);
      if (!faces) problems.push(led.id + '.C does not meet ' + mate.id + '.A');
    }
  }
  return problems;
}

function cathodeBarX(svg, id) {
  const i = svg.indexOf('data-pid="' + id + '"');
  if (i < 0) return null;
  const g = svg.slice(i, svg.indexOf('</g>', i));
  const m = /M(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) V(-?\d+(?:\.\d+)?)/.exec(g);
  return m ? +m[1] : null;
}

test('a pin on the ground net gets a GND symbol, including a lone ESP32 ground pin', () => {
  const lone = layout({ name: 'lone', parts: [{ id: 'esp', type: 'esp32', x: 0, y: 0, rot: 0, props: { power: 'usb' } }], wires: [] });
  const gnd = lone.symbols.find((s) => s.id === 'esp').terms.find((t) => /GND/.test(t.name));
  assert.ok(gnd, 'ESP32 has a ground term');
  assert.equal(gnd.rail, 'gnd');
  assert.equal(gnd.nc, false);
  assert.ok(lone.rails.some((r) => r.kind === 'gnd' && r.pid === 'esp'));
  assert.ok(toSvg(lone).includes('sch-gnd'));

  const button = E.EX.button();
  const drawn = layout(button);
  const led = drawn.symbols.find((s) => s.id === 'LED1');
  const cath = led.terms.find((t) => t.name === 'C');
  assert.equal(cath.rail, 'gnd');
  assert.equal(cath.nc, false);
  assert.ok(drawn.rails.some((r) => r.kind === 'gnd' && r.pid === 'LED1' && r.pin === 'C'));
  assert.ok(toSvg(drawn).includes('sch-gnd'));

  // The blue − stripe is not ground until a ground pin is jumpered onto it.
  const open = E.EX.button();
  const board = open.parts.find((p) => p.type === 'breadboard');
  const hole = (row, col) => {
    const h = P.T.breadboard.pins(board).find((z) => z.name === row + col);
    return { x: board.x + h.x, y: board.y + h.y };
  };
  const a3 = hole('a', 3), tn3 = hole('tn', 3);
  const near = (a, b) => a && b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  const before = open.wires.length;
  open.wires = open.wires.filter((w) => !((near(w.a, a3) && near(w.b, tn3)) || (near(w.a, tn3) && near(w.b, a3))));
  assert.ok(open.wires.length === before - 1, 'removed the GND.2 jumper onto the top − rail');
  const floated = layout(open);
  const fc = floated.symbols.find((s) => s.id === 'LED1').terms.find((t) => t.name === 'C');
  assert.notEqual(fc.rail, 'gnd');
  assert.ok(!floated.rails.some((r) => r.kind === 'gnd' && r.pid === 'LED1'));
});

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
  assert.strictEqual(cpin.net, 0, 'LED cathode returns through the breadboard rails');
  assert.ok(!model.symbols.some((s) => s.parked), 'blink has no loose parts');
  assert.ok(model.rails.some((g) => g.kind === 'gnd' && g.pid === led.id));
  assert.ok(model.rails.some((g) => g.kind === 'gnd' && g.pid === 'esp'));
  // resistor and LED share a wired net
  const rn = r.terms.map((t) => t.net);
  const ln = led.terms.filter((t) => t.wire).map((t) => t.net);
  assert.ok(rn.some((n) => ln.includes(n)), 'series net');
  assert.ok(!model.fallback, 'blink routed cleanly');
});

test('series vs parallel LEDs: supply is drawn, and the red pair is one anode-to-cathode string', () => {
  const model = layout(E.EX.b_series());
  audit(model, 'b_series');
  assert.ok(!model.fallback, (model.fallbackWhy || []).join('; '));
  const pin = (id, name) => model.symbols.find((s) => s.id === id).terms.find((t) => t.name === name);
  const plus = pin('BAT1', '+');
  assert.strictEqual(plus.net, pin('R1', '1').net);
  assert.strictEqual(plus.net, pin('R2', '1').net);
  assert.strictEqual(plus.net, pin('R3', '1').net);
  for (const [id, name] of [['BAT1', '+'], ['R1', '1'], ['R2', '1'], ['R3', '1']]) {
    const t = pin(id, name);
    assert.strictEqual(t.wire, true, id + ' supply pin is not drawn');
    assert.notStrictEqual(t.rail, 'flag', id + ' supply pin is only a ' + t.netName + ' flag');
  }
  const reach = connected(model, plus.net);
  for (const id of ['R1', 'R2', 'R3']) {
    const t = pin(id, '1');
    assert.ok(reach.has(t.x + ',' + t.y) || reach.has(t.sx + ',' + t.sy), id + ' is not on the supply wire');
  }
  assert.strictEqual(pin('R1', '2').net, pin('LED1', 'A').net);
  assert.strictEqual(pin('LED1', 'C').net, pin('LED2', 'A').net);
  assert.notStrictEqual(pin('LED1', 'A').net, pin('LED2', 'A').net);
  assert.strictEqual(pin('LED2', 'C').rail, 'gnd');
  assert.strictEqual(pin('LED3', 'C').rail, 'gnd');
  assert.strictEqual(pin('LED4', 'C').rail, 'gnd');
  assert.strictEqual(pin('R2', '2').net, pin('LED3', 'A').net);
  assert.strictEqual(pin('R3', '2').net, pin('LED4', 'A').net);
  const a1 = pin('LED1', 'A'), c1 = pin('LED1', 'C'), a2 = pin('LED2', 'A');
  assert.ok(a1.x < c1.x && c1.x <= a2.x, 'red LEDs do not read left to right');
  assert.strictEqual(a1.dir, 'l');
  assert.strictEqual(c1.dir, 'r');
  assert.strictEqual(a2.dir, 'l');
  assert.deepStrictEqual(seriesDiodeProblems(model), []);
  const svg = toSvg(model);
  for (const id of ['LED1', 'LED2', 'LED3', 'LED4']) {
    const a = pin(id, 'A'), c = pin(id, 'C'), bx = cathodeBarX(svg, id);
    assert.ok(bx !== null, id + ' has no cathode bar');
    assert.ok(Math.abs(bx - c.x) < Math.abs(bx - a.x), id + ' bar ' + bx + ' is nearer the anode ' + a.x + ' than the cathode ' + c.x);
  }
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

test('555 example is a standard astable: TRIG and THR meet at the timing cap, and the battery is wired in', () => {
  const proj = E.EX.ic_555blink();
  assert.deepStrictEqual(proj.parts.map((p) => p.id).sort(), ['BAT1', 'C1', 'LED1', 'R1', 'R2', 'R3', 'U1']);
  const sim = new Sim(proj);
  sim.topology();
  const net = (id, pin) => sim.pinNet.get(id + ':' + pin);
  const timing = net('U1', 'TRIG');
  assert.strictEqual(net('U1', 'THR'), timing, 'THR tied to TRIG');
  assert.strictEqual(net('C1', '+'), timing, 'timing cap on THR/TRIG');
  assert.strictEqual(net('R2', '2'), timing, 'R2 feeds the timing node');
  assert.notStrictEqual(net('U1', 'DIS'), timing, 'DIS is the other side of R2');
  assert.strictEqual(net('U1', 'DIS'), net('R1', '2'));
  assert.strictEqual(net('U1', 'DIS'), net('R2', '1'));
  assert.strictEqual(net('R1', '1'), net('U1', 'VCC'));
  assert.strictEqual(net('R1', '1'), net('BAT1', '+'));
  assert.strictEqual(net('U1', 'RESET'), net('U1', 'VCC'));
  assert.strictEqual(net('U1', 'GND'), net('C1', '-'));
  assert.strictEqual(net('U1', 'GND'), net('BAT1', '-'));
  assert.strictEqual(net('U1', 'GND'), net('LED1', 'C'));
  assert.strictEqual(net('U1', 'OUT'), net('R3', '2'));
  assert.strictEqual(net('R3', '1'), net('LED1', 'A'));
  const model = layout(proj);
  audit(model, '555-astable');
  assert.ok(!model.labels.some((l) => l.name === 'TRIG'), 'the timing node is not a wire named TRIG');
  const bat = model.symbols.find((s) => s.id === 'BAT1');
  assert.ok(!bat.parked);
  assert.strictEqual(bat.terms.find((t) => t.name === '+').wire, true, 'battery positive is wired into the circuit');
  const timingNet = model.symbols.find((s) => s.id === 'U1').terms.find((t) => t.name === 'TRIG').net;
  const onTiming = model.symbols.flatMap((s) => s.terms.filter((t) => t.net === timingNet).map((t) => s.id + '.' + t.name)).sort();
  assert.deepStrictEqual(onTiming, ['C1.+', 'R2.2', 'U1.THR', 'U1.TRIG']);
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
  assert.deepStrictEqual(loose.map((s) => s.id).sort(), ['C2', 'RES1']);
  const placed = model.symbols.filter((s) => !s.parked);
  const mainBottom = Math.max(...placed.filter((s) => s.part.type === 'ne555' || s.part.type === 'battery9v' || s.part.type === 'led').map((s) => s.y + s.h));
  for (const s of loose) {
    assert.ok(s.y >= mainBottom + 40, s.id + ' parked at ' + s.y + ' vs ' + mainBottom);
    assert.ok(s.terms.every((t) => t.nc), s.id + ' parked with a connected pin');
    assert.ok(model.texts.some((t) => t.kind === 'note' && t.pid === s.id && t.text === 'Not connected'), s.id + ' caption');
  }
  const ys = loose.map((s) => s.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 40, 'open parts share one row');
  for (const s of loose) for (const t of s.terms) {
    assert.notStrictEqual(t.rail, 'flag', s.id + '.' + t.name + ' flagged ' + t.netName);
    assert.ok(!t.netName, s.id + '.' + t.name + ' labeled ' + t.netName);
  }
  const xtal = model.symbols.find((s) => s.id === 'Y1');
  const cap = model.symbols.find((s) => s.id === 'CAP1');
  assert.ok(!xtal.parked && !cap.parked, 'a wired crystal and capacitor stay in a circuit');
  assert.ok(xtal.terms.some((t) => t.nc));
  assert.ok(xtal.terms.some((t) => t.wire && cap.terms.some((u) => u.net === t.net)));
  const bat = model.symbols.find((s) => s.id === 'BAT1');
  assert.ok(!bat.parked, 'battery that feeds the 555 stays with the circuit');
  const plus = bat.terms.find((t) => t.name === '+');
  assert.ok(plus.wire || plus.rail === 'flag', 'battery still feeds the VCC net');
  assert.ok(!model.fallback, 'loose fixture routed cleanly');
});

test('ground parts on a shared net draw as the GND rail, not floating symbols', () => {
  const model = layout(E.EX.transistor());
  audit(model, 'transistor');
  assert.ok(!model.fallback, 'transistor ' + (model.fallbackWhy || []).join('; '));
  assert.ok(!model.symbols.some((s) => s.part.type === 'ground'), 'G1/G2 are the emitter and supply ground');
  assert.ok(!model.symbols.some((s) => s.parked));
  const q = model.symbols.find((s) => s.kind === 'NPN');
  assert.strictEqual(q.terms.find((t) => t.name === 'E').rail, 'gnd');
  assert.ok(model.rails.some((r) => r.kind === 'gnd' && r.pid === q.id));
  const v5 = model.symbols.find((s) => s.part.type === 'vcc5');
  assert.ok(v5 && !v5.parked);
  assert.strictEqual(v5.terms.find((t) => t.name === 'GND').rail, 'gnd');
});

test('spirit-level LED grounds are rails, and the dense examples do not fall back', () => {
  for (const key of ['level', 'remote', 'sensorsjs', 'displaysjs', 'ic_555blink']) {
    const model = layout(E.EX[key]());
    audit(model, key);
    assert.ok(!model.fallback, key + ' fallback ' + (model.fallbackWhy || []).join('; '));
    assert.ok(!model.symbols.some((s) => s.parked && s.part.type === 'ground'), key + ' parked a ground');
    for (const s of model.symbols) if (s.parked) {
      assert.ok(s.terms.every((t) => t.nc), key + ' ' + s.id + ' parked but connected');
    }
  }
  const level = layout(E.EX.level());
  assert.ok(!level.symbols.some((s) => s.part.type === 'ground'));
  const leds = level.symbols.filter((s) => s.part.type === 'led');
  assert.ok(leds.length >= 2);
  for (const led of leds) assert.strictEqual(led.terms.find((t) => t.name === 'C').rail, 'gnd');
});

function assertCircuit(model, label) {
  audit(model, label);
  assert.ok(!model.fallback, label + ' fallback ' + (model.fallbackWhy || []).join('; '));
  for (const s of model.symbols) {
    if (s.part.type !== 'ground') continue;
    const net = s.terms[0] && s.terms[0].net;
    const shared = model.symbols.some((o) => o.id !== s.id && o.part.type !== 'ground' && o.terms.some((t) => t.net === net));
    assert.ok(!shared, label + ' ground ' + s.id + ' restates a connected net');
    assert.ok(!s.parked, label + ' ground ' + s.id + ' parked');
  }
  for (const s of model.symbols) if (s.parked) {
    assert.ok(s.terms.every((t) => t.nc), label + ' ' + s.id + ' parked but a pin shares a net');
    assert.ok(model.texts.some((t) => t.kind === 'note' && t.pid === s.id && t.text === 'Not connected'), label + ' ' + s.id + ' missing caption');
  }
  const series = seriesDiodeProblems(model);
  assert.deepStrictEqual(series, [], label + ' series diode: ' + series.join('; '));
}

test('every example: 2D, 3D and schematic share one netlist, with no stray or duplicate parts', () => {
  const keys = E.LIST.map((row) => row[0]);
  assert.ok(keys.length >= 42, 'example list has ' + keys.length);
  const problems = [];
  for (const key of keys) {
    const fn = E.EX[key];
    if (typeof fn !== 'function') continue;
    let proj;
    try { proj = fn(); } catch (e) { problems.push(key + ' example threw ' + e.message); continue; }
    if (!proj || !(proj.parts || []).length) { problems.push(key + ' has no parts'); continue; }
    const ids = proj.parts.map((p) => p.id);
    if (new Set(ids).size !== ids.length) problems.push(key + ' has duplicate part ids');
    const sim = new Sim(JSON.parse(JSON.stringify(proj)));
    sim.topology();
    let model;
    try { model = layout(proj); } catch (e) { problems.push(key + ' layout threw ' + e.message); continue; }
    try { assertCircuit(model, key); }
    catch (e) { problems.push(e.message); }
    for (const s of model.symbols) if (!ids.includes(s.id)) problems.push(key + ' schematic invented ' + s.id);
    const sch = pinNets(proj);
    const pins = [];
    for (const p of proj.parts) {
      if (p.type === 'breadboard' || p.type === 'label') continue;
      const d = P.T[p.type];
      if (!d || !d.pins) continue;
      let list = [];
      try { list = d.pins(p) || []; } catch (e) { problems.push(key + ' pins threw ' + p.id); continue; }
      for (const pin of list) pins.push(p.id + ':' + pin.name);
    }
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i], b = pins[j];
      const simSame = sim.pinNet.get(a) !== undefined && sim.pinNet.get(a) === sim.pinNet.get(b);
      const schSame = sch.get(a) !== undefined && sch.get(a) === sch.get(b);
      if (simSame !== schSame) {
        problems.push(key + ' net mismatch ' + a + ' / ' + b);
        i = pins.length; break;
      }
    }
    // A ground symbol omitted from the drawing must still be the same sim net as a drawn ground pin.
    for (const p of proj.parts) {
      if (p.type !== 'ground' || model.symbols.some((s) => s.id === p.id)) continue;
      const g = sim.pinNet.get(p.id + ':GND');
      const drawn = [...sch.keys()].some((k) => sim.pinNet.get(k) === g);
      if (!drawn) problems.push(key + ' dropped ground ' + p.id + ' that is not on a drawn net');
    }
    // 2D and 3D render these same wires. Nothing else defines their connectivity.
    for (const w of proj.wires || []) {
      if (!w.a || !w.b || !isFinite(w.a.x) || !isFinite(w.b.x)) problems.push(key + ' wire ' + w.id + ' is not a 2D/3D segment');
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('every example: no fallback, no connected floater, no text overlap, no wire through a body', () => {
  const keys = E.LIST.map((row) => row[0]);
  assert.ok(keys.length >= 20, 'example list loaded');
  const problems = [];
  for (const key of keys) {
    const fn = E.EX[key];
    if (typeof fn !== 'function') continue;
    let proj;
    try { proj = fn(); } catch (e) { problems.push(key + ' example threw ' + e.message); continue; }
    if (!proj || !(proj.parts || []).some((p) => p.type !== 'breadboard' && p.type !== 'label')) continue;
    try { assertCircuit(layout(proj), key); }
    catch (e) { problems.push(e.message); }
  }
  assert.deepStrictEqual(problems, []);
});
