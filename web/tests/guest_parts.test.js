'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const G = require('../js/guestparts.js');

function meta(content) {
  global.document = {
    querySelector(sel) {
      if (sel === 'meta[name="guestparts"]' && content != null) return { getAttribute: () => content };
      return null;
    },
  };
}

test('the limit is off without the meta and on with the starter list', () => {
  meta(null);
  assert.equal(G.enabled(), false);
  assert.equal(G.blocks('servo'), false);
  meta('esp32,breadboard,led,resistor,pushbutton,potentiometer,buzzer,ground,vcc33,vcc5,label');
  G.noteSession({ signed_in: false });
  assert.equal(G.enabled(), true);
  assert.equal(G.allowed('led'), true);
  assert.equal(G.allowed('irled'), false);
  assert.equal(G.blocks('led'), false);
  assert.equal(G.blocks('servo'), true);
  assert.equal(G.projectBlocked({ parts: [{ type: 'esp32' }, { type: 'led' }, { type: 'resistor' }] }), false);
  assert.equal(G.projectBlocked({ parts: [{ type: 'esp32' }, { type: 'servo' }] }), true);
  G.noteSession({ signed_in: true });
  assert.equal(G.blocks('servo'), false);
  assert.equal(G.projectBlocked({ parts: [{ type: 'servo' }] }), false);
  G.noteSession({ signed_in: false });
});

test('a locked palette part shows the sentence and a click opens sign-in', () => {
  meta('esp32,led,resistor');
  G.noteSession({ signed_in: false });
  let prompted = 0;
  global.GuestParts = G;
  global.clAuth = { openMenu() { prompted += 1; return true; } };
  const spans = [];
  const el = {
    dataset: { type: 'servo' },
    draggable: true,
    className: 'pitem',
    attrs: {},
    children: [],
    classList: { add(c) { this._ = (this._ || []).concat(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    querySelector() { return { textContent: 'Servo' }; },
    querySelectorAll() { return []; },
    appendChild(node) { this.children.push(node); return node; },
  };
  global.document.createElement = (tag) => {
    const node = { tag, className: '', attrs: {}, children: [], textContent: '' };
    node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
    node.appendChild = (c) => { node.children.push(c); return c; };
    node.append = (...xs) => node.children.push(...xs);
    if (tag === 'span') spans.push(node);
    return node;
  };
  global.document.createElementNS = () => global.document.createElement('svg');
  G.markPart(el);
  assert.equal(el.attrs['aria-disabled'], 'true');
  assert.equal(el.attrs.role, 'button');
  assert.equal(el.attrs.tabindex, '0');
  assert.equal(el.attrs.title, 'Sign in free to use this part');
  assert.equal(el.draggable, false);
  assert.equal(spans.some((s) => s.textContent === 'Sign in free to use this part'), true);
  G.prompt();
  assert.equal(prompted, 1);
  const src = fs.readFileSync(path.join(__dirname, '../js/guestparts.js'), 'utf8');
  assert.match(src, /aria-disabled/);
  assert.match(src, /Sign in free to use this part/);
});

test('blink uses only starter parts and a servo example does not', () => {
  meta('esp32,breadboard,led,resistor,pushbutton,potentiometer,buzzer,ground,vcc33,vcc5,label');
  G.noteSession({ signed_in: false });
  global.Examples = {
    EX: {
      blink: () => ({ parts: [{ type: 'breadboard' }, { type: 'esp32' }, { type: 'resistor' }, { type: 'led' }] }),
      servo: () => ({ parts: [{ type: 'esp32' }, { type: 'servo' }] }),
    },
  };
  assert.equal(G.exampleLocked('blink'), false);
  assert.equal(G.exampleLocked('servo'), true);
});

test('pot, fade, and the JS pot stay open because ground is a starter symbol', () => {
  require('../js/parts.js');
  require('../js/examples.js');
  meta('esp32,breadboard,led,resistor,pushbutton,potentiometer,buzzer,ground,vcc33,vcc5,label');
  G.noteSession({ signed_in: false });
  for (const key of ['pot', 'fade', 'potjs']) {
    assert.equal(G.exampleLocked(key), false, key);
    const types = globalThis.Examples.EX[key]().parts.map((p) => p.type);
    for (const type of types) assert.equal(G.allowed(type), true, key + ' ' + type);
  }
  assert.equal(G.allowed('ground'), true);
  assert.equal(G.allowed('vcc33'), true);
  assert.equal(G.allowed('vcc5'), true);
  assert.equal(G.allowed('label'), true);
  assert.equal(G.allowed('servo'), false);
});
