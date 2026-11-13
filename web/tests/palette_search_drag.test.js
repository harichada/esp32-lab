// Search filters the same palette rows the grid drags. A search hit for
// "pushbutton" must drop on the canvas, and the same row must still drop
// after the phone layout moves those rows onto the track and back.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function classListFor(node) {
  const classes = () => (node.className || '').split(/\s+/).filter(Boolean);
  return {
    contains(c) { return classes().includes(c); },
    add(c) { if (!this.contains(c)) node.className = (node.className + ' ' + c).trim(); },
    remove(c) { node.className = classes().filter((x) => x !== c).join(' '); },
    toggle(c, on) { const next = on === undefined ? !this.contains(c) : !!on; if (next) this.add(c); else this.remove(c); },
  };
}
function relink(parent) {
  let prev = null;
  for (const c of parent.childNodes) {
    c.parentNode = parent;
    c.parentElement = parent;
    c.previousElementSibling = prev;
    if (prev) prev.nextElementSibling = c;
    prev = c.tagName ? c : prev;
  }
  if (parent.childNodes.length) parent.childNodes[parent.childNodes.length - 1].nextElementSibling = null;
}
function matches(node, sel) {
  if (!node || typeof node.tagName !== 'string') return false;
  let rest = sel;
  while (rest) {
    if (rest[0] === '#') {
      const id = rest.slice(1).match(/^[^.#\[]+/)[0];
      if (node.id !== id) return false;
      rest = rest.slice(1 + id.length);
    } else if (rest[0] === '.') {
      const cls = rest.slice(1).match(/^[^.#\[]+/)[0];
      if (!(' ' + (node.className || '') + ' ').includes(' ' + cls + ' ')) return false;
      rest = rest.slice(1 + cls.length);
    } else if (rest[0] === '[') {
      const end = rest.indexOf(']');
      const body = rest.slice(1, end);
      const eq = body.indexOf('=');
      let raw = eq < 0 ? body : body.slice(0, eq);
      const want = eq < 0 ? null : body.slice(eq + 1).replace(/^"|"$/g, '');
      if (raw.startsWith('data-')) raw = raw.slice(5);
      const name = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!node.dataset || node.dataset[name] == null || node.dataset[name] === '') return false;
      if (want != null && node.dataset[name] !== want) return false;
      rest = rest.slice(end + 1);
    } else {
      const tag = rest.match(/^[^.#\[]+/)[0];
      if (node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      rest = rest.slice(tag.length);
    }
  }
  return true;
}
function matchSel(node, sel) {
  const parts = sel.trim().split(/\s+/);
  const last = parts.pop();
  if (!matches(node, last)) return false;
  if (!parts.length) return true;
  const ancestor = parts.join(' ');
  let n = node.parentElement;
  while (n) { if (matchSel(n, ancestor)) return true; n = n.parentElement; }
  return false;
}
function queryAll(root, sel) {
  const out = [];
  const start = root === document ? [document.documentElement] : (root.childNodes || []);
  (function walk(nodes) {
    for (const c of nodes || []) {
      if (!c || !c.tagName) continue;
      if (matchSel(c, sel)) out.push(c);
      walk(c.childNodes);
    }
  })(start);
  return out;
}
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: {},
    attrs: {},
    childNodes: [],
    parentNode: null,
    parentElement: null,
    nextElementSibling: null,
    previousElementSibling: null,
    textContent: '',
    hidden: false,
    draggable: false,
    value: '',
    _ls: {},
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { if (c.parentNode) c.remove(); this.childNodes.push(c); relink(this); return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i >= 0) this.childNodes.splice(i, 0, c); else this.childNodes.push(c);
      relink(this); return c;
    },
    before(c) { if (this.parentNode) this.parentNode.insertBefore(c, this); },
    remove() {
      const p = this.parentNode; if (!p) return;
      const i = p.childNodes.indexOf(this); if (i >= 0) p.childNodes.splice(i, 1);
      this.parentNode = null; this.parentElement = null;
      relink(p);
    },
    addEventListener(type, fn) { (this._ls[type] = this._ls[type] || []).push(fn); },
    setPointerCapture() {},
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentElement; } return null; },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
  };
  node.classList = classListFor(node);
  Object.defineProperty(node, 'children', { get() { return node.childNodes.filter((c) => c.tagName); } });
  Object.defineProperty(node, 'firstChild', { get() { return node.childNodes[0] || null; } });
  Object.defineProperty(node, 'lastChild', { get() { return node.childNodes[node.childNodes.length - 1] || null; } });
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(v) {
      node._html = String(v);
      node.childNodes = [];
      if (node.id === 'lOver') { node.appendChild(makeEl('g')); node.appendChild(makeEl('g')); return; }
      if (node.id === 'palList') parseInto(node, v);
    },
  });
  return node;
}
function decode(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function applyAttrs(el, raw) {
  const re = /([^\s=/]+)(?:="([^"]*)")?/g;
  let m, first = true;
  while ((m = re.exec(raw))) {
    if (first) { first = false; continue; }
    const name = m[1];
    if (name === '/') continue;
    const hasVal = m[2] != null;
    const val = hasVal ? decode(m[2]) : '';
    if (name === 'class') el.className = val;
    else if (name === 'id') el.id = val;
    else if (name === 'draggable') el.draggable = val !== 'false';
    else if (name === 'hidden') el.hidden = true;
    else if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      el.dataset[key] = val;
    }
    el.attrs[name] = hasVal ? val : '';
  }
}
function parseNodes(s, i) {
  const nodes = [];
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return { nodes, i: s.length };
    if (s.startsWith('</', lt)) return { nodes, i: lt };
    if (s.startsWith('<svg', lt) || s.startsWith('<SVG', lt)) {
      const end = s.toLowerCase().indexOf('</svg>', lt);
      i = end < 0 ? s.length : end + 6;
      continue;
    }
    const gt = s.indexOf('>', lt);
    if (gt < 0) return { nodes, i: s.length };
    const raw = s.slice(lt + 1, gt);
    const self = /\/\s*$/.test(raw);
    const tag = raw.split(/[\s/]/)[0].toLowerCase();
    const el = makeEl(tag);
    applyAttrs(el, raw);
    i = gt + 1;
    if (!self && !['input', 'br', 'img', 'use', 'path', 'circle', 'rect', 'line', 'text'].includes(tag)) {
      const inner = parseNodes(s, i);
      inner.nodes.forEach((c) => el.appendChild(c));
      i = inner.i;
      if (s.startsWith('</', i)) {
        const closeGt = s.indexOf('>', i);
        i = closeGt < 0 ? s.length : closeGt + 1;
      }
    }
    nodes.push(el);
  }
  return { nodes, i };
}
function parseInto(parent, html) {
  parseNodes(String(html), 0).nodes.forEach((n) => parent.appendChild(n));
}

