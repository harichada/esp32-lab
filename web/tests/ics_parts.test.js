// Add-on ICs / passives / inputs (js/parts/ics.js, passives.js, examples-ics.js): node --test tests/
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'sim.js', 'bom.js', 'examples.js', 'basic.js', 'parts/registry.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js']) require('../js/' + f);
const P = globalThis.Parts, E = globalThis.Examples, B = globalThis.Bom, IC = globalThis.ICDev, { Sim } = globalThis.SimCore;
const NEW = ['ne555', 'ic74hc595', 'ic74hc165', 'cd4017', 'cd4511', 'ic7400', 'ic7402', 'ic7404', 'ic7408', 'ic7432', 'ic7486', 'lm358', 'lm393', 'pcf8574', 'mcp23017', 'at24c32', 'ds3231',
  'ccap', 'ecap', 'inductor', 'crystal', 'trimmer', 'dipsw4', 'dipsw8', 'tact12', 'latchbtn', 'reed', 'tilt', 'rgbled', 'bargraph', 'photodiode', 'phototransistor', 'ntc', 'rnet'];
// tiny project builder: parts + "nets" (lists of [part, pin]) wired star-wise to the first pin
let n = 0;
const mk = (type, props = {}, x = 0, y = 0, rot = 0) => ({ id: type + (++n), type, x, y, rot, props: Object.assign({}, P.T[type].props, props) });
function proj(parts, nets) {
  const wires = []; for (const net of nets) { const a = P.pinWorld(net[0][0], P.T[net[0][0].type].pins(net[0][0]).find((q) => q.name === net[0][1])); for (const [p, nm] of net.slice(1)) { const b = P.pinWorld(p, P.T[p.type].pins(p).find((q) => q.name === nm)); wires.push({ id: 'w' + (++n), a, b, pts: [] }); } }
  return { name: 't', mode: 'circuit', parts, wires };
}
const place = (parts) => parts.forEach((p, i) => { p.x = (i % 5) * 400; p.y = Math.floor(i / 5) * 300 + 100; });

