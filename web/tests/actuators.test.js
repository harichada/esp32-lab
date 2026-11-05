// Actuator / power / semiconductor add-on parts (js/parts/actuators.js, power.js, semis.js): node --test tests/
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver', 'parts', 'sim', 'examples', 'basic', 'bom', 'parts/registry', 'parts/hwkit', 'parts/actuators', 'parts/power', 'parts/semis', 'parts/examples-actuators']) require('../js/' + f + '.js');
const P = globalThis.Parts, E = globalThis.Examples, B = globalThis.Bom, { Sim } = globalThis.SimCore;
const TYPES = ['relay1', 'relay2', 'buzzerp', 'vibmotor', 'solenoid', 'l298n', 'l293d', 'uln2003', 'stepper28', 'a4988', 'nema17', 'lm7805', 'ams1117', 'buck', 'fuse', 'cell18650', 'd1n4007', 'd1n5819', 'n2n3904', 'p2n3906', 'tip120', 'irlz44n', 'pc817'];
let uid = 0;
const mk = (type, x, y, props = {}, id) => ({ id: id || type + (++uid), type, x, y, rot: 0, props: Object.assign(JSON.parse(JSON.stringify(P.T[type].props || {})), props) });
const pin = (p, n) => P.pinWorld(p, P.T[p.type].pins(p).find((q) => q.name === n));
const w = (a, b) => ({ id: 'w' + (++uid), a, b, pts: [], color: 'green' });
const run = (proj, n = 20, dt = 0.05) => { const s = new Sim(proj); for (let i = 0; i < n; i++) s.advance(dt); return s; };
const st = (s, p) => s.partState(p);

test('every new part renders, has pins, a BOM line and a searchable label', () => {
  for (const t of TYPES) {
    const d = P.T[t]; assert.ok(d, t); const p = mk(t, 0, 0);
    assert.ok(d.svg(p, null).includes('data-pin'), t); assert.ok(d.pins(p).length >= 2, t);
    assert.ok(B.list({ parts: [p], wires: [], mode: 'circuit' }).some((e) => e.key !== 'bb' && e.key !== 'jw'), 'bom ' + t);
    assert.ok(/[A-Za-z0-9]/.test(d.label) && d.cat, t);
  }
  const q = (s) => TYPES.filter((t) => (P.T[t].label + ' ' + t + ' ' + P.T[t].cat).toLowerCase().includes(s));
  for (const s of ['sg90', 'relay', 'l298n', 'l293d', 'uln2003', '28byj', 'a4988', 'nema17', '7805', 'ams1117', 'lm2596', '1n4007', '5819', '2n3904', '2n3906', 'tip120', 'irlz44n', 'pc817', '18650', 'fuse', 'solenoid', 'vibration', 'passive']) assert.ok(q(s).length || s === 'sg90' && P.T.servo, s);
});

test('relay module: LOW trigger from a 5 V supply switches COM→NO and lights a lamp; 3.3 V coil does not pull in', () => {
  const sup = mk('vcc5', 0, 100), rl = mk('relay1', 100, 100), g = mk('ground', 0, 200), lamp = mk('lamp', 200, 0, { v: 5, w: 1 });
  const wires = [w(pin(sup, '+'), pin(rl, 'VCC')), w(pin(sup, 'GND'), pin(g, 'GND')), w(pin(rl, 'GND'), pin(g, 'GND')), w(pin(sup, '+'), pin(rl, 'COM')), w(pin(rl, 'NO'), pin(lamp, '1')), w(pin(lamp, '2'), pin(g, 'GND'))];
  let s = run({ parts: [sup, rl, g, lamp], wires });
  assert.ok(!st(s, rl).on[0], 'IN floating = off'); assert.ok(!(st(s, lamp).i > 0.01));
  s = run({ parts: [sup, rl, g, lamp], wires: [...wires, w(pin(rl, 'IN'), pin(g, 'GND'))] });
  assert.ok(st(s, rl).on[0]); assert.ok(st(s, lamp).i > 0.15, st(s, lamp).i);
  const s3 = mk('vcc33', 0, 100, {}, 'S3'); const s2 = run({ parts: [s3, rl, g, lamp], wires: [w(pin(s3, '+'), pin(rl, 'VCC')), w(pin(s3, 'GND'), pin(g, 'GND')), w(pin(rl, 'GND'), pin(g, 'GND')), w(pin(rl, 'IN'), pin(g, 'GND'))] });
  assert.ok(!st(s2, rl).on[0]); assert.ok(/will not pull in/.test(s2.warnings.map((x) => x.msg).join()));
});

