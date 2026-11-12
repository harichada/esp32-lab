// Pinch zoom: the world point under the finger midpoint stays put, the scale
// clamps, and a second finger undoes a wire or a part drag.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { WEB } = require('./tools/load-parts');
const Pinch = require(path.join(WEB, 'js/pinch.js'));

function viewAt(anchor, mid, dist, rect) {
  return Pinch.applyView(anchor, mid, dist, rect, { min: 0.15, max: 4 });
}
function world(view, client, rect) {
  return Pinch.worldAt(view, client, rect);
}

test('pinch keeps the world point under the midpoint while zooming', () => {
  const rect = { left: 10, top: 20, width: 390, height: 700 };
  const start = { x: -40, y: 80, s: 1 };
  const mid0 = { x: 180, y: 360 };
  const anchorWorld = world(start, mid0, rect);
  const anchor = { s: start.s, dist: 80, wx: anchorWorld.x, wy: anchorWorld.y };
  const zoomed = viewAt(anchor, mid0, 200, rect);
  assert.ok(Math.abs(zoomed.s - 2.5) < 1e-9);
  const back = world(zoomed, mid0, rect);
  assert.ok(Math.abs(back.x - anchorWorld.x) < 1e-6);
  assert.ok(Math.abs(back.y - anchorWorld.y) < 1e-6);
});

test('two-finger pan keeps that same world point under the moving midpoint', () => {
  const rect = { left: 0, top: 0, width: 400, height: 800 };
  const start = { x: 20, y: -15, s: 1.25 };
  const mid0 = { x: 140, y: 300 };
  const anchorWorld = world(start, mid0, rect);
  const anchor = { s: start.s, dist: 90, wx: anchorWorld.x, wy: anchorWorld.y };
  const mid1 = { x: mid0.x + 48, y: mid0.y - 30 };
  const panned = viewAt(anchor, mid1, 90, rect);
  assert.ok(Math.abs(panned.s - start.s) < 1e-9, 'distance unchanged so scale stays');
  const back = world(panned, mid1, rect);
  assert.ok(Math.abs(back.x - anchorWorld.x) < 1e-6);
  assert.ok(Math.abs(back.y - anchorWorld.y) < 1e-6);
  assert.ok(Math.abs(panned.x - start.x) > 1, 'the view itself scrolls with the fingers');
});

test('zoom and pan together stay anchored, and the scale clamps at both ends', () => {
  const rect = { left: 5, top: 8, width: 375, height: 600 };
  const start = { x: 0, y: 0, s: 1 };
  const mid0 = { x: 100, y: 220 };
  const anchorWorld = world(start, mid0, rect);
  const anchor = { s: 1, dist: 40, wx: anchorWorld.x, wy: anchorWorld.y };
  const mid1 = { x: 160, y: 250 };
  const both = viewAt(anchor, mid1, 100, rect);
  assert.ok(Math.abs(both.s - 2.5) < 1e-9);
  const back = world(both, mid1, rect);
  assert.ok(Math.abs(back.x - anchorWorld.x) < 1e-6);
  assert.ok(Math.abs(back.y - anchorWorld.y) < 1e-6);

  const hi = viewAt(anchor, mid0, 10000, rect);
  assert.equal(hi.s, 4);
  const hiBack = world(hi, mid0, rect);
  assert.ok(Math.abs(hiBack.x - anchorWorld.x) < 1e-6);
  assert.ok(Math.abs(hiBack.y - anchorWorld.y) < 1e-6);

  const lo = viewAt(anchor, mid1, 0.01, rect);
  assert.equal(lo.s, 0.15);
  const loBack = world(lo, mid1, rect);
  assert.ok(Math.abs(loBack.x - anchorWorld.x) < 1e-6);
  assert.ok(Math.abs(loBack.y - anchorWorld.y) < 1e-6);
});

test('the gesture does not move the view until the fingers actually move', () => {
  const rect = { left: 0, top: 40, width: 390, height: 800 };
  const start = { x: -70, y: -700, s: 0.5 };
  const mid = { x: 200, y: 400 };
  const anchorWorld = world(start, mid, rect);
  const anchor = { s: start.s, dist: 70, wx: anchorWorld.x, wy: anchorWorld.y };
  const same = viewAt(anchor, mid, 70, rect);
  assert.equal(same.s, start.s);
  assert.ok(Math.abs(same.x - start.x) < 1e-9);
  assert.ok(Math.abs(same.y - start.y) < 1e-9);
});

