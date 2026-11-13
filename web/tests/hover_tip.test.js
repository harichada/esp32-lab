// Deleting the part under the cursor used to leave its label ('LED1 LED') on screen.
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
    querySelectorAll(sel) { return findAll(this, sel); },
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
  return String(node.tagName || '').toLowerCase() === String(sel).toLowerCase();
}
function find(node, sel) {
  if (matches(node, sel)) return node;
  for (const c of node.childNodes || []) { const hit = find(c, sel); if (hit) return hit; }
  return null;
}
function findAll(node, sel) {
  const out = [];
  (function walk(n) { for (const c of n.childNodes || []) { if (matches(c, sel)) out.push(c); walk(c); } })(node);
  return out;
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
function hoverPart(ed, id) {
  const g = makeEl('g'); g.className = 'part'; g.dataset.id = id;
  const body = makeEl('path'); body.className = 'led-body'; g.appendChild(body);
  ed._move({ clientX: 100, clientY: 80, target: body, pointerType: 'mouse' });
}

test('the hover label hides when that part is deleted, undone away, or the project changes', () => {
  const tip = { hidden: true, textContent: '' };
  const ed = new global.Editor(stage(), {
    beforeEdit() {}, changed() {}, press() {}, selected() {},
    state() { return null; }, running() { return false; },
    hover(h) {
      if (!h || !h.part || h.part.type === 'breadboard') { tip.hidden = true; tip.textContent = ''; return; }
      tip.hidden = false;
      tip.textContent = h.part.id + ' ' + global.Parts.T[h.part.type].label;
    },
  });
  const led = { id: 'LED1', type: 'led', x: 220, y: 90, rot: 0, props: { color: 'red' } };
  ed.setProject({ parts: [led], wires: [] });
  assert.equal(tip.hidden, true);

  hoverPart(ed, 'LED1');
  assert.equal(tip.hidden, false);
  assert.equal(tip.textContent, 'LED1 LED');
  ed.select({ part: 'LED1' });
  ed.deleteSel();
  assert.equal(ed.part('LED1'), undefined);
  assert.equal(tip.hidden, true);
  assert.equal(tip.textContent, '');

  ed.undo();
  assert.equal(ed.part('LED1').type, 'led');
  assert.equal(tip.hidden, true, 'undo does not bring the old label back');
  hoverPart(ed, 'LED1');
  assert.equal(tip.textContent, 'LED1 LED');
  ed.redo();
  assert.equal(ed.part('LED1'), undefined);
  assert.equal(tip.hidden, true);

  ed.undo();
  hoverPart(ed, 'LED1');
  assert.equal(tip.hidden, false);
  ed.setProject({ parts: [], wires: [] });
  assert.equal(tip.hidden, true);
});
