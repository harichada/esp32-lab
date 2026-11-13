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
    global.WebSocket.last = this;
  }
  send() {}
  close() { this.readyState = 3; }
};
global.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

require('./tools/load-parts');
require(path.join(__dirname, '../js/storage.js'));
require(path.join(__dirname, '../js/projects.js'));
require(path.join(__dirname, '../js/app.js'));
require(path.join(__dirname, '../js/mobile.js'));

const mIgnite = byId('mIgnite', 'button');
mIgnite.setAttribute('aria-label', 'Run');
const igUse = el('use');
igUse.setAttribute('href', '#i-play');
const igT = el('span');
igT.className = 'm-ig-t';
igT.textContent = 'RUN';
mIgnite.appendChild(igUse);
mIgnite.appendChild(igT);
mIgnite.querySelector = (sel) => {
  if (sel === 'use') return igUse;
  if (sel === '.m-ig-t') return igT;
  if (sel === 'span') return igT;
  return null;
};

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
function phoneCompiling() {
  global.Mobile.syncIgnite();
  assert.equal(mIgnite.disabled, false);
  assert.equal(mIgnite.tabIndex, 0);
  assert.equal(mIgnite.classList.contains('compiling'), true);
  assert.equal(mIgnite.classList.contains('live'), false);
  assert.equal(mIgnite.getAttribute('aria-label'), 'Compiling…');
  assert.equal(mIgnite.getAttribute('title'), 'Compiling…');
  assert.equal(mIgnite.getAttribute('aria-busy'), 'true');
  assert.equal(mIgnite.getAttribute('aria-disabled'), 'true');
  assert.equal(mIgnite.title, 'Compiling…');
}
function phoneRun() {
  global.Mobile.syncIgnite();
  assert.equal(mIgnite.disabled, false);
  assert.equal(mIgnite.tabIndex, 0);
  assert.equal(mIgnite.classList.contains('compiling'), false);
  assert.equal(mIgnite.classList.contains('live'), false);
  assert.equal(mIgnite.getAttribute('aria-label'), 'Run');
  assert.equal(mIgnite.getAttribute('title'), 'Run');
  assert.equal(mIgnite.getAttribute('aria-busy'), 'false');
  assert.equal(mIgnite.getAttribute('aria-disabled'), 'false');
  assert.equal(igT.textContent, 'RUN');
  assert.equal(igUse.getAttribute('href'), '#i-play');
}
function phoneStop() {
  global.Mobile.syncIgnite();
  assert.equal(mIgnite.disabled, false);
  assert.equal(mIgnite.tabIndex, 0);
  assert.equal(mIgnite.classList.contains('compiling'), false);
  assert.equal(mIgnite.classList.contains('live'), true);
  assert.equal(mIgnite.getAttribute('aria-label'), 'Stop');
  assert.equal(mIgnite.getAttribute('title'), 'Stop');
  assert.equal(mIgnite.getAttribute('aria-busy'), 'false');
  assert.equal(mIgnite.getAttribute('aria-disabled'), 'false');
  assert.equal(igT.textContent, 'STOP');
  assert.equal(igUse.getAttribute('href'), '#i-stop');
}

test('Run stays busy for the whole compile, then restores', async () => {
  const pending = gate();
  compileReply = pending.promise;
  const flight = app.startRun();
  busy();
  phoneCompiling();
  pending.resolve(okResponse());
  await flight;
  idle();
  // The desktop label returns to Run when the HTTP compile finishes. The phone
  // button stays on Compiling… until the run socket actually opens.
  phoneCompiling();
  assert.equal(typeof global.WebSocket.last.onopen, 'function');
  global.WebSocket.last.onopen();
  phoneStop();

  const limited = gate();
  compileReply = limited.promise;
  const limitedFlight = app.startRun();
  busy();
  limited.resolve({ status: 429, headers: { get: () => '2' }, json: async () => ({}) });
  await limitedFlight;
  idle();
  phoneRun();

  const failed = gate();
  compileReply = failed.promise;
  const failedFlight = app.startRun();
  busy();
  failed.resolve(okResponse({ ok: false, log: 'error: sketch.ino:1\n' }));
  await failedFlight;
  idle();
  phoneRun();
  assert.equal(buildTab.clicked, 1);

  wsShouldThrow = true;
  const dropped = gate();
  compileReply = dropped.promise;
  const droppedFlight = app.startRun();
  busy();
  dropped.resolve(okResponse({ id: 'build-2' }));
  await droppedFlight;
  idle();
  phoneRun();
  assert.equal(ids.stText.textContent, 'connection lost');

  const origFetch = global.fetch;
  const origTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => (ms >= 1000 ? (fn(), 0) : origTimeout(fn, ms, ...a));
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('api/compile') && !u.includes('progress')) return Promise.reject(new Error('offline'));
    return origFetch(url, opts);
  };
  try {
    const offline = app.startRun();
    phoneCompiling();
    await offline;
    idle();
    phoneRun();
    assert.equal(app.run, null);
  } finally {
    global.fetch = origFetch;
    global.setTimeout = origTimeout;
  }
});