function rebuild(target, r, ndc, right, up, fov, aspect) {
  const halfH = r * Math.tan(fov / 2), halfW = halfH * aspect;
  return {
    x: target.x + right.x * ndc.x * halfW + up.x * ndc.y * halfH,
    y: target.y + right.y * ndc.x * halfW + up.y * ndc.y * halfH,
    z: target.z + right.z * ndc.x * halfW + up.z * ndc.y * halfH,
  };
}
function near(a, b) {
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6);
}

test('3D pinch anchors at the finger midpoint and clamps the camera radius', () => {
  const right = { x: 0.8018, y: 0.1002, z: -0.5893 };
  const up = { x: -0.1604, y: 0.9836, z: 0.0810 };
  const fov = 40 * Math.PI / 180, aspect = 390 / 700;
  const target = { x: 30, y: 8, z: -12 };
  const ndc0 = { x: 0.22, y: -0.18 };
  const base = { r0: 280, dist0: 100, ndc0, target, right, up, fov, aspect, minR: 60, maxR: 1400 };
  const held = Pinch.orbit(Object.assign({ dist: 100, ndc: ndc0 }, base));
  assert.ok(Math.abs(held.r - 280) < 1e-9);
  assert.ok(Math.abs(held.target.x - target.x) < 1e-6);
  assert.ok(Math.abs(held.target.y - target.y) < 1e-6);
  assert.ok(Math.abs(held.target.z - target.z) < 1e-6);

  const zoomed = Pinch.orbit(Object.assign({ dist: 250, ndc: ndc0 }, base));
  assert.ok(Math.abs(zoomed.r - 112) < 1e-9);
  near(rebuild(zoomed.target, zoomed.r, ndc0, right, up, fov, aspect), zoomed.world);

  const ndc1 = { x: -0.35, y: 0.4 };
  const panned = Pinch.orbit(Object.assign({ dist: 250, ndc: ndc1 }, base));
  near(rebuild(panned.target, panned.r, ndc1, right, up, fov, aspect), panned.world);
  assert.ok(Math.abs(panned.target.x - target.x) + Math.abs(panned.target.y - target.y) > 1);

  const tiny = Pinch.orbit(Object.assign({ dist: 10000, ndc: ndc0 }, base));
  assert.equal(tiny.r, 60);
  near(rebuild(tiny.target, tiny.r, ndc0, right, up, fov, aspect), tiny.world);
  const far = Pinch.orbit(Object.assign({ dist: 1, ndc: ndc1 }, base));
  assert.equal(far.r, 1400);
  near(rebuild(far.target, far.r, ndc1, right, up, fov, aspect), far.world);
});

// --- editor: second finger cancels a wire or a drag ---
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), id: '', className: '', dataset: {}, style: {}, attrs: {}, childNodes: [], parentElement: null, textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; },
    addEventListener() {}, setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    querySelector(sel) { return find(this, sel); },
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentElement; } return null; },
  };
  node.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  Object.defineProperty(node, 'firstChild', { get() { return node.childNodes[0] || null; } });
  Object.defineProperty(node, 'lastChild', { get() { return node.childNodes[node.childNodes.length - 1] || null; } });
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(v) { node._html = String(v); node.childNodes = []; if (node.id === 'lOver') { node.appendChild(makeEl('g')); node.appendChild(makeEl('g')); } },
  });
  return node;
}
function matches(node, sel) {
  if (!node || typeof node.tagName !== 'string') return false;
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) return (' ' + (node.className || '') + ' ').includes(' ' + sel.slice(1) + ' ');
  if (sel.startsWith('[data-')) {
    const name = sel.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return !!(node.dataset && node.dataset[name] != null && node.dataset[name] !== '');
  }
  return String(node.tagName || '').toLowerCase() === String(sel).toLowerCase();
}
function find(node, sel) {
  if (matches(node, sel)) return node;
  for (const c of node.childNodes || []) { const hit = find(c, sel); if (hit) return hit; }
  return null;
}
const document = {
  createElementNS() { return makeEl('g'); }, createElement(tag) { return makeEl(tag); },
  querySelector() { return null; }, getElementById() { return null; },
};
document.body = makeEl('body');
document.body.classList.contains = () => false;
global.document = document;
global.addEventListener = global.addEventListener || (() => {});
require(path.join(WEB, 'js/editor.js'));
const Editor = global.Editor;

