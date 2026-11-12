// Collapse used to be handled as a tab, so the dock reopened at its full height
// with no tab selected. Phone layout also left its close-button headers in the
// desktop panels after the window grew back past the breakpoint.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function classListOf(node) {
  return {
    contains(c) { return (' ' + node.className + ' ').includes(' ' + c + ' '); },
    add(c) { if (!this.contains(c)) node.className = (node.className + ' ' + c).trim(); },
    remove(c) { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
    toggle(c, on) { const next = on === undefined ? !this.contains(c) : !!on; if (next) this.add(c); else this.remove(c); },
  };
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
      if (!(' ' + node.className + ' ').includes(' ' + cls + ' ')) return false;
      rest = rest.slice(1 + cls.length);
    } else if (rest[0] === '[') {
      const end = rest.indexOf(']');
      let raw = rest.slice(1, end).split('=')[0];
      if (raw.startsWith('data-')) raw = raw.slice(5);
      const name = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!node.dataset || node.dataset[name] == null || node.dataset[name] === '') return false;
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
  let n = node.parentNode;
  while (n) { if (matchSel(n, ancestor)) return true; n = n.parentNode; }
  return false;
}
function relink(parent) {
  let prev = null;
  for (const c of parent.childNodes) {
    c.parentNode = parent; c.parentElement = parent;
    if (prev) prev.nextSibling = c;
    prev = c;
  }
  if (prev) prev.nextSibling = null;
}
function walk(node, out) {
  const kids = node === document ? [document.documentElement] : (node.childNodes || []);
  for (const c of kids) { if (!c) continue; out.push(c); walk(c, out); }
}
function queryAll(root, sel) {
  const out = []; walk(root, out);
  return out.filter((n) => matchSel(n, sel));
}
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: { display: '', height: '', top: '', transform: '', transition: '' },
    childNodes: [],
    parentNode: null,
    parentElement: null,
    nextSibling: null,
    textContent: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { if (c.parentNode) c.remove(); this.childNodes.push(c); relink(this); return c; },
    prepend(c) { if (c.parentNode) c.remove(); this.childNodes.unshift(c); relink(this); return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i >= 0) this.childNodes.splice(i, 0, c); else this.childNodes.push(c);
      relink(this); return c;
    },
    remove() {
      const p = this.parentNode; if (!p) return;
      const i = p.childNodes.indexOf(this); if (i >= 0) p.childNodes.splice(i, 1);
      this.parentNode = null; this.parentElement = null; this.nextSibling = null;
      relink(p);
    },
    addEventListener() {},
    setPointerCapture() {},
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
  };
  node.classList = classListOf(node);
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(v) {
      node._html = String(v);
      node.childNodes = [];
      if (String(v).includes('m-x')) {
        const b = makeEl('button'); b.className = 'm-x'; b.setAttribute('aria-label', 'Close'); node.appendChild(b);
      }
    },
  });
  return node;
}

const store = new Map();
global.localStorage = {
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
};
const document = {
  body: null,
  documentElement: null,
  createElement: (tag) => makeEl(tag),
  getElementById(id) { return queryAll(this, '#' + id)[0] || null; },
  querySelector(sel) { return queryAll(this, sel)[0] || null; },
  querySelectorAll(sel) { return queryAll(this, sel); },
  addEventListener() {},
};
document.documentElement = makeEl('html');
document.documentElement.style.setProperty = (k, v) => { document.documentElement.style[k] = v; };
document.documentElement.style.getPropertyValue = (k) => document.documentElement.style[k] || '';
document.body = makeEl('body');
document.documentElement.appendChild(document.body);
global.document = document;
global.window = global;
global.addEventListener = () => {};
global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

function button(id, tab, on) {
  const b = makeEl('button');
  b.id = id; b.dataset.tab = tab; if (on) b.className = 'on';
  b.textContent = tab;
  return b;
}
function panel(id) {
  const el = makeEl('div'); el.id = id; el.className = 'tab' + (id === 'tab-code' ? ' on' : '');
  return el;
}
const tabs = makeEl('nav'); tabs.id = 'tabs';
const code = button('tCode', 'code', true);
const serial = button('tSerial', 'serial', false);
const collapse = makeEl('button'); collapse.className = 'iconbtn'; collapse.dataset.collapse = 'dock';
tabs.appendChild(code); tabs.appendChild(serial); tabs.appendChild(collapse);
const dock = makeEl('section'); dock.id = 'dock';
const tabCode = panel('tab-code'); const tabSerial = panel('tab-serial');
dock.appendChild(tabs); dock.appendChild(tabCode); dock.appendChild(tabSerial);
const palette = makeEl('aside'); palette.id = 'palette';
const side = makeEl('aside'); side.id = 'side';
document.body.appendChild(palette); document.body.appendChild(dock); document.body.appendChild(side);

