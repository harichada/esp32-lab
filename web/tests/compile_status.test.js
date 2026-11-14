// Status sentences for a sandbox failure, a blocked include, and a compiler error.
// Own page mock so it does not share the Run button with compile_button.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function classListFor(node) {
  const set = new Set((node.className || '').split(/\s+/).filter(Boolean));
  const sync = () => { node.className = [...set].join(' '); };
  return {
    add(...xs) { xs.forEach((c) => set.add(c)); sync(); },
    remove(...xs) { xs.forEach((c) => set.delete(c)); sync(); },
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      sync();
      return on;
    },
    contains(c) { return set.has(c); },
  };
}
function el(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), value: '', textContent: '', className: '',
    style: {}, dataset: {}, attrs: {}, childNodes: [], parentElement: null,
    scrollTop: 0, scrollHeight: 0, disabled: false, open: false, hidden: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; },
    remove() {},
    addEventListener() {},
    querySelector(sel) {
      if (sel === 'span') return this.childNodes.find((c) => c.tagName === 'SPAN') || null;
      return null;
    },
  };
  node.classList = classListFor(node);
  return node;
}

const ids = {};
function byId(id, tag) { const n = el(tag); n.id = id; ids[id] = n; return n; }

const bRun = byId('bRun', 'button');
bRun.className = 'primary run';
const label = el('span');
label.textContent = 'Run';
bRun.appendChild(label);
bRun.appendChild(el('i'));

byId('code', 'textarea');
byId('inDefines', 'input');
byId('buildLog', 'pre');
byId('netNotice', 'p');
byId('buildDet', 'details');
byId('stDot', 'i');
byId('stText', 'span');
byId('status', 'div');
byId('stLive', 'span');
byId('compileStrip', 'p');
byId('mCompileToast', 'p');
byId('stage', 'div');
const buildTab = el('button');
buildTab.click = () => {};

const document = {
  hidden: false,
  body: el('body'),
  createElement: (tag) => el(tag),
  querySelector(sel) {
    const id = /^#([\w-]+)$/.exec(sel);
    if (id) return ids[id[1]] || null;
    if (sel === '[data-tab=build]') return buildTab;
    return null;
  },
  getElementById: (id) => ids[id] || null,
  querySelectorAll: () => [],
  addEventListener() {},
};
global.document = document;
global.window = global;
if (typeof global.addEventListener !== 'function') global.addEventListener = () => {};
global.location = { protocol: 'http:', host: 'localhost', pathname: '/', search: '', href: 'http://localhost/' };
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
global.localStorage = memStorage();
global.sessionStorage = memStorage();
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (fn, ms, ...a) => { const t = origSetInterval(fn, ms, ...a); if (t.unref) t.unref(); return t; };
global.setTimeout = (fn, ms, ...a) => { const t = origSetTimeout(fn, ms, ...a); if (t.unref) t.unref(); return t; };
global.requestAnimationFrame = (fn) => global.setTimeout(fn, 0);