const document = {
  hidden: false,
  body: null,
  documentElement: null,
  createElement: (tag) => makeEl(tag),
  createElementNS: (_ns, tag) => makeEl(tag),
  getElementById(id) { return queryAll(this, '#' + id)[0] || null; },
  querySelector(sel) { return queryAll(this, sel)[0] || null; },
  querySelectorAll(sel) { return queryAll(this, sel); },
  addEventListener() {},
};
document.documentElement = makeEl('html');
document.body = makeEl('body');
document.documentElement.appendChild(document.body);
global.document = document;
global.window = global;
global.addEventListener = () => {};
global.location = { protocol: 'http:', host: 'localhost', pathname: '/', search: '', href: 'http://localhost/' };
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
global.localStorage = memStorage();
global.sessionStorage = memStorage();
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (fn, ms, ...a) => { const t = origSetInterval(fn, ms, ...a); if (t.unref) t.unref(); return t; };
global.setTimeout = (fn, ms, ...a) => { const t = origSetTimeout(fn, ms, ...a); if (t.unref) t.unref(); return t; };
global.requestAnimationFrame = (fn) => global.setTimeout(fn, 0);
delete global.ResizeObserver;
if (!global.CSS) global.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch) };

const palette = makeEl('aside'); palette.id = 'palette';
const search = makeEl('input'); search.id = 'palSearch';
const list = makeEl('div'); list.id = 'palList';
palette.appendChild(search); palette.appendChild(list);
document.body.appendChild(palette);

