// While a compile is in flight the Run button is disabled, labelled Compiling…,
// and carries the busy (.spinning) class. It returns to Run once that compile
// resolves, including a 429, a compiler error, and a websocket that never opens.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setTimeout: delay } = require('node:timers/promises');

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
bRun.classList = classListFor(bRun);
const label = el('span');
label.textContent = 'Run';
bRun.appendChild(label);
const spin = el('i');
spin.className = 'runspin';
bRun.appendChild(spin);

byId('code', 'textarea');
byId('inDefines', 'input');
byId('buildLog', 'pre');
byId('buildDet', 'details');
byId('stDot', 'i');
byId('stText', 'span');
byId('stage', 'div');
const buildTab = el('button');
buildTab.clicked = 0;
buildTab.click = () => { buildTab.clicked += 1; };

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
let wsShouldThrow = false;
let progressBody = { active: false };
let lastCompile = null;
global.fetch = (url, init) => {
  const u = String(url);
  if (u.includes('progress')) return Promise.resolve({ status: 200, json: async () => progressBody });
  if (u.includes('api/compile')) { lastCompile = { url: u, init: init || {} }; return compileReply; }
  return Promise.resolve({ status: 200, ok: true, json: async () => ({}) });
};
global.WebSocket = class {
  constructor() {
    if (wsShouldThrow) throw new Error('socket failed');
    this.readyState = 0;
  }
  send() {}
  close() { this.readyState = 3; }
};

require('./tools/load-parts');
require(path.join(__dirname, '../js/storage.js'));
require(path.join(__dirname, '../js/projects.js'));
require(path.join(__dirname, '../js/app.js'));

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
function busy() {
  assert.equal(bRun.disabled, true);
  assert.equal(label.textContent, 'Compiling…');
  assert.equal(bRun.classList.contains('spinning'), true);
}
function idle() {
  assert.equal(label.textContent, 'Run');
  assert.equal(bRun.disabled, false);
  assert.equal(bRun.classList.contains('spinning'), false);
}

test('Run stays busy for the whole compile, then restores', async () => {
  const pending = gate();
  compileReply = pending.promise;
  const flight = app.startRun();
  busy();
  pending.resolve(okResponse());
  await flight;
  idle();

  const limited = gate();
  compileReply = limited.promise;
  const limitedFlight = app.startRun();
  busy();
  limited.resolve({ status: 429, headers: { get: () => '2' }, json: async () => ({}) });
  await limitedFlight;
  idle();

  const failed = gate();
  compileReply = failed.promise;
  const failedFlight = app.startRun();
  busy();
  failed.resolve(okResponse({ ok: false, log: 'error: sketch.ino:1\n' }));
  await failedFlight;
  idle();
  assert.equal(buildTab.clicked, 1);

  wsShouldThrow = true;
  const dropped = gate();
  compileReply = dropped.promise;
  const droppedFlight = app.startRun();
  busy();
  dropped.resolve(okResponse({ id: 'build-2' }));
  await droppedFlight;
  idle();
  assert.equal(ids.stText.textContent, 'connection lost');
});

test('a queued compile says it is waiting, then the button returns to Run', async () => {
  progressBody = { active: false, wait: { reason: 'build', position: 2, message: 'Waiting for another build to finish… (position 2)' } };
  const pending = gate();
  compileReply = pending.promise;
  app.serialText = '';
  const flight = app.startRun();
  busy();
  await delay(20);
  assert.equal(label.textContent, 'Waiting…');
  assert.equal(bRun.disabled, true);
  assert.equal(bRun.classList.contains('spinning'), true);
  assert.equal(ids.stText.textContent, 'Waiting for another build to finish… (position 2)');
  assert.match(ids.buildLog.textContent, /Waiting for another build to finish… \(position 2\)/);
  assert.match(app.serialText, /\[Waiting for another build to finish… \(position 2\)\]/);
  const id = lastCompile.init.headers['X-Client-Id'];
  assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  progressBody = { active: false, wait: { reason: 'warm-up', position: 1, message: 'Preparing network stack (first run after restart), about 40 s…' } };
  await delay(450);
  assert.equal(label.textContent, 'Waiting…');
  assert.equal(ids.stText.textContent, 'Preparing network stack (first run after restart), about 40 s…');
  assert.match(app.serialText, /Preparing network stack \(first run after restart\), about 40 s…/);
  pending.resolve(okResponse());
  await flight;
  idle();
  progressBody = { active: false };

  const full = gate();
  compileReply = full.promise;
  const fullFlight = app.startRun();
  full.resolve({ status: 429, headers: { get: () => '3' }, json: async () => ({ ok: false, reason: 'full', log: 'Server busy, 4 builds queued — try again shortly' }) });
  await fullFlight;
  idle();
  assert.equal(ids.stText.textContent, 'Server busy, 4 builds queued — try again shortly');

  const timed = gate();
  compileReply = timed.promise;
  const timedFlight = app.startRun();
  timed.resolve({ status: 429, headers: { get: () => '3' }, json: async () => ({ ok: false, reason: 'timeout', log: 'Timed out waiting for a build slot after 120 s — try again shortly' }) });
  await timedFlight;
  idle();
  assert.equal(ids.stText.textContent, 'Timed out waiting for a build slot after 120 s — try again shortly');
  assert.equal(lastCompile.init.headers['X-Client-Id'], id);
});

test('the busy Run button is grey, keeps its spinner, and theme.css is cache-busted', () => {
  const css = fs.readFileSync(path.join(__dirname, '../css/theme.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const block = css.match(/#bRun\.spinning,#bRun\.spinning:hover\{([^}]*)\}/);
  assert.ok(block, 'spinning rule');
  assert.match(block[1], /background:var\(--l3\)/);
  assert.match(block[1], /box-shadow:none/);
  assert.doesNotMatch(block[1], /#22d3ee|#06b6d4|#67e8f9/);
  assert.match(css, /#bRun\.spinning \.runspin\{display:block;animation:runspin/);
  const v = html.match(/theme\.css\?v=(\d+)/);
  assert.ok(v && Number(v[1]) > 55);
});
