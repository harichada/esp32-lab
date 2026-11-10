// Known-answer behavior tests for key parts (divider, RC, LC, diodes,
// transistors, LED, LDR, pot, 555, regulators, servo mapping, NeoPixel).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { P, Sim, mk, projFromNets, stepSim } = require('./tools/part-helpers');

function circuit(parts, nets, steps = 4, dt = 0.01) {
  const project = projFromNets(parts, nets);
  const sim = stepSim(project, steps, dt);
  return { project, sim, parts };
}

function v(sim, part, a, b) {
  return sim.pinVoltage(part, a) - (b ? sim.pinVoltage(part, b) : 0);
}

test('resistor divider: 10 kΩ / 4.7 kΩ on 5 V reads 5·4.7/14.7 V', () => {
  const V = mk('vcc5'), G = mk('ground');
  const R1 = mk('resistor', { r: 10000 }), R2 = mk('resistor', { r: 4700 });
  const { sim } = circuit([V, G, R1, R2], [
    [[V, '+'], [R1, '1']],
    [[R1, '2'], [R2, '1']],
    [[R2, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  const expect = 5 * 4700 / 14700;
  assert.ok(Math.abs(v(sim, R2, '1') - expect) < 0.02, 'Vmid=' + v(sim, R2, '1'));
  assert.ok(sim.circuit.converged);
});

test('RC time constant: 1 kΩ × 1 µF charges to ~63% of 5 V at t = RC', () => {
  const V = mk('vcc5'), G = mk('ground');
  const R = mk('resistor', { r: 1000 }), C = mk('capacitor', { c: 1e-6 });
  const project = projFromNets([V, G, R, C], [
    [[V, '+'], [R, '1']],
    [[R, '2'], [C, '1']],
    [[C, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  const sim = new Sim(project);
  const tau = 0.001;
  for (let i = 0; i < 10; i++) sim.advance(tau / 10);
  const vc = v(sim, C, '1', '2');
  // Backward-Euler is slightly conservative; 5*(1-1/e) ≈ 3.16 V, we see ~3.07 V.
  assert.ok(Math.abs(vc - 5 * (1 - Math.exp(-1))) < 0.2, 'Vc(tau)=' + vc + ' at t=' + sim.t);
  for (let i = 0; i < 40; i++) sim.advance(tau / 10);
  assert.ok(v(sim, C, '1', '2') > 4.8, 'should be nearly full at 5 tau, got ' + v(sim, C, '1', '2'));
});

test('LC oscillation: 10 mH × 1 µF rings above the rail then damps toward 5 V', () => {
  const V = mk('vcc5'), G = mk('ground');
  const R = mk('resistor', { r: 10 }), L = mk('inductor', { l: '10m' }), C = mk('capacitor', { c: 1e-6 });
  const project = projFromNets([V, G, R, L, C], [
    [[V, '+'], [R, '1']],
    [[R, '2'], [L, '1']],
    [[L, '2'], [C, '1']],
    [[C, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  const sim = new Sim(project);
  const period = 2 * Math.PI * Math.sqrt(0.01 * 1e-6);
  const samples = [];
  for (let i = 0; i < 80; i++) { sim.advance(period / 20); samples.push(v(sim, C, '1', '2')); }
  const peak = Math.max(...samples);
  const later = samples.slice(50);
  assert.ok(peak > 6.5, 'expected overshoot, peak=' + peak);
  assert.ok(Math.min(...samples.slice(0, 25)) < 5, 'should start from a lower voltage');
  // After a few cycles it should be settling near the 5 V step.
  const mean = later.reduce((a, b) => a + b, 0) / later.length;
  assert.ok(Math.abs(mean - 5) < 0.4, 'damped mean ' + mean);
  // Time between the first two local maxima should be about one period.
  const peaks = [];
  for (let i = 2; i < samples.length - 2; i++) {
    if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1] && samples[i] > 5.3) peaks.push(i);
  }
  if (peaks.length >= 2) {
    const dt = (peaks[1] - peaks[0]) * (period / 20);
    assert.ok(Math.abs(dt - period) / period < 0.25, 'period ' + dt + ' vs ' + period);
  }
});

test('1N4148 forward drop is about 0.65 V at ~4 mA', () => {
  const V = mk('vcc5'), G = mk('ground'), R = mk('resistor', { r: 1000 }), D = mk('diode');
  const { sim } = circuit([V, G, R, D], [
    [[V, '+'], [R, '1']],
    [[R, '2'], [D, 'A']],
    [[D, 'K'], [G, 'GND'], [V, 'GND']],
  ]);
  const vd = v(sim, D, 'A', 'K');
  assert.ok(vd > 0.55 && vd < 0.8, 'Vd=' + vd);
});

test('5.1 V zener clamps a 9 V supply through 1 kΩ', () => {
  const B = mk('battery9v'), G = mk('ground'), R = mk('resistor', { r: 1000 }), Z = mk('zener', { vz: 5.1 });
  const { sim } = circuit([B, G, R, Z], [
    [[B, '+'], [R, '1']],
    [[R, '2'], [Z, 'K']],
    [[Z, 'A'], [G, 'GND'], [B, '-']],
  ]);
  const vz = v(sim, Z, 'K', 'A');
  assert.ok(Math.abs(vz - 5.1) < 0.15, 'Vz=' + vz);
});

test('NPN 2N2222: cutoff with base held down, saturation with base driven', () => {
  const V = mk('vcc5'), G = mk('ground'), Q = mk('npn');
  const Rc = mk('resistor', { r: 1000 }), Rb = mk('resistor', { r: 10000 });
  const off = circuit([V, G, Q, Rc, Rb], [
    [[V, '+'], [Rc, '1']],
    [[Rc, '2'], [Q, 'C']],
    [[Q, 'E'], [G, 'GND'], [V, 'GND'], [Rb, '2']],
    [[Rb, '1'], [Q, 'B']],
  ]);
  assert.ok(v(off.sim, Q, 'C', 'E') > 4.9, 'cutoff Vce=' + v(off.sim, Q, 'C', 'E'));

  const V2 = mk('vcc5'), G2 = mk('ground'), Q2 = mk('npn');
  const Rc2 = mk('resistor', { r: 1000 }), Rb2 = mk('resistor', { r: 2200 });
  const on = circuit([V2, G2, Q2, Rc2, Rb2], [
    [[V2, '+'], [Rc2, '1'], [Rb2, '1']],
    [[Rc2, '2'], [Q2, 'C']],
    [[Rb2, '2'], [Q2, 'B']],
    [[Q2, 'E'], [G2, 'GND'], [V2, 'GND']],
  ]);
  assert.ok(v(on.sim, Q2, 'C', 'E') < 0.15, 'sat Vce=' + v(on.sim, Q2, 'C', 'E'));
});

test('N-MOSFET AO3400 is off below Vth and on with Vgs = 5 V', () => {
  const V = mk('vcc5'), G = mk('ground'), Q = mk('nmos'), Rd = mk('resistor', { r: 1000 });
  const off = circuit([V, G, Q, Rd], [
    [[V, '+'], [Rd, '1']],
    [[Rd, '2'], [Q, 'D']],
    [[Q, 'S'], [Q, 'G'], [G, 'GND'], [V, 'GND']],
  ]);
  assert.ok(v(off.sim, Q, 'D', 'S') > 4.9, 'off Vds=' + v(off.sim, Q, 'D', 'S'));
  assert.ok(v(off.sim, Q, 'G', 'S') < 0.05);

  const V2 = mk('vcc5'), G2 = mk('ground'), Q2 = mk('nmos'), Rd2 = mk('resistor', { r: 1000 });
  const on = circuit([V2, G2, Q2, Rd2], [
    [[V2, '+'], [Rd2, '1'], [Q2, 'G']],
    [[Rd2, '2'], [Q2, 'D']],
    [[Q2, 'S'], [G2, 'GND'], [V2, 'GND']],
  ]);
  assert.ok(v(on.sim, Q2, 'D', 'S') < 0.05, 'on Vds=' + v(on.sim, Q2, 'D', 'S'));
  assert.ok(v(on.sim, Q2, 'G', 'S') > 4.5);
});

test('LED current on 5 V through 220 Ω is about (5 − Vf)/220', () => {
  const V = mk('vcc5'), G = mk('ground'), R = mk('resistor', { r: 220 }), L = mk('led', { color: 'red', vf: 1.9 });
  const { sim } = circuit([V, G, R, L], [
    [[V, '+'], [R, '1']],
    [[R, '2'], [L, 'A']],
    [[L, 'C'], [G, 'GND'], [V, 'GND']],
  ]);
  const i = sim.partState(L).i;
  const vf = v(sim, L, 'A', 'C');
  const expect = (5 - vf) / 220;
  assert.ok(i > 0.012 && i < 0.016, 'I=' + i);
  assert.ok(Math.abs(i - expect) < 5e-4, 'I=' + i + ' vs (5-Vf)/R=' + expect);
  assert.ok(vf > 1.7 && vf < 2.1, 'Vf=' + vf);
});

test('LDR and potentiometer divider voltages follow their models', () => {
  const V = mk('vcc5'), G = mk('ground'), R = mk('resistor', { r: 10000 }), L = mk('ldr', { lux: 10 });
  const dark = circuit([V, G, R, L], [
    [[V, '+'], [R, '1']],
    [[R, '2'], [L, '1']],
    [[L, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  const rDark = P.T.ldr.R(10);
  assert.ok(Math.abs(rDark - 10000) < 1);
  assert.ok(Math.abs(v(dark.sim, L, '1') - 2.5) < 0.02, 'dark V=' + v(dark.sim, L, '1'));
  L.props.lux = 5000;
  dark.sim.dirty = true;
  dark.sim.advance(0.01);
  const rBright = P.T.ldr.R(5000);
  const expect = 5 * rBright / (10000 + rBright);
  assert.ok(Math.abs(v(dark.sim, L, '1') - expect) < 0.02, 'bright V=' + v(dark.sim, L, '1'));
  assert.ok(v(dark.sim, L, '1') < 0.2, 'bright should pull the divider down');

  const V2 = mk('vcc5'), G2 = mk('ground'), POT = mk('potentiometer', { r: 10000, pos: 0.25 });
  const { sim } = circuit([V2, G2, POT], [
    [[V2, '+'], [POT, '1']],
    [[POT, '2'], [G2, 'GND'], [V2, 'GND']],
  ]);
  // Wiper voltage is V1·(1−pos) + V2·pos, so pos=0.25 → 3.75 V.
  assert.ok(Math.abs(v(sim, POT, 'W') - 3.75) < 0.05, 'wiper=' + v(sim, POT, 'W'));
  POT.props.pos = 0.5;
  sim.dirty = true;
  sim.advance(0.01);
  assert.ok(Math.abs(v(sim, POT, 'W') - 2.5) < 0.05, 'wiper mid=' + v(sim, POT, 'W'));
});

test('NE555 astable with R1=1 kΩ, R2=10 kΩ, C=10 µF is about 1.44/((R1+2R2)C) Hz', () => {
  const V = mk('vcc5'), G = mk('ground'), U = mk('ne555');
  const R1 = mk('resistor', { r: 1000 }), R2 = mk('resistor', { r: 10000 }), C = mk('ecap', { c: '10u' });
  const project = projFromNets([V, G, U, R1, R2, C], [
    [[V, '+'], [U, 'VCC'], [U, 'RESET'], [R1, '1']],
    [[R1, '2'], [U, 'DIS'], [R2, '1']],
    [[R2, '2'], [U, 'THR'], [U, 'TRIG'], [C, '+']],
    [[C, '-'], [U, 'GND'], [G, 'GND'], [V, 'GND']],
  ]);
  const sim = new Sim(project);
  sim.advance(0.001);
  for (let i = 0; i < 2000; i++) sim.advance(0.001);
  const edges = sim.partState(U).edges || 0;
  const f = edges / sim.t;
  const expect = 1.44 / ((1000 + 2 * 10000) * 10e-6);
  assert.ok(edges >= 8, 'too few cycles: ' + edges);
  assert.ok(Math.abs(f - expect) / expect < 0.1, 'f=' + f + ' expect ' + expect);
});

test('LDO 3.3 V and LM7805 hold their regulated outputs under a 1 kΩ load', () => {
  const V = mk('vcc5'), G = mk('ground'), U = mk('ldo'), R = mk('resistor', { r: 1000 });
  const ldo = circuit([V, G, U, R], [
    [[V, '+'], [U, 'VIN']],
    [[V, 'GND'], [U, 'GND'], [G, 'GND'], [R, '2']],
    [[U, 'VOUT'], [R, '1']],
  ]);
  assert.ok(Math.abs(v(ldo.sim, U, 'VOUT', 'GND') - 3.3) < 0.05, 'LDO=' + v(ldo.sim, U, 'VOUT', 'GND'));

  const B = mk('battery9v'), G2 = mk('ground'), REG = mk('lm7805'), R2 = mk('resistor', { r: 1000 });
  const reg = circuit([B, G2, REG, R2], [
    [[B, '+'], [REG, 'IN']],
    [[B, '-'], [REG, 'GND'], [G2, 'GND'], [R2, '2']],
    [[REG, 'OUT'], [R2, '1']],
  ], 8, 0.05);
  assert.ok(Math.abs(v(reg.sim, REG, 'OUT', 'GND') - 5) < 0.1, '7805=' + v(reg.sim, REG, 'OUT', 'GND'));
});

test('servo pulse-width mapping: 544–2400 µs → 0–180°, and svg follows state.angle', () => {
  // Horn motion lives in js/app.js (QEMU LEDC duty × frequency). The mapping
  // itself is (us − min)/(max − min)×180, which we apply the same way here.
  const angle = (us, lo = 544, hi = 2400) => Math.max(0, Math.min(180, (us - lo) / (hi - lo) * 180));
  assert.equal(angle(544), 0);
  assert.equal(angle(2400), 180);
  assert.ok(Math.abs(angle(1472) - 90) < 0.5);

  const S = mk('servo'), V = mk('vcc5'), G = mk('ground');
  const { sim } = circuit([S, V, G], [
    [[V, '+'], [S, 'V+']],
    [[V, 'GND'], [S, 'GND'], [G, 'GND']],
  ]);
  const st = sim.partState(S);
  st.us = 1472; st.hz = 50; st.target = 90; st.angle = 90;
  const svg = P.T.servo.svg(S, st);
  assert.match(svg, /90°/);
  assert.match(svg, /1472 µs/);
  // 1.5 ms pulse at 50 Hz is a 7.5% duty; document the app.js formula.
  const duty = 0.075, freq = 50, us = duty * 1e6 / freq;
  assert.ok(Math.abs(us - 1500) < 1e-6);
  assert.ok(Math.abs(angle(us) - 90) < 5);
});

test('NeoPixel svg uses st.px colors; lighting the strip increases supply current', () => {
  // Pixel data is normally pushed by Adafruit_NeoPixel::show() through the QEMU
  // hook in app.js. Here we set the same state the hook would and check the model.
  const P1 = mk('neopixel', { n: 8 }), V = mk('vcc5'), G = mk('ground');
  const dark = circuit([P1, V, G], [
    [[V, '+'], [P1, 'VCC']],
    [[V, 'GND'], [P1, 'GND'], [G, 'GND']],
  ]);
  const rOff = 5 / (0.001 * 8); // stamp: 5 / (0.001*n + 0.06*lit)
  const vDark = v(dark.sim, P1, 'VCC', 'GND');

  const P2 = mk('neopixel', { n: 8 }), V2 = mk('vcc5'), G2 = mk('ground');
  const project = projFromNets([P2, V2, G2], [
    [[V2, '+'], [P2, 'VCC']],
    [[V2, 'GND'], [P2, 'GND'], [G2, 'GND']],
  ]);
  const sim = new Sim(project);
  const st = sim.partState(P2);
  st.px = Array.from({ length: 8 }, () => [255, 0, 0]);
  st.frames = 1;
  sim.dirty = true;
  sim.advance(0.01);
  const svg = P.T.neopixel.svg(P2, st);
  assert.match(svg, /rgb\(/);
  assert.match(svg, /255/);
  const lit = 8 * (255 + 0 + 0) / 765;
  const rOn = 5 / (0.001 * 8 + 0.06 * lit);
  assert.ok(rOn < rOff / 2, 'lit load should be heavier');
  const vLit = v(sim, P2, 'VCC', 'GND');
  assert.ok(vLit > 4.5 && vLit < 5.1, 'VCC=' + vLit);
  assert.ok(vLit < vDark, 'lit rail ' + vLit + ' should droop below dark rail ' + vDark);
});

test('DHT22 bytes() encode temperature and humidity with a checksum', () => {
  const p = mk('dht22', { temp: 24, hum: 50 });
  const b = P.T.dht22.bytes(p);
  assert.equal(b.length, 5);
  assert.equal((b[0] << 8) | b[1], 500);
  assert.equal((b[2] << 8) | b[3], 240);
  assert.equal(b[4], (b[0] + b[1] + b[2] + b[3]) & 255);
  const n = mk('dht22', { temp: -10.5, hum: 12.3 });
  const c = P.T.dht22.bytes(n);
  const t = (c[2] << 8) | c[3];
  assert.ok(t & 0x8000, 'negative temps set the sign bit');
  assert.equal(t & 0x7fff, 105);
});

test('resistor r=0 is stamped as 1 mΩ; invalid strings use 220 Ω and warn', () => {
  const V = mk('vcc5'), G = mk('ground'), Rs = mk('resistor', { r: 1000 }), Rz = mk('resistor', { r: 0 });
  const { sim } = circuit([V, G, Rs, Rz], [
    [[V, '+'], [Rs, '1']],
    [[Rs, '2'], [Rz, '1']],
    [[Rz, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  const el = sim.mains.get(Rz.id);
  assert.ok(el, 'zero-ohm resistor has a main element');
  assert.equal(el.r, P.WIRE_R);
  assert.equal(P.WIRE_R, 1e-3);
  const i = (5 - v(sim, V, '+')) > -1 ? sim.circuit.current(el) : 0;
  // 1 kΩ + 1 mΩ ≈ 5 mA; voltage across the 1 mΩ part is ~5 µV.
  assert.ok(Math.abs(Math.abs(i) - 0.005) < 5e-5, 'I=' + i);
  assert.ok(Math.abs(v(sim, Rz, '1', '2')) < 1e-4, 'Vr=' + v(sim, Rz, '1', '2'));

  const V2 = mk('vcc5'), G2 = mk('ground'), Rbad = mk('resistor', { r: 'foo' }), Rref = mk('resistor', { r: 1000 });
  const bad = circuit([V2, G2, Rbad, Rref], [
    [[V2, '+'], [Rref, '1']],
    [[Rref, '2'], [Rbad, '1']],
    [[Rbad, '2'], [G2, 'GND'], [V2, 'GND']],
  ]);
  assert.equal(bad.sim.mains.get(Rbad.id).r, 220);
  const mid = 5 * 220 / (1000 + 220);
  assert.ok(Math.abs(v(bad.sim, Rbad, '1') - mid) < 0.02, 'Vmid=' + v(bad.sim, Rbad, '1'));
  const msgs = (bad.sim.warnings || []).map((w) => w.msg).join('; ');
  assert.match(msgs, /invalid resistance/);
  assert.match(msgs, /220/);
});

test('capacitor C=0 stays open (not 1 nF); invalid strings use 1 µF and warn', () => {
  const V = mk('vcc5'), G = mk('ground'), R = mk('resistor', { r: 1000 }), C0 = mk('capacitor', { c: 0 });
  const project = projFromNets([V, G, R, C0], [
    [[V, '+'], [R, '1']],
    [[R, '2'], [C0, '1']],
    [[C0, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  const sim = new Sim(project);
  for (let i = 0; i < 20; i++) sim.advance(0.001);
  assert.equal(sim.mains.get(C0.id).c, 0);   // previously `parseVal(c) || 1e-9` stamped this as 1 nF
  // A 0 F capacitor is an open; the far node is not uniquely held at 0 V, but the sim must not throw or NaN.
  assert.ok(Number.isFinite(v(sim, C0, '1', '2')), 'Vc=' + v(sim, C0, '1', '2'));

  const V2 = mk('vcc5'), G2 = mk('ground'), R2 = mk('resistor', { r: 1000 }), Cbad = mk('capacitor', { c: 'foo' });
  const project2 = projFromNets([V2, G2, R2, Cbad], [
    [[V2, '+'], [R2, '1']],
    [[R2, '2'], [Cbad, '1']],
    [[Cbad, '2'], [G2, 'GND'], [V2, 'GND']],
  ]);
  const sim2 = new Sim(project2);
  for (let i = 0; i < 50; i++) sim2.advance(0.0001);   // 5 ms ≈ 5τ for 1 kΩ × 1 µF
  assert.equal(sim2.mains.get(Cbad.id).c, 1e-6);
  assert.ok(v(sim2, Cbad, '1', '2') > 4.8, 'invalid C should use 1 µF default, Vc=' + v(sim2, Cbad, '1', '2'));
  const msgs = (sim2.warnings || []).map((w) => w.msg).join('; ');
  assert.match(msgs, /invalid capacitance/);
});

test('potentiometer r=0 uses 1 mΩ total; invalid strings use 10 kΩ and warn', () => {
  const used0 = P.stampResistance(0, 10000);
  assert.equal(used0.value, 1e-3);
  assert.ok(used0.wire);
  const usedBad = P.stampResistance('foo', 10000);
  assert.equal(usedBad.value, 10000);
  assert.equal(usedBad.ok, false);

  const V = mk('vcc5'), G = mk('ground'), POT = mk('potentiometer', { r: 'foo', pos: 0.25 });
  const { sim } = circuit([V, G, POT], [
    [[V, '+'], [POT, '1']],
    [[POT, '2'], [G, 'GND'], [V, 'GND']],
  ]);
  assert.ok(Math.abs(v(sim, POT, 'W') - 3.75) < 0.05, 'wiper=' + v(sim, POT, 'W'));
  const msgs = (sim.warnings || []).map((w) => w.msg).join('; ');
  assert.match(msgs, /invalid resistance/);
  assert.match(msgs, /10 kΩ|10kΩ|10000/);
});
