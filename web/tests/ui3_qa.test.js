// Studio Dark follow-ups: Space pans only from the canvas, and 3D stays out of the More sheet when it cannot open.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const els = {};
function node(tag, id) {
  const n = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    nodeType: 1,
    className: '',
    hidden: false,
    dataset: {},
    attrs: {},
    style: {},
    parentElement: null,
    childNodes: [],
    textContent: '',
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    _display: 'block',
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); if (c.id) els[c.id] = c; return c; },
    addEventListener() {},
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains(other) {
      let p = other;
      while (p) { if (p === this) return true; p = p.parentElement; }
      return false;
    },
    getBoundingClientRect() { return this.rect; },
    getContext(kind) { return (kind === 'webgl' || kind === 'experimental-webgl') && global.__gl ? {} : null; },
    focus() {},
    click() {},
  };
  n.classList = {
    contains(c) { return n.classList._s.has(c); },
    add(c) { n.classList._s.add(c); },
    remove(c) { n.classList._s.delete(c); },
    toggle(c, on) { if (on === false) n.classList.remove(c); else n.classList.add(c); },
    _s: new Set(),
  };
  if (id) els[id] = n;
  return n;
}

const document = {
  documentElement: node('html'),
  body: node('body'),
  createElement(tag) { return node(tag); },
  createElementNS(_ns, tag) { return node(tag); },
  getElementById(id) { return els[id] || null; },
  querySelector(sel) {
    if (sel === '#ui3more [data-go="3d"]') return els.more3d || null;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener() {},
};
document.documentElement.getAttribute = (k) => (k === 'data-ui' ? null : null);
document.body.appendChild(document.documentElement); // keep a parent chain without making body contain itself
document.body.parentElement = null;
global.document = document;
global.window = global;
global.location = { search: '' };
global.addEventListener = global.addEventListener || (() => {});
const nav = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 };
Object.defineProperty(global, 'navigator', { value: nav, configurable: true, writable: true });
global.__media = {};
global.matchMedia = (q) => ({ matches: !!global.__media[q] });
global.getComputedStyle = (el) => ({ display: el._display || 'block', visibility: 'visible' });
global.WebGLRenderingContext = function WebGLRenderingContext() {};
global.__gl = true;

require(path.join(__dirname, '..', 'js', 'viewchrome.js'));
require(path.join(__dirname, '..', 'js', 'ui3.js'));

const UI3 = global.UI3;
const stage = node('svg', 'stage');
const wrap = node('div', 'stageWrap');
wrap.appendChild(stage);
const side = node('aside', 'side');
side.rect = { left: 1140, top: 72, right: 1428, bottom: 860, width: 288, height: 788 };
const more3d = node('button', 'more3d');
more3d.dataset.go = '3d';
els.more3d = more3d;

function press(target) {
  const ed = { _spacePan: false };
  global.app = { editor: ed };
  let prevented = false;
  UI3.onStudioKey({
    key: ' ',
    repeat: false,
    target: target,
    preventDefault() { prevented = true; },
  });
  return { ed, prevented };
}

test('Space pans from the canvas or the page, and activates focused controls', () => {
  const body = press(document.body);
  assert.equal(body.prevented, true);
  assert.equal(body.ed._spacePan, true);

  const page = press(document.documentElement);
  assert.equal(page.prevented, true);
  assert.equal(page.ed._spacePan, true);

  const canvas = press(stage);
  assert.equal(canvas.prevented, true);
  assert.equal(canvas.ed._spacePan, true);

  const ink = node('g');
  ink.parentElement = stage;
  const drawn = press(ink);
  assert.equal(drawn.prevented, true);

  const button = node('button');
  button.parentElement = document.body;
  const onButton = press(button);
  assert.equal(onButton.prevented, false);
  assert.equal(onButton.ed._spacePan, false);

  const box = node('input');
  box.parentElement = document.body;
  box.attrs.type = 'checkbox';
  const onCheck = press(box);
  assert.equal(onCheck.prevented, false);
  assert.equal(onCheck.ed._spacePan, false);

  const link = node('a');
  link.parentElement = document.body;
  const onLink = press(link);
  assert.equal(onLink.prevented, false);

  const role = node('div');
  role.parentElement = document.body;
  role.attrs.role = 'checkbox';
  const onRole = press(role);
  assert.equal(onRole.prevented, false);

  const label = node('span');
  const host = node('button');
  host.parentElement = wrap;
  label.parentElement = host;
  const onInner = press(label);
  assert.equal(onInner.prevented, false, 'a control inside the canvas still receives Space');

  const card = node('div');
  card.parentElement = document.body;
  const onCard = press(card);
  assert.equal(onCard.prevented, false);

  const ed = { _spacePan: false };
  global.app = { editor: ed };
  let prevented = false;
  UI3.onStudioKey({ key: ' ', repeat: true, target: document.body, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(ed._spacePan, false);
});

test('the More sheet hides 3D whenever 3D cannot open', () => {
  global.__gl = true;
  global.navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64)';
  global.navigator.maxTouchPoints = 0;
  global.__media = {};
  document.body.classList.remove('no3d');
  assert.equal(UI3.threeDAvailable(), true);
  UI3.applyWebgl();
  assert.equal(more3d.hidden, false);

  global.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
  assert.equal(UI3.threeDAvailable(), false);
  UI3.applyWebgl();
  assert.equal(more3d.hidden, true);
  assert.equal(more3d.getAttribute('aria-disabled'), 'true');

  global.navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64)';
  global.__media['(pointer: coarse)'] = true;
  global.__media['(any-pointer: fine)'] = false;
  assert.equal(UI3.threeDAvailable(), false, 'a coarse pointer with no fine pointer is touch-first');

  global.__media = {};
  document.body.classList.add('no3d');
  assert.equal(UI3.threeDAvailable(), false, 'the no3d class hides 3D even on a desktop browser');
  UI3.applyWebgl();
  assert.equal(more3d.hidden, true);
  document.body.classList.remove('no3d');

  global.__gl = false;
  assert.equal(UI3.threeDAvailable(), false, 'missing WebGL still hides 3D');
  UI3.applyWebgl();
  assert.equal(more3d.hidden, true);
});

test('the selection toolbar stays inside the canvas beside the inspector', () => {
  side._display = 'block';
  const wrap = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
  const box = UI3.canvasLimits(wrap);
  assert.ok(box.x1 <= 1140 - 8, 'the inspector covers the right edge');
  const under = UI3.placeContextBox(1160, 180, 900, 220, 40, box);
  assert.ok(under.left >= box.x0);
  assert.ok(under.left + 220 <= box.x1 + 0.01, 'Rotate and the rest of the toolbar clear the inspector');
  const clear = UI3.placeContextBox(400, 180, 200, 220, 40, box);
  assert.equal(clear.left, 400, 'a toolbar that already fits stays next to the part');
  side._display = 'none';
  const open = UI3.canvasLimits(wrap);
  assert.ok(open.x1 > 1200, 'a hidden inspector gives the canvas back');
});
