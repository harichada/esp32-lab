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

function footprint(type, origin) {
  const spec = Parts.T[type];
  const p = { id: '_', type, x: origin.x, y: origin.y, rot: origin.rot || 0, props: JSON.parse(JSON.stringify(spec.props || {})) };
  const pins = spec.pins(p);
  const sz = spec.size(p) || { w: 10, h: 10 };
  let x0 = 0, y0 = 0, x1 = sz.w || 0, y1 = 0;
  for (const pin of pins) {
    x0 = Math.min(x0, pin.x); y0 = Math.min(y0, pin.y);
    x1 = Math.max(x1, pin.x); y1 = Math.max(y1, pin.y);
  }
  if (y1 - y0 < 20) { y0 = Math.min(y0, -(Math.max(sz.h || 10, 16))); y1 = Math.max(y1, 6); }
  else { x0 -= 6; y0 -= 6; x1 += 6; y1 += 6; }
  let wx0 = 1e9, wy0 = 1e9, wx1 = -1e9, wy1 = -1e9;
  for (const [a, b] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const [rx, ry] = Parts.rotPt(a, b, p.rot || 0);
    wx0 = Math.min(wx0, p.x + rx); wy0 = Math.min(wy0, p.y + ry);
    wx1 = Math.max(wx1, p.x + rx); wy1 = Math.max(wy1, p.y + ry);
  }
  return { x0: wx0, y0: wy0, x1: wx1, y1: wy1 };
}
function overlaps(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

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
