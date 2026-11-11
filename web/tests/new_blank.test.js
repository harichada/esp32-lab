// "+ New blank" chooser: Basic circuit vs ESP32 project templates.  node --test tests/new_blank.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Examples, Sim, Netlist, WEB } = require('./tools/load-parts');
const { ProjectStore } = require('../js/projects.js');

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const BLINKY = /digitalWrite|LED_BUILTIN|delay\s*\(/;

test('both blank kinds are offered', () => {
  assert.deepEqual(Examples.BLANK_KINDS, ['basic', 'esp32']);
  assert.throws(() => Examples.newBlank('arduino-uno'), /unknown blank kind/);
});

test('Basic circuit blank: bare breadboard, no ESP32, circuit mode, no Blink', () => {
  const p = Examples.newBlank('basic');
  assert.equal(p.mode, 'circuit');
  assert.deepEqual(p.parts.map((q) => q.type), ['breadboard']);
  assert.ok(!p.parts.some((q) => q.type === 'esp32'), 'Basic blank must not contain an ESP32');
  assert.equal(p.wires.length, 0);
  assert.ok(p.code !== Examples.BLINK && !BLINKY.test(p.code), 'Basic blank must not carry the Blink sketch');
  assert.ok(!/void\s+(setup|loop)/.test(p.code), 'Basic blank has no firmware sketch');
});

test('ESP32 blank: DevKit V1 on breadboard, empty sketch, real firmware (QEMU)', () => {
  const p = Examples.newBlank('esp32');
  assert.equal(p.mode, 'qemu');
  const types = p.parts.map((q) => q.type).sort();
  assert.deepEqual(types, ['breadboard', 'esp32']);
  assert.equal(p.code, 'void setup() {}\nvoid loop() {}\n');
  assert.equal(p.code, Examples.EMPTY_INO);
  assert.ok(p.code !== Examples.BLINK && !BLINKY.test(p.code), 'ESP32 blank must not carry the Blink sketch');
  assert.equal(p.wires.length, 0);
});

test('each call returns a fresh project (no shared part objects)', () => {
  for (const k of Examples.BLANK_KINDS) {
    const a = Examples.newBlank(k), b = Examples.newBlank(k);
    assert.notEqual(a, b); assert.notEqual(a.parts[0], b.parts[0]);
    a.parts[0].x = 999; assert.notEqual(b.parts[0].x, 999);
  }
});

test('blanks survive the project store round trip and keep their mode / code', () => {
  const s = new ProjectStore(mem(), null);
  for (const k of Examples.BLANK_KINDS) {
    const src = Examples.newBlank(k); const saved = s.importJson(src); const got = s.get(saved.id);
    assert.ok(got && got.id && !got.example, k + ' becomes a user project');
    assert.equal(got.mode, src.mode); assert.equal(got.code, src.code);
    assert.deepEqual(got.parts.map((q) => q.type), src.parts.map((q) => q.type));
  }
});

test('blanks build a netlist and simulate without errors', () => {
  for (const k of Examples.BLANK_KINDS) {
    const p = JSON.parse(JSON.stringify(Examples.newBlank(k)));
    if (Netlist && Netlist.migrate) Netlist.migrate(p);
    const sim = new Sim(p); for (let i = 0; i < 3; i++) sim.advance(0.01);
  }
});

test('the existing ?ex=blank example is unchanged (ESP32 board, QEMU)', () => {
  const p = Examples.EX.blank();
  assert.equal(p.mode, 'qemu'); assert.ok(p.parts.some((q) => q.type === 'esp32'));
});

test('Projects > + New blank opens the chooser instead of loading the Blink ESP32 blank', () => {
  const src = fs.readFileSync(path.join(WEB, 'js', 'app.js'), 'utf8');
  const line = src.split('\n').find((l) => /a === 'new'/.test(l));
  assert.ok(line, "projects dialog has a 'new' action");
  assert.match(line, /newBlankDialog\(/);
  assert.match(line, /Examples\.newBlank\(kind\)/);
  assert.doesNotMatch(line, /Examples\.BLINK|EX\.blank\(\)/);
  // chooser offers both options, is an accessible modal, and closes on Esc / Cancel / backdrop
  assert.match(src, /data-k="basic"/); assert.match(src, /data-k="esp32"/);
  assert.match(src, /role="dialog" aria-modal="true"/);
  assert.match(src, /e\.key === 'Escape'[^\n]*close\(\)/);
  assert.match(src, /e\.target === d\) \{ close\(\)/);
  assert.match(src, /data-a=cancel\]'\)\) close\(\)/);
});

test('opening or replacing a project clears the selection and empties the Inspector', () => {
  const src = fs.readFileSync(path.join(WEB, 'js', 'app.js'), 'utf8');
  const setProject = src.slice(src.indexOf('function setProject'), src.indexOf('async function loadExample'));
  assert.match(setProject, /app\.editor\.setProject\(app\.proj\)/);
  assert.match(setProject, /app\.editor\.select\(null\)/);
  assert.match(setProject, /app\.schematic\.sel = null/);
  // The Inspector is filled only from this hook, so select(null) is what paints it empty.
  assert.match(src, /selected:\s*\(s\)\s*=>\s*\{\s*renderInspector\(s\)/);
  assert.match(src, /function renderInspector\(sel\)[\s\S]*?if \(!sel\) \{ el\.innerHTML = '<p class="muted">Select a part or wire\.<\/p>'/);
  // Every replace path goes through setProject (New blank and file open via openProject).
  assert.match(src, /function openProject\(id\)[\s\S]*?setProject\(p\)/);
  assert.match(src, /async function loadExample\(k\)[\s\S]*?setProject\(ex/);
  assert.match(src, /function openFile\(f\)[\s\S]*?openProject\(p\.id\)/);
  const neu = src.split('\n').find((l) => /a === 'new'/.test(l));
  assert.match(neu, /openProject\(p\.id\)/);
});
