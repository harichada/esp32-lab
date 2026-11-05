// Sensor + display add-on parts (js/parts/*.js): node --test tests/
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver', 'parts', 'sim', 'i2cdev', 'jssketch', 'examples', 'bom', 'parts/registry', 'parts/sensors', 'parts/displays', 'parts/examples-sensors-displays']) require('../js/' + f + '.js');
const P = globalThis.Parts, { Sim } = globalThis.SimCore, { JsSketch } = globalThis.JsSketchMod, E = globalThis.Examples, B = globalThis.Bom, D = globalThis.SDDisplays;
const NEW = ['dht11', 'ds18b20', 'hcsr04', 'pir', 'ldrmod', 'soil', 'mq2', 'sound', 'irrecv', 'ky040', 'joystick', 'bmp280', 'hx711', 'lcd2004', 'seg7', 'tm1637', 'max7219'];
const mk = (type, id, x = 400, y = 100, props = {}) => ({ id, type, x, y, rot: 0, props: Object.assign({}, P.T[type].props, props) });
// rig: ESP32 at (0,0); wire each part pin to a GPIO / 3V3 / GND
function rig(q, map) {
  const esp = { id: 'esp', type: 'esp32', x: 0, y: 200, rot: 0, props: { power: 'usb' } }, wires = [];
  for (const [pn, ep] of Object.entries(map)) { const a = P.pinWorld(q, P.T[q.type].pins(q).find((z) => z.name === pn)), b = P.pinWorld(esp, P.T.esp32.pins(esp).find((z) => z.name === ep)); wires.push({ id: 'w' + pn, a, b, pts: [] }); }
  const proj = { parts: [esp, q], wires }; const sim = new Sim(proj); sim.advance(0.01); return { proj, sim, esp, rt: sim.espRuntime(esp), st: sim.partState(q) };
}
test('every new part is registered with pins, artwork, BOM entry and palette text', () => {
  for (const t of NEW) {
    const d = P.T[t]; assert.ok(d, t); assert.ok(d.pins(mk(t, 'X')).length >= 3, t); assert.ok(d.cat && d.label, t);
    assert.match(d.svg(mk(t, 'X'), null), /class="pin"/, t); assert.match(d.svg(mk(t, 'X'), {}), /<(rect|circle|path)/, t);
    const bom = B.list({ parts: [mk(t, 'X')], wires: [] }); assert.ok(bom.some((e) => e.key !== 'esp32' && e.key !== 'bb' && e.key !== 'jw' && /amazon\.com\/s\?k=/.test(e.url)), 'bom ' + t);
  }
});
test('analog modules: joystick, LDR module, soil, MQ-2 give the expected ADC voltages', () => {
  let r = rig(mk('joystick', 'J', 400, 100, { x: 1, y: -1 }), { GND: 'GND.1', '+5V': '3V3', VRx: 'D34', VRy: 'D35' });
  assert.ok(r.sim.pinVoltage(r.proj.parts[1], 'VRx') > 3.2); assert.ok(r.sim.pinVoltage(r.proj.parts[1], 'VRy') < 0.1);
  r = rig(mk('ldrmod', 'L', 400, 100, { lux: 1 }), { GND: 'GND.1', VCC: '3V3', AO: 'D32', DO: 'D33' }); const dark = r.sim.pinVoltage(r.proj.parts[1], 'AO');
  r.proj.parts[1].props.lux = 5000; r.sim.dirty = true; r.sim.advance(0.01); r.sim.advance(0.01); const bright = r.sim.pinVoltage(r.proj.parts[1], 'AO');
  assert.ok(dark > 2.5 && bright < 0.5, dark + ' ' + bright); assert.ok(r.sim.pinVoltage(r.proj.parts[1], 'DO') < 0.3, 'DO low when bright');
  r = rig(mk('soil', 'S', 400, 100, { moist: 0 }), { GND: 'GND.1', VCC: '3V3', AO: 'VP' }); const dry = r.sim.pinVoltage(r.proj.parts[1], 'AO');
  r.proj.parts[1].props.moist = 100; r.sim.dirty = true; r.sim.advance(0.01); assert.ok(dry > r.sim.pinVoltage(r.proj.parts[1], 'AO') + 1);
  r = rig(mk('mq2', 'G', 400, 100, { ppm: 200 }), { GND: 'GND.1', VCC: '3V3', AO: 'D34' }); const clean = r.sim.pinVoltage(r.proj.parts[1], 'AO');
  r.proj.parts[1].props.ppm = 8000; r.sim.dirty = true; r.sim.advance(0.01); assert.ok(r.sim.pinVoltage(r.proj.parts[1], 'AO') > clean + 0.5);
});
test('PIR holds OUT high for the hold time after motion', () => {
  const q = mk('pir', 'PIR', 400, 100, { hold: 1 }), r = rig(q, { GND: 'GND.1', VCC: '3V3', OUT: 'D26' });
  assert.ok(r.sim.pinVoltage(q, 'OUT') < 0.2); q.props.motion = true; r.sim.advance(0.05); r.sim.advance(0.01); assert.ok(r.sim.pinVoltage(q, 'OUT') > 3);
  q.props.motion = false; for (let i = 0; i < 25; i++) r.sim.advance(0.05); assert.ok(r.sim.pinVoltage(q, 'OUT') < 0.2);
});
test('HC-SR04 echo width = 58 µs/cm after a trigger pulse', () => {
  const q = mk('hcsr04', 'US', 400, 100, { cm: 100 }), r = rig(q, { GND: 'GND.1', VCC: '3V3', TRIG: 'D25', ECHO: 'D14' });
  r.rt.pinMode(25, 'OUTPUT'); r.rt.write(25, 1); r.sim.advance(10e-6); r.rt.write(25, 0); r.sim.advance(1e-6);
  let hi = 0; for (let i = 0; i < 2000; i++) { r.sim.advance(10e-6); if (r.rt.pinInput[14]) hi += 10; }
  assert.ok(Math.abs(hi - 5831) < 60, 'echo us ' + hi);
});
test('DHT11 answers the single-wire read with 40 bits (hum, 0, temp, 0, sum)', () => {
  const q = mk('dht11', 'DHT', 400, 100, { temp: 27, hum: 61 }), r = rig(q, { VCC: '3V3', DATA: 'D4', GND: 'GND.1' }), rt = r.rt, p = rt.pins[4];
  p.out = true; p.level = 0; rt.version++; r.sim.settle(); p.out = false; rt.version++; r.sim.settle();
  const bits = []; for (let i = 0; i < 41; i++) { p.pu = !p.pu; rt.version++; r.sim.settle(); if (i < 40) bits.push(rt.pinInput[4]); }
  const bytes = []; for (let b = 0; b < 5; b++) bytes.push(parseInt(bits.slice(b * 8, b * 8 + 8).join(''), 2));
  assert.deepStrictEqual(bytes, [61, 0, 27, 0, 88]); assert.strictEqual(r.st.reads, 1);
});
test('HX711 shifts out offset + grams·scale as 24-bit two\'s complement', () => {
  const q = mk('hx711', 'HX', 400, 100, { grams: 250, scale: 400, offset: -1000 }), r = rig(q, { GND: 'GND.1', VCC: '3V3', DT: 'D4', SCK: 'D5' }), rt = r.rt;
  rt.pinMode(5, 'OUTPUT'); rt.write(5, 0); r.sim.settle(); assert.strictEqual(rt.pinInput[4], 0, 'ready');
  let v = 0; for (let i = 0; i < 25; i++) { rt.write(5, 1); r.sim.settle(); if (i < 24) v = (v << 1) | rt.pinInput[4]; rt.write(5, 0); r.sim.settle(); }
  assert.strictEqual(v << 8 >> 8, -1000 + 250 * 400); assert.strictEqual(r.st.gain, 128);
});
test('KY-040 produces quadrature (CLK leads DT one way, lags the other)', () => {
  const q = mk('ky040', 'ENC'), r = rig(q, { GND: 'GND.1', '+': '3V3', CLK: 'D32', DT: 'D33', SW: 'D27' });
  const seq = []; q.props.pos = 1; for (let i = 0; i < 10; i++) { r.sim.advance(2.5e-3); seq.push('' + r.rt.pinInput[32] + r.rt.pinInput[33]); }
  const s = seq.filter((x, i) => x !== seq[i - 1]); assert.deepStrictEqual(s.slice(0, 5), ['11', '01', '00', '10', '11']);
});
test('IR receiver emits an NEC frame (9 ms leader, 32 bits) when pressed', () => {
  const q = mk('irrecv', 'IR'), r = rig(q, { GND: 'GND.1', VCC: '3V3', OUT: 'D15' }); assert.strictEqual(r.rt.pinInput[15], 1);
  r.st.pressed = true; let low = 0, edges = 0, last = 1; for (let i = 0; i < 1000; i++) { r.sim.advance(100e-6); const l = r.rt.pinInput[15]; if (!l) low += 100; if (l !== last) edges++; last = l; }
  assert.ok(edges >= 66, 'edges ' + edges); assert.ok(low > 9000 + 33 * 500, 'low us ' + low);
});
test('BMP280 identifies as 0x58 on I2C; LCD2004 renders 4 rows', () => {
  const d = globalThis.PartsReg.i2cDev(mk('bmp280', 'BMP')); d.start(false); d.write(0xD0); d.stop(); d.start(true); assert.strictEqual(d.read(), 0x58);
  const q = mk('lcd2004', 'LCD'), lcd = globalThis.PartsReg.i2cDev(q);
  const nib = (n, rs) => { const v = (n << 4) | 8 | (rs ? 1 : 0); lcd.write(v | 4); lcd.write(v); };
  const byte = (b, rs) => { nib(b >> 4, rs); nib(b & 15, rs); };
  lcd.start(); for (const n of [3, 3, 3, 2]) nib(n, 0); byte(0x28, 0); byte(0x0C, 0); byte(0x01, 0);
  const put = (row, s) => { byte(0x80 | [0, 0x40, 0x14, 0x54][row], 0); for (const ch of s) byte(ch.charCodeAt(0), 1); };
  put(0, 'Hello'); put(3, 'row four');
  const t = D.lcdText(lcd).split('\n'); assert.strictEqual(t[0].trimEnd(), 'Hello'); assert.strictEqual(t[3].trimEnd(), 'row four'); assert.strictEqual(t[0].length, 20);
});
test('single 7-segment digit lights the driven segments (common cathode, basic circuit)', () => {
  const q = mk('seg7', 'SEG', 100, 100), s = { id: 'V', type: 'vcc33', x: 300, y: 300, rot: 0, props: { v: 3.3 } }, g = { id: 'G', type: 'ground', x: 320, y: 300, rot: 0, props: {} };
  const pw = (pn) => P.pinWorld(q, P.T.seg7.pins(q).find((z) => z.name === pn)), rs = [];
  const wires = [{ id: 'wc', a: pw('COM2'), b: { x: 320, y: 300 }, pts: [] }];
  ['b', 'c'].forEach((n, i) => { const r = { id: 'R' + n, type: 'resistor', x: 200 + i * 40, y: 400, rot: 0, props: { r: 220 } }; rs.push(r); wires.push({ id: 'w1' + n, a: { x: 300, y: 300 }, b: P.pinWorld(r, P.T.resistor.pins(r)[0]), pts: [] }, { id: 'w2' + n, a: P.pinWorld(r, P.T.resistor.pins(r)[1]), b: pw(n), pts: [] }); });
  const proj = { mode: 'circuit', parts: [q, s, g, ...rs], wires }, sim = new Sim(proj); sim.advance(0.01); sim.advance(0.01);
  assert.strictEqual(P.T.seg7.digit(sim.partState(q)), 1, sim.readout(q));
});
test('examples: JS sensor panel prints readings; JS display demo drives TM1637 + MAX7219', async () => {
  for (const k of ['sensorsjs', 'displaysjs']) assert.ok(E.LIST.some((x) => x[0] === k) && E.EX[k], k);
  let proj = E.EX.sensorsjs(), sim = new Sim(proj), esp = proj.parts[0], out = [];
  proj.parts.find((q) => q.id === 'US1').props.cm = 40;
  let sk = new JsSketch(proj.code, { sim, espPart: esp, serial: (s) => out.push(s), onError: (e) => { throw e; } }); await sk.start();
  for (let f = 0; f < 60; f++) await sk.runUntil((f + 1) * 0.02, (dt) => sim.advance(dt)); sk.stop();
  const line = out.join('').split('\n').find((l) => /cm/.test(l)); assert.ok(line, out.join('')); const cm = +/\|\s+(\d+) cm/.exec(line)[1]; assert.ok(Math.abs(cm - 40) <= 2, line);
  proj = E.EX.displaysjs(); sim = new Sim(proj); esp = proj.parts[0];
  sk = new JsSketch(proj.code, { sim, espPart: esp, serial() {}, onError: (e) => { throw e; } }); await sk.start();
  for (let f = 0; f < 80; f++) await sk.runUntil((f + 1) * 0.02, (dt) => sim.advance(dt)); sk.stop();
  const tm = sim.partState(proj.parts.find((q) => q.id === 'TM1')), mx = sim.partState(proj.parts.find((q) => q.id === 'MTX1'));
  assert.match(P.T.tm1637.text(tm), /^\d{4}$/); assert.ok(tm.on && tm.bright === 7);
  assert.ok(mx.on && mx.rows.some((r) => r === 0xFF || r === 0x3C), JSON.stringify(mx.rows));
});
