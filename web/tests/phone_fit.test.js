// Loading ?ex=remote at 390x844 called Editor.fit from mobile.js before the
// example's fetch finished, so Editor.bounds read parts of an undefined project.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
    getBoundingClientRect() { return { left: 0, top: 0, width: stageSize.w, height: stageSize.h, right: stageSize.w, bottom: stageSize.h }; },
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

const stageSize = { w: 390, h: 844 };
const classes = new Set();
const ids = { zoomPct: { textContent: '' } };
const document = {
  createElementNS(_ns, tag) { return makeEl(tag); },
  createElement(tag) { return makeEl(tag); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById(id) { return ids[id] || null; },
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

// Narrow-phone chrome, in the same coordinates as a stage that fills the viewport.
// The fit button is the third 44px cell in the stack (−, %, fit, +).
function phoneBlockers(w, h) {
  const stackW = 52, stackH = 4 + 44 * 4 + 6 * 3 + 4, stackTop = 88, stackRight = w - 8;
  return [
    { id: 'top', tag: 'header', left: 0, top: 0, right: w, bottom: 54 },
    { id: 'mTicker', left: 0, top: 54, right: w, bottom: 78 },
    { id: 'bCopy', left: 12, top: 88, right: 150, bottom: 128 },
    { id: 'mParts', left: w - 122, top: 36, right: w - 12, bottom: 80 },
    { className: 'zoom-tools', left: stackRight - stackW, top: stackTop, right: stackRight, bottom: stackTop + stackH },
    { className: 'hint', left: 12, top: h - 224, right: w - 12, bottom: h - 176 },
    { className: 'canvas-tools', left: 12, top: h - 164, right: Math.min(200, w - 100), bottom: h - 112 },
    { id: 'mHub', left: w / 2 - 38, top: h - 90, right: w / 2 + 38, bottom: h - 14 },
    { id: 'mIgnite', left: w - 92, top: h - 90, right: w - 16, bottom: h - 14 },
  ];
}
function fitButtonBox(w) {
  const stackTop = 88, pad = 4, gap = 6, cell = 44;
  const top = stackTop + pad + (cell + gap) * 2;
  return { left: w - 8 - 52 + pad, top: top, right: w - 8 - 52 + pad + cell, bottom: top + cell };
}
function overlaps(a, b) {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}
function clearOf(a, b, m) {
  return a.right <= b.left - m + 0.75 || a.left >= b.right + m - 0.75 || a.bottom <= b.top - m + 0.75 || a.top >= b.bottom + m - 0.75;
}
function screenBox(view, box) {
  const left = (box.x - view.x) * view.s, top = (box.y - view.y) * view.s;
  return { left: left, top: top, right: left + box.w * view.s, bottom: top + box.h * view.s };
}
function installChrome(list) {
  const nodes = list.map((b) => {
    const n = makeEl(b.tag || 'div');
    n.id = b.id || '';
    n.className = b.className || '';
    n.classList.contains = (c) => n.className.split(/\s+/).includes(c);
    n.getBoundingClientRect = () => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.right - b.left, height: b.bottom - b.top });
    return n;
  });
  document.querySelectorAll = (sel) => (sel && String(sel).includes('#mIgnite') ? nodes : []);
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
}

