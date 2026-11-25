// Shift inverts the 90° checkbox for the wire being drawn or retargeted.
// The checkbox flag (editor.ortho) is not changed, and there is no second routing mode.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { WEB } = require('./tools/load-parts');

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
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
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
  if (sel.startsWith('.') && (' ' + (node.className || '') + ' ').includes(' ' + sel.slice(1) + ' ')) return node;
  for (const c of node.childNodes || []) { const hit = find(c, sel); if (hit) return hit; }
  return null;
}

const document = {
  documentElement: { dataset: {} },
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

function editor() {
  const svg = makeEl('svg');
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  const wrap = makeEl('div'); wrap.appendChild(svg);
  const ed = new Editor(svg, { changed() {}, selected() {}, hover() {}, beforeEdit() {}, state() { return null; }, running() { return false; }, press() {} });
  ed.view = { x: 0, y: 0, s: 1 };
  ed.wireColor = 'green';
  ed.proj = { parts: [], wires: [] };
  ed.ortho = true;
  ed._shift = false;
  return ed;
}

function finish(ed, ortho, shift, b) {
  ed.ortho = ortho;
  ed._shift = shift;
  ed.mode = { k: 'wire', a: { x: 0, y: 0 }, pts: [], start: null, ptr: { x: b.x, y: b.y } };
  ed._finishWire(b, null);
  return ed.proj.wires[ed.proj.wires.length - 1];
}

test('Shift inverts 90° routing for one new wire and leaves the checkbox flag alone', () => {
  const ed = editor();
  const corner = [{ x: 40, y: 0 }];
  const straight = finish(ed, true, true, { x: 40, y: 20 });
  assert.deepEqual(straight.pts, [], '90° on + Shift is one straight segment');
  assert.deepEqual(straight.a, { x: 0, y: 0 });
  assert.deepEqual(straight.b, { x: 40, y: 20 });
  assert.equal(ed.ortho, true);

  const bent = finish(ed, true, false, { x: 40, y: 20 });
  assert.deepEqual(bent.pts, corner, '90° on without Shift keeps the L');
  assert.equal(ed.ortho, true);

  const forced = finish(ed, false, true, { x: 40, y: 20 });
  assert.deepEqual(forced.pts, corner, '90° off + Shift uses the L');
  assert.equal(ed.ortho, false);

  const open = finish(ed, false, false, { x: 40, y: 20 });
  assert.deepEqual(open.pts, [], '90° off without Shift stays straight');
  assert.equal(ed.ortho, false);

  ed.ortho = true;
  ed._shift = false;
  assert.deepEqual(ed._ortho({ x: 0, y: 0 }, { x: 40, y: 0 }), [{ x: 40, y: 0 }], 'an axis-aligned run never grows a corner');
});

test('Shift while dragging a wire end uses the same inverted route', () => {
  const ed = editor();
  const w = { id: 'w1', a: { x: 0, y: 0 }, b: { x: 40, y: 20 }, pts: [{ x: 40, y: 0 }], color: 'green' };
  ed.proj.wires.push(w);
  ed.ortho = true;
  ed.mode = { k: 'end', w, end: 'b', moved: false, ptr: { x: 30, y: 50 } };
  ed._shift = true;
  ed._dragEnd({ x: 30, y: 50 });
  assert.deepEqual(w.b, { x: 30, y: 50 });
  assert.deepEqual(w.pts, [], 'Shift drops the corner while the end moves');
  assert.equal(ed.ortho, true);
  ed._shift = false;
  ed.mode = { k: 'end', w, end: 'b', moved: false, ptr: { x: 50, y: 20 } };
  ed._dragEnd({ x: 50, y: 20 });
  assert.deepEqual(w.b, { x: 50, y: 20 });
  assert.deepEqual(w.pts, [{ x: 50, y: 0 }], 'releasing Shift routes the same end at 90°');
  assert.equal(ed.ortho, true);
});

test('pressing Shift during a wire redraws with the inverted route and does not stick', () => {
  const ed = editor();
  ed.ortho = true;
  ed.mode = { k: 'wire', a: { x: 0, y: 0 }, pts: [], start: null, ptr: { x: 40, y: 20 } };
  ed._shiftGesture({ key: 'Shift', type: 'keydown' });
  assert.equal(ed._shift, true);
  assert.match(ed.ovWire.innerHTML, /0,0 40,20/);
  assert.doesNotMatch(ed.ovWire.innerHTML, /40,0/);
  ed._shiftGesture({ key: 'Shift', type: 'keyup' });
  assert.equal(ed._shift, false);
  assert.equal(ed.ortho, true);
  assert.match(ed.ovWire.innerHTML, /0,0 40,0 40,20/);
});
