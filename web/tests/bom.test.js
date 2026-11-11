// Parts list: the header counts the parts on the board, and an open tab
// refreshes when a part is added or deleted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Parts, Examples, Bom } = require('./tools/load-parts');

function add(proj, type, x, y) {
  const d = Parts.T[type];
  const pre = d.prefix || type.slice(0, 3).toUpperCase();
  let n = 1;
  while (proj.parts.some((p) => p.id === pre + n)) n++;
  proj.parts.push({ id: pre + n, type, x, y, rot: 0, props: JSON.parse(JSON.stringify(d.props || {})) });
}

// Blink, then the crowded drop the lab used: four LEDs released on Blink's LED,
// then palette clicks at the fitted view centre until the board holds 9 LEDs and 5 resistors.
function crowdedBlink() {
  const proj = Examples.EX.blink();
  for (let i = 0; i < 4; i++) {
    const at = Parts.placeDroppedPart(proj.parts, 'led', 293, 116, 0);
    add(proj, 'led', at.x, at.y);
  }
  const aim = { x: 320, y: 90 };
  const n = (type) => proj.parts.filter((p) => p.type === type).length;
  let guard = 0;
  while ((n('led') < 9 || n('resistor') < 5) && guard++ < 30) {
    const type = n('led') < 9 ? 'led' : 'resistor';
    const at = Parts.placeOnEmptyStrips(proj.parts, type, aim.x, aim.y, 0);
    add(proj, type, at.x, at.y);
  }
  return proj;
}

test('Blink plus four drops and click-adds lists 16 components', () => {
  const proj = crowdedBlink();
  const rows = Bom.list(proj);
  const byKey = Object.fromEntries(rows.map((e) => [e.key, e.qty]));
  assert.equal(proj.parts.filter((p) => p.type === 'led').length, 9);
  assert.equal(proj.parts.filter((p) => p.type === 'resistor').length, 5);
  assert.deepEqual(byKey, { bb: 1, esp32: 1, r220: 5, ledred: 9, jw: 1 });
  assert.equal(Bom.componentCount(rows), 16);
  const origins = proj.parts.map((p) => p.type + '@' + p.x + ',' + p.y);
  assert.equal(new Set(origins).size, origins.length, 'no stacked duplicate ' + origins.join(' '));
  assert.ok(proj.parts.every((p) => p.id !== '_seat' && p.id !== '_new'));
});

test('a board that already has an ESP32 and a breadboard does not gain a second of each', () => {
  const proj = Examples.EX.blink();
  const esp = Bom.CATALOG.esp32, bb = Bom.CATALOG.breadboard;
  Bom.CATALOG.esp32 = () => ({ key: 'esp32-devkit', name: 'ESP32 dev board', q: 'ESP32' });
  Bom.CATALOG.breadboard = () => ({ key: 'bb-830', name: 'Breadboard, 830 tie-points', q: 'breadboard' });
  try {
    const rows = Bom.list(proj);
    assert.equal(Bom.componentCount(rows), 4);
    assert.equal(rows.filter((e) => e.key === 'esp32' || e.key === 'bb').length, 0);
  } finally {
    Bom.CATALOG.esp32 = esp; Bom.CATALOG.breadboard = bb;
  }
});

test('placement probes and a repeated part id are not extra components', () => {
  const proj = Examples.EX.blink();
  const esp = proj.parts.find((p) => p.type === 'esp32');
  const board = proj.parts.find((p) => p.type === 'breadboard');
  proj.parts.push(esp, board, { id: '_seat', type: 'led', x: 0, y: 0, rot: 0, props: { color: 'red' } });
  assert.equal(Bom.componentCount(Bom.list(proj)), 4);
});

function fakeEl() { return { innerHTML: '', querySelector() { return {}; } }; }
function headerCount(el) {
  const m = el.innerHTML.match(/(\d+) components \+ jumper wires/);
  assert.ok(m, el.innerHTML.slice(0, 180));
  return +m[1];
}

test('an open parts list refreshes on add and on delete', () => {
  const proj = Examples.EX.blink();
  const el = fakeEl();
  Bom.render(el, proj);
  assert.equal(headerCount(el), 4);
  proj.parts.push({ id: 'LED9', type: 'led', x: 400, y: 80, rot: 0, props: { color: 'red', vf: 1.9, imax: 0.03 } });
  assert.equal(Bom.sync(el, proj, false), false);
  assert.equal(headerCount(el), 4);
  assert.equal(Bom.sync(el, proj, true), true);
  assert.equal(headerCount(el), 5);
  proj.parts = proj.parts.filter((p) => p.id !== 'LED9');
  Bom.sync(el, proj, true);
  assert.equal(headerCount(el), 4);
  const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  assert.match(app, /changed: \(topo\) => \{[\s\S]*?Bom\.sync\(document\.getElementById\('bomView'\), app\.proj\)/);
});
