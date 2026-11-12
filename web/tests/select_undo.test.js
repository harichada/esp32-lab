// Body clicks select a part (they must not start a wire). Undo chords match z/Z and y/Y,
// Ctrl/Cmd+Shift+Z redoes, and a value field keeps native text undo.
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
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; },
    remove() {
      const p = this.parentElement; if (!p) return;
      const i = p.childNodes.indexOf(this); if (i >= 0) p.childNodes.splice(i, 1);
      this.parentElement = null;
    },
    addEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    focus(opts) { this._focus = opts || {}; document.activeElement = this; },
    blur() { if (document.activeElement === this) document.activeElement = document.body; },
    querySelector(sel) { return find(this, sel); },
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

const classes = new Set();
const document = {
  activeElement: null,
  createElementNS(_ns, tag) { return makeEl(tag); },
  createElement(tag) { return makeEl(tag); },
  querySelector() { return null; },
  getElementById() { return null; },
};
document.body = makeEl('body');
document.body.classList.contains = (c) => classes.has(c);
global.document = document;
global.addEventListener = global.addEventListener || (() => {});

require(path.join(WEB, 'js/editor.js'));
const Editor = global.Editor;

function stage() {
  const hint = makeEl('div'); hint.className = 'hint';
  const wrap = makeEl('div');
  const svg = makeEl('svg'); svg.id = 'stage';
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  wrap.appendChild(svg); wrap.appendChild(hint);
  return { svg, hint };
}
function editor() {
  const { svg, hint } = stage();
  const ed = new Editor(svg, {
    changed() {}, selected() {}, hover() {}, beforeEdit() {}, state() { return null; },
    running() { return false; }, press() {},
  });
  ed.view = { x: 0, y: 0, s: 1 };
  ed.setProject({ parts: [{ id: 'R1', type: 'resistor', x: 100, y: 100, rot: 0, props: { r: 220 } }], wires: [] });
  return { ed, hint };
}
function partTree() {
  const part = makeEl('g'); part.className = 'part'; part.dataset.id = 'R1';
  const body = makeEl('path'); body.className = 'res-body'; part.appendChild(body);
  const pin1 = makeEl('circle'); pin1.className = 'pin'; pin1.dataset.pin = '1'; part.appendChild(pin1);
  const pin2 = makeEl('circle'); pin2.className = 'pin'; pin2.dataset.pin = '2'; part.appendChild(pin2);
  return { part, body, pin1, pin2 };
}
function ev(target, x, y, extra) {
  return Object.assign({ button: 0, clientX: x, clientY: y, target, altKey: false, shiftKey: false, pointerType: 'mouse', detail: 1 }, extra);
}
// Same order as the keydown handler in app.js: a value field returns before the chord runs.
function dispatch(ed, e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return 'native';
  const chord = Editor.editChord(e);
  if (chord === 'undo') { ed.undo(); return 'undo'; }
  if (chord === 'redo') { ed.redo(); return 'redo'; }
  return null;
}

test('a click on a part body selects it and does not start a wire', () => {
  const { ed } = editor();
  const { body } = partTree();
  // 4 units from pin 1: inside the old body snap radius, so this used to begin a wire.
  const near = ed.pinNear({ x: 104, y: 100 }, { pointerType: 'mouse' }, 5);
  assert.equal(near && near.pin.name, '1');
  const down = ev(body, 104, 100);
  assert.equal(ed.pinAtEvent(down), null);
  ed._down(down);
  assert.equal(ed.sel && ed.sel.part, 'R1');
  assert.notEqual(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.proj.wires.length, 0);
  ed._up(down);
  assert.equal(ed.mode, null);
  assert.equal(ed.sel.part, 'R1');
  assert.equal(ed.proj.wires.length, 0);
});

test('a touch on a part body selects it and does not start a wire', () => {
  const { ed } = editor();
  const { body } = partTree();
  ed._down(ev(body, 103, 100, { pointerType: 'touch' }));
  assert.equal(ed.sel && ed.sel.part, 'R1');
  assert.notEqual(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.proj.wires.length, 0);
});