test('ESP32 example: relay, L298N PWM motor and ULN2003 half-step stepper all respond to GPIO', () => {
  const p = E.EX.act_motion(), s = new Sim(p); s.advance(0.05);
  const rt = s.espRuntime(p.parts.find((q) => q.type === 'esp32')), by = (id) => p.parts.find((q) => q.id === id);
  for (const g of [13, 12, 14, 27, 26, 33, 32, 25]) rt.pinMode(g, 'OUTPUT');
  rt.write(26, 0); rt.write(33, 1); rt.write(32, 0); rt.pwm(25, 0.8);
  const SEQ = [8, 12, 4, 6, 2, 3, 1, 9];
  for (let k = 0; k < 160; k++) { const v = SEQ[k % 8]; [13, 12, 14, 27].forEach((g, i) => rt.write(g, (v >> (3 - i)) & 1)); s.advance(0.002); }
  for (let i = 0; i < 20; i++) s.advance(0.05);
  assert.ok(st(s, by('K1')).on[0]); assert.ok(st(s, by('LAMP1')).i > 0.05);
  assert.ok(Math.abs(st(s, by('M1')).w) > 0.3, 'dc motor spins');
  assert.ok(st(s, by('M2')).pos >= 155, 'stepper half-steps ' + st(s, by('M2')).pos);
  rt.write(33, 0); rt.write(32, 1); for (let i = 0; i < 30; i++) s.advance(0.05); assert.ok(st(s, by('M1')).w < -0.3, 'reverse');
  assert.ok(p.code.includes('analogWrite') && p.mode === 'qemu');
});

test('A4988 counts STEP edges (DIR, microstep), needs RST tied to SLP and VMOT ≥ 8 V', () => {
  const esp = mk('esp32', 0, 300, {}, 'esp'), drv = mk('a4988', 300, 200), m = mk('nema17', 300, 50), ps = mk('bench', 500, 300, { pos: 0.4 }), g = mk('ground', 600, 400);
  const wires = [w(pin(drv, 'STEP'), pin(esp, 'D13')), w(pin(drv, 'DIR'), pin(esp, 'D12')), w(pin(drv, 'VDD'), pin(esp, '3V3')), w(pin(drv, 'GND2'), pin(g, 'GND')), w(pin(drv, 'VMOT'), pin(ps, '+')), w(pin(ps, '-'), pin(g, 'GND')),
    w(pin(drv, '1A'), pin(m, 'A+')), w(pin(drv, '1B'), pin(m, 'A-')), w(pin(drv, '2A'), pin(m, 'B+')), w(pin(drv, '2B'), pin(m, 'B-'))];
  const go = (ws) => { const s = new Sim({ parts: [esp, drv, m, ps, g], wires: ws }); s.advance(0.05); s.advance(0.05); const rt = s.espRuntime(esp); rt.pinMode(13, 'OUTPUT'); rt.pinMode(12, 'OUTPUT'); rt.write(12, 1); for (let k = 0; k < 50; k++) { rt.write(13, 1); s.advance(0.001); rt.write(13, 0); s.advance(0.001); } s.advance(0.05); return s; };
  let s = go(wires); assert.strictEqual(st(s, drv).steps || 0, 0); assert.ok(/RESET is floating/.test(s.warnings.map((x) => x.msg).join()));
  s = go([...wires, w(pin(drv, 'RST'), pin(drv, 'SLP'))]); assert.strictEqual(st(s, drv).steps, 50); assert.ok(Math.abs(st(s, m).ang - 90) < 1e-6, st(s, m).ang);
});