test('the phone fit button sits on the % pill, stays off the desktop, and clears the other bars', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'css/mobile.css'), 'utf8');
  const pill = html.match(/<span id="zoomPct"[\s\S]*?<\/span>\s*<button[^>]*id="bFitPill"[^>]*>/);
  assert.ok(pill, 'fit button is adjacent to the zoom %');
  assert.match(pill[0], /aria-label="Fit circuit to view"/);
  assert.match(pill[0], /title="Fit circuit to view"/);
  assert.match(css, /#bFitPill\{display:none\}/);
  assert.match(css, /body\.m #bFitPill\{display:inline-flex!important/);
  assert.match(css, /#bFitPill\{display:inline-flex!important;width:44px;min-width:44px;height:44px;min-height:44px/);
  for (const [w, h] of [[390, 844], [375, 667]]) {
    const bars = phoneBlockers(w, h);
    const fit = fitButtonBox(w);
    assert.ok(fit.right - fit.left >= 40 && fit.bottom - fit.top >= 40, 'tap target ' + w);
    const stack = bars.find((b) => b.className === 'zoom-tools');
    assert.ok(fit.left >= stack.left && fit.right <= stack.right && fit.top >= stack.top && fit.bottom <= stack.bottom, 'button stays inside the zoom stack');
    for (const bar of bars) {
      if (bar.className === 'zoom-tools') continue;
      assert.equal(overlaps(fit, bar), false, 'fit button overlaps ' + (bar.id || bar.className) + ' at ' + w + 'x' + h);
      assert.equal(overlaps(stack, bar), false, 'zoom stack overlaps ' + (bar.id || bar.className) + ' at ' + w + 'x' + h);
    }
  }
});

test('the fit pill no-ops without a project and uses the same fit as the % tap', () => {
  const ed = editor();
  global.app = { editor: ed };
  const before = { x: ed.view.x, y: ed.view.y, s: ed.view.s };
  global.Mobile.fitFromPill();
  assert.deepEqual(ed.view, before);
  let sch = 0, cube = 0;
  ed.setProject(Examples.EX.blank());
  global.app.schematic = { active: true, fit() { sch += 1; } };
  global.Mobile.fitFromPill();
  assert.equal(sch, 1);
  global.app.schematic.active = false;
  global.app.view3d = { active: true, fit() { cube += 1; } };
  global.Mobile.fitFromPill();
  assert.equal(cube, 1);
  global.app.view3d.active = false;
  global.Mobile.fitFromPill();
  assert.equal(ed._autoFit, true);
  global.app = { editor: editor() };
  global.Mobile.fitFromPill();
  assert.equal(global.app.editor._autoFit, undefined);
});

test('every bundled example fits inside the phone canvas with a margin at 390x844 and 375x667', () => {
  const keys = [...new Set([...Examples.LIST.map((row) => row[0]), ...Object.keys(Examples.EX)])];
  assert.ok(keys.length >= 40, 'catalog ' + keys.length);
  const servo = Examples.EX.servo().parts.find((p) => p.type === 'servo');
  const drawn = global.Parts.gfxBox(servo);
  assert.ok(drawn && drawn.w > 100, 'servo artwork is wider than the pin box');
  classes.add('m');
  for (const [w, h] of [[390, 844], [375, 667]]) {
    stageSize.w = w; stageSize.h = h;
    const bars = phoneBlockers(w, h);
    installChrome(bars);
    for (const key of keys) {
      const proj = Examples.EX[key]();
      const ed = editor();
      ed.setProject(proj);
      assert.doesNotThrow(() => ed.fit(), key + ' fit');
      assert.equal(ed._fitSize, w + 'x' + h, key);
      const where = key + ' @ ' + w + 'x' + h + ' scale ' + ed.view.s.toFixed(3);
      for (const p of proj.parts) {
        const box = global.Parts.gfxBox(p);
        if (!box) continue;
        const s = screenBox(ed.view, box);
        assert.ok(s.left >= 16 - 0.75 && s.top >= 16 - 0.75 && s.right <= w - 16 + 0.75 && s.bottom <= h - 16 + 0.75, p.type + ' leaves the canvas ' + where + ' ' + JSON.stringify(s));
        for (const bar of bars) assert.ok(clearOf(s, bar, 16), p.type + ' hits ' + (bar.id || bar.className) + ' ' + where);
      }
      for (const wire of proj.wires || []) {
        for (const q of [wire.a, wire.b, ...(wire.pts || [])]) {
          if (!q) continue;
          const s = screenBox(ed.view, { x: q.x - 2, y: q.y - 2, w: 4, h: 4 });
          assert.ok(s.left >= 16 - 0.75 && s.top >= 16 - 0.75 && s.right <= w - 16 + 0.75 && s.bottom <= h - 16 + 0.75, 'wire leaves the canvas ' + where);
          for (const bar of bars) assert.ok(clearOf(s, bar, 16), 'wire hits ' + (bar.id || bar.className) + ' ' + where);
        }
      }
    }
  }
  classes.delete('m');
  stageSize.w = 390; stageSize.h = 844;
  document.querySelectorAll = () => [];
});

function relL(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function contrast(a, b) {
  const x = relL(a), y = relL(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('the fit button meets AA contrast and keeps a fixed 44px box in every state', () => {
  const css = fs.readFileSync(path.join(WEB, 'css/mobile.css'), 'utf8');
  for (const state of [':hover', ':active', ':focus-visible', ':disabled', '[aria-disabled="true"]']) {
    assert.match(css, new RegExp('#bFitPill' + state.replace('[', '\\[')));
  }
  assert.match(css, /#bFitPill\{display:inline-flex!important;[^}]*flex:0 0 44px;width:44px;min-width:44px;height:44px;min-height:44px/);
  // The phone zoom cluster is a dark glass over either theme's canvas. #4d5055 is that glass over the light canvas.
  const pill = '#4d5055';
  assert.ok(contrast('#f4f6f8', pill) >= 4.5, 'resting icon');
  assert.ok(contrast('#ffffff', '#2a3038') >= 4.5, 'hover and focus');
  assert.ok(contrast('#ffffff', '#12161b') >= 4.5, 'active');
  assert.ok(contrast('#c5c9d0', pill) >= 4.5, 'disabled');
  assert.ok(contrast('#67e8f9', pill) >= 3, 'focus ring on the dark cluster');
  assert.match(css, /#bFitPill:focus-visible\{[^}]*outline:2px solid #67e8f9/);
  assert.match(css, /#bFitPill:active\{[^}]*transform:none/);
});

test('Enter and Space fit the circuit, Tab does not, and a missing project does nothing', () => {
  const handlers = {};
  const b = makeEl('button');
  b.tabIndex = 0;
  b.disabled = false;
  b.setAttribute('aria-label', 'Fit circuit to view');
  b.addEventListener = (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); };
  ids.bFitPill = b;
  global.Mobile.bindFitPill();
  const ed = editor();
  global.app = { editor: ed };
  const fire = (key) => handlers.keydown.forEach((fn) => fn({ key: key, preventDefault() {}, repeat: false }));
  fire('Tab');
  fire('Enter');
  assert.equal(ed._autoFit, undefined);
  assert.equal(ed.view.s, 1);
  ed.setProject(Examples.EX.blank());
  fire(' ');
  assert.equal(ed._autoFit, true);
  assert.ok(ed.view.s > 0 && ed.view.s <= 3);
  const fitted = ed.view.s;
  fire('Enter');
  assert.equal(ed.view.s, fitted);
  assert.equal(b.tabIndex, 0);
  assert.equal(b.disabled, false);
  assert.equal(b.getAttribute('aria-label'), 'Fit circuit to view');
});

test('fit rejects an empty project, a non-finite viewport, and non-finite part data', () => {
  const ed = editor();
  const snap = () => ({ x: ed.view.x, y: ed.view.y, s: ed.view.s });
  ed.setProject({ name: 'empty', parts: [], wires: [] });
  const untouched = snap();
  ed.fit();
  assert.deepEqual(snap(), untouched);
  global.app = { editor: ed };
  global.Mobile.fitFromPill();
  assert.deepEqual(snap(), untouched);

  ed.setProject({ name: 'nan', parts: [{ id: 'r', type: 'resistor', x: NaN, y: NaN, rot: 0, props: { r: '1k' } }], wires: [{ a: { x: NaN, y: 0 }, b: { x: Infinity, y: 1 }, pts: [{ x: -Infinity, y: NaN }] }] });
  ed.fit();
  assert.deepEqual(snap(), untouched);
  assert.equal(ed.bounds(), null);

  const blank = Examples.EX.blank();
  blank.parts.push({ id: 'bad', type: 'label', x: Infinity, y: -Infinity, rot: 0, props: { text: 'x', size: 12 } });
  ed.setProject(blank);
  ed.fit();
  assert.ok([ed.view.x, ed.view.y, ed.view.s].every(Number.isFinite));
  assert.ok(ed.view.s >= 0.15 && ed.view.s <= 3);
  const bb = ed.bounds();
  assert.ok(bb && [bb.x, bb.y, bb.w, bb.h].every(Number.isFinite) && bb.w > 0 && bb.h > 0);

  const fitted = snap();
  for (const size of [{ w: 0, h: 0 }, { w: -20, h: 844 }, { w: NaN, h: 844 }, { w: Infinity, h: 100 }]) {
    stageSize.w = size.w; stageSize.h = size.h;
    ed.fit();
    assert.deepEqual(snap(), fitted, 'viewport ' + size.w + 'x' + size.h);
  }
  stageSize.w = 100000; stageSize.h = 100000;
  ed.fit();
  assert.equal(ed.view.s, 3);
  assert.ok(Number.isFinite(ed.view.x) && Number.isFinite(ed.view.y));
  stageSize.w = 8; stageSize.h = 8;
  ed.fit();
  assert.equal(ed.view.s, 0.15);
  assert.equal(ids.zoomPct.textContent, '15%');
  stageSize.w = 390; stageSize.h = 844;
});
