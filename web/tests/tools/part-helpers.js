// Shared helpers for the data-driven part tests.
'use strict';
const { Parts: P, Sim, Netlist: N, Schematic, Bom: B, allTypes } = require('./load-parts');

const SOURCE_TYPES = new Set([
  'vcc33', 'vcc5', 'battery', 'battery9v', 'aapack', 'coincell', 'bench', 'cell18650',
]);
const NO_ELECTRICAL = new Set(['label']);
const HIDDEN_IN_SCHEMATIC = new Set(['breadboard']);
const POS_NAMES = ['VCC', 'VDD', 'VIN', 'V+', '+5V', '3V3', 'IN+', 'VMOT'];
const GND_NAMES = ['GND', 'GND.1', 'GND.2', 'VSS', 'IN-', 'OUT-'];
// Only used when no VCC-like name is present (battery/motor/meter terminals).
const POS_FALLBACK = ['+', 'P'];
const GND_FALLBACK = ['-'];

let uid = 0;
function nextId(prefix) { return (prefix || 'x') + (++uid); }

function mk(type, props = {}, x = 0, y = 0, id) {
  const d = P.T[type];
  if (!d) throw new Error('unknown part type ' + type);
  const defaults = d.props ? JSON.parse(JSON.stringify(d.props)) : {};
  return { id: id || nextId(type), type, x, y, rot: 0, props: Object.assign(defaults, props) };
}

function pinsOf(part) {
  const d = P.T[part.type];
  return d.pins ? d.pins(part) || [] : [];
}

function pinByName(part, name) {
  const pin = pinsOf(part).find((q) => q.name === name);
  if (!pin) throw new Error(part.type + ' has no pin ' + name);
  return P.pinWorld(part, pin);
}

function w(a, b) { return { id: nextId('w'), a, b, pts: [], color: 'green' }; }

function place(parts, pitch = 120) {
  parts.forEach((p, i) => { p.x = (i % 8) * pitch; p.y = Math.floor(i / 8) * pitch + 40; });
  return parts;
}

function projFromNets(parts, nets, extraWires = []) {
  place(parts);
  const wires = extraWires.slice();
  for (const net of nets) {
    const a = net[0];
    for (const b of net.slice(1)) wires.push(w(pinByName(a[0], a[1]), pinByName(b[0], b[1])));
  }
  return { name: 't', mode: 'circuit', parts, wires };
}

function findPin(part, names) {
  const have = new Set(pinsOf(part).map((q) => q.name));
  return names.find((n) => have.has(n));
}

function isBjt(part) {
  const names = pinsOf(part).map((q) => q.name);
  return names.includes('E') && names.includes('B') && names.includes('C');
}

function isMosfet(part) {
  const names = pinsOf(part).map((q) => q.name);
  return names.includes('G') && names.includes('D') && names.includes('S');
}

function diodeLike(part) {
  const names = pinsOf(part).map((q) => q.name);
  if (names.length !== 2) return null;
  if (names.includes('A') && names.includes('K')) return { a: 'A', k: 'K' };
  if (names.includes('A') && names.includes('C')) return { a: 'A', k: 'C' };
  return null;
}