test('tap a pin, then another pin, to wire — and a drag from a pin finishes on release', () => {
  const { ed } = editor();
  const { pin1, pin2 } = partTree();
  const empty = makeEl('rect');
  ed._down(ev(empty, 100, 100));
  assert.equal(ed.mode && ed.mode.k, 'wire', 'a press on the pin position still starts a wire');
  ed.cancelWire();
  ed._down(ev(pin1, 100, 100));
  assert.equal(ed.mode && ed.mode.k, 'wire');
  assert.equal(ed.proj.wires.length, 0);
  ed._down(ev(pin2, 140, 100));
  assert.equal(ed.proj.wires.length, 1);
  assert.equal(ed.mode, null);
  const { pin1: a, pin2: b } = partTree();
  ed._down(ev(a, 100, 100));
  ed._up(ev(b, 140, 100));
  assert.equal(ed.proj.wires.length, 2);
  assert.equal(ed.mode, null);
});

test('a body click while wiring selects the part instead of landing the wire', () => {
  const { ed } = editor();
  const { body, pin1 } = partTree();
  ed._down(ev(pin1, 100, 100));
  assert.equal(ed.mode.k, 'wire');
  ed._down(ev(body, 120, 96));
  assert.equal(ed.proj.wires.length, 0);
  assert.equal(ed.sel && ed.sel.part, 'R1');
  assert.notEqual(ed.mode && ed.mode.k, 'wire');
});

test('hint bar tells you to select a part, then wire from pins', () => {
  const { ed, hint } = editor();
  ed.setHint();
  assert.match(hint.textContent, /Click a part to select it\. Click a pin, then another pin, to wire/);
  classes.add('m');
  try {
    ed.setHint();
    assert.equal(hint.textContent, 'Tap a part to select it. Tap a pin, then another pin, to wire');
  } finally { classes.delete('m'); }
});

test('undo matches z/Z and y/Y, Shift+Z redoes, and a value field is left alone', () => {
  const page = { tagName: 'BODY' };
  assert.equal(Editor.editChord({ key: 'z', ctrlKey: true, target: page }), 'undo');
  assert.equal(Editor.editChord({ key: 'Z', ctrlKey: true, target: page }), 'undo');
  assert.equal(Editor.editChord({ key: 'z', metaKey: true, target: page }), 'undo');
  assert.equal(Editor.editChord({ key: 'Z', metaKey: true, shiftKey: true, target: page }), 'redo');
  assert.equal(Editor.editChord({ key: 'z', ctrlKey: true, shiftKey: true, code: 'KeyZ', target: page }), 'redo');
  assert.equal(Editor.editChord({ key: 'y', ctrlKey: true, target: page }), 'redo');
  assert.equal(Editor.editChord({ key: 'Y', metaKey: true, target: page }), 'redo');
  assert.equal(Editor.editChord({ key: 'z', target: page }), null);
  assert.equal(Editor.editChord({ key: 'r', ctrlKey: true, target: page }), null);
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const field = { tagName: tag };
    assert.equal(Editor.editChord({ key: 'z', ctrlKey: true, target: field }), null);
    assert.equal(Editor.editChord({ key: 'Z', ctrlKey: true, shiftKey: true, target: field }), null);
    assert.equal(Editor.editChord({ key: 'y', metaKey: true, target: field }), null);
  }
});

test('after delete, focus returns to the canvas so Ctrl+Z undoes it; typing does not', () => {
  const { ed } = editor();
  const field = { tagName: 'INPUT', blur() { if (document.activeElement === this) document.activeElement = document.body; } };
  document.activeElement = field;
  ed.select({ part: 'R1' });
  ed.push();
  ed.proj.parts[0].x = 999;
  assert.equal(dispatch(ed, { key: 'z', ctrlKey: true, target: field }), 'native');
  assert.equal(ed.proj.parts[0].x, 999, 'native text undo must not move the part');
  ed.deleteSel();
  assert.equal(ed.proj.parts.length, 0);
  assert.equal(document.activeElement, ed.svg);
  assert.equal(dispatch(ed, { key: 'Z', ctrlKey: true, target: document.activeElement }), 'undo');
  assert.equal(ed.proj.parts.length, 1);
  assert.equal(ed.proj.parts[0].id, 'R1');
  assert.equal(dispatch(ed, { key: 'Z', ctrlKey: true, shiftKey: true, target: ed.svg }), 'redo');
  assert.equal(ed.proj.parts.length, 0);
  assert.equal(dispatch(ed, { key: 'z', metaKey: true, target: ed.svg }), 'undo');
  assert.equal(ed.proj.parts.length, 1);
});
