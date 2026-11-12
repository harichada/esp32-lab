// Loading ?ex=remote at 390x844 called Editor.fit from mobile.js before the
// example's fetch finished, so Editor.bounds read parts of an undefined project.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { WEB, Examples } = require('./tools/load-parts');

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
      if (k === 'viewBox') this._viewBox = String(v);
    },
    getAttribute(k) { return k === 'viewBox' ? (this._viewBox || null) : (Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null); },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; },
    remove() {},
    addEventListener() {},
    querySelector(sel) { return find(this, sel); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }; },
  };
  node.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set() { node.childNodes = []; },
  });
  Object.defineProperty(node, 'firstChild', { get() { return node.childNodes[0] || null; } });
  Object.defineProperty(node, 'lastChild', { get() { return node.childNodes[node.childNodes.length - 1] || null; } });
  return node;
}
function matches(node, sel) {
  if (!node || typeof node.tagName !== 'string') return false;
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  return false;
}
function find(node, sel) {
  if (matches(node, sel)) return node;
  for (const c of node.childNodes || []) { const hit = find(c, sel); if (hit) return hit; }
  return null;
}

const classes = new Set();
const document = {
  createElementNS(_ns, tag) { return makeEl(tag); },
  createElement(tag) { return makeEl(tag); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById(id) { return id === 'zoomPct' ? { textContent: '' } : null; },
  addEventListener() {},
};
document.body = makeEl('body');
document.body.classList.contains = (c) => classes.has(c);
global.document = document;
global.window = global;
global.addEventListener = global.addEventListener || (() => {});
global.matchMedia = () => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
delete global.ResizeObserver;

require(path.join(WEB, 'js/pinch.js'));
require(path.join(WEB, 'js/editor.js'));
require(path.join(WEB, 'js/mobile.js'));

function editor() {
  const svg = makeEl('svg'); svg.id = 'stage';
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  const wrap = makeEl('div'); wrap.appendChild(svg);
  return new global.Editor(svg, {
    beforeEdit() {}, changed() {}, selected() {}, hover() {}, press() {},
    state() { return null; }, running() { return false; },
  });
}

test('phone load of ?ex=remote at 390x844 does not fit before the circuit exists', () => {
  const ed = editor();
  assert.equal(ed.proj, undefined);
  assert.doesNotThrow(() => ed.bounds());
  assert.equal(ed.bounds(), null);
  assert.doesNotThrow(() => ed.fit());
  assert.equal(global.Mobile.fitIfReady(ed, true), false);
  assert.equal(ed._autoFit, undefined);
});

test('once ?ex=remote is loaded the 390x844 phone view fits the circuit', () => {
  const ed = editor();
  classes.add('m');
  const proj = Examples.EX.remote();
  assert.ok(proj.parts.length > 1);
  ed.setProject(proj);
  assert.equal(global.Mobile.fitIfReady(ed, true), true);
  assert.equal(ed._autoFit, true);
  assert.equal(ed._fitSize, '390x844');
  assert.ok(Number.isFinite(ed.view.s) && ed.view.s > 0 && ed.view.s <= 3);
  const vb = ed.svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
  assert.ok(Math.abs(vb[2] - 390 / ed.view.s) < 1e-6);
  assert.ok(Math.abs(vb[3] - 844 / ed.view.s) < 1e-6);
  const bb = ed.bounds();
  const x1 = ed.view.x + 390 / ed.view.s, y1 = ed.view.y + 844 / ed.view.s;
  assert.ok(bb.x >= ed.view.x - 1 && bb.y >= ed.view.y - 1, 'circuit is not left of the phone view');
  assert.ok(bb.x + bb.w <= x1 + 1 && bb.y + bb.h <= y1 + 1, 'circuit is not past the phone view');
  classes.delete('m');
});
