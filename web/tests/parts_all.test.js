// Data-driven coverage of every registered part: pins, artwork, netlist,
// schematic, BOM and a minimal simulation.  node --test tests/parts_all.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  P, N, Schematic, B, allTypes, mk, pinsOf, uniquePinIssues, hasBomEntry,
  minimalProject, stepSim, nonFiniteVoltages, NO_ELECTRICAL, HIDDEN_IN_SCHEMATIC,
} = require('./tools/part-helpers');

const TYPES = allTypes();

test('the catalog has a stable, complete set of part types', () => {
  assert.ok(TYPES.length >= 100, 'expected at least 100 registered types, got ' + TYPES.length);
  assert.ok(TYPES.includes('resistor') && TYPES.includes('esp32') && TYPES.includes('relay1'));
  // Loading add-on files in the wrong order silently drops actuators / keypad / basic sources.
  for (const t of ['keypad', 'battery9v', 'relay1', 'lm7805', 'lcd2004']) {
    assert.ok(P.T[t], 'missing ' + t + ' — check script load order');
  }
});

test('every part instantiates with default props, unique pins, and artwork', () => {
  const problems = [];
  for (const type of TYPES) {
    const d = P.T[type];
    if (!d) { problems.push(type + ' not registered'); continue; }
    if (!d.label) problems.push(type + ' missing label');
    if (!d.cat) problems.push(type + ' missing category');
    let part;
    try { part = mk(type); }
    catch (e) { problems.push(type + ' instantiate: ' + e.message); continue; }
    let pins;
    try { pins = pinsOf(part); }
    catch (e) { problems.push(type + ' pins(): ' + e.message); continue; }
    if (!Array.isArray(pins)) { problems.push(type + ' pins() did not return an array'); continue; }
    problems.push(...uniquePinIssues(part).map((m) => type + ' ' + m));
    if (typeof d.svg !== 'function') { problems.push(type + ' has no svg()'); continue; }
    let svg;
    try { svg = d.svg(part, null); }
    catch (e) { problems.push(type + ' svg(null): ' + e.message); continue; }
    try { d.svg(part, {}); }
    catch (e) { problems.push(type + ' svg({}): ' + e.message); }
    if (typeof svg !== 'string') problems.push(type + ' svg() did not return a string');
    else if (pins.length && !/data-pin/.test(svg)) problems.push(type + ' svg() has no data-pin markers');
  }
  assert.deepEqual(problems, []);
});

test('every part appears in a netlist and schematic build without error', () => {
  const problems = [];
  for (const type of TYPES) {
    let ctx;
    try { ctx = minimalProject(type); }
    catch (e) { problems.push(type + ' project: ' + e.message); continue; }
    try {
      const nl = N.extract(ctx.project);
      if (!nl || !Array.isArray(nl.nets)) problems.push(type + ' netlist missing nets');
    } catch (e) {
      problems.push(type + ' netlist: ' + e.message);
    }
    try {
      const model = Schematic.layout(ctx.project);
      const svg = Schematic.toSvg(model);
      if (HIDDEN_IN_SCHEMATIC.has(type)) {
        if (model.symbols && model.symbols.some((s) => s.part && s.part.type === type)) {
          problems.push(type + ' should be hidden in the schematic');
        }
      } else if (type === 'ground') {
        // Ground is drawn as a rail symbol, not a boxed part symbol.
        const rails = (model.rails || []).filter((r) => r.kind === 'gnd');
        if (!rails.length && !(svg || '').includes('gnd') && !(svg || '').includes('GND')) {
          problems.push(type + ' missing ground rail in the schematic');
        }
      } else if (NO_ELECTRICAL.has(type)) {
        // A text label may show up as a symbol or as free text; just require a draw.
        if (typeof svg !== 'string' || !svg.length) problems.push(type + ' schematic svg empty');
      } else {
        const symbols = (model.symbols || []).filter((s) => s.part && s.part.type === type);
        if (!symbols.length) problems.push(type + ' missing schematic symbol');
      }
      if (typeof svg !== 'string' || !svg.length) problems.push(type + ' schematic toSvg empty');
    } catch (e) {
      problems.push(type + ' schematic: ' + e.message);
    }
  }
  assert.deepEqual(problems, []);
});

test('every part with a BOM catalog entry appears in Bom.list', () => {
  const problems = [];
  for (const type of TYPES) {
    if (!hasBomEntry(type)) continue;
    const part = mk(type);
    let list;
    try { list = B.list({ parts: [part], wires: [], mode: 'circuit' }); }
    catch (e) { problems.push(type + ' bom: ' + e.message); continue; }
    const hit = (list || []).some((e) => e.key === type || (e.key && e.key.startsWith(type)) || e.name);
    // Catalog entries are functions of props; the list should include something other than just breadboard/jumpers.
    // The breadboard catalog line is keyed 'bb' (jumpers are 'jw').
    const useful = (list || []).filter((e) => {
      if (type === 'breadboard') return e.key === 'bb' || e.key === 'breadboard';
      return e.key !== 'bb' && e.key !== 'jw' && e.key !== 'breadboard';
    });
    if (!useful.length) problems.push(type + ' BOM list has no catalog line (got ' + JSON.stringify(list) + ')');
    void hit;
  }
  assert.deepEqual(problems, []);
});

test('every part can be simulated in a minimal circuit without throw or NaN voltages', { timeout: 120000 }, () => {
  const problems = [];
  const table = [];
  for (const type of TYPES) {
    const row = { type, ok: true, detail: '' };
    try {
      const ctx = minimalProject(type);
      const sim = stepSim(ctx.project, 3, 0.01);
      const nan = nonFiniteVoltages(sim, ctx.project);
      if (nan.length) {
        row.ok = false;
        row.detail = 'NaN/non-finite: ' + nan.map((x) => x.type + ':' + x.pin + '=' + x.v).join(', ');
        problems.push(type + ' ' + row.detail);
      }
    } catch (e) {
      row.ok = false;
      row.detail = e.message;
      problems.push(type + ' sim: ' + e.message);
    }
    table.push(row);
  }
  if (problems.length) {
    const failed = table.filter((r) => !r.ok).map((r) => r.type + ': ' + r.detail).join('\n');
    assert.fail(problems.length + ' parts failed minimal simulation:\n' + failed);
  }
  assert.equal(table.length, TYPES.length);
});
