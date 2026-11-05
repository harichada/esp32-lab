/* Passives & inputs: ceramic / electrolytic capacitors with value pickers, inductor, crystal, trimmer, DIP switch, 12 mm tactile
 * and self-locking buttons, reed switch, tilt switch, RGB LED (common anode / cathode), 10-segment bar-graph LED, photodiode,
 * phototransistor, NTC thermistor, bussed resistor network. Registered through js/parts/registry.js. */
(function (root) {
  const P = root.Parts, R = root.PartsReg, T = P.T, esc = P.esc, fmt = P.fmt, pv = P.parseVal;
  const dots = (pins) => pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join('');
  const lead = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="url(#aLeadV)" stroke-width="1.7"/>`;
  const t = (x, y, s, sz, fill = '#f2f2f2', anchor = 'middle') => `<text x="${x}" y="${y}" font-size="${sz}" fill="${fill}" font-family="ui-monospace,Menlo,monospace" text-anchor="${anchor}" pointer-events="none">${esc(s)}</text>`;
  const DEFS = `<linearGradient id="pvEcap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#10233f"/><stop offset=".45" stop-color="#2d5a9a"/><stop offset="1" stop-color="#0c1a30"/></linearGradient>
<linearGradient id="pvCer" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb24a"/><stop offset="1" stop-color="#d27d12"/></linearGradient>
<linearGradient id="pvMlcc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa0e6"/><stop offset="1" stop-color="#2c63a8"/></linearGradient>
<linearGradient id="pvCu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3b06a"/><stop offset=".5" stop-color="#c6731f"/><stop offset="1" stop-color="#8a4a10"/></linearGradient>
<linearGradient id="pvXtal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9aa2ab"/><stop offset=".4" stop-color="#f1f3f5"/><stop offset="1" stop-color="#8a929b"/></linearGradient>
<linearGradient id="pvGlass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9f6ff" stop-opacity=".75"/><stop offset="1" stop-color="#9cc6dd" stop-opacity=".35"/></linearGradient>
<linearGradient id="pvRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5463b"/><stop offset="1" stop-color="#a81f17"/></linearGradient>`;
  function injectDefs() { const d = document.querySelector('#stage defs'); if (d && !d.querySelector('#pvEcap')) d.insertAdjacentHTML('beforeend', DEFS); }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectDefs); else injectDefs(); }
  const fmtq = (v, u) => fmt(v, u).replace(' ', '').replace('µ', 'u');

  // ---------- capacitors with value pickers (same electrical model as the generic Capacitor) ----------
  const CER = ['10p', '22p', '100p', '1n', '10n', '100n', '220n', '470n', '1u'];
  const ELE = ['1u', '2.2u', '4.7u', '10u', '22u', '47u', '100u', '220u', '470u', '1000u', '2200u'];
  const capCode = (c) => { const pf = Math.round(c * 1e12); if (pf < 100) return String(pf); const e = Math.floor(Math.log10(pf)) - 1; return String(Math.round(pf / Math.pow(10, e))) + e; };
  const capDef = (type, label, kind, opts, def0, kw) => R.register(type, {
    label, cat: 'Passive', prefix: 'C', props: { c: def0, v: kind === 'electrolytic' ? 16 : 50 }, dynamic: true, keywords: kw,
    edit: [{ k: 'c', label: 'Capacitance', t: 'sel', opts }, { k: 'v', label: 'Voltage rating (V)', t: 'num' }],
    pins: () => kind === 'electrolytic' ? [{ name: '+', x: 0, y: 0 }, { name: '-', x: 10, y: 0 }] : [{ name: '1', x: 0, y: 0 }, { name: '2', x: 10, y: 0 }],
    size: () => ({ w: 10, h: 10 }),
    svg(p, st) {
      const c = pv(p.props.c); let s;
      if (kind === 'electrolytic') {
        const big = c >= 220e-6, w = big ? 18 : 14, h = big ? 26 : 20, x0 = 5 - w / 2;
        s = lead(0, 0, -5) + lead(10, 0, -5) + `<rect x="${x0}" y="${-5 - h}" width="${w}" height="${h}" rx="2.5" fill="url(#pvEcap)" stroke="#06101f" stroke-width=".5" filter="url(#fShadow)"/>`;
        s += `<rect x="${x0 + w - 5}" y="${-5 - h}" width="4" height="${h}" fill="#c9d3df" opacity=".85"/>${[0.3, 0.55, 0.8].map((f) => t(x0 + w - 3, -5 - h + h * f + 1.2, '−', 3.6, '#1b2c45')).join('')}`;
        s += `<ellipse cx="5" cy="${-5 - h + 1.5}" rx="${w / 2 - 0.6}" ry="1.6" fill="#b9c2cc"/><path d="M${5 - w / 4} ${-5 - h + 1.5} h${w / 2} M5 ${-5 - h + 0.3} v2.4" stroke="#7d8792" stroke-width=".5"/>`;
        s += t(x0 + (w - 5) / 2, -5 - h / 2, fmtq(c, 'F'), 3.2, '#dfe7f1') + t(x0 + (w - 5) / 2, -5 - h / 2 + 4.5, p.props.v + 'V', 2.8, '#9fb2c9');
        if (st && st.rev) s += `<g class="smoke"><circle cx="5" cy="${-h - 12}" r="5"/><circle cx="9" cy="${-h - 22}" r="6"/></g>`;
        return s + dots(this.pins(p)) + `<text x="-4" y="9" class="plbl small">+</text><text x="5" y="${-h - 9}" class="plbl">${esc(fmt(c, 'F'))}</text>`;
      }
      const mlcc = c >= 100e-9;
      s = lead(0, 0, -6) + lead(10, 0, -6);
      s += mlcc ? `<rect x="-1" y="-17" width="12" height="11" rx="3" fill="url(#pvMlcc)" stroke="#173b66" stroke-width=".5" filter="url(#fShadow)"/>` : `<ellipse cx="5" cy="-12.5" rx="7.4" ry="6.6" fill="url(#pvCer)" stroke="#8a4f07" stroke-width=".5" filter="url(#fShadow)"/>`;
      s += `<ellipse cx="3" cy="-15" rx="3" ry="1.6" fill="#fff" opacity=".35" pointer-events="none"/>` + t(5, -10.6, capCode(c), 3.8, mlcc ? '#e8f1fb' : '#3b2203');
      return s + dots(this.pins(p)) + `<text x="5" y="-21" class="plbl">${esc(fmt(c, 'F'))}</text>`;
    },
    stamp(p, cx) { const ps = this.pins(p); cx.add({ kind: 'C', a: cx.node(p, ps[0].name), b: cx.node(p, ps[1].name), c: pv(p.props.c) || 1e-9, main: true }, p); },
    measure(p, cx) { const e = cx.main(p); if (e && kind === 'electrolytic') cx.state(p).rev = cx.V(e.a) - cx.V(e.b) < -1.5; },
    readout(p, cx) { const e = cx.main(p); return e ? `V=${fmt(cx.V(e.a) - cx.V(e.b), 'V')}` : ''; },
    warn(p, cx) { const e = cx.main(p); if (!e) return; const v = cx.V(e.a) - cx.V(e.b); if (kind === 'electrolytic' && v < -0.7) return 'electrolytic reverse-biased!'; if (Math.abs(v) > +p.props.v) return `over voltage rating (${fmt(Math.abs(v), 'V')} > ${p.props.v} V)`; },
  }, { bom: (pp) => ({ key: type + pp.c, name: `${kind === 'electrolytic' ? 'Electrolytic' : 'Ceramic'} capacitor ${fmt(pv(pp.c), 'F')} ${pp.v} V`, q: `${fmtq(pv(pp.c), 'F')} ${kind === 'electrolytic' ? 'electrolytic' : 'ceramic'} capacitor ${pp.v}V` }) });
  capDef('ccap', 'Ceramic capacitor', 'ceramic', CER, '100n', 'ceramic capacitor disc mlcc 104 decoupling bypass');
  capDef('ecap', 'Electrolytic capacitor', 'electrolytic', ELE, '10u', 'electrolytic capacitor polarized aluminium bulk');

  // ---------- inductor (radial drum core) ----------
  R.register('inductor', {
    label: 'Inductor', cat: 'Passive', prefix: 'L', props: { l: '10m' }, dynamic: true, keywords: 'inductor coil choke henry',
    edit: [{ k: 'l', label: 'Inductance', t: 'sel', opts: ['10u', '47u', '100u', '470u', '1m', '10m', '100m', '1'] }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) {
      let s = lead(0, 0, -5) + lead(20, 0, -5) + `<rect x="-2" y="-9" width="24" height="4" rx="1" fill="#2a2d33"/><rect x="-2" y="-30" width="24" height="4" rx="1" fill="#2a2d33"/><rect x="1" y="-26" width="18" height="17" fill="url(#pvCu)" filter="url(#fShadow)"/>`;
      for (let i = 0; i < 8; i++) s += `<line x1="1" y1="${-25 + i * 2.1}" x2="19" y2="${-24.2 + i * 2.1}" stroke="#6b3508" stroke-width=".5"/>`;
      return s + dots(this.pins(p)) + `<text x="10" y="-34" class="plbl">${esc(fmt(pv(p.props.l), 'H'))}</text>`;
    },
    stamp(p, cx) { const st = cx.state(p); cx.add({ kind: 'L', a: cx.node(p, '1'), b: cx.node(p, '2'), l: pv(p.props.l) || 1e-3, iprev: st.iL || 0, st, main: true }, p); cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 1e7 }, p); },
    readout(p, cx) { return `I=${fmt(cx.state(p).iL || 0, 'A')}`; },
  }, { bom: (pp) => ({ key: 'ind' + pp.l, name: 'Inductor ' + fmt(pv(pp.l), 'H') + ' radial', q: fmtq(pv(pp.l), 'H') + ' radial inductor' }) });

  // ---------- crystal (HC-49/S) ----------
  R.register('crystal', {
    label: 'Crystal HC-49', cat: 'Passive', prefix: 'Y', props: { f: '16M' }, keywords: 'crystal quartz oscillator resonator hc49 xtal mhz',
    edit: [{ k: 'f', label: 'Frequency', t: 'sel', opts: ['32.768k', '4M', '8M', '12M', '16M', '20M', '25M', '40M'] }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) {
      const f = pv(p.props.f), small = f < 1e6;
      if (small) return lead(7, 0, -6) + lead(13, 0, -6) + `<rect x="6" y="-24" width="8" height="18" rx="4" fill="url(#pvXtal)" stroke="#6c737c" stroke-width=".5" filter="url(#fShadow)"/><line x1="0" y1="0" x2="7" y2="0" stroke="#aeb4bb" stroke-width="1.4"/><line x1="13" y1="0" x2="20" y2="0" stroke="#aeb4bb" stroke-width="1.4"/>` + dots(this.pins(p)) + `<text x="10" y="-28" class="plbl">${esc(fmt(f, 'Hz'))}</text>`;
      return lead(3, 0, -5) + lead(17, 0, -5) + `<line x1="0" y1="0" x2="3" y2="0" stroke="#aeb4bb" stroke-width="1.4"/><line x1="17" y1="0" x2="20" y2="0" stroke="#aeb4bb" stroke-width="1.4"/><rect x="-3" y="-17" width="26" height="12" rx="6" fill="url(#pvXtal)" stroke="#6c737c" stroke-width=".6" filter="url(#fShadow)"/><rect x="-1" y="-15.4" width="22" height="3" rx="1.5" fill="#fff" opacity=".45"/>${t(10, -9, (f / 1e6).toFixed(f % 1e6 ? 3 : 0) + 'M', 4.2, '#3a4048')}` + dots(this.pins(p)) + `<text x="10" y="-21" class="plbl">${esc(fmt(f, 'Hz'))}</text>`;
    },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 1e10, main: true }, p); },
    readout(p) { return `${fmt(pv(p.props.f), 'Hz')} · electrically open at DC (oscillation not modelled)`; },
  }, { bom: (pp) => ({ key: 'xtal' + pp.f, name: 'Crystal ' + fmt(pv(pp.f), 'Hz') + ' HC-49', q: fmt(pv(pp.f), 'Hz').replace(' ', '') + ' crystal oscillator HC-49' }) });

  // ---------- trimmer pot (3296W multi-turn) ----------
  R.register('trimmer', {
    label: 'Trimmer pot 3296', cat: 'Input', prefix: 'RV', props: { r: 10000, pos: 0.5 }, keywords: 'trimmer trimpot preset potentiometer 3296 variable resistor',
    edit: [{ k: 'r', label: 'Resistance (Ω)', t: 'sel', opts: [100, 500, 1000, 5000, 10000, 50000, 100000, 1000000] }, { k: 'pos', label: 'Wiper', t: 'range', min: 0, max: 1, step: 0.005, live: true }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: 'W', x: 10, y: 0 }, { name: '2', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) {
      let s = [0, 10, 20].map((x) => lead(x, 0, -4)).join('') + `<rect x="-5" y="-22" width="30" height="18" rx="1.5" fill="url(#aBlue)" stroke="#123a75" stroke-width=".6" filter="url(#fShadow)"/>`;
      s += `<circle cx="19" cy="-13" r="4.2" fill="url(#aGold)" stroke="#7a5a12" stroke-width=".4"/><g transform="rotate(${(+p.props.pos) * 3600} 19 -13)"><rect x="18.3" y="-16.4" width="1.4" height="6.8" fill="#6b4c0e"/></g>`;
      s += t(6, -14.5, '3296', 3.4, '#e7eefa') + t(6, -9, P.fmt(pv(p.props.r), 'Ω').replace(' ', ''), 3, '#bcd0ee');
      return s + dots(this.pins(p)) + `<text x="10" y="-26" class="plbl">${Math.round(p.props.pos * 100)}%</text>`;
    },
    stamp: T.potentiometer.stamp, wheel(p, d) { p.props.pos = Math.min(1, Math.max(0, +p.props.pos - d * 0.02)); return true; },
    readout(p) { const r = pv(p.props.r); return `1-W ${fmt(r * p.props.pos, 'Ω')} · W-2 ${fmt(r * (1 - p.props.pos), 'Ω')}`; },
  }, { bom: (pp) => ({ key: 'trim' + pp.r, name: 'Trimmer pot 3296W ' + fmt(pv(pp.r), 'Ω'), q: '3296W ' + fmtq(pv(pp.r), 'ohm').replace('ohm', '') + ' trimmer potentiometer' }) });

  // ---------- DIP switch (4 / 8 positions; DIP footprint straddles the breadboard channel) ----------
  for (const n of [4, 8]) {
    const pins = []; for (let i = 0; i < n; i++) pins.push({ name: String(i + 1), x: i * 10, y: 0 }); for (let i = 0; i < n; i++) pins.push({ name: String(2 * n - i), x: i * 10, y: -30 });
    const props = {}; for (let i = 1; i <= n; i++) props['s' + i] = i === 1;
    R.register('dipsw' + n, {
      label: `DIP switch ${n}-way`, cat: 'Input', prefix: 'SW', props, keywords: 'dip switch dipswitch configuration piano', interactive: false,
      edit: Array.from({ length: n }, (_, i) => ({ k: 's' + (i + 1), label: `Switch ${i + 1} ON`, t: 'bool' })),
      pins: () => pins, size: () => ({ w: (n - 1) * 10, h: 30 }),
      svg(p) {
        let s = ''; for (let i = 0; i < n; i++) s += `<rect x="${i * 10 - 1.4}" y="-5" width="2.8" height="5" fill="url(#aLeadV)"/><rect x="${i * 10 - 1.4}" y="-30" width="2.8" height="5" fill="url(#aLeadV)"/>`;
        s += `<rect x="-6" y="-26" width="${(n - 1) * 10 + 12}" height="22" rx="1.5" fill="url(#pvRed)" stroke="#5c0f0a" stroke-width=".6" filter="url(#fShadow)"/>${t(-2, -22, 'ON', 3, '#fff', 'start')}`;
        for (let i = 0; i < n; i++) { const on = !!p.props['s' + (i + 1)]; s += `<rect x="${i * 10 - 3}" y="-21" width="6" height="12" rx=".8" fill="#5a0d08"/><rect x="${i * 10 - 2.6}" y="${on ? -20.6 : -15}" width="5.2" height="5.6" rx=".8" fill="#f4f4f4" stroke="#bbb" stroke-width=".3"/>${t(i * 10, -5.6, String(i + 1), 2.8, '#fff')}`; }
        return s + dots(pins);
      },
      stamp(p, cx) { for (let i = 1; i <= n; i++) if (p.props['s' + i]) cx.add({ kind: 'R', a: cx.node(p, String(i)), b: cx.node(p, String(2 * n + 1 - i)), r: 0.1 }, p); },
      readout(p) { return Array.from({ length: n }, (_, i) => p.props['s' + (i + 1)] ? '1' : '0').join(''); },
    }, { bom: () => ({ key: 'dip' + n, name: `DIP switch ${n} positions (2.54 mm)`, q: `${n} position DIP switch 2.54mm` }) });
  }

  // ---------- tactile button variants ----------
  const CAPS = { red: '#e53935', green: '#2e9e4f', blue: '#2f6fd6', yellow: '#f4c430', black: '#2a2d33', white: '#ececec', gray: '#8d939a' };
  R.register('tact12', {
    label: 'Tactile button 12 mm (capped)', cat: 'Input', prefix: 'BTN', props: { key: '', label: '', color: 'blue' }, interactive: true, keywords: 'tactile push button switch 12x12 momentary cap',
    edit: [{ k: 'key', label: 'Keyboard key', t: 'text' }, { k: 'label', label: 'Label', t: 'text' }, { k: 'color', label: 'Cap colour', t: 'sel', opts: Object.keys(CAPS) }],
    pins: () => [{ name: '1.l', x: 0, y: 0 }, { name: '2.l', x: 30, y: 0 }, { name: '1.r', x: 0, y: 30 }, { name: '2.r', x: 30, y: 30 }], size: () => ({ w: 30, h: 30 }),
    groups: () => [['1.l', '1.r'], ['2.l', '2.r']],
    svg(p, st) {
      const pr = st && st.pressed, cap = CAPS[p.props.color] || CAPS.blue;
      let s = `<rect x="-4" y="-4" width="38" height="38" rx="2" fill="url(#aShield)" stroke="#6c737c" stroke-width=".6" filter="url(#fShadow)"/><rect x="-1" y="-1" width="32" height="32" rx="1.5" fill="#1c1e22"/>`;
      s += [[1, 1], [29, 1], [1, 29], [29, 29]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4" fill="#555b63"/>`).join('');
      s += `<circle cx="15" cy="15" r="12.5" fill="#0b0c0e"/><circle cx="15" cy="${pr ? 15.8 : 15}" r="${pr ? 10.2 : 11}" fill="${cap}"/><circle cx="15" cy="${pr ? 15.8 : 15}" r="${pr ? 10.2 : 11}" fill="url(#aCap)" opacity="${pr ? 0.5 : 1}" pointer-events="none"/>`;
      return s + dots(this.pins(p)) + (p.props.label ? `<text x="15" y="44" class="plbl">${esc(p.props.label)}</text>` : '') + (p.props.key ? `<text x="15" y="18" class="pb-key">${esc(p.props.key)}</text>` : '');
    },
    stamp(p, cx) { if (cx.state(p).pressed) cx.add({ kind: 'R', a: cx.node(p, '1.l'), b: cx.node(p, '2.l'), r: 0.05, main: true }, p); },
  }, { bom: () => ({ key: 'tact12', name: 'Tactile button 12×12 mm with cap', q: '12x12mm tactile push button with caps' }) });
  R.register('latchbtn', {
    label: 'Self-locking push switch', cat: 'Input', prefix: 'SW', props: { on: false }, keywords: 'latching push button self locking on off switch 8x8 push-on push-off',
    edit: [{ k: 'on', label: 'Latched ON', t: 'bool' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) { const on = !!p.props.on; return lead(0, 0, -5) + lead(20, 0, -5) + `<rect x="-3" y="-25" width="26" height="20" rx="1.5" fill="url(#aShield)" stroke="#6c737c" stroke-width=".6" filter="url(#fShadow)"/><rect x="2" y="${on ? -21 : -23}" width="16" height="${on ? 12 : 14}" rx="1.5" fill="${on ? '#2a2d33' : '#3a3e45'}" stroke="#000" stroke-width=".4"/>${t(10, -14, on ? 'ON' : 'OFF', 4, on ? '#7dff6a' : '#bbb')}` + dots(this.pins(p)); },
    stamp(p, cx) { if (p.props.on) cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 0.05, main: true }, p); },
    click(p) { p.props.on = !p.props.on; return true; },
  }, { bom: () => ({ key: 'latch', name: 'Self-locking push switch 8×8 mm', q: '8x8mm self locking push button switch' }) });

  // ---------- reed switch / tilt switch ----------
  R.register('reed', {
    label: 'Reed switch (magnet)', cat: 'Input', prefix: 'SW', props: { magnet: false }, keywords: 'reed switch magnetic door sensor magnet glass',
    edit: [{ k: 'magnet', label: 'Magnet nearby', t: 'bool' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 40, y: 0 }], size: () => ({ w: 40, h: 10 }),
    svg(p) {
      const m = !!p.props.magnet;
      let s = `<line x1="0" y1="0" x2="8" y2="0" stroke="#aeb4bb" stroke-width="1.4"/><line x1="32" y1="0" x2="40" y2="0" stroke="#aeb4bb" stroke-width="1.4"/><path d="M8 0 h12 l1 ${m ? 0 : -1.4}" stroke="#7d8792" stroke-width="1.2" fill="none"/><path d="M32 0 h-12" stroke="#7d8792" stroke-width="1.2"/>`;
      s += `<rect x="6" y="-4" width="28" height="8" rx="4" fill="url(#pvGlass)" stroke="#9cc6dd" stroke-width=".5" filter="url(#fShadow)"/><rect x="8" y="-3" width="24" height="2" rx="1" fill="#fff" opacity=".5"/>`;
      if (m) s += `<g><rect x="6" y="-20" width="14" height="8" fill="#d32f2f"/><rect x="20" y="-20" width="14" height="8" fill="#2f6fd6"/>${t(13, -14, 'N', 5)}${t(27, -14, 'S', 5)}</g>`;
      return s + dots(this.pins(p)) + `<text x="20" y="${m ? -24 : -8}" class="plbl">${m ? 'closed' : 'open'}</text>`;
    },
    stamp(p, cx) { if (p.props.magnet) cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 0.1, main: true }, p); },
    click(p) { p.props.magnet = !p.props.magnet; return true; },
  }, { bom: () => ({ key: 'reed', name: 'Reed switch (glass, N.O.) + magnet', q: 'reed switch normally open glass with magnet' }) });
  R.register('tilt', {
    label: 'Tilt switch SW-520D', cat: 'Input', prefix: 'SW', props: { tilt: 0 }, keywords: 'tilt switch ball sw-520d vibration orientation',
    edit: [{ k: 'tilt', label: 'Tilt (°)', t: 'range', min: 0, max: 180, step: 1, live: true }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 10, y: 0 }], size: () => ({ w: 10, h: 10 }),
    closed: (p) => +p.props.tilt < 45,
    svg(p) {
      const c = this.closed(p), a = Math.min(90, +p.props.tilt);
      return lead(0, 0, -5) + lead(10, 0, -5) + `<g transform="rotate(${a} 5 -14)"><rect x="-1" y="-24" width="12" height="19" rx="2" fill="url(#aShield)" stroke="#6c737c" stroke-width=".5" filter="url(#fShadow)"/><circle cx="5" cy="${c ? -9 : -20}" r="3" fill="#cfd3d8" stroke="#666" stroke-width=".4"/></g>` + dots(this.pins(p)) + `<text x="5" y="-29" class="plbl">${c ? 'closed' : 'open'} ${Math.round(+p.props.tilt)}°</text>`;
    },
    stamp(p, cx) { if (this.closed(p)) cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 1, main: true }, p); },
    click(p) { p.props.tilt = this.closed(p) ? 90 : 0; return true; },
  }, { bom: () => ({ key: 'tilt', name: 'Tilt ball switch SW-520D', q: 'SW-520D tilt ball switch' }) });

  // ---------- RGB LED (5 mm, 4 leads: R, COM, G, B) ----------
  const VF = { R: 2.0, G: 3.0, B: 3.1 };
  R.register('rgbled', {
    label: 'RGB LED 5 mm', cat: 'Semiconductors', prefix: 'LED', props: { common: 'cathode' }, keywords: 'rgb led common anode common cathode tricolor colour',
    edit: [{ k: 'common', label: 'Common pin', t: 'sel', opts: ['cathode', 'anode'] }],
    pins: () => [{ name: 'R', x: 0, y: 0 }, { name: 'COM', x: 10, y: 0 }, { name: 'G', x: 20, y: 0 }, { name: 'B', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      const b = (st && st.b) || { R: 0, G: 0, B: 0 }, m = Math.max(b.R, b.G, b.B);
      const col = m > 0.01 ? `rgb(${Math.round(60 + 195 * b.R)},${Math.round(60 + 195 * b.G)},${Math.round(60 + 195 * b.B)})` : '#e9eef2';
      let s = [0, 10, 20, 30].map((x) => `<path d="M${x} 0 V-8 L15 -11" stroke="url(#aLeadV)" stroke-width="1.5" fill="none"/>`).join('');
      if (m > 0.01) s += `<circle cx="15" cy="-22" r="${11 + 16 * m}" style="fill:${col};opacity:${0.65 * m}" filter="url(#fGlow)" pointer-events="none"/>`;
      s += `<path d="M7 -10 h16 v-12 a8 8 0 0 0 -16 0 z" fill="${col}" opacity="${0.55 + 0.45 * m}" stroke="#0005" stroke-width=".5"/><path d="M7 -10 h16 v-12 a8 8 0 0 0 -16 0 z" fill="url(#aDome)" pointer-events="none"/><rect x="6" y="-11.4" width="18" height="2.6" rx=".8" fill="#dfe6ec" stroke="#0004" stroke-width=".4"/>`;
      return s + dots(this.pins(p)) + ['R', p.props.common === 'anode' ? '+' : '−', 'G', 'B'].map((n, i) => `<text x="${i * 10}" y="9" class="plbl small">${n}</text>`).join('');
    },
    stamp(p, cx) {
      const ca = p.props.common === 'anode', com = cx.node(p, 'COM');
      for (const c of ['R', 'G', 'B']) { const s = root.Solver.diodeFromVf(VF[c], 0.02, 2), n = cx.node(p, c); cx.add(ca ? { kind: 'D', a: com, k: n, is: s.is, n: s.n, tag: c } : { kind: 'D', a: n, k: com, is: s.is, n: s.n, tag: c }, p); }
    },
    measure(p, cx) {
      const st = cx.state(p), sim = cx; st.b = st.b || {}; st.i = st.i || {};
      const ca = p.props.common === 'anode';
      for (const c of ['R', 'G', 'B']) { const vd = ca ? cx.pinV(p, 'COM') - cx.pinV(p, c) : cx.pinV(p, c) - cx.pinV(p, 'COM'); const s = root.Solver.diodeFromVf(VF[c], 0.02, 2); const i = Math.max(0, s.is * (Math.exp(Math.min(vd / (s.n * 0.025852), 80)) - 1)); st.i[c] = i; st.b[c] = Math.min(1, Math.sqrt(i / 0.012)); }
    },
    readout(p, cx) { const st = cx.state(p); return st.i ? ['R', 'G', 'B'].map((c) => `${c} ${fmt(st.i[c], 'A')}`).join(' · ') : ''; },
    warn(p, cx) { const st = cx.state(p); if (st.i && Math.max(st.i.R, st.i.G, st.i.B) > 0.03) return 'RGB LED channel over 30 mA — add series resistors'; },
  }, { bom: (pp) => ({ key: 'rgb' + pp.common, name: `RGB LED 5 mm, common ${pp.common}`, q: `5mm RGB LED common ${pp.common}` }) });

  // ---------- 10-segment bar graph LED (DIP-20: pins 1-10 anodes, 20-11 cathodes) ----------
  const BGP = []; for (let i = 0; i < 10; i++) BGP.push({ name: 'A' + (i + 1), x: i * 10, y: 0 }); for (let i = 0; i < 10; i++) BGP.push({ name: 'K' + (i + 1), x: i * 10, y: -30 });
  R.register('bargraph', {
    label: 'LED bar graph 10-segment', cat: 'Semiconductors', prefix: 'BAR', props: { color: 'red' }, keywords: 'led bar graph 10 segment level meter vu dip-20',
    edit: [{ k: 'color', label: 'Colour', t: 'sel', opts: ['red', 'green', 'yellow', 'blue'] }],
    pins: () => BGP, size: () => ({ w: 90, h: 30 }),
    svg(p, st) {
      const col = (P.LEDCOL[p.props.color] || P.LEDCOL.red)[0], b = (st && st.b) || [];
      let s = ''; for (let i = 0; i < 10; i++) s += `<rect x="${i * 10 - 1.4}" y="-5" width="2.8" height="5" fill="url(#aLeadV)"/><rect x="${i * 10 - 1.4}" y="-30" width="2.8" height="5" fill="url(#aLeadV)"/>`;
      s += `<rect x="-5" y="-26" width="100" height="22" rx="1" fill="#16171a" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/>`;
      for (let i = 0; i < 10; i++) { const v = b[i] || 0; if (v > 0.02) s += `<rect x="${i * 10 - 4}" y="-24" width="8" height="18" fill="${col}" opacity="${0.6 * v}" filter="url(#fGlow)" pointer-events="none"/>`; s += `<rect x="${i * 10 - 2.6}" y="-23" width="5.2" height="16" rx=".5" fill="${col}" opacity="${0.22 + 0.78 * v}"/>`; }
      return s + dots(BGP) + `<text x="45" y="-30" class="plbl" style="display:none"></text>`;
    },
    stamp(p, cx) { const d = root.Solver.diodeFromVf((P.LEDCOL[p.props.color] || P.LEDCOL.red)[1], 0.02, 2); for (let i = 1; i <= 10; i++) cx.add({ kind: 'D', a: cx.node(p, 'A' + i), k: cx.node(p, 'K' + i), is: d.is, n: d.n, tag: 'seg' + i }, p); },
    measure(p, cx) { const st = cx.state(p), d = root.Solver.diodeFromVf((P.LEDCOL[p.props.color] || P.LEDCOL.red)[1], 0.02, 2); st.b = []; st.i = []; for (let i = 1; i <= 10; i++) { const vd = cx.pinV(p, 'A' + i) - cx.pinV(p, 'K' + i), c = Math.max(0, d.is * (Math.exp(Math.min(vd / (d.n * 0.025852), 80)) - 1)); st.i.push(c); st.b.push(Math.min(1, Math.sqrt(c / 0.012))); } },
    readout(p, cx) { const st = cx.state(p); return st.i ? 'lit: ' + st.i.map((c, i) => c > 1e-3 ? i + 1 : null).filter(Boolean).join(',') : ''; },
    warn(p, cx) { const st = cx.state(p); if (st.i && Math.max(...st.i) > 0.03) return 'bar-graph segment over 30 mA — add resistors'; },
  }, { bom: (pp) => ({ key: 'bar' + pp.color, name: `LED bar graph 10-segment (${pp.color}, DIP-20)`, q: `10 segment LED bar graph ${pp.color}` }) });

  // ---------- photodiode / phototransistor / NTC ----------
  const luxEdit = { k: 'lux', label: 'Light (lux)', t: 'range', min: 0.1, max: 10000, step: 1, log: true, live: true };
  R.register('photodiode', {
    label: 'Photodiode BPW34', cat: 'Sensors', prefix: 'PD', props: { lux: 500 }, keywords: 'photodiode light sensor bpw34 photo diode reverse bias',
    edit: [luxEdit], pins: () => [{ name: 'A', x: 0, y: 0 }, { name: 'K', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    iph: (lux) => 5e-8 * Math.max(0, lux),   // ~50 µA at 1000 lux
    svg(p) { return lead(0, 0, -5) + lead(20, 0, -5) + `<rect x="-3" y="-21" width="26" height="16" rx="1.5" fill="#1a1b1e" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><rect x="2" y="-18.5" width="16" height="11" rx="1" fill="#2a1f3a"/><rect x="3" y="-17.5" width="14" height="9" fill="#493472" opacity=".85"/><rect x="3" y="-17.5" width="14" height="3" fill="#fff" opacity=".25"/>` + dots(this.pins(p)) + `<text x="-2" y="9" class="plbl small">A</text><text x="22" y="9" class="plbl small">K</text><text x="10" y="-25" class="plbl">${Math.round(p.props.lux)} lx</text>`; },
    stamp(p, cx) { const a = cx.node(p, 'A'), k = cx.node(p, 'K'); cx.add({ kind: 'D', a, k, is: 1e-12, n: 1.5, main: true }, p); cx.add({ kind: 'I', a: k, b: a, i: this.iph(+p.props.lux) }, p); },
    readout(p) { return `Iph=${fmt(this.iph(+p.props.lux), 'A')} (reverse-bias it: K to +, A to load)`; },
  }, { bom: () => ({ key: 'bpw34', name: 'Photodiode BPW34', q: 'BPW34 photodiode' }) });
  R.register('phototransistor', {
    label: 'Phototransistor PT334', cat: 'Sensors', prefix: 'Q', props: { lux: 200 }, keywords: 'phototransistor light sensor pt334 ir receiver photo transistor',
    edit: [luxEdit], pins: () => [{ name: 'C', x: 0, y: 0 }, { name: 'E', x: 10, y: 0 }], size: () => ({ w: 10, h: 10 }),
    il: (lux) => Math.min(0.02, 4e-6 * Math.max(0, lux)),   // ~2 mA at 500 lux
    svg(p) {
      let s = `<path d="M0 0 V-9" stroke="url(#aLeadV)" stroke-width="1.6"/><path d="M10 0 V-7 l-1.5 -2" stroke="url(#aLeadV)" stroke-width="1.6" fill="none"/>`;
      s += `<path d="M-2.5 -8.5 h15 v-11.5 a7.5 7.5 0 0 0 -15 0 z" fill="#1d1f24" opacity=".92" stroke="#0005" stroke-width=".5"/><path d="M-2.5 -8.5 h15 v-11.5 a7.5 7.5 0 0 0 -15 0 z" fill="url(#aDome)" pointer-events="none"/><rect x="-3.5" y="-9.6" width="17" height="2.6" rx=".8" fill="#1d1f24"/>`;
      return s + dots(this.pins(p)) + `<text x="0" y="9" class="plbl small">C</text><text x="10" y="9" class="plbl small">E</text><text x="5" y="-31" class="plbl">${Math.round(p.props.lux)} lx</text>`;
    },
    stamp(p, cx) { cx.add({ kind: 'PT', c: cx.node(p, 'C'), e: cx.node(p, 'E'), il: this.il(+p.props.lux) + 1e-8, main: true }, p); },
    readout(p, cx) { const e = cx.main(p); return e ? `Ic=${fmt(cx.I(e), 'A')} (max ${fmt(e.il, 'A')})` : ''; },
  }, { bom: () => ({ key: 'pt334', name: 'Phototransistor 5 mm (PT334-6C / 3DU5C)', q: 'phototransistor 5mm PT334' }) });
  R.register('ntc', {
    label: 'Thermistor NTC 10k', cat: 'Sensors', prefix: 'TH', props: { temp: 25, r25: 10000, beta: 3950 }, keywords: 'thermistor ntc temperature sensor mf52 10k beta 3950',
    edit: [{ k: 'temp', label: 'Temperature (°C)', t: 'range', min: -40, max: 125, step: 0.5, live: true }, { k: 'r25', label: 'R @25 °C (Ω)', t: 'sel', opts: [1000, 4700, 10000, 47000, 100000] }, { k: 'beta', label: 'β (K)', t: 'num' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 10, y: 0 }], size: () => ({ w: 10, h: 10 }),
    R: (p) => (+p.props.r25 || 1e4) * Math.exp((+p.props.beta || 3950) * (1 / (273.15 + +p.props.temp) - 1 / 298.15)),
    svg(p) { return lead(0, 0, -8) + lead(10, 0, -8) + `<path d="M0 -8 L4 -14 M10 -8 L6 -14" stroke="url(#aLeadV)" stroke-width="1.2"/><ellipse cx="5" cy="-18" rx="5.5" ry="6" fill="#1b1c1f" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><ellipse cx="3.4" cy="-20.4" rx="2" ry="1.4" fill="#fff" opacity=".3"/>` + dots(this.pins(p)) + `<text x="5" y="-28" class="plbl">${(+p.props.temp).toFixed(1)}°C</text>`; },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: this.R(p), main: true }, p); },
    readout(p) { return 'R=' + fmt(this.R(p), 'Ω'); },
  }, { bom: (pp) => ({ key: 'ntc' + pp.r25, name: `NTC thermistor ${fmt(+pp.r25, 'Ω')} β${pp.beta}`, q: `NTC thermistor ${fmtq(+pp.r25, '').replace(/\s/g, '')} ${pp.beta}` }) });

  // ---------- resistor network (SIP-9 bussed: pin 1 common) ----------
  const RNP = Array.from({ length: 9 }, (_, i) => ({ name: i ? String(i + 1) : 'COM', x: i * 10, y: 0 }));
  R.register('rnet', {
    label: 'Resistor network SIP-9 (bussed)', cat: 'Passive', prefix: 'RN', props: { r: 10000 }, keywords: 'resistor network array sip bussed pull-up pullup 8 resistors a103',
    edit: [{ k: 'r', label: 'Each resistor (Ω)', t: 'sel', opts: [220, 330, 470, 1000, 4700, 10000, 47000, 100000] }],
    pins: () => RNP, size: () => ({ w: 80, h: 10 }),
    svg(p) {
      const r = pv(p.props.r), e = Math.floor(Math.log10(r)) - 1, code = 'A' + Math.round(r / Math.pow(10, e)) + e;
      let s = RNP.map((q) => lead(q.x, 0, -4)).join('') + `<rect x="-4" y="-16" width="88" height="12" rx="3" fill="#e9d9a8" stroke="#a48b48" stroke-width=".5" filter="url(#fShadow)"/><circle cx="0" cy="-10" r="1.4" fill="#2a2d33"/>`;
      s += t(42, -8.4, `${code}J · 8×${fmt(r, 'Ω').replace(' ', '')}`, 4, '#3b3320');
      return s + dots(RNP) + `<text x="0" y="9" class="plbl small">●</text>`;
    },
    stamp(p, cx) { const r = pv(p.props.r) || 1e4, c = cx.node(p, 'COM'); for (let i = 2; i <= 9; i++) cx.add({ kind: 'R', a: c, b: cx.node(p, String(i)), r }, p); },
    readout(p) { return `8 × ${fmt(pv(p.props.r), 'Ω')} from COM (pin 1, dot)`; },
  }, { bom: (pp) => ({ key: 'rnet' + pp.r, name: `Resistor network SIP-9 bussed 8×${fmt(pv(pp.r), 'Ω')}`, q: `${fmtq(pv(pp.r), '')} SIP-9 resistor network bussed`.replace(/\s+/g, ' ') }) });
})(typeof window !== 'undefined' ? window : globalThis);
