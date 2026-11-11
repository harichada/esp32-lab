// Drag-and-drop must seat every pin in a row hole, never on a rail or between rows.
const test = require('node:test');
const assert = require('node:assert');
const { Parts, Examples } = require('./tools/load-parts');

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
