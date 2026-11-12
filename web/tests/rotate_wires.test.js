// Rotate must keep wires on the pins they were attached to. The tester's circuit
// is GPIO2 -> 220Ω -> LED -> GND. One press of R used to leave the wire ends on
// the old pin coordinates, so the next run left the LED dark with no warning.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WEB, Parts: P, Sim, Netlist } = require('./tools/load-parts');

function pinAt(part, name) {
  return P.pinWorld(part, P.T[part.type].pins(part).find((q) => q.name === name));
}
function copy(pt) { return { x: pt.x, y: pt.y }; }
function groups(proj) {
  return Netlist.extract(proj).nets.map((n) => n.pins.slice().sort().join(',')).sort();
}
function key(x, y) { return Math.round(x) + ',' + Math.round(y); }
function attached(proj, part) {
  const at = new Map();
  for (const pin of P.T[part.type].pins(part)) {
    const w = P.pinWorld(part, pin);
    const k = key(w.x, w.y);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(pin.name);
  }
  const hits = [];
  for (const w of proj.wires) {
    for (const end of ['a', 'b']) {
      const names = at.get(key(w[end].x, w[end].y));
      if (names) hits.push({ id: w.id, end, name: names[0] });
    }
  }
  return hits;
}
function ledCurrent(proj) {
  const sim = new Sim(proj);
  const esp = proj.parts.find((p) => p.type === 'esp32');
  const led = proj.parts.find((p) => p.type === 'led');
  const rt = sim.espRuntime(esp);
  rt.pinMode(2, 'OUTPUT'); rt.write(2, 1); sim.advance(0.01);
  return sim.partState(led).i;
}

function DomNode() {
  this.attrs = {}; this.dataset = {}; this.children = []; this.style = {}; this.className = '';
  this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
}
DomNode.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); };
DomNode.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; };
DomNode.prototype.appendChild = function (c) { this.children.push(c); return c; };
Object.defineProperty(DomNode.prototype, 'innerHTML', { set() { this.children = []; }, get() { return ''; } });
DomNode.prototype.querySelector = function () { return null; };
DomNode.prototype.querySelectorAll = function () { return []; };
DomNode.prototype.addEventListener = function () {};
DomNode.prototype.getBoundingClientRect = function () { return { width: 800, height: 600, left: 0, top: 0 }; };
DomNode.prototype.remove = function () {};

function editorHarness() {
  const g = globalThis;
  g.window = g;
  g.addEventListener = () => {};
  g.document = {
    body: { classList: { contains: () => false } },
    createElementNS: () => new DomNode(),
    getElementById: () => null,
    addEventListener: () => {},
  };
  delete g.ResizeObserver;
  require('../js/editor.js');
  const layers = { '#lParts': new DomNode(), '#lWires': new DomNode(), '#lOver': new DomNode() };
  const svg = new DomNode();
  svg.querySelector = (sel) => layers[sel] || null;
  svg.parentElement = new DomNode();
  const box = { hidden: true, text: '' };
  const ed = new g.Editor(svg, {
    beforeEdit() {}, changed() {}, selected() {}, hover() {},
    state() { return null; }, running() { return false; }, press() {},
    warnings(list) {
      box.hidden = !list.length;
      box.text = list.map((x) => (x.id ? x.id + ' ' : '') + x.msg).join('\n');
    },
  });
  return { ed, box };
}

// GPIO2 -> 220Ω -> LED anode, LED cathode -> GND. No shared junctions.
function blink() {
  const esp = { id: 'ESP1', type: 'esp32', x: 0, y: 0, rot: 0, props: { power: 'usb' } };
  const r = { id: 'R1', type: 'resistor', x: 120, y: 90, rot: 0, props: { r: 220 } };
  const led = { id: 'LED1', type: 'led', x: 220, y: 90, rot: 0, props: { color: 'red', vf: 1.9, imax: 0.03 } };
  const wires = [
    { id: 'w1', a: copy(pinAt(esp, 'D2')), b: copy(pinAt(r, '1')), color: 'yellow' },
    { id: 'w2', a: copy(pinAt(r, '2')), b: copy(pinAt(led, 'A')), color: 'green' },
    { id: 'w3', a: copy(pinAt(led, 'C')), b: copy(pinAt(esp, 'GND.1')), color: 'black' },
  ];
  return { parts: [esp, r, led], wires };
}

