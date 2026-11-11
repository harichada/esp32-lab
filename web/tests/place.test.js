// Click-to-add must seat parts in breadboard holes, not the centre channel.
const test = require('node:test');
const assert = require('node:assert');
const { Parts, Examples } = require('./tools/load-parts');

function holeMap(parts) {
  const map = new Map();
  for (const p of parts) {
    if (p.type !== 'breadboard') continue;
    for (const h of Parts.T.breadboard.pins(p)) {
      const w = Parts.pinWorld(p, h);
      map.set(Math.round(w.x) + ',' + Math.round(w.y), { name: h.name, bb: p.id });
    }
  }
  return map;
}
function seated(parts, type, origin) {
  const spec = Parts.T[type];
  const p = { id: '_', type, x: origin.x, y: origin.y, rot: 0, props: JSON.parse(JSON.stringify(spec.props || {})) };
  return spec.pins(p).map((pin) => {
    const w = Parts.pinWorld(p, pin);
    const hit = holeMap(parts).get(Math.round(w.x) + ',' + Math.round(w.y));
    return { x: w.x, y: w.y, name: pin.name, hole: hit ? hit.name : null, bb: hit ? hit.bb : null };
  });
}
function side(name) {
  const m = /^([a-j])/.exec(name || '');
  if (!m) return 'rail';
  return 'abcde'.includes(m[1]) ? 'a' : 'f';
}
const blink = () => Examples.EX.blink();

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
