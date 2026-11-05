// Per-wire current from Sim.wireFlow(): node --test tests/wire_flow.test.js
const test = require('node:test');
const assert = require('node:assert');
require('../js/solver.js'); require('../js/parts.js'); require('../js/sim.js');
const { Sim } = globalThis.SimCore;

test('series LED on breadboard: each wire carries ~LED current', () => {
  const proj = { parts: [
    { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 63 } },
    { id: 'esp', type: 'esp32', x: 20, y: 50, rot: 0, props: { power: 'usb' } },
    { id: 'r1', type: 'resistor', x: 250, y: 120, rot: 0, props: { r: 220 } },
    { id: 'led', type: 'led', x: 290, y: 130, rot: 0, props: { color: 'red', vf: 1.9, imax: 0.03 } },
  ], wires: [
    { id: 'w1', a: { x: 50, y: 150 }, b: { x: 250, y: 150 }, color: 'yellow' },
    { id: 'w2', a: { x: 300, y: 150 }, b: { x: 310, y: 190 }, color: 'black' },
    { id: 'w3', a: { x: 30, y: 150 }, b: { x: 30, y: 190 }, color: 'black' },
  ] };
  const sim = new Sim(proj);
  const rt = sim.espRuntime(proj.parts[1]);
  rt.pinMode(2, 'OUTPUT'); rt.write(2, 1);
  sim.advance(0.01);
  const st = sim.partState(proj.parts[3]);
  assert.ok(st.i > 0.004 && st.i < 0.008, 'LED current ' + st.i);
  const flow = sim.wireFlow();
  assert.ok(flow.w1 && flow.w2 && flow.w3, 'wires present');
  // At least the GPIO feed and return paths should carry near the LED current
  const mags = ['w1', 'w2', 'w3'].map((id) => Math.abs(flow[id].i));
  const near = mags.filter((i) => Math.abs(i - st.i) / st.i < 0.25);
  assert.ok(near.length >= 2, '≥2 wires near LED I; got ' + JSON.stringify(flow) + ' LED=' + st.i);
  assert.ok(typeof flow.w1.v === 'number', 'voltage on wire');
  rt.write(2, 0); sim.advance(0.01);
  const off = sim.wireFlow();
  assert.ok(Math.abs(off.w1.i) < 1e-6, 'wire current off when GPIO low');
});

test('wireFlow empty project has no wires', () => {
  const sim = new Sim({ parts: [], wires: [] });
  sim.advance(0.001);
  assert.deepStrictEqual(sim.wireFlow(), {});
});
