// Drag-and-drop must seat every pin in a row hole, never on a rail or between rows.
const test = require('node:test');
const assert = require('node:assert');
const { Parts, Examples, Netlist } = require('./tools/load-parts');

function holeMap(parts) {
  const map = new Map();
  for (const p of parts) {
    if (p.type !== 'breadboard') continue;
    for (const h of Parts.T.breadboard.pins(p)) {
      const w = Parts.pinWorld(p, h);
      map.set(Math.round(w.x) + ',' + Math.round(w.y), h.name);
    }
  }
  return map;
}
function seated(parts, type, origin) {
  const spec = Parts.T[type];
  const p = { id: '_', type, x: origin.x, y: origin.y, rot: 0, props: JSON.parse(JSON.stringify(spec.props || {})) };
  return spec.pins(p).map((pin) => {
    const w = Parts.pinWorld(p, pin);
    const name = holeMap(parts).get(Math.round(w.x) + ',' + Math.round(w.y)) || null;
    return { x: w.x, y: w.y, hole: name };
  });
}
function footprint(type, origin) {
  const spec = Parts.T[type];
  const p = { id: '_', type, x: origin.x, y: origin.y, rot: 0, props: JSON.parse(JSON.stringify(spec.props || {})) };
  const pins = spec.pins(p);
  const sz = spec.size(p) || { w: 10, h: 10 };
  let x0 = 0, y0 = 0, x1 = sz.w || 0, y1 = 0;
  for (const pin of pins) {
    x0 = Math.min(x0, pin.x); y0 = Math.min(y0, pin.y);
    x1 = Math.max(x1, pin.x); y1 = Math.max(y1, pin.y);
  }
  if (y1 - y0 < 20) { y0 = Math.min(y0, -(Math.max(sz.h || 10, 16))); y1 = Math.max(y1, 6); }
  else { x0 -= 6; y0 -= 6; x1 += 6; y1 += 6; }
  return { x0: origin.x + x0, y0: origin.y + y0, x1: origin.x + x1, y1: origin.y + y1 };
}
function overlaps(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}
function rowHoles(pins) {
  assert.ok(pins.every((q) => q.hole && /^[a-j]\d+$/.test(q.hole)), JSON.stringify(pins));
  assert.ok(pins.every((q) => !/^[tbp][np]/.test(q.hole)), 'rail hole ' + JSON.stringify(pins));
}
function side(name) {
  const m = /^([a-j])/.exec(name || '');
  if (!m) return 'rail';
  return 'abcde'.includes(m[1]) ? 'a' : 'f';
}
const blink = () => Examples.EX.blink();

test('a drop in the centre channel seats on the nearest row, not between rows', () => {
  const proj = blink();
  const at = Parts.placeDroppedPart(proj.parts, 'led', 320, 90, 0);
  const pins = seated(proj.parts, 'led', at);
  rowHoles(pins);
  assert.ok(pins.every((q) => q.y === 80), JSON.stringify(pins));
  assert.notStrictEqual(at.y, 90);
});

test('a drop between two rows snaps onto one of them', () => {
  const proj = blink();
  const at = Parts.placeDroppedPart(proj.parts, 'led', 320, 45, 0);
  const pins = seated(proj.parts, 'led', at);
  rowHoles(pins);
  assert.ok(pins.every((q) => q.y === 40 || q.y === 50), JSON.stringify(pins));
  assert.ok(new Set(pins.map((q) => q.y)).size === 1);
});

test('a drop on the power-rail line seats in row holes, not on the rail', () => {
  const proj = blink();
  const at = Parts.placeDroppedPart(proj.parts, 'led', 320, 5, 0);
  const pins = seated(proj.parts, 'led', at);
  rowHoles(pins);
  assert.ok(pins.every((q) => q.y === 40), JSON.stringify(pins));
  assert.ok(pins.every((q) => q.hole.startsWith('a')));
});

test('a drop on an exact free hole is left there', () => {
  const proj = blink();
  const at = Parts.placeDroppedPart(proj.parts, 'led', 500, 40, 0);
  assert.deepStrictEqual(at, { x: 500, y: 40 });
  rowHoles(seated(proj.parts, 'led', at));
});

