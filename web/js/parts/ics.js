/* ICs (DIP packages): NE555, 74HC595, 74HC165, CD4017, CD4511, 7400/02/04/08/32/86 gates, LM358 op-amp, LM393 comparator,
 * and I2C chips PCF8574, MCP23017, 24C32 EEPROM, DS3231 RTC module. Registered through js/parts/registry.js.
 * Digital parts are evaluated (a) before each circuit build when the ESP32 changes a pin (espStep -> bit-banged shiftOut works
 * in lock-step with QEMU), (b) after every transient step (onStep, works with no MCU at all), (c) once per frame (tick).
 * Outputs are stamped as ~25 Ω to VCC / GND (push-pull), sink-only (open drain), or nothing (high-Z). */
(function (root) {
  const P = root.Parts, R = root.PartsReg, esc = P.esc, fmt = P.fmt;
  const SIMREF = new WeakMap();   // part -> Sim (I2C device models need pin voltages)
  // ---------- artwork helpers ----------
  const DEFS = `<linearGradient id="icEpoxy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34373d"/><stop offset=".12" stop-color="#23252a"/><stop offset="1" stop-color="#121316"/></linearGradient>
<linearGradient id="icLeg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8d949c"/><stop offset=".5" stop-color="#eef1f4"/><stop offset="1" stop-color="#8d949c"/></linearGradient>
<linearGradient id="icRtc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6fd1"/><stop offset="1" stop-color="#1b4690"/></linearGradient>
<radialGradient id="icCoin" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#c9ced4"/><stop offset="1" stop-color="#7c848d"/></radialGradient>`;
  function injectDefs() { const d = document.querySelector('#stage defs'); if (d && !d.querySelector('#icEpoxy')) d.insertAdjacentHTML('beforeend', DEFS); }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectDefs); else injectDefs(); }
  const dots = (pins) => pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join('');
  const t = (x, y, s, sz, fill = '#cfd3d8', anchor = 'middle', rot) => `<text x="${x}" y="${y}" font-size="${sz}" fill="${fill}" font-family="ui-monospace,Menlo,monospace" text-anchor="${anchor}"${rot !== undefined ? ` transform="rotate(${rot} ${x} ${y})"` : ''} pointer-events="none">${esc(s)}</text>`;
  // DIP: pin 1 bottom-left, counter-clockwise; rows 0.3" apart (straddles the breadboard channel: rows e / f)
  function dipPins(names) {
    const h = names.length / 2;
    return names.map((n, i) => i < h ? { name: n, x: i * 10, y: 0 } : { name: n, x: (names.length - 1 - i) * 10, y: -30 });
  }
  function dipSvg(names, mark, sub, labels, st) {
    const h = names.length / 2, W = (h - 1) * 10 + 12;
    let s = '';
    for (let i = 0; i < h; i++) s += `<rect x="${i * 10 - 1.6}" y="-5" width="3.2" height="5" fill="url(#icLeg)"/><rect x="${i * 10 - 1.6}" y="-30" width="3.2" height="5" fill="url(#icLeg)"/>`;
    s += `<rect x="-6" y="-25.5" width="${W}" height="21" rx="1.6" fill="url(#icEpoxy)" stroke="#07080a" stroke-width=".6" filter="url(#fShadow)"/>`;
    s += `<rect x="-5" y="-24.6" width="${W - 2}" height="3" rx="1" fill="#ffffff10" pointer-events="none"/><path d="M-6 -18.5 a3.4 3.4 0 0 1 0 7" fill="#0b0c0e" stroke="#000" stroke-width=".4"/><circle cx="-1.6" cy="-8.4" r="1.2" fill="#0b0c0e" stroke="#3a3e45" stroke-width=".3"/>`;
    s += t((h - 1) * 5, -15.4, mark, 5.2, '#e2e5e9') + (sub ? t((h - 1) * 5, -9.6, sub, 3, '#8e959d') : '');
    if (labels !== false) dipPins(names).forEach((q, i) => { const lb = (labels && labels[i]) || q.name; s += q.y === 0 ? t(q.x, -6, lb, 2.2, '#9aa1a9') : t(q.x, -22.2, lb, 2.2, '#9aa1a9'); });
    if (st && st.out) dipPins(names).forEach((q) => { const o = st.out[q.name]; if (o === 1) s += `<circle cx="${q.x}" cy="${q.y}" r="3.6" fill="#ff5a4e" opacity=".35" pointer-events="none"/>`; });
    return s;
  }
  // ---------- logic evaluation ----------
  function mkCtx(sim) {
    const esp = sim.project.parts.find((q) => q.type === 'esp32');
    return {
      sim, state: (p) => sim.partState(p),
      drive(p, name) {
        if (!esp || !sim.pinNet) return null; const n = sim.pinNet.get(p.id + ':' + name); if (!(n > 0)) return null;
        for (const pn of [...P.ESP_TOP, ...P.ESP_BOT]) { const g = P.espGpio(pn); if (g >= 0 && sim.pinNet.get(esp.id + ':' + pn) === n) { const pin = sim.espRuntime(esp).pins[g]; return pin.out && pin.pwm === undefined ? (pin.level ? 1 : 0) : null; } }
        return null;
      },
    };
  }
  const same = (a, b) => { const ka = Object.keys(a || {}), kb = Object.keys(b || {}); if (ka.length !== kb.length) return false; for (const k of ka) if (a[k] !== b[k]) return false; return true; };
  function evaluate(p, c) {
    const d = P.T[p.type], st = c.state(p), sim = c.sim; SIMREF.set(p, sim);
    if (!sim.pinNet) return false;
    const vg = sim.pinVoltage(p, d.gnd || 'GND'), vs = sim.pinVoltage(p, d.vcc || 'VCC') - vg;
    const powered = vs > (d.vmin || 1.8) || !sim.circuit;
    st.lv = st.lv || {}; st.prev = st.prev || {};
    const lv = (name) => {
      const dr = c.drive(p, name); if (dr !== null) return (st.lv[name] = dr);
      const v = sim.pinVoltage(p, name) - vg, th = Math.max(vs, 0.5), pv = st.lv[name] || 0;
      return (st.lv[name] = v > 0.55 * th ? 1 : v < 0.45 * th ? 0 : pv);
    };
    const A = (name) => sim.pinVoltage(p, name) - vg;
    const rise = (name) => { const v = lv(name), was = st.prev[name]; st.prev[name] = v; return v === 1 && was === 0; };
    const fall = (name) => { const v = lv(name), was = st.prev[name]; st.prev[name] = v; return v === 0 && was === 1; };
    const out = powered ? d.logic(p, { lv, A, rise, fall, st, vs, c }) || {} : {};
    if (!powered) { st.prev = {}; }
    st.powered = powered;
    if (same(out, st.out)) return false;
    st.out = out; return true;
  }
  function stampOuts(p, cx, ro) {
    const d = P.T[p.type], st = cx.state(p), out = st.out || {}, v = cx.node(p, d.vcc || 'VCC'), g = cx.node(p, d.gnd || 'GND');
    cx.add({ kind: 'R', a: v, b: g, r: d.iq ? 5 / d.iq : 50e3, main: true }, p);
    for (const n in out) {
      const o = out[n], nd = cx.node(p, n); if (!nd && nd !== 0) continue;
      if (o === 1) cx.add({ kind: 'R', a: nd, b: v, r: ro }, p);
      else if (o === 0) cx.add({ kind: 'R', a: nd, b: g, r: ro }, p);
      else if (o === 'w') cx.add({ kind: 'R', a: nd, b: v, r: 33e3 }, p);   // weak pull-up (PCF8574 quasi-bidirectional / MCP23017 GPPU)
    }
  }
  function chip(type, o) {
    return R.register(type, Object.assign({ cat: 'ICs', dynamic: true, prefix: 'U' }, o, {
      pins: () => dipPins(o.names), size: () => ({ w: (o.names.length / 2 - 1) * 10, h: 30 }),
      svg(p, st) { return dipSvg(o.names, o.mark || type.toUpperCase(), typeof o.sub === 'function' ? o.sub(p, st || {}) : o.sub, o.labels, o.showOut !== false ? st : null) + dots(this.pins(p)); },
      stamp(p, cx) { stampOuts(p, cx, o.ro || 25); if (o.stamp) o.stamp(p, cx); },
      espStep(p, c) { evaluate(p, mkCtx(c.sim)); },
      onStep(p, sim) { return evaluate(p, mkCtx(sim)); },
      tick(p, c) { return evaluate(p, mkCtx(c.sim)); },
      readout(p, cx) { const st = cx.state(p); if (!st.powered) return 'not powered (wire VCC and GND)'; return o.readout ? o.readout(p, st) : Object.entries(st.out || {}).filter(([, v]) => v === 1 || v === 0).map(([k, v]) => k + '=' + v).join(' '); },
      warn(p, cx) { if (cx.pinV(p, o.vcc || 'VCC') - cx.pinV(p, o.gnd || 'GND') > (o.vmax || 6.5)) return `${o.mark || type} supply above ${o.vmax || 6.5} V!`; },
    }), { bom: o.bom });
  }
  // ---------- 74xx quad 2-input gates (7400 / 7408 / 7432 / 7486 share a pinout; 7402 differs) ----------
  const Q2 = ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'];
  const Q2NOR = ['1Y', '1A', '1B', '2Y', '2A', '2B', 'GND', '3A', '3B', '3Y', '4A', '4B', '4Y', 'VCC'];
  const HEX = ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'];
  const gate = (type, label, names, fn, n, kw, q) => chip(type, {
    label, names, mark: '74HC' + type.slice(2), sub: label.replace(/^.*?\s/, ''), keywords: kw, iq: 1e-4, vmax: 6.5,
    logic(p, L) { const o = {}; for (let k = 1; k <= n; k++) o[k + 'Y'] = fn(L.lv(k + 'A'), n === 6 ? 0 : L.lv(k + 'B')) ? 1 : 0; return o; },
    bom: () => ({ key: type, name: `${'74HC' + type.slice(2)} ${label.replace(/^.*?\s/, '')} (DIP-14)`, q: q || `74HC${type.slice(2)} DIP-14 logic IC` }),
  });
  gate('ic7400', '7400 quad NAND', Q2, (a, b) => !(a && b), 4, 'nand gate logic 74hc00 74ls00');
  gate('ic7402', '7402 quad NOR', Q2NOR, (a, b) => !(a || b), 4, 'nor gate logic 74hc02 74ls02');
  gate('ic7404', '7404 hex inverter', HEX, (a) => !a, 6, 'not gate inverter logic 74hc04 74ls04');
  gate('ic7408', '7408 quad AND', Q2, (a, b) => a && b, 4, 'and gate logic 74hc08 74ls08');
  gate('ic7432', '7432 quad OR', Q2, (a, b) => a || b, 4, 'or gate logic 74hc32 74ls32');
  gate('ic7486', '7486 quad XOR', Q2, (a, b) => a !== b, 4, 'xor exclusive or gate logic 74hc86 74ls86');
  // ---------- 74HC595 8-bit shift register with output latch ----------
  const Q595 = ['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND', "QH'", 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'QA', 'VCC'];
  chip('ic74hc595', {
    label: '74HC595 shift register', names: Q595, mark: '74HC595', sub: 'SIPO · latch', keywords: 'shift register sipo serial in parallel out 595 led driver spi shiftout',
    labels: ['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND', "QH'", 'CLR̅', 'SCK', 'RCK', 'OE̅', 'SER', 'QA', 'VCC'], iq: 1e-4,
    logic(p, L) {
      const st = L.st; st.sr = st.sr || 0; st.lat = st.lat || 0;
      const ser = L.lv('SER'), rck = L.rise('RCLK'), sck = L.rise('SRCLK'), clr = L.lv('SRCLR');
      if (rck) st.lat = st.sr;   // storage register samples the shift register's previous contents (tied clocks lag one bit)
      if (!clr) st.sr = 0; else if (sck) st.sr = ((st.sr << 1) | ser) & 255;
      const o = {}, oe = !L.lv('OE');
      ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'].forEach((n, i) => { o[n] = oe ? (st.lat >> i) & 1 : 'z'; });
      o["QH'"] = (st.sr >> 7) & 1; return o;
    },
    readout: (p, st) => `latch=0b${(st.lat || 0).toString(2).padStart(8, '0').split('').reverse().join('')} (QA…QH) · shift=0x${(st.sr || 0).toString(16).padStart(2, '0')}`,
    bom: () => ({ key: '595', name: '74HC595 8-bit shift register (DIP-16)', q: '74HC595 DIP-16 shift register' }),
  });
  // ---------- 74HC165 8-bit parallel-in / serial-out ----------
  chip('ic74hc165', {
    label: '74HC165 PISO shift register', names: ['SH_LD', 'CLK', 'E', 'F', 'G', 'H', 'QH_N', 'GND', 'QH', 'SER', 'A', 'B', 'C', 'D', 'CLK_INH', 'VCC'], mark: '74HC165', sub: 'PISO',
    labels: ['SH/L̅D̅', 'CLK', 'E', 'F', 'G', 'H', 'Q̅H̅', 'GND', 'QH', 'SER', 'A', 'B', 'C', 'D', 'INH', 'VCC'], keywords: 'shift register piso parallel in serial out 165 button input expander shiftin', iq: 1e-4,
    logic(p, L) {
      const st = L.st; st.reg = st.reg || 0;
      const clk = L.rise('CLK');
      if (!L.lv('SH_LD')) { let r = 0; ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((n, i) => { r |= L.lv(n) << i; }); st.reg = r; }
      else if (clk && !L.lv('CLK_INH')) st.reg = ((st.reg << 1) | L.lv('SER')) & 255;
      const h = (st.reg >> 7) & 1; return { QH: h, QH_N: h ^ 1 };
    },
    readout: (p, st) => `reg A…H=${(st.reg || 0).toString(2).padStart(8, '0').split('').reverse().join('')} · QH=${((st.reg || 0) >> 7) & 1}`,
    bom: () => ({ key: '165', name: '74HC165 8-bit parallel-in shift register (DIP-16)', q: '74HC165 DIP-16 shift register' }),
  });
  // ---------- CD4017 decade counter / divider ----------
  chip('cd4017', {
    label: 'CD4017 decade counter', names: ['Q5', 'Q1', 'Q0', 'Q2', 'Q6', 'Q7', 'Q3', 'GND', 'Q8', 'Q4', 'Q9', 'CO', 'INH', 'CLK', 'RST', 'VCC'], mark: 'CD4017BE', sub: 'decade counter',
    labels: ['Q5', 'Q1', 'Q0', 'Q2', 'Q6', 'Q7', 'Q3', 'VSS', 'Q8', 'Q4', 'Q9', 'CO', 'INH', 'CLK', 'RST', 'VDD'], keywords: 'decade counter johnson 4017 led chaser divider', ro: 250, vmax: 18, vmin: 2.5, iq: 1e-5,
    logic(p, L) {
      const st = L.st; st.n = st.n || 0;
      const clk = L.rise('CLK');
      if (L.lv('RST')) st.n = 0; else if (clk && !L.lv('INH')) st.n = (st.n + 1) % 10;
      const o = {}; for (let i = 0; i < 10; i++) o['Q' + i] = st.n === i ? 1 : 0; o.CO = st.n < 5 ? 1 : 0; return o;
    },
    readout: (p, st) => `count=${st.n || 0} (Q${st.n || 0} high)`,
    bom: () => ({ key: '4017', name: 'CD4017 decade counter (DIP-16)', q: 'CD4017BE decade counter DIP-16' }),
  });
  // ---------- CD4511 BCD to 7-segment latch/decoder/driver ----------
  const SEG = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x1f, 0x70, 0x7f, 0x73];   // abcdefg, bit6 = a (4511: no tails on 6 / 9)
  chip('cd4511', {
    label: 'CD4511 BCD→7-segment decoder', names: ['B', 'C', 'LT', 'BI', 'LE', 'D', 'A', 'GND', 'e', 'd', 'c', 'b', 'a', 'g', 'f', 'VCC'], mark: 'CD4511BE', sub: 'BCD→7seg',
    labels: ['B', 'C', 'L̅T̅', 'B̅I̅', 'LE', 'D', 'A', 'VSS', 'e', 'd', 'c', 'b', 'a', 'g', 'f', 'VDD'], keywords: 'bcd 7 segment decoder driver 4511 seven segment display', ro: 80, vmax: 18, vmin: 2.5, iq: 1e-5,
    logic(p, L) {
      const st = L.st; if (st.bcd === undefined) st.bcd = 0;
      if (!L.lv('LE')) st.bcd = L.lv('A') | (L.lv('B') << 1) | (L.lv('C') << 2) | (L.lv('D') << 3);
      let m = SEG[st.bcd] || 0; if (!L.lv('LT')) m = 0x7f; else if (!L.lv('BI')) m = 0;
      const o = {}; 'abcdefg'.split('').forEach((s, i) => { o[s] = (m >> (6 - i)) & 1; }); return o;
    },
    readout: (p, st) => `latched BCD=${st.bcd || 0}${(st.bcd || 0) > 9 ? ' (blank)' : ''}`,
    bom: () => ({ key: '4511', name: 'CD4511 BCD to 7-segment decoder (DIP-16)', q: 'CD4511BE BCD 7 segment decoder DIP-16' }),
  });
  // ---------- NE555 timer ----------
  chip('ne555', {
    label: 'NE555 timer', names: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC'], mark: 'NE555P', sub: 'TIMER', ro: 10, vmax: 16, vmin: 4.5, iq: 3e-3,
    labels: ['GND', 'TRG', 'OUT', 'R̅S̅T̅', 'CV', 'THR', 'DIS', 'VCC'], keywords: '555 timer astable monostable oscillator blinker pwm lm555 ne555',
    stamp(p, cx) { const v = cx.node(p, 'VCC'), g = cx.node(p, 'GND'), c = cx.node(p, 'CTRL'); cx.add({ kind: 'R', a: v, b: c, r: 5e3 }, p); cx.add({ kind: 'R', a: c, b: g, r: 10e3 }, p); },
    logic(p, L) {
      const st = L.st, vc = L.A('CTRL'); if (st.q === undefined) st.q = 0;
      if (L.A('RESET') < 0.7) st.q = 0;
      else if (L.A('TRIG') < vc / 2) { if (!st.q) st.edges = (st.edges || 0) + 1; st.q = 1; }
      else if (L.A('THR') > vc) st.q = 0;
      return { OUT: st.q, DIS: st.q ? 'z' : 0 };
    },
    readout: (p, st) => `OUT ${st.q ? 'HIGH' : 'LOW'} · ${st.edges || 0} cycles`,
    bom: () => ({ key: '555', name: 'NE555 timer IC (DIP-8)', q: 'NE555P timer IC DIP-8' }),
  });
  // ---------- LM358 dual op-amp / LM393 dual comparator (analog: solver 'OA' element) ----------
  const OPN = ['OUT1', 'IN1-', 'IN1+', 'GND', 'IN2+', 'IN2-', 'OUT2', 'VCC'];
  for (const [type, label, mark, oc, kw, q] of [['lm358', 'LM358 dual op-amp', 'LM358P', false, 'op amp opamp operational amplifier lm358 amplifier buffer', 'LM358P dual op amp DIP-8'], ['lm393', 'LM393 dual comparator', 'LM393P', true, 'comparator lm393 open collector threshold', 'LM393P dual comparator DIP-8']]) {
    R.register(type, {
      label, cat: 'ICs', prefix: 'U', keywords: kw,
      pins: () => dipPins(OPN), size: () => ({ w: 30, h: 30 }),
      svg(p) { return dipSvg(OPN, mark, oc ? 'COMPARATOR' : 'OP-AMP', ['OUT1', 'IN1−', 'IN1+', 'GND', 'IN2+', 'IN2−', 'OUT2', 'VCC']) + dots(this.pins(p)); },
      stamp(p, cx) {
        const v = cx.node(p, 'VCC'), g = cx.node(p, 'GND');
        cx.add({ kind: 'R', a: v, b: g, r: 5 / 0.0007, main: true }, p);
        for (const k of [1, 2]) cx.add({ kind: 'OA', p: cx.node(p, 'IN' + k + '+'), n: cx.node(p, 'IN' + k + '-'), o: cx.node(p, 'OUT' + k), vp: v, vn: g, oc, a: 2e4, ro: oc ? 15 : 20, hi: 1.5, lo: 0.02, tag: 'oa' + k }, p);
      },
      readout(p, cx) { return [1, 2].map((k) => `OUT${k}=${fmt(cx.pinV(p, 'OUT' + k) - cx.pinV(p, 'GND'), 'V')}`).join(' · ') + (oc ? ' (open collector: add a pull-up)' : ''); },
      warn(p, cx) { if (cx.pinV(p, 'VCC') - cx.pinV(p, 'GND') > 32) return 'supply above 32 V!'; },
    }, { bom: () => ({ key: type, name: label + ' (DIP-8)', q }) });
  }
  // ---------- I2C chips ----------
  const aPins = (p, names) => { const sim = SIMREF.get(p); if (!sim) return 0; const vg = sim.pinVoltage(p, 'GND'), vs = sim.pinVoltage(p, 'VCC') - vg; let a = 0; names.forEach((n, i) => { if (sim.pinVoltage(p, n) - vg > vs / 2) a |= 1 << i; }); return a; };
  function addrFromPins(base, names) { return { espStep(p, c) { SIMREF.set(p, c.sim); const a = '0x' + (base | aPins(p, names)).toString(16).toUpperCase(); if (p.props.addr !== a) p.props.addr = a; }, tick(p, c) { this.espStep(p, c); } }; }
  const i2cStamp = (p, cx) => { const st = cx.state(p), v = cx.node(p, 'VCC'), g = cx.node(p, 'GND'); cx.add({ kind: 'R', a: v, b: g, r: 3.3 / 0.0003, main: true }, p); return { st, v, g }; };
  const pinLv = (q, name) => { const sim = SIMREF.get(q); if (!sim) return 0; const vg = sim.pinVoltage(q, 'GND'), vs = sim.pinVoltage(q, 'VCC') - vg; return sim.pinVoltage(q, name) - vg > vs * 0.5 ? 1 : 0; };
  const touch = (q) => { const sim = SIMREF.get(q); if (sim) { sim.dirty = true; } };
  // PCF8574: quasi-bidirectional port. Writing 1 = weak pull-up (input), 0 = strong sink.
  const PCFN = ['A0', 'A1', 'A2', 'P0', 'P1', 'P2', 'P3', 'GND', 'P4', 'P5', 'P6', 'P7', 'INT', 'SCL', 'SDA', 'VCC'];
  class PCF8574 { constructor(q) { this.q = q; } start() { return true; } write(b) { const sim = SIMREF.get(this.q); if (sim) { sim.partState(this.q).port = b & 255; sim.dirty = true; } } read() { let v = 0; for (let i = 0; i < 8; i++) v |= pinLv(this.q, 'P' + i) << i; return v; } stop() {} }
  R.register('pcf8574', Object.assign({
    label: 'PCF8574 I2C 8-bit expander', cat: 'ICs', prefix: 'U', props: { addr: '0x20' }, keywords: 'i2c io expander gpio pcf8574 port expander',
    pins: () => dipPins(PCFN), size: () => ({ w: 70, h: 30 }),
    svg(p, st) { return dipSvg(PCFN, 'PCF8574P', 'I²C ' + p.props.addr) + dots(this.pins(p)); },
    stamp(p, cx) { const { st, v, g } = i2cStamp(p, cx), port = st.port === undefined ? 255 : st.port; for (let i = 0; i < 8; i++) cx.add((port >> i) & 1 ? { kind: 'R', a: cx.node(p, 'P' + i), b: v, r: 33e3 } : { kind: 'R', a: cx.node(p, 'P' + i), b: g, r: 25 }, p); cx.add({ kind: 'R', a: cx.node(p, 'SCL'), b: v, r: 1e9 }, p); },
    readout(p, cx) { const st = cx.state(p); return `${p.props.addr} (A2..A0 pins) · port=0x${(st.port === undefined ? 255 : st.port).toString(16).padStart(2, '0')}`; },
  }, addrFromPins(0x20, ['A0', 'A1', 'A2'])), { i2c: (q) => new PCF8574(q), bom: () => ({ key: 'pcf8574', name: 'PCF8574 I2C I/O expander (DIP-16)', q: 'PCF8574P DIP-16 I2C expander' }) });
  // MCP23017: 16-bit expander, IOCON.BANK=0 register map, sequential addressing
  const MCPN = ['GPB0', 'GPB1', 'GPB2', 'GPB3', 'GPB4', 'GPB5', 'GPB6', 'GPB7', 'VCC', 'GND', 'NC1', 'SCL', 'SDA', 'NC2', 'A0', 'A1', 'A2', 'RESET', 'INTB', 'INTA', 'GPA0', 'GPA1', 'GPA2', 'GPA3', 'GPA4', 'GPA5', 'GPA6', 'GPA7'];
  class MCP23017 {
    constructor(q) { this.q = q; this.reg = new Uint8Array(22); this.reg[0] = this.reg[1] = 0xff; this.ptr = 0; this.first = false; }
    start(rd) { this.first = !rd; return true; }
    write(b) {
      if (this.first) { this.ptr = b % 22; this.first = false; return; }
      const r = this.ptr; if (r === 0x12 || r === 0x13) this.reg[r + 2] = b; else if (r !== 0x0e && r !== 0x0f && r !== 0x10 && r !== 0x11) this.reg[r] = b;
      this.ptr = (this.ptr + 1) % 22; this.sync();
    }
    read() { const r = this.ptr; this.ptr = (this.ptr + 1) % 22; if (r === 0x12 || r === 0x13) { const ab = r === 0x12 ? 'A' : 'B'; let v = 0; for (let i = 0; i < 8; i++) v |= pinLv(this.q, 'GP' + ab + i) << i; return (v ^ this.reg[r - 0x10]) & 255; } return this.reg[r]; }
    stop() {}
    sync() { const sim = SIMREF.get(this.q); if (!sim) return; const st = sim.partState(this.q); st.iodir = [this.reg[0], this.reg[1]]; st.olat = [this.reg[0x14], this.reg[0x15]]; st.gppu = [this.reg[0x0c], this.reg[0x0d]]; sim.dirty = true; }
  }
  R.register('mcp23017', Object.assign({
    label: 'MCP23017 I2C 16-bit expander', cat: 'ICs', prefix: 'U', props: { addr: '0x20' }, keywords: 'i2c io expander gpio mcp23017 16 bit port expander',
    pins: () => dipPins(MCPN), size: () => ({ w: 130, h: 30 }),
    svg(p) { return dipSvg(MCPN, 'MCP23017-E/SP', 'I²C ' + p.props.addr, MCPN.map((n) => n === 'VCC' ? 'VDD' : n === 'GND' ? 'VSS' : n === 'RESET' ? 'R̅S̅T̅' : /^NC/.test(n) ? 'NC' : n.replace('GP', ''))) + dots(this.pins(p)); },
    stamp(p, cx) {
      const { st, v, g } = i2cStamp(p, cx), dir = st.iodir || [255, 255], lat = st.olat || [0, 0], pu = st.gppu || [0, 0];
      ['A', 'B'].forEach((ab, k) => { for (let i = 0; i < 8; i++) { const n = cx.node(p, 'GP' + ab + i); if (!((dir[k] >> i) & 1)) cx.add({ kind: 'R', a: n, b: (lat[k] >> i) & 1 ? v : g, r: 25 }, p); else if ((pu[k] >> i) & 1) cx.add({ kind: 'R', a: n, b: v, r: 100e3 }, p); } });
    },
    readout(p, cx) { const st = cx.state(p), d = st.iodir || [255, 255], l = st.olat || [0, 0]; return `${p.props.addr} · IODIR A/B=0x${d[0].toString(16)}/0x${d[1].toString(16)} · OLAT=0x${l[0].toString(16)}/0x${l[1].toString(16)}`; },
  }, addrFromPins(0x20, ['A0', 'A1', 'A2'])), { i2c: (q) => new MCP23017(q), bom: () => ({ key: 'mcp23017', name: 'MCP23017 16-bit I2C I/O expander (DIP-28)', q: 'MCP23017-E/SP DIP-28' }) });
  // 24C32 EEPROM (4 KiB, 2-byte address, 32-byte pages). Contents survive sim resets for the page session.
  const EEMEM = new Map();
  class EE24C32 {
    constructor(q) { this.q = q; if (!EEMEM.has(q.id)) EEMEM.set(q.id, new Uint8Array(4096).fill(0xff)); this.mem = EEMEM.get(q.id); this.ptr = 0; this.n = 0; this.rd = false; }
    start(rd) { this.rd = !!rd; this.n = 0; return true; }
    write(b) {
      if (this.n === 0) this.ptr = (this.ptr & 0xff) | ((b & 0x0f) << 8); else if (this.n === 1) this.ptr = (this.ptr & 0xf00) | b;
      else if (!pinLv(this.q, 'WP')) { this.mem[this.ptr] = b; this.ptr = (this.ptr & ~31) | ((this.ptr + 1) & 31); this.dirty = true; }
      this.n++;
    }
    read() { const b = this.mem[this.ptr]; this.ptr = (this.ptr + 1) & 4095; return b; }
    stop() { if (this.dirty) { const sim = SIMREF.get(this.q); if (sim) { const st = sim.partState(this.q); st.writes = (st.writes || 0) + 1; } this.dirty = false; } }
  }
  const EEN = ['A0', 'A1', 'A2', 'GND', 'SDA', 'SCL', 'WP', 'VCC'];
  R.register('at24c32', Object.assign({
    label: '24C32 I2C EEPROM 4 KB', cat: 'ICs', prefix: 'U', props: { addr: '0x50' }, keywords: 'eeprom i2c memory 24c32 at24c32 24lc32 storage',
    pins: () => dipPins(EEN), size: () => ({ w: 30, h: 30 }),
    svg(p) { return dipSvg(EEN, 'AT24C32', p.props.addr) + dots(this.pins(p)); },
    stamp(p, cx) { i2cStamp(p, cx); },
    readout(p, cx) { const st = cx.state(p); return `${p.props.addr} · ${st.writes || 0} write cycles`; },
  }, addrFromPins(0x50, ['A0', 'A1', 'A2'])), { i2c: (q) => new EE24C32(q), bom: () => ({ key: '24c32', name: 'AT24C32 I2C EEPROM (DIP-8)', q: 'AT24C32 EEPROM DIP-8' }) });
  // DS3231 RTC module (ZS-042 style): time runs from the browser clock plus whatever offset the sketch sets
  const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10)) & 255, unbcd = (b) => (b >> 4) * 10 + (b & 15);
  class DS3231 {
    constructor(q, now = () => Date.now()) { this.q = q; this.now = now; this.off = 0; this.reg = new Uint8Array(19); this.reg[0x0e] = 0x1c; this.reg[0x0f] = 0x88; this.ptr = 0; this.first = false; this.wr = null; }
    date() { return new Date(this.now() + this.off); }
    snap() { const d = this.date(); const r = this.reg; r[0] = bcd(d.getUTCSeconds()); r[1] = bcd(d.getUTCMinutes()); r[2] = bcd(d.getUTCHours()); r[3] = d.getUTCDay() + 1; r[4] = bcd(d.getUTCDate()); r[5] = bcd(d.getUTCMonth() + 1) | (d.getUTCFullYear() >= 2100 ? 0x80 : 0); r[6] = bcd(d.getUTCFullYear() % 100); const tc = Math.round(((this.q.props && +this.q.props.temp) || 25) * 4); r[0x11] = (tc >> 2) & 255; r[0x12] = (tc & 3) << 6; }
    start(rd) { this.first = !rd; if (rd) this.snap(); return true; }
    write(b) {
      if (this.first) { this.ptr = b % 19; this.first = false; this.snap(); return; }
      if (this.ptr < 7) { this.reg[this.ptr] = b; this.wr = true; } else if (this.ptr < 0x11) this.reg[this.ptr] = b;
      this.ptr = (this.ptr + 1) % 19;
    }
    read() { const b = this.reg[this.ptr]; this.ptr = (this.ptr + 1) % 19; return b; }
    stop() {
      if (!this.wr) return; this.wr = false; const r = this.reg;
      const t = Date.UTC(2000 + unbcd(r[6]) + (r[5] & 0x80 ? 100 : 0), unbcd(r[5] & 0x1f) - 1, unbcd(r[4] & 0x3f), unbcd(r[2] & 0x3f), unbcd(r[1] & 0x7f), unbcd(r[0] & 0x7f));
      this.off = t - this.now(); this.reg[0x0f] &= 0x7f;
    }
  }
  R.register('ds3231', {
    label: 'DS3231 RTC module (I2C)', cat: 'ICs', prefix: 'RTC', props: { addr: '0x68', temp: 25 }, keywords: 'rtc real time clock ds3231 zs-042 i2c clock calendar',
    edit: [{ k: 'temp', label: 'Chip temperature (°C)', t: 'range', min: -40, max: 85, step: 0.25, live: true }],
    pins: () => ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'].map((n, i) => ({ name: n, x: i * 10, y: 0 })), size: () => ({ w: 50, h: 10 }),
    svg(p) {
      let s = `<rect x="-10" y="-58" width="70" height="52" rx="3" fill="url(#icRtc)" stroke="#0e2a5a" stroke-width=".6" filter="url(#fShadow)"/>`;
      s += [[-6, -54], [56, -54]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="url(#aGold)"/><circle cx="${x}" cy="${y}" r="1.6" fill="#0d0f12"/>`).join('');
      s += `<circle cx="38" cy="-34" r="15" fill="url(#icCoin)" stroke="#5d646d" stroke-width=".6"/>${t(38, -33, 'CR2032', 4, '#5d646d')}${t(38, -27, '+', 6, '#5d646d')}`;
      s += `<rect x="0" y="-48" width="16" height="12" rx="1" fill="url(#icEpoxy)" stroke="#000" stroke-width=".4"/>${t(8, -41, 'DS3231', 2.6)}<rect x="0" y="-30" width="10" height="7" rx=".8" fill="url(#icEpoxy)"/>${t(5, -25.5, '24C32', 2)}`;
      s += [0, 10, 20, 30, 40, 50].map((x) => `<rect x="${x - 4.4}" y="-10" width="8.8" height="8.8" rx=".8" fill="#17181b"/><rect x="${x - 1.6}" y="-7.6" width="3.2" height="3.2" fill="url(#aGold)"/>`).join('');
      s += ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'].map((n, i) => t(i * 10, -13, n, 3, '#f2f2f2')).join('');
      return s + `<text x="25" y="-62" class="plbl">DS3231 RTC ${esc(p.props.addr)}</text>` + dots(this.pins(p));
    },
    stamp(p, cx) { const { v } = i2cStamp(p, cx); cx.add({ kind: 'R', a: cx.node(p, 'SCL'), b: v, r: 4.7e3 }, p); cx.add({ kind: 'R', a: cx.node(p, 'SDA'), b: v, r: 4.7e3 }, p); },
    espStep(p, c) { SIMREF.set(p, c.sim); }, tick(p, c) { SIMREF.set(p, c.sim); },
    readout(p, cx) { const st = cx.state(p); return `0x68 · ${st.i2cInfo || 'no traffic yet'}`; },
  }, { i2c: (q) => new DS3231(q), bom: () => ({ key: 'ds3231', name: 'DS3231 RTC module (ZS-042) + CR2032', q: 'DS3231 RTC module ZS-042 AT24C32' }) });

  root.ICDev = { PCF8574, MCP23017, EE24C32, DS3231, SIMREF, evaluate, mkCtx, dipPins, dipSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ICDev;
})(typeof window !== 'undefined' ? window : globalThis);
