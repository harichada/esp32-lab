/* Semiconductors: 1N4007 rectifier, 1N5819 Schottky, 2N3904 / 2N3906, TIP120 Darlington, IRLZ44N logic-level MOSFET,
 * PC817 optocoupler. All have a dissipation / current burn-out rule (part goes open, smoke, reset sim to repair). */
(function (root) {
  const P = root.Parts, R = root.PartsReg, K = root.HwKit, S = root.Solver;
  if (!P || !R || !K || !S) return;
  const { dots, silk, to220, to92, lbls, smoke, burnCheck, esc, fmt } = K;

  // ---------- axial diodes ----------
  function axial(type, o) {
    R.register(type, {
      label: o.label, cat: 'Semiconductors', prefix: 'D', props: {},
      pins: () => [{ name: 'A', x: 0, y: 0 }, { name: 'K', x: 40, y: 0 }], size: () => ({ w: 40, h: 10 }),
      svg(p, st) {
        st = st || {};
        return `<line x1="0" y1="0" x2="40" y2="0" stroke="url(#aLeadV)" stroke-width="1.6"/><rect x="10" y="-5" width="20" height="10" rx="2.5" fill="${o.body}" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><rect x="10" y="-5" width="20" height="3" rx="1.5" fill="#fff" opacity=".12"/>` +
          `<rect x="25" y="-5" width="2.6" height="10" fill="${o.band}"/>` + silk(17.5, 1.4, o.print, 2.6, 'middle', undefined, '#cfd3d8') + (st.burned ? smoke(20, -10) : '') + dots(this.pins(p)) + lbls(['A', 'K'], [-2, 42], 10);
      },
      stamp(p, cx) { if (cx.state(p).burned) return; const d = S.diodeFromVf(o.vf, o.ivf, o.n); cx.add({ kind: 'D', a: cx.node(p, 'A'), k: cx.node(p, 'K'), is: d.is, n: d.n, rs: o.rs, bv: o.bv, nbv: 2, main: true }, p); },
      measure(p, cx, dt) { const st = cx.state(p), e = cx.main(p); if (!e) return; const i = cx.I(e); st.i = i; st.vd = cx.V(e.a) - cx.V(e.k); if (burnCheck(st, Math.abs(i) > 2 * o.imax || Math.abs(i * st.vd) > o.pmax, dt, 0.3)) cx.log(`💥 ${p.id} ${o.short} burned open (${fmt(i, 'A')})`); },
      readout(p, cx) { const st = cx.state(p); return st.burned ? 'BURNED open' : `${fmt(st.i || 0, 'A')}, Vf=${fmt(st.vd || 0, 'V')}`; },
      warn(p, cx) { const st = cx.state(p); if (st.burned) return `${o.short} burned out`; if (Math.abs(st.i || 0) > o.imax) return `${o.short} above ${o.imax} A rating`; },
    }, { bom: () => ({ key: type, name: o.bomName, q: o.q }) });
  }
  axial('d1n4007', { label: 'Diode 1N4007 (1 A, 1000 V)', short: '1N4007', print: '4007', body: '#17181b', band: '#c9ced4', vf: 0.93, ivf: 1, n: 1.9, rs: 0.03, bv: 1000, imax: 1, pmax: 3, bomName: 'Rectifier diode 1N4007 (1 A)', q: '1N4007 rectifier diode' });
  axial('d1n5819', { label: 'Schottky diode 1N5819 (1 A, 40 V)', short: '1N5819', print: '5819', body: '#202227', band: '#d8dde2', vf: 0.45, ivf: 1, n: 1.4, rs: 0.04, bv: 40, imax: 1, pmax: 2, bomName: 'Schottky diode 1N5819 (1 A 40 V)', q: '1N5819 schottky diode' });

  // ---------- small-signal BJTs (TO-92) ----------
  function smallBjt(type, label, pnp, name, bf, is, ic, pd, bomQ) {
    R.register(type, {
      label, cat: 'Semiconductors', prefix: 'Q', props: { bf },
      edit: [{ k: 'bf', label: 'β (hFE)', t: 'num' }],
      pins: () => [{ name: 'E', x: 0, y: 0 }, { name: 'B', x: 10, y: 0 }, { name: 'C', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
      svg(p, st) { st = st || {}; return to92(name, pnp ? 'PNP' : 'NPN') + (st.burned ? smoke(10, -26) : '') + dots(this.pins(p)) + lbls(['E', 'B', 'C'], [0, 10, 20], 10); },
      stamp(p, cx) { if (cx.state(p).burned) return; cx.add({ kind: 'Q', type: pnp ? 'pnp' : 'npn', c: cx.node(p, 'C'), b: cx.node(p, 'B'), e: cx.node(p, 'E'), is, bf: +p.props.bf || bf, br: 4, main: true }, p); },
      measure(p, cx, dt) { const st = cx.state(p), e = cx.main(p); if (!e) return; const r = cx.I(e); st.ic = r.ic; st.ib = r.ib; st.vce = cx.V(e.c) - cx.V(e.e); st.pd = Math.abs(r.ic * st.vce) + Math.abs(r.ib * (cx.V(e.b) - cx.V(e.e)));
        if (burnCheck(st, st.pd > pd * 1.5 || Math.abs(r.ic) > ic * 2, dt, 0.25)) cx.log(`💥 ${p.id} ${name} burned (${fmt(st.pd, 'W')}, Ic ${fmt(r.ic, 'A')})`); },
      readout(p, cx) { const st = cx.state(p); return st.burned ? 'BURNED' : `Ic=${fmt(st.ic || 0, 'A')} Ib=${fmt(st.ib || 0, 'A')} Vce=${fmt(st.vce || 0, 'V')} P=${fmt(st.pd || 0, 'W')}`; },
      warn(p, cx) { const st = cx.state(p); if (st.burned) return `${name} burned out`; if ((st.pd || 0) > pd) return `${name} dissipating ${fmt(st.pd, 'W')} (> ${pd} W)`; if (Math.abs(st.ic || 0) > ic) return `${name} collector current above ${ic * 1000} mA`; },
    }, { bom: () => ({ key: type, name: `${pnp ? 'PNP' : 'NPN'} transistor ${name} (TO-92)`, q: bomQ }) });
  }
  smallBjt('n2n3904', 'NPN 2N3904', false, '2N3904', 300, 6.7e-15, 0.2, 0.625, '2N3904 NPN transistor');
  smallBjt('p2n3906', 'PNP 2N3906', true, '2N3906', 250, 1.4e-14, 0.2, 0.625, '2N3906 PNP transistor');

  // ---------- TIP120 Darlington (TO-220: B C E), built-in C-E flyback diode ----------
  R.register('tip120', {
    label: 'Darlington TIP120 (5 A, TO-220)', cat: 'Semiconductors', prefix: 'Q', props: { heatsink: false },
    edit: [{ k: 'heatsink', label: 'Heatsink fitted', t: 'bool' }],
    pins: () => [{ name: 'B', x: 0, y: 0 }, { name: 'C', x: 10, y: 0 }, { name: 'E', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p, st) { st = st || {}; return to220([0, 10, 20], 'TIP120', 'NPN DARL.', Math.max(0, ((st.tj || 25) - 70) / 120)) + (st.burned ? smoke(10, -62) : '') + dots(this.pins(p)) + lbls(['B', 'C', 'E'], [0, 10, 20], 10) + K.plbl(10, -64, `${Math.round(st.tj || 25)}°C`); },
    stamp(p, cx) {
      if (cx.state(p).burned) return; const c = cx.node(p, 'C'), b = cx.node(p, 'B'), e = cx.node(p, 'E');
      // single-transistor equivalent: β ≈ 1000, Vbe(on) ≈ 1.3–1.4 V (two junctions)
      cx.add({ kind: 'Q', type: 'npn', c, b, e, is: 2e-25, bf: 1000, br: 2, main: true }, p);
      cx.add({ kind: 'R', a: b, b: e, r: 8e3 }, p);   // internal R1/R2 bleeders
      cx.add({ kind: 'D', a: e, k: c, is: 1e-11, n: 1.6 }, p);   // built-in flyback diode
    },
    measure(p, cx, dt) {
      const st = cx.state(p), e = cx.main(p); if (!e) return; const r = cx.I(e); st.ic = r.ic; st.ib = r.ib; st.vce = cx.V(e.c) - cx.V(e.e); st.pd = Math.max(0, r.ic * st.vce);
      const rth = p.props.heatsink ? 4 : 62.5, tgt = 25 + st.pd * rth; st.tj = (st.tj || 25) + (tgt - (st.tj || 25)) * (1 - Math.exp(-dt / 4));
      if (burnCheck(st, st.tj > 175 || r.ic > 8, dt, 0.1)) cx.log(`💥 ${p.id} TIP120 burned (Tj ${Math.round(st.tj)}°C)`);
    },
    readout(p, cx) { const st = cx.state(p); return st.burned ? 'BURNED' : `Ic=${fmt(st.ic || 0, 'A')} Ib=${fmt(st.ib || 0, 'A')} Vce=${fmt(st.vce || 0, 'V')} Tj ${Math.round(st.tj || 25)}°C`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'TIP120 burned out'; if ((st.tj || 25) > 130) return `TIP120 hot (${Math.round(st.tj)}°C) — ${p.props.heatsink ? 'reduce load' : 'add a heatsink'}`; },
  }, { bom: () => ({ key: 'tip120', name: 'TIP120 Darlington transistor (TO-220)', q: 'TIP120 darlington transistor TO-220' }) });

  // ---------- IRLZ44N logic-level N-MOSFET (TO-220: G D S) ----------
  R.register('irlz44n', {
    label: 'MOSFET IRLZ44N logic-level (TO-220)', cat: 'Semiconductors', prefix: 'Q', props: { heatsink: false },
    edit: [{ k: 'heatsink', label: 'Heatsink fitted', t: 'bool' }],
    pins: () => [{ name: 'G', x: 0, y: 0 }, { name: 'D', x: 10, y: 0 }, { name: 'S', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p, st) { st = st || {}; return to220([0, 10, 20], 'IRLZ44N', 'N-MOSFET', Math.max(0, ((st.tj || 25) - 70) / 120)) + (st.burned ? smoke(10, -62) : '') + dots(this.pins(p)) + lbls(['G', 'D', 'S'], [0, 10, 20], 10) + K.plbl(10, -64, `${Math.round(st.tj || 25)}°C`); },
    stamp(p, cx) {
      if (cx.state(p).burned) return; const d = cx.node(p, 'D'), g = cx.node(p, 'G'), s = cx.node(p, 'S');
      cx.add({ kind: 'M', type: 'n', d, g, s, vth: 1.6, k: 16, lambda: 0.005, main: true }, p);   // Rds(on) ≈ 25 mΩ @ 4.5 V, ~40 mΩ @ 3.3 V
      cx.add({ kind: 'D', a: s, k: d, is: 1e-11, n: 1.5 }, p);   // body diode
      cx.add({ kind: 'R', a: g, b: s, r: 1e9 }, p);
    },
    measure(p, cx, dt) {
      const st = cx.state(p), e = cx.main(p); if (!e) return; st.id = cx.I(e); st.vgs = cx.V(e.g) - cx.V(e.s); st.vds = cx.V(e.d) - cx.V(e.s); st.pd = Math.max(0, st.id * st.vds);
      const rth = p.props.heatsink ? 3 : 62, tgt = 25 + st.pd * rth; st.tj = (st.tj || 25) + (tgt - (st.tj || 25)) * (1 - Math.exp(-dt / 4));
      if (burnCheck(st, st.tj > 175 || st.vgs > 16 || st.vds > 55, dt, 0.05)) cx.log(`💥 ${p.id} IRLZ44N destroyed (${st.vgs > 16 ? 'Vgs > 16 V' : st.vds > 55 ? 'Vds > 55 V' : 'Tj ' + Math.round(st.tj) + '°C'})`);
    },
    readout(p, cx) { const st = cx.state(p); return st.burned ? 'DESTROYED' : `Id=${fmt(st.id || 0, 'A')} Vgs=${fmt(st.vgs || 0, 'V')} Vds=${fmt(st.vds || 0, 'V')} Tj ${Math.round(st.tj || 25)}°C`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'IRLZ44N destroyed'; if ((st.id || 0) > 1 && (st.vgs || 0) < 2.8) return 'IRLZ44N not fully enhanced (Vgs < 2.8 V) — heating up'; if ((st.tj || 25) > 130) return `IRLZ44N hot (${Math.round(st.tj)}°C)`; },
  }, { bom: () => ({ key: 'irlz44n', name: 'IRLZ44N logic-level N-MOSFET (TO-220)', q: 'IRLZ44N MOSFET logic level' }) });

  // ---------- PC817 optocoupler (DIP-4: 1 A, 2 K | 4 C, 3 E) ----------
  R.register('pc817', {
    label: 'Optocoupler PC817 (DIP-4)', cat: 'Semiconductors', prefix: 'U', props: { ctr: 1.0 },
    edit: [{ k: 'ctr', label: 'CTR (Ic/If)', t: 'num' }],
    pins: () => [{ name: 'A', x: 0, y: 0 }, { name: 'K', x: 10, y: 0 }, { name: 'C', x: 0, y: -30 }, { name: 'E', x: 10, y: -30 }], size: () => ({ w: 10, h: 10 }),
    svg(p, st) {
      st = st || {}; const on = (st.if || 0) > 5e-4;
      let s = [0, 10].map((x) => `<rect x="${x - 1.6}" y="-5" width="3.2" height="5" fill="url(#hkMetal)"/><rect x="${x - 1.6}" y="-30" width="3.2" height="5" fill="url(#hkMetal)"/>`).join('');
      s += `<rect x="-6" y="-26" width="22" height="22" rx="1.5" fill="#f2f2ee" stroke="#999" stroke-width=".5" filter="url(#fShadow)"/><circle cx="-2" cy="-8" r="1.3" fill="#888"/>` + silk(5, -16, 'PC817', 3.4, 'middle', undefined, '#222');
      if (on) s += `<circle cx="5" cy="-15" r="6" fill="#ff7a3a" opacity=".35" filter="url(#fGlow)" pointer-events="none"/>`;
      if (st.burned) s += smoke(5, -34);
      return s + dots(this.pins(p)) + lbls(['A', 'K'], [-2, 12], 9) + lbls(['C', 'E'], [-2, 12], -34);
    },
    stamp(p, cx) {
      const st = cx.state(p); if (st.burned) return;
      const d = S.diodeFromVf(1.2, 0.01, 1.9); cx.add({ kind: 'D', a: cx.node(p, 'A'), k: cx.node(p, 'K'), is: d.is, n: d.n, rs: 2, main: true }, p);
      const ic = (+p.props.ctr || 1) * Math.max(0, st.if || 0); st.ron = ic > 1e-6 ? Math.max(20, 0.2 / ic) : 1e9;
      cx.add({ kind: 'R', a: cx.node(p, 'C'), b: cx.node(p, 'E'), r: st.ron }, p);
    },
    espStep(p, c) { const st = c.state(p), g = c.gpio(p, 'A'); if (g && g.pin.out) { if (!g.pin.level && g.pin.pwm === undefined) st.if = 0; else if (!(st.if > 0)) st.if = st.ifLast || 0.003; } },
    measure(p, cx, dt) { const st = cx.state(p), e = cx.main(p); if (!e) return; const i = Math.max(0, cx.I(e)); st.ifMeas = i; if (i > 1e-4) st.ifLast = i; if (burnCheck(st, i > 0.1, dt, 0.2)) cx.log(`💥 ${p.id} PC817 LED burned (${fmt(i, 'A')} > 50 mA)`); },
    tick(p, c) { const st = c.state(p), i = st.ifMeas || 0, old = st.if || 0; if (Math.abs(i - old) > Math.max(2e-5, 0.1 * old)) { st.if = i; return true; } return false; },
    readout(p, cx) { const st = cx.state(p); return st.burned ? 'LED burned' : `If=${fmt(st.if || 0, 'A')} → output ${st.ron < 1e6 ? 'ON (' + fmt(st.ron, 'Ω') + ')' : 'off'}`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'PC817 LED burned out'; if ((st.ifMeas || 0) > 0.05) return 'PC817 LED above 50 mA — add a series resistor'; },
  }, { bom: () => ({ key: 'pc817', name: 'PC817 optocoupler (DIP-4)', q: 'PC817 optocoupler DIP-4' }) });

  // existing built-ins that had no BOM line
  const B = root.Bom; if (B && B.CATALOG) { /* nothing to add: diode/zener/npn/pnp/nmos/ldo/buzzer/servo/motor already listed */ }
})(typeof window !== 'undefined' ? window : globalThis);