test('L293D drives a DC motor both ways from IN1/IN2 with EN high', () => {
  const sup = mk('vcc5', 0, 0), g = mk('ground', 0, 200), u = mk('l293d', 100, 100), mot = mk('motor', 300, 0, { v: 5, r: 10 });
  const base = [w(pin(sup, '+'), pin(u, 'VSS')), w(pin(sup, '+'), pin(u, 'VS')), w(pin(sup, '+'), pin(u, 'EN1')), w(pin(sup, 'GND'), pin(g, 'GND')), w(pin(u, 'GND1'), pin(g, 'GND')), w(pin(u, 'OUT1'), pin(mot, '+')), w(pin(u, 'OUT2'), pin(mot, '-'))];
  let s = run({ parts: [sup, g, u, mot], wires: [...base, w(pin(sup, '+'), pin(u, 'IN1')), w(pin(u, 'IN2'), pin(g, 'GND'))] }, 40);
  assert.ok(st(s, mot).w > 0.3, st(s, mot).w);
  s = run({ parts: [sup, g, u, mot], wires: [...base, w(pin(sup, '+'), pin(u, 'IN2')), w(pin(u, 'IN1'), pin(g, 'GND'))] }, 40);
  assert.ok(st(s, mot).w < -0.3);
});

test('regulated-supply example: 7805 → 5 V, AMS1117 → 3.3 V, TIP120 fires the solenoid', () => {
  const p = E.EX.b_power(), s = run(p), by = (id) => p.parts.find((q) => q.id === id);
  assert.ok(Math.abs(st(s, by('U1')).vout - 5) < 0.05); assert.ok(Math.abs(st(s, by('U2')).vout - 3.3) < 0.05); assert.ok(!st(s, by('SOL1')).on);
  st(s, by('SW1')).pressed = true; s.dirty = true; for (let i = 0; i < 10; i++) s.advance(0.05);
  assert.ok(st(s, by('SOL1')).on); assert.ok(st(s, by('SOL1')).fly); assert.ok(!st(s, by('F1')).burned);
  assert.ok(E.LIST.some((r) => r[0] === 'b_power' && r[2]) && E.LIST.some((r) => r[0] === 'act_motion'));
});

test('burn-out rules: fuse blows on a short, 7805 hits thermal shutdown, 1N4007 burns open', () => {
  const ps = mk('bench', 0, 0, { pos: 0.4, ilim: 10 }), f = mk('fuse', 100, 0, { rating: 0.5 }), r = mk('resistor', 200, 0, { r: 1, w: 0.25 });
  let s = run({ parts: [ps, f, r], wires: [w(pin(ps, '+'), pin(f, '1')), w(pin(f, '2'), pin(r, '1')), w(pin(r, '2'), pin(ps, '-'))] }, 5);
  assert.ok(st(s, f).burned);
  const ps2 = mk('bench', 0, 0, { pos: 0.6, ilim: 10 }), u = mk('lm7805', 100, 0), rl = mk('resistor', 200, 100, { r: 5, w: 25 }), g = mk('ground', 0, 100);
  s = run({ parts: [ps2, u, rl, g], wires: [w(pin(ps2, '+'), pin(u, 'IN')), w(pin(u, 'GND'), pin(g, 'GND')), w(pin(ps2, '-'), pin(g, 'GND')), w(pin(u, 'OUT'), pin(rl, '1')), w(pin(rl, '2'), pin(g, 'GND'))] }, 400);
  assert.ok(s.log.some((l) => /thermal shutdown/.test(l)), 'thermal shutdown');
  const ps3 = mk('bench', 0, 0, { pos: 0.2, ilim: 10 }), d = mk('d1n4007', 100, 0);
  s = run({ parts: [ps3, d], wires: [w(pin(ps3, '+'), pin(d, 'A')), w(pin(d, 'K'), pin(ps3, '-'))] }, 20);
  assert.ok(st(s, d).burned);
});