require('./tools/load-parts');
require(path.join(__dirname, '../js/storage.js'));
require(path.join(__dirname, '../js/projects.js'));
require(path.join(__dirname, '../js/editor.js'));
require(path.join(__dirname, '../js/app.js'));

function stage() {
  const svg = makeEl('svg');
  svg._ls = {};
  for (const id of ['lParts', 'lWires', 'lOver']) { const g = makeEl('g'); g.id = id; svg.appendChild(g); }
  const wrap = makeEl('div'); wrap.appendChild(svg);
  return svg;
}
function phoneTrack() {
  const src = fs.readFileSync(path.join(__dirname, '../js/mobile.js'), 'utf8');
  const mark = 'window.Mobile_track = (on) => ';
  const start = src.indexOf(mark);
  assert.ok(start >= 0, 'phone layout still moves palette rows with Mobile_track');
  let depth = 0, j = start + mark.length;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  const pl = document.getElementById('palList');
  const track = makeEl('div'); track.id = 'mTrack';
  pl.before(track);
  // build() stamps the category before the first resize. apply() then calls Mobile_track.
  document.querySelectorAll('#palList .pgrid').forEach((g) => { [...g.children].forEach((it) => { it.dataset.cat = g.dataset.cat; }); });
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const move = new Function('$$', 'pl', 'track', 'CSS', 'return (on) => ' + src.slice(start + mark.length, j))($$, pl, track, global.CSS);
  return { track, move };
}
function searchPushbutton() {
  const input = document.getElementById('palSearch');
  input.value = 'pushbutton';
  input.oninput({ target: input });
  const hits = [...document.querySelectorAll('.pitem')].filter((it) => visible(it) && it.dataset.type === 'pushbutton');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].getAttribute('draggable') || (hits[0].draggable ? 'true' : ''), 'true');
  return hits[0];
}
function visible(el) {
  let n = el;
  while (n && n !== document) { if (n.hidden) return false; n = n.parentElement; }
  return !!el.parentNode;
}
function dropRow(ed, row, clientX, clientY) {
  const bag = new Map();
  const dt = { setData: (k, v) => bag.set(k, String(v)), getData: (k) => bag.get(k) || '' };
  for (const fn of row._ls.dragstart || []) fn({ dataTransfer: dt, target: row });
  assert.equal(bag.get('text/x-part'), 'pushbutton');
  const drop = (ed.svg._ls.drop || []).find(Boolean);
  assert.ok(drop, 'canvas drop listener');
  const before = ed.proj.parts.length;
  drop({ preventDefault() {}, dataTransfer: dt, clientX, clientY, target: ed.svg });
  assert.equal(ed.proj.parts.length, before + 1);
  const part = ed.proj.parts[ed.proj.parts.length - 1];
  const world = ed.toWorld({ clientX, clientY });
  assert.equal(part.type, 'pushbutton');
  assert.equal(part.x, Math.round(world.x / 10) * 10);
  assert.equal(part.y, Math.round(world.y / 10) * 10);
  return part;
}

test('dragging a pushbutton search result drops it, including after the phone layout toggles', () => {
  app.buildPalette();
  const svg = stage();
  const ed = new global.Editor(svg, { beforeEdit() {}, changed() {}, hover() {}, press() {}, selected() {}, state() { return null; }, running() { return false; } });
  ed.setProject({ parts: [], wires: [] });
  app.editor = ed;
  app.proj = ed.proj;

  const row = searchPushbutton();
  const first = dropRow(ed, row, 140, 140);
  assert.equal(first.x, 100);
  assert.equal(first.y, 100);

  const { track, move } = phoneTrack();
  document.body.classList.add('m');
  move(true);
  assert.equal(row.parentNode, track, 'phone layout parks the search row on the track');
  const onPhone = searchPushbutton();
  assert.equal(onPhone, row);
  const second = dropRow(ed, onPhone, 240, 120);
  assert.equal(second.x, 200);
  assert.equal(second.y, 80);

  document.body.classList.remove('m');
  move(false);
  assert.ok(row.parentNode && row.parentNode.classList.contains('pgrid'), 'desktop layout puts the row back in its category');
  const back = searchPushbutton();
  assert.equal(back, row);
  const third = dropRow(ed, back, 80, 200);
  assert.equal(third.x, 40);
  assert.equal(third.y, 160);
});