test('GPIO2 -> 220R -> LED -> GND: one rotate keeps the wires, the netlist and the LED current', () => {
  const { ed, box } = editorHarness();
  const proj = blink();
  ed.setProject(proj);
  const beforeNets = groups(proj);
  const beforeI = ledCurrent(proj);
  assert.ok(beforeI > 0.004, 'LED lights before rotate, i=' + beforeI);
  const led = () => ed.part('LED1');
  ed.select({ part: 'LED1' });
  const snap = JSON.parse(JSON.stringify({ rot: led().rot, wires: proj.wires }));
  ed.rotateSel();
  assert.equal(led().rot, 1);
  assert.equal(ed.warnings.length, 0);
  assert.equal(box.hidden, true);
  for (const hit of attached(proj, led())) {
    const w = proj.wires.find((q) => q.id === hit.id);
    assert.deepEqual(w[hit.end], copy(pinAt(led(), hit.name)), hit.id + ' ' + hit.end + ' follows ' + hit.name);
  }
  assert.deepEqual(groups(proj), beforeNets);
  const afterI = ledCurrent(proj);
  assert.ok(afterI > 0.004, 'LED still lights after one rotate, i=' + afterI);
  assert.ok(Math.abs(afterI - beforeI) / beforeI < 0.05, 'current stays with the same circuit, before=' + beforeI + ' after=' + afterI);
  ed.undo();
  assert.equal(led().rot, snap.rot);
  assert.deepEqual(proj.wires, snap.wires);
  assert.deepEqual(groups(proj), beforeNets);
});

test('rotating the same LED two and three times still leaves every wire end on the new pin', () => {
  const { ed } = editorHarness();
  const proj = blink();
  ed.setProject(proj);
  const beforeNets = groups(proj);
  ed.select({ part: 'LED1' });
  for (let n = 1; n <= 3; n++) {
    ed.rotateSel();
    assert.equal(ed.part('LED1').rot, n);
    assert.equal(ed.warnings.length, 0, 'rotate ' + n);
    for (const hit of attached(proj, ed.part('LED1'))) {
      const w = proj.wires.find((q) => q.id === hit.id);
      assert.deepEqual(w[hit.end], copy(pinAt(ed.part('LED1'), hit.name)));
    }
    assert.deepEqual(groups(proj), beforeNets);
  }
  ed.undo(); ed.undo(); ed.undo();
  assert.equal(ed.part('LED1').rot, 0);
  assert.deepEqual(groups(proj), beforeNets);
});

test('a wire that shares its point with another part stays put and a warning is shown', () => {
  const { ed, box } = editorHarness();
  const esp = { id: 'ESP1', type: 'esp32', x: 0, y: 0, rot: 0, props: { power: 'usb' } };
  const r = { id: 'R1', type: 'resistor', x: 120, y: 90, rot: 0, props: { r: 220 } };
  const led = { id: 'LED1', type: 'led', x: 220, y: 90, rot: 0, props: { color: 'red', vf: 1.9 } };
  const cathode = pinAt(led, 'C');
  const gnd = { id: 'GND1', type: 'ground', x: cathode.x, y: cathode.y, rot: 0, props: {} };
  const proj = { parts: [esp, r, led, gnd], wires: [
    { id: 'w1', a: copy(pinAt(esp, 'D2')), b: copy(pinAt(r, '1')), color: 'yellow' },
    { id: 'w2', a: copy(pinAt(r, '2')), b: copy(pinAt(led, 'A')), color: 'green' },
    { id: 'w3', a: copy(cathode), b: copy(pinAt(esp, 'GND.1')), color: 'black' },
  ] };
  ed.setProject(proj);
  const stuck = copy(proj.wires[2].a);
  ed.select({ part: 'LED1' });
  ed.rotateSel();
  assert.deepEqual(proj.wires[2].a, stuck, 'shared endpoint is not dragged off the other part');
  assert.deepEqual(proj.wires[1].b, copy(pinAt(ed.part('LED1'), 'A')), 'the free anode wire still follows');
  assert.ok(ed.warnings.length >= 1);
  assert.equal(box.hidden, false);
  assert.match(box.text, /w3/);
  assert.match(box.text, /cannot follow/);
  assert.match(box.text, /GND1/);
  const appjs = fs.readFileSync(path.join(WEB, 'js/app.js'), 'utf8');
  assert.match(appjs, /editor\.warnings/);
  assert.match(appjs, /#warnBox/);
});