test('every new part is registered, renders SVG, has a BOM line and a searchable label', () => {
  for (const t of NEW) {
    const d = P.T[t]; assert.ok(d, t); const p = mk(t); const svg = d.svg(p, {}); assert.ok(svg.includes('data-pin'), t);
    const names = d.pins(p).map((q) => q.name); assert.strictEqual(new Set(names).size, names.length, t + ' duplicate pin names');
    assert.ok(B.CATALOG[t], t + ' bom'); const b = B.CATALOG[t](p.props); assert.ok(b.name && b.q && b.key, t);
    assert.ok(d.label && d.cat, t);
  }
  const L = B.list({ parts: [mk('ne555'), mk('ic74hc595'), mk('ccap')], wires: [], mode: 'circuit' }); assert.ok(L.some((e) => /NE555/.test(e.name) && /amazon\.com\/s\?k=/.test(e.url)));
});
test('DIP packages: pin 1 bottom-left, 0.3" row spacing, pin N top-left', () => {
  for (const [t, cnt] of [['ne555', 8], ['ic7400', 14], ['ic74hc595', 16], ['mcp23017', 28]]) { const ps = P.T[t].pins(mk(t)); assert.strictEqual(ps.length, cnt); assert.deepStrictEqual([ps[0].x, ps[0].y], [0, 0]); assert.deepStrictEqual([ps[cnt - 1].x, ps[cnt - 1].y], [0, -30]); }
});
test('555 astable example blinks at ~1.5 Hz without an ESP32', () => {
  const p = E.EX.ic_555blink(); const s = new Sim(p); const led = p.parts.find((q) => q.id === 'LED1'); let tr = 0, last = null;
  for (let i = 0; i < 200; i++) { s.advance(0.02); const v = s.partState(led).i > 0.005; if (last !== null && v !== last) tr++; last = v; }
  const cyc = s.partState(p.parts.find((q) => q.id === 'U1')).edges; assert.ok(cyc >= 5 && cyc <= 8, 'cycles ' + cyc); assert.ok(tr >= 9, 'transitions ' + tr);
  assert.ok(E.LIST.some((x) => x[0] === 'ic_555blink' && x[2]), 'listed under basic circuits');
});
test('555 monostable: trigger pulse gives one ~1.1·R·C pulse', () => {
  const bat = mk('vcc5'), u = mk('ne555'), r = mk('resistor', { r: 10000 }), c = mk('ecap', { c: '10u' }), rt = mk('resistor', { r: 10000 }), btn = mk('key'), gnd = mk('ground');
  place([bat, u, r, c, rt, btn, gnd]);
  const pr = proj([bat, u, r, c, rt, btn, gnd], [[[bat, '+'], [u, 'VCC'], [u, 'RESET'], [r, '1'], [rt, '1']], [[r, '2'], [u, 'THR'], [u, 'DIS'], [c, '+']], [[rt, '2'], [u, 'TRIG'], [btn, '1']], [[bat, 'GND'], [u, 'GND'], [c, '-'], [btn, '2'], [gnd, 'GND']]]);
  const s = new Sim(pr); s.advance(0.05); assert.strictEqual(s.partState(u).q, 0, 'idle low');
  s.partState(btn).pressed = true; s.dirty = true; s.advance(0.01); s.partState(btn).pressed = false; s.dirty = true;
  let hi = 0.01; while (s.partState(u).q && hi < 1) { s.advance(0.005); hi += 0.005; }
  assert.ok(Math.abs(hi - 0.11) < 0.02, 'pulse ' + hi);
});
function logicRig(type, inputs) {   // drive inputs from 5 V / GND through switches: returns {sim, set(name, v), out(name)}
  const sup = mk('vcc5'), u = mk(type), gnd = mk('ground'), parts = [sup, u, gnd], nets = [[[sup, '+'], [u, 'VCC']], [[sup, 'GND'], [u, 'GND'], [gnd, 'GND']]], sw = {};
  for (const nm of inputs) { const s = mk('slideswitch'); sw[nm] = s; parts.push(s); nets[0].push([s, '3']); nets[1].push([s, '1']); nets.push([[s, '2'], [u, nm]]); }
  place(parts); const sim = new Sim(proj(parts, nets));
  return { sim, u, set(nm, v) { sw[nm].props.pos = v ? 1 : 0; sim.dirty = true; sim.advance(0.002); }, out: (nm) => sim.pinVoltage(u, nm) > 2.5 ? 1 : 0 };
}
test('7400/7402/7404/7408/7432/7486 truth tables in basic-circuit mode', () => {
  const F = { ic7400: (a, b) => !(a && b), ic7402: (a, b) => !(a || b), ic7408: (a, b) => a && b, ic7432: (a, b) => a || b, ic7486: (a, b) => a !== b };
  for (const t in F) { const r = logicRig(t, ['1A', '1B', '4A', '4B']); for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) { r.set('1A', a); r.set('1B', b); r.set('4A', b); r.set('4B', a); assert.strictEqual(r.out('1Y'), F[t](a, b) ? 1 : 0, `${t} ${a}${b}`); assert.strictEqual(r.out('4Y'), F[t](b, a) ? 1 : 0, `${t} 4Y`); } }
  const r = logicRig('ic7404', ['1A', '6A']); r.set('1A', 0); r.set('6A', 1); assert.strictEqual(r.out('1Y'), 1); assert.strictEqual(r.out('6Y'), 0);
});
test('CD4017 counts clock edges, CD4511 decodes BCD', () => {
  const r = logicRig('cd4017', ['CLK', 'RST', 'INH']); r.set('RST', 0); r.set('INH', 0);
  for (let i = 0; i < 3; i++) { r.set('CLK', 1); r.set('CLK', 0); }
  assert.strictEqual(r.out('Q3'), 1); assert.strictEqual(r.out('Q0'), 0); assert.strictEqual(r.out('CO'), 1);
  r.set('RST', 1); assert.strictEqual(r.out('Q0'), 1);
  const d = logicRig('cd4511', ['A', 'B', 'C', 'D', 'LT', 'BI', 'LE']); d.set('LT', 1); d.set('BI', 1); d.set('LE', 0); d.set('A', 1); d.set('B', 1); d.set('C', 1);   // 7
  assert.deepStrictEqual('abcdefg'.split('').map(d.out), [1, 1, 1, 0, 0, 0, 0]);
  d.set('LE', 1); d.set('C', 0); assert.deepStrictEqual('abcdefg'.split('').map(d.out), [1, 1, 1, 0, 0, 0, 0], 'latched');
});
test('74HC165 parallel load then shift', () => {
  const r = logicRig('ic74hc165', ['SH_LD', 'CLK', 'CLK_INH', 'SER', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const byte = 0b10110010; ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((nm, i) => r.set(nm, (byte >> i) & 1)); r.set('CLK_INH', 0); r.set('SER', 0);
  r.set('SH_LD', 0); r.set('SH_LD', 1); const bits = [];
  for (let i = 0; i < 8; i++) { bits.push(r.out('QH')); r.set('CLK', 1); r.set('CLK', 0); }
  assert.deepStrictEqual(bits, [1, 0, 1, 1, 0, 0, 1, 0]);   // H first
});
test('74HC595 chaser example: bit-banged shiftOut from the ESP32 runtime lights the right LED', () => {
  const p = E.EX.ic_595chaser(); const s = new Sim(p); const esp = p.parts.find((q) => q.type === 'esp32'), rt = s.espRuntime(esp);
  for (const g of [23, 18, 5]) rt.pinMode(g, 'OUTPUT'); s.settle();
  const w = (g, v) => { rt.write(g, v); s.settle(); };
  const show = (b) => { w(5, 0); for (let i = 7; i >= 0; i--) { w(23, (b >> i) & 1); w(18, 1); w(18, 0); } w(5, 1); s.advance(0.01); };
  for (const k of [0, 3, 7]) { show(1 << k); const lit = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => (s.partState(p.parts.find((q) => q.id === 'LED' + i)).i || 0) > 0.002); assert.deepStrictEqual(lit, [k + 1]); }
});
test('LM358 follower / non-inverting gain, LM393 open-collector compare', () => {
  const sup = mk('vcc5'), u = mk('lm358'), pot = mk('potentiometer', { pos: 0.4 }), r1 = mk('resistor', { r: 10000 }), r2 = mk('resistor', { r: 10000 }), g = mk('ground');
  place([sup, u, pot, r1, r2, g]);
  const s = new Sim(proj([sup, u, pot, r1, r2, g], [[[sup, '+'], [u, 'VCC'], [pot, '1']], [[sup, 'GND'], [u, 'GND'], [pot, '2'], [r2, '2'], [g, 'GND'], [u, 'IN2+']], [[pot, 'W'], [u, 'IN1+']], [[u, 'OUT1'], [r1, '1']], [[r1, '2'], [r2, '1'], [u, 'IN1-']], [[u, 'OUT2'], [u, 'IN2-']]]));
  s.advance(0.01); const vin = s.pinVoltage(pot, 'W'), vo = s.pinVoltage(u, 'OUT1');
  assert.ok(Math.abs(vin - 3.0) < 0.05, 'vin ' + vin); assert.ok(Math.abs(vo - 3.5) < 0.05, 'clips at VCC-1.5: ' + vo);
  pot.props.pos = 0.8; s.dirty = true; s.advance(0.01); assert.ok(Math.abs(s.pinVoltage(u, 'OUT1') - 2 * s.pinVoltage(pot, 'W')) < 0.02, 'gain 2: ' + s.pinVoltage(u, 'OUT1') + ' / ' + s.pinVoltage(pot, 'W') + ' f ' + s.pinVoltage(u, 'OUT2'));
  const c = mk('lm393'), rp = mk('resistor', { r: 4700 }), pt = mk('potentiometer', { pos: 0.7 }), sp = mk('vcc5'), g2 = mk('ground'); place([c, rp, pt, sp, g2]);
  const s2 = new Sim(proj([c, rp, pt, sp, g2], [[[sp, '+'], [c, 'VCC'], [rp, '1'], [pt, '1']], [[sp, 'GND'], [c, 'GND'], [pt, '2'], [g2, 'GND'], [c, 'IN2+'], [c, 'IN2-']], [[pt, 'W'], [c, 'IN1+']], [[c, 'OUT1'], [rp, '2']]]));
  s2.advance(0.01); const hiOut = s2.pinVoltage(c, 'OUT1');   // IN1+ = 1.5 V, IN1- floating ~0 -> output released -> pulled up
  assert.ok(hiOut > 4.5, 'released ' + hiOut);
});
test('I2C chip models: PCF8574 port, MCP23017 registers, 24C32 paged memory, DS3231 BCD time', () => {
  const q = mk('mcp23017'); const m = new IC.MCP23017(q);
  m.start(false); m.write(0x00); m.write(0x00); m.stop();   // IODIRA = outputs
  m.start(false); m.write(0x14); m.write(0xa5); m.stop(); assert.strictEqual(m.reg[0x14], 0xa5);
  m.start(false); m.write(0x00); m.stop(); m.start(true); assert.strictEqual(m.read(), 0x00); assert.strictEqual(m.read(), 0xff, 'IODIRB default, sequential');
  const e = new IC.EE24C32(mk('at24c32')); e.start(false); [0x01, 0x1e, 1, 2, 3].forEach((b) => e.write(b)); e.stop();
  e.start(false); e.write(0x01); e.write(0x1e); e.start(true); assert.deepStrictEqual([e.read(), e.read()], [1, 2]);
  assert.strictEqual(e.mem[0x100], 3, 'page wrap at 32 bytes');
  let now = Date.UTC(2026, 10, 4, 21, 30, 15); const r = new IC.DS3231(mk('ds3231'), () => now);
  r.start(false); r.write(0); r.start(true); const b = [0, 1, 2, 3, 4, 5, 6].map(() => r.read()); assert.deepStrictEqual([b[0], b[1], b[2], b[4], b[5], b[6]], [0x15, 0x30, 0x21, 0x04, 0x11, 0x26]);
  r.start(false); [0, 0x00, 0x00, 0x12, 1, 0x01, 0x01, 0x30].forEach((x) => r.write(x)); r.stop(); now += 5000;
  r.start(false); r.write(0); r.start(true); assert.deepStrictEqual([r.read(), r.read(), r.read()], [0x05, 0x00, 0x12]);
  const pc = new IC.PCF8574(mk('pcf8574')); assert.strictEqual(pc.start(false), true);
});
test('PCF8574 drives an LED through the sim, address follows A0..A2 pins', () => {
  const sup = mk('vcc33'), u = mk('pcf8574'), r = mk('resistor', { r: 220 }), led = mk('led'), g = mk('ground'); place([sup, u, r, led, g]);
  const pr = proj([sup, u, r, led, g], [[[sup, '+'], [u, 'VCC'], [r, '1'], [u, 'A0']], [[sup, 'GND'], [u, 'GND'], [g, 'GND'], [u, 'A1'], [u, 'A2']], [[r, '2'], [led, 'A']], [[led, 'C'], [u, 'P3']]]);
  const s = new Sim(pr); s.advance(0.01); assert.strictEqual(u.props.addr, '0x21');
  const d = globalThis.PartsReg.i2cDev(u); d.start(false); d.write(0xff & ~(1 << 3)); d.stop(); s.advance(0.01);
  assert.ok(s.partState(led).i > 0.003, 'sinks LED current ' + s.partState(led).i);
});
test('passives & inputs: inductor RL time constant, NTC, photodiode, phototransistor, RGB LED, bar graph, switches, resistor network', () => {
  const sup = mk('vcc5'), L = mk('inductor', { l: '100m' }), r = mk('resistor', { r: 100 }), g = mk('ground'); place([sup, L, r, g]);
  const s = new Sim(proj([sup, L, r, g], [[[sup, '+'], [L, '1']], [[L, '2'], [r, '1']], [[sup, 'GND'], [r, '2'], [g, 'GND']]])); s.advance(0.001);   // tau = 1 ms
  const i1 = s.partState(L).iL; assert.ok(i1 > 0.05 * 0.55 && i1 < 0.05 * 0.72, 'i(tau) ' + i1); s.advance(0.01); assert.ok(Math.abs(s.partState(L).iL - 0.05) < 0.002);
  assert.ok(Math.abs(P.T.ntc.R(mk('ntc')) - 10000) < 1); assert.ok(P.T.ntc.R(mk('ntc', { temp: 50 })) < 4000);
  const parts = []; const add = (x) => { parts.push(x); return x; };
  const s5 = add(mk('vcc5')), gg = add(mk('ground')), rgb = add(mk('rgbled')), rr = add(mk('resistor', { r: 220 })), bar = add(mk('bargraph')), rb = add(mk('resistor', { r: 330 })), dip = add(mk('dipsw4')), rn = add(mk('rnet', { r: 1000 })), pt = add(mk('phototransistor', { lux: 500 })), rpt = add(mk('resistor', { r: 1000 }));
  place(parts);
  const s2 = new Sim(proj(parts, [[[s5, '+'], [rr, '1'], [rb, '1'], [rn, 'COM'], [rpt, '1']], [[rr, '2'], [rgb, 'G']], [[rb, '2'], [bar, 'A3']], [[s5, 'GND'], [gg, 'GND'], [rgb, 'COM'], [bar, 'K3'], [dip, '8'], [pt, 'E']], [[dip, '1'], [rn, '5']], [[rpt, '2'], [pt, 'C']]]));
  s2.advance(0.01);
  assert.ok(s2.partState(rgb).i.G > 0.005 && s2.partState(rgb).i.R < 1e-6, 'rgb green only'); assert.ok(s2.partState(bar).i[2] > 0.005 && s2.partState(bar).i[0] < 1e-6, 'bar seg 3');
  assert.ok(s2.pinVoltage(rn, '5') < 0.01 && Math.abs(s2.pinVoltage(rn, '4') - 5) < 0.05, 'rnet + dip');
  const vc = s2.pinVoltage(pt, 'C'); assert.ok(vc > 2.5 && vc < 3.5, 'phototransistor ~2 mA · 1k drop: ' + vc);
  assert.strictEqual(P.T.tilt.closed(mk('tilt', { tilt: 10 })), true); assert.strictEqual(P.T.tilt.closed(mk('tilt', { tilt: 90 })), false);
});
test('all add-on examples build and converge', () => {
  for (const k of ['ic_555blink', 'ic_595chaser']) { const p = E.EX[k](); const s = new Sim(p); for (let i = 0; i < 5; i++) s.advance(0.02); assert.ok(s.circuit.converged, k); }
});
