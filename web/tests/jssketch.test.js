const test = require('node:test');
const assert = require('node:assert');
require('../js/solver.js'); require('../js/parts.js'); require('../js/sim.js'); require('../js/jssketch.js');
const { Sim } = globalThis.SimCore, { JsSketch, transform } = globalThis.JsSketchMod;

function rig(extraParts = [], wires = []) {
  const proj = { parts: [{ id: 'esp', type: 'esp32', x: 0, y: 0, rot: 0, props: { power: 'usb' } }, ...extraParts], wires };
  return { proj, sim: new Sim(proj), esp: proj.parts[0] };
}
test('transform awaits delay and user functions', () => {
  const t = transform('function blink(){ digitalWrite(2,1); delay(10); }\nfunction loop(){ blink(); }');
  assert.match(t, /async function blink\(/); assert.match(t, /await delay\(10\)/); assert.match(t, /await blink\(\)/);
});
test('Blink JS sketch toggles GPIO2 every 500 ms of virtual time', async () => {
  const { sim, esp } = rig();
  const edges = []; let last = null;
  const sk = new JsSketch('function setup(){ pinMode(LED_BUILTIN, OUTPUT); }\nfunction loop(){ digitalWrite(LED_BUILTIN, HIGH); delay(500); digitalWrite(LED_BUILTIN, LOW); delay(500); }', { sim, espPart: esp, serial() {} });
  await sk.start();
  for (let f = 0; f < 300; f++) {
    await sk.runUntil((f + 1) * 0.01, (dt) => sim.advance(dt));
    const l = sim.espRuntime(esp).pins[2].level; if (l !== last) { edges.push([sk.now, l]); last = l; }
  }
  sk.stop();
  assert.ok(edges.length >= 6, 'edges ' + edges.length);
  for (let i = 2; i < edges.length; i++) assert.ok(Math.abs(edges[i][0] - edges[i - 1][0] - 0.5) < 0.011, `period at ${i}: ${edges[i][0] - edges[i - 1][0]}`);
});
test('button read through INPUT_PULLUP and the circuit', async () => {
  // key between GPIO18 (bottom header index 8: x=80,y=90) and GND.1 (x=10,y=90)
  const key = { id: 'k', type: 'key', x: 300, y: 300, rot: 0, props: {} };
  const { sim, esp } = rig([key], [{ id: 'w1', a: { x: 80, y: 90 }, b: { x: 300, y: 300 } }, { id: 'w2', a: { x: 10, y: 90 }, b: { x: 330, y: 300 } }]);
  const out = [];
  const sk = new JsSketch('function setup(){ pinMode(18, INPUT_PULLUP); Serial.begin(115200); }\nfunction loop(){ Serial.println(digitalRead(18)); delay(100); }', { sim, espPart: esp, serial: (s) => out.push(s) });
  await sk.start();
  await sk.runUntil(0.25, (dt) => sim.advance(dt));
  sim.partState(key).pressed = true; sim.dirty = true;
  await sk.runUntil(0.55, (dt) => sim.advance(dt));
  sk.stop();
  const vals = out.join('').split(/\r\n/).filter(Boolean);
  assert.deepStrictEqual(vals.slice(0, 3), ['1', '1', '1']);
  assert.strictEqual(vals[vals.length - 1], '0');
});
test('analogRead of a potentiometer divider (12-bit)', async () => {
  // pot 1->3V3 (x=0,y=90), W->GPIO34 (top index 11: x=110,y=0), 2->GND.1 (x=10,y=90)
  const pot = { id: 'pot', type: 'potentiometer', x: 300, y: 200, rot: 0, props: { r: 10000, pos: 0.25 } };
  const { sim, esp } = rig([pot], [{ id: 'a', a: { x: 0, y: 90 }, b: { x: 300, y: 200 } }, { id: 'b', a: { x: 110, y: 0 }, b: { x: 310, y: 200 } }, { id: 'c', a: { x: 10, y: 90 }, b: { x: 320, y: 200 } }]);
  let v = null;
  const sk = new JsSketch('function loop(){ result(analogRead(34)); delay(10); }\nfunction result(x){ out.v = x; }'.replace('out.v', 'globalThis.__v'), { sim, espPart: esp, serial() {} });
  await sk.start(); await sk.runUntil(0.05, (dt) => sim.advance(dt)); sk.stop();
  v = globalThis.__v;
  assert.ok(Math.abs(v - Math.round((0.75 * 3300 - 142) / (1100 * 196602 / 65536 / 4096))) < 60, 'adc ' + v);   // 75% of 3.3 V through the eFuse-Vref ADC model
});
