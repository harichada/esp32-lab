// Studio Dark: one classic board, wires from holes and canvas dots, and drags that pan.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { WEB, Parts: P } = require('./tools/load-parts');

function colsIn(svg, row) {
  const found = new Set();
  const re = new RegExp('data-pin="' + row + '(-?\\d+)"', 'g');
  let m;
  while ((m = re.exec(svg))) found.add(+m[1]);
  return found;
}
test('Studio Dark paints one classic board, and canvas dots thin only under 3px', () => {
  const grown = { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 160, c0: 1, c1: 160, b0: 0, b1: 2 } };
  assert.equal(P.bbShown(grown).plain, true);
  assert.equal(P.bbHoleStep(0.96), 1);
  assert.ok(P.bbHoleStep(0.2) > 1, 'below ~3px per column, dot detail can drop');
  const svg = P.T.breadboard.svg(grown);
  const painted = colsIn(svg, 'a');
  for (let c = 1; c <= 63; c++) assert.ok(painted.has(c), 'column ' + c + ' of the one board is painted');
  assert.equal(painted.has(100), false);
  assert.doesNotMatch(svg, /data-pin="a1@/);
  assert.match(svg, /width="642"/);
});

function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: {},
    attrs: {},
    childNodes: [],
    parentElement: null,
    textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; },
    addEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; },
    querySelector(sel) { return find(this, sel); },
    closest() { return null; },
  };
  node.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(v) {
      node._html = String(v);
      node.childNodes = [];
      if (node.id === 'lOver') { node.appendChild(makeEl('g')); node.appendChild(makeEl('g')); }
    },
  });
  Object.defineProperty(node, 'firstChild', { get() { return node.childNodes[0] || null; } });
  Object.defineProperty(node, 'lastChild', { get() { return node.childNodes[node.childNodes.length - 1] || null; } });
  return node;
}
function find(node, sel) {
  if (!node) return null;
  if (sel.startsWith('#') && node.id === sel.slice(1)) return node;
  for (const c of node.childNodes || []) { const hit = find(c, sel); if (hit) return hit; }
  return null;
}

const document = {
  documentElement: { dataset: { ui: '3' } },
  createElementNS() { return makeEl('g'); },
  createElement(tag) { return makeEl(tag); },
  querySelector() { return null; },
  getElementById() { return null; },
  addEventListener() {},
};
document.body = makeEl('body');
document.body.classList.contains = () => false;
global.document = document;
global.window = global;
global.addEventListener = global.addEventListener || (() => {});
require(path.join(WEB, 'js/editor.js'));
const Editor = global.Editor;

function editor(running) {
  const svg = makeEl('svg');
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  const wrap = makeEl('div'); wrap.appendChild(svg);
  const ed = new Editor(svg, {
    changed() {}, selected() {}, hover() {}, beforeEdit() {}, state() { return null; },
    running() { return !!running.state; }, press() {},
  });
  ed.view = { x: 0, y: 0, s: 0.96 };
  ed.ortho = true;
  ed.proj = { parts: [{ id: 'bb1', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 63 } }], wires: [] };
  return ed;
}
function plastic() {
  const part = makeEl('g');
  part.className = 'part';
  part.dataset.id = 'bb1';
  const body = makeEl('rect');
  body.className = 'bb-body';
  body.closest = (sel) => (sel === '.part' ? part : null);
  return body;
}
function pointer(ed, target, x, y, extra) {
  const s = ed.view.s;
  return Object.assign({
    button: 0, clientX: x * s, clientY: y * s, target: target,
    altKey: false, shiftKey: false, pointerType: 'mouse', detail: 1,
  }, extra);
}
function down(ed, target, x, y, extra) { ed._down(pointer(ed, target, x, y, extra)); }
function move(ed, target, x, y, extra) { ed._move(pointer(ed, target, x, y, extra)); }
function up(ed, target, x, y, extra) { ed._up(pointer(ed, target, x, y, extra)); }

test('a press at Fit zoom starts a wire on every column, including ones the old cap skipped', () => {
  const ed = editor({ state: false });
  const board = plastic();
  for (let c = 1; c <= 24; c++) {
    const x = 10 + (c - 1) * 10;
    down(ed, board, x, 40);
    assert.equal(ed.mode && ed.mode.k, 'wire', 'column ' + c + ' starts a wire');
    assert.equal(ed.mode.start.pin.name, 'a' + c);
    assert.equal(ed.ortho, true);
    ed.cancelWire();
  }
});