require('../js/ui.js');
require('../js/mobile.js');

test('collapsing the dock and reopening it restores the last tab and the saved height', () => {
  const UI = global.UI;
  assert.equal(UI.dockTabClick({ target: serial }), true);
  assert.equal(serial.classList.contains('on'), true);
  assert.equal(code.classList.contains('on'), false);
  assert.equal(tabSerial.classList.contains('on'), true);
  assert.equal(UI.dockTabClick({ target: collapse }), false, 'the collapse control is not a tab');
  assert.equal(serial.classList.contains('on'), true, 'collapse does not clear the selected tab');
  assert.equal(tabSerial.classList.contains('on'), true);
  serial.classList.remove('on'); code.classList.remove('on'); collapse.classList.add('on');
  tabSerial.classList.remove('on'); tabCode.classList.remove('on');
  localStorage.setItem('esp32lab.ui.dockH', JSON.stringify(180));
  document.documentElement.style.setProperty('--dockH', '900px');
  assert.equal(UI.restoreDock(document), 'serial');
  assert.equal(serial.classList.contains('on'), true);
  assert.equal(collapse.classList.contains('on'), false);
  assert.equal(tabSerial.classList.contains('on'), true);
  assert.equal(tabCode.classList.contains('on'), false);
  assert.equal(document.documentElement.style.getPropertyValue('--dockH'), '180px');
  serial.classList.remove('on'); tabSerial.classList.remove('on');
  localStorage.removeItem('esp32lab.ui.dockTab');
  assert.equal(UI.restoreDock(document), 'code', 'with nothing remembered, the first tab is shown');
  assert.equal(code.classList.contains('on'), true);
  assert.equal(tabCode.classList.contains('on'), true);
  const src = fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8');
  assert.match(src, /k === 'dock' && !v\) restoreDock\(\)/);
});

test('a hard reload restores the saved dock tab, and an unknown name falls back to Code', () => {
  const UI = global.UI;
  localStorage.setItem('esp32lab.ui.dockTab', JSON.stringify('serial'));
  localStorage.setItem('esp32lab.ui.dockH', JSON.stringify(180));
  code.classList.add('on');
  serial.classList.remove('on');
  collapse.classList.remove('on');
  tabCode.classList.add('on');
  tabSerial.classList.remove('on');
  document.documentElement.style.setProperty('--dockH', '900px');
  assert.equal(UI.restoreDock(document), 'serial');
  assert.equal(serial.classList.contains('on'), true);
  assert.equal(code.classList.contains('on'), false);
  assert.equal(tabSerial.classList.contains('on'), true);
  assert.equal(tabCode.classList.contains('on'), false);
  assert.equal(document.documentElement.style.getPropertyValue('--dockH'), '180px');
  localStorage.setItem('esp32lab.ui.dockTab', JSON.stringify('blueprint'));
  assert.equal(UI.restoreDock(document), 'code');
  assert.equal(code.classList.contains('on'), true);
  assert.equal(serial.classList.contains('on'), false);
  assert.equal(tabCode.classList.contains('on'), true);
  assert.equal(tabSerial.classList.contains('on'), false);
});

test('leaving the phone layout removes the close-button headers from the desktop panels', () => {
  const Mobile = global.Mobile;
  Mobile.sheetHead(palette, 'Parts');
  Mobile.sheetHead(dock, 'Code');
  Mobile.sheetHead(side, 'Properties');
  assert.equal(document.querySelectorAll('.m-x').length, 3);
  dock.style.height = '78%';
  Mobile.syncPhoneChrome(false);
  assert.equal(document.querySelectorAll('.m-sh-h').length, 0);
  assert.equal(document.querySelectorAll('.m-x').length, 0);
  assert.equal(palette.querySelector('.m-sh-h'), null);
  assert.equal(dock.classList.contains('m-sheet'), false);
  assert.equal(dock.style.height, '');
  Mobile.syncPhoneChrome(true);
  assert.equal(document.querySelectorAll('.m-x').length, 3);
  assert.equal(palette.querySelector('.m-x').getAttribute('aria-label'), 'Close');
});
