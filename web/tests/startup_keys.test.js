// ?ex= fetches the sketch before app.proj exists. A key event in that window
// must not read proj.parts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function el(tag) {
  return {
    tagName: String(tag).toUpperCase(), id: '', className: '', textContent: '', value: '',
    style: {}, dataset: {}, hidden: false, childNodes: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.childNodes.push(c); return c; },
    remove() {}, addEventListener() {},
    querySelector(sel) { return sel === 'span' ? this.childNodes.find((c) => c.tagName === 'SPAN') || null : null; },
  };
}
const ids = {};
function byId(id, tag) { const n = el(tag); n.id = id; ids[id] = n; return n; }
const bRun = byId('bRun', 'button');
const label = el('span'); label.textContent = 'Run'; bRun.appendChild(label);
byId('code', 'textarea');
byId('inDefines', 'input');
byId('buildLog', 'pre');
byId('stDot', 'i');
byId('stText', 'span');
byId('stage', 'div');

const listeners = [];
const document = {
  hidden: false,
  body: el('body'),
  createElement: (tag) => el(tag),
  querySelector(sel) {
    const id = /^#([\w-]+)$/.exec(sel);
    return id ? (ids[id[1]] || null) : null;
  },
  getElementById: (id) => ids[id] || null,
  querySelectorAll: () => [],
  addEventListener() {},
};
global.document = document;
global.window = global;
global.addEventListener = (type, fn) => { listeners.push({ type, fn }); };
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
global.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => ({}) });

require('./tools/load-parts');
require(path.join(__dirname, '../js/storage.js'));
require(path.join(__dirname, '../js/projects.js'));
require(path.join(__dirname, '../js/app.js'));

function fire(type, key, extra) {
  const e = Object.assign({
    key, code: '', target: { tagName: 'BODY' },
    preventDefault() { e.defaultPrevented = true; },
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
  }, extra);
  const hits = listeners.filter((h) => h.type === type);
  assert.ok(hits.length, type + ' listener is installed before init');
  for (const h of hits) h.fn(e);
}

test('keydown and keyup do not throw while app.proj is still null', () => {
  assert.equal(app.proj, null);
  assert.doesNotThrow(() => {
    fire('keydown', 'Delete');
    fire('keydown', 'Backspace');
    fire('keydown', 'r');
    fire('keydown', 'z', { ctrlKey: true });
    fire('keydown', 'Enter', { ctrlKey: true });
    fire('keydown', 's', { metaKey: true });
    fire('keyup', 'a');
    fire('keyup', 'Enter');
  });
});

test('part shortcuts ignore focused controls and already-handled events but work on the canvas', () => {
  const previous = { proj: app.proj, editor: app.editor, Editor: global.Editor };
  let edits = 0;
  app.proj = { parts: [] };
  app.editor = { deleteSel() { edits++; }, rotateSel() { edits++; }, flipSel() { edits++; } };
  global.Editor = { editChord() { return null; } };
  try {
    fire('keydown', 'Delete');
    assert.equal(edits, 1);
    for (const tag of ['BUTTON', 'A', 'SUMMARY', 'DIV']) {
      const target = { tagName: tag, closest(selector) { return selector.includes('button,a,summary') ? this : null; } };
      fire('keydown', 'Delete', { target });
      fire('keydown', 'r', { target });
      fire('keydown', 'f', { target });
    }
    fire('keydown', 'Delete', { defaultPrevented: true });
    assert.equal(edits, 1);
  } finally {
    app.proj = previous.proj; app.editor = previous.editor; global.Editor = previous.Editor;
  }
});

test('a held virtual key releases even after focus moves to a toolbar button', () => {
  const previous = { proj: app.proj, editor: app.editor, sim: app.sim, run: app.run };
  const state = { pressed: true };
  let refreshed = 0;
  app.proj = { parts: [{ id: 'KEY1', type: 'pushbutton', props: { key: 'a' } }] };
  app.sim = { partState() { return state; } };
  app.editor = { refreshDynamic() { refreshed++; } };
  app.run = { kind: 'js' };
  try {
    fire('keyup', 'a', { target: { tagName: 'BUTTON' } });
    assert.equal(state.pressed, false);
    assert.equal(refreshed, 1);
  } finally {
    app.proj = previous.proj; app.editor = previous.editor; app.sim = previous.sim; app.run = previous.run;
  }
});