test('a drop onto an occupied seat moves to the nearest free spot', () => {
  const proj = blink();
  const first = Parts.placeDroppedPart(proj.parts, 'led', 320, 90, 0);
  proj.parts.push({ id: 'LEDX', type: 'led', x: first.x, y: first.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) });
  const second = Parts.placeDroppedPart(proj.parts, 'led', 320, 90, 0);
  assert.notDeepStrictEqual(second, first);
  const pa = seated(proj.parts, 'led', first), pb = seated(proj.parts, 'led', second);
  rowHoles(pa); rowHoles(pb);
  const used = new Set(pa.map((q) => q.x + ',' + q.y));
  assert.ok(pb.every((q) => !used.has(q.x + ',' + q.y)), JSON.stringify([pa, pb]));
  assert.ok(!overlaps(footprint('led', first), footprint('led', second)));
  const moved = Math.hypot(second.x - 320, second.y - 90);
  const stayed = Math.hypot(first.x - 320, first.y - 90);
  assert.ok(moved < stayed + 40, JSON.stringify({ first, second, moved }));
});

test('a dropped resistor seats both pins in one row', () => {
  const proj = blink();
  const at = Parts.placeDroppedPart(proj.parts, 'resistor', 323, 87, 0);
  const pins = seated(proj.parts, 'resistor', at);
  rowHoles(pins);
  assert.strictEqual(new Set(pins.map((q) => q.y)).size, 1);
  assert.ok(pins.every((q) => q.y === 80), JSON.stringify(pins));
});

test('a drop off the breadboard is not pulled onto it', () => {
  const proj = blink();
  assert.deepStrictEqual(Parts.placeDroppedPart(proj.parts, 'led', -400, 40, 0), { x: -400, y: 40 });
});

test('an exact drop on a free hole of a shared strip stays there', () => {
  const proj = blink();
  const x = 400, top = { id: 'LEDX', type: 'led', x, y: 110, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) };
  proj.parts.push(top);
  const at = Parts.placeDroppedPart(proj.parts, 'led', x, 150, 0);
  assert.deepStrictEqual(at, { x, y: 150 });
  proj.parts.push({ id: 'LEDY', type: 'led', x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) });
  const nl = Netlist.extract(proj);
  const joined = nl.nets.some((net) => net.pins.some((p) => p.startsWith('LEDX:')) && net.pins.some((p) => p.startsWith('LEDY:')));
  assert.ok(joined, 'same-strip drop is intentional wiring');
  assert.ok(!overlaps(footprint('led', top), footprint('led', at)));
});

test('crowded blink: click-add after four nudged LEDs stays off shared strips', () => {
  const proj = blink();
  const nudged = [];
  for (let i = 0; i < 4; i++) {
    const at = Parts.placeDroppedPart(proj.parts, 'led', 293, 116, 0);
    const id = 'D' + (i + 1);
    proj.parts.push({ id, type: 'led', x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) });
    nudged.push(at);
  }
  assert.deepStrictEqual(nudged, [{ x: 310, y: 120 }, { x: 290, y: 80 }, { x: 330, y: 120 }, { x: 310, y: 80 }]);
  const added = [];
  for (const type of ['led', 'resistor']) {
    const at = Parts.placeOnEmptyStrips(proj.parts, type, 320, 90, 0);
    const id = type === 'led' ? 'LEDN' : 'RESN';
    assert.ok(at.y <= 80 || at.y >= 110, 'channel ' + JSON.stringify(at));
    assert.ok(![0, 10, 180, 190].includes(at.y), 'rail ' + JSON.stringify(at));
    rowHoles(seated(proj.parts, type, at));
    for (const old of proj.parts) {
      if (old.type === 'breadboard' || old.type === 'label') continue;
      assert.ok(!overlaps(footprint(type, at), footprint(old.type, old)), id + ' overlaps ' + old.id);
    }
    proj.parts.push({ id, type, x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T[type].props)) });
    added.push(id);
  }
  const nl = Netlist.extract(proj);
  for (const net of nl.nets) {
    const ids = [...new Set(net.pins.map((p) => p.split(':')[0]))];
    const news = ids.filter((id) => added.includes(id) || id.startsWith('D'));
    assert.ok(!(news.length && ids.length > 1), 'joined ' + net.pins.join(' '));
  }
});

