/* Power parts: LM7805 (TO-220), AMS1117-3.3 (SOT-223), LM2596 buck module, glass fuse, 18650 Li-ion cell + holder.
 * Linear regulators use the solver's behavioural LDO element plus a junction-temperature model (thermal shutdown). */
(function (root) {
  const P = root.Parts, R = root.PartsReg, K = root.HwKit;
  if (!P || !R || !K) return;
  const { dots, silk, mhole, plbl, screws, to220, lead, wireLead, smoke, led, burnCheck, esc, fmt } = K;

  // ---------- linear regulators with thermal model ----------
  function linReg(type, o) {
    R.register(type, {
      label: o.label, cat: 'Power', prefix: 'U', props: Object.assign({ heatsink: false }, o.props || {}),
      edit: [{ k: 'heatsink', label: 'Heatsink fitted', t: 'bool' }],
      pins: () => o.pins.map((n, i) => ({ name: n, x: i * 10, y: 0 })), size: () => ({ w: 20, h: 10 }),
      svg(p, st) { st = st || {}; const hot = Math.max(0, ((st.tj || 25) - 70) / 120); return o.art(p, st, hot) + dots(this.pins(p)) + o.pins.map((n, i) => `<text x="${i * 10}" y="10" class="plbl small">${n}</text>`).join('') + (st.burned ? smoke(10, -60) : '') + plbl(10, o.lblY, (st.shut ? 'THERMAL SHUTDOWN' : `${o.vout} V · ${Math.round(st.tj || 25)}°C`)); },
      stamp(p, cx) {
        const st = cx.state(p), g = cx.node(p, 'GND'), vi = cx.node(p, 'IN');
        cx.add({ kind: 'R', a: vi, b: g, r: o.vq }, p);   // quiescent current
        if (st.burned || st.shut) { cx.add({ kind: 'G', a: cx.node(p, 'OUT'), b: g, g: 1e-9 }, p); return; }
        cx.add({ kind: 'LDO', in: vi, out: cx.node(p, 'OUT'), gnd: g, vreg: o.vout, drop: o.drop, main: true }, p);
      },
      measure(p, cx, dt) {
        const st = cx.state(p), e = cx.main(p), vin = cx.pinV(p, 'IN') - cx.pinV(p, 'GND');
        const i = e ? Math.max(0, cx.I(e)) : 0, vo = e ? cx.V(e.out) - cx.V(e.gnd) : 0; st.i = i; st.vin = vin; st.vout = vo; st.pd = Math.max(0, (vin - vo) * i);
        const rth = p.props.heatsink ? o.rthHs : o.rth, tgt = 25 + st.pd * rth; st.tj = (st.tj || 25) + (tgt - (st.tj || 25)) * (1 - Math.exp(-dt / o.tau));
        const was = !!st.shut; if (st.tj > 150) st.shut = true; else if (st.tj < 125) st.shut = false; st.shut = !!st.shut;
        if (st.shut !== was) { cx.log(st.shut ? `🔥 ${p.id} thermal shutdown (Tj ${Math.round(st.tj)}°C, ${fmt(st.pd, 'W')})` : `${p.id} cooled down, output back on`); st.__dirty = true; }
        if (burnCheck(st, vin > o.vmax, dt, 0.05)) cx.log(`💥 ${p.id} destroyed: VIN ${fmt(vin, 'V')} > ${o.vmax} V`);
        if (i > o.ilim) st.i = o.ilim;   // current-limit (approximate)
      },
      tick(p, c) { const st = c.state(p); if (st.__dirty) { st.__dirty = false; return true; } return false; },
      readout(p, cx) { const st = cx.state(p); return `Vout ${fmt(st.vout || 0, 'V')} · Iout ${fmt(st.i || 0, 'A')} · Pd ${fmt(st.pd || 0, 'W')} · Tj ${Math.round(st.tj || 25)}°C`; },
      warn(p, cx) {
        const st = cx.state(p); if (st.burned) return `${o.short} destroyed (VIN > ${o.vmax} V)`; if (st.shut) return `${o.short} in thermal shutdown — ${p.props.heatsink ? 'reduce load / input voltage' : 'add a heatsink'}`;
        if ((st.i || 0) > o.ilim) return `${o.short} over current (${fmt(st.i, 'A')} > ${o.ilim} A)`;
        if (st.vin > 0.5 && st.vin < o.vout + o.drop - 0.05 && (st.i || 0) > 1e-4) return `${o.short} in dropout: needs ≥ ${(o.vout + o.drop).toFixed(1)} V in`;
        if ((st.tj || 25) > 110) return `${o.short} running hot (${Math.round(st.tj)}°C)`;
      },
    }, { bom: o.bom });
  }
  linReg('lm7805', {
    label: 'Regulator LM7805 5 V 1.5 A (TO-220)', short: 'LM7805', vout: 5, drop: 2.0, ilim: 1.5, vmax: 35, vq: 1.5e3, rth: 65, rthHs: 12, tau: 6, lblY: -64,
    pins: ['IN', 'GND', 'OUT'], art: (p, st, hot) => to220([0, 10, 20], 'L7805CV', '5V 1.5A', hot) + (p.props.heatsink ? `<rect x="-12" y="-74" width="44" height="18" fill="#1a1c20" stroke="#000" stroke-width=".4"/>${Array.from({ length: 7 }, (_, k) => `<rect x="${-10 + k * 6}" y="-74" width="3" height="16" fill="#30343a"/>`).join('')}` : ''),
    bom: () => ({ key: 'lm7805', name: 'LM7805 5 V regulator (TO-220)', q: 'LM7805 voltage regulator TO-220' }),
  });
  linReg('ams1117', {
    label: 'Regulator AMS1117-3.3 (SOT-223)', short: 'AMS1117', vout: 3.3, drop: 1.1, ilim: 1.0, vmax: 15, vq: 1e3, rth: 90, rthHs: 45, tau: 3, lblY: -36,
    pins: ['GND', 'OUT', 'IN'], art: (p, st, hot) => [0, 10, 20].map((x) => lead(x, 0, -6)).join('') + `<rect x="-6" y="-30" width="32" height="24" rx="1.5" fill="#1d5fd0" stroke="#0b2a5e" stroke-width=".5" filter="url(#fShadow)"/>` +
      `<rect x="2" y="-27" width="16" height="4" fill="url(#hkMetal)"/><rect x="0" y="-23" width="20" height="10" rx=".8" fill="url(#hkBlk)"/>` + silk(10, -16.5, 'AMS1117', 3) + silk(10, -9, '3.3V', 2.6) +
      (hot ? `<rect x="-6" y="-30" width="32" height="24" fill="#ff5a1a" opacity="${Math.min(0.55, hot)}" filter="url(#fGlow)" pointer-events="none"/>` : ''),
    bom: () => ({ key: 'ams1117', name: 'AMS1117-3.3 regulator (SOT-223 breakout)', q: 'AMS1117 3.3V regulator module' }),
  });

  // ---------- LM2596 buck converter module (adjustable) ----------
  R.register('buck', {
    label: 'Buck converter LM2596 (adjustable)', cat: 'Power', prefix: 'PS', props: { vout: 5, eff: 0.88, imax: 3 },
    edit: [{ k: 'vout', label: 'Output voltage (trim pot)', t: 'range', min: 1.25, max: 30, step: 0.05, live: true }, { k: 'eff', label: 'Efficiency', t: 'num' }, { k: 'imax', label: 'Max current (A)', t: 'num' }],
    pins: () => [{ name: 'IN+', x: 0, y: 0 }, { name: 'IN-', x: 0, y: 20 }, { name: 'OUT+', x: 90, y: 0 }, { name: 'OUT-', x: 90, y: 20 }],
    size: () => ({ w: 90, h: 20 }), groups: () => [['IN-', 'OUT-']], groundPins: [['IN-', 1]],
    svg(p, st) {
      st = st || {};
      let s = `<rect x="-8" y="-36" width="106" height="64" rx="3" fill="url(#hkBlue)" stroke="#0b2a5e" stroke-width=".7" filter="url(#fShadow)"/>` + mhole(-2, -30) + mhole(92, 22);
      s += `<circle cx="22" cy="-12" r="11" fill="#1a1a1e" stroke="#333" stroke-width=".6"/><circle cx="22" cy="-12" r="8" fill="#2b2f36"/>` + silk(22, -10, '220µF', 2.6);
      s += `<rect x="38" y="-28" width="24" height="24" rx="3" fill="#2a2d33" stroke="#000" stroke-width=".5"/><circle cx="50" cy="-16" r="8" fill="url(#hkCopper)"/>` + silk(50, -14, '33µH', 2.6, 'middle', undefined, '#222');
      s += `<rect x="40" y="4" width="18" height="14" rx="1" fill="url(#hkBlk)"/>` + silk(49, 13, 'LM2596', 2.8);
      s += `<rect x="68" y="-28" width="12" height="16" rx="1" fill="#2f6fd6" stroke="#16408f" stroke-width=".5"/><circle cx="74" cy="-25" r="2" fill="#ffd84a"/>`;
      s += `<circle cx="74" cy="10" r="7" fill="#1a1a1e" stroke="#333" stroke-width=".6"/>` + led(84, -8, st.on, '#ff3b30', 1.6);
      s += silk(4, 3, 'IN+', 3, 'start') + silk(4, 23, 'IN−', 3, 'start') + silk(86, 3, 'OUT+', 3, 'end') + silk(86, 23, 'OUT−', 3, 'end');
      if (st.burned) s += smoke(49, -30);
      return s + dots(this.pins(p)) + plbl(45, -40, `${(+p.props.vout).toFixed(2)} V out`);
    },
    stamp(p, cx) {
      const st = cx.state(p), vi = cx.node(p, 'IN+'), g = cx.node(p, 'IN-');
      cx.add({ kind: 'R', a: vi, b: g, r: 12 / 0.006 }, p);
      if (st.burned) return;
      cx.add({ kind: 'LDO', in: vi, out: cx.node(p, 'OUT+'), gnd: g, vreg: +p.props.vout || 5, drop: 1.5, main: true }, p);
      // the LDO element draws Iout from IN; a switcher draws only Pout/(Vin·eff) — inject the difference back into IN+
      st._comp = cx.add({ kind: 'I', a: g, b: vi, i: st.comp || 0 }, p);
    },
    measure(p, cx, dt) {
      const st = cx.state(p), e = cx.main(p); if (!e) return;
      const vin = cx.V(e.in) - cx.V(e.gnd), vo = cx.V(e.out) - cx.V(e.gnd), io = Math.max(0, cx.I(e)), eff = Math.min(0.99, Math.max(0.3, +p.props.eff || 0.88));
      const iin = vin > 1 ? vo * io / (vin * eff) : io; const want = Math.max(0, io - iin);
      st.comp = (st.comp || 0) + (want - (st.comp || 0)) * 0.7; if (st._comp) st._comp.i = st.comp;
      st.vin = vin; st.vo = vo; st.io = io; st.iin = io - st.comp; st.on = vo > 1;
      if (burnCheck(st, vin > 40 || io > 1.5 * (+p.props.imax || 3), dt, 0.1)) cx.log(`💥 ${p.id} buck converter destroyed (${vin > 40 ? 'VIN > 40 V' : 'over current'})`);
    },
    readout(p, cx) { const st = cx.state(p); return `IN ${fmt(st.vin || 0, 'V')} ${fmt(st.iin || 0, 'A')} → OUT ${fmt(st.vo || 0, 'V')} ${fmt(st.io || 0, 'A')}`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'buck converter destroyed'; if (st.vin > 0.5 && st.vin < (+p.props.vout || 5) + 1.5) return 'buck needs VIN ≥ VOUT + 1.5 V'; if ((st.io || 0) > (+p.props.imax || 3)) return 'buck over current'; },
  }, { bom: () => ({ key: 'lm2596', name: 'LM2596 adjustable buck converter module', q: 'LM2596 DC-DC buck converter module' }) });

  // ---------- glass fuse (5×20 mm, fast-blow, I²t) ----------
  R.register('fuse', {
    label: 'Fuse (glass 5×20, fast)', cat: 'Power', prefix: 'F', props: { rating: 1 },
    edit: [{ k: 'rating', label: 'Rating (A)', t: 'sel', opts: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10] }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 40, y: 0 }], size: () => ({ w: 40, h: 10 }),
    svg(p, st) {
      st = st || {}; const b = st.burned;
      let s = `<line x1="0" y1="0" x2="40" y2="0" stroke="url(#aLeadV)" stroke-width="1.8"/><rect x="2" y="-6" width="8" height="12" rx="1.5" fill="url(#hkMetal)" stroke="#777" stroke-width=".5"/><rect x="30" y="-6" width="8" height="12" rx="1.5" fill="url(#hkMetal)" stroke="#777" stroke-width=".5"/>`;
      s += `<rect x="10" y="-5" width="20" height="10" fill="#dfe9f2" opacity=".35" stroke="#9fb3c4" stroke-width=".5"/>` + (b ? `<path d="M10 0 h7 M23 0 h7" stroke="#555" stroke-width=".8"/><circle cx="20" cy="0" r="4" fill="#3a3a3a" opacity=".6"/>` : `<path d="M10 0 h20" stroke="#c9ced4" stroke-width=".7"/>`);
      s += `<rect x="10" y="-5" width="20" height="3" fill="#fff" opacity=".35"/>`;
      return s + dots(this.pins(p)) + plbl(20, -10, `${esc(p.props.rating)} A${b ? ' · BLOWN' : ''}`);
    },
    stamp(p, cx) { if (cx.state(p).burned) return; const r = +p.props.rating || 1; cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: Math.min(2, 0.08 / r), main: true }, p); },
    measure(p, cx, dt) {
      const st = cx.state(p), e = cx.main(p); if (!e) return; const i = Math.abs(cx.I(e)), r = +p.props.rating || 1; st.i = i;
      st.h = Math.max(0, (st.h || 0) + (i * i - r * r) * dt);   // I²t accumulates above rating, cools below
      if (i > 10 * r || st.h > 0.05 * r * r) { st.burned = true; cx.log(`💥 ${p.id} fuse blew (${fmt(i, 'A')} through a ${r} A fuse)`); }
    },
    readout(p, cx) { const st = cx.state(p); return st.burned ? 'BLOWN (reset sim to replace)' : `${fmt(st.i || 0, 'A')} of ${p.props.rating} A`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'fuse blown'; },
  }, { bom: (pr) => ({ key: 'fuse' + pr.rating, name: `Glass fuse 5×20 mm ${pr.rating} A + inline holder`, q: `5x20mm ${pr.rating}A fast blow glass fuse holder` }) });

  // ---------- 18650 Li-ion cell in a holder ----------
  const ocv = (soc) => { const s = Math.max(0, Math.min(1, soc)); return 3.0 + 0.55 * Math.pow(s, 0.35) + 0.65 * s * s * s - (s < 0.08 ? (0.08 - s) * 4 : 0); };
  R.register('cell18650', {
    label: 'Li-ion 18650 cell + holder (3.7 V)', cat: 'Power', prefix: 'BAT', props: { soc: 0.8, mah: 2600, rint: 0.06 }, groundPins: [['-', 1]],
    edit: [{ k: 'soc', label: 'State of charge', t: 'range', min: 0, max: 1, step: 0.01, live: true }, { k: 'mah', label: 'Capacity (mAh)', t: 'num' }, { k: 'rint', label: 'Internal R (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 80, y: 0 }], size: () => ({ w: 80, h: 10 }),
    svg(p, st) {
      st = st || {}; const soc = +p.props.soc;
      let s = wireLead(0, 0, -10, '#d32f2f') + wireLead(80, 0, -10, '#222');
      s += `<rect x="-8" y="-40" width="96" height="30" rx="3" fill="#16171a" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/><rect x="-4" y="-36" width="4" height="22" fill="url(#hkMetal)"/><rect x="80" y="-36" width="4" height="22" fill="url(#hkMetal)"/>`;
      s += `<rect x="2" y="-36" width="76" height="22" rx="4" fill="url(#hkCellBlue)"/><rect x="2" y="-36" width="76" height="6" rx="3" fill="#fff" opacity=".18"/><rect x="72" y="-33" width="6" height="16" fill="url(#hkMetal)" opacity=".9"/>`;
      s += silk(36, -23, '18650 3.7V', 4.4) + silk(36, -17, `${p.props.mah} mAh Li-ion`, 2.8);
      s += `<rect x="12" y="-46" width="48" height="4" rx="1" fill="#222"/><rect x="12" y="-46" width="${48 * Math.max(0, Math.min(1, soc))}" height="4" rx="1" fill="${soc > 0.5 ? '#33e07a' : soc > 0.2 ? '#ffd43b' : '#ff4d4f'}"/>`;
      if (st.burned) s += smoke(40, -50);
      return s + dots(this.pins(p)) + plbl(36, -50, `${ocv(soc).toFixed(2)} V · ${Math.round(soc * 100)}%`) + `<text x="-6" y="9" class="plbl small">+</text><text x="86" y="9" class="plbl small">−</text>`;
    },
    stamp(p, cx) { if (cx.state(p).burned) return; cx.add({ kind: 'V', a: cx.node(p, '+'), b: cx.node(p, '-'), v: ocv(+p.props.soc), rs: Math.max(0.005, +p.props.rint || 0.06), main: true }, p); },
    measure(p, cx, dt) {
      const st = cx.state(p), e = cx.main(p); if (!e) return; const i = -cx.I(e); st.i = i;   // discharge current (out of +)
      const cap = (+p.props.mah || 2600) * 3.6; p.props.soc = Math.max(0, Math.min(1, +p.props.soc - i * dt / cap));
      st.tsh = Math.abs(i) > 20 ? (st.tsh || 0) + dt : 0; if (st.tsh > 2 && !st.burned) { st.burned = true; cx.log(`🔥 ${p.id} 18650 vented: ${fmt(Math.abs(i), 'A')} short circuit`); }
    },
    readout(p, cx) { const st = cx.state(p); return `${ocv(+p.props.soc).toFixed(2)} V OCV · ${fmt(st.i || 0, 'A')} · ${Math.round(+p.props.soc * 100)}%`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return '18650 vented (short circuit)'; if (Math.abs(st.i || 0) > 8) return `SHORT CIRCUIT on 18650: ${fmt(Math.abs(st.i), 'A')}!`; if (+p.props.soc < 0.05) return '18650 over-discharged (< 3.0 V)'; },
  }, { bom: () => ({ key: '18650', name: '18650 Li-ion cell (protected) + 1-slot holder', q: '18650 battery holder with leads' }) });
})(typeof window !== 'undefined' ? window : globalThis);
