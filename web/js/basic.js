/* Basic circuits without an ESP32: battery packs, bench supply, lamp, DC motor, toggle switch, digital multimeter,
 * resistor/lamp burn-out, realistic artwork, and the "Basic circuits (no ESP32)" example projects.
 * Everything here is solved by the existing MNA solver (solver.js) via sim.js — no compile, no QEMU. */
(function (root) {
  const P = root.Parts, T = P.T, esc = P.esc, fmt = P.fmt;
  const dots = (pins) => pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join('');
  const lead = (x, y1, y2, c = 'url(#aLeadV)') => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${c}" stroke-width="1.8"/>`;
  const wireLead = (x, y1, y2, col) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${col}" stroke-width="2.4" stroke-linecap="round"/>`;
  const smoke = (x, y) => `<g class="smoke"><circle cx="${x}" cy="${y}" r="5"/><circle cx="${x + 4}" cy="${y - 10}" r="6"/><circle cx="${x - 2}" cy="${y - 20}" r="7"/></g>`;
  const DEFS = `
<linearGradient id="bBat9" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1b1d21"/><stop offset=".5" stop-color="#3a3f47"/><stop offset="1" stop-color="#15171a"/></linearGradient>
<linearGradient id="bCopper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0a14a"/><stop offset="1" stop-color="#b8661c"/></linearGradient>
<linearGradient id="bAA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b8892a"/><stop offset=".45" stop-color="#f7dd84"/><stop offset="1" stop-color="#8a6419"/></linearGradient>
<linearGradient id="bAAblk" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0e0f11"/><stop offset=".45" stop-color="#3b3f45"/><stop offset="1" stop-color="#0a0b0c"/></linearGradient>
<radialGradient id="bCoin" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#c9ced4"/><stop offset="1" stop-color="#7c848d"/></radialGradient>
<linearGradient id="bPsu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9ecef"/><stop offset="1" stop-color="#b9bfc6"/></linearGradient>
<linearGradient id="bDmm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd23f"/><stop offset="1" stop-color="#e0a800"/></linearGradient>
<radialGradient id="bBulb" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".6" stop-color="#dfe9f2" stop-opacity=".35"/><stop offset="1" stop-color="#9fb3c4" stop-opacity=".55"/></radialGradient>
<linearGradient id="bCan" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d7dbe0"/><stop offset=".5" stop-color="#9aa2ab"/><stop offset="1" stop-color="#6c737c"/></linearGradient>`;
  function injectDefs() { const d = document.querySelector('#stage defs'); if (d && !d.querySelector('#bBat9')) d.insertAdjacentHTML('beforeend', DEFS); }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectDefs); else injectDefs(); }
  const def = (type, d) => { d.type = type; T[type] = d; return d; };
  const srcReadout = (p, cx) => { const e = cx.main(p); return e ? `I=${fmt(-cx.I(e), 'A')} · V=${fmt(cx.V(e.a) - cx.V(e.b), 'V')}` : ''; };
  const srcWarn = (lim) => (p, cx) => { const e = cx.main(p); if (e && Math.abs(cx.I(e)) > lim) return `SHORT CIRCUIT: ${fmt(Math.abs(cx.I(e)), 'A')} from ${p.id}!`; };

  // ---------- 9 V battery ----------
  def('battery9v', {
    label: '9 V battery (PP3)', cat: 'Power', props: { v: 9, rint: 1.7 }, groundPins: [['-', 1]],
    edit: [{ k: 'v', label: 'Voltage (V)', t: 'num' }, { k: 'rint', label: 'Internal R (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) {
      let s = wireLead(0, 0, -10, '#d32f2f') + wireLead(20, 0, -10, '#222');
      s += `<rect x="-12" y="-74" width="44" height="64" rx="4" fill="url(#bBat9)" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/><rect x="-12" y="-58" width="44" height="30" fill="#e5b81f"/><rect x="-12" y="-58" width="44" height="3" fill="#0003"/>`;
      s += `<text x="10" y="-39" font-size="11" font-weight="700" fill="#111" text-anchor="middle" font-family="Arial,sans-serif" pointer-events="none">9V</text><text x="10" y="-31" font-size="4.6" fill="#222" text-anchor="middle" pointer-events="none">ALKALINE</text>`;
      s += `<rect x="-4" y="-82" width="10" height="8" rx="1.5" fill="url(#aShield)" stroke="#555" stroke-width=".5"/><path d="M14 -74 v-6 h4 v-2 h4 v2 h4 v6 z" fill="url(#aShield)" stroke="#555" stroke-width=".5"/><text x="1" y="-62" font-size="6" fill="#ddd" text-anchor="middle">+</text><text x="20" y="-62" font-size="7" fill="#ddd" text-anchor="middle">−</text>`;
      return s + dots(this.pins(p)) + `<text x="-6" y="9" class="plbl small">+</text><text x="26" y="9" class="plbl small">−</text>`;
    },
    stamp(p, cx) { cx.add({ kind: 'V', a: cx.node(p, '+'), b: cx.node(p, '-'), v: +p.props.v, rs: +p.props.rint || 0.01, main: true }, p); },
    readout: srcReadout, warn: srcWarn(1),
  });
  // ---------- AA battery pack ----------
  def('aapack', {
    label: 'AA battery pack', cat: 'Power', props: { n: 2 }, groundPins: [['-', 1]],
    edit: [{ k: 'n', label: 'Cells (1.5 V each)', t: 'sel', opts: [1, 2, 3, 4] }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 40, y: 0 }], size: () => ({ w: 40, h: 10 }),
    svg(p) {
      const n = +p.props.n || 2, w = n * 16 + 8, x0 = 20 - w / 2;
      let s = wireLead(0, 0, -10, '#d32f2f') + wireLead(40, 0, -10, '#222');
      s += `<rect x="${x0}" y="-70" width="${w}" height="60" rx="3" fill="#1b1c1f" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/>`;
      for (let i = 0; i < n; i++) {
        const x = x0 + 5 + i * 16, up = i % 2 === 0;
        s += `<rect x="${x}" y="-64" width="14" height="48" rx="2" fill="url(#bAAblk)"/><rect x="${x}" y="${up ? -64 : -32}" width="14" height="16" rx="2" fill="url(#bAA)"/><rect x="${x + 4}" y="${up ? -67 : -16}" width="6" height="3" rx="1" fill="url(#aShield)"/>`;
        s += `<text x="${x + 7}" y="-38" font-size="4.5" fill="#eee" text-anchor="middle" transform="rotate(-90 ${x + 7} -38)" pointer-events="none">AA 1.5V</text>`;
      }
      return s + dots(this.pins(p)) + `<text x="20" y="-74" class="plbl">${(n * 1.5).toFixed(1)} V</text><text x="-6" y="9" class="plbl small">+</text><text x="46" y="9" class="plbl small">−</text>`;
    },
    stamp(p, cx) { const n = +p.props.n || 2; cx.add({ kind: 'V', a: cx.node(p, '+'), b: cx.node(p, '-'), v: 1.5 * n, rs: 0.15 * n, main: true }, p); },
    readout: srcReadout, warn: srcWarn(2),
  });
  // ---------- CR2032 coin cell ----------
  def('coincell', {
    label: 'Coin cell CR2032 (3 V)', cat: 'Power', props: { v: 3, rint: 15 }, groundPins: [['-', 1]],
    edit: [{ k: 'rint', label: 'Internal R (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) {
      let s = lead(0, 0, -8) + lead(20, 0, -8);
      s += `<rect x="-6" y="-38" width="32" height="30" rx="3" fill="#202226" filter="url(#fShadow)"/><circle cx="10" cy="-23" r="13" fill="url(#bCoin)" stroke="#6c737c" stroke-width=".6"/><circle cx="10" cy="-23" r="10.5" fill="none" stroke="#ffffff55" stroke-width=".6"/>`;
      s += `<text x="10" y="-24" font-size="4.6" fill="#333" text-anchor="middle" pointer-events="none">CR2032</text><text x="10" y="-18" font-size="5" fill="#333" text-anchor="middle" pointer-events="none">3V +</text>`;
      return s + dots(this.pins(p)) + `<text x="-6" y="9" class="plbl small">+</text><text x="26" y="9" class="plbl small">−</text>`;
    },
    stamp(p, cx) { cx.add({ kind: 'V', a: cx.node(p, '+'), b: cx.node(p, '-'), v: +p.props.v || 3, rs: +p.props.rint || 15, main: true }, p); },
    readout: srcReadout,
  });
  // ---------- adjustable bench supply (constant-voltage / constant-current) ----------
  def('bench', {
    label: 'Bench power supply (adjustable)', cat: 'Power', props: { pos: 0.3, vmax: 30, ilim: 0.5 }, groundPins: [['-', 2]], dynamic: false,
    edit: [{ k: 'pos', label: 'Output voltage (knob, × Vmax)', t: 'range', min: 0, max: 1, step: 0.005, live: true }, { k: 'vmax', label: 'Vmax (V)', t: 'num' }, { k: 'ilim', label: 'Current limit (A)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    vset: (p) => Math.round((+p.props.pos || 0) * (+p.props.vmax || 30) * 10) / 10,
    svg(p, st) {
      st = st || {}; const vs = this.vset(p), cc = st.cc, vo = st.vout !== undefined ? st.vout : vs, io = st.iout || 0, a = -135 + 270 * (+p.props.pos || 0);
      let s = wireLead(0, 0, -10, '#d32f2f') + wireLead(30, 0, -10, '#222');
      s += `<rect x="-22" y="-78" width="74" height="68" rx="4" fill="url(#bPsu)" stroke="#7a828b" stroke-width=".7" filter="url(#fShadow)"/><rect x="-22" y="-78" width="74" height="9" rx="4" fill="#2b5fb3"/><text x="15" y="-71.5" font-size="5" fill="#fff" text-anchor="middle" pointer-events="none">DC POWER SUPPLY</text>`;
      s += `<rect x="-17" y="-65" width="40" height="24" rx="1.5" fill="#0b0f0b" stroke="#000" stroke-width=".6"/><text x="21" y="-55" font-size="9" fill="${cc ? '#ff6a4a' : '#7dff6a'}" text-anchor="end" font-family="ui-monospace,Menlo,monospace" pointer-events="none">${vo.toFixed(vo < 10 ? 2 : 1)}V</text><text x="21" y="-44.5" font-size="7.5" fill="#ffd84a" text-anchor="end" font-family="ui-monospace,Menlo,monospace" pointer-events="none">${Math.abs(io).toFixed(3)}A</text>`;
      s += `<text x="-15" y="-35" font-size="4.6" fill="${cc ? '#d32f2f' : '#999'}" font-weight="700" pointer-events="none">CC</text><text x="-6" y="-35" font-size="4.6" fill="${cc ? '#999' : '#1c8a43'}" font-weight="700" pointer-events="none">CV</text>`;
      s += `<g transform="rotate(${a} 38 -52)"><circle cx="38" cy="-52" r="10" fill="url(#gKnob)" stroke="#111" stroke-width=".6"/>${Array.from({ length: 20 }, (_, k) => `<line x1="38" y1="-62" x2="38" y2="-60.4" stroke="#000a" stroke-width=".7" transform="rotate(${k * 18} 38 -52)"/>`).join('')}<rect x="37" y="-60" width="2" height="6" rx="1" fill="#f2f2f2"/></g><text x="38" y="-37" font-size="4.4" fill="#333" text-anchor="middle" pointer-events="none">VOLTAGE</text>`;
      s += `<circle cx="0" cy="-20" r="4.5" fill="#c62828" stroke="#600" stroke-width=".6"/><circle cx="30" cy="-20" r="4.5" fill="#222" stroke="#000" stroke-width=".6"/><circle cx="0" cy="-20" r="1.6" fill="url(#aGold)"/><circle cx="30" cy="-20" r="1.6" fill="url(#aGold)"/>`;
      return s + dots(this.pins(p)) + `<text x="-6" y="9" class="plbl small">+</text><text x="36" y="9" class="plbl small">−</text>`;
    },
    stamp(p, cx) { const st = cx.state(p), vs = this.vset(p); if (st.vout === undefined || st.vset !== vs) { st.vout = vs; st.vset = vs; } cx.add({ kind: 'V', a: cx.node(p, '+'), b: cx.node(p, '-'), v: st.vout, rs: 0.01, main: true }, p); },
    measure(p, cx) {   // CC regulation: when the load wants more than ilim, fold the output voltage back (one step per frame)
      const e = cx.main(p), st = cx.state(p); if (!e) return; const vs = this.vset(p), lim = Math.max(0.001, +p.props.ilim || 0.5), i = Math.abs(cx.I(e));
      let v = e.v;
      if (i > lim * 1.002) v = Math.max(0, v * (0.25 + 0.75 * lim / i)); else if (v < vs) v = Math.min(vs, v + Math.max(0.05, (vs - v) * 0.5) * (i < lim * 0.98 ? 1 : 0.1));
      if (v !== e.v) { e.v = v; }
      st.vout = v; st.vset = vs; st.iout = i; st.cc = v < vs - 0.01;
    },
    wheel(p, d) { p.props.pos = Math.min(1, Math.max(0, +p.props.pos - d * (0.5 / (+p.props.vmax || 30)))); return true; },
    readout(p, cx) { const st = cx.state(p); return `${fmt(st.vout || 0, 'V')} · ${fmt(st.iout || 0, 'A')}${st.cc ? ' · CC (current limit)' : ' · CV'}`; },
    warn(p, cx) { const st = cx.state(p); if (st.cc) return `bench supply in current limit (${fmt(+p.props.ilim, 'A')}) — short or heavy load?`; },
  });
  // ---------- incandescent lamp ----------
  def('lamp', {
    label: 'Incandescent lamp', cat: 'Output', props: { v: 6, w: 1.2 },
    edit: [{ k: 'v', label: 'Rated voltage (V)', t: 'num' }, { k: 'w', label: 'Rated power (W)', t: 'num' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    R: (p) => { const v = +p.props.v || 6, w = +p.props.w || 1; return v * v / w; },
    svg(p, st) {
      st = st || {}; const b = st.burned ? 0 : Math.min(1, st.bright || 0);
      let s = lead(0, 0, -8) + lead(30, 0, -8);
      s += `<rect x="1" y="-16" width="28" height="9" rx="1.5" fill="url(#bCan)" stroke="#555" stroke-width=".5"/><path d="M5 -16 h20 M5 -12.5 h20" stroke="#0004" stroke-width=".8"/>`;
      if (b > 0.02) s += `<circle cx="15" cy="-34" r="${12 + 20 * b}" fill="#ffcf5a" opacity="${0.75 * b}" filter="url(#fGlow)"/>`;
      s += `<path d="M7 -16 c-9 -8 -8 -30 8 -30 c16 0 17 22 8 30 z" fill="url(#bBulb)" stroke="#8fa3b4" stroke-width=".6"/>`;
      const fc = st.burned ? '#333' : b > 0.02 ? `rgb(255,${Math.round(150 + 105 * b)},${Math.round(60 + 140 * b)})` : '#6b5a4a';
      s += `<path d="M12 -17 L12 -30 M18 -17 L18 -30" stroke="#9aa2ab" stroke-width=".7"/><path d="M12 -30 q1 -4 2 0 q1 4 2 0 q1 -4 2 0" stroke="${fc}" stroke-width="${b > 0.02 ? 1.4 : 0.9}" fill="none"${st.burned ? ' stroke-dasharray="2 2"' : ''}/>`;
      if (b > 0.02) s += `<circle cx="15" cy="-31" r="${2 + 3 * b}" fill="#fff" opacity="${0.9 * b}" filter="url(#fGlow)"/>`;
      s += `<ellipse cx="11" cy="-38" rx="3" ry="5" fill="#fff" opacity=".45" pointer-events="none"/>`;
      if (st.burned) s += smoke(15, -54);
      return s + dots(this.pins(p)) + `<text x="15" y="-50" class="plbl">${esc(p.props.v)}V ${esc(p.props.w)}W</text>`;
    },
    stamp(p, cx) { if (cx.state(p).burned) return; cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: this.R(p), main: true }, p); },
    measure(p, cx, dt) {
      const e = cx.main(p), st = cx.state(p); if (!e) { st.bright = 0; st.pw = 0; return; }
      const i = cx.I(e), pw = i * i * e.r, rated = +p.props.w || 1; st.i = i; st.pw = pw;
      st.bright = Math.pow(Math.min(2, pw / rated), 0.6);
      st.over = pw > rated * 2.2 ? (st.over || 0) + dt : 0;
      if (st.over > 0.3) { st.burned = true; cx.log(`💥 ${p.id} filament blew (${fmt(pw, 'W')} on a ${rated} W lamp)`); }
    },
    readout(p, cx) { const st = cx.state(p); return st.burned ? 'FILAMENT BLOWN (press Run to reset)' : `${fmt(Math.abs(st.i || 0), 'A')} · ${fmt(st.pw || 0, 'W')}`; },
    warn(p, cx) { const st = cx.state(p); if (st.burned) return 'lamp filament blown — over-voltage'; if ((st.pw || 0) > (+p.props.w || 1) * 1.3) return 'lamp over-driven (above rated power)'; },
  });
  // ---------- DC motor (armature R + back-EMF that builds up with speed) ----------
  def('motor', {
    label: 'DC motor (hobby)', cat: 'Output', props: { v: 3, r: 8 }, dynamic: true,
    edit: [{ k: 'v', label: 'Rated voltage (V)', t: 'num' }, { k: 'r', label: 'Winding R (Ω)', t: 'num' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      st = st || {}; const ang = st.ang || 0, w = st.w || 0;
      let s = wireLead(0, 0, -10, '#d32f2f') + wireLead(30, 0, -10, '#222');
      s += `<rect x="-6" y="-44" width="42" height="34" rx="9" fill="url(#bCan)" stroke="#555" stroke-width=".6" filter="url(#fShadow)"/><rect x="-6" y="-44" width="9" height="34" rx="3" fill="#e0e3e6" stroke="#777" stroke-width=".5"/><rect x="0" y="-16" width="4" height="5" fill="url(#bCopper)"/><rect x="26" y="-16" width="4" height="5" fill="url(#bCopper)"/>`;
      s += `<rect x="36" y="-28.5" width="9" height="3" fill="#ccc"/><g transform="rotate(${ang.toFixed(1)} 50 -27)"><rect x="46" y="-40" width="8" height="26" rx="2" fill="#e53935" stroke="#7a1713" stroke-width=".5"/><circle cx="50" cy="-27" r="2.5" fill="#333"/></g>`;
      if (Math.abs(w) > 0.05) s += `<path d="M58 -40 a16 16 0 0 1 0 26" stroke="#4ae0ff" stroke-width="1.2" fill="none" opacity="${Math.min(1, Math.abs(w))}"/>`;
      return s + dots(this.pins(p)) + `<text x="15" y="-48" class="plbl">${Math.round(Math.abs(w) * 6000)} rpm</text>`;
    },
    stamp(p, cx) {
      const st = cx.state(p), r = Math.max(0.1, +p.props.r || 8), emf = 0.85 * (+p.props.v || 3) * (st.w || 0);
      cx.add({ kind: 'G', a: cx.node(p, '+'), b: cx.node(p, '-'), g: 1 / r, main: true }, p);
      st._src = cx.add({ kind: 'I', a: cx.node(p, '+'), b: cx.node(p, '-'), i: -emf / r }, p);
    },
    measure(p, cx, dt) {
      const e = cx.main(p), st = cx.state(p); if (!e) return; const r = 1 / e.g, vr = +p.props.v || 3;
      const v = cx.V(e.a) - cx.V(e.b), emf = 0.85 * vr * (st.w || 0), i = (v - emf) / r; st.i = i;
      const target = v / (0.85 * vr) * (1 - 0.06), k = 1 - Math.exp(-dt / 0.35);   // speed settles with τ ≈ 0.35 s (small friction load)
      st.w = (st.w || 0) + (target - (st.w || 0)) * k;
      if (st._src) st._src.i = -0.85 * vr * st.w / r;
      st.ang = ((st.ang || 0) + st.w * 360 * 4 * dt) % 360;
    },
    readout(p, cx) { const st = cx.state(p); return `${fmt(Math.abs(st.i || 0), 'A')} · ${Math.round(Math.abs(st.w || 0) * 6000)} rpm`; },
    warn(p, cx) { const st = cx.state(p); if (Math.abs(st.i || 0) > 1.5) return 'motor stall current > 1.5 A'; },
  });
  // ---------- SPST toggle switch ----------
  def('toggle', {
    label: 'Toggle switch (SPST)', cat: 'Input', props: { on: false, label: '' },
    edit: [{ k: 'on', label: 'On', t: 'bool' }, { k: 'label', label: 'Label', t: 'text' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p) {
      const on = !!p.props.on;
      let s = lead(0, 0, -6) + lead(20, 0, -6);
      s += `<rect x="-6" y="-20" width="32" height="14" rx="2" fill="#26292e" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/><circle cx="10" cy="-13" r="5" fill="url(#aShield)" stroke="#555" stroke-width=".5"/>`;
      s += `<line x1="10" y1="-13" x2="${on ? 18 : 2}" y2="-30" stroke="#d9dde2" stroke-width="3.2" stroke-linecap="round"/><circle cx="${on ? 18 : 2}" cy="-30" r="2.6" fill="#f2f2f2" stroke="#888" stroke-width=".5"/>`;
      return s + dots(this.pins(p)) + `<text x="10" y="-35" class="plbl" style="fill:${on ? '#2e9e4f' : '#c62828'}">${on ? 'ON' : 'OFF'}${p.props.label ? ' · ' + esc(p.props.label) : ''}</text>`;
    },
    stamp(p, cx) { if (p.props.on) cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 0.02, main: true }, p); },
    click(p) { p.props.on = !p.props.on; return true; },
  });
  // ---------- digital multimeter (V / A / Ω) ----------
  const MODES = ['V', 'A', 'Ω'];
  def('multimeter', {
    label: 'Digital multimeter (V/A/Ω)', cat: 'Instruments', props: { mode: 'V' },
    edit: [{ k: 'mode', label: 'Mode (click meter to cycle)', t: 'sel', opts: MODES }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: 'COM', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      const m = p.props.mode || 'V', txt = st && st.txt ? st.txt : '----', a = { V: -40, A: 40, 'Ω': 0 }[m];
      let s = wireLead(0, 0, -10, '#d32f2f') + wireLead(30, 0, -10, '#222');
      s += `<rect x="-14" y="-92" width="58" height="82" rx="7" fill="url(#bDmm)" stroke="#8a6a00" stroke-width=".7" filter="url(#fShadow)"/><rect x="-10" y="-88" width="50" height="74" rx="5" fill="#2b2d31"/>`;
      s += `<rect x="-6" y="-84" width="42" height="18" rx="2" fill="#a9b89a" stroke="#000" stroke-width=".5"/><text x="34" y="-70" font-size="10" fill="#1a1d17" text-anchor="end" font-family="ui-monospace,Menlo,monospace" pointer-events="none">${esc(txt)}</text>`;
      s += `<g transform="rotate(${a} 15 -46)"><circle cx="15" cy="-46" r="11" fill="#1a1b1e" stroke="#555" stroke-width=".6"/><rect x="13.6" y="-58" width="2.8" height="12" rx="1" fill="#f2f2f2"/></g>`;
      s += `<text x="1" y="-56" font-size="5.5" fill="${m === 'V' ? '#ffd23f' : '#aaa'}" text-anchor="middle" pointer-events="none">V⎓</text><text x="15" y="-60" font-size="5.5" fill="${m === 'Ω' ? '#ffd23f' : '#aaa'}" text-anchor="middle" pointer-events="none">Ω</text><text x="29" y="-56" font-size="5.5" fill="${m === 'A' ? '#ffd23f' : '#aaa'}" text-anchor="middle" pointer-events="none">A</text>`;
      s += `<circle cx="0" cy="-22" r="4" fill="#c62828"/><circle cx="30" cy="-22" r="4" fill="#111" stroke="#555" stroke-width=".5"/><text x="0" y="-28" font-size="4" fill="#ddd" text-anchor="middle">VΩA</text><text x="30" y="-28" font-size="4" fill="#ddd" text-anchor="middle">COM</text>`;
      return s + dots(this.pins(p));
    },
    stamp(p, cx) {
      const a = cx.node(p, '+'), b = cx.node(p, 'COM'), m = p.props.mode || 'V';
      if (m === 'A') cx.add({ kind: 'V', a, b, v: 0, rs: 0.05, main: true }, p);   // 50 mΩ shunt
      else if (m === 'Ω') cx.add({ kind: 'V', a, b, v: 1, rs: 1000, main: true }, p);   // 1 V through 1 kΩ: Rx = 1k·Vm/(1−Vm)
      else cx.add({ kind: 'G', a, b, g: 1e-7, main: true }, p);   // 10 MΩ input
    },
    measure(p, cx) {
      const e = cx.main(p), st = cx.state(p); if (!e) return; const m = p.props.mode || 'V', vm = cx.V(e.a) - cx.V(e.b);
      if (m === 'A') { const i = cx.I(e); st.val = i; st.txt = fmt(i, 'A'); }
      else if (m === 'Ω') { const r = vm >= 0.9999 ? Infinity : 1000 * vm / (1 - vm); st.val = r; st.txt = !isFinite(r) || r > 20e6 || r < 0 ? 'O.L' : fmt(r, 'Ω'); }
      else { st.val = vm; st.txt = fmt(vm, 'V'); }
    },
    click(p) { p.props.mode = MODES[(MODES.indexOf(p.props.mode) + 1) % MODES.length]; return true; },
    readout(p, cx) { const st = cx.state(p); return `${p.props.mode} mode: ${st.txt || '—'}`; },
    warn(p, cx) { const e = cx.main(p); if (e && p.props.mode === 'A' && Math.abs(cx.I(e)) > 2) return 'multimeter in A mode across a supply — blown fuse!'; if (e && p.props.mode === 'Ω' && Math.abs(cx.I(e)) > 0.0015) return 'Ω mode on a live circuit — reading is meaningless'; },
  });
  // ---------- resistor burn-out (> 2.5× rated power for 0.5 s) ----------
  const R0 = T.resistor, rSvg = R0.svg, rStamp = R0.stamp, rReadout = R0.readout, rWarn = R0.warn;
  R0.props = Object.assign({ w: 0.25 }, R0.props);
  if (!R0.edit.some((q) => q.k === 'w')) R0.edit = [...R0.edit, { k: 'w', label: 'Power rating (W)', t: 'num' }];
  R0.svg = function (p, st) {
    let s = rSvg.call(this, p, st);
    if (st && st.burned) s += `<rect x="8" y="-6" width="24" height="12" rx="3" fill="#1a1410" opacity=".85"/><path d="M14 -3 l3 4 l2 -5 l3 5" stroke="#ff6a1a" stroke-width=".8" fill="none"/>` + smoke(20, -14);
    else if (st && st.hot > 0.05) s += `<rect x="7" y="-7" width="26" height="14" rx="4" fill="#ff5a1a" opacity="${Math.min(0.6, st.hot * 0.6)}" filter="url(#fGlow)" pointer-events="none"/>`;
    return s;
  };
  R0.stamp = function (p, cx) { if (cx.state(p).burned) return; return rStamp.call(this, p, cx); };
  R0.measure = function (p, cx, dt) {
    const e = cx.main(p), st = cx.state(p); if (!e) return; const i = cx.I(e), pw = i * i * e.r, rate = +p.props.w || 0.25;
    st.hot = pw / rate > 1 ? Math.min(1, (pw / rate - 1) / 2) : 0;
    st.over = pw > rate * 2.5 ? (st.over || 0) + dt : 0;
    if (st.over > 0.5) { st.burned = true; cx.log(`💥 ${p.id} burned open (${fmt(pw, 'W')} in a ${rate} W resistor)`); }
  };
  R0.readout = function (p, cx) { return cx.state(p).burned ? 'BURNED OPEN (press Run to reset)' : rReadout.call(this, p, cx); };
  R0.warn = function (p, cx) {
    const msgs = [];
    const st = cx.state(p);
    if (st.burned) msgs.push('resistor burned open — too much power');
    else {
      const e = cx.main(p);
      if (e) { const i = cx.I(e), pw = i * i * e.r, rate = +p.props.w || 0.25; if (pw > rate) msgs.push(`resistor over its ${rate} W rating (${fmt(pw, 'W')}) — getting hot`); }
    }
    const base = rWarn ? rWarn.call(this, p, cx) : '';
    if (base) msgs.push(base);
    return msgs.join('; ') || undefined;
  };

  // ======================= example projects =======================
  const E = root.Examples; if (!E) return;
  let uid = 0;
  const part = (type, x, y, props = {}, rot = 0, pid) => ({ id: pid || type.slice(0, 3) + (++uid), type, x, y, rot, props: Object.assign({}, T[type].props, props) });
  const pin = (p, name) => { const q = T[p.type].pins(p).find((z) => z.name === name); if (!q) throw new Error('no pin ' + name + ' on ' + p.type); return P.pinWorld(p, q); };
  const pt = (x, y) => ({ x, y });
  let wid = 0;
  const path = (color, ...q) => ({ id: 'bw' + (++wid), a: { x: q[0].x, y: q[0].y }, b: { x: q[q.length - 1].x, y: q[q.length - 1].y }, pts: q.slice(1, -1).map((z) => ({ x: z.x, y: z.y })), color });
  const proj = (name, parts, wires, notes) => ({ name, mode: 'circuit', code: '// Basic circuit — no ESP32, no code. Press Run (or just interact): the circuit is simulated live.\n', parts, wires, notes });
  const CAT = 'Basic circuits (no ESP32)';

  E.EX.b_led = () => {
    const bat = part('battery9v', 100, 320, {}, 0, 'BAT1'), r = part('resistor', 160, 200, { r: 470 }, 0, 'R1'), led = part('led', 240, 200, { color: 'red' }, 0, 'LED1'), dmm = part('multimeter', 300, 330, { mode: 'A' }, 0, 'DMM1');
    return proj('LED + resistor on a 9 V battery', [bat, r, led, dmm], [
      path('red', pin(bat, '+'), pt(100, 200), pin(r, '1')),
      path('orange', pin(r, '2'), pin(led, 'A')),
      path('blue', pin(led, 'C'), pt(300, 200), pin(dmm, '+')),
      path('black', pin(dmm, 'COM'), pt(330, 350), pt(120, 350), pin(bat, '-')),
    ], 'The classic first circuit: 9 V → 470 Ω → red LED. I = (9 − 1.9) / 470 ≈ 15 mA, shown on the multimeter (A mode, in series). Change R1 to 47 Ω and the LED burns out (press Run to repair). Click the meter to cycle V/A/Ω.');
  };
  E.EX.b_series = () => {
    const bat = part('aapack', 100, 420, { n: 3 }, 0, 'BAT1');
    const r1 = part('resistor', 160, 150, { r: 100 }, 0, 'R1'), l1 = part('led', 240, 150, { color: 'red' }, 0, 'LED1'), l2 = part('led', 280, 150, { color: 'red' }, 0, 'LED2');
    const r2 = part('resistor', 160, 250, { r: 150 }, 0, 'R2'), l3 = part('led', 240, 250, { color: 'green', vf: 2.1 }, 0, 'LED3');
    const r3 = part('resistor', 160, 320, { r: 150 }, 0, 'R3'), l4 = part('led', 240, 320, { color: 'green', vf: 2.1 }, 0, 'LED4');
    return proj('Series vs parallel LEDs', [bat, r1, l1, l2, r2, l3, r3, l4], [
      path('red', pin(bat, '+'), pt(100, 320)), path('red', pt(100, 320), pt(100, 250)), path('red', pt(100, 250), pt(100, 150), pin(r1, '1')),
      path('red', pt(100, 250), pin(r2, '1')), path('red', pt(100, 320), pin(r3, '1')),
      path('orange', pin(r1, '2'), pin(l1, 'A')), path('orange', pin(l1, 'C'), pin(l2, 'A')), path('blue', pin(l2, 'C'), pt(340, 150), pt(340, 250)),
      path('orange', pin(r2, '2'), pin(l3, 'A')), path('blue', pin(l3, 'C'), pt(340, 250)),
      path('orange', pin(r3, '2'), pin(l4, 'A')), path('blue', pin(l4, 'C'), pt(340, 320)),
      path('black', pt(340, 250), pt(340, 320)), path('black', pt(340, 320), pt(340, 440), pt(140, 440), pin(bat, '-')),
    ], '4.5 V (3×AA). Top: two red LEDs in SERIES share one current and need 2×1.9 V, leaving only ~0.8 V for R1 → dim (≈ 7 mA). Bottom: two green LEDs in PARALLEL, each with its own 150 Ω resistor → each gets ≈ 16 mA and glows bright. Hover the parts for their currents.');
  };
  E.EX.b_lamp = () => {
    const bat = part('aapack', 100, 420, { n: 4 }, 0, 'BAT1'), btn = part('pushbutton', 160, 200, { color: 'green', label: 'PUSH', key: 'l' }, 0, 'SW1'), lamp = part('lamp', 240, 200, { v: 6, w: 1.2 }, 0, 'LAMP1');
    const tg = part('toggle', 160, 320, { label: 'motor' }, 0, 'SW2'), mot = part('motor', 240, 320, { v: 6, r: 12 }, 0, 'M1');
    return proj('Pushbutton lamp + switched motor', [bat, btn, lamp, tg, mot], [
      path('red', pin(bat, '+'), pt(100, 320)), path('red', pt(100, 320), pt(100, 200), pin(btn, '1.l')), path('red', pt(100, 320), pin(tg, '1')),
      path('orange', pin(btn, '2.l'), pin(lamp, '1')), path('orange', pin(tg, '2'), pin(mot, '+')),
      path('black', pin(lamp, '2'), pt(340, 200), pt(340, 320)), path('black', pin(mot, '-'), pt(340, 320)), path('black', pt(340, 320), pt(340, 440), pt(140, 440), pin(bat, '-')),
    ], '6 V (4×AA). Hold the green pushbutton (or the L key) to light the 6 V / 1.2 W lamp (200 mA). Click the toggle switch to start the DC motor — watch the start-up current spike and fall as back-EMF builds with speed. Set the pack to a 9 V battery-sized lamp mismatch (lamp V = 3) to blow the filament.');
  };
  E.EX.b_dimmer = () => {
    const bat = part('battery9v', 100, 370, {}, 0, 'BAT1'), pot = part('potentiometer', 160, 200, { r: 4700, pos: 0.06 }, 0, 'POT1'), r = part('resistor', 220, 240, { r: 330 }, 0, 'R1'), led = part('led', 300, 240, { color: 'blue', vf: 3.0 }, 0, 'LED1'), dmm = part('multimeter', 330, 300, { mode: 'A' }, 0, 'DMM1');
    return proj('Potentiometer LED dimmer', [bat, pot, r, led, dmm], [
      path('red', pin(bat, '+'), pt(100, 200), pin(pot, '1')),
      path('orange', pin(pot, 'W'), pt(170, 240), pin(r, '1')),
      path('orange', pin(r, '2'), pin(led, 'A')),
      path('blue', pin(led, 'C'), pt(330, 240), pin(dmm, '+')),
      path('black', pin(dmm, 'COM'), pt(380, 300), pt(380, 390), pt(120, 390), pin(bat, '-')),
    ], 'The 4.7 kΩ pot is wired as a variable resistor (pin 1 + wiper) in series with 330 Ω and a blue LED. Drag the knob (or scroll on it) — brightness and the multimeter current change live, from ≈ 18 mA down to ≈ 1 mA. R1 stops the LED burning out at the end stop.');
  };
  E.EX.b_night = () => {
    const bat = part('battery9v', 100, 470, {}, 0, 'BAT1'), r1 = part('resistor', 200, 150, { r: 47000 }, 1, 'R1'), ldr = part('ldr', 200, 250, { lux: 5 }, 1, 'LDR1');
    const q = part('npn', 300, 300, { bf: 200 }, 3, 'Q1'), led = part('led', 300, 220, { color: 'white', vf: 3.0 }, 1, 'LED1'), rc = part('resistor', 300, 160, { r: 330 }, 1, 'RC'), btn = part('pushbutton', 400, 170, { color: 'blue', label: 'TEST', key: 't' }, 1, 'SW1'), rb = part('resistor', 400, 210, { r: 1000 }, 1, 'RB');
    return proj('Transistor night-light (LDR) + test button', [bat, r1, ldr, q, led, rc, btn, rb], [
      path('red', pin(bat, '+'), pt(100, 120)), path('red', pt(100, 120), pt(200, 120)), path('red', pt(200, 120), pin(r1, '1')), path('red', pt(200, 120), pt(300, 120)), path('red', pt(300, 120), pin(rc, '1')), path('red', pt(300, 120), pt(400, 120), pin(btn, '1.l')),
      path('orange', pin(r1, '2'), pin(ldr, '1')), path('orange', pin(r1, '2'), pt(250, 190), pt(250, 290), pin(q, 'B')),
      path('orange', pin(btn, '2.l'), pin(rb, '1')), path('orange', pin(rb, '2'), pt(400, 290), pin(q, 'B')),
      path('orange', pin(rc, '2'), pin(led, 'A')), path('blue', pin(led, 'C'), pin(q, 'C')),
      path('black', pin(ldr, '2'), pt(200, 340)), path('black', pin(q, 'E'), pt(300, 340), pt(200, 340)), path('black', pt(200, 340), pt(120, 340), pin(bat, '-')),
    ], 'An NPN 2N2222 used as a switch. R1 (47 kΩ) and the LDR form a divider on the base: in the dark the LDR is ~50 kΩ, the base rises above 0.7 V and the transistor saturates, lighting the white LED. Drag the LDR light slider (Inspector) up to a few hundred lux and the LED turns off. The blue TEST button (T key) forces the base on through RB (1 kΩ).');
  };
  E.EX.b_rcfade = () => {
    const bat = part('battery9v', 100, 470, {}, 0, 'BAT1'), btn = part('pushbutton', 160, 150, { color: 'red', label: 'CHARGE', key: 'c' }, 0, 'SW1'), r1 = part('resistor', 200, 150, { r: 100 }, 0, 'R1');
    const c = part('capacitor', 260, 200, { c: 220e-6, kind: 'electrolytic' }, 1, 'C1'), rb = part('resistor', 280, 150, { r: 10000 }, 0, 'RB'), q = part('npn', 400, 300, {}, 3, 'Q1'), led = part('led', 400, 220, { color: 'yellow', vf: 2.0 }, 1, 'LED1'), rc = part('resistor', 400, 160, { r: 470 }, 1, 'RC'), sc = part('scope', 260, 130, { ch: 1 }, 0, 'CH1');
    return proj('RC delay: LED fade-off timer', [bat, btn, r1, c, rb, q, led, rc, sc], [
      path('red', pin(bat, '+'), pt(100, 150)), path('red', pt(100, 150), pin(btn, '1.l')), path('red', pt(100, 150), pt(100, 100), pt(400, 100), pin(rc, '1')),
      path('orange', pin(btn, '2.l'), pin(r1, '1')), path('orange', pin(r1, '2'), pt(260, 150)), path('orange', pt(260, 150), pin(c, '+')), path('orange', pt(260, 150), pin(rb, '1')), path('yellow', pin(sc, 'P'), pt(260, 150)),
      path('orange', pin(rb, '2'), pt(340, 150), pt(340, 290), pin(q, 'B')),
      path('orange', pin(rc, '2'), pin(led, 'A')), path('blue', pin(led, 'C'), pin(q, 'C')),
      path('black', pin(c, '-'), pt(260, 340)), path('black', pin(q, 'E'), pt(400, 340), pt(260, 340)), path('black', pt(260, 340), pt(120, 340), pin(bat, '-')),
    ], 'Tap the red CHARGE button (C key): C1 (220 µF) charges to 9 V through 100 Ω almost instantly. After release it discharges through RB (10 kΩ) into the transistor base — the LED stays on for a few seconds, then fades out smoothly as the capacitor voltage falls below ~1.5 V. Scope CH1 shows the capacitor voltage (τ = RB·C ≈ 2.2 s).');
  };
  E.EX.b_blink = () => {
    const bat = part('battery9v', 100, 520, {}, 0, 'BAT1');
    const rb1 = part('resistor', 150, 180, { r: 47000 }, 1, 'RB1'), rc1 = part('resistor', 200, 180, { r: 470 }, 1, 'RC1'), l1 = part('led', 200, 250, { color: 'red' }, 1, 'LED1'), q1 = part('npn', 200, 350, {}, 3, 'Q1');
    const rb2 = part('resistor', 340, 180, { r: 56000 }, 1, 'RB2'), rc2 = part('resistor', 400, 180, { r: 470 }, 1, 'RC2'), l2 = part('led', 400, 250, { color: 'green', vf: 2.1 }, 1, 'LED2'), q2 = part('npn', 400, 350, {}, 3, 'Q2');
    const c1 = part('capacitor', 260, 300, { c: 22e-6, kind: 'electrolytic' }, 0, 'C1'), c2 = part('capacitor', 380, 400, { c: 22e-6, kind: 'electrolytic' }, 2, 'C2');
    return proj('Two-transistor LED flasher (555-free astable)', [bat, rb1, rc1, l1, q1, rb2, rc2, l2, q2, c1, c2], [
      path('red', pin(bat, '+'), pt(100, 150), pt(150, 150)), path('red', pt(150, 150), pin(rb1, '1')), path('red', pt(150, 150), pt(200, 150)), path('red', pt(200, 150), pin(rc1, '1')),
      path('red', pt(200, 150), pt(340, 150)), path('red', pt(340, 150), pin(rb2, '1')), path('red', pt(340, 150), pt(400, 150)), path('red', pt(400, 150), pin(rc2, '1')),
      path('orange', pin(rc1, '2'), pin(l1, 'A')), path('blue', pin(l1, 'C'), pin(q1, 'C')), path('orange', pin(rc2, '2'), pin(l2, 'A')), path('blue', pin(l2, 'C'), pin(q2, 'C')),
      path('blue', pin(q1, 'C'), pt(230, 330), pt(230, 300), pin(c1, '+')), path('green', pin(c1, '-'), pt(340, 300)), path('green', pt(340, 300), pt(340, 340), pin(q2, 'B')), path('green', pin(rb2, '2'), pt(340, 300)),
      path('blue', pin(q2, 'C'), pt(420, 330), pt(420, 400), pin(c2, '+')), path('green', pin(c2, '-'), pt(150, 400), pt(150, 340)), path('green', pin(rb1, '2'), pt(150, 340)), path('green', pt(150, 340), pin(q1, 'B')),
      path('black', pin(q1, 'E'), pt(200, 450)), path('black', pin(q2, 'E'), pt(400, 450), pt(200, 450)), path('black', pt(200, 450), pt(120, 450), pin(bat, '-')),
    ], 'A classic astable multivibrator — no 555, no microcontroller. Each transistor\'s collector is cross-coupled to the other\'s base through a 22 µF capacitor; the caps recharge through RB1/RB2 (47 k / 56 k), so the two LEDs alternate about once a second (t ≈ 0.69·R·C). Change C1/C2 to speed it up or slow it down.');
  };
  E.EX.b_divider = () => {
    const ps = part('bench', 100, 400, { pos: 0.3, ilim: 0.2 }, 0, 'PSU1'), r1 = part('resistor', 160, 200, { r: 10000 }, 0, 'R1'), r2 = part('resistor', 240, 200, { r: 4700 }, 0, 'R2'), dmm = part('multimeter', 240, 330, { mode: 'V' }, 0, 'DMM1');
    const r3 = part('resistor', 420, 200, { r: 1000 }, 0, 'R3'), dmm2 = part('multimeter', 420, 330, { mode: 'Ω' }, 0, 'DMM2');
    return proj('Voltage divider + multimeter', [ps, r1, r2, dmm, r3, dmm2], [
      path('red', pin(ps, '+'), pt(100, 200), pin(r1, '1')), path('orange', pin(r1, '2'), pin(r2, '1')),
      path('black', pin(r2, '2'), pt(340, 200), pt(340, 420), pt(130, 420), pin(ps, '-')),
      path('red', pin(r2, '1'), pin(dmm, '+')), path('black', pin(dmm, 'COM'), pt(280, 330), pin(r2, '2')),
      path('red', pin(r3, '1'), pin(dmm2, '+')), path('black', pin(dmm2, 'COM'), pt(460, 330), pin(r3, '2')),
    ], 'Adjustable bench supply (drag or scroll its knob) feeds R1 = 10 kΩ over R2 = 4.7 kΩ. DMM1 (V mode) reads Vout = Vin · 4.7 / 14.7 — at 9 V that is 2.88 V. DMM2 in Ω mode measures the loose 1 kΩ resistor R3 (out of circuit, as on a real bench). Click a meter to cycle V → A → Ω.');
  };
  E.EX.b_coin = () => {
    const cc = part('coincell', 120, 260, {}, 0, 'BAT1'), led = part('led', 200, 200, { color: 'blue', vf: 3.0 }, 0, 'LED1'), tg = part('toggle', 120, 200, {}, 0, 'SW1');
    return proj('Coin-cell LED throwie (no resistor)', [cc, led, tg], [
      path('red', pin(cc, '+'), pt(110, 260), pt(110, 200), pin(tg, '1')), path('orange', pin(tg, '2'), pin(led, 'A')), path('black', pin(led, 'C'), pt(210, 280), pt(140, 280), pin(cc, '-')),
    ], 'A CR2032 can drive a blue LED with no resistor because its ~15 Ω internal resistance limits the current — click the toggle. Swap the coin cell for the 9 V battery and the LED burns out instantly.');
  };
  const add = [['b_led', 'LED + resistor (9 V battery)'], ['b_series', 'Series vs parallel LEDs'], ['b_lamp', 'Pushbutton lamp + switched motor'], ['b_dimmer', 'Potentiometer LED dimmer'], ['b_night', 'Transistor night-light (LDR + button)'], ['b_rcfade', 'RC delay LED fade-off'], ['b_blink', 'Two-transistor LED flasher (no 555)'], ['b_divider', 'Voltage divider + multimeter'], ['b_coin', 'Coin-cell LED (no resistor)']];
  const at = E.LIST.findIndex((x) => x[0] === 'blank');
  E.LIST.splice(at < 0 ? E.LIST.length : at, 0, ...add.map(([k, n]) => [k, n, CAT]));
  E.BASIC_CAT = CAT;
})(typeof window !== 'undefined' ? window : globalThis);