test('the phone Run button is a tab stop, and Enter and Space follow idle, compiling, and running', () => {
  const handlers = {};
  mIgnite.addEventListener = (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); };
  global.Mobile.bindIgnite(mIgnite);
  let runs = 0, stops = 0;
  bRun.click = () => { runs += 1; };
  const bStop = byId('bStop', 'button');
  bStop.click = () => { stops += 1; };
  document.body.classList.remove('busy', 'running');
  bRun.classList.remove('spinning');
  bRun.disabled = false;
  app.run = null;
  phoneRun();
  const fire = (key) => handlers.keydown.forEach((fn) => fn({ key: key, preventDefault() {}, repeat: false }));
  fire('Tab');
  assert.equal(runs, 0);
  fire('Enter');
  fire(' ');
  assert.equal(runs, 2);
  assert.equal(stops, 0);
  document.body.classList.add('busy');
  bRun.classList.add('spinning');
  bRun.disabled = true;
  app.run = { kind: 'qemu' };
  phoneCompiling();
  fire('Enter');
  fire(' ');
  assert.equal(runs, 2, 'compiling ignores Enter and Space');
  assert.equal(stops, 0);
  document.body.classList.remove('busy');
  document.body.classList.add('running');
  bRun.classList.remove('spinning');
  phoneStop();
  fire('Enter');
  fire(' ');
  assert.equal(stops, 2);
  assert.equal(runs, 2);
  document.body.classList.remove('running');
  app.run = null;
  phoneRun();
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
  const mobile = fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8');
  for (const state of [':hover', ':active', ':focus-visible', ':disabled', '[aria-disabled="true"]']) {
    assert.match(mobile, new RegExp('#mIgnite\\.compiling' + state.replace('[', '\\[')));
  }
  const phone = mobile.match(/body\.m #mIgnite\.compiling,body\.m #mIgnite\.compiling:disabled,body\.m #mIgnite\.compiling\[aria-disabled="true"\]\{([^}]*)\}/);
  assert.ok(phone, 'phone compiling rule');
  assert.match(phone[1], /background:#1b1f24!important/);
  assert.match(phone[1], /color:#e8eaed/);
  assert.match(phone[1], /box-shadow:none/);
  assert.match(phone[1], /width:76px;height:76px/);
  assert.doesNotMatch(phone[1], /opacity:\.72|#22d3ee|#06b6d4|#67e8f9/);
  assert.match(mobile, /#mIgnite\.compiling::after\{[^}]*position:absolute;[^}]*animation:runspin/);
  assert.match(mobile, /#mIgnite\.compiling \.m-ig-bg\{[^}]*stroke-dasharray:none/);
  assert.match(mobile, /html\[data-theme=light\] body\.m #mIgnite\.compiling[^\{]*\{[^}]*background:#eceef1!important;[^}]*color:#2c333c/);
  const rel = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
  };
  const ratio = (a, b) => { const x = rel(a), y = rel(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  assert.ok(ratio('#e8eaed', '#1b1f24') >= 4.5, 'dark compiling');
  assert.ok(ratio('#ffffff', '#2a3038') >= 4.5, 'dark hover');
  assert.ok(ratio('#e8eaed', '#12161b') >= 4.5, 'dark active');
  assert.ok(ratio('#2c333c', '#eceef1') >= 4.5, 'light compiling');
  assert.ok(ratio('#15181c', '#e2e5e9') >= 4.5, 'light hover');
  assert.ok(ratio('#15181c', '#d5d9df') >= 4.5, 'light active');
  assert.ok(ratio('#0891b2', '#f7f8fa') >= 3 && ratio('#0891b2', '#08090b') >= 3, 'focus ring against both canvases');
  const mv = html.match(/mobile\.css\?v=(\d+)/);
  assert.ok(mv && Number(mv[1]) > 59);
});