test('buck converter: input current ≈ Pout / (Vin·η), much less than Iout', () => {
  const ps = mk('bench', 0, 0, { pos: 0.4, ilim: 5 }), b = mk('buck', 100, 0, { vout: 5 }), rl = mk('resistor', 300, 0, { r: 5, w: 25 });
  const s = run({ parts: [ps, b, rl], wires: [w(pin(ps, '+'), pin(b, 'IN+')), w(pin(ps, '-'), pin(b, 'IN-')), w(pin(b, 'OUT+'), pin(rl, '1')), w(pin(rl, '2'), pin(b, 'OUT-'))] }, 40);
  const x = st(s, b); assert.ok(Math.abs(x.vo - 5) < 0.05, x.vo); assert.ok(Math.abs(x.iin - 5 * 1 / (12 * 0.88)) < 0.05, x.iin);
});

test('transistors: 2N3904 switch saturates, IRLZ44N on at 3.3 V, PC817 transfers', () => {
  const sup = mk('vcc5', 0, 0), g = mk('ground', 0, 200), rb = mk('resistor', 100, 100, { r: 4700 }), q = mk('n2n3904', 200, 150), rc = mk('resistor', 200, 0, { r: 470 });
  let s = run({ parts: [sup, g, rb, q, rc], wires: [w(pin(sup, 'GND'), pin(g, 'GND')), w(pin(sup, '+'), pin(rb, '1')), w(pin(rb, '2'), pin(q, 'B')), w(pin(q, 'E'), pin(g, 'GND')), w(pin(sup, '+'), pin(rc, '1')), w(pin(rc, '2'), pin(q, 'C'))] });
  assert.ok(st(s, q).vce < 0.3 && st(s, q).ic > 0.009, JSON.stringify(st(s, q)));
  const s3 = mk('vcc33', 0, 0), m = mk('irlz44n', 200, 150), rl = mk('resistor', 200, 0, { r: 5, w: 25 }), s5 = mk('vcc5', 300, 0, {}, 'S5');
  s = run({ parts: [s3, g, m, rl, s5], wires: [w(pin(s3, 'GND'), pin(g, 'GND')), w(pin(s5, 'GND'), pin(g, 'GND')), w(pin(s3, '+'), pin(m, 'G')), w(pin(m, 'S'), pin(g, 'GND')), w(pin(s5, '+'), pin(rl, '1')), w(pin(rl, '2'), pin(m, 'D'))] });
  assert.ok(st(s, m).id > 0.9 && st(s, m).vds < 0.1, JSON.stringify(st(s, m)));
  const o = mk('pc817', 200, 150), rled = mk('resistor', 100, 100, { r: 470 }), rpu = mk('resistor', 300, 50, { r: 10000 });
  s = run({ parts: [sup, g, o, rled, rpu], wires: [w(pin(sup, 'GND'), pin(g, 'GND')), w(pin(sup, '+'), pin(rled, '1')), w(pin(rled, '2'), pin(o, 'A')), w(pin(o, 'K'), pin(g, 'GND')), w(pin(sup, '+'), pin(rpu, '1')), w(pin(rpu, '2'), pin(o, 'C')), w(pin(o, 'E'), pin(g, 'GND'))] });
  assert.ok(s.pinVoltage(o, 'C') < 0.4, s.pinVoltage(o, 'C'));
});

test('passive buzzer reports the LEDC tone frequency from the ESP32', () => {
  const esp = mk('esp32', 0, 300, {}, 'esp'), bz = mk('buzzerp', 300, 100), g = mk('ground', 400, 200);
  const s = new Sim({ parts: [esp, bz, g], wires: [w(pin(bz, '+'), pin(esp, 'D18')), w(pin(bz, '-'), pin(g, 'GND'))] }); s.advance(0.05);
  const rt = s.espRuntime(esp); rt.pins[18].out = true; rt.pins[18].pwm = 0.5; rt.pins[18].pwmFreq = 2000; rt.version++; s.advance(0.05); s.advance(0.05);
  assert.strictEqual(Math.round(st(s, bz).hz), 2000);
});