// Build a small project that exercises `type` without shorting a supply.
function minimalProject(type, props = {}) {
  const part = mk(type, props);
  const load = mk('resistor', { r: 1000 }, 0, 0, nextId('RL'));
  const nets = [];
  let parts, supply, gnd;

  if (type === 'ground') {
    supply = mk('vcc5');
    gnd = part;
    parts = [part, supply, load];
    nets.push([[supply, '+'], [load, '1']], [[load, '2'], [gnd, 'GND'], [supply, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  if (SOURCE_TYPES.has(type)) {
    gnd = mk('ground');
    parts = [part, gnd, load];
    const pos = findPin(part, ['+', 'OUT+', '3V3', 'VIN']) || findPin(part, POS_NAMES.concat(POS_FALLBACK));
    const neg = findPin(part, ['-', 'OUT-', 'GND', 'GND.1']) || findPin(part, GND_NAMES.concat(GND_FALLBACK));
    if (pos && neg) {
      nets.push([[part, pos], [load, '1']], [[load, '2'], [part, neg], [gnd, 'GND']]);
    } else {
      parts = [part, gnd];
    }
    return { project: projFromNets(parts, nets), part, gnd, load };
  }

  supply = mk('vcc5');
  gnd = mk('ground');
  parts = [part, supply, gnd, load];
  nets.push([[supply, 'GND'], [gnd, 'GND']]);

  if (NO_ELECTRICAL.has(type) || type === 'breadboard') {
    // Supplies present but not wired to the part (breadboard has 842 grouped holes).
    nets.push([[supply, '+'], [load, '1']], [[load, '2'], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  if (isBjt(part)) {
    // Common-emitter, base pulled down (cutoff) — safe, no short.
    const rb = mk('resistor', { r: 10000 }, 0, 0, nextId('RB'));
    parts.push(rb);
    nets.push([[supply, '+'], [load, '1']], [[load, '2'], [part, 'C']], [[part, 'E'], [gnd, 'GND']], [[part, 'B'], [rb, '1']], [[rb, '2'], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  if (isMosfet(part)) {
    nets.push([[supply, '+'], [load, '1']], [[load, '2'], [part, 'D']], [[part, 'S'], [part, 'G'], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  const pos = findPin(part, POS_NAMES) || findPin(part, POS_FALLBACK);
  const neg = findPin(part, GND_NAMES) || findPin(part, GND_FALLBACK);
  const out = findPin(part, ['VOUT', 'OUT', 'OUT+']);

  if (pos && neg) {
    nets.push([[supply, '+'], [part, pos]], [[part, neg], [gnd, 'GND']]);
    if (out && out !== pos) nets.push([[part, out], [load, '1']], [[load, '2'], [gnd, 'GND']]);
    else nets.push([[supply, '+'], [load, '1']], [[load, '2'], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  const dio = diodeLike(part);
  if (dio) {
    nets.push([[supply, '+'], [load, '1']], [[load, '2'], [part, dio.a]], [[part, dio.k], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  const pins = pinsOf(part);
  if (pins.length >= 2) {
    // Generic two-terminal (or first two pins) through a series 1 kΩ.
    nets.push([[supply, '+'], [load, '1']], [[load, '2'], [part, pins[0].name]], [[part, pins[1].name], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  if (pins.length === 1) {
    nets.push([[part, pins[0].name], [supply, '+']], [[supply, '+'], [load, '1']], [[load, '2'], [gnd, 'GND']]);
    return { project: projFromNets(parts, nets), part, supply, gnd, load };
  }

  nets.push([[supply, '+'], [load, '1']], [[load, '2'], [gnd, 'GND']]);
  return { project: projFromNets(parts, nets), part, supply, gnd, load };
}

function stepSim(project, steps = 3, dt = 0.01) {
  const sim = new Sim(project);
  for (let i = 0; i < steps; i++) sim.advance(dt);
  return sim;
}

function pinVoltages(sim, project) {
  const out = [];
  for (const part of project.parts) {
    for (const pin of pinsOf(part)) {
      const v = sim.pinVoltage(part, pin.name);
      out.push({ id: part.id, type: part.type, pin: pin.name, v });
    }
  }
  return out;
}

function nonFiniteVoltages(sim, project) {
  return pinVoltages(sim, project).filter((x) => !Number.isFinite(x.v));
}

function uniquePinIssues(part) {
  const pins = pinsOf(part);
  const issues = [];
  const seen = new Map();
  pins.forEach((q, i) => {
    if (!q || q.name === undefined || q.name === null || String(q.name) === '') {
      issues.push('empty pin name at index ' + i);
      return;
    }
    if (seen.has(q.name)) issues.push('duplicate pin name ' + q.name);
    else seen.set(q.name, i);
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) issues.push('non-finite pin coords for ' + q.name);
  });
  return issues;
}

function hasBomEntry(type) {
  return !!(B.CATALOG && B.CATALOG[type]);
}

function sweepCases(edit, defVal) {
  const t = (edit && edit.t) || guessType(defVal);
  const values = [];
  const add = (v, kind) => { values.push({ kind, v }); };
  add(defVal, 'typical');
  if (t === 'sel') {
    const opts = (edit && edit.opts) || [];
    if (opts.length) {
      add(opts[0], 'min');
      add(opts[opts.length - 1], 'max');
    }
    add(0, 'zero');
    add(-1, 'negative');
    add('', 'empty');
    add('not-a-valid-option', 'invalid');
  } else if (t === 'bool') {
    add(false, 'min');
    add(true, 'max');
    add(0, 'zero');
    add('', 'empty');
    add('maybe', 'invalid');
  } else if (t === 'text') {
    add('', 'empty');
    add('hello', 'typical');
    add('<>&"\'', 'invalid');
  } else if (t === 'range') {
    const lo = edit.min, hi = edit.max;
    if (lo !== undefined) add(lo, 'min');
    if (hi !== undefined) add(hi, 'max');
    add(0, 'zero');
    add(-1, 'negative');
    if (lo !== undefined) add(lo - 1, 'below-min');
    if (hi !== undefined) add(hi + 1, 'above-max');
    add('', 'empty');
    add('foo', 'invalid');
  } else {
    // num / val
    add(0, 'zero');
    add(1, 'min');
    add(1e6, 'max');
    add(-1, 'negative');
    add('', 'empty');
    add('foo', 'invalid');
    if (t === 'val' || t === 'num') add('10k', 'si-string');
  }
  // de-dupe by JSON value, keep first kind
  const seen = new Set();
  return values.filter((x) => {
    const k = JSON.stringify(x.v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function guessType(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'val';
  return 'text';
}

function editableAndProps(type) {
  const d = P.T[type];
  const keys = new Map();
  for (const e of d.edit || []) keys.set(e.k, e);
  for (const k of Object.keys(d.props || {})) {
    if (keys.has(k)) continue;
    const v = d.props[k];
    if (Array.isArray(v) || (v && typeof v === 'object')) continue; // metadata such as addrs
    keys.set(k, { k, t: guessType(v), implicit: true });
  }
  return [...keys.values()];
}

function fmtShown(v) {
  if (typeof P.fmt === 'function' && typeof v === 'number' && Number.isFinite(v)) {
    return [P.fmt(v, ''), P.fmt(v, 'Ω'), P.fmt(v, 'F'), P.fmt(v, 'V'), P.fmt(v, 'A'), String(v)];
  }
  if (v === undefined || v === null) return [];
  return [String(v)];
}

module.exports = {
  P, Sim, N, Schematic, B, allTypes,
  SOURCE_TYPES, NO_ELECTRICAL, HIDDEN_IN_SCHEMATIC,
  mk, pinsOf, pinByName, w, place, projFromNets, nextId,
  minimalProject, stepSim, pinVoltages, nonFiniteVoltages,
  uniquePinIssues, hasBomEntry, sweepCases, editableAndProps, fmtShown,
};
