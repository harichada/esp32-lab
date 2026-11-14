const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../js/statusstrip.js');

const LINE = "Can't reach the build server right now. Your work is safe; Run will work again when it's back.";
const SLOT = 'Timed out waiting for a build slot after 120 s — try again shortly';

function docWith(meta) {
  const head = { first: null };
  const strip = { textContent: '', hidden: true, className: '', attrs: {}, classList: { _c: new Set(), add(c) { this._c.add(c); }, contains(c) { return this._c.has(c); }, remove(c) { this._c.delete(c); } } };
  strip.setAttribute = (k, v) => { strip.attrs[k] = v; };
  strip.getAttribute = (k) => (k in strip.attrs ? strip.attrs[k] : null);
  strip.removeAttribute = (k) => { delete strip.attrs[k]; };
  const toast = { textContent: 'old', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const status = { textContent: '', hidden: false, attrs: {}, parentNode: null, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
  const doc = {
    querySelector(sel) {
      if (sel === 'meta[name="statusstrip"]') return meta ? { getAttribute: () => meta } : null;
      if (sel === '.runctl') return { parentNode: { insertBefore(el) { doc._mounted = el; }, removeChild() { doc._mounted = null; } }, nextSibling: null };
      return null;
    },
    getElementById(id) {
      if (id === 'compileStrip') return strip;
      if (id === 'mCompileToast') return toast;
      if (id === 'statusStrip') return doc._mounted && doc._mounted.id === 'statusStrip' ? doc._mounted : null;
      return null;
    },
    createElement() {
      return status;
    },
    _mounted: null,
    strip,
    toast,
    status,
  };
  status.id = 'statusStrip';
  status.parentNode = { removeChild() { doc._mounted = null; } };
  return doc;
}

test('the flag is off without the meta and on only for the explicit values', () => {
  assert.equal(S.enabled(docWith(null)), false);
  assert.equal(S.enabled(docWith('0')), false);
  assert.equal(S.enabled(docWith('')), false);
  assert.equal(S.enabled(docWith('1')), true);
  assert.equal(S.enabled(docWith('yes')), true);
  assert.equal(S.enabled({ querySelector: () => null }), false);
});

test('a read-only unchanged example has no copy', () => {
  const example = { example: 'blink', name: 'Blink', id: 'ex' };
  assert.equal(S.hasUserCopy(example, true, { get: () => example }), false);
  assert.equal(S.hasUserCopy(example, false, { get: () => example }), false);
  assert.equal(S.hasUserCopy({ id: 'p1', name: 'Mine' }, false, { get: () => null }), false);
  assert.equal(S.hasUserCopy({ id: 'p1', name: 'Mine' }, false, { get: (id) => id === 'p1' ? { id: 'p1' } : null }), true);
  assert.equal(S.hasUserCopy(null, false, { get: () => ({}) }), false);
});

test("It's saved. is added only when a user copy exists", () => {
  assert.equal(S.timeoutSentence(SLOT, false), SLOT);
  assert.equal(S.timeoutSentence(SLOT, true), SLOT + ". It's saved.");
  assert.equal(S.timeoutSentence(S.COMPILE_TIMEOUT_BASE, false), S.COMPILE_TIMEOUT_BASE);
  assert.equal(S.timeoutSentence(S.COMPILE_TIMEOUT_BASE, true), "The compile timed out. Press Run again. It's saved.");
  assert.equal(S.timeoutSentence('', true), "The compile timed out. Press Run again. It's saved.");
  const twice = S.timeoutSentence(SLOT + ". It's saved.", true);
  assert.equal(twice.split("It's saved.").length, 2);
});

test('a compiler timeout is recognised and other failures are not', () => {
  assert.equal(S.isCompileTimeout('Linking...\ncompile timed out (120s) - the first build after a restart compiles the ESP32 core; press Run again.\n'), true);
  assert.equal(S.isCompileTimeout("sketch.ino:3:2: error: expected ';' before '}' token"), false);
  assert.equal(S.isCompileTimeout(''), false);
});

test('the timeout sentence is text on the compile card and the phone toast is cleared', () => {
  const doc = docWith('1');
  const el = S.showTimeout(doc, SLOT + ". It's saved.");
  assert.equal(el, doc.strip);
  assert.equal(doc.strip.textContent, SLOT + ". It's saved.");
  assert.equal(doc.strip.hidden, false);
  assert.equal(doc.strip.classList.contains('timeout-card'), true);
  assert.equal(doc.strip.attrs.role, 'status');
  assert.equal(doc.strip.attrs['aria-live'], 'polite');
  assert.equal(doc.toast.textContent, '');
  assert.equal(doc.toast.hidden, true);
  S.clearTimeoutCard(doc);
  assert.equal(doc.strip.classList.contains('timeout-card'), false);
  assert.equal(doc.strip.attrs.role, undefined);
});

test('the build-server line is one sentence, and a repeat writes it again', async () => {
  const doc = docWith('1');
  const el = S.showDown(doc);
  assert.equal(el.textContent, LINE);
  assert.equal(el.attrs.role, 'status');
  assert.equal(el.attrs['aria-live'], 'polite');
  el.textContent = 'gone';
  S.repeat(doc);
  assert.equal(el.textContent, '');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(el.textContent, LINE);
  assert.equal(el.getAttribute('data-said'), '1');
  S.hideDown(doc);
  assert.equal(doc.getElementById('statusStrip'), null);
});

test('the module never builds HTML from a log', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/statusstrip.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|DOMParser|document\.write/);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /js\/statusstrip\.js\?v=5/);
  assert.match(html, /js\/app\.js\?v=85/);
  assert.doesNotMatch(html, /id="statusStrip"/);
  for (const banned of ['84', '86', '87', '88', '89']) assert.doesNotMatch(html, new RegExp('js/app\\.js\\?v=' + banned + '(?:\\D|$)'));
  assert.doesNotMatch(html, /js\/projects\.js\?v=48/);
  assert.doesNotMatch(html, /js\/schematic\.js\?v=71/);
});
