// The phone ··· button is named "More options" and the Examples menu has a real label.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function el(tag, attrs, text) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: (attrs && attrs.id) || '',
    className: (attrs && (attrs.class || attrs.className)) || '',
    textContent: text || '',
    attrs: Object.assign({}, attrs),
    childNodes: [],
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
  };
  return node;
}
function walk(node, out) {
  out.push(node);
  for (const c of node.childNodes || []) walk(c, out);
}
function all() {
  const out = [];
  walk(document.body, out);
  return out;
}
function accName(node) {
  const labelled = node.getAttribute && node.getAttribute('aria-labelledby');
  if (labelled) {
    return labelled.split(/\s+/).map((id) => {
      const hit = all().find((n) => n.id === id);
      return hit ? hit.textContent : '';
    }).join(' ').replace(/\s+/g, ' ').trim();
  }
  const label = node.getAttribute && node.getAttribute('aria-label');
  if (label) return label;
  return String(node.textContent || '').replace(/\s+/g, ' ').trim();
}
function getByRole(role, opts) {
  const hits = all().filter((n) => {
    const tag = n.tagName && n.tagName.toLowerCase();
    const implicit = tag === 'button' ? 'button' : tag === 'select' ? 'combobox' : '';
    return implicit === role && accName(n) === opts.name;
  });
  assert.equal(hits.length, 1, 'getByRole ' + role + ' ' + opts.name);
  return hits[0];
}
function getByLabel(text) {
  const labels = all().filter((n) => n.tagName === 'LABEL' && String(n.textContent).trim() === text);
  assert.equal(labels.length, 1, 'label ' + text);
  const id = labels[0].getAttribute('for');
  const ctl = all().find((n) => n.id === id);
  assert.ok(ctl, 'control for ' + text);
  return ctl;
}

const src = fs.readFileSync(path.join(__dirname, '../js/mobile.js'), 'utf8');
const buttonTag = src.match(/<button id="mMenu"[^>]*>/);
assert.ok(buttonTag, 'more button markup');
const buttonAttrs = {};
for (const hit of buttonTag[0].matchAll(/([\w:-]+)="([^"]*)"/g)) buttonAttrs[hit[1]] = hit[2];
const labelTag = src.match(/<label class="m-lbl" for="mSelExample">Examples<\/label>/);
assert.ok(labelTag, 'examples label markup');

const body = el('body', {});
body.dataset = {};
body.classList = { contains() { return false; }, toggle() {}, add() {}, remove() {} };
body.appendChild(el('button', buttonAttrs));
body.appendChild(el('label', { class: 'm-lbl', for: 'mSelExample' }, 'Examples'));
body.appendChild(el('select', { id: 'mSelExample' }));
const document = {
  body,
  documentElement: { getAttribute() { return null; }, setAttribute() {} },
  getElementById(id) { return all().find((n) => n.id === id) || null; },
  querySelector(sel) { return sel.charAt(0) === '#' ? document.getElementById(sel.slice(1)) : null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
global.document = document;
global.window = global;
global.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
global.addEventListener = () => {};
global.setTimeout = () => 0;
require(path.join(__dirname, '../js/mobile.js'));

test('getByRole finds More options and aria-expanded tracks the sheet', () => {
  const btn = getByRole('button', { name: 'More options' });
  assert.equal(btn.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.getAttribute('aria-controls'), 'mMore');
  global.Mobile.setSheet('more');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(document.body.dataset.msheet, 'more');
  global.Mobile.setSheet('parts');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  global.Mobile.setSheet('more');
  assert.equal(getByRole('button', { name: 'More options' }).getAttribute('aria-expanded'), 'true');
  global.Mobile.setSheet(null);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(document.body.dataset.msheet, '');
});

test('getByLabel finds the Examples dropdown in the More sheet', () => {
  const ctl = getByLabel('Examples');
  assert.equal(ctl.tagName, 'SELECT');
  assert.equal(ctl.id, 'mSelExample');
});
