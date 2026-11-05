// Instrument suite (js/scope.js): ring buffer, measurements, FFT, trigger, decoders, and live sampling from the solver.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'scope.js', 'sim.js', 'bom.js', 'examples.js', 'basic.js', 'parts/registry.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js']) require('../js/' + f);
const I = globalThis.Instruments, { Ring, measure, spectrum } = I._test, { Sim } = globalThis.SimCore;

test('ring buffer wraps, keeps order and binary-searches time', () => {
  const r = new Ring(8); for (let i = 0; i < 20; i++) r.push(i * 0.1, i);
  assert.strictEqual(r.n, 8); assert.strictEqual(r.V(0), 12); assert.strictEqual(r.last(), 19);
  assert.strictEqual(r.first(1.45), 3); assert.ok(Math.abs(r.at(1.55) - 15.5) < 1e-6);
});
test('measurements on a 50 Hz, 30 % duty, 0–3.3 V square wave', () => {
  const r = new Ring(); for (let i = 0; i < 20000; i++) { const t = i * 1e-5; r.push(t, (t * 50) % 1 < 0.3 ? 3.3 : 0); }
  const m = measure(r, 0, 0.2);
  assert.ok(Math.abs(m.pp - 3.3) < 1e-6); assert.ok(Math.abs(m.f - 50) < 0.5, m.f); assert.ok(Math.abs(m.duty - 0.3) < 0.01, m.duty); assert.ok(Math.abs(m.avg - 0.99) < 0.02, m.avg);
});
test('FFT finds the fundamental of a 1 kHz sine', () => {
  const r = new Ring(); for (let i = 0; i < 20000; i++) { const t = i * 1e-6; r.push(t, 1 + Math.sin(2 * Math.PI * 1000 * t)); }
  const s = spectrum(r, 0, 0.02); let pk = 1; for (let k = 1; k < s.db.length; k++) if (s.db[k] > s.db[pk]) pk = k;
  assert.ok(Math.abs(pk * s.df - 1000) <= s.df, pk * s.df); assert.ok(Math.abs(s.db[pk]) < 1.5, s.db[pk]);   // 1 V peak ≈ 0 dBV
});
test('555 astable: probing OUT and the LED anode through the solver gives a ~1.5 Hz square wave; trigger locks', () => {
  const ex = globalThis.Examples.EX.ic_555blink(); const sim = new Sim(ex);
  I.setProject(ex, sim); I.probe({ kind: 'pin', part: 'U1', pin: 'OUT' }); I.probe({ kind: 'pin', part: 'LED1', pin: 'A' });
  for (let i = 0; i < 300; i++) sim.advance(1 / 60);   // 5 s
  const out = I.ch[0].buf, led = I.ch[1].buf; assert.ok(out.n > 5000, 'samples ' + out.n);
  const m = measure(out, 1, sim.t); assert.ok(m.max > 7 && m.min < 0.5, JSON.stringify(m)); assert.ok(m.f > 1.0 && m.f < 2.2, 'f=' + m.f);
  const ml = measure(led, 1, sim.t); assert.ok(ml.max > 1.5 && ml.max < 2.6 && ml.min < 0.5, JSON.stringify(ml));
  I.trig.src = 1; I.trig.level = 4; I.trig.slope = 'rise'; I.tdiv = 0.1;
  const tt = I._test.findTrigger(I.ch[0], sim.t); assert.ok(tt !== null && tt < sim.t, 'trigger ' + tt);
  assert.ok(out.at(tt + 0.02) > 4 && out.at(tt - 0.02) < 4);
});
test('UART decode of a bit-banged 9600-baud "Hi" on a logic lane', () => {
  I.clearAll(); const l = I.lanes[0], bit = 1 / 9600; let t = 0.001; l.buf.push(0, 1);
  for (const ch of 'Hi') { const bits = [0, ...[...Array(8)].map((_, i) => (ch.charCodeAt(0) >> i) & 1), 1]; for (const b of bits) { l.buf.push(t, b); t += bit; } t += 2 * bit; }
  I.decoder = { kind: 'uart', a: 0, b: 1, baud: 9600 };
  const d = I._test.decode({ t0: 0, t1: t + 0.001 }); assert.deepStrictEqual(d.map((e) => e.s), ["'H' 0x48", "'i' 0x69"]);
  I.decoder = { kind: 'none', a: 0, b: 1, baud: 9600 };
});
