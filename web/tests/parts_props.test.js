// Property sweeps: every editable/default prop of every part, across
// min / typical / max / zero / negative / empty / invalid values.
// Asserts no throw and no NaN node voltages. Also checks that valid
// values show up in the part's svg label or readout when they can.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  P, allTypes, mk, editableAndProps, sweepCases, minimalProject, stepSim,
  nonFiniteVoltages, fmtShown,
} = require('./tools/part-helpers');

const TYPES = allTypes();

function isHarsh(kind) {
  return kind === 'invalid' || kind === 'empty' || kind === 'negative' || kind === 'below-min' || kind === 'above-max';
}

test('property sweeps do not throw or produce NaN voltages', { timeout: 180000 }, () => {
  const hard = [];       // throw / NaN — these fail the test
  const notes = [];      // interesting but non-fatal (coercion, missing labels)
  let swept = 0;
  let cases = 0;
  for (const type of TYPES) {
    const d = P.T[type];
    const fields = editableAndProps(type);
    if (!fields.length) continue;
    swept += fields.length;
    const defaults = d.props ? JSON.parse(JSON.stringify(d.props)) : {};
    for (const field of fields) {
      // breadboard.cols at huge values would create thousands of pins; cap it.
      const rawCases = sweepCases(field, defaults[field.k]);
      const list = rawCases.filter((c) => {
        if (type === 'breadboard' && field.k === 'cols' && typeof c.v === 'number' && (c.v > 80 || c.v < 0)) return false;
        if ((type === 'neopixel' || type === 'neoring') && field.k === 'n' && typeof c.v === 'number' && c.v > 200) return false;
        return true;
      });
      for (const c of list) {
        cases++;
        const tag = type + '.' + field.k + '=' + JSON.stringify(c.v) + ' (' + c.kind + ')';
        try {
          const props = {}; props[field.k] = c.v;
          const ctx = minimalProject(type, props);
          const part = ctx.part;
          if (typeof d.svg === 'function') d.svg(part, {});
          if (typeof d.readout === 'function') {
            // readout after a sim step is more meaningful; called below too.
          }
          const sim = stepSim(ctx.project, 2, 0.01);
          if (typeof d.readout === 'function') {
            try { d.readout(part, { state: () => sim.partState(part), main: () => null, I: () => 0, V: () => 0 }); }
            catch (_) { /* readout may need a full sim cx; try sim.readout */ }
            try { sim.readout(part); } catch (_) { /* some parts only work with the official cx */ }
          }
          const nan = nonFiniteVoltages(sim, ctx.project);
          if (nan.length) hard.push(tag + ' non-finite voltage ' + nan.map((x) => x.pin + '=' + x.v).join(','));
          if (!isHarsh(c.kind) && c.v !== undefined && c.v !== null && c.v !== '') {
            let svg = '';
            try { svg = d.svg(part, sim.partState(part)); } catch (_) { svg = ''; }
            let ro = '';
            try { ro = sim.readout(part) || ''; } catch (_) { ro = ''; }
            const shown = (svg + ' ' + ro);
            const needles = fmtShown(c.v).filter((s) => s && s !== '—' && s.trim());
            // Only require a visible update for values the artwork commonly prints.
            if (needles.length && field.t !== 'bool' && field.t !== 'text') {
              const hit = needles.some((n) => n && shown.includes(String(n).trim()));
              if (!hit && (field.t === 'val' || field.t === 'num' || field.t === 'sel' || field.t === 'range')) {
                // Soft: many props (imax, dropout, I2C addr on the underside, …) are not drawn.
                notes.push(tag + ' not visible in svg/readout');
              }
            }
          }
        } catch (e) {
          hard.push(tag + ' threw: ' + e.message);
        }
      }
    }
  }
  // Known defect (not fixed in this change): Sim.advance does
  //   this.scope[ch].push(...)
  // for whatever props.ch the probe was stamped with (sim.js, probes[p.props.ch || 1]).
  // ch=-1 and a non-numeric string are truthy, so they skip the `|| 1` fallback and crash.
  const known = hard.filter((h) => /^scope\.ch=/.test(h) && /reading 'push'/.test(h));
  const unexpected = hard.filter((h) => !known.includes(h));
  globalThis.__PART_PROP_SWEEP__ = { fields: swept, cases, hard: hard.length, known: known.length, unexpected: unexpected.length, notes: notes.length, knownList: known };
  console.log('property sweep: %d fields, %d cases, %d hard failures (%d known, %d unexpected), %d label notes',
    swept, cases, hard.length, known.length, unexpected.length, notes.length);
  if (known.length) known.forEach((n) => console.log('  known bug:', n));
  assert.deepEqual(unexpected, []);
  assert.ok(known.length >= 2, 'expected the scope.ch crash to still reproduce; remove the known-bug waiver if it is fixed');
});

test('scope probe: an out-of-range channel crashes Sim.advance (known bug)', () => {
  const { minimalProject, stepSim } = require('./tools/part-helpers');
  for (const ch of [-1, 'not-a-valid-option']) {
    const ctx = minimalProject('scope', { ch });
    assert.throws(() => stepSim(ctx.project, 2, 0.01), /push/);
  }
  // Valid channels still work.
  const ok = minimalProject('scope', { ch: 3 });
  const sim = stepSim(ok.project, 2, 0.01);
  assert.ok(sim);
});
