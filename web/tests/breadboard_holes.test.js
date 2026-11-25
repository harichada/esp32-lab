// Studio Dark paints every on-screen hole at Fit zoom, and a press snaps to the
// nearest hole even when that column was not drawn.
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
function fitRect() {
  const s = 0.96;
  return { x0: -400, y0: -300, x1: -400 + 1600 / s, y1: -300 + 1000 / s, s: s };
}

test('Fit zoom paints every hole column in view, and only zooms under 3px thin them', () => {
  const board = { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 63 } };
  const rect = fitRect();
  const view = P.bbViewFor(board, rect);
  const wide = (view.span.c1 - view.span.c0 + 1) * (view.span.b1 - view.span.b0 + 1) * 14;
  assert.ok(Math.ceil(wide / 1800) > 1, 'this viewport used to skip columns under the 1800 cap');
  assert.equal(view.step, 1, 'holes are still a few pixels apart, so every column is drawn');
  global._bbPaint = { id: 'bb', span: view.span, hole: view.hole, step: view.step };
  let svg = '';
  try { svg = P.T.breadboard.svg(board); }
  finally { global._bbPaint = null; }
  const painted = colsIn(svg, 'a');
  for (let c = 1; c <= 63; c++) assert.ok(painted.has(c), 'column ' + c + ' is painted at Fit zoom');

  const far = P.bbViewFor(board, { x0: -2000, y0: -2000, x1: 4000, y1: 4000, s: 0.2 });
  assert.ok(far.step > 1, 'below ~3px per column, hole detail can drop');
  global._bbPaint = { id: 'bb', span: far.span, hole: far.hole, step: far.step };
  try { svg = P.T.breadboard.svg(board); }
  finally { global._bbPaint = null; }
  const thin = colsIn(svg, 'a');
  const visible = [];
  for (let c = far.hole.c0; c <= far.hole.c1; c++) if (c >= 1 && c <= 63) visible.push(c);
  const kept = visible.filter((c) => thin.has(c));
  assert.ok(visible.length > kept.length, 'off-pitch columns are not all painted when the dots would merge');
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
function down(ed, target, x, y, extra) {
  const s = ed.view.s;
  ed._down(Object.assign({
    button: 0, clientX: x * s, clientY: y * s, target: target,
    altKey: false, shiftKey: false, pointerType: 'mouse', detail: 1,
  }, extra));
}

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

test('a press near an unpainted hole snaps to it, and Shift still inverts 90°', () => {
  const ed = editor({ state: false });
  const board = plastic();
  const s = ed.view.s;
  const hole = P.bbNearest(ed.proj.parts[0], 20, 40);
  assert.equal(hole.name, 'a2');
  // 4 screen px off the hole, still on the plastic, with Shift already held.
  down(ed, board, hole.x + 4 / s, hole.y, { shiftKey: true });
  assert.equal(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.mode.start.pin.name, 'a2');
  assert.equal(ed._shift, true);
  assert.equal(ed.ortho, true);
  ed._drawWirePreview({ x: 60, y: 80 });
  assert.match(ed.ovWire.innerHTML, /20,40 60,80/);
  assert.doesNotMatch(ed.ovWire.innerHTML, /60,40/);
  ed.cancelWire();

  // The channel between the row groups is farther than a few screen px from any hole.
  down(ed, board, 10, 97);
  assert.equal(ed.mode && ed.mode.k, 'pan');
  assert.equal(ed.proj.wires.length, 0);
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