function editor() {
  const svg = makeEl('svg'); svg.id = 'stage';
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  const hint = makeEl('div');
  const wrap = makeEl('div'); wrap.appendChild(svg); wrap.appendChild(hint);
  const ed = new Editor(svg, { changed() {}, selected() {}, hover() {}, beforeEdit() {}, state() { return null; }, running() { return false; }, press() {} });
  ed.view = { x: 0, y: 0, s: 1 };
  ed.setProject({ parts: [{ id: 'R1', type: 'resistor', x: 100, y: 100, rot: 0, props: { r: 220 } }], wires: [] });
  return ed;
}
function partTree() {
  const part = makeEl('g'); part.className = 'part'; part.dataset.id = 'R1';
  const body = makeEl('path'); body.className = 'res-body'; part.appendChild(body);
  const pin1 = makeEl('circle'); pin1.className = 'pin'; pin1.dataset.pin = '1'; part.appendChild(pin1);
  const pin2 = makeEl('circle'); pin2.className = 'pin'; pin2.dataset.pin = '2'; part.appendChild(pin2);
  return { body, pin1, pin2 };
}
function ev(target, x, y) {
  return { button: 0, clientX: x, clientY: y, target, altKey: false, shiftKey: false, pointerType: 'touch', detail: 1 };
}

test('a one-finger body drag moves the part, and the second finger puts it back', () => {
  const ed = editor();
  const { body } = partTree();
  const before = Pinch.cloneSel(ed.sel);
  ed._down(ev(body, 120, 110));
  assert.equal(ed.mode && ed.mode.k, 'drag');
  assert.equal(ed.sel && ed.sel.part, 'R1');
  ed._move(ev(body, 200, 180));
  assert.notEqual(ed.proj.parts[0].x, 100);
  assert.equal(ed.undoS.length, 1);
  const dragged = { x: ed.proj.parts[0].x, y: ed.proj.parts[0].y };
  Pinch.cancelEditorGesture(ed, before);
  assert.equal(ed.mode, null);
  assert.equal(ed.proj.parts[0].x, 100);
  assert.equal(ed.proj.parts[0].y, 100);
  assert.notDeepEqual(dragged, { x: 100, y: 100 });
  assert.equal(ed.undoS.length, 0);
  assert.equal(ed.sel, null);
  assert.equal(ed.proj.wires.length, 0);
  assert.equal(ed.ovWire.innerHTML, '');
});

test('a second finger cancels a wire, even one that has been waiting, and leaves no rubber band', () => {
  const ed = editor();
  const { pin1 } = partTree();
  ed.select({ part: 'R1' });
  const before = Pinch.cloneSel(ed.sel);
  ed._down(ev(pin1, 100, 100));
  assert.equal(ed.mode && ed.mode.k, 'wire');
  ed._move(ev(pin1, 160, 140));
  assert.match(ed.ovWire.innerHTML, /w-preview/);
  ed.mode.t0 = 0;
  Pinch.cancelEditorGesture(ed, before);
  assert.equal(ed.mode, null);
  assert.equal(ed.ovWire.innerHTML, '');
  assert.equal(ed.proj.wires.length, 0);
  assert.equal(ed.proj.parts[0].x, 100);
  assert.deepEqual(ed.sel, { part: 'R1' });
});

test('without a second finger, a body drag keeps the move and a pin still starts a wire', () => {
  const ed = editor();
  const { body, pin1 } = partTree();
  ed._down(ev(body, 120, 110));
  ed._move(ev(body, 200, 180));
  ed._up(ev(body, 200, 180));
  assert.equal(ed.mode, null);
  assert.notEqual(ed.proj.parts[0].x, 100);
  assert.equal(ed.sel && ed.sel.part, 'R1');
  const x = ed.proj.parts[0].x;
  ed._down(ev(pin1, x, ed.proj.parts[0].y));
  assert.equal(ed.mode && ed.mode.k, 'wire');
  assert.match(ed.ovWire.innerHTML, /w-preview/);
  assert.equal(ed.proj.wires.length, 0);
});