test('a full board sends click-add beside the breadboard', () => {
  const proj = blink();
  const bb = proj.parts.find((p) => p.type === 'breadboard');
  const holes = Parts.T.breadboard.pins(bb);
  let n = 0;
  for (const h of holes) {
    if (!/^[af]\d+$/.test(h.name)) continue;
    const w = Parts.pinWorld(bb, h);
    proj.parts.push({ id: 'G' + (++n), type: 'ground', x: w.x, y: w.y, rot: 0, props: {} });
  }
  const at = Parts.placeOnEmptyStrips(proj.parts, 'led', 320, 90, 0);
  const edge = Parts.T.breadboard.size(bb).w + 4;
  assert.ok(at.x >= edge || at.x < -8, 'still on the board ' + JSON.stringify(at));
  const pins = seated(proj.parts, 'led', at);
  assert.ok(pins.every((q) => !q.hole), JSON.stringify(pins));
});

test('click-add skips a strip that a hole-only seat would share', () => {
  const proj = blink();
  const x = 400;
  const top = { id: 'LEDX', type: 'led', x, y: 110, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) };
  proj.parts.push(top);
  const holeOnly = { x, y: 150 };
  const holes = seated(proj.parts, 'led', holeOnly);
  rowHoles(holes);
  assert.ok(!overlaps(footprint('led', top), footprint('led', holeOnly)));
  const trial = blink();
  trial.parts.push(JSON.parse(JSON.stringify(top)));
  trial.parts.push({ id: 'LEDY', type: 'led', x: holeOnly.x, y: holeOnly.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) });
  const wouldJoin = Netlist.extract(trial).nets.some((net) => net.pins.some((p) => p.startsWith('LEDX:')) && net.pins.some((p) => p.startsWith('LEDY:')));
  assert.ok(wouldJoin, 'hole-only seat on the free holes of that strip joins the LEDs');
  const at = Parts.placeOnEmptyStrips(proj.parts, 'led', x, holeOnly.y, 0);
  assert.notDeepStrictEqual(at, holeOnly);
  rowHoles(seated(proj.parts, 'led', at));
  proj.parts.push({ id: 'LEDY', type: 'led', x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) });
  const nl = Netlist.extract(proj);
  for (const net of nl.nets) {
    const ids = [...new Set(net.pins.map((p) => p.split(':')[0]))];
    assert.ok(!(ids.includes('LEDY') && ids.length > 1), 'joined ' + net.pins.join(' '));
  }
  assert.ok(!overlaps(footprint('led', top), footprint('led', at)));
});

test('repeated drops on an occupied LED do not join nets or overlap', () => {
  const proj = blink();
  const led = proj.parts.find((p) => p.id === 'LED1');
  const added = [];
  for (let i = 0; i < 6; i++) {
    const at = Parts.placeDroppedPart(proj.parts, 'led', led.x, led.y, 0);
    const id = 'N' + (i + 1);
    const part = { id, type: 'led', x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) };
    rowHoles(seated(proj.parts, 'led', at));
    proj.parts.push(part);
    added.push(part);
  }
  const nl = Netlist.extract(proj);
  for (const net of nl.nets) {
    const ids = [...new Set(net.pins.map((p) => p.split(':')[0]))];
    const news = ids.filter((id) => added.some((p) => p.id === id));
    assert.ok(!(news.length && ids.length > 1), 'joined ' + net.pins.join(' '));
  }
  const bodies = proj.parts.filter((p) => p.type !== 'breadboard' && p.type !== 'label').map((p) => footprint(p.type, p));
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    assert.ok(!overlaps(bodies[i], bodies[j]), JSON.stringify([bodies[i], bodies[j]]));
  }
});