test('a click near a hole snaps to it, and Shift still inverts 90°', () => {
  const ed = editor({ state: false });
  const board = plastic();
  const s = ed.view.s;
  const hole = P.bbNearest(ed.proj.parts[0], 20, 40);
  assert.equal(hole.name, 'a2');
  const x = hole.x + 4 / s;
  down(ed, board, x, hole.y);
  assert.equal(ed.mode && ed.mode.k, 'arm', 'a press off the hole mark does not start a wire yet');
  up(ed, board, x, hole.y, { shiftKey: true });
  assert.equal(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.mode.start.pin.name, 'a2');
  assert.equal(ed._shift, true);
  assert.equal(ed.ortho, true);
  ed._drawWirePreview({ x: 60, y: 80 });
  assert.match(ed.ovWire.innerHTML, /20,40 60,80/);
  assert.doesNotMatch(ed.ovWire.innerHTML, /60,40/);
  ed.cancelWire();

  // The channel is farther than the snap radius, so a click does not invent a hole.
  down(ed, board, 10, 97);
  up(ed, board, 10, 97);
  assert.notEqual(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.proj.wires.length, 0);
});

test('a mouse drag on the board pans, and a touch drag at 55% zoom pans', () => {
  const ed = editor({ state: false });
  const board = plastic();
  const hole = P.bbNearest(ed.proj.parts[0], 20, 40);
  down(ed, board, hole.x + 4 / ed.view.s, hole.y);
  assert.equal(ed.mode.k, 'arm');
  move(ed, board, hole.x + 4 / ed.view.s + 7 / ed.view.s, hole.y);
  assert.equal(ed.mode.k, 'pan');
  assert.notEqual(ed.view.x, 0);
  assert.equal(ed.proj.wires.length, 0);
  ed.mode = null;
  ed._clearArm();

  ed.view = { x: 0, y: 0, s: 0.55 };
  down(ed, board, 15, 40, { pointerType: 'touch' });
  assert.equal(ed.mode.k, 'arm', 'the gap between holes is not an exact hit');
  move(ed, board, 15 + 10 / ed.view.s, 40, { pointerType: 'touch' });
  assert.equal(ed.mode.k, 'pan');
  assert.equal(ed.proj.wires.length, 0);

  ed.view = { x: 0, y: 0, s: 0.96 };
  ed.mode = null;
  down(ed, board, hole.x, hole.y);
  assert.equal(ed.mode.k, 'wire', 'a press on the hole itself still starts a wire');
  move(ed, board, hole.x + 30, hole.y);
  assert.equal(ed.mode.k, 'wire');
  ed.cancelWire();
});

test('a press on a canvas dot starts a wire, and a drag on the empty canvas pans', () => {
  const ed = editor({ state: false });
  const canvas = makeEl('rect');
  down(ed, canvas, 1000, 400);
  assert.equal(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.mode.a.x, 1000);
  assert.equal(ed.mode.a.y, 400);
  assert.equal(ed.mode.start.dot, true);
  ed.cancelWire();

  down(ed, canvas, 1005, 400, { pointerType: 'touch' });
  assert.equal(ed.mode.k, 'arm');
  move(ed, canvas, 1005 + 12 / ed.view.s, 400, { pointerType: 'touch' });
  assert.equal(ed.mode.k, 'pan');
  ed._clearArm();
});

test('while the sim is running, a press on a wire that sits on a part body selects the part', () => {
  const run = { state: true };
  const ed = editor(run);
  ed.proj.parts.push({ id: 'R1', type: 'resistor', x: 200, y: 200, rot: 0, props: { r: 220 } });
  ed.proj.wires.push({ id: 'w1', a: { x: 200, y: 200 }, b: { x: 240, y: 200 }, pts: [], color: 'green' });
  const wire = makeEl('g');
  wire.className = 'wire';
  wire.dataset.wid = 'w1';
  wire.closest = (sel) => (sel === '.wire' ? wire : null);
  down(ed, wire, 220, 202);
  assert.equal(ed.sel && ed.sel.part, 'R1');
  assert.notEqual(ed.sel && ed.sel.wire, 'w1');
  ed.mode = null;
  ed.sel = null;
  run.state = false;
  down(ed, wire, 220, 202);
  assert.equal(ed.sel && ed.sel.wire, 'w1');
});

test('while the sim is running, a wire over the LED dome selects the LED', () => {
  const ed = editor({ state: true });
  ed.proj.parts.push({ id: 'D1', type: 'led', x: 400, y: 400, rot: 0, props: { color: 'red', vf: 1.9, imax: 0.03 } });
  const box = P.gfxBox(ed.proj.parts[1]);
  assert.ok(box && box.y < 400 - 12, 'the dome sits above the pin box');
  ed.proj.wires.push({ id: 'w1', a: { x: 390, y: 382 }, b: { x: 420, y: 382 }, pts: [], color: 'green' });
  const wire = makeEl('g');
  wire.className = 'wire';
  wire.dataset.wid = 'w1';
  wire.closest = (sel) => (sel === '.wire' ? wire : null);
  down(ed, wire, 405, 382);
  assert.equal(ed.sel && ed.sel.part, 'D1');
  assert.notEqual(ed.sel && ed.sel.wire, 'w1');
});