let compileReply = null;
let narrowPhone = false;
global.fetch = (url) => {
  const u = String(url);
  if (u.includes('progress')) return Promise.resolve({ status: 200, json: async () => ({ active: false }) });
  if (u.includes('api/compile')) return compileReply;
  return Promise.resolve({ status: 200, ok: true, json: async () => ({}) });
};
global.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
global.matchMedia = (q) => ({
  matches: narrowPhone && String(q).includes('640'),
  media: String(q || ''),
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

require('./tools/load-parts');
require(path.join(__dirname, '../js/storage.js'));
require(path.join(__dirname, '../js/projects.js'));
require(path.join(__dirname, '../js/app.js'));
require(path.join(__dirname, '../js/mobile.js'));

app.proj = {
  name: 'sketch', mode: 'qemu', code: 'void setup(){}', files: {}, defines: [],
  parts: [{ id: 'esp', type: 'esp32' }], wires: [],
};
app.file = 'sketch';
app.sim = { resetState() {}, dirty: false, espRuntime() { return { reset() {} }; } };
ids.code.value = app.proj.code;
ids.inDefines.value = '';

function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function okResponse(body) {
  return { status: 200, ok: true, json: async () => Object.assign({ ok: true, id: 'build-1', log: '', cached: false }, body) };
}

const SIMULATOR = "The simulator couldn't start. Try again in a minute. Your sketch is fine and saved.";

test('sandbox, include, and compiler status lines', async (t) => {
  await t.test('a sandbox failure is the simulator sentence on the phone and on the desktop', async () => {
    narrowPhone = false;
    const pending = gate();
    compileReply = pending.promise;
    const flight = app.startRun();
    pending.resolve(okResponse({
      ok: false,
      reason: 'infra',
      log: "We couldn't check this sketch's #include lines, so it wasn't built. Check them for typos, then press Run again.",
    }));
    await flight;
    assert.equal(ids.buildLog.textContent, SIMULATOR);
    assert.equal(ids.buildLog.innerHTML, undefined);
    assert.equal(ids.stLive.textContent, SIMULATOR);
    assert.equal(ids.compileStrip.textContent, SIMULATOR);
    assert.equal(ids.compileStrip.hidden, false);
    assert.equal(ids.mCompileToast.hidden, true);
    assert.doesNotMatch(ids.stText.textContent, /compile error/);
    assert.doesNotMatch(ids.stLive.textContent, /compile error/);

    narrowPhone = true;
    const again = gate();
    compileReply = again.promise;
    const second = app.startRun();
    again.resolve(okResponse({ ok: false, reason: 'infra', log: 'compile error' }));
    await second;
    assert.equal(ids.mCompileToast.hidden, false);
    assert.equal(ids.mCompileToast.textContent, SIMULATOR);
    assert.equal(ids.mCompileToast.innerHTML, undefined);
    assert.equal(ids.compileStrip.hidden, true);
    assert.equal(ids.stLive.textContent, SIMULATOR);
    narrowPhone = false;
  });

  await t.test('a blocked include names the line and renders sketch text as text', async () => {
    const nasty = '<img src=x onerror=alert(1)>';
    app.proj.code = 'void setup(){}\nvoid loop(){}\n#include ' + nasty + '\n';
    ids.code.value = app.proj.code;
    narrowPhone = true;
    const pending = gate();
    compileReply = pending.promise;
    const flight = app.startRun();
    pending.resolve(okResponse({
      ok: false,
      reason: 'outside',
      log: 'This sketch tries to include a file from outside the project.',
    }));
    await flight;
    const sentence = "Line 3: Circuit Lab can't use " + nasty + '. Remove it and use a library such as WiFi.h, or a file in your sketch.';
    assert.equal(ids.mCompileToast.textContent, sentence);
    assert.equal(ids.mCompileToast.innerHTML, undefined);
    assert.equal(ids.mCompileToast.childNodes.length, 0);
    assert.equal(ids.stLive.textContent, sentence);
    assert.ok(sentence.length > 80);
    assert.ok(nasty.length <= 80);

    narrowPhone = false;
    app.proj.code = 'void setup(){}\nvoid loop(){}\n#include <sys/socket.h>\n';
    ids.code.value = app.proj.code;
    const desk = gate();
    compileReply = desk.promise;
    const third = app.startRun();
    desk.resolve(okResponse({
      ok: false,
      reason: 'outside',
      log: 'This sketch tries to include a file from outside the project.',
    }));
    await third;
    const socketLine = "Line 3: Circuit Lab can't use <sys/socket.h>. Remove it and use WiFi.h instead.";
    assert.equal(ids.compileStrip.textContent, socketLine);
    assert.equal(ids.compileStrip.hidden, false);
    assert.equal(ids.mCompileToast.hidden, true);
    assert.equal(ids.stLive.textContent, socketLine);
    assert.equal(ids.compileStrip.innerHTML, undefined);

    app.proj.code = 'void setup(){}\n#include <stdio.h>\n';
    ids.code.value = app.proj.code;
    const files = gate();
    compileReply = files.promise;
    const fifth = app.startRun();
    files.resolve(okResponse({ ok: false, reason: 'outside', log: 'outside the project' }));
    await fifth;
    assert.equal(ids.stLive.textContent, "Line 2: Circuit Lab can't use <stdio.h>. Remove it and keep data in your sketch instead.");

    app.proj.code = 'void setup(){}\n';
    ids.code.value = app.proj.code;
    const compiler = gate();
    compileReply = compiler.promise;
    const fourth = app.startRun();
    compiler.resolve(okResponse({
      ok: false,
      log: "Compiling sketch...\n/tmp/esp32/sketch/sketch.ino:1:1: error: expected ';' before '}' token\n",
    }));
    await fourth;
    assert.equal(ids.stLive.textContent, "sketch.ino:1:1: error: expected ';' before '}' token");
    assert.equal(ids.compileStrip.textContent, ids.stLive.textContent);
    assert.doesNotMatch(ids.stLive.textContent, /\/tmp\/|bwrap|sandbox/);
    assert.equal(ids.compileStrip.innerHTML, undefined);
  });
});
