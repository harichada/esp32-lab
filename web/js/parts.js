/* Part catalog: geometry (pins on a 10 px = 0.1" grid), SVG rendering, and circuit stamping. */
(function (root) {
  const G = 10;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const VTH = 1.65;

  // ---------- value formatting ----------
  function fmt(v, unit) {
    if (v === undefined || v === null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const P = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
    if (a === 0) return '0 ' + unit;
    for (const [m, p] of P) if (a >= m * 0.9999) { const t = (v / m).toPrecision(3); return (t.includes('.') ? t.replace(/\.?0+$/, '') : t) + ' ' + p + unit; }
    return v.toExponential(2) + ' ' + unit;
  }
  function parseVal(s) {
    if (typeof s === 'number') return s;
    const m = String(s).trim().match(/^([0-9.]+(?:e-?\d+)?)\s*([pnuµmkKMG]?)/);
    if (!m) return NaN;
    const mult = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[m[2]];
    return parseFloat(m[1]) * mult;
  }
  // Parse a user-entered part value. Non-finite / empty / unparseable input
  // falls back to `fallback` and sets ok=false so the part can warn.
  // Zero is kept as zero — callers that need a tiny wire resistance use stampResistance.
  function parseProp(raw, fallback) {
    if (raw === '' || raw === undefined || raw === null) return { value: fallback, ok: false };
    const v = typeof raw === 'number' ? raw : parseVal(raw);
    if (!isFinite(v)) return { value: fallback, ok: false };
    return { value: v, ok: true };
  }
  const WIRE_R = 1e-3;   // 1 mΩ: a 0 Ω entry is stamped as a tiny ideal wire, not as 1 Ω
  function stampResistance(raw, fallback) {
    const p = parseProp(raw, fallback);
    if (p.ok && p.value === 0) return { value: WIRE_R, ok: true, wire: true };
    return { value: p.value, ok: p.ok, wire: false };
  }
  // Oscilloscope probe channel: always 1..4. Non-numeric values fall back to 1.
  function scopeChannel(ch) {
    const n = Math.round(Number(ch));
    return Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : 1;
  }
  function invalidValueWarning(kind, raw, fallback, unit) {
    return `invalid ${kind} ${JSON.stringify(raw)}, using ${fmt(fallback, unit)}`;
  }
  // resistor colour bands (4-band)
  const BANDC = ['#000', '#8b4513', '#e02020', '#ff8c00', '#f5d000', '#20a020', '#2050e0', '#9030c0', '#888', '#fff'];
  function bands(r) {
    if (!(r > 0)) return ['#000', '#000', '#000', '#c9a227'];
    let e = Math.floor(Math.log10(r)) - 1; let d = Math.round(r / Math.pow(10, e));
    if (d >= 100) { d = Math.round(d / 10); e++; }
    const mult = e >= 0 ? BANDC[e] || '#fff' : (e === -1 ? '#c9a227' : '#c0c0c0');
    return [BANDC[Math.floor(d / 10)], BANDC[d % 10], mult, '#c9a227'];
  }
  const LEDCOL = { red: ['#ff2a2a', 1.9], green: ['#22dd44', 2.1], yellow: ['#ffd500', 2.0], blue: ['#3a7bff', 3.0], white: ['#f4f4ff', 3.0], orange: ['#ff8a1a', 2.0] };

  // ---------- ESP32 DevKit V1 (30 pin) ----------
  // Horizontal: top header (y=0) left->right, bottom header (y=90) left->right. USB at the left end.
  const ESP_TOP = ['VIN', 'GND.2', 'D13', 'D12', 'D14', 'D27', 'D26', 'D25', 'D33', 'D32', 'D35', 'D34', 'VN', 'VP', 'EN'];
  const ESP_BOT = ['3V3', 'GND.1', 'D15', 'D2', 'D4', 'RX2', 'TX2', 'D5', 'D18', 'D19', 'D21', 'RX0', 'TX0', 'D22', 'D23'];
  const ESP_GPIO = { VP: 36, VN: 39, RX2: 16, TX2: 17, RX0: 3, TX0: 1 };
  function espGpio(name) { if (ESP_GPIO[name] !== undefined) return ESP_GPIO[name]; const m = /^D(\d+)$/.exec(name); return m ? +m[1] : -1; }
  const INPUT_ONLY = new Set([34, 35, 36, 39]);
  const STRAPPING = new Set([0, 2, 5, 12, 15]);
  const ADC1 = { 36: 0, 37: 1, 38: 2, 39: 3, 32: 4, 33: 5, 34: 6, 35: 7 };
  const ADC2 = { 4: 0, 0: 1, 2: 2, 15: 3, 13: 4, 12: 5, 14: 6, 27: 7, 25: 8, 26: 9 };

  const T = {};   // type registry
  function def(type, d) { d.type = type; T[type] = d; return d; }

  // ---------- breadboard 830 ----------
  // columns 1..63 along x (pitch 10). rows a..e (y=40..80), f..j (y=110..150). rails: top − y=0, + y=10; bottom + y=180, − y=190
  const BB_ROWS = { a: 40, b: 50, c: 60, d: 70, e: 80, f: 110, g: 120, h: 130, i: 140, j: 150 };
  const BB_RAILS = { 'tn': 0, 'tp': 10, 'bp': 180, 'bn': 190 };
  function bbHoles(cols) {
    const h = [];
    for (let c = 1; c <= cols; c++) for (const r in BB_ROWS) h.push({ name: r + c, x: 10 + (c - 1) * G, y: BB_ROWS[r] });
    for (const rl in BB_RAILS) for (let c = 1; c <= cols; c++) { if ((c - 1) % 6 === 5) continue; h.push({ name: rl + c, x: 10 + (c - 1) * G, y: BB_RAILS[rl] }); }
    return h;
  }
  def('breadboard', {
    label: 'Breadboard 830', cat: 'Boards', layer: 0,
    props: { cols: 63 },
    pins: (p) => bbHoles(p.props.cols || 63),
    size: (p) => ({ w: (p.props.cols || 63) * G + 10, h: 200 }),
    groups(p) {
      const cols = p.props.cols || 63, g = [];
      for (let c = 1; c <= cols; c++) { g.push(['a', 'b', 'c', 'd', 'e'].map((r) => r + c)); g.push(['f', 'g', 'h', 'i', 'j'].map((r) => r + c)); }
      for (const rl in BB_RAILS) { const a = []; for (let c = 1; c <= cols; c++) if ((c - 1) % 6 !== 5) a.push(rl + c); g.push(a); }
      return g;
    },
    svg(p) {
      const cols = p.props.cols || 63, W = cols * G + 10;
      let s = `<rect x="-6" y="-14" width="${W + 2}" height="222" rx="6" class="bb-body" filter="url(#fShadow)"/><rect x="-6" y="-14" width="${W + 2}" height="222" rx="6" fill="url(#gGloss)" opacity=".25" pointer-events="none"/>`;
      s += `<rect x="-6" y="-14" width="${W + 2}" height="38" rx="6" class="bb-railband"/><rect x="-6" y="170" width="${W + 2}" height="38" rx="6" class="bb-railband"/>`;
      s += `<rect x="-6" y="91" width="${W + 2}" height="12" class="bb-channel"/><line x1="-6" y1="91.5" x2="${W - 4}" y2="91.5" class="bb-chedge"/><line x1="-6" y1="102.5" x2="${W - 4}" y2="102.5" class="bb-chedge2"/>`;
      s += `<rect x="4" y="-9.6" width="${W - 12}" height="1.6" rx=".8" class="rail-n"/><rect x="4" y="17.4" width="${W - 12}" height="1.6" rx=".8" class="rail-p"/>`;
      s += `<rect x="4" y="171.4" width="${W - 12}" height="1.6" rx=".8" class="rail-p"/><rect x="4" y="197.4" width="${W - 12}" height="1.6" rx=".8" class="rail-n"/>`;
      s += `<text x="${W - 4}" y="3" class="bb-lbl rail-n-t">−</text><text x="${W - 4}" y="13" class="bb-lbl rail-p-t">+</text><text x="${W - 4}" y="183" class="bb-lbl rail-p-t">+</text><text x="${W - 4}" y="193" class="bb-lbl rail-n-t">−</text>`;
      s += `<text x="-2" y="3" class="bb-lbl rail-n-t">−</text><text x="-2" y="13" class="bb-lbl rail-p-t">+</text><text x="-2" y="183" class="bb-lbl rail-p-t">+</text><text x="-2" y="193" class="bb-lbl rail-n-t">−</text>`;
      for (const h of bbHoles(cols)) s += `<rect x="${h.x - 2.5}" y="${h.y - 2.5}" width="5" height="5" rx="1" class="hole" data-pin="${h.name}"/>`;
      for (let c = 1; c <= cols; c++) if (c === 1 || c % 5 === 0) { const x = 10 + (c - 1) * G; s += `<text x="${x}" y="31" class="bb-num">${c}</text><text x="${x}" y="166" class="bb-num">${c}</text>`; }
      for (const r in BB_ROWS) s += `<text x="1" y="${BB_ROWS[r] + 2.2}" class="bb-num">${r}</text><text x="${W - 4}" y="${BB_ROWS[r] + 2.2}" class="bb-num">${r}</text>`;
      return s;
    },
  });

  def('esp32', {
    label: 'ESP32 DevKit V1', cat: 'Boards', layer: 1,
    props: { power: 'usb' },
    pins: () => [...ESP_TOP.map((n, i) => ({ name: n, x: i * G, y: 0 })), ...ESP_BOT.map((n, i) => ({ name: n, x: i * G, y: 90 }))],
    size: () => ({ w: 150, h: 110 }),
    svg(p, st) {
      let s = `<rect x="-12" y="-6" width="166" height="102" rx="4" class="esp-pcb" filter="url(#fShadow)"/><rect x="-10" y="-4" width="162" height="98" rx="3" class="esp-pcb-in"/>`;
      for (const y of [0, 90]) for (let i = 0; i < 15; i++) s += `<rect x="${i * G - 4}" y="${y - 4}" width="8" height="8" rx="1" class="esp-hdr"/>`;
      s += `<rect x="-24" y="34" width="22" height="22" rx="2" fill="url(#gUsb)" stroke="#5e656e" stroke-width=".6"/><rect x="-24" y="39" width="4" height="12" fill="#2a2f36"/><rect x="-21" y="41" width="14" height="8" rx="1" fill="#1a1d22"/>`;
      s += `<rect x="4" y="28" width="12" height="9" rx="1" class="esp-ic"/><text x="10" y="34" class="esp-t4">1117</text><rect x="20" y="20" width="14" height="14" rx="1" class="esp-ic"/><text x="27" y="29" class="esp-t4">CP2102</text>`;
      s += `<rect x="90" y="8" width="68" height="74" rx="1.5" class="esp-mod"/>`;
      s += `<rect x="94" y="13" width="48" height="64" rx="2" fill="url(#gShield)" stroke="#7d8590" stroke-width=".7" class="esp-can"/><rect x="96" y="15" width="44" height="60" rx="1.5" fill="none" stroke="#ffffff55" stroke-width=".6"/>`;
      s += `<text x="118" y="34" class="esp-can-t">ESP32-WROOM-32</text><text x="118" y="44" class="esp-can-t2">Espressif · FCC ID 2AC7Z</text><rect x="110" y="52" width="16" height="16" rx="1" fill="none" stroke="#6b737d" stroke-width=".6"/><text x="118" y="62" class="esp-can-t2">CE</text>`;
      s += `<path d="M145 14 h10 v6 h-8 v6 h8 v6 h-8 v6 h8 v6 h-8 v6 h8 v6 h-8 v6 h8 v8" class="esp-ant"/>`;
      s += `<text x="58" y="44" class="esp-t">ESP32</text><text x="58" y="55" class="esp-t2">DevKitC · 30P</text>`;
      s += `<rect x="6" y="64" width="8" height="8" rx="1" class="btn-sm"/><text x="10" y="80" class="esp-t3">EN</text><rect x="72" y="64" width="8" height="8" rx="1" class="btn-sm"/><text x="76" y="80" class="esp-t3">BOOT</text>`;
      const led2 = st && st.pinLevel ? st.pinLevel[2] : 0;
      s += `<circle cx="30" cy="68" r="2.6" class="esp-led" style="fill:${led2 ? '#4aa3ff' : '#123'}"/><circle cx="30" cy="68" r="8" style="fill:#4aa3ff;opacity:${led2 ? 0.6 : 0}" filter="url(#fGlow)" pointer-events="none"/><circle cx="46" cy="68" r="2.6" style="fill:#f33"/><circle cx="46" cy="68" r="5" style="fill:#f33;opacity:.45" filter="url(#fGlow)" pointer-events="none"/>`;
      ESP_TOP.forEach((n, i) => { s += `<rect x="${i * G - 3}" y="-3" width="6" height="6" class="pin" data-pin="${n}"/><text x="${i * G}" y="13" class="esp-pl" transform="rotate(-90 ${i * G} 13)" text-anchor="end">${n}</text>`; });
      ESP_BOT.forEach((n, i) => { s += `<rect x="${i * G - 3}" y="87" width="6" height="6" class="pin" data-pin="${n}"/><text x="${i * G}" y="78" class="esp-pl" transform="rotate(-90 ${i * G} 78)" text-anchor="start">${n}</text>`; });
      return s;
    },
    info(name) {
      const g = espGpio(name);
      if (g < 0) return name;
      const t = [`GPIO${g}`];
      if (INPUT_ONLY.has(g)) t.push('input-only (no output, no pull-ups)');
      if (STRAPPING.has(g)) t.push('strapping pin');
      if (ADC1[g] !== undefined) t.push(`ADC1_CH${ADC1[g]}`);
      if (ADC2[g] !== undefined) t.push(`ADC2_CH${ADC2[g]} (unusable while Wi-Fi on)`);
      if (g === 1 || g === 3) t.push('UART0 (USB serial)');
      return t.join(' · ');
    },
    warn(p, cx) {
      const rt = cx.esp(p), out = [];
      for (const name of [...ESP_TOP, ...ESP_BOT]) {
        const g = espGpio(name); if (g < 0) continue; const ps = rt.pin(g);
        if (!ps.out || INPUT_ONLY.has(g)) continue;
        const v = ps.pwm !== undefined ? 3.3 * ps.pwm : (ps.level ? 3.3 : 0), i = (v - cx.pinV(p, name)) / 40;
        if (Math.abs(i) > 0.04) out.push(`${name} ${Math.abs(i) > 0.06 ? 'SHORT CIRCUIT' : 'over-current'}: ${fmt(Math.abs(i), 'A')} (max 40 mA)`);
      }
      if (p.props.power === 'usb' && cx.pinV(p, '3V3') < 2.7) out.push('3V3 rail collapsed — short circuit on 3V3?');
      return out.join('; ');
    },
    stamp(p, cx) {
      const gnd = cx.node(p, 'GND.1'); cx.join(gnd, cx.node(p, 'GND.2')); cx.markGround(gnd);
      const v33 = cx.node(p, '3V3');
      if (p.props.power === 'usb') {
        cx.add({ kind: 'V', a: v33, b: gnd, v: 3.3, rs: 0.3, tag: 'esp3v3' }, p);
        cx.add({ kind: 'V', a: cx.node(p, 'VIN'), b: gnd, v: 4.7, rs: 0.5, tag: 'espvin' }, p);   // USB 5V through diode
      } else {
        cx.add({ kind: 'R', a: v33, b: gnd, r: 3.3 / 0.05, tag: 'espload' }, p);   // ~50 mA load when powered externally
      }
      cx.add({ kind: 'R', a: cx.node(p, 'EN'), b: v33, r: 10e3 }, p);
      const rt = cx.esp(p);   // runtime pin state
      for (const name of [...ESP_TOP, ...ESP_BOT]) {
        const g = espGpio(name); if (g < 0) continue;
        const nd = cx.node(p, name), ps = rt.pin(g);
        if (ps.out && !INPUT_ONLY.has(g)) {
          const v = ps.pwm !== undefined ? 3.3 * ps.pwm : (ps.level ? 3.3 : 0);
          cx.add({ kind: 'G', a: nd, b: gnd, g: 1 / 40 }, p); cx.add({ kind: 'I', a: gnd, b: nd, i: v / 40, tag: 'drv' + g }, p);
        } else {
          if (ps.pu && !INPUT_ONLY.has(g)) { cx.add({ kind: 'G', a: nd, b: gnd, g: 1 / 45e3 }, p); cx.add({ kind: 'I', a: gnd, b: nd, i: 3.3 / 45e3 }, p); }
          if (ps.pd && !INPUT_ONLY.has(g)) cx.add({ kind: 'G', a: nd, b: gnd, g: 1 / 45e3 }, p);
          cx.add({ kind: 'G', a: nd, b: gnd, g: 1e-9 }, p);
        }
      }
    },
  });

  // ---------- passives ----------
  def('resistor', {
    label: 'Resistor', cat: 'Passive', props: { r: 220 },
    edit: [{ k: 'r', label: 'Resistance (Ω)', t: 'val' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 40, y: 0 }],
    size: () => ({ w: 40, h: 10 }),
    svg(p) {
      const b = bands(parseVal(p.props.r));
      let s = `<line x1="0" y1="0" x2="40" y2="0" class="lead"/><path d="M8 -4.5 q0 -1 2 -1 h3 q2 0 3 1 h8 q1 -1 3 -1 h3 q2 0 2 1 v9 q0 1 -2 1 h-3 q-2 0 -3 -1 h-8 q-1 1 -3 1 h-3 q-2 0 -2 -1 z" fill="url(#gRes)" class="res-body" filter="url(#fShadow)"/>`;
      b.forEach((c, i) => { s += `<rect x="${11 + i * 4.6 + (i === 3 ? 3 : 0)}" y="${i === 0 || i === 3 ? -5.5 : -4.5}" width="2.4" height="${i === 0 || i === 3 ? 11 : 9}" style="fill:${c}"/>`; });
      s += `<rect x="8" y="-5.5" width="24" height="5" rx="2" fill="url(#gGloss)" opacity=".7" pointer-events="none"/>`;
      return s + pinDots(this.pins(p)) + `<text x="20" y="-8" class="plbl">${esc(fmt(parseVal(p.props.r), 'Ω'))}</text>`;
    },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: stampResistance(p.props.r, this.props.r).value, main: true }, p); },
    readout(p, cx) { const e = cx.main(p); if (!e) return ''; const i = cx.I(e); const w = i * i * e.r; return `${fmt(Math.abs(i), 'A')} · ${fmt(w, 'W')}` + (w > 0.25 ? ' ⚠ >¼W' : ''); },
    warn(p, cx) {
      const used = stampResistance(p.props.r, this.props.r);
      const msgs = [];
      if (!used.ok) msgs.push(invalidValueWarning('resistance', p.props.r, this.props.r, 'Ω'));
      const e = cx.main(p); if (e) { const i = cx.I(e); if (i * i * e.r > 0.5) msgs.push('resistor overheating (>0.5 W)'); }
      return msgs.join('; ') || undefined;
    },
  });
  def('capacitor', {
    label: 'Capacitor', cat: 'Passive', props: { c: 1e-6, kind: 'ceramic' },
    edit: [{ k: 'c', label: 'Capacitance (F)', t: 'val' }, { k: 'kind', label: 'Type', t: 'sel', opts: ['ceramic', 'electrolytic'] }],
    pins: (p) => [{ name: p.props.kind === 'electrolytic' ? '+' : '1', x: 0, y: 0 }, { name: p.props.kind === 'electrolytic' ? '-' : '2', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    svg(p) {
      const c = parseVal(p.props.c);
      if (p.props.kind === 'electrolytic') return `<line x1="0" y1="0" x2="20" y2="0" class="lead"/><rect x="1" y="-19" width="18" height="18" rx="3" class="ecap" filter="url(#fShadow)"/><rect x="14" y="-19" width="4" height="18" class="ecap-stripe"/><rect x="1" y="-19" width="18" height="8" rx="3" fill="url(#gGloss)" opacity=".5"/><path d="M4 -16 h12 M4 -4 h12" stroke="#0006" stroke-width=".6"/><text x="4" y="-6" class="ecap-t">+</text>` + pinDots(this.pins(p)) + `<text x="10" y="-21" class="plbl">${esc(fmt(c, 'F'))}</text>`;
      return `<line x1="0" y1="0" x2="20" y2="0" class="lead"/><ellipse cx="10" cy="-7" rx="7.5" ry="6.2" class="ccap" filter="url(#fShadow)"/><ellipse cx="8" cy="-9.5" rx="4" ry="2.2" fill="#fff" opacity=".35"/><text x="10" y="-5.2" class="ccap-t">${c >= 1e-6 ? '105' : c >= 1e-7 ? '104' : c >= 1e-8 ? '103' : '102'}</text>` + pinDots(this.pins(p)) + `<text x="10" y="-16" class="plbl">${esc(fmt(c, 'F'))}</text>`;
    },
    stamp(p, cx) { const ps = this.pins(p); cx.add({ kind: 'C', a: cx.node(p, ps[0].name), b: cx.node(p, ps[1].name), c: parseProp(p.props.c, this.props.c).value, main: true }, p); },
    readout(p, cx) { const e = cx.main(p); return e ? `V=${fmt(cx.V(e.a) - cx.V(e.b), 'V')}` : ''; },
    warn(p, cx) {
      const used = parseProp(p.props.c, this.props.c);
      const msgs = [];
      if (!used.ok) msgs.push(invalidValueWarning('capacitance', p.props.c, this.props.c, 'F'));
      const e = cx.main(p); if (e && p.props.kind === 'electrolytic' && cx.V(e.a) - cx.V(e.b) < -0.7) msgs.push('electrolytic reverse-biased!');
      return msgs.join('; ') || undefined;
    },
  });
  function ledDef(type, label, isIR) {
    def(type, {
      label, cat: 'Semiconductors', props: isIR ? { vf: 1.35, imax: 0.1 } : { color: 'red', vf: 1.9, imax: 0.03 },
      edit: isIR ? [{ k: 'vf', label: 'Vf @20 mA (V)', t: 'num' }, { k: 'imax', label: 'Max current (A)', t: 'num' }] : [{ k: 'color', label: 'Colour', t: 'sel', opts: Object.keys(LEDCOL) }, { k: 'vf', label: 'Vf @20 mA (V)', t: 'num' }, { k: 'imax', label: 'Max current (A)', t: 'num' }],
      pins: () => [{ name: 'A', x: 0, y: 0 }, { name: 'C', x: 10, y: 0 }],
      size: () => ({ w: 10, h: 10 }),
      svg(p, st) {
        const col = isIR ? '#7a5cff' : (LEDCOL[p.props.color] || LEDCOL.red)[0];
        const b = st ? st.bright || 0 : 0, burned = st && st.burned;
        let s = `<line x1="0" y1="0" x2="0" y2="-8" class="lead"/><line x1="10" y1="0" x2="10" y2="-8" class="lead"/>`;
        if (b > 0.01 && !burned) s += `<circle cx="5" cy="-18" r="${8 + 16 * b}" style="fill:${isIR ? '#b49cff' : col};opacity:${(isIR ? 0.35 : 0.75) * b}" class="glow" filter="url(#fGlow)"/>`;
        s += `<path d="M-2 -8 h14 v-12 a7 7 0 0 0 -14 0 z" style="fill:${burned ? '#333' : col};opacity:${burned ? 1 : 0.5 + 0.5 * b}" class="led-body"/>`;
        if (b > 0.01 && !burned) s += `<circle cx="5" cy="-17" r="${1.5 + 3 * b}" style="fill:#fff;opacity:${0.9 * b}" filter="url(#fGlow)" pointer-events="none"/>`;
        s += `<path d="M0 -10 v-9 a5 5 0 0 1 4 -5" stroke="#fff" stroke-opacity=".55" stroke-width="1.3" fill="none" stroke-linecap="round" pointer-events="none"/>`;
        s += `<rect x="-3" y="-9.5" width="16" height="2.4" rx=".8" class="led-rim" style="fill:${burned ? '#333' : col}"/>`;
        if (isIR) { s += `<text x="5" y="-30" class="plbl">IR</text>`; if (b > 0.02 && !burned) s += `<g class="ir-arcs" style="opacity:${0.3 + 0.7 * b}">${[0, 1, 2].map((k) => `<path d="M${13 + k * 5} ${-26 - k * 4} a${8 + k * 5} ${8 + k * 5} 0 0 1 0 ${12 + k * 8}" style="animation-delay:${k * 0.18}s"/>`).join('')}</g>`; }
        if (burned) s += `<g class="smoke"><circle cx="5" cy="-32" r="5"/><circle cx="9" cy="-42" r="6"/><circle cx="3" cy="-52" r="7"/></g>`;
        return s + pinDots(this.pins(p)) + `<text x="-4" y="9" class="plbl small">A</text><text x="14" y="9" class="plbl small">C</text>`;
      },
      stamp(p, cx) {
        if (cx.state(p).burned) return;
        const d = Solver.diodeFromVf(+p.props.vf || 1.9, 0.02, 2);
        cx.add({ kind: 'D', a: cx.node(p, 'A'), k: cx.node(p, 'C'), is: d.is, n: d.n, main: true }, p);
      },
      measure(p, cx, dt) {
        const e = cx.main(p), st = cx.state(p); if (!e) { st.bright = 0; return; }
        const i = cx.I(e); st.i = i;
        st.bright = Math.max(0, Math.min(1, Math.sqrt(Math.max(0, i) / 0.015)));
        const imax = +p.props.imax || 0.03;
        st.over = i > imax * 1.5 ? (st.over || 0) + dt : 0;
        if (st.over > 0.15 && i > imax * 2) { st.burned = true; cx.log(`💥 ${p.id} burned out (${fmt(i, 'A')} > ${fmt(imax, 'A')})`); }
      },
      readout(p, cx) { const st = cx.state(p); return st.burned ? 'BURNED (reset sim to repair)' : `${fmt(st.i || 0, 'A')}`; },
      warn(p, cx) { const st = cx.state(p); if (st.burned) return 'LED burned out'; if ((st.i || 0) > (+p.props.imax || 0.03)) return 'LED overcurrent!'; },
    });
  }
  ledDef('led', 'LED');
  ledDef('irled', 'IR LED (TSAL6200)', true);
  def('diode', {
    label: 'Diode 1N4148', cat: 'Semiconductors', props: { bypass: false },
    edit: [{ k: 'bypass', label: 'Replace with wire (ghosting demo)', t: 'bool' }],
    pins: () => [{ name: 'A', x: 0, y: 0 }, { name: 'K', x: 30, y: 0 }],
    size: () => ({ w: 30, h: 10 }),
    svg(p) {
      if (p.props.bypass) return `<line x1="0" y1="0" x2="30" y2="0" class="lead bypass"/><text x="15" y="-5" class="plbl small">wire</text>` + pinDots(this.pins(p));
      return `<line x1="0" y1="0" x2="30" y2="0" class="lead"/><rect x="8" y="-3.5" width="14" height="7" rx="2" class="dio-body"/><rect x="18" y="-3.5" width="2.5" height="7" class="dio-band"/>` + pinDots(this.pins(p));
    },
    stamp(p, cx) {
      if (p.props.bypass) { cx.add({ kind: 'R', a: cx.node(p, 'A'), b: cx.node(p, 'K'), r: 0.01, main: true }, p); return; }
      cx.add({ kind: 'D', a: cx.node(p, 'A'), k: cx.node(p, 'K'), is: 2.52e-9, n: 1.752, main: true }, p);
    },
    readout(p, cx) { const e = cx.main(p); return e ? `${fmt(cx.I(e), 'A')}, Vd=${fmt(cx.V(e.a) - cx.V(e.k !== undefined ? e.k : e.b), 'V')}` : ''; },
  });
  def('zener', {
    label: 'Zener diode', cat: 'Semiconductors', props: { vz: 5.1 },
    edit: [{ k: 'vz', label: 'Vz (V)', t: 'num' }],
    pins: () => [{ name: 'A', x: 0, y: 0 }, { name: 'K', x: 30, y: 0 }],
    size: () => ({ w: 30, h: 10 }),
    svg(p) { return `<line x1="0" y1="0" x2="30" y2="0" class="lead"/><rect x="8" y="-3.5" width="14" height="7" rx="2" class="zen-body"/><rect x="18" y="-3.5" width="2.5" height="7" class="dio-band"/><text x="15" y="-6" class="plbl small">${esc(p.props.vz)}V</text>` + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.add({ kind: 'D', a: cx.node(p, 'A'), k: cx.node(p, 'K'), is: 1e-12, n: 1.5, bv: +p.props.vz || 5.1, nbv: 1.2, main: true }, p); },
    readout(p, cx) { const e = cx.main(p); return e ? `${fmt(cx.I(e), 'A')}` : ''; },
  });
  function bjt(type, label, pnp) {
    def(type, {
      label, cat: 'Semiconductors', props: { bf: 200 },
      edit: [{ k: 'bf', label: 'β (hFE)', t: 'num' }],
      pins: () => [{ name: 'E', x: 0, y: 0 }, { name: 'B', x: 10, y: 0 }, { name: 'C', x: 20, y: 0 }],
      size: () => ({ w: 20, h: 10 }),
      svg(p) { return `<line x1="0" y1="0" x2="0" y2="-6" class="lead"/><line x1="10" y1="0" x2="10" y2="-6" class="lead"/><line x1="20" y1="0" x2="20" y2="-6" class="lead"/><path d="M-4 -6 h28 v-8 a14 10 0 0 0 -28 0 z" class="to92" fill="url(#gBlack)" filter="url(#fShadow)"/><path d="M-2 -8 h24" stroke="#ffffff22"/><text x="10" y="-11" class="to92-t">${pnp ? 'PNP' : 'NPN'}</text>` + pinDots(this.pins(p)) + `<text x="0" y="10" class="plbl small">E</text><text x="10" y="10" class="plbl small">B</text><text x="20" y="10" class="plbl small">C</text>`; },
      stamp(p, cx) { cx.add({ kind: 'Q', type: pnp ? 'pnp' : 'npn', c: cx.node(p, 'C'), b: cx.node(p, 'B'), e: cx.node(p, 'E'), is: 1e-14, bf: +p.props.bf || 200, br: 3, main: true }, p); },
      readout(p, cx) { const e = cx.main(p); if (!e) return ''; const r = cx.I(e); const vce = cx.V(e.c) - cx.V(e.e); return `Ic=${fmt(r.ic, 'A')} Ib=${fmt(r.ib, 'A')} Vce=${fmt(vce, 'V')}`; },
    });
  }
  bjt('npn', 'NPN 2N2222', false);
  bjt('pnp', 'PNP 2N2907', true);
  def('nmos', {
    label: 'N-MOSFET AO3400', cat: 'Semiconductors', props: { vth: 1.05, k: 10 },
    edit: [{ k: 'vth', label: 'Vth (V)', t: 'num' }, { k: 'k', label: 'k (A/V²)', t: 'num' }],
    pins: () => [{ name: 'G', x: 0, y: 0 }, { name: 'D', x: 10, y: 0 }, { name: 'S', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    svg(p) { return `<line x1="0" y1="0" x2="0" y2="-6" class="lead"/><line x1="10" y1="0" x2="10" y2="-6" class="lead"/><line x1="20" y1="0" x2="20" y2="-6" class="lead"/><rect x="-4" y="-18" width="28" height="12" rx="2" class="to92" fill="url(#gBlack)" filter="url(#fShadow)"/><circle cx="0" cy="-14.5" r="1" fill="#555"/><text x="10" y="-9" class="to92-t">NMOS</text>` + pinDots(this.pins(p)) + `<text x="0" y="10" class="plbl small">G</text><text x="10" y="10" class="plbl small">D</text><text x="20" y="10" class="plbl small">S</text>`; },
    stamp(p, cx) { cx.add({ kind: 'M', type: 'n', d: cx.node(p, 'D'), g: cx.node(p, 'G'), s: cx.node(p, 'S'), vth: +p.props.vth, k: +p.props.k, lambda: 0.01, main: true }, p); cx.add({ kind: 'D', a: cx.node(p, 'S'), k: cx.node(p, 'D'), is: 1e-12, n: 1.5 }, p); },
    readout(p, cx) { const e = cx.main(p); return e ? `Id=${fmt(cx.I(e), 'A')} Vgs=${fmt(cx.V(e.g) - cx.V(e.s), 'V')}` : ''; },
  });
  // ---------- switches & inputs ----------
  def('pushbutton', {
    label: 'Pushbutton 6 mm', cat: 'Input', props: { key: '', label: '' }, interactive: true,
    edit: [{ k: 'key', label: 'Keyboard key', t: 'text' }, { k: 'label', label: 'Label', t: 'text' }],
    pins: () => [{ name: '1.l', x: 0, y: 0 }, { name: '2.l', x: 20, y: 0 }, { name: '1.r', x: 0, y: 30 }, { name: '2.r', x: 20, y: 30 }],
    size: () => ({ w: 20, h: 30 }),
    svg(p, st) {
      const pr = st && st.pressed;
      return `<rect x="-5" y="2" width="30" height="26" rx="3" class="pb-body" fill="url(#gBlack)" filter="url(#fShadow)"/>${[[-2, 5], [22, 5], [-2, 25], [22, 25]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4" fill="#0008"/>`).join('')}<circle cx="10" cy="15" r="10" fill="#111" opacity=".6"/><circle cx="10" cy="${pr ? 15.6 : 15}" r="${pr ? 7 : 8}" class="pb-cap ${pr ? 'down' : ''}"/>${pr ? '' : '<ellipse cx="8" cy="11.5" rx="4.5" ry="2.4" fill="#fff" opacity=".28" pointer-events="none"/>'}` + pinDots(this.pins(p)) +
        (p.props.label ? `<text x="10" y="39" class="plbl">${esc(p.props.label)}</text>` : '') + (p.props.key ? `<text x="10" y="18" class="pb-key">${esc(p.props.key)}</text>` : '');
    },
    groups: () => [['1.l', '1.r'], ['2.l', '2.r']],
    stamp(p, cx) { if (cx.state(p).pressed) cx.add({ kind: 'R', a: cx.node(p, '1.l'), b: cx.node(p, '2.l'), r: 0.05, main: true }, p); },
  });
  def('key', {
    label: 'Key (2-pin tactile)', cat: 'Input', props: { key: '', label: '' }, interactive: true,
    edit: [{ k: 'key', label: 'Keyboard key', t: 'text' }, { k: 'label', label: 'Label', t: 'text' }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 30, y: 0 }],
    size: () => ({ w: 30, h: 20 }),
    svg(p, st) {
      const pr = st && st.pressed;
      return `<line x1="0" y1="0" x2="30" y2="0" class="lead"/><rect x="2" y="-12" width="26" height="22" rx="4" class="pb-body" fill="url(#gBlack)" filter="${pr ? '' : 'url(#fShadow)'}"/><rect x="${pr ? 6 : 5}" y="${pr ? -8 : -9}" width="${pr ? 18 : 20}" height="${pr ? 14 : 16}" rx="3" class="key-cap ${pr ? 'down' : ''}"/>` +
        `<text x="15" y="2" class="key-t">${esc(p.props.label || '')}</text>` + (p.props.key ? `<text x="15" y="20" class="pb-key2">${esc(p.props.key)}</text>` : '') + pinDots(this.pins(p));
    },
    stamp(p, cx) { if (cx.state(p).pressed) cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: 0.05, main: true }, p); },
  });
  def('slideswitch', {
    label: 'Slide switch SPDT', cat: 'Input', props: { pos: 0 }, interactive: true,
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 10, y: 0 }, { name: '3', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    svg(p) { const x = p.props.pos ? 12 : 0; return `<rect x="-5" y="-16" width="30" height="12" rx="2" class="sw-body"/><rect x="${x - 1}" y="-14" width="10" height="8" rx="1" class="sw-knob"/>` + [0, 10, 20].map((v) => `<line x1="${v}" y1="0" x2="${v}" y2="-4" class="lead"/>`).join('') + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '2'), b: cx.node(p, p.props.pos ? '3' : '1'), r: 0.05 }, p); },
    click(p) { p.props.pos = p.props.pos ? 0 : 1; return true; },
  });
  def('potentiometer', {
    label: 'Potentiometer', cat: 'Input', props: { r: 10000, pos: 0.5 },
    edit: [{ k: 'r', label: 'Resistance (Ω)', t: 'val' }, { k: 'pos', label: 'Wiper', t: 'range', min: 0, max: 1, step: 0.01, live: true }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: 'W', x: 10, y: 0 }, { name: '2', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    svg(p) { const a = -135 + 270 * (+p.props.pos); return [0, 10, 20].map((v) => `<line x1="${v}" y1="0" x2="${v}" y2="-6" class="lead"/>`).join('') + `<rect x="-6" y="-30" width="32" height="24" rx="3" class="pot-body" filter="url(#fShadow)"/><path d="M2.2 -10.2 A11 11 0 1 1 17.8 -10.2" class="pot-track"/><g transform="rotate(${a} 10 -18)"><circle cx="10" cy="-18" r="9" class="pot-knob" fill="url(#gKnob)"/>${Array.from({ length: 18 }, (_, k) => `<line x1="10" y1="-27" x2="10" y2="-25.4" stroke="#0009" stroke-width=".8" transform="rotate(${k * 20} 10 -18)"/>`).join('')}<circle cx="10" cy="-18" r="5.5" fill="#2a2f37" stroke="#4a525d" stroke-width=".5"/><line x1="10" y1="-18" x2="10" y2="-25" class="pot-ind"/></g>` + pinDots(this.pins(p)) + `<text x="10" y="-34" class="plbl">${Math.round(p.props.pos * 100)}%</text>`; },
    stamp(p, cx) { const r = stampResistance(p.props.r, this.props.r).value, x = Math.min(0.999, Math.max(0.001, +p.props.pos)); cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, 'W'), r: r * x }, p); cx.add({ kind: 'R', a: cx.node(p, 'W'), b: cx.node(p, '2'), r: r * (1 - x) }, p); },
    warn(p) {
      const used = stampResistance(p.props.r, this.props.r);
      if (!used.ok) return invalidValueWarning('resistance', p.props.r, this.props.r, 'Ω');
    },
    wheel(p, d) { p.props.pos = Math.min(1, Math.max(0, +p.props.pos - d * 0.05)); return true; },
  });
  def('ldr', {
    label: 'Photoresistor (LDR)', cat: 'Input', props: { lux: 100 },
    edit: [{ k: 'lux', label: 'Light (lux)', t: 'range', min: 0.1, max: 10000, step: 1, log: true, live: true }],
    pins: () => [{ name: '1', x: 0, y: 0 }, { name: '2', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    R: (lux) => Math.min(1e6, Math.max(100, 1e4 * Math.pow(Math.max(lux, 0.01) / 10, -0.7))),
    svg(p) { return `<line x1="0" y1="0" x2="20" y2="0" class="lead"/><circle cx="10" cy="-9" r="9" class="ldr-body"/><path d="M4 -13 q3 -3 6 0 t6 0 M4 -9 q3 -3 6 0 t6 0 M4 -5 q3 -3 6 0 t6 0" class="ldr-track"/>` + pinDots(this.pins(p)) + `<text x="10" y="-21" class="plbl">${Math.round(p.props.lux)} lx</text>`; },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '1'), b: cx.node(p, '2'), r: this.R(+p.props.lux), main: true }, p); },
    readout(p) { return 'R=' + fmt(this.R(+p.props.lux), 'Ω'); },
  });
  // ---------- power ----------
  def('battery', {
    label: 'Battery / LiPo', cat: 'Power', props: { v: 3.7, rint: 0.15, label: 'LiPo 1S' },
    edit: [{ k: 'v', label: 'Voltage (V)', t: 'num' }, { k: 'rint', label: 'Internal R (Ω)', t: 'num' }, { k: 'label', label: 'Label', t: 'text' }],
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 40, y: 0 }],
    size: () => ({ w: 40, h: 10 }),
    svg(p) { return `<rect x="-2" y="-28" width="44" height="22" rx="4" class="bat-body"/><rect x="42" y="-21" width="4" height="8" class="bat-tip"/><text x="20" y="-14" class="bat-t">${esc(p.props.label)}</text><text x="20" y="-34" class="plbl">${esc(p.props.v)} V</text><line x1="0" y1="0" x2="0" y2="-6" class="wire-red"/><line x1="40" y1="0" x2="40" y2="-6" class="wire-blk"/>` + pinDots(this.pins(p)) + `<text x="-6" y="9" class="plbl small">+</text><text x="46" y="9" class="plbl small">−</text>`; },
    stamp(p, cx) { const n = cx.node(p, '-'); cx.markGround(n, 1); cx.add({ kind: 'V', a: cx.node(p, '+'), b: n, v: +p.props.v, rs: +p.props.rint || 0.01, main: true }, p); },
    readout(p, cx) { const e = cx.main(p); return e ? `I=${fmt(-cx.I(e), 'A')}` : ''; },
    warn(p, cx) { const e = cx.main(p); if (e && Math.abs(cx.I(e)) > 3) return 'SHORT CIRCUIT on battery!'; },
  });
  function supply(type, v) {
    def(type, {
      label: `${v} V supply`, cat: 'Power', props: { v },
      pins: () => [{ name: '+', x: 0, y: 0 }, { name: 'GND', x: 20, y: 0 }],
      size: () => ({ w: 20, h: 10 }),
      svg(p) { return `<rect x="-6" y="-24" width="32" height="18" rx="3" class="sup-body"/><text x="10" y="-12" class="sup-t">${v}V</text><line x1="0" y1="0" x2="0" y2="-6" class="wire-red"/><line x1="20" y1="0" x2="20" y2="-6" class="wire-blk"/>` + pinDots(this.pins(p)) + `<text x="-5" y="10" class="plbl small">+</text><text x="22" y="10" class="plbl small">⏚</text>`; },
      stamp(p, cx) { const g = cx.node(p, 'GND'); cx.markGround(g, 2); cx.add({ kind: 'V', a: cx.node(p, '+'), b: g, v, rs: 0.02, main: true }, p); },
      readout(p, cx) { const e = cx.main(p); return e ? `I=${fmt(-cx.I(e), 'A')}` : ''; },
      warn(p, cx) { const e = cx.main(p); if (e && Math.abs(cx.I(e)) > 2) return 'SHORT CIRCUIT: supply current > 2 A'; },
    });
  }
  supply('vcc33', 3.3); supply('vcc5', 5);
  def('ground', {
    label: 'Ground', cat: 'Power', props: {},
    pins: () => [{ name: 'GND', x: 0, y: 0 }], size: () => ({ w: 10, h: 10 }),
    svg(p) { return `<line x1="0" y1="0" x2="0" y2="-8" class="lead"/><path d="M-8 -8 h16 M-5 -12 h10 M-2 -16 h4" class="gnd-sym" transform="scale(1,-1) translate(0,8)"/>` + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.markGround(cx.node(p, 'GND'), 3); },
  });
  def('ldo', {
    label: 'LDO MCP1700 / AP2112 3.3V', cat: 'Power', props: { vreg: 3.3, drop: 0.18, imax: 0.25 },
    edit: [{ k: 'vreg', label: 'Vout (V)', t: 'num' }, { k: 'drop', label: 'Dropout (V)', t: 'num' }, { k: 'imax', label: 'Max current (A)', t: 'num' }],
    pins: () => [{ name: 'GND', x: 0, y: 0 }, { name: 'VIN', x: 10, y: 0 }, { name: 'VOUT', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    svg(p) { return `<line x1="0" y1="0" x2="0" y2="-6" class="lead"/><line x1="10" y1="0" x2="10" y2="-6" class="lead"/><line x1="20" y1="0" x2="20" y2="-6" class="lead"/><path d="M-4 -6 h28 v-8 a14 10 0 0 0 -28 0 z" class="to92" fill="url(#gBlack)" filter="url(#fShadow)"/><path d="M-2 -8 h24" stroke="#ffffff22"/><text x="10" y="-11" class="to92-t">LDO</text>` + pinDots(this.pins(p)) + `<text x="0" y="10" class="plbl small">G</text><text x="10" y="10" class="plbl small">I</text><text x="20" y="10" class="plbl small">O</text>`; },
    stamp(p, cx) { cx.add({ kind: 'LDO', in: cx.node(p, 'VIN'), out: cx.node(p, 'VOUT'), gnd: cx.node(p, 'GND'), vreg: +p.props.vreg, drop: +p.props.drop, main: true }, p); },
    readout(p, cx) { const e = cx.main(p); return e ? `Iout=${fmt(cx.I(e), 'A')} Vout=${fmt(cx.V(e.out) - cx.V(e.gnd), 'V')}` : ''; },
    warn(p, cx) { const e = cx.main(p); if (e && cx.I(e) > (+p.props.imax || 0.25)) return `LDO over current (${fmt(cx.I(e), 'A')} > ${p.props.imax} A)`; },
  });
  // ---------- output / instruments ----------
  def('buzzer', {
    label: 'Buzzer (active)', cat: 'Output', props: {},
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 20, y: 0 }], size: () => ({ w: 20, h: 10 }),
    svg(p, st) { const on = st && st.on; return `<line x1="0" y1="0" x2="0" y2="-6" class="lead"/><line x1="20" y1="0" x2="20" y2="-6" class="lead"/><circle cx="10" cy="-18" r="13" class="buz-body"/><circle cx="10" cy="-18" r="3" class="buz-hole"/>` + (on ? `<path d="M28 -28 q6 10 0 20 M33 -32 q9 14 0 28" class="buz-wave"/>` : '') + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, '+'), b: cx.node(p, '-'), r: 42, main: true }, p); },
    measure(p, cx) { const e = cx.main(p), st = cx.state(p); st.on = e && cx.I(e) > 0.005; },
    readout(p, cx) { const e = cx.main(p); return e ? fmt(cx.I(e), 'A') : ''; },
  });
  def('voltmeter', {
    label: 'Voltmeter', cat: 'Instruments', props: {},
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    svg(p, st) { return `<rect x="-6" y="-34" width="42" height="28" rx="4" class="meter"/><text x="15" y="-15" class="meter-t">${st && st.txt ? esc(st.txt) : '— V'}</text><line x1="0" y1="0" x2="0" y2="-6" class="wire-red"/><line x1="30" y1="0" x2="30" y2="-6" class="wire-blk"/>` + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.add({ kind: 'G', a: cx.node(p, '+'), b: cx.node(p, '-'), g: 1e-8, main: true }, p); },
    measure(p, cx) { const e = cx.main(p); cx.state(p).txt = fmt(cx.V(e.a) - cx.V(e.b), 'V'); },
  });
  def('ammeter', {
    label: 'Ammeter', cat: 'Instruments', props: {},
    pins: () => [{ name: '+', x: 0, y: 0 }, { name: '-', x: 30, y: 0 }], size: () => ({ w: 30, h: 10 }),
    svg(p, st) { return `<rect x="-6" y="-34" width="42" height="28" rx="4" class="meter amm"/><text x="15" y="-15" class="meter-t">${st && st.txt ? esc(st.txt) : '— A'}</text><line x1="0" y1="0" x2="0" y2="-6" class="wire-red"/><line x1="30" y1="0" x2="30" y2="-6" class="wire-blk"/>` + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.add({ kind: 'V', a: cx.node(p, '+'), b: cx.node(p, '-'), v: 0, main: true }, p); },
    measure(p, cx) { const e = cx.main(p); cx.state(p).txt = fmt(cx.I(e), 'A'); },
  });
  def('scope', {
    label: 'Oscilloscope probe', cat: 'Instruments', props: { ch: 1 },
    edit: [{ k: 'ch', label: 'Channel', t: 'sel', opts: [1, 2, 3, 4] }],
    pins: () => [{ name: 'P', x: 0, y: 0 }], size: () => ({ w: 10, h: 10 }),
    svg(p) { const ch = scopeChannel(p.props.ch); const c = ['#ffd84a', '#4ae0ff', '#ff5ad1', '#7dff6a'][ch - 1]; return `<line x1="0" y1="0" x2="0" y2="-14" class="lead"/><rect x="-5" y="-40" width="10" height="26" rx="3" style="fill:${c}" class="probe"/><text x="0" y="-44" class="plbl">CH${ch}</text>` + pinDots(this.pins(p)); },
    stamp(p, cx) { cx.probe(p, cx.node(p, 'P')); },
  });
  // ---------- I2C modules (bus traffic comes from the emulated ESP32 I2C controller) ----------
  function i2cMod(type, label, props, edit, w, body) {
    def(type, {
      label, cat: 'I2C / Displays', props, edit: [{ k: 'addr', label: 'I2C address', t: 'sel', opts: props.addrs }, ...edit],
      pins: () => [{ name: 'GND', x: 0, y: 0 }, { name: 'VCC', x: 10, y: 0 }, { name: 'SCL', x: 20, y: 0 }, { name: 'SDA', x: 30, y: 0 }],
      size: () => ({ w, h: 10 }),
      svg(p, st) { return body(p, st || {}) + ['GND', 'VCC', 'SCL', 'SDA'].map((n, i) => `<text x="${i * 10}" y="-7" class="plbl small" transform="rotate(-90 ${i * 10} -7)" text-anchor="start">${n}</text>`).join('') + pinDots(this.pins(p)); },
      stamp(p, cx) {   // module load + on-board 10k pull-ups on SCL/SDA
        const v = cx.node(p, 'VCC'), g = cx.node(p, 'GND');
        cx.add({ kind: 'R', a: v, b: g, r: 3.3 / 0.0005, main: true }, p);
        cx.add({ kind: 'R', a: cx.node(p, 'SCL'), b: v, r: 10e3 }, p); cx.add({ kind: 'R', a: cx.node(p, 'SDA'), b: v, r: 10e3 }, p);
      },
      readout(p, cx) { const st = cx.state(p); return `${p.props.addr} · ${st.i2cInfo || 'no traffic yet'}`; },
    });
  }
  i2cMod('ssd1306', 'OLED SSD1306 128×64', { addr: '0x3C', addrs: ['0x3C', '0x3D'] }, [], 130, (p, st) =>
    `<rect x="-6" y="-80" width="142" height="74" rx="4" class="oled-pcb" filter="url(#fShadow)"/>${[[-2, -76], [132, -76], [-2, -10], [132, -10]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" class="mhole"/>`).join('')}<rect x="-2" y="-77" width="134" height="68" rx="2" class="bezel"/><rect x="0" y="-74" width="130" height="62" class="oled-glass"/>` +
    (st.img ? `<image href="${st.img}" x="1" y="-73" width="128" height="60" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : '') +
    `<rect x="0" y="-74" width="130" height="30" fill="url(#gGloss)" opacity=".12" pointer-events="none"/><text x="65" y="-84" class="plbl">SSD1306 ${esc(p.props.addr)}</text>`);
  i2cMod('bme280', 'BME280 temp/pressure/humidity', { addr: '0x76', addrs: ['0x76', '0x77'], temp: 23.5, hum: 45, press: 1013.25 },
    [{ k: 'temp', label: 'Temperature (°C)', t: 'range', min: -40, max: 85, step: 0.1, live: true }, { k: 'hum', label: 'Humidity (%)', t: 'range', min: 0, max: 100, step: 0.5, live: true }, { k: 'press', label: 'Pressure (hPa)', t: 'range', min: 300, max: 1100, step: 0.25, live: true }], 30,
    (p) => `<rect x="-6" y="-44" width="42" height="38" rx="3" class="mod-pcb"/><rect x="10" y="-32" width="10" height="10" class="mod-chip"/><text x="15" y="-48" class="plbl">BME280 ${(+p.props.temp).toFixed(1)}°C</text>`);
  i2cMod('mpu6050', 'MPU6050 accelerometer/gyro', { addr: '0x68', addrs: ['0x68', '0x69'], ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 25 },
    ['ax', 'ay', 'az'].map((k) => ({ k, label: `Accel ${k[1].toUpperCase()} (g)`, t: 'range', min: -2, max: 2, step: 0.01, live: true })).concat(['gx', 'gy', 'gz'].map((k) => ({ k, label: `Gyro ${k[1].toUpperCase()} (°/s)`, t: 'range', min: -250, max: 250, step: 1, live: true }))), 30,
    (p) => `<rect x="-6" y="-48" width="42" height="42" rx="3" class="mod-pcb mpu"/><rect x="8" y="-34" width="14" height="14" class="mod-chip"/><text x="15" y="-52" class="plbl">MPU6050</text>`);
  // ---------- SPI parts (bus traffic comes from the emulated ESP32 SPI2/SPI3 controllers; CS and D/C are GPIOs) ----------
  function spiPart(type, o) {
    const names = o.pins.map((n) => n);
    def(type, {
      label: o.label, cat: 'SPI / Displays / Storage', props: o.props || {}, edit: o.edit || [],
      pins: () => names.map((n, i) => ({ name: n, x: i * 10, y: 0 })).concat((o.top || []).map((n, i) => ({ name: n, x: i * 10, y: o.topY }))),
      size: () => ({ w: Math.max(names.length, (o.top || []).length) * 10, h: 10 }),
      svg(p, st) { st = st || {}; return o.body(p, st) + names.map((n, i) => `<text x="${i * 10}" y="-7" class="plbl small" transform="rotate(-90 ${i * 10} -7)" text-anchor="start">${n}</text>`).join('') + (o.top || []).map((n, i) => `<text x="${i * 10}" y="${o.topY + 7}" class="plbl small" transform="rotate(-90 ${i * 10} ${o.topY + 7})" text-anchor="end">${n}</text>`).join('') + pinDots(this.pins(p)); },
      stamp(p, cx) { const v = cx.node(p, o.vcc || 'VCC'), g = cx.node(p, 'GND'); cx.add({ kind: 'R', a: v, b: g, r: o.load || 3.3 / 0.001, main: true }, p); if (o.stamp) o.stamp(p, cx); },
      readout(p, cx) { const st = cx.state(p); return st.spiInfo || 'no SPI traffic yet'; },
    });
  }
  spiPart('ili9341', { label: 'TFT ILI9341 240×320 (SPI)', pins: ['VCC', 'GND', 'CS', 'RST', 'DC', 'MOSI', 'SCK', 'LED', 'MISO'], load: 3.3 / 0.02,
    props: { view: 'landscape' }, edit: [{ k: 'view', label: 'Module orientation', t: 'sel', opts: ['landscape', 'portrait'] }],
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, 'LED'), b: cx.node(p, 'GND'), r: 160 }, p); },
    body: (p, st) => p.props.view === 'portrait'
      ? `<rect x="-8" y="-166" width="96" height="160" rx="4" class="tft-pcb" filter="url(#fShadow)"/><rect x="-5" y="-162" width="90" height="128" rx="2" class="bezel"/><rect x="-3" y="-158" width="86" height="116" class="oled-glass"/>` +
        (st.img ? `<image href="${st.img}" x="-2" y="-157" width="84" height="114" preserveAspectRatio="none"/>` : '') + `<rect x="-3" y="-158" width="86" height="50" fill="url(#gGloss)" opacity=".12" pointer-events="none"/><text x="40" y="-30" class="plbl">ILI9341 2.4"</text>`
      : `<rect x="-42" y="-134" width="164" height="128" rx="4" class="tft-pcb" filter="url(#fShadow)"/><rect x="-39" y="-131" width="158" height="120" rx="2" class="bezel"/><rect x="-36" y="-128" width="152" height="114" class="oled-glass"/>` +
        (st.img ? `<image href="${st.img}" x="-35" y="-127" width="150" height="112" preserveAspectRatio="none"/>` : '') + `<rect x="-36" y="-128" width="152" height="50" fill="url(#gGloss)" opacity=".12" pointer-events="none"/><text x="40" y="-138" class="plbl">ILI9341 2.4"</text>` });
  spiPart('mcp3008', { label: 'MCP3008 8-ch 10-bit ADC (SPI)', pins: ['VDD', 'GND', 'CLK', 'DOUT', 'DIN', 'CS'], top: ['CH0', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7'], topY: -50, vcc: 'VDD', load: 3.3 / 0.0005,
    body: () => `<rect x="-5" y="-42" width="80" height="30" rx="2" class="mod-chip"/><circle cx="1" cy="-36" r="2" fill="#555"/><text x="35" y="-24" class="plbl" style="fill:#ddd">MCP3008</text>` });
  spiPart('sdcard', { label: 'microSD card module (SPI)', pins: ['CS', 'SCK', 'MOSI', 'MISO', 'VCC', 'GND'], props: { hello: 'Hello from the virtual SD card!' }, edit: [{ k: 'hello', label: 'HELLO.TXT contents (at run start)', t: 'text' }], load: 3.3 / 0.002,
    body: () => `<rect x="-8" y="-70" width="66" height="64" rx="4" class="mod-pcb sd"/><path d="M8 -62 h30 l8 8 v34 h-38 z" class="sd-card"/><text x="25" y="-40" class="plbl" style="fill:#fff">microSD</text>` });
  i2cMod('lcd1602', 'LCD 16×2 I2C (PCF8574 + HD44780)', { addr: '0x27', addrs: ['0x27', '0x3F', '0x20', '0x21'], color: 'blue' }, [{ k: 'color', label: 'Backlight', t: 'sel', opts: ['blue', 'green'] }], 30, (p, st) => {
    const green = p.props.color === 'green', bl = st.bl;
    return `<rect x="-36" y="-92" width="182" height="86" rx="4" class="lcd-pcb" filter="url(#fShadow)"/>${[[-30, -86], [140, -86], [-30, -12], [140, -12]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" class="mhole"/>`).join('')}` +
      `<rect x="-24" y="-80" width="158" height="54" rx="2" class="lcd-bezel"/><rect x="-18" y="-74" width="146" height="42" rx="1" style="fill:${green ? (bl ? '#9fd13a' : '#4d6421') : (bl ? '#2c5cff' : '#14234f')}"/>` +
      (st.img ? `<image href="${st.img}" x="-15" y="-71" width="140" height="36" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : '') +
      `<rect x="-18" y="-74" width="146" height="16" fill="url(#gGloss)" opacity=".15" pointer-events="none"/><text x="56" y="-96" class="plbl">LCD1602 I2C ${esc(p.props.addr)}</text>`;
  });
  // ---------- Servo SG90: 50 Hz PWM pulse width (LEDC duty / frequency) -> horn angle, slews like the real gearbox ----------
  def('servo', {
    label: 'Servo SG90 (PWM)', cat: 'Motors / LEDs', props: { min: 544, max: 2400 }, prefix: 'SRV',
    edit: [{ k: 'min', label: 'Pulse at 0° (µs)', t: 'num' }, { k: 'max', label: 'Pulse at 180° (µs)', t: 'num' }],
    pins: () => [{ name: 'GND', x: 0, y: 0 }, { name: 'V+', x: 10, y: 0 }, { name: 'SIG', x: 20, y: 0 }],
    size: () => ({ w: 20, h: 10 }),
    svg(p, st) {
      st = st || {}; const a = st.angle !== undefined ? st.angle : 90, rot = 90 - a;   // 0° = horn to the right... 180° = left
      return `<line x1="0" y1="0" x2="0" y2="-10" stroke="#5a3a22" stroke-width="2"/><line x1="10" y1="0" x2="10" y2="-10" stroke="#d0342c" stroke-width="2"/><line x1="20" y1="0" x2="20" y2="-10" stroke="#f0a020" stroke-width="2"/>` +
        `<rect x="-24" y="-56" width="68" height="40" rx="3" class="servo-body" filter="url(#fShadow)"/><rect x="-32" y="-44" width="84" height="8" rx="2" class="servo-body"/><circle cx="-27" cy="-40" r="2" fill="#0006"/><circle cx="47" cy="-40" r="2" fill="#0006"/>` +
        `<circle cx="0" cy="-44" r="11" class="servo-hub"/><g transform="rotate(${rot.toFixed(1)} 0 -44)"><path d="M-5 -44 L-2.5 -84 a2.5 2.5 0 0 1 5 0 L5 -44 a5 5 0 0 1 -10 0 z" class="servo-horn"/>${[0, 1, 2, 3].map((i) => `<circle cx="0" cy="${-52 - i * 8}" r="1.1" fill="#999"/>`).join('')}</g><circle cx="0" cy="-44" r="3" fill="#bbb"/>` +
        `<text x="22" y="-28" class="plbl" style="fill:#ddd">SG90</text><text x="22" y="-60" class="plbl">${st.us ? Math.round(a) + '° · ' + Math.round(st.us) + ' µs' : 'no pulse'}</text>` + pinDots(this.pins(p));
    },
    stamp(p, cx) { cx.add({ kind: 'R', a: cx.node(p, 'V+'), b: cx.node(p, 'GND'), r: 5 / 0.01, main: true }, p); cx.add({ kind: 'R', a: cx.node(p, 'SIG'), b: cx.node(p, 'GND'), r: 100e3 }, p); },
    readout(p, cx) { const st = cx.state(p); return st.us ? `${Math.round(st.target)}° target, ${Math.round(st.angle)}° now · ${Math.round(st.us)} µs @ ${st.hz ? st.hz.toFixed(0) : '?'} Hz` : 'no 50 Hz pulse on SIG'; },
    warn(p, cx) { const st = cx.state(p); if (st.lowV) return 'servo supply below 4 V (use VIN / 5 V)'; },
  });
  // ---------- WS2812B NeoPixels (pixel data comes from Adafruit_NeoPixel::show() via the QemuSim hook) ----------
  function neoBody(p, st, ring) {
    const n = Math.max(1, Math.min(144, +p.props.n || 8)), px = (st && st.px) || [], led = (i, x, y) => {
      const c = px[i] || [0, 0, 0], m = Math.max(c[0], c[1], c[2]), on = m > 2;
      const f = on ? `rgb(${c.map((v) => Math.round(Math.min(255, 40 + v * 215 / Math.max(m, 1) * (0.35 + 0.65 * m / 255)))).join(',')})` : '#cfcabb';
      return (on ? `<circle cx="${x}" cy="${y}" r="${6 + 6 * m / 255}" style="fill:${f};opacity:${0.25 + 0.5 * m / 255}" filter="url(#fGlow)"/>` : '') + `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5" style="fill:${f}" class="neo-led"/>`;
    };
    if (ring) {
      const R = Math.max(18, n * 3.2); let s = `<circle cx="10" cy="${-R - 12}" r="${R}" class="neo-ring" filter="url(#fShadow)"/><path d="M10 ${-12} v-6" stroke="#1b1b1d" stroke-width="10"/>`;
      for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n; s += led(i, 10 + R * Math.cos(a), -R - 12 + R * Math.sin(a)); }
      return s + `<text x="10" y="${-2 * R - 24}" class="plbl">NeoPixel ring ×${n}</text>`;
    }
    let s = `<rect x="-6" y="-26" width="${Math.max(30, n * 14 + 6)}" height="18" rx="2" class="neo-pcb" filter="url(#fShadow)"/>`;
    for (let i = 0; i < n; i++) s += led(i, 8 + i * 14, -17);
    return s + `<text x="${n * 7}" y="-30" class="plbl">WS2812B ×${n}</text>`;
  }
  for (const [type, label, ring, n] of [['neopixel', 'NeoPixel strip WS2812B', false, 8], ['neoring', 'NeoPixel ring WS2812B', true, 16]]) {
    def(type, {
      label, cat: 'Motors / LEDs', props: { n }, prefix: ring ? 'RING' : 'STRIP',
      edit: [{ k: 'n', label: 'LED count', t: 'num' }],
      pins: () => [{ name: 'GND', x: 0, y: 0 }, { name: 'VCC', x: 10, y: 0 }, { name: 'DIN', x: 20, y: 0 }],
      size: (p) => ({ w: ring ? 20 : Math.max(30, (+p.props.n || 8) * 14), h: 10 }),
      svg(p, st) { return neoBody(p, st, ring) + ['GND', 'VCC', 'DIN'].map((t, i) => `<text x="${i * 10}" y="9" class="plbl small" transform="rotate(-90 ${i * 10} 9)" text-anchor="end">${t}</text>`).join('') + pinDots(this.pins(p)); },
      stamp(p, cx) { const st = cx.state(p), lit = (st.px || []).reduce((a, c) => a + (c[0] + c[1] + c[2]) / 765, 0); cx.add({ kind: 'R', a: cx.node(p, 'VCC'), b: cx.node(p, 'GND'), r: 5 / (0.001 * (+p.props.n || 8) + 0.06 * lit), main: true }, p); cx.add({ kind: 'R', a: cx.node(p, 'DIN'), b: cx.node(p, 'GND'), r: 1e6 }, p); },
      readout(p, cx) { const st = cx.state(p); return st.frames ? `${st.frames} frames · last ${st.px.length} px on GPIO${st.gpio}` : 'no data yet (Adafruit_NeoPixel show())'; },
    });
  }
  // ---------- DHT22 / AM2302 (module with 10k pull-up). Read through the QemuSim DHT::read() hook: the sketch's DHT library
  // sends the normal start pulse, then clocks the 40 data bits by toggling the pin's pull-up; the sensor drives each bit. ----------
  def('dht22', {
    label: 'DHT22 temp/humidity', cat: 'Sensors', props: { temp: 24.0, hum: 50 }, prefix: 'DHT',
    edit: [{ k: 'temp', label: 'Temperature (°C)', t: 'range', min: -40, max: 80, step: 0.1, live: true }, { k: 'hum', label: 'Humidity (%)', t: 'range', min: 0, max: 100, step: 0.1, live: true }],
    pins: () => [{ name: 'VCC', x: 0, y: 0 }, { name: 'DATA', x: 10, y: 0 }, { name: 'NC', x: 20, y: 0 }, { name: 'GND', x: 30, y: 0 }],
    size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      let s = `<rect x="-5" y="-62" width="40" height="56" rx="3" class="dht-body" filter="url(#fShadow)"/>`;
      for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) s += `<rect x="${-1 + c * 9}" y="${-56 + r * 8}" width="5" height="5" rx="1" class="dht-grill"/>`;
      return s + `<text x="15" y="-66" class="plbl">DHT22 ${(+p.props.temp).toFixed(1)}°C ${(+p.props.hum).toFixed(0)}%</text>` + ['VCC', 'DAT', 'NC', 'GND'].map((t, i) => `<text x="${i * 10}" y="9" class="plbl small" transform="rotate(-90 ${i * 10} 9)" text-anchor="end">${t}</text>`).join('') + pinDots(this.pins(p));
    },
    stamp(p, cx) {
      const v = cx.node(p, 'VCC'), g = cx.node(p, 'GND'), d = cx.node(p, 'DATA'), st = cx.state(p);
      cx.add({ kind: 'R', a: v, b: g, r: 3.3 / 0.0015, main: true }, p); cx.add({ kind: 'R', a: d, b: v, r: 10e3 }, p);
      if (st.drive === 0) cx.add({ kind: 'R', a: d, b: g, r: 60 }, p); else if (st.drive === 1) cx.add({ kind: 'R', a: d, b: v, r: 60 }, p);
    },
    bytes(p) {   // 16-bit RH x10, 16-bit T x10 (sign bit 15), checksum
      const h = Math.round(Math.max(0, Math.min(100, +p.props.hum)) * 10), t = Math.round(Math.max(-40, Math.min(80, +p.props.temp)) * 10), tt = t < 0 ? (0x8000 | -t) : t;
      const b = [h >> 8, h & 255, tt >> 8, tt & 255]; b.push((b[0] + b[1] + b[2] + b[3]) & 255); return b;
    },
    readout(p, cx) { const st = cx.state(p); return st.reads ? `${st.reads} reads` : 'not read yet'; },
  });
  def('label', {
    label: 'Text label', cat: 'Misc', props: { text: 'label', size: 12 },
    edit: [{ k: 'text', label: 'Text', t: 'text' }, { k: 'size', label: 'Size', t: 'num' }],
    pins: () => [], size: (p) => ({ w: String(p.props.text).length * (+p.props.size || 12) * 0.6, h: +p.props.size || 12 }),
    svg(p) { return `<text x="0" y="0" class="free-lbl" style="font-size:${+p.props.size || 12}px">${esc(p.props.text)}</text>`; },
  });

  function pinDots(pins) { return pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join(''); }

  // rotation helpers (rot: 0..3, 90° steps clockwise)
  function rotPt(x, y, r) { switch (r & 3) { case 1: return [-y, x]; case 2: return [-x, -y]; case 3: return [y, -x]; default: return [x, y]; } }
  function pinWorld(p, pin) { const [x, y] = rotPt(pin.x, pin.y, p.rot || 0); return { x: p.x + x, y: p.y + y }; }

  // Bounds of the part body in world space. Single-row parts draw their body
  // above the leg line, so the box reaches back across that artwork; a part
  // whose pins already span rows (a DIP, the DevKit) just pads the pin box.
  function partBox(part) {
    const spec = T[part.type];
    if (!spec || part.type === 'breadboard' || part.type === 'label') return null;
    let pins = [];
    try { pins = spec.pins(part) || []; } catch (e) { pins = []; }
    let sz = { w: 10, h: 10 };
    try { sz = spec.size(part) || sz; } catch (e) { /* keep default */ }
    let x0 = 0, y0 = 0, x1 = sz.w || 0, y1 = 0;
    for (const pin of pins) {
      x0 = Math.min(x0, pin.x); y0 = Math.min(y0, pin.y);
      x1 = Math.max(x1, pin.x); y1 = Math.max(y1, pin.y);
    }
    if (y1 - y0 < 20) { y0 = Math.min(y0, -(Math.max(sz.h || 10, 16))); y1 = Math.max(y1, 6); }
    else { x0 -= 6; y0 -= 6; x1 += 6; y1 += 6; }
    let wx0 = 1e9, wy0 = 1e9, wx1 = -1e9, wy1 = -1e9;
    for (const [a, b] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      const [rx, ry] = rotPt(a, b, part.rot || 0);
      wx0 = Math.min(wx0, part.x + rx); wy0 = Math.min(wy0, part.y + ry);
      wx1 = Math.max(wx1, part.x + rx); wy1 = Math.max(wy1, part.y + ry);
    }
    return { x0: wx0, y0: wy0, x1: wx1, y1: wy1 };
  }

  // Click-to-add aims at the view centre. A fitted breadboard's centre is the
  // plastic channel, so the first part sits on the nearest row and each later
  // click steps along that row to the next free seat. A seat is free when
  // every pin is in an empty hole and the body does not cover another part.
  // A footprint at least 0.3" across (DIP ICs, tactile buttons, the DevKit)
  // may bridge the channel. Off the board — or when nothing free remains —
  // return a spot that does not sit on the breadboard body.
  function placeNewPart(parts, type, x, y, rot) {
    const snap = (v) => Math.round(v / G) * G;
    const sx = snap(x), sy = snap(y), r = rot || 0;
    const d = T[type];
    parts = parts || [];
    if (!d || type === 'label') return { x: sx, y: sy };
    const probe = { id: '_new', type, x: 0, y: 0, rot: r, props: JSON.parse(JSON.stringify(d.props || {})) };
    let localPins = [];
    try { localPins = d.pins(probe) || []; } catch (e) { localPins = []; }
    const offs = localPins.map((pin) => rotPt(pin.x, pin.y, r));
    const boards = parts.filter((p) => p.type === 'breadboard' && T.breadboard);
    const boxes = boards.map((p) => {
      const sz = T.breadboard.size(p);
      const corners = [[-8, -16], [sz.w + 4, -16], [sz.w + 4, sz.h + 16], [-8, sz.h + 16]];
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [a, b] of corners) {
        const [rx, ry] = rotPt(a, b, p.rot || 0);
        x0 = Math.min(x0, p.x + rx); y0 = Math.min(y0, p.y + ry); x1 = Math.max(x1, p.x + rx); y1 = Math.max(y1, p.y + ry);
      }
      return { x0, y0, x1, y1 };
    });
    const inside = (px, py) => boxes.some((b) => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1);
    const over = inside(sx, sy) || offs.some(([dx, dy]) => inside(sx + dx, sy + dy));
    const hits = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    function bodyOf(px, py) {
      let sz = { w: 10, h: 10 };
      try { sz = d.size(Object.assign({}, probe, { x: px, y: py })) || sz; } catch (e) { /* keep default */ }
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      const acc = (qx, qy) => { x0 = Math.min(x0, qx); y0 = Math.min(y0, qy); x1 = Math.max(x1, qx); y1 = Math.max(y1, qy); };
      for (const [a, b] of [[0, 0], [sz.w, 0], [0, sz.h], [sz.w, sz.h]]) { const [rx, ry] = rotPt(a, b, r); acc(px + rx, py + ry); }
      for (const [dx, dy] of offs) acc(px + dx, py + dy);
      if (!(x0 <= x1)) return { x0: px, y0: py, x1: px + G, y1: py + G };
      return { x0, y0, x1, y1 };
    }
    function freeSpot() {
      const others = [];
      for (const p of parts) {
        if (p.type === 'breadboard' || p.type === 'label' || !T[p.type] || !T[p.type].size) continue;
        let sz = { w: 10, h: 10 };
        try { sz = T[p.type].size(p) || sz; } catch (e) { /* keep default */ }
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const [a, b] of [[0, 0], [sz.w, 0], [0, sz.h], [sz.w, sz.h]]) {
          const [rx, ry] = rotPt(a, b, p.rot || 0);
          x0 = Math.min(x0, p.x + rx); y0 = Math.min(y0, p.y + ry); x1 = Math.max(x1, p.x + rx); y1 = Math.max(y1, p.y + ry);
        }
        others.push({ x0, y0, x1, y1 });
      }
      const clear = (px, py) => {
        if (offs.length ? offs.some(([dx, dy]) => inside(px + dx, py + dy)) : inside(px, py)) return false;
        const body = bodyOf(px, py);
        if (boxes.some((b) => hits(body, b)) || others.some((b) => hits(body, b))) return false;
        return true;
      };
      if (clear(sx, sy)) return { x: sx, y: sy };
      for (let rad = G; rad <= 900; rad += G) {
        for (let t = -rad; t <= rad; t += G) {
          for (const [px, py] of [[sx + t, sy - rad], [sx + t, sy + rad], [sx - rad, sy + t], [sx + rad, sy + t]]) {
            if (clear(px, py)) return { x: px, y: py };
          }
        }
      }
      return { x: sx, y: sy };
    }
    if (!boards.length || (!over && type !== 'breadboard')) return { x: sx, y: sy };
    if (type === 'breadboard' || !offs.length) return freeSpot();

    const holeAt = new Map();
    for (const p of boards) {
      for (const h of T.breadboard.pins(p)) {
        const w = pinWorld(p, h);
        const key = Math.round(w.x) + ',' + Math.round(w.y);
        if (holeAt.has(key)) continue;
        const row = /^([a-j])/.exec(h.name);
        holeAt.set(key, { x: Math.round(w.x), y: Math.round(w.y), side: row ? ('abcde'.includes(row[1]) ? 'a' : 'f') : 'rail', bb: p.id });
      }
    }
    const occupied = new Set();
    const footprints = [];
    for (const p of parts) {
      if (p.type === 'breadboard' || p.type === 'label' || !T[p.type]) continue;
      let ps = [];
      try { ps = T[p.type].pins(p) || []; } catch (e) { ps = []; }
      for (const pin of ps) { const w = pinWorld(p, pin); occupied.add(Math.round(w.x) + ',' + Math.round(w.y)); }
      const box = partBox(p); if (box) footprints.push(box);
    }
    const ys = offs.map((o) => o[1]);
    const span = ys.length ? Math.max.apply(null, ys) - Math.min.apply(null, ys) : 0;
    const mayStraddle = span >= 30;
    const seatOk = (ox, oy) => {
      const sides = new Map();
      for (const [dx, dy] of offs) {
        const key = Math.round(ox + dx) + ',' + Math.round(oy + dy), hit = holeAt.get(key);
        if (!hit || occupied.has(key)) return false;
        if (hit.side !== 'rail') {
          const prev = sides.get(hit.bb);
          if (prev && prev !== hit.side) { if (!mayStraddle) return false; sides.set(hit.bb, 'both'); }
          else if (!prev) sides.set(hit.bb, hit.side);
        }
      }
      const box = partBox(Object.assign({}, probe, { x: ox, y: oy }));
      return !(box && footprints.some((b) => hits(box, b)));
    };
    // Nearest row to the click, then the next rows. On a row, step to the
    // right of the click first so successive adds walk along the board.
    const rows = new Map();
    for (const h of holeAt.values()) { if (!rows.has(h.y)) rows.set(h.y, []); rows.get(h.y).push(h); }
    const rowYs = [...rows.keys()].sort((a, b) => Math.abs(a - sy) - Math.abs(b - sy) || a - b);
    const pin0 = offs[0];
    for (const rowY of rowYs) {
      const oy = rowY - pin0[1];
      const xs = []; const seenX = new Set();
      for (const h of rows.get(rowY)) {
        const ox = h.x - pin0[0];
        if (seenX.has(ox)) continue; seenX.add(ox); xs.push(ox);
      }
      xs.sort((a, b) => a - b);
      for (const ox of xs.filter((x) => x >= sx).concat(xs.filter((x) => x < sx).reverse())) {
        if (seatOk(ox, oy)) return { x: ox, y: oy };
      }
    }
    return freeSpot();
  }

  const api = { T, fmt, parseVal, parseProp, stampResistance, WIRE_R, scopeChannel, bands, espGpio, ESP_TOP, ESP_BOT, INPUT_ONLY, STRAPPING, ADC1, ADC2, rotPt, pinWorld, placeNewPart, G, VTH, esc, LEDCOL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Parts = api;
})(typeof window !== 'undefined' ? window : globalThis);
