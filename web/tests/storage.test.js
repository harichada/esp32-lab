'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..');

function mem() {
  const m = new Map();
  return {
    map: m,
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
}

function loadStorage() {
  delete require.cache[require.resolve('../js/storage.js')];
  return require('../js/storage.js');
}

test('storage wrapper keeps today\'s keys when staging is off', () => {
  const local = mem();
  const session = mem();
  global.localStorage = local;
  global.sessionStorage = session;
  global.__CL_STAGING = false;
  const store = loadStorage();
  assert.equal(store.staging(), false);
  assert.equal(store.key('esp32lab.projects.v1'), 'esp32lab.projects.v1');
  store.local.setItem('esp32lab.theme', 'light');
  store.session.setItem('esp32client', 'tab1');
  assert.equal(local.getItem('esp32lab.theme'), 'light');
  assert.equal(session.getItem('esp32client'), 'tab1');
  assert.equal(store.local.getItem('esp32lab.theme'), 'light');
  store.local.removeItem('esp32lab.theme');
  assert.equal(local.getItem('esp32lab.theme'), null);
  assert.deepEqual([...local.map.keys()], []);
});

test('storage wrapper prefixes every key in staging mode', () => {
  const local = mem();
  const session = mem();
  global.localStorage = local;
  global.sessionStorage = session;
  global.__CL_STAGING = true;
  const store = loadStorage();
  assert.equal(store.staging(), true);
  assert.equal(store.key('esp32lab.theme'), 'esp32lab-staging:esp32lab.theme');
  store.local.setItem('esp32lab.projects.v1', '{}');
  store.local.setItem('netlog', '0');
  store.session.setItem('esp32run', '{}');
  store.session.setItem('esp32client', 'abc');
  for (const k of local.map.keys()) assert.ok(k.startsWith('esp32lab-staging:'), k);
  for (const k of session.map.keys()) assert.ok(k.startsWith('esp32lab-staging:'), k);
  assert.equal(store.local.getItem('esp32lab.projects.v1'), '{}');
  assert.equal(local.getItem('esp32lab.projects.v1'), null);
  store.session.removeItem('esp32run');
  assert.equal(session.getItem('esp32lab-staging:esp32run'), null);
  global.__CL_STAGING = false;
});

test('projects.js uses the wrapper and never writes an unprefixed key in staging', () => {
  const src = fs.readFileSync(path.join(WEB, 'js/projects.js'), 'utf8');
  assert.match(src, /clStorage\.local/);
  assert.doesNotMatch(src, /\blocalStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\b/);

  const touched = [];
  const box = new Map();
  const guard = {
    getItem(k) {
      touched.push(k);
      if (!String(k).startsWith('esp32lab-staging:')) throw new Error('unprefixed get ' + k);
      return box.has(k) ? box.get(k) : null;
    },
    setItem(k, v) {
      touched.push(k);
      if (!String(k).startsWith('esp32lab-staging:')) throw new Error('unprefixed set ' + k);
      box.set(k, String(v));
    },
    removeItem(k) {
      touched.push(k);
      if (!String(k).startsWith('esp32lab-staging:')) throw new Error('unprefixed del ' + k);
      box.delete(k);
    },
  };
  global.localStorage = guard;
  global.sessionStorage = guard;
  global.__CL_STAGING = true;
  loadStorage();
  delete require.cache[require.resolve('../js/projects.js')];
  const { ProjectStore } = require('../js/projects.js');
  const s = new ProjectStore();
  const id = s.save({ name: 'Stage', parts: [], wires: [] });
  assert.equal(s.current(), id);
  s.remove(id);
  assert.ok(touched.length > 0);
  for (const k of touched) assert.ok(String(k).startsWith('esp32lab-staging:'), k);
  global.__CL_STAGING = false;
});

test('app code does not touch localStorage or sessionStorage except through the wrapper', () => {
  const re = /\b(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem|clear|key)\b/;
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name === 'vendor' || name === 'tests') continue;
        walk(p);
      } else if (/\.(js|html)$/.test(name)) files.push(p);
    }
  }
  walk(path.join(WEB, 'js'));
  files.push(path.join(WEB, 'index.html'));
  for (const file of files) {
    if (file.endsWith(path.sep + 'storage.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, re, file);
  }
});

test('staging banner is in the first HTML, reserved, and not a dialog', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'css/theme.css'), 'utf8');
  const mobile = fs.readFileSync(path.join(WEB, 'css/mobile.css'), 'utf8');
  assert.match(html, /<div id="stageBanner" class="stage-banner" role="status">Test version: projects here may be deleted\.<\/div>/);
  assert.doesNotMatch(html, /id="stageBanner"[^>]*emoji|id="stageBanner"[^>]*>[^<]*[\u{1F300}-\u{1FAFF}]/u);
  assert.match(html, /js\/storage\.js\?v=1/);
  assert.match(html, /theme\.css\?v=60/);
  assert.match(html, /mobile\.css\?v=63/);
  assert.match(html, /app\.js\?v=71/);
  assert.match(html, /mobile\.js\?v=66/);
  assert.match(html, /projects\.js\?v=42/);
  assert.match(html, /ui\.js\?v=62/);
  assert.match(html, /netlog\.js\?v=41/);
  assert.match(css, /#stageBanner\{display:none\}/);
  assert.match(css, /html\[data-cl-env=staging\]\{--stage-h:40px\}/);
  assert.match(css, /background:#4a2f00;color:#fff4d4/);
  assert.match(css, /html\[data-cl-env=staging\] #main\{height:calc\(100% - 70px - var\(--stage-h\)\)\}/);
  assert.match(mobile, /html\[data-cl-env=staging\] body\.m #mTicker/);
  assert.match(mobile, /html\[data-cl-env=staging\] body\.m header#top\{top:var\(--stage-offset\)/);
  assert.doesNotMatch(mobile, /html\[data-cl-env=staging\] body\.m #bForce2d\{top:/);
  assert.match(mobile, /html\[data-cl-env=staging\] body\.m \.zoom-tools\{top:calc\(88px \+ var\(--stage-offset\)\)\}/);
  assert.doesNotMatch(html, /id="stageBanner"[^>]*tabindex/);
  assert.doesNotMatch(html, /id="stageBanner"[^>]*aria-modal/);
});