test('LED clicked at the fitted centre seats in one row, not the centre channel', () => {
  const proj = blink();
  const at = Parts.placeNewPart(proj.parts, 'led', 320, 90, 0);
  const pins = seated(proj.parts, 'led', at);
  assert.ok(pins.every((q) => q.hole), JSON.stringify(pins));
  assert.ok(pins.every((q) => q.y <= 80 || q.y >= 110), 'pin in the trough: ' + JSON.stringify(pins));
  const sides = new Set(pins.map((q) => side(q.hole)));
  assert.strictEqual(sides.size, 1);
  assert.notStrictEqual([...sides][0], 'both');
  const used = new Set();
  for (const p of proj.parts) {
    if (p.type === 'breadboard' || p.type === 'label') continue;
    for (const pin of Parts.T[p.type].pins(p)) { const w = Parts.pinWorld(p, pin); used.add(Math.round(w.x) + ',' + Math.round(w.y)); }
  }
  assert.ok(pins.every((q) => !used.has(q.x + ',' + q.y)), 'stacked on an existing leg');
});

test('consecutive click-adds step along the row and do not overlap', () => {
  const proj = blink();
  const prior = proj.parts.filter((p) => p.type !== 'breadboard' && p.type !== 'label').map((p) => footprint(p.type, p));
  const types = ['led', 'resistor', 'led'];
  const placed = [];
  for (const type of types) {
    const at = Parts.placeNewPart(proj.parts, type, 320, 90, 0);
    const pins = seated(proj.parts, type, at);
    assert.ok(pins.every((q) => q.hole), type + ' ' + JSON.stringify({ at, pins }));
    assert.ok(pins.every((q) => q.y <= 80 || q.y >= 110), type + ' in the trough');
    const spec = Parts.T[type];
    proj.parts.push({ id: type + placed.length, type, x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(spec.props || {})) });
    placed.push({ type, at, pins, box: footprint(type, at) });
  }
  assert.ok(placed.every((p) => p.at.y === placed[0].at.y), JSON.stringify(placed.map((p) => p.at)));
  assert.ok(placed[0].at.x < placed[1].at.x && placed[1].at.x < placed[2].at.x, JSON.stringify(placed.map((p) => p.at)));
  const used = new Set();
  for (let i = 0; i < placed.length; i++) {
    for (const pin of placed[i].pins) {
      const k = pin.x + ',' + pin.y;
      assert.ok(!used.has(k), 'shared hole ' + k);
      used.add(k);
    }
    for (let j = 0; j < i; j++) assert.ok(!overlaps(placed[i].box, placed[j].box), JSON.stringify([placed[i].at, placed[j].at]));
    for (const old of prior) assert.ok(!overlaps(placed[i].box, old), JSON.stringify([placed[i].at, old]));
  }
});

test('a second LED does not reuse the first LED\'s holes', () => {
  const proj = blink();
  const a = Parts.placeNewPart(proj.parts, 'led', 320, 90, 0);
  const spec = Parts.T.led;
  proj.parts.push({ id: 'LEDX', type: 'led', x: a.x, y: a.y, rot: 0, props: JSON.parse(JSON.stringify(spec.props)) });
  const b = Parts.placeNewPart(proj.parts, 'led', 320, 90, 0);
  const pa = seated(proj.parts, 'led', a), pb = seated(proj.parts, 'led', b);
  const keys = new Set(pa.map((q) => q.x + ',' + q.y));
  assert.ok(pb.every((q) => q.hole && !keys.has(q.x + ',' + q.y)));
});

test('an exact free hole is left where it is', () => {
  const proj = blink();
  const at = Parts.placeNewPart(proj.parts, 'led', 500, 40, 0);
  assert.deepStrictEqual(at, { x: 500, y: 40 });
  assert.ok(seated(proj.parts, 'led', at).every((q) => q.hole));
});

