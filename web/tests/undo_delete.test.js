// After undo, part objects are new. The tester then clicked the LED: the
// Inspector stayed on the resistor, and Delete removed the resistor.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

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
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; },
    remove() {},
    addEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    querySelector(sel) { return find(this, sel); },
    querySelectorAll() { return []; },
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentElement; } return null; },
  };
  node.classList = { toggle() {}, add() {}, remove() {}, contains(c) { return (' ' + node.className + ' ').includes(' ' + c + ' '); } };
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
  if (matches(node, sel)) return node;
  for (const c of node.childNodes || []) { const hit = find(c, sel); if (hit) return hit; }
  return null;
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

const document = {
  activeElement: null,
  createElementNS(_ns, tag) { return makeEl(tag); },
  createElement(tag) { return makeEl(tag); },
  querySelector() { return null; },
  getElementById() { return null; },
};
document.body = makeEl('body');
document.body.classList.contains = () => false;
global.document = document;
global.window = global;
global.addEventListener = () => {};
delete global.ResizeObserver;
require('./tools/load-parts');
require('../js/editor.js');

function stage() {
  const svg = makeEl('svg');
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  const wrap = makeEl('div'); wrap.appendChild(svg);
  return svg;
}
function harness() {
  let shown = null;
  const ed = new global.Editor(stage(), {
    beforeEdit() {}, changed() {}, hover() {}, press() {},
    state() { return null; }, running() { return false; },
    selected(s) { shown = s && s.part && ed.part(s.part) ? s.part : null; },
    shownPart() { return shown; },
  });
  const r = { id: 'R1', type: 'resistor', x: 120, y: 90, rot: 0, props: { r: 220 } };
  const led = { id: 'LED1', type: 'led', x: 220, y: 90, rot: 0, props: { color: 'red' } };
  ed.setProject({ parts: [r, led], wires: [] });
  return { ed, shown: () => shown, setShown: (id) => { shown = id; } };
}
function clickPart(ed, id) {
  const g = makeEl('g'); g.className = 'part'; g.dataset.id = id; g.setAttribute('data-id', id);
  const body = makeEl('path'); body.className = 'led-body'; g.appendChild(body);
  ed._down({ button: 0, clientX: 220, clientY: 90, target: body, altKey: false, shiftKey: false, pointerType: 'mouse', detail: 1 });
}

test('undo, then click the LED, then Delete removes only the LED the Inspector shows', () => {
  const { ed, shown } = harness();
  ed.select({ part: 'R1' });
  assert.equal(shown(), 'R1');
  const oldLed = ed.part('LED1');
  ed.push();
  oldLed.x = 999;
  ed.mode = { k: 'drag', p: oldLed, ox: oldLed.x, oy: oldLed.y, sx: 0, sy: 0, moved: false };
  ed.undo();
  assert.notEqual(ed.part('LED1'), oldLed, 'undo replaced the part objects');
  assert.equal(ed.mode, null, 'the drag is not still holding the replaced part');
  assert.equal(ed.sel.part, 'R1');
  assert.equal(shown(), 'R1', 'the Inspector is still the resistor until the click');
  clickPart(ed, 'LED1');
  assert.equal(ed.sel.part, 'LED1');
  assert.equal(shown(), 'LED1');
  ed.deleteSel();
  assert.deepEqual(ed.proj.parts.map((p) => p.id), ['R1']);
  assert.equal(ed.sel, null);
  assert.equal(shown(), null);
});

test('Delete of a selection whose part is gone does nothing', () => {
  const { ed } = harness();
  ed.select({ part: 'R1' });
  const ids = ed.proj.parts.map((p) => p.id);
  const depth = ed.undoS.length;
  ed.sel = { part: 'NOPE' };
  ed.deleteSel();
  assert.equal(ed.undoS.length, depth);
  assert.deepEqual(ed.proj.parts.map((p) => p.id), ids);
  assert.equal(ed.sel.part, 'NOPE');
});

test('Delete removes the part shown in the Inspector when that part is not the selection', () => {
  const { ed, setShown } = harness();
  ed.select({ part: 'R1' });
  setShown('LED1');
  ed.deleteSel();
  assert.deepEqual(ed.proj.parts.map((p) => p.id), ['R1']);
  assert.equal(ed.sel, null);
});
