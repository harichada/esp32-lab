/* Display parts (add-on file, see js/parts/registry.js): 20x4 I2C LCD, single 7-segment digit, TM1637 4-digit, MAX7219 8x8. */
(function (root) {
  const P = root.Parts, R = root.PartsReg, A = root.SDArt, esc = P.esc;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DEV = new Map();   // part id -> live device model (I2C)
  const CAT = 'Displays';

  // ---------- LCD 20x4 with PCF8574 backpack (same HD44780 model as the 16x2) ----------
  const ROWADDR = [0x00, 0x40, 0x14, 0x54];
  function lcdChar(d, r, c) { return d.ddram[(ROWADDR[r] + c) & 0x7f]; }
  function lcdDev(q) { const d = new root.I2CDev.LCD1602(20, 4); DEV.set(q.id, d); return d; }
  function lcdText(d) { let s = ''; for (let r = 0; r < 4; r++) { for (let c = 0; c < 20; c++) { const ch = lcdChar(d, r, c); s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; } s += '\n'; } return s; }
  function lcdImg(d, green) {   // 5x8 dot glyphs -> canvas data URL (cached per device version)
    if (typeof document === 'undefined' || !d.glyph) return null;
    if (d._img && d._imgV === d.version) return d._img;
    const c = document.createElement('canvas'); c.width = 20 * 6; c.height = 4 * 9; const g = c.getContext('2d');
    const bl = d.backlight, on = green ? '#13250a' : '#e9f1ff', off = green ? (bl ? '#93c435' : '#4d6421') : (bl ? '#2a57f0' : '#14234f');
    g.fillStyle = off; g.fillRect(0, 0, c.width, c.height);
    for (let r = 0; r < 4; r++) for (let col = 0; col < 20; col++) {
      const rows = d.disp ? d.glyph(lcdChar(d, r, col)) : new Array(8).fill(0);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 5; x++) { g.fillStyle = (rows[y] >> (4 - x)) & 1 ? on : (green ? '#86b52e' : '#2f5ef8'); g.fillRect(col * 6 + x, r * 9 + y, 1, 1); }
    }
    d._img = c.toDataURL(); d._imgV = d.version; return d._img;
  }
  R.register('lcd2004', {
    label: 'LCD 20×4 I2C (PCF8574 + HD44780)', cat: 'I2C / Displays', props: { addr: '0x27', addrs: ['0x27', '0x3F', '0x20', '0x21'], color: 'blue' }, prefix: 'LCD',
    edit: [{ k: 'addr', label: 'I2C address', t: 'sel', opts: ['0x27', '0x3F', '0x20', '0x21'] }, { k: 'color', label: 'Backlight', t: 'sel', opts: ['blue', 'green'] }],
    pins: () => A.row(['GND', 'VCC', 'SCL', 'SDA']), size: () => ({ w: 30, h: 10 }),
    svg(p) {
      const d = DEV.get(p.id), green = p.props.color === 'green', bl = d ? d.backlight : false, img = d ? lcdImg(d, green) : null;
      return A.hdr(4) + A.pcb(-46, -122, 222, 114, 'url(#aLcdPcb)', 4) + [[-40, -116], [170, -116], [-40, -14], [170, -14]].map(([x, y]) => A.mh(x, y, 3)).join('') +
        `<rect x="-34" y="-108" width="198" height="78" rx="2" fill="#16181b" stroke="#000"/><rect x="-28" y="-102" width="186" height="66" rx="1" fill="${green ? (bl ? '#9fd13a' : '#4d6421') : (bl ? '#2c5cff' : '#14234f')}"/>` +
        (img ? `<image href="${img}" x="-25" y="-99" width="180" height="60" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : '') +
        `<rect x="-28" y="-102" width="186" height="22" fill="url(#sdGloss)" opacity=".8" pointer-events="none"/>` + A.title(65, -126, `LCD2004 I2C ${p.props.addr}`) + A.lbls(['GND', 'VCC', 'SCL', 'SDA']) + A.dots(this.pins(p));
    },
    stamp(p, cx) { const v = cx.node(p, 'VCC'); cx.add({ kind: 'R', a: v, b: cx.node(p, 'GND'), r: 5 / 0.025, main: true }, p); cx.add({ kind: 'R', a: cx.node(p, 'SCL'), b: v, r: 10e3 }, p); cx.add({ kind: 'R', a: cx.node(p, 'SDA'), b: v, r: 10e3 }, p); },
    readout(p, cx) { const st = cx.state(p), d = DEV.get(p.id); return `${p.props.addr} · ${st.i2cInfo || 'no traffic yet'}${d ? ' · ' + JSON.stringify(lcdText(d).split('\n')[0].trimEnd()) : ''}`; },
    text: (p) => { const d = DEV.get(p.id); return d ? lcdText(d) : ''; },
  }, { i2c: lcdDev, bom: () => ({ key: 'lcd2004', name: 'LCD 20×4 with I2C backpack (PCF8574)', q: '2004 20x4 LCD I2C PCF8574 module' }) });

  // ---------- segment geometry shared by the 7-seg parts (digit box 24x40 at x,y) ----------
  const SEGP = { a: [[3, 0], [21, 0], [18, 3], [6, 3]], b: [[22, 1], [22, 19], [19, 17], [19, 4]], c: [[22, 21], [22, 39], [19, 36], [19, 23]], d: [[3, 40], [21, 40], [18, 37], [6, 37]], e: [[2, 21], [2, 39], [5, 36], [5, 23]], f: [[2, 1], [2, 19], [5, 17], [5, 4]], g: [[4, 20], [7, 18.4], [17, 18.4], [20, 20], [17, 21.6], [7, 21.6]] };
  const SEGN = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  function digitSvg(x, y, mask, col = '#ff3326', dp, sx = 1) {
    let s = '';
    for (let i = 0; i < 7; i++) {
      const on = (mask >> i) & 1, pts = SEGP[SEGN[i]].map(([u, v]) => `${x + (u + (40 - v) * 0.12) * sx},${y + v * sx}`).join(' ');
      s += `<polygon points="${pts}" fill="${on ? col : '#2a1414'}" ${on ? 'filter="url(#fGlow)"' : ''}/>`;
      if (on) s += `<polygon points="${pts}" fill="${col}"/>`;
    }
    if (dp !== undefined) s += `<circle cx="${x + 26 * sx}" cy="${y + 39 * sx}" r="${2 * sx}" fill="${dp ? col : '#2a1414'}"/>`;
    return s;
  }
  const FONT7 = { 0: 0x3f, 1: 0x06, 2: 0x5b, 3: 0x4f, 4: 0x66, 5: 0x6d, 6: 0x7d, 7: 0x07, 8: 0x7f, 9: 0x6f };

  // ---------- single 7-segment digit (common cathode / anode) : 8 real LED junctions in the circuit ----------
  const SEG_TOP = ['g', 'f', 'COM', 'a', 'b'], SEG_BOT = ['e', 'd', 'COM2', 'c', 'dp'];
  R.register('seg7', {
    label: '7-segment digit (0.56")', cat: CAT, props: { common: 'cathode', color: 'red' }, prefix: 'SEG',
    edit: [{ k: 'common', label: 'Common', t: 'sel', opts: ['cathode', 'anode'] }, { k: 'color', label: 'Colour', t: 'sel', opts: ['red', 'green', 'blue', 'yellow', 'white'] }],
    pins: () => [...SEG_BOT.map((n, i) => ({ name: n, x: i * 10, y: 0 })), ...SEG_TOP.map((n, i) => ({ name: n, x: i * 10, y: -70 }))],
    groups: () => [['COM', 'COM2']], size: () => ({ w: 40, h: 70 }),
    svg(p, st) {
      const b = (st && st.b) || {}, col = (P.LEDCOL[p.props.color] || P.LEDCOL.red)[0];
      let mask = 0; SEGN.forEach((n, i) => { if ((b[n] || 0) > 0.05) mask |= 1 << i; });
      return `<rect x="-6" y="-64" width="52" height="58" rx="2" fill="#1b1c1f" stroke="#000" filter="url(#fShadow)"/><rect x="-6" y="-64" width="52" height="58" rx="2" fill="url(#sdGloss)"/>` + digitSvg(6, -56, mask, col, (b.dp || 0) > 0.05) +
        SEG_BOT.map((n, i) => `<text x="${i * 10}" y="9" class="plbl small" text-anchor="middle">${n === 'COM2' ? 'C' : n}</text>`).join('') + SEG_TOP.map((n, i) => `<text x="${i * 10}" y="-74" class="plbl small" text-anchor="middle">${n === 'COM' ? 'C' : n}</text>`).join('') + A.dots(this.pins(p));
    },
    stamp(p, cx) {
      const st = cx.state(p), ca = p.props.common === 'anode', com = cx.node(p, 'COM'), d = root.Solver.diodeFromVf((P.LEDCOL[p.props.color] || P.LEDCOL.red)[1], 0.02, 2); st.els = {};
      for (const n of [...SEGN, 'dp']) { const s = cx.node(p, n); st.els[n] = cx.add({ kind: 'D', a: ca ? com : s, k: ca ? s : com, is: d.is, n: d.n }, p); }
    },
    measure(p, cx) { const st = cx.state(p); st.b = {}; st.i = {}; for (const n in st.els || {}) { const i = cx.I(st.els[n]); st.i[n] = i; st.b[n] = clamp(Math.sqrt(Math.max(0, i) / 0.01), 0, 1); } },
    digit(st) { let m = 0; SEGN.forEach((n, i) => { if ((st.b && st.b[n] || 0) > 0.05) m |= 1 << i; }); const k = Object.keys(FONT7).find((x) => FONT7[x] === m); return k === undefined ? null : +k; },
    readout(p, cx) { const st = cx.state(p), k = this.digit(st); return `shows ${k === null ? '?' : k} · ${SEGN.filter((n) => (st.b && st.b[n] || 0) > 0.05).join('') || 'all off'}`; },
    warn(p, cx) { const st = cx.state(p); for (const n in st.i || {}) if (st.i[n] > 0.03) return `segment ${n} overcurrent (${P.fmt(st.i[n], 'A')}) — add a resistor per segment`; },
  }, { bom: (pr) => ({ key: 'seg7' + pr.common, name: '7-segment display 0.56" common ' + pr.common, q: '0.56 inch 7 segment display common ' + pr.common }) });

  // ---------- TM1637 4-digit display (CLK/DIO 2-wire, bit-banged by TM1637Display) ----------
  const lvl = (c, p, n) => { const d = c.drive(p, n); return d === null ? 1 : d; };   // open-drain bus with module pull-ups
  R.register('tm1637', {
    label: 'TM1637 4-digit display', cat: CAT, props: {}, prefix: 'TM',
    pins: () => A.row(['CLK', 'DIO', 'VCC', 'GND']), size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      st = st || {}; const seg = st.seg || [0, 0, 0, 0], on = st.on, br = on ? 0.45 + 0.08 * (st.bright || 0) : 0;
      let s = A.hdr(4) + A.pcb(-52, -66, 134, 58, 'url(#sdPcbBlue)') + A.mh(-48, -62, 1.8) + A.mh(78, -62, 1.8) + A.mh(-48, -12, 1.8) + A.mh(78, -12, 1.8) + `<rect x="-42" y="-60" width="114" height="44" rx="2" fill="#141518" stroke="#000"/>`;
      for (let i = 0; i < 4; i++) s += `<g opacity="${on ? clamp(br, 0.3, 1) : 1}">${digitSvg(-36 + i * 27, -56, on ? seg[i] & 0x7f : 0, '#ff3326', undefined, 0.85)}</g>`;
      const colon = on && (seg[1] & 0x80); s += `<circle cx="16" cy="-44" r="1.8" fill="${colon ? '#ff3326' : '#2a1414'}"/><circle cx="16" cy="-30" r="1.8" fill="${colon ? '#ff3326' : '#2a1414'}"/>`;
      return s + A.title(15, -70, 'TM1637') + A.lbls(['CLK', 'DIO', 'VCC', 'GND']) + A.dots(this.pins(p));
    },
    stamp(p, cx) { const st = cx.state(p), v = cx.node(p, 'VCC'); load(cx, p); cx.add({ kind: 'R', a: cx.node(p, 'CLK'), b: v, r: 10e3 }, p); cx.add({ kind: 'R', a: cx.node(p, 'DIO'), b: v, r: 10e3 }, p); if (st.ack) cx.add({ kind: 'R', a: cx.node(p, 'DIO'), b: cx.node(p, 'GND'), r: 60 }, p); },
    espStep(p, c) {
      const st = c.state(p); if (!st.seg) { st.seg = [0, 0, 0, 0, 0, 0]; st.addr = 0; }
      const clk = lvl(c, p, 'CLK'), dio = st.ack ? 0 : lvl(c, p, 'DIO'), pc = st.pc === undefined ? 1 : st.pc, pd = st.pd === undefined ? 1 : st.pd;
      if (clk && pc && pd && !dio) { st.inTx = true; st.bits = 0; st.byte = 0; st.first = true; }   // START
      else if (clk && pc && !pd && dio) { st.inTx = false; }                                          // STOP
      else if (st.inTx && !pc && clk) {                                                               // CLK rising: sample
        if (st.bits < 8) { st.byte |= (dio & 1) << st.bits; st.bits++; } else { st.bits = 9; }
      } else if (st.inTx && pc && !clk) {                                                             // CLK falling
        if (st.bits === 8 && !st.ack) { this.onByte(st, st.byte); st.ack = true; }
        else if (st.bits === 9) { st.ack = false; st.bits = 0; st.byte = 0; }
      }
      st.pc = clk; st.pd = st.ack ? (c.drive(p, 'DIO') === null ? 1 : c.drive(p, 'DIO')) : dio;
    },
    onByte(st, b) {
      if (st.first) { st.first = false; if ((b & 0xc0) === 0x40) { st.auto = !(b & 4); return; } if ((b & 0xc0) === 0x80) { st.on = !!(b & 8); st.bright = b & 7; st.frames = (st.frames || 0) + 1; return; } if ((b & 0xc0) === 0xc0) { st.addr = b & 7; return; } }
      if (st.addr < 6) st.seg[st.addr] = b; if (st.auto !== false) st.addr++;
    },
    text(st) { return (st.seg || []).slice(0, 4).map((m) => { const k = Object.keys(FONT7).find((x) => FONT7[x] === (m & 0x7f)); return k === undefined ? (m & 0x7f ? '?' : ' ') : k; }).join(''); },
    readout(p, cx) { const st = cx.state(p); return st.frames ? `"${this.text(st)}" · brightness ${st.bright}/7 ${st.on ? 'ON' : 'OFF'}` : 'no data yet (TM1637Display)'; },
  }, { bom: () => ({ key: 'tm1637', name: 'TM1637 4-digit 7-segment display module', q: 'TM1637 4 digit 7 segment display module' }) });

  // ---------- MAX7219 8x8 LED matrix (DIN/CS/CLK, 16-bit frames latched on CS rising) ----------
  R.register('max7219', {
    label: 'MAX7219 8×8 LED matrix', cat: CAT, props: { color: 'red' }, prefix: 'MTX',
    edit: [{ k: 'color', label: 'LED colour', t: 'sel', opts: ['red', 'green', 'blue', 'yellow', 'white'] }],
    pins: () => A.row(['VCC', 'GND', 'DIN', 'CS', 'CLK']), size: () => ({ w: 40, h: 10 }),
    svg(p, st) {
      st = st || {}; const rows = st.rows || [], on = st.on && !st.test, col = (P.LEDCOL[p.props.color] || P.LEDCOL.red)[0], op = 0.35 + 0.65 * ((st.intensity || 0) + 1) / 16;
      let s = A.hdr(5) + A.pcb(-14, -98, 68, 90, 'url(#sdPcbBlue)') + `<rect x="-10" y="-94" width="60" height="60" rx="1" fill="#101113" stroke="#000"/>`;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const lit = st.test || (on && ((rows[r] || 0) >> (7 - c)) & 1), x = -5.5 + c * 7.3, y = -89.5 + r * 7.3;
        s += lit ? `<circle cx="${x + 1}" cy="${y + 1}" r="4.4" fill="${col}" opacity="${op * 0.5}" filter="url(#fGlow)"/><circle cx="${x + 1}" cy="${y + 1}" r="2.9" fill="${col}" opacity="${op}"/>` : `<circle cx="${x + 1}" cy="${y + 1}" r="2.9" fill="#2a2b2f"/>`;
      }
      return s + A.chip(4, -30, 32, 10, 'MAX7219') + A.title(20, -102, 'MAX7219 8×8') + A.lbls(['VCC', 'GND', 'DIN', 'CS', 'CLK']) + A.dots(this.pins(p));
    },
    stamp(p, cx) { const st = cx.state(p), lit = (st.rows || []).reduce((a, r) => a + bitc(r), 0); cx.add({ kind: 'R', a: cx.node(p, 'VCC'), b: cx.node(p, 'GND'), r: 5 / (0.002 + 0.0025 * lit), main: true }, p); },
    espStep(p, c) {
      const st = c.state(p); if (!st.rows) { st.rows = [0, 0, 0, 0, 0, 0, 0, 0]; st.sr = 0; st.n = 0; }
      const clk = c.drive(p, 'CLK'), cs = c.drive(p, 'CS'), din = c.drive(p, 'DIN');
      if (cs === 0 && st.pcs === 1) { st.sr = 0; st.n = 0; }
      if (cs === 0 && st.pclk === 0 && clk === 1) { st.sr = ((st.sr << 1) | (din ? 1 : 0)) & 0xffff; st.n++; }
      if (cs === 1 && st.pcs === 0 && st.n >= 16) {
        const reg = (st.sr >> 8) & 15, v = st.sr & 255;
        if (reg >= 1 && reg <= 8) st.rows[reg - 1] = v; else if (reg === 0x0a) st.intensity = v & 15; else if (reg === 0x0c) st.on = !!(v & 1); else if (reg === 0x0f) st.test = !!(v & 1); else if (reg === 0x0b) st.scan = v & 7;
        st.frames = (st.frames || 0) + 1;
      }
      st.pclk = clk; st.pcs = cs;
    },
    readout(p, cx) { const st = cx.state(p); return st.frames ? `${st.frames} frames · ${st.on ? 'on' : 'shutdown'} · intensity ${st.intensity || 0}` : 'no data yet (LedControl / shiftOut)'; },
  }, { bom: () => ({ key: 'max7219', name: 'MAX7219 8×8 LED matrix module', q: 'MAX7219 8x8 dot matrix module' }) });
  function bitc(v) { let n = 0; while (v) { n += v & 1; v >>= 1; } return n; }
  function load(cx, p, ma = 20) { cx.add({ kind: 'R', a: cx.node(p, 'VCC'), b: cx.node(p, 'GND'), r: 5 / (ma / 1000), main: true }, p); }
  root.SDDisplays = { DEV, lcdText, digitSvg, FONT7 };
})(typeof window !== 'undefined' ? window : globalThis);