test('DIP clicked on the channel may straddle it, with every pin in a hole', () => {
  const proj = blink();
  const at = Parts.placeNewPart(proj.parts, 'ne555', 320, 110, 0);
  const pins = seated(proj.parts, 'ne555', at);
  assert.ok(pins.every((q) => q.hole), JSON.stringify(pins));
  assert.ok(pins.every((q) => q.y <= 80 || q.y >= 110));
  const sides = new Set(pins.map((q) => side(q.hole)));
  assert.ok(sides.has('a') && sides.has('f'), [...sides].join(','));
});

test('a click off the breadboard stays in that free spot', () => {
  const proj = blink();
  const at = Parts.placeNewPart(proj.parts, 'led', -400, 40, 0);
  assert.deepStrictEqual(at, { x: -400, y: 40 });
  assert.ok(seated(proj.parts, 'led', at).every((q) => !q.hole));
});

test('with no breadboard the click point is kept', () => {
  const proj = Examples.EX.pot();
  assert.ok(!proj.parts.some((p) => p.type === 'breadboard'));
  assert.deepStrictEqual(Parts.placeNewPart(proj.parts, 'led', 123, 87, 0), { x: 120, y: 90 });
});

test('a new breadboard does not stack on the one already there', () => {
  const proj = blink();
  const at = Parts.placeNewPart(proj.parts, 'breadboard', 0, 0, 0);
  assert.ok(at.x !== 0 || at.y !== 0, JSON.stringify(at));
  const sz = Parts.T.breadboard.size({ props: { cols: 63 } });
  const overlap = !(at.x + sz.w < 0 || at.x > sz.w || at.y + sz.h < 0 || at.y > 200);
  assert.strictEqual(overlap, false, JSON.stringify(at));
});

test('crowded blink: placeNewPart after four LEDs on Blink\'s LED stays off shared strips', () => {
  const proj = blink();
  const nudged = [[310, 120], [290, 80], [330, 120], [310, 80]];
  nudged.forEach(([x, y], i) => proj.parts.push({ id: 'D' + (i + 1), type: 'led', x, y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T.led.props)) }));
  const added = [];
  for (const type of ['led', 'resistor']) {
    const at = Parts.placeNewPart(proj.parts, type, 320, 90, 0);
    const id = type === 'led' ? 'LEDN' : 'RESN';
    const pins = seated(proj.parts, type, at);
    assert.ok(pins.every((q) => q.hole && /^[a-j]\d+$/.test(q.hole)), JSON.stringify(pins));
    assert.ok(pins.every((q) => q.y <= 80 || q.y >= 110), 'channel ' + JSON.stringify(at));
    for (const old of proj.parts) {
      if (old.type === 'breadboard' || old.type === 'label') continue;
      assert.ok(!overlaps(footprint(type, at), footprint(old.type, old)), id + ' overlaps ' + old.id);
    }
    proj.parts.push({ id, type, x: at.x, y: at.y, rot: 0, props: JSON.parse(JSON.stringify(Parts.T[type].props)) });
    added.push(id);
  }
  const nl = Netlist.extract(proj);
  for (const net of nl.nets) {
    const ids = [...new Set(net.pins.map((p) => p.split(':')[0]))];
    const news = ids.filter((id) => added.includes(id) || id.startsWith('D'));
    assert.ok(!(news.length && ids.length > 1), 'joined ' + net.pins.join(' '));
  }
});

test('placeNewPart sends a full board beside the breadboard', () => {
  const proj = blink();
  const bb = proj.parts.find((p) => p.type === 'breadboard');
  let n = 0;
  for (const h of Parts.T.breadboard.pins(bb)) {
    if (!/^[af]\d+$/.test(h.name)) continue;
    const w = Parts.pinWorld(bb, h);
    proj.parts.push({ id: 'G' + (++n), type: 'ground', x: w.x, y: w.y, rot: 0, props: {} });
  }
  const at = Parts.placeNewPart(proj.parts, 'led', 320, 90, 0);
  const edge = Parts.T.breadboard.size(bb).w + 4;
  assert.ok(at.x >= edge || at.x < -8, 'still on the board ' + JSON.stringify(at));
  assert.ok(seated(proj.parts, 'led', at).every((q) => !q.hole), JSON.stringify(at));
});
