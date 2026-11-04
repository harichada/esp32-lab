// node --test tests/   (Node >= 18)
const test = require('node:test');
const assert = require('node:assert');
require('../js/solver.js'); require('../js/parts.js'); require('../js/sim.js');
const { Circuit } = globalThis.Solver;
const { Sim } = globalThis.SimCore;
const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${msg}: got ${a}, expected ${b} ±${rel * 100}%`);

test('voltage divider is exact', () => {
  const c = new Circuit(3);
  c.add({ kind: 'V', a: 1, b: 0, v: 3.3 }); c.add({ kind: 'R', a: 1, b: 2, r: 10e3 }); c.add({ kind: 'R', a: 2, b: 0, r: 4.7e3 });
  c.dc();
  assert.ok(Math.abs(c.v(2) - 3.3 * 4.7 / 14.7) < 1e-6, 'divider ' + c.v(2));
  near(-c.current(c.el[0]), 3.3 / 14.7e3, 1e-6, 'source current');
});

test('LED + resistor current within 5% of hand calculation', () => {
  // 3.3 V -> 220 Ω -> red LED (Vf ≈ 1.9 V @ 20 mA). Hand calc: I ≈ (3.3 - Vf)/220 with Vf at that current.
  const d = globalThis.Solver.diodeFromVf(1.9, 0.02, 2);
  const c = new Circuit(3);
  c.add({ kind: 'V', a: 1, b: 0, v: 3.3 }); const r = c.add({ kind: 'R', a: 1, b: 2, r: 220 }); const led = c.add({ kind: 'D', a: 2, k: 0, is: d.is, n: d.n });
  c.dc();
  const i = c.current(r), vf = c.v(2);
  const hand = (3.3 - 1.85) / 220;   // ≈ 6.6 mA; at 6.6 mA this LED model's Vf = 1.9 - 2*VT*ln(20/6.6) ≈ 1.843 V
  near(i, hand, 0.05, 'LED current');
  near(c.current(led), i, 1e-4, 'KCL');
  assert.ok(vf > 1.8 && vf < 1.9, 'Vf ' + vf);
});

test('RC charging time constant within 5%', () => {
  const R = 10e3, Cc = 47e-6, tau = R * Cc;   // 0.47 s
  const c = new Circuit(3);
  c.add({ kind: 'V', a: 1, b: 0, v: 3.3 }); c.add({ kind: 'R', a: 1, b: 2, r: R }); c.add({ kind: 'C', a: 2, b: 0, c: Cc, vprev: 0 });
  const h = 1e-3; let t = 0, t63 = null;
  while (t < 3 * tau) { c.step(h); t += h; if (t63 === null && c.v(2) >= 3.3 * (1 - Math.exp(-1))) t63 = t; }
  near(t63, tau, 0.05, 'time to 63.2%');
  near(c.v(2), 3.3 * (1 - Math.exp(-3)), 0.02, 'V(3τ)');
});

test('BJT switch saturates (2N2222, 3.3 V drive through 1 kΩ, 220 Ω collector load @5 V)', () => {
  const c = new Circuit(5);
  c.add({ kind: 'V', a: 1, b: 0, v: 5 }); c.add({ kind: 'V', a: 3, b: 0, v: 3.3 });
  c.add({ kind: 'R', a: 1, b: 2, r: 220 });       // collector load
  c.add({ kind: 'R', a: 3, b: 4, r: 1000 });      // base resistor
  const q = c.add({ kind: 'Q', type: 'npn', c: 2, b: 4, e: 0, is: 1e-14, bf: 200, br: 3 });
  assert.ok(c.dc(), 'converged');
  const vce = c.v(2), { ic, ib } = c.current(q);
  assert.ok(vce < 0.25, 'Vce(sat) ' + vce);
  near(ic, (5 - vce) / 220, 0.02, 'Ic');
  assert.ok(ic / ib < 200 * 0.5, 'forced beta < βF (saturation): ' + ic / ib);
  // and cut-off with base at 0 V
  c.el[1].v = 0; c.dc();
  assert.ok(c.v(2) > 4.99, 'off: Vc ' + c.v(2));
});

test('PNP and MOSFET sanity', () => {
  const c = new Circuit(4);
  c.add({ kind: 'V', a: 1, b: 0, v: 5 }); const vg = c.add({ kind: 'V', a: 2, b: 0, v: 5 });
  c.add({ kind: 'R', a: 1, b: 3, r: 100 });
  const m = c.add({ kind: 'M', type: 'n', d: 3, g: 2, s: 0, vth: 1.05, k: 10 });
  c.dc(); assert.ok(c.v(3) < 0.05, 'NMOS on, Vd=' + c.v(3));
  vg.v = 0; c.dc(); assert.ok(c.v(3) > 4.99, 'NMOS off');
  // PNP high-side switch: E=5 V, base pulled to 0 V via 10 kΩ -> on; collector load 1 kΩ to GND
  const p = new Circuit(5);
  p.add({ kind: 'V', a: 1, b: 0, v: 5 }); const vb = p.add({ kind: 'V', a: 2, b: 0, v: 0 });
  p.add({ kind: 'R', a: 2, b: 3, r: 10e3 }); p.add({ kind: 'R', a: 4, b: 0, r: 1e3 });
  p.add({ kind: 'Q', type: 'pnp', e: 1, b: 3, c: 4, is: 1e-14, bf: 150, br: 3 });
  assert.ok(p.dc(), 'pnp converged'); assert.ok(p.v(4) > 4.7, 'PNP on: Vc=' + p.v(4));
  vb.v = 5; p.dc(); assert.ok(p.v(4) < 0.01, 'PNP off: Vc=' + p.v(4));
});

test('zener clamps', () => {
  const c = new Circuit(3);
  c.add({ kind: 'V', a: 1, b: 0, v: 12 }); c.add({ kind: 'R', a: 1, b: 2, r: 1000 });
  c.add({ kind: 'D', a: 0, k: 2, is: 1e-12, n: 1.5, bv: 5.1, nbv: 1.2 });
  c.dc(); assert.ok(Math.abs(c.v(2) - 5.1) < 0.3, 'Vz ' + c.v(2));
});

test('LDO regulates and drops out', () => {
  const c = new Circuit(3);
  const vin = c.add({ kind: 'V', a: 1, b: 0, v: 4.2 }); c.add({ kind: 'LDO', in: 1, out: 2, gnd: 0, vreg: 3.3, drop: 0.18 }); c.add({ kind: 'R', a: 2, b: 0, r: 33 });
  c.dc(); assert.ok(Math.abs(c.v(2) - 3.3) < 1e-6, 'reg ' + c.v(2));
  vin.v = 3.4; c.dc(); assert.ok(Math.abs(c.v(2) - 3.22) < 1e-3, 'dropout ' + c.v(2));
});

test('netlist from editor geometry: breadboard strips + ESP32 pin drive lights an LED', () => {
  const proj = { parts: [
    { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 63 } },
    { id: 'esp', type: 'esp32', x: 20, y: 50, rot: 0, props: { power: 'usb' } },
    { id: 'r1', type: 'resistor', x: 250, y: 120, rot: 0, props: { r: 220 } },       // g25 - g29
    { id: 'led', type: 'led', x: 290, y: 130, rot: 0, props: { color: 'red', vf: 1.9, imax: 0.03 } }, // h29 / h30
  ], wires: [
    { id: 'w1', a: { x: 50, y: 150 }, b: { x: 250, y: 150 }, color: 'yellow' },   // j5 (GPIO2) -> j25
    { id: 'w2', a: { x: 300, y: 150 }, b: { x: 310, y: 190 }, color: 'black' },   // j30 -> bottom - rail col 31
    { id: 'w3', a: { x: 30, y: 150 }, b: { x: 30, y: 190 }, color: 'black' },     // j3 (GND.1) -> bottom - rail
  ] };
  const sim = new Sim(proj);
  const esp = proj.parts[1], rt = sim.espRuntime(esp);
  rt.pinMode(2, 'OUTPUT'); rt.write(2, 1);
  sim.advance(0.01);
  const st = sim.partState(proj.parts[3]);
  assert.ok(st.i > 0.004 && st.i < 0.008, 'LED current ' + st.i);
  rt.write(2, 0); sim.advance(0.01);
  assert.ok(sim.partState(proj.parts[3]).i < 1e-6, 'LED off');
  // input read through a pull-up
  rt.pinMode(18, 'INPUT_PULLUP'); sim.advance(0.01);
  assert.strictEqual(rt.pinInput[18], 1);
});
