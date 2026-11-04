// Basic circuits without an ESP32 (js/basic.js): node --test tests/
const test = require('node:test');
const assert = require('node:assert');
require('../js/solver.js'); require('../js/parts.js'); require('../js/sim.js'); require('../js/examples.js'); require('../js/basic.js');
const E = globalThis.Examples, { Sim } = globalThis.SimCore;
const run = (k, f, n = 40) => { const p = E.EX[k](); const s = new Sim(p); if (f) f(p, s); for (let i = 0; i < n; i++) s.advance(0.05); return [p, s]; };
const st = (p, s, id) => s.partState(p.parts.find((q) => q.id === id));
test('all basic examples build and converge with no ESP32', () => {
  for (const [k, , c] of E.LIST) if (c) { const [p, s] = run(k); assert.ok(!p.parts.some((q) => q.type === 'esp32'), k); assert.ok(s.circuit.converged, k); }
});
test('LED + 470R on 9 V ≈ 15 mA, meter agrees', () => { const [p, s] = run('b_led'); const i = st(p, s, 'LED1').i; assert.ok(i > 0.014 && i < 0.016, i); assert.ok(Math.abs(st(p, s, 'DMM1').val - i) < 1e-4); });
test('divider reads 2.88 V and ohmmeter reads 1 k', () => { const [p, s] = run('b_divider'); assert.ok(Math.abs(st(p, s, 'DMM1').val - 9 * 4.7 / 14.7) < 0.02); assert.ok(Math.abs(st(p, s, 'DMM2').val - 1000) < 5); });
test('night light: dark = on, bright = off', () => {
  let [p, s] = run('b_night'); assert.ok(st(p, s, 'LED1').i > 0.01);
  [p, s] = run('b_night', (p) => { p.parts.find((q) => q.id === 'LDR1').props.lux = 500; }); assert.ok(st(p, s, 'LED1').i < 1e-6);
});
test('astable flasher alternates', () => {
  const [p, s] = run('b_blink', null, 1); const seen = new Set();
  for (let t = 0; t < 40; t++) { s.advance(0.05); seen.add(st(p, s, 'LED1').i > 0.005 ? 1 : 2); }
  assert.deepStrictEqual([...seen].sort(), [1, 2]);
});
test('resistor burns open when over-powered', () => { const [p, s] = run('b_led', (p) => { p.parts.find((q) => q.id === 'R1').props.r = 10; p.parts.find((q) => q.id === 'LED1').props.imax = 10; }); assert.ok(st(p, s, 'R1').burned); });
