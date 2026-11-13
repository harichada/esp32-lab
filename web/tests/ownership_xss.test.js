const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
let Safe = null;
try { Safe = require('../js/safehtml.js'); } catch (e) { Safe = null; }
const { ProjectStore } = require('../js/projects.js');

const ATTACK = '<img src=x onerror=alert(1)>';
const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

function fileTabs(names, current) {
  if (Safe && /fileTabsHtml\(/.test(appSrc)) return Safe.fileTabsHtml(names, current, 'sketch.ino');
  return names.map((n) => `<button data-f="${n}" class="${n === current ? 'on' : ''}">${n === 'sketch' ? 'sketch.ino' : n}</button>`).join('')
    + '<button data-f="+" title="Add a header/source file">＋</button>';
}
function warnings(items) {
  if (Safe && /warnListHtml\(/.test(appSrc)) return Safe.warnListHtml(items);
  return items.map((x) => `<div class="w">⚠ ${x.id ? '<b>' + x.id + '</b>: ' : ''}${x.msg}</div>`).join('');
}
function partTitle(label, id) {
  if (Safe && /partTitleHtml\(/.test(appSrc)) return Safe.partTitleHtml(label, id);
  return `<h3>${label} <small>${id}</small></h3>`;
}
function rangeBox(field, value) {
  if (Safe && /rangeControlHtml\(/.test(appSrc)) return Safe.rangeControlHtml(field, value);
  return `<label>${field.label}<input type="range" data-k="${field.k}" min="${field.min}" max="${field.max}" step="${field.step}" value="${value}"></label>`;
}

test('a file name with a tag renders as text', () => {
  const html = fileTabs(['sketch', ATTACK + '.h'], 'sketch');
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /&lt;img/);
  assert.match(appSrc, /fileTabsHtml\(/);
});

test('a warning id and a part id render as text', () => {
  const warn = warnings([{ id: ATTACK, msg: 'check the wire' }]);
  const title = partTitle('LED', ATTACK);
  assert.ok(!warn.includes('<img'), warn);
  assert.ok(!title.includes('<img'), title);
  assert.match(warn, /&lt;img/);
  assert.match(title, /&lt;img/);
  assert.match(appSrc, /warnListHtml\(/);
  assert.match(appSrc, /partTitleHtml\(/);
});

test('a range value renders as text', () => {
  const html = rangeBox({ k: 'pos', label: 'Wiper', min: 0, max: 1, step: 0.01 }, ATTACK);
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /&lt;img/);
  assert.match(appSrc, /rangeControlHtml\(/);
});

test('import rejects a bad file name, part id, and non-finite values', () => {
  require('../js/parts.js');
  const s = new ProjectStore(mem(), null);
  const base = { name: 'Imported', parts: [{ id: 'LED1', type: 'led', props: {} }], wires: [] };
  assert.throws(() => s.importJson(Object.assign({}, base, { files: { [ATTACK + '.h']: 'int x;' } })), /file name/i);
  assert.throws(() => s.importJson({ name: 'Imported', parts: [{ id: ATTACK, type: 'led' }], wires: [] }), /part id/i);
  assert.throws(() => s.importJson({ name: 'Imported', parts: [{ id: 'POT1', type: 'potentiometer', props: { pos: NaN } }], wires: [] }), /finite/i);
  assert.throws(() => s.importJson({ name: 'Imported', parts: [{ id: 'POT1', type: 'potentiometer', props: { pos: Infinity } }], wires: [] }), /finite/i);
  assert.throws(() => s.importJson({ name: 'Imported', parts: [{ id: 'POT1', type: 'potentiometer', props: { pos: 5 } }], wires: [] }), /between 0 and 1/);
  const ok = s.importJson({ name: 'Imported', parts: [{ id: 'POT1', type: 'potentiometer', props: { r: '10k', pos: 0.5 } }], wires: [] });
  assert.strictEqual(ok.parts[0].props.pos, 0.5);
});

test('the edit fragment is stored and stripped from the address', () => {
  const s = new ProjectStore(mem(), null);
  const loc = { pathname: '/', search: '?p=abc', hash: '#edit=' + encodeURIComponent('sek ret') };
  let next = null;
  const history = { replaceState: (_a, _b, url) => { next = url; } };
  if (typeof s.consumeEditFragment === 'function') s.consumeEditFragment(loc, history);
  const stored = typeof s.secretFor === 'function' ? s.secretFor('abc') : '';
  assert.strictEqual(loc.hash, '');
  assert.strictEqual(stored, 'sek ret');
  assert.ok(next && next.indexOf('#') < 0 && next.indexOf('sek') < 0, String(next));
  assert.strictEqual(typeof s.shareUrl, 'function');
  const share = s.shareUrl('http://127.0.0.1/?ex=blink', 'abc');
  assert.ok(share.indexOf('edit=') < 0 && share.indexOf('#') < 0);
  const edit = s.editUrl('http://127.0.0.1/?t=sitegate', 'abc', 'sek ret');
  assert.ok(edit.indexOf('#edit=') > 0);
  assert.ok(!edit.split('#')[0].includes('sek'));
});
