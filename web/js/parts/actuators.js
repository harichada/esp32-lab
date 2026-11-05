/* Actuators, motor drivers and switching modules: relay modules (1/2-ch), passive buzzer, vibration motor, solenoid,
 * L298N and L293D H-bridges (drive the existing 'motor' part), ULN2003 + 28BYJ-48 stepper, A4988 + NEMA17 stepper.
 * Logic inputs are read from the ESP32's driven GPIO level (espStep, before every circuit build, so fast bit-banged
 * step sequences are not missed) or, without an MCU, from node voltages of the last solve (tick -> rebuild on change). */
(function (root) {
  const P = root.Parts, R = root.PartsReg, K = root.HwKit;
  if (!P || !R || !K) return;
  const { dots, silk, header, mhole, led, plbl, screws, lbls, net, volt, level, duty, pwmFreq, linked, hasFlyback, burnCheck, wireLead, smoke, esc, fmt } = K;
  const vin = (c, p, name) => { const g = c.gpio(p, name); if (g && g.pin.out) return g.pin.pwm !== undefined ? 3.3 * g.pin.pwm : (g.pin.level ? 3.3 : 0); return volt(c.sim, p, name); };
  const vdiff = (c, p, a, b) => volt(c.sim, p, a) - volt(c.sim, p, b);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // =============== relay modules (SRD-05VDC-SL-C, optocoupled, jumper-selectable LOW/HIGH trigger) ===============
  function relayMod(type, n) {
    const ins = n === 1 ? ['IN'] : ['IN1', 'IN2'];
    const pins = [{ name: 'VCC', x: 0, y: 0 }, { name: 'GND', x: 10, y: 0 }, ...ins.map((nm, i) => ({ name: nm, x: 20 + i * 10, y: 0 }))];
    const term = (k) => { const b = k * 40, s = n === 1 ? '' : String(k + 1); return [{ name: 'NO' + s, x: b, y: -90 }, { name: 'COM' + s, x: b + 10, y: -90 }, { name: 'NC' + s, x: b + 20, y: -90 }]; };
    for (let k = 0; k < n; k++) pins.push(...term(k));
    const W = n === 1 ? 20 : 60;
    R.register(type, {
      label: n === 1 ? 'Relay module 1-channel 5 V (SRD-05VDC)' : 'Relay module 2-channel 5 V (SRD-05VDC)', cat: 'Motors / Actuators', prefix: 'K',
      props: { trig: 'low', imax: 10 }, dynamic: false,
      edit: [{ k: 'trig', label: 'Trigger jumper', t: 'sel', opts: ['low', 'high'] }, { k: 'imax', label: 'Contact rating (A)', t: 'num' }],
      pins: () => pins, size: () => ({ w: W, h: 10 }),
      svg(p, st) {
        st = st || {}; const on = st.on || [];
        let s = `<rect x="-12" y="-112" width="${W + 24}" height="122" rx="3" fill="url(#hkBlue)" stroke="#0b2a5e" stroke-width=".7" filter="url(#fShadow)"/>`;
        s += mhole(-6, -106) + mhole(W + 6, -106) + mhole(-6, 4) + mhole(W + 6, 4);
        for (let k = 0; k < n; k++) {
          const b = k * 40, sfx = n === 1 ? '' : String(k + 1);
          s += screws([b, b + 10, b + 20], -86);
          s += `<rect x="${b - 8}" y="-72" width="36" height="40" rx="1.5" fill="#1d5fd0" stroke="#0b2a5e" stroke-width=".6"/><rect x="${b - 8}" y="-72" width="36" height="6" fill="#ffffff22"/>`;
          s += silk(b + 10, -58, 'SONGLE', 4) + silk(b + 10, -51, 'SRD-05VDC-SL-C', 2.6) + silk(b + 10, -45, '10A 250VAC', 2.6) + silk(b + 10, -39, '10A 30VDC', 2.6);
          s += silk(b, -94, 'NO', 3.2) + silk(b + 10, -94, 'COM', 3.2) + silk(b + 20, -94, 'NC', 3.2);
          s += led(b + 22, -24, on[k], '#ff3b30') + silk(b + 10, -22, 'K' + (sfx || '1'), 3);
          // contact indicator (armature)
          s += `<path d="M${b + 10} -80 L${on[k] ? b + 1 : b + 19} -76" stroke="#ffd84a" stroke-width="1.2" opacity=".9"/>`;
          if (st.cburn && st.cburn[k]) s += smoke(b + 10, -76);
        }
        s += `<rect x="-6" y="-26" width="10" height="7" rx=".8" fill="#e8e8e8"/><rect x="-5" y="-25" width="8" height="5" fill="#222"/>` + silk(-1, -14, 'PC817', 2.4);
        s += `<rect x="${W - 2}" y="-30" width="10" height="5" rx=".6" fill="#17181b"/><rect x="${p.props.trig === 'high' ? W + 3 : W - 2}" y="-31" width="5" height="7" fill="#ffd84a"/>` + silk(W + 3, -20, p.props.trig === 'high' ? 'H' : 'L', 3);
        s += led(4, -8, st.pw, '#33e07a', 1.6);
        s += header(pins.filter((q) => q.y === 0).map((q) => q.x), 0);
        s += pins.filter((q) => q.y === 0).map((q) => silk(q.x, 9.5, q.name, 3.2)).join('');
        return s + dots(this.pins(p)) + plbl(W / 2, -116, (n === 1 ? '1-ch' : '2-ch') + ' relay · ' + (p.props.trig === 'high' ? 'HIGH' : 'LOW') + ' trigger');
      },
      active(p, c, k) {
        const vcc = vdiff(c, p, 'VCC', 'GND'), v = vin(c, p, ins[k]) - volt(c.sim, p, 'GND');
        if (vcc < 3.6) return false;   // SRD-05VDC pull-in ≈ 3.75 V
        return p.props.trig === 'high' ? v > 2.0 : vcc - v > 2.0;
      },
      _upd(p, c) { const st = c.state(p), on = ins.map((_, k) => this.active(p, c, k)), pw = vdiff(c, p, 'VCC', 'GND') > 2.5; const ch = !same(on, st.on) || pw !== st.pw; if (ch && st.on) on.forEach((o, k) => { if (o !== st.on[k]) c.sim.log.push(`🔌 ${p.id} relay ${k + 1} ${o ? 'ON (click)' : 'OFF (clack)'}`); }); st.on = on; st.pw = pw; st.vcc = vdiff(c, p, 'VCC', 'GND'); return ch; },
      espStep(p, c) { this._upd(p, c); }, tick(p, c) { return this._upd(p, c); },
      stamp(p, cx) {
        const st = cx.state(p), v = cx.node(p, 'VCC'), g = cx.node(p, 'GND'), on = st.on || [];
        cx.add({ kind: 'R', a: v, b: g, r: 5 / 0.004, main: true }, p);   // power LED
        st.ce = [];
        ins.forEach((nm, k) => {
          const i = cx.node(p, nm);
          if (p.props.trig === 'high') cx.add({ kind: 'R', a: i, b: g, r: 4.7e3 }, p); else cx.add({ kind: 'R', a: i, b: v, r: 2.2e3 }, p);   // opto LED + 1k
          if (on[k]) cx.add({ kind: 'R', a: v, b: g, r: 5 / 0.072 }, p);   // 70 Ω coil
          const s = n === 1 ? '' : String(k + 1);
          if (!(st.cburn && st.cburn[k])) st.ce[k] = cx.add({ kind: 'R', a: cx.node(p, 'COM' + s), b: cx.node(p, (on[k] ? 'NO' : 'NC') + s), r: 0.03 }, p);
        });
      },
      measure(p, cx, dt) {
        const st = cx.state(p); st.ic = (st.ce || []).map((e) => (e ? Math.abs(cx.I(e)) : 0)); st.cburn = st.cburn || [];
        st.ic.forEach((i, k) => { st.ct = st.ct || []; st.ct[k] = i > 1.5 * (+p.props.imax || 10) ? (st.ct[k] || 0) + dt : 0; if (st.ct[k] > 0.2 && !st.cburn[k]) { st.cburn[k] = true; st.burned = true; cx.log(`💥 ${p.id} relay contact ${k + 1} burned open (${fmt(i, 'A')})`); } });
      },
      readout(p, cx) { const st = cx.state(p); return ins.map((_, k) => `K${k + 1} ${st.on && st.on[k] ? 'ON (COM→NO)' : 'off (COM→NC)'}${st.ic && st.ic[k] > 1e-3 ? ' ' + fmt(st.ic[k], 'A') : ''}`).join(' · ') + ` · VCC ${fmt(st.vcc || 0, 'V')}`; },
      warn(p, cx) {
        const st = cx.state(p);
        if (st.cburn && st.cburn.some(Boolean)) return 'relay contact burned (over rated current)';
        if (st.vcc > 0.5 && st.vcc < 3.6) return `relay VCC ${fmt(st.vcc, 'V')} — the 5 V coil will not pull in (use VIN / 5 V)`;
      },
    }, { bom: () => ({ key: type, name: (n === 1 ? '1' : '2') + '-channel 5 V relay module (optocoupled, SRD-05VDC)', q: (n === 1 ? '1' : '2') + ' channel 5V relay module optocoupler' }) });
  }
  relayMod('relay1', 1); relayMod('relay2', 2);

  // =============== passive buzzer (magnetic transducer, needs a tone/PWM) ===============
  R.register('buzzerp', {
    label: 'Buzzer (passive) 12085', cat: 'Motors / Actuators', props: { r: 16 }, prefix: 'BZ',
    edit: [{ k: 'r', label: 'Coil resistance (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p, st) {
      st = st || {}; const hz = st.hz || 0;
      let s = K.lead(0, 0, -8) + K.lead(20, 0, -8) + `<circle cx="10" cy="-22" r="15" fill="url(#hkBlk)" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/><circle cx="10" cy="-22" r="11" fill="none" stroke="#ffffff14"/><circle cx="10" cy="-22" r="3.2" fill="#050505"/>`;
      s += `<rect x="-2" y="-12" width="24" height="5" rx="1" fill="#2a8b3e"/>` + silk(10, -8.6, 'PASSIVE', 2.6);
      if (hz) s += `<g class="buz-wave">${[0, 1, 2].map((k) => `<path d="M${29 + k * 5} ${-32 - k * 3} q${5 + k * 2} ${10 + k * 3} 0 ${20 + k * 6}" stroke="#4ae0ff" stroke-width="1.1" fill="none" opacity="${0.9 - k * 0.25}"/>`).join('')}</g>`;
      return s + dots(this.pins(p)) + plbl(10, -41, hz ? Math.round(hz) + ' Hz' : (st.dc ? 'DC: click only' : 'passive buzzer')) + lbls(['+', '−'], [-5, 25], 9);
    },
    _upd(p, c) { const st = c.state(p); const f = pwmFreq(c, p, '+') || pwmFreq(c, p, '-'); const ch = f !== (st.hz || 0); st.hz = f; return ch; },
    espStep(p, c) { this._upd(p, c); }, tick(p, c) { this._upd(p, c); return false; },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '+'), b: cx.node(p, '-'), r: Math.max(1, +p.props.r || 16), main: true }, p); },
    measure(p, cx) { const e = cx.main(p), st = cx.state(p); st.i = e ? cx.I(e) : 0; st.dc = !st.hz && Math.abs(st.i) > 0.005; },
    readout(p, cx) { const st = cx.state(p); return st.hz ? `tone ${Math.round(st.hz)} Hz · ${fmt(Math.abs(st.i || 0), 'A')} avg` : st.dc ? 'DC only — a passive buzzer needs tone()/PWM' : 'silent'; },
  }, { bom: () => ({ key: 'buzzp', name: 'Passive buzzer (magnetic, 12085)', q: 'passive buzzer 5V 12085' }) });

  // =============== coin vibration motor (10 mm ERM) ===============
  R.register('vibmotor', {
    label: 'Vibration motor (coin 1027, 3 V)', cat: 'Motors / Actuators', props: { r: 35 }, prefix: 'M', dynamic: false,
    edit: [{ k: 'r', label: 'Winding R (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p, st) {
      st = st || {}; const on = st.on, j = on ? ((st.ph || 0) % 2 ? 1.2 : -1.2) : 0;
      let s = wireLead(0, 0, -12, '#d32f2f') + wireLead(20, 0, -12, '#1e5bd8');
      s += `<g transform="translate(${j} ${-j * 0.6})"><circle cx="10" cy="-26" r="14" fill="url(#hkMetal)" stroke="#6f767e" stroke-width=".7" filter="url(#fShadow)"/><circle cx="10" cy="-26" r="10" fill="none" stroke="#0002"/><circle cx="10" cy="-26" r="2" fill="#0003"/>` + silk(10, -24, '1027', 3.6, 'middle', undefined, '#444') + `</g>`;
      if (on) s += `<path d="M-8 -34 q-4 8 0 16 M28 -34 q4 8 0 16" stroke="#4ae0ff" stroke-width="1.1" fill="none"/>`;
      return s + dots(this.pins(p)) + plbl(10, -44, on ? `buzzing ${Math.round(st.rpm || 0)} rpm` : 'vib motor');
    },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '+'), b: cx.node(p, '-'), r: Math.max(1, +p.props.r || 35), main: true }, p); },
    measure(p, cx) { const e = cx.main(p), st = cx.state(p); const v = e ? Math.abs(cx.V(e.a) - cx.V(e.b)) : 0; st.i = e ? cx.I(e) : 0; st.on = v > 0.9; st.rpm = st.on ? Math.min(14000, 12000 * v / 3) : 0; st.ph = (st.ph || 0) + 1; },
    readout(p, cx) { const st = cx.state(p); return st.on ? `${fmt(Math.abs(st.i), 'A')} · ~${Math.round(st.rpm)} rpm` : 'stopped'; },
    warn(p, cx) { const st = cx.state(p); if (Math.abs(st.i || 0) > 0.15) return 'vibration motor over-current (rated 3 V / ~80 mA)'; },
  }, { bom: () => ({ key: 'vib', name: 'Coin vibration motor 10 mm 3 V (1027)', q: '1027 coin vibration motor 3V' }) });

  // =============== push-pull solenoid (JF-0530B) ===============
  R.register('solenoid', {
    label: 'Solenoid push-pull (JF-0530B)', cat: 'Motors / Actuators', props: { v: 12, r: 24 }, prefix: 'SOL', dynamic: false,
    edit: [{ k: 'v', label: 'Rated voltage (V)', t: 'num' }, { k: 'r', label: 'Coil R (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 40, y: 0 }], size: () => ({ w: 40, h: 10 }),
    svg(p, st) {
      st = st || {}; const on = st.on, dx = on ? -10 : 0;
      let s = wireLead(0, 0, -12, '#d32f2f') + wireLead(40, 0, -12, '#222');
      s += `<rect x="${-16 + dx}" y="-34" width="${22 - dx}" height="8" rx="1.5" fill="url(#hkMetal)" stroke="#666" stroke-width=".5"/><circle cx="${-16 + dx}" cy="-30" r="5" fill="url(#hkMetal)" stroke="#666" stroke-width=".5"/>`;
      s += `<rect x="2" y="-46" width="42" height="32" rx="1.5" fill="url(#hkAlu)" stroke="#555" stroke-width=".6" filter="url(#fShadow)"/><rect x="6" y="-43" width="34" height="26" fill="url(#hkCopper)" stroke="#5a2c0a" stroke-width=".4"/>`;
      for (let k = 0; k < 9; k++) s += `<line x1="${8 + k * 3.7}" y1="-43" x2="${8 + k * 3.7}" y2="-17" stroke="#0003" stroke-width=".6"/>`;
      s += `<rect x="10" y="-35" width="26" height="10" rx="1" fill="#1b1d21" opacity=".85"/>` + silk(23, -28, 'JF-0530B', 3.2);
      if (on) s += `<path d="M-26 -38 l-6 8 l6 8" stroke="#4ae0ff" stroke-width="1.2" fill="none"/>`;
      return s + dots(this.pins(p)) + plbl(20, -50, `${esc(p.props.v)} V solenoid · ${on ? 'PULLED' : 'released'}`);
    },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '+'), b: cx.node(p, '-'), r: Math.max(0.5, +p.props.r || 24), main: true }, p); },
    measure(p, cx) { const e = cx.main(p), st = cx.state(p); st.i = e ? cx.I(e) : 0; const rated = (+p.props.v || 12) / (+p.props.r || 24), was = st.on; st.on = st.i > 0.6 * rated || (was && st.i > 0.35 * rated);
      if (was && !st.on && !st.fly) cx.log(`⚡ ${p.id} released with no flyback diode — the coil's inductive kick (~-${Math.round(10 * (+p.props.v || 12))} V) would hit the driver transistor`); },
    tick(p, c) { c.state(p).fly = hasFlyback(c.sim, p, '+', '-'); return false; },
    readout(p, cx) { const st = cx.state(p); return `${fmt(Math.abs(st.i || 0), 'A')} · ${st.on ? 'plunger pulled' : 'released'} · flyback diode ${st.fly ? '✓' : 'missing'}`; },
    warn(p, cx) { const st = cx.state(p); if (!st.fly && Math.abs(st.i || 0) > 0.02) return 'no flyback diode across the solenoid (cathode to +)'; if ((st.i || 0) > 1.6 * (+p.props.v || 12) / (+p.props.r || 24)) return 'solenoid over-voltage — coil overheating'; },
  }, { bom: () => ({ key: 'sol', name: 'Push-pull solenoid 12 V (JF-0530B)', q: 'JF-0530B 12V push pull solenoid' }) });

  // =============== H-bridge drivers ===============
  // one half-bridge output: IN high -> high side to VS, low -> low side to GND; EN duty scales the conduction (PWM average)
  function half(cx, p, st, out, inHi, en, vs, gnd, ron) {
    const o = cx.node(p, out); if (st.burned || !st.pw || en <= 0) { cx.add({ kind: 'G', a: o, b: gnd, g: 1e-9 }, p); st.oe[out] = null; return; }
    st.oe[out] = cx.add({ kind: 'R', a: o, b: inHi ? vs : gnd, r: ron / Math.max(en, 1e-3) }, p);
  }
  function hbMeasure(p, cx, dt, outs, imax, name) {
    const st = cx.state(p); st.io = {}; let worst = 0;
    for (const o of outs) { const e = st.oe && st.oe[o]; const i = e ? Math.abs(cx.I(e)) : 0; st.io[o] = i; worst = Math.max(worst, i); }
    if (burnCheck(st, worst > imax, dt, 0.3)) cx.log(`💥 ${p.id} ${name} burned out (${fmt(worst, 'A')} > ${fmt(imax, 'A')})`);
  }
  R.register('l298n', {
    label: 'L298N dual H-bridge motor driver', cat: 'Motors / Actuators', prefix: 'U', props: { j5: true, jena: false, jenb: false },
    edit: [{ k: 'j5', label: '5 V regulator jumper (VS ≤ 12 V)', t: 'bool' }, { k: 'jena', label: 'ENA jumper (always on)', t: 'bool' }, { k: 'jenb', label: 'ENB jumper (always on)', t: 'bool' }],
    pins: () => [...['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'].map((n, i) => ({ name: n, x: i * 10, y: 0 })), { name: 'VS', x: 70, y: 0 }, { name: 'GND', x: 80, y: 0 }, { name: '5V', x: 90, y: 0 },
      { name: 'OUT1', x: 0, y: -130 }, { name: 'OUT2', x: 10, y: -130 }, { name: 'OUT3', x: 80, y: -130 }, { name: 'OUT4', x: 90, y: -130 }],
    size: () => ({ w: 90, h: 10 }),
    svg(p, st) {
      st = st || {}; const io = st.io || {};
      let s = `<rect x="-14" y="-142" width="118" height="152" rx="3" fill="url(#hkRed)" stroke="#4d0a0d" stroke-width=".7" filter="url(#fShadow)"/>` + mhole(-8, -136) + mhole(98, -136) + mhole(-8, 4) + mhole(98, 4);
      s += screws([0, 10], -126) + screws([80, 90], -126) + screws([70, 80, 90], 4).replace(/y="-14"/, 'y="-14"');
      // heatsink + L298 multiwatt
      s += `<rect x="22" y="-128" width="46" height="50" rx="1" fill="#16181b" stroke="#000" stroke-width=".5"/>`; for (let k = 0; k < 9; k++) s += `<rect x="${24 + k * 5}" y="-126" width="3" height="46" fill="#2c3036"/>`;
      s += `<rect x="28" y="-78" width="34" height="16" rx="1" fill="url(#hkBlk)"/>` + silk(45, -68, 'L298N', 4.4) + Array.from({ length: 15 }, (_, k) => `<rect x="${29 + k * 2.2}" y="-62" width="1" height="5" fill="#c3c8ce"/>`).join('');
      s += `<rect x="4" y="-54" width="18" height="10" rx="1" fill="url(#hkBlk)"/>` + silk(13, -47.5, '78M05', 3) + `<circle cx="76" cy="-60" r="7" fill="#1a1a1e" stroke="#333"/><circle cx="76" cy="-60" r="5" fill="#2b2f36"/>` + silk(76, -49, '220µF', 2.6);
      s += led(84, -36, st.pw, '#ff3b30', 1.8) + silk(84, -30, 'PWR', 2.4);
      // jumpers
      for (const [x, on] of [[0, p.props.jena], [50, p.props.jenb]]) s += `<rect x="${x - 3}" y="-24" width="6" height="12" rx=".8" fill="${on ? '#111' : 'none'}" stroke="#ffd84a55" stroke-width=".5"/>`;
      s += `<rect x="86" y="-24" width="8" height="10" rx=".8" fill="${p.props.j5 ? '#111' : 'none'}" stroke="#ffd84a55" stroke-width=".5"/>`;
      s += header([0, 10, 20, 30, 40, 50], 0) + ['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'].map((n, i) => silk(i * 10, -7, n, 2.8)).join('');
      s += silk(70, 15, '+12V', 2.8) + silk(80, 15, 'GND', 2.8) + silk(90, 15, '+5V', 2.8) + silk(5, -137, 'OUT1  OUT2', 2.8) + silk(85, -137, 'OUT3  OUT4', 2.8);
      s += `<text x="5" y="-108" class="plbl small" style="fill:#ffd">${io.OUT1 ? fmt(io.OUT1, 'A') : ''}</text><text x="85" y="-108" class="plbl small" style="fill:#ffd">${io.OUT3 ? fmt(io.OUT3, 'A') : ''}</text>`;
      if (st.burned) s += smoke(45, -90);
      return s + dots(this.pins(p));
    },
    _upd(p, c) {
      const st = c.state(p), vs = vdiff(c, p, 'VS', 'GND'), v5 = vdiff(c, p, '5V', 'GND');
      const pw = !c.sim.circuit || (p.props.j5 && vs > 6.5) || v5 > 4.2;
      const en = [p.props.jena ? 1 : duty(c, p, 'ENA', 'GND', 2.3), p.props.jenb ? 1 : duty(c, p, 'ENB', 'GND', 2.3)];
      const inp = ['IN1', 'IN2', 'IN3', 'IN4'].map((n) => level(c, p, n, 'GND', 2.3));
      const ch = pw !== st.pw || !same(en, st.en) || !same(inp, st.inp); st.pw = pw; st.en = en; st.inp = inp; st.vs = vs; return ch;
    },
    espStep(p, c) { this._upd(p, c); }, tick(p, c) { return this._upd(p, c); },
    stamp(p, cx) {
      const st = cx.state(p), vs = cx.node(p, 'VS'), g = cx.node(p, 'GND'), v5 = cx.node(p, '5V'), en = st.en || [0, 0], inp = st.inp || [0, 0, 0, 0]; st.oe = {};
      cx.add({ kind: 'R', a: vs, b: g, r: 12 / 0.013, main: true }, p);
      if (p.props.j5) cx.add({ kind: 'LDO', in: vs, out: v5, gnd: g, vreg: 5, drop: 1.6 }, p);
      cx.add({ kind: 'R', a: v5, b: g, r: 5 / 0.036 }, p);
      for (const n of ['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB']) cx.add({ kind: 'R', a: cx.node(p, n), b: g, r: 100e3 }, p);
      ['OUT1', 'OUT2', 'OUT3', 'OUT4'].forEach((o, k) => half(cx, p, st, o, inp[k], en[k >> 1], vs, g, 1.8));
    },
    measure(p, cx, dt) { hbMeasure(p, cx, dt, ['OUT1', 'OUT2', 'OUT3', 'OUT4'], 3, 'L298N'); },
    readout(p, cx) { const st = cx.state(p), io = st.io || {}, en = st.en || [0, 0], inp = st.inp || []; const d = (a, b, e) => (e <= 0 ? 'coast' : a === b ? 'brake' : a ? 'fwd' : 'rev') + (e > 0 && e < 1 ? ` ${Math.round(e * 100)}%` : ''); return `A: ${d(inp[0], inp[1], en[0])} ${fmt(io.OUT1 || 0, 'A')} · B: ${d(inp[2], inp[3], en[1])} ${fmt(io.OUT3 || 0, 'A')} · VS ${fmt(st.vs || 0, 'V')}`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'L298N burned out (> 3 A)'; if (st.vs > 0.5 && !st.pw) return 'L298N logic unpowered: VS < 7 V with the 5 V jumper, or no 5 V on +5V'; if (st.vs > 12.5 && p.props.j5) return 'remove the 5 V jumper above 12 V VS'; },
  }, { bom: () => ({ key: 'l298n', name: 'L298N dual H-bridge motor driver module', q: 'L298N motor driver module' }) });

  const L293 = ['EN1', 'IN1', 'OUT1', 'GND1', 'GND2', 'OUT2', 'IN2', 'VS', 'EN2', 'IN3', 'OUT3', 'GND3', 'GND4', 'OUT4', 'IN4', 'VSS'];
  R.register('l293d', {
    label: 'L293D quad half-H driver (DIP-16)', cat: 'Motors / Actuators', prefix: 'U', props: {},
    pins: () => L293.map((n, i) => (i < 8 ? { name: n, x: i * 10, y: 0 } : { name: n, x: (15 - i) * 10, y: -30 })),
    size: () => ({ w: 70, h: 10 }), groups: () => [['GND1', 'GND2', 'GND3', 'GND4']],
    svg(p, st) {
      st = st || {}; let s = '';
      for (let i = 0; i < 8; i++) s += `<rect x="${i * 10 - 1.6}" y="-5" width="3.2" height="5" fill="url(#hkMetal)"/><rect x="${i * 10 - 1.6}" y="-30" width="3.2" height="5" fill="url(#hkMetal)"/>`;
      s += `<rect x="-6" y="-26" width="82" height="22" rx="1.5" fill="url(#hkBlk)" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><path d="M-6 -18 a3 3 0 0 1 0 6" fill="#0d0e10"/><circle cx="-1" cy="-8" r="1.2" fill="#444"/>`;
      s += silk(35, -16, 'L293D', 5) + silk(35, -9.5, 'ST · 0.6A ×4', 3, 'middle', undefined, '#9aa0a8');
      if (st.burned) s += smoke(35, -36);
      return s + dots(this.pins(p)) + L293.map((n, i) => (i < 8 ? silk(i * 10, 8, n, 2.4) : silk((15 - i) * 10, -35, n, 2.4))).join('');
    },
    _upd(p, c) {
      const st = c.state(p), pw = !c.sim.circuit || vdiff(c, p, 'VSS', 'GND1') > 4.0;
      const en = [duty(c, p, 'EN1', 'GND1', 2.3), duty(c, p, 'EN2', 'GND1', 2.3)], inp = ['IN1', 'IN2', 'IN3', 'IN4'].map((n) => level(c, p, n, 'GND1', 2.3));
      const ch = pw !== st.pw || !same(en, st.en) || !same(inp, st.inp); st.pw = pw; st.en = en; st.inp = inp; st.vs = vdiff(c, p, 'VS', 'GND1'); return ch;
    },
    espStep(p, c) { this._upd(p, c); }, tick(p, c) { return this._upd(p, c); },
    stamp(p, cx) {
      const st = cx.state(p), g = cx.node(p, 'GND1'), vs = cx.node(p, 'VS'), en = st.en || [0, 0], inp = st.inp || [0, 0, 0, 0]; st.oe = {};
      cx.add({ kind: 'R', a: cx.node(p, 'VSS'), b: g, r: 5 / 0.024, main: true }, p); cx.add({ kind: 'R', a: vs, b: g, r: 12 / 0.008 }, p);
      ['OUT1', 'OUT2', 'OUT3', 'OUT4'].forEach((o, k) => half(cx, p, st, o, inp[k], en[k >> 1], vs, g, 2.6));
    },
    measure(p, cx, dt) { hbMeasure(p, cx, dt, ['OUT1', 'OUT2', 'OUT3', 'OUT4'], 1.2, 'L293D'); },
    readout(p, cx) { const st = cx.state(p), io = st.io || {}; return `OUT1 ${fmt(io.OUT1 || 0, 'A')} OUT3 ${fmt(io.OUT3 || 0, 'A')} · EN ${(st.en || []).map((e) => Math.round(e * 100) + '%').join('/')} · VS ${fmt(st.vs || 0, 'V')}`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'L293D burned out (> 1.2 A per channel)'; if (!st.pw) return 'L293D VSS (pin 16) needs 4.5–7 V logic supply'; const io = st.io || {}; if (Object.values(io).some((i) => i > 0.6)) return 'L293D above 600 mA continuous — gets hot'; },
  }, { bom: () => ({ key: 'l293d', name: 'L293D motor driver IC (DIP-16)', q: 'L293D motor driver IC DIP16' }) });

  // =============== ULN2003 driver board + 28BYJ-48 stepper ===============
  const HS = { '1000': 0, '1100': 1, '0100': 2, '0110': 3, '0010': 4, '0011': 5, '0001': 6, '1001': 7 };
  function stepTrack(st, bits, perRev) {   // bits '1100' -> half-step position
    const idx = HS[bits]; if (idx === undefined) return; if (st.hsi === undefined) { st.hsi = idx; return; }
    let d = (idx - st.hsi + 8) % 8; if (d > 4) d -= 8; if (d === 4 || d === -4) d = 0; st.hsi = idx; st.pos = (st.pos || 0) + d; st.steps = (st.steps || 0) + Math.abs(d); st.ang = (st.pos * 360 / perRev);
  }
  R.register('uln2003', {
    label: 'ULN2003 stepper driver board', cat: 'Motors / Actuators', prefix: 'U', props: {},
    pins: () => [...['IN1', 'IN2', 'IN3', 'IN4'].map((n, i) => ({ name: n, x: i * 10, y: 0 })), { name: '-', x: 50, y: 0 }, { name: '+', x: 60, y: 0 },
      ...['A', 'B', 'C', 'D', 'COM'].map((n, i) => ({ name: n, x: 10 + i * 10, y: -80 }))],
    size: () => ({ w: 60, h: 10 }), groups: () => [['+', 'COM']],
    svg(p, st) {
      st = st || {}; const on = st.on || [];
      let s = `<rect x="-10" y="-92" width="80" height="102" rx="3" fill="url(#hkGreen)" stroke="#083a20" stroke-width=".7" filter="url(#fShadow)"/>` + mhole(-4, -86) + mhole(64, -86) + mhole(-4, 4) + mhole(64, 4);
      s += `<rect x="4" y="-86" width="52" height="12" rx="1" fill="#f4f4f0" stroke="#bbb" stroke-width=".5"/>` + ['A', 'B', 'C', 'D', 'COM'].map((n, i) => `<rect x="${10 + i * 10 - 3}" y="-83" width="6" height="6" fill="#c9c9c4"/>`).join('');
      s += `<rect x="4" y="-62" width="34" height="14" rx="1" fill="url(#hkBlk)"/>` + silk(21, -53, 'ULN2003A', 3.6) + Array.from({ length: 8 }, (_, k) => `<rect x="${6 + k * 4}" y="-64" width="1.6" height="2" fill="#c3c8ce"/><rect x="${6 + k * 4}" y="-48" width="1.6" height="2" fill="#c3c8ce"/>`).join('');
      ['A', 'B', 'C', 'D'].forEach((n, i) => { s += led(46 + (i % 2) * 8, -60 + (i >> 1) * 10, on[i], '#ff3b30', 1.8) + silk(46 + (i % 2) * 8, -53.5 + (i >> 1) * 10, n, 2.4); });
      s += header([0, 10, 20, 30], 0) + header([50, 60], 0) + ['IN1', 'IN2', 'IN3', 'IN4'].map((n, i) => silk(i * 10, -7, n, 2.8)).join('') + silk(50, -7, '−', 4) + silk(60, -7, '+', 4) + silk(30, -24, '5-12V', 3);
      return s + dots(this.pins(p)) + ['A', 'B', 'C', 'D', 'COM'].map((n, i) => silk(10 + i * 10, -95, n === 'COM' ? '+' : n, 2.8)).join('');
    },
    outOn(p, c, out) { const k = 'ABCD'.indexOf(out); return k >= 0 && level(c, p, 'IN' + (k + 1), '-', 1.4) === 1; },
    _upd(p, c) { const st = c.state(p), on = ['A', 'B', 'C', 'D'].map((o) => this.outOn(p, c, o)); const ch = !same(on, st.on); st.on = on; return ch; },
    espStep(p, c) { this._upd(p, c); }, tick(p, c) { return this._upd(p, c); },
    stamp(p, cx) {
      const st = cx.state(p), g = cx.node(p, '-'), on = st.on || [];
      cx.add({ kind: 'R', a: cx.node(p, '+'), b: g, r: 5 / 0.002, main: true }, p);
      ['IN1', 'IN2', 'IN3', 'IN4'].forEach((n) => cx.add({ kind: 'R', a: cx.node(p, n), b: g, r: 3.3e3 }, p));   // 2.7k base resistor + LED
      st.oe = ['A', 'B', 'C', 'D'].map((o, k) => (on[k] ? cx.add({ kind: 'R', a: cx.node(p, o), b: g, r: 1.0 }, p) : null));
    },
    measure(p, cx, dt) { const st = cx.state(p); st.io = (st.oe || []).map((e) => (e ? Math.abs(cx.I(e)) : 0)); if (burnCheck(st, st.io.some((i) => i > 0.7), dt, 0.3)) cx.log(`💥 ${p.id} ULN2003 channel burned (> 500 mA)`); },
    readout(p, cx) { const st = cx.state(p); return 'outputs ' + (st.on || []).map((o, i) => 'ABCD'[i] + (o ? '●' : '○')).join(' ') + ' · ' + (st.io || []).map((i) => fmt(i, 'A')).join(' '); },
  }, { bom: () => ({ key: 'uln', name: '28BYJ-48 5 V stepper + ULN2003 driver board', q: '28BYJ-48 stepper motor ULN2003 driver', note: 'usually sold as a pair' }) });

  const BYJ = ['BLU', 'PNK', 'YEL', 'ORG', 'RED'], BYJC = ['#2f6fff', '#ff7ab8', '#ffd43b', '#ff922b', '#e03131'];
  R.register('stepper28', {
    label: 'Stepper 28BYJ-48 (5 V, 64:1)', cat: 'Motors / Actuators', prefix: 'M', props: {},
    pins: () => BYJ.map((n, i) => ({ name: n, x: i * 10, y: 0 })), size: () => ({ w: 40, h: 10 }),
    svg(p, st) {
      st = st || {}; const a = st.ang || 0;
      let s = BYJ.map((n, i) => wireLead(i * 10, 0, -14, BYJC[i])).join('') + `<rect x="-3" y="-20" width="46" height="7" rx="1.5" fill="#f4f4f0" stroke="#bbb" stroke-width=".4"/>`;
      s += `<path d="M-14 -62 h68 v8 h-68 z" fill="url(#hkMetal)" stroke="#777" stroke-width=".5"/><circle cx="-10" cy="-58" r="2.2" fill="#333"/><circle cx="50" cy="-58" r="2.2" fill="#333"/>`;
      s += `<circle cx="20" cy="-58" r="28" fill="url(#hkMetal)" stroke="#6f767e" stroke-width=".7" filter="url(#fShadow)"/><circle cx="20" cy="-58" r="22" fill="none" stroke="#0002"/><rect x="6" y="-36" width="28" height="14" rx="2" fill="#2f6fd6" stroke="#16408f" stroke-width=".5"/>`;
      s += `<circle cx="20" cy="-70" r="7" fill="#c9ced4" stroke="#777" stroke-width=".5"/><g transform="rotate(${a.toFixed(1)} 20 -70)"><rect x="18.4" y="-80" width="3.2" height="20" rx="1" fill="#e8e8e8" stroke="#555" stroke-width=".4"/><path d="M18.4 -80 h3.2 v4 h-3.2 z" fill="#ffd84a"/></g>`;
      s += silk(20, -46, '28BYJ-48', 3.6, 'middle', undefined, '#333') + silk(20, -41, '5VDC', 3, 'middle', undefined, '#555');
      return s + dots(this.pins(p)) + plbl(20, -92, `${(((a % 360) + 360) % 360).toFixed(1)}° · ${st.steps || 0} steps`);
    },
    _upd(p, c) {
      const st = c.state(p), bits = BYJ.slice(0, 4).map((pin) => { const l = linked(c.sim, p, pin, ['uln2003']); if (l) return P.T.uln2003.outOn(l.part, c, l.pin) ? '1' : '0'; return (st.coilI && st.coilI[BYJ.indexOf(pin)] > 0.02) ? '1' : '0'; }).join('');
      const pw = !c.sim.circuit || volt(c.sim, p, 'RED') > 3.5;
      if (pw) stepTrack(st, bits, 4096); st.bits = bits; return false;
    },
    espStep(p, c) { this._upd(p, c); }, tick(p, c) { this._upd(p, c); return false; },
    stamp(p, cx) { const r = cx.node(p, 'RED'); cx.state(p).ce = BYJ.slice(0, 4).map((n) => cx.add({ kind: 'R', a: r, b: cx.node(p, n), r: 50 }, p)); },
    measure(p, cx) { const st = cx.state(p); st.coilI = (st.ce || []).map((e) => Math.abs(cx.I(e))); },
    readout(p, cx) { const st = cx.state(p); return `${(st.ang || 0).toFixed(1)}° (${st.pos || 0} half-steps) · coils ${st.bits || '0000'} · ${(st.coilI || []).map((i) => fmt(i, 'A')).join(' ')}`; },
  }, { bom: () => ({ key: 'uln', name: '28BYJ-48 5 V stepper + ULN2003 driver board', q: '28BYJ-48 stepper motor ULN2003 driver', note: 'usually sold as a pair' }) });

  // =============== A4988 (Pololu carrier) + NEMA17 ===============
  const A4C = ['EN', 'MS1', 'MS2', 'MS3', 'RST', 'SLP', 'STEP', 'DIR'], A4P = ['VMOT', 'GND', '2B', '2A', '1A', '1B', 'VDD', 'GND2'];
  const MICRO = { '000': 1, '100': 2, '010': 4, '110': 8, '111': 16 };
  R.register('a4988', {
    label: 'A4988 stepper driver (Pololu)', cat: 'Motors / Actuators', prefix: 'U', props: { ilim: 1.0 },
    edit: [{ k: 'ilim', label: 'Current limit (A, Vref pot)', t: 'num' }],
    pins: () => [...A4C.map((n, i) => ({ name: n, x: i * 10, y: 0 })), ...A4P.map((n, i) => ({ name: n, x: (7 - i) * 10, y: -50 }))],
    size: () => ({ w: 70, h: 10 }), groups: () => [['GND', 'GND2']],
    svg(p, st) {
      st = st || {};
      let s = `<rect x="-7" y="-57" width="84" height="64" rx="2" fill="url(#hkGreen)" stroke="#083a20" stroke-width=".7" filter="url(#fShadow)"/>`;
      s += header(A4C.map((_, i) => i * 10), 0) + header(A4P.map((_, i) => i * 10), -50);
      s += `<rect x="18" y="-38" width="22" height="22" rx="1" fill="url(#hkBlk)"/>` + silk(29, -26, 'A4988', 3.6) + `<rect x="22" y="-34" width="14" height="14" fill="none" stroke="#ffffff10"/>`;
      s += `<circle cx="52" cy="-28" r="6" fill="url(#hkMetal)" stroke="#777" stroke-width=".5"/><path d="M48 -28 h8" stroke="#555" stroke-width="1.2" transform="rotate(${(+p.props.ilim || 1) * 90} 52 -28)"/>` + silk(52, -18, 'VREF', 2.4);
      s += led(66, -26, st.en, '#33e07a', 1.6);
      s += A4C.map((n, i) => silk(i * 10, -7, n, 2.4)).join('') + A4P.map((n, i) => silk((7 - i) * 10, -42, n === 'GND2' ? 'GND' : n, 2.4)).join('');
      if (st.burned) s += smoke(29, -40);
      return s + dots(this.pins(p)) + plbl(35, -62, `A4988 · 1/${st.micro || 1} step${st.warnRst ? ' · RST floating!' : ''}`);
    },
    _upd(p, c, fromEsp) {
      const st = c.state(p), vdd = vdiff(c, p, 'VDD', 'GND'), vm = vdiff(c, p, 'VMOT', 'GND');
      const tied = net(c.sim, p, 'RST') === net(c.sim, p, 'SLP'), rstNet = net(c.sim, p, 'RST');
      const rstFloat = !tied && !c.sim.project.parts.some((q) => q !== p && q.type !== 'breadboard' && P.T[q.type].pins(q).some((pn) => net(c.sim, q, pn.name) === rstNet));
      const slp = level(c, p, 'SLP', 'GND', 2.0) || (!c.sim.circuit ? 1 : 0), rst = tied ? slp : rstFloat ? 0 : level(c, p, 'RST', 'GND', 2.0);
      const en = level(c, p, 'EN', 'GND', 2.0) === 0 && rst === 1 && slp === 1 && (!c.sim.circuit || (vdd > 2.9 && vm > 7.5));
      st.micro = MICRO[[level(c, p, 'MS1', 'GND', 2.0), level(c, p, 'MS2', 'GND', 2.0), level(c, p, 'MS3', 'GND', 2.0)].join('')] || 1;
      st.warnRst = rstFloat; st.vm = vm; st.vdd = vdd;
      const step = level(c, p, 'STEP', 'GND', 2.0), dir = level(c, p, 'DIR', 'GND', 2.0);
      if (st.lastStep === 0 && step === 1 && en && !st.burned) { st.ang = (st.ang || 0) + (dir ? 1 : -1) * 1.8 / st.micro; st.steps = (st.steps || 0) + 1; }
      st.lastStep = step; st.dir = dir;
      const ch = en !== st.en; st.en = en; return ch;
    },
    espStep(p, c) { this._upd(p, c, true); },
    tick(p, c, dt) {
      const st = c.state(p), ch = this._upd(p, c), f = pwmFreq(c, p, 'STEP');
      if (f && st.en) { st.ang = (st.ang || 0) + (st.dir ? 1 : -1) * f * dt * 1.8 / st.micro; st.steps = (st.steps || 0) + Math.round(f * dt); }
      return ch;
    },
    stamp(p, cx) {
      const st = cx.state(p), g = cx.node(p, 'GND');
      cx.add({ kind: 'R', a: cx.node(p, 'VDD'), b: g, r: 5 / 0.008 }, p);
      cx.add({ kind: 'R', a: cx.node(p, 'SLP'), b: cx.node(p, 'VDD'), r: 100e3 }, p);
      for (const n of ['EN', 'MS1', 'MS2', 'MS3', 'STEP', 'DIR']) cx.add({ kind: 'R', a: cx.node(p, n), b: g, r: 100e3 }, p);
      const ilim = +p.props.ilim || 1; cx.add({ kind: 'R', a: cx.node(p, 'VMOT'), b: g, r: st.en && !st.burned ? 12 / Math.max(0.02, 0.35 * ilim * ilim + 0.01) : 12 / 0.002, main: true }, p);
    },
    measure(p, cx, dt) { const st = cx.state(p); if (burnCheck(st, (st.vm || 0) > 36, dt, 0.05)) cx.log(`💥 ${p.id} A4988 destroyed: VMOT ${fmt(st.vm, 'V')} > 35 V`); },
    readout(p, cx) { const st = cx.state(p); return `${st.en ? 'enabled' : 'disabled'} · 1/${st.micro || 1} · ${st.steps || 0} steps · DIR ${st.dir ? 'CW' : 'CCW'} · VMOT ${fmt(st.vm || 0, 'V')}`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'A4988 destroyed (VMOT > 35 V)'; if (st.warnRst) return 'RESET is floating — wire RST to SLP (driver stays disabled)'; if ((st.vm || 0) > 0.5 && st.vm < 8) return 'A4988 VMOT needs 8–35 V'; if ((st.vdd || 0) < 2.9) return 'A4988 VDD (logic) needs 3–5.5 V'; },
  }, { bom: () => ({ key: 'a4988', name: 'A4988 stepper driver (Pololu-style, with heatsink)', q: 'A4988 stepper motor driver module heatsink' }) });

  const NEMA = ['A+', 'A-', 'B+', 'B-'], NEMAC = ['#111', '#2f9e44', '#e03131', '#2f6fff'];
  R.register('nema17', {
    label: 'Stepper NEMA17 (1.8°, bipolar)', cat: 'Motors / Actuators', prefix: 'M', props: {},
    pins: () => NEMA.map((n, i) => ({ name: n, x: i * 10, y: 0 })), size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      st = st || {}; const a = st.ang || 0;
      let s = NEMA.map((n, i) => wireLead(i * 10, 0, -14, NEMAC[i])).join('');
      s += `<rect x="-18" y="-84" width="66" height="66" rx="5" fill="url(#hkBlk)" stroke="#000" stroke-width=".7" filter="url(#fShadow)"/><rect x="-14" y="-80" width="58" height="58" rx="4" fill="url(#hkAlu)" stroke="#555" stroke-width=".5"/>`;
      for (const [x, y] of [[-10, -76], [40, -76], [-10, -26], [40, -26]]) s += `<circle cx="${x}" cy="${y}" r="2.4" fill="#1b1d21"/>`;
      s += `<circle cx="15" cy="-51" r="12" fill="#c9ced4" stroke="#777" stroke-width=".6"/><g transform="rotate(${a.toFixed(1)} 15 -51)"><circle cx="15" cy="-51" r="3.2" fill="#e8e8e8" stroke="#555" stroke-width=".4"/><rect x="14" y="-62" width="2" height="9" fill="#ffd84a"/></g>`;
      s += silk(15, -31, 'NEMA17 · 1.8°', 3.4, 'middle', undefined, '#222');
      return s + dots(this.pins(p)) + plbl(15, -90, `${(((a % 360) + 360) % 360).toFixed(1)}°`) + NEMA.map((n, i) => silk(i * 10, 9, n, 2.8)).join('');
    },
    _upd(p, c) { const st = c.state(p), l = linked(c.sim, p, 'A+', ['a4988']) || linked(c.sim, p, 'B+', ['a4988']); if (l) { const ds = c.state(l.part); st.ang = ds.ang || 0; st.drv = l.part.id; st.en = ds.en; } else st.drv = null; },
    espStep(p, c) { this._upd(p, c); }, tick(p, c) { this._upd(p, c); return false; },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, 'A+'), b: cx.node(p, 'A-'), r: 1.7, main: true }, p); cx.add({ kind: 'R', a: cx.node(p, 'B+'), b: cx.node(p, 'B-'), r: 1.7 }, p); },
    readout(p, cx) { const st = cx.state(p); return st.drv ? `${(st.ang || 0).toFixed(1)}° · driven by ${st.drv}${st.en ? '' : ' (disabled)'}` : 'not connected to an A4988 (coils 1.7 Ω)'; },
  }, { bom: () => ({ key: 'nema17', name: 'NEMA17 stepper motor 1.8° (42 mm, ~1.5 A)', q: 'NEMA 17 stepper motor 42mm' }) });
})(typeof window !== 'undefined' ? window : globalThis);
