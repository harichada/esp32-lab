/* Realistic part artwork (first-party SVG). Overrides only the svg() of existing parts (pins/hit areas untouched) and adds the 4x4 keypad. */
(function (root) {
  const P = root.Parts, T = P.T, esc = P.esc, G = 10;
  const dots = (pins) => pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join('');
  const DEFS = `
<linearGradient id="aPcbBlk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f36"/><stop offset="1" stop-color="#15171b"/></linearGradient>
<linearGradient id="aShield" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1f3f5"/><stop offset=".35" stop-color="#c7cdd3"/><stop offset=".6" stop-color="#dde1e5"/><stop offset="1" stop-color="#9aa2ab"/></linearGradient>
<linearGradient id="aGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7dd84"/><stop offset="1" stop-color="#b8892a"/></linearGradient>
<linearGradient id="aLeadV" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8d949c"/><stop offset=".5" stop-color="#eef1f4"/><stop offset="1" stop-color="#8d949c"/></linearGradient>
<linearGradient id="aBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a7fd8"/><stop offset="1" stop-color="#1f56a8"/></linearGradient>
<linearGradient id="aServo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d7fe0"/><stop offset="1" stop-color="#174a9c"/></linearGradient>
<linearGradient id="aPurple" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a3fb3"/><stop offset="1" stop-color="#4c2275"/></linearGradient>
<linearGradient id="aMpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6fd1"/><stop offset="1" stop-color="#1c4a93"/></linearGradient>
<linearGradient id="aLcdPcb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c8a43"/><stop offset="1" stop-color="#0f5f2b"/></linearGradient>
<linearGradient id="aOledPcb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2459b8"/><stop offset="1" stop-color="#173c80"/></linearGradient>
<radialGradient id="aDome" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".35" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
<radialGradient id="aCap" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></radialGradient>
<radialGradient id="aBuz" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#4a4f57"/><stop offset="1" stop-color="#0d0e10"/></radialGradient>
<linearGradient id="aKeyB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b9cf0"/><stop offset="1" stop-color="#2f6bc4"/></linearGradient>
<linearGradient id="aKeyR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0625b"/><stop offset="1" stop-color="#c4302a"/></linearGradient>
<linearGradient id="aKpBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d4148"/><stop offset="1" stop-color="#26292e"/></linearGradient>`;
  function injectDefs() { const d = document.querySelector('#stage defs'); if (d && !d.querySelector('#aGold')) d.insertAdjacentHTML('beforeend', DEFS); }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectDefs); else injectDefs(); }
  // generic male header row: black plastic + gold pin tops
  const header = (xs, y) => xs.map((x) => `<rect x="${x - 4.6}" y="${y - 4.6}" width="9.2" height="9.2" rx=".8" fill="#17181b" stroke="#000" stroke-width=".4"/><rect x="${x - 2}" y="${y - 2}" width="4" height="4" rx=".5" fill="url(#aGold)"/>`).join('');
  const silk = (x, y, t, sz = 4.2, anchor = 'middle', rot) => `<text x="${x}" y="${y}" font-size="${sz}" fill="#f2f2f2" font-family="ui-monospace,Menlo,monospace" text-anchor="${anchor}"${rot !== undefined ? ` transform="rotate(${rot} ${x} ${y})"` : ''} pointer-events="none">${esc(t)}</text>`;
  const hole = (x, y, r = 2.6) => `<circle cx="${x}" cy="${y}" r="${r + 1}" fill="url(#aGold)"/><circle cx="${x}" cy="${y}" r="${r}" fill="#0d0f12"/>`;

  // ---------- ESP32 DevKit V1 ----------
  T.esp32.svg = function (p, st) {
    const ET = P.ESP_TOP, EB = P.ESP_BOT, xs = ET.map((_, i) => i * G);
    let s = `<rect x="-13" y="-8" width="168" height="106" rx="5" fill="url(#aPcbBlk)" stroke="#07080a" stroke-width=".8" filter="url(#fShadow)"/>`;
    s += `<rect x="-11" y="-6" width="164" height="102" rx="4" fill="none" stroke="#ffffff10" stroke-width=".8"/>`;
    [[-8, -3], [150, -3], [-8, 93], [150, 93]].forEach(([x, y]) => { s += hole(x, y, 1.8); });
    s += header(xs, 0) + header(xs, 90);
    // micro-USB
    s += `<rect x="-26" y="33" width="24" height="24" rx="2" fill="url(#aShield)" stroke="#6c737c" stroke-width=".6"/><rect x="-26" y="38" width="5" height="14" rx="1" fill="#24272c"/><rect x="-22" y="40.5" width="15" height="9" rx="1.5" fill="#101215"/><rect x="-20" y="43.6" width="11" height="2.6" rx=".6" fill="#c9a227"/>`;
    // AMS1117 regulator (SOT-223) + CP2102 bridge + passives
    s += `<rect x="2" y="24" width="14" height="10" rx=".8" fill="#1d1f23" stroke="#3a3e45" stroke-width=".5"/><rect x="5" y="20.5" width="8" height="3.5" fill="#c3c8ce"/>${[4, 9, 14].map((x) => `<rect x="${x - 1}" y="34" width="2" height="2.5" fill="#c3c8ce"/>`).join('')}${silk(9, 30.5, 'AMS1117', 2.4)}`;
    s += `<rect x="21" y="40" width="15" height="15" rx="1" fill="#1d1f23" stroke="#3a3e45" stroke-width=".5"/><circle cx="23.5" cy="42.5" r=".8" fill="#555"/>${silk(28.5, 48.8, 'CP2102', 2.3)}`;
    for (let i = 0; i < 6; i++) s += `<rect x="${40 + (i % 3) * 7}" y="${22 + Math.floor(i / 3) * 6}" width="4" height="2.2" rx=".4" fill="${i % 2 ? '#a77b3d' : '#5d636b'}"/>`;
    // EN / BOOT buttons
    for (const [x, t] of [[10, 'EN'], [70, 'BOOT']]) s += `<rect x="${x - 6}" y="60" width="12" height="12" rx="1" fill="url(#aShield)" stroke="#6c737c" stroke-width=".5"/><circle cx="${x}" cy="66" r="3.6" fill="#1b1c1f" stroke="#000" stroke-width=".4"/><circle cx="${x - 1}" cy="65" r="1.4" fill="#fff" opacity=".18"/>${silk(x, 80, t, 3.6)}`;
    // LEDs: blue GPIO2, red power
    const led2 = st && st.pinLevel ? st.pinLevel[2] : 0;
    s += `<rect x="27" y="64" width="6" height="4" rx=".6" fill="${led2 ? '#9cd0ff' : '#28405e'}"/><circle cx="30" cy="66" r="9" fill="#4aa3ff" opacity="${led2 ? 0.65 : 0}" filter="url(#fGlow)" pointer-events="none"/>${silk(30, 75, 'IO2', 3)}`;
    s += `<rect x="43" y="64" width="6" height="4" rx=".6" fill="#ff5a4e"/><circle cx="46" cy="66" r="6" fill="#ff3b30" opacity=".5" filter="url(#fGlow)" pointer-events="none"/>${silk(46, 75, 'PWR', 3)}`;
    s += `<text x="58" y="46" font-size="9" font-weight="700" fill="#f4f4f4" text-anchor="middle" font-family="Inter,system-ui,sans-serif" pointer-events="none">ESP32</text>${silk(58, 54, 'DEVKIT V1', 3.6)}`;
    // WROOM module: shield can + PCB antenna
    s += `<rect x="88" y="7" width="66" height="76" rx="1.5" fill="#20242a" stroke="#000" stroke-width=".5"/>`;
    s += `<rect x="92" y="12" width="50" height="66" rx="1.6" fill="url(#aShield)" stroke="#7d8590" stroke-width=".6"/><rect x="94" y="14" width="46" height="62" rx="1" fill="none" stroke="#ffffff80" stroke-width=".5"/>`;
    s += `<circle cx="117" cy="30" r="6.5" fill="none" stroke="#6f7781" stroke-width="1"/><path d="M113 30 a4 4 0 0 1 8 0 M114.5 32.5 a2.6 2.6 0 0 1 5 0" stroke="#6f7781" stroke-width=".8" fill="none"/>`;
    s += `<text x="117" y="46" font-size="5" font-weight="700" fill="#4a5059" text-anchor="middle" font-family="Inter,system-ui,sans-serif" pointer-events="none">ESP32-WROOM-32</text><text x="117" y="53" font-size="3.3" fill="#5d646d" text-anchor="middle" font-family="ui-monospace,monospace" pointer-events="none">ESPRESSIF · FCC ID 2AC7Z</text><rect x="109" y="58" width="16" height="12" rx="1" fill="none" stroke="#6f7781" stroke-width=".5"/><text x="117" y="66" font-size="5" fill="#5d646d" text-anchor="middle" pointer-events="none">CE</text>`;
    s += `<rect x="143" y="10" width="13" height="70" fill="#1a2a3a" opacity=".55"/><path d="M146 14 h8 v6 h-6 v6 h6 v6 h-6 v6 h6 v6 h-6 v6 h6 v6 h-6 v6 h6 v8" stroke="url(#aGold)" stroke-width="1.6" fill="none"/>`;
    ET.forEach((n, i) => { s += `<rect x="${i * G - 3.5}" y="-3.5" width="7" height="7" class="pin espp" style="fill:transparent;stroke:none" data-pin="${n}"/>` + silk(i * G, 7.5, n, 3.6, 'end', -90); });
    EB.forEach((n, i) => { s += `<rect x="${i * G - 3.5}" y="86.5" width="7" height="7" class="pin espp" style="fill:transparent;stroke:none" data-pin="${n}"/>` + silk(i * G, 82.5, n, 3.6, 'start', -90); });
    return s;
  };

  // ---------- LEDs (5 mm dome) ----------
  for (const type of ['led', 'irled']) {
    const isIR = type === 'irled';
    T[type].svg = function (p, st) {
      const col = isIR ? '#6b55d6' : (P.LEDCOL[p.props.color] || P.LEDCOL.red)[0];
      const b = st ? st.bright || 0 : 0, burned = st && st.burned, c = burned ? '#3a3a3a' : col;
      let s = `<path d="M0 0 V-9" stroke="url(#aLeadV)" stroke-width="1.6"/><path d="M10 0 V-7 l-1.5 -2" stroke="url(#aLeadV)" stroke-width="1.6" fill="none"/>`;
      if (b > 0.01 && !burned) s += `<circle cx="5" cy="-19" r="${10 + 18 * b}" style="fill:${isIR ? '#b49cff' : col};opacity:${(isIR ? 0.3 : 0.7) * b}" filter="url(#fGlow)" pointer-events="none"/>`;
      s += `<path d="M-2.5 -8.5 h15 v-11.5 a7.5 7.5 0 0 0 -15 0 z" fill="${c}" opacity="${burned ? 1 : 0.62 + 0.38 * b}" stroke="#0005" stroke-width=".5" class="led-body"/>`;
      s += `<path d="M-2.5 -8.5 h15 v-11.5 a7.5 7.5 0 0 0 -15 0 z" fill="url(#aDome)" pointer-events="none"/>`;
      s += `<path d="M1 -11 h2 v-4 l-1 -1.5 h-1 z M7 -11 h2 v-5 h-3 l1 1.5 z" fill="#0004" pointer-events="none"/>`;
      if (b > 0.01 && !burned) s += `<circle cx="5" cy="-17" r="${2 + 3.5 * b}" style="fill:#fff;opacity:${0.85 * b}" filter="url(#fGlow)" pointer-events="none"/>`;
      s += `<rect x="-3.5" y="-9.6" width="17" height="2.6" rx=".8" fill="${c}" stroke="#0005" stroke-width=".4"/><rect x="10.5" y="-9.6" width="3" height="2.6" fill="#0003"/>`;
      if (isIR) { s += `<text x="5" y="-31" class="plbl">IR</text>`; if (b > 0.02 && !burned) s += `<g class="ir-arcs" style="opacity:${0.3 + 0.7 * b}">${[0, 1, 2].map((k) => `<path d="M${14 + k * 5} ${-26 - k * 4} a${8 + k * 5} ${8 + k * 5} 0 0 1 0 ${12 + k * 8}" style="animation-delay:${k * 0.18}s"/>`).join('')}</g>`; }
      if (burned) s += `<g class="smoke"><circle cx="5" cy="-32" r="5"/><circle cx="9" cy="-42" r="6"/><circle cx="3" cy="-52" r="7"/></g>`;
      return s + dots(this.pins(p)) + `<text x="-4" y="9" class="plbl small">A</text><text x="14" y="9" class="plbl small">C</text>`;
    };
  }

  // ---------- resistor (beige body, 4 bands) ----------
  T.resistor.svg = function (p) {
    const b = P.bands(P.parseVal(p.props.r));
    let s = `<line x1="0" y1="0" x2="40" y2="0" stroke="#aeb4bb" stroke-width="1.6"/><path d="M8 -4.6 q0 -1.4 2.2 -1.4 h3 q2 0 3 1.3 h8 q1 -1.3 3 -1.3 h3 q2.2 0 2.2 1.4 v9.2 q0 1.4 -2.2 1.4 h-3 q-2 0 -3 -1.3 h-8 q-1 1.3 -3 1.3 h-3 q-2.2 0 -2.2 -1.4 z" fill="url(#gRes)" stroke="#8a6d3b" stroke-width=".4" filter="url(#fShadow)"/>`;
    const bx = [10.6, 15.4, 20.2, 27.4];
    b.forEach((c, i) => { const full = i === 0 || i === 3; s += `<rect x="${bx[i]}" y="${full ? -5.8 : -4.6}" width="2.6" height="${full ? 11.6 : 9.2}" style="fill:${c}"/>`; });
    s += `<rect x="8.5" y="-5.6" width="23" height="4.6" rx="2" fill="url(#gGloss)" opacity=".75" pointer-events="none"/>`;
    return s + dots(this.pins(p)) + `<text x="20" y="-9" class="plbl">${esc(P.fmt(P.parseVal(p.props.r), 'Ω'))}</text>`;
  };

  // ---------- pushbuttons (12 mm tactile, coloured cap) ----------
  const CAPS = { red: '#e53935', green: '#2e9e4f', blue: '#2f6fd6', yellow: '#f4c430', black: '#2a2d33', white: '#ececec' };
  const capOf = (p) => CAPS[p.props.color] || CAPS[/up|plus|\+/i.test(p.props.label || '') ? 'green' : /down|minus/i.test(p.props.label || '') ? 'blue' : 'red'];
  T.pushbutton.props = Object.assign({ color: 'red' }, T.pushbutton.props);
  T.pushbutton.edit = [...T.pushbutton.edit, { k: 'color', label: 'Cap colour', t: 'sel', opts: Object.keys(CAPS) }];
  T.pushbutton.svg = function (p, st) {
    const pr = st && st.pressed, cap = capOf(p);
    let s = `<rect x="-6" y="1" width="32" height="28" rx="2.5" fill="url(#aShield)" stroke="#6c737c" stroke-width=".6" filter="url(#fShadow)"/><rect x="-3.5" y="3.5" width="27" height="23" rx="1.5" fill="#1c1e22"/>`;
    s += [[-1.5, 6], [21.5, 6], [-1.5, 24], [21.5, 24]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.3" fill="#555b63"/>`).join('');
    s += `<circle cx="10" cy="15" r="9.6" fill="#0b0c0e"/><circle cx="10" cy="${pr ? 15.6 : 15}" r="${pr ? 7.3 : 8}" fill="${cap}" class="pb-cap ${pr ? 'down' : ''}"/><circle cx="10" cy="${pr ? 15.6 : 15}" r="${pr ? 7.3 : 8}" fill="url(#aCap)" opacity="${pr ? 0.5 : 1}" pointer-events="none"/>`;
    return s + dots(this.pins(p)) + (p.props.label ? `<text x="10" y="40" class="plbl">${esc(p.props.label)}</text>` : '') + (p.props.key ? `<text x="10" y="18" class="pb-key">${esc(p.props.key)}</text>` : '');
  };
  T.key.props = Object.assign({ color: '' }, T.key.props);
  T.key.edit = [...T.key.edit, { k: 'color', label: 'Cap colour', t: 'sel', opts: ['', ...Object.keys(CAPS)] }];
  T.key.svg = function (p, st) {
    const pr = st && st.pressed, cap = capOf(p);
    let s = `<line x1="0" y1="0" x2="30" y2="0" stroke="#aeb4bb" stroke-width="1.6"/><rect x="2" y="-12" width="26" height="22" rx="2.5" fill="url(#aShield)" stroke="#6c737c" stroke-width=".6" filter="url(#fShadow)"/><rect x="4" y="-10" width="22" height="18" rx="1.6" fill="#1c1e22"/>`;
    s += `<circle cx="15" cy="${pr ? -0.4 : -1}" r="${pr ? 6.4 : 7}" fill="${cap}"/><circle cx="15" cy="${pr ? -0.4 : -1}" r="${pr ? 6.4 : 7}" fill="url(#aCap)" opacity="${pr ? 0.5 : 1}" pointer-events="none"/>`;
    return s + (p.props.label ? `<text x="15" y="-15" class="plbl">${esc(p.props.label)}</text>` : '') + (p.props.key ? `<text x="15" y="20" class="pb-key2">${esc(p.props.key)}</text>` : '') + dots(this.pins(p));
  };

  // ---------- potentiometer (blue trimmer body + ridged knob) ----------
  T.potentiometer.svg = function (p) {
    const a = -135 + 270 * (+p.props.pos);
    let s = [0, 10, 20].map((v) => `<line x1="${v}" y1="0" x2="${v}" y2="-6" stroke="url(#aLeadV)" stroke-width="1.8"/>`).join('');
    s += `<rect x="-7" y="-32" width="34" height="27" rx="3" fill="url(#aBlue)" stroke="#123a75" stroke-width=".6" filter="url(#fShadow)"/><circle cx="10" cy="-18" r="11.5" fill="#d9dde2" stroke="#8b939c" stroke-width=".6"/>`;
    s += `<g transform="rotate(${a} 10 -18)"><circle cx="10" cy="-18" r="9.4" fill="url(#gKnob)"/>${Array.from({ length: 24 }, (_, k) => `<line x1="10" y1="-27.4" x2="10" y2="-25.6" stroke="#000a" stroke-width=".7" transform="rotate(${k * 15} 10 -18)"/>`).join('')}<circle cx="10" cy="-18" r="6" fill="#2a2f37" stroke="#4a525d" stroke-width=".5"/><rect x="9" y="-26" width="2" height="7" rx="1" fill="#f2f2f2"/></g>`;
    return s + dots(this.pins(p)) + `<text x="10" y="-36" class="plbl">${Math.round(p.props.pos * 100)}%</text>`;
  };

  // ---------- buzzer / piezo ----------
  T.buzzer.svg = function (p, st) {
    const on = st && st.on;
    let s = `<line x1="0" y1="0" x2="0" y2="-6" stroke="url(#aLeadV)" stroke-width="1.6"/><line x1="20" y1="0" x2="20" y2="-6" stroke="url(#aLeadV)" stroke-width="1.6"/>`;
    s += `<circle cx="10" cy="-19" r="14" fill="url(#aBuz)" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/><circle cx="10" cy="-19" r="10.5" fill="none" stroke="#ffffff14" stroke-width="1.2"/><circle cx="10" cy="-19" r="3" fill="#050506" stroke="#3a3e45" stroke-width=".6"/><text x="-0.5" y="-23" font-size="6" fill="#bbb" pointer-events="none">+</text>`;
    if (on) s += `<g class="buz-wave"><path d="M29 -29 q6 10 0 20 M34 -33 q9 14 0 28"/></g><circle cx="10" cy="-19" r="16" fill="#ffd84a" opacity=".15" filter="url(#fGlow)"/>`;
    return s + dots(this.pins(p)) + `<text x="-3" y="9" class="plbl small">+</text>`;
  };

  // ---------- I2C modules ----------
  const i2cLbls = (y, anchorPins) => ['GND', 'VCC', 'SCL', 'SDA'].map((n, i) => silk(i * 10, y, n, 3.4, 'start', -90)).join('');
  function i2cWrap(type, body) { T[type].svg = function (p, st) { return body(p, st || {}) + dots(this.pins(p)); }; }
  i2cWrap('ssd1306', (p, st) => {
    let s = `<rect x="-6" y="-82" width="142" height="80" rx="4" fill="url(#aOledPcb)" stroke="#0d2350" stroke-width=".6" filter="url(#fShadow)"/>`;
    [[-1, -77], [131, -77], [-1, -7], [131, -7]].forEach(([x, y]) => { s += hole(x, y, 2); });
    s += header([0, 10, 20, 30], 0).replace(/y="-4.6"/g, 'y="-4.6"');
    s += `<rect x="-2" y="-74" width="134" height="58" rx="2" fill="#0a0b0d" stroke="#000" stroke-width=".6"/><rect x="2" y="-71" width="126" height="52" fill="#020304"/>`;
    s += st.img ? `<image href="${st.img}" x="2" y="-71" width="126" height="52" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : '';
    s += `<rect x="40" y="-16" width="50" height="6" fill="#c9a227" opacity=".55"/>`;
    s += ['GND', 'VCC', 'SCL', 'SDA'].map((n, i) => silk(i * 10, -7.5, n, 3.2)).join('') + `<text x="65" y="-86" class="plbl">SSD1306 ${esc(p.props.addr)}</text>`;
    return s;
  });
  function breakout(type, grad, chipW, name, extra) {
    i2cWrap(type, (p) => {
      let s = `<rect x="-7" y="-48" width="44" height="44" rx="3" fill="url(#${grad})" stroke="#0006" stroke-width=".6" filter="url(#fShadow)"/>`;
      s += hole(-1.5, -42.5, 2) + hole(31.5, -42.5, 2);
      s += header([0, 10, 20, 30], 0);
      s += `<rect x="${15 - chipW / 2}" y="${-30 - chipW / 2}" width="${chipW}" height="${chipW}" rx="1" fill="${type === 'bme280' ? '#c8ccd1' : '#17191c'}" stroke="#555" stroke-width=".5"/>${type === 'bme280' ? '<circle cx="18" cy="-27" r="1" fill="#333"/>' : '<circle cx="9.5" cy="-35.5" r=".8" fill="#666"/>'}`;
      s += `<rect x="1" y="-20" width="3" height="1.8" fill="#a77b3d"/><rect x="26" y="-20" width="3" height="1.8" fill="#5d636b"/>`;
      s += silk(15, -14, name, 3.6) + ['GND', 'VCC', 'SCL', 'SDA'].map((n, i) => silk(i * 10, -7, n, 2.8)).join('') + (extra ? extra(p) : '');
      return s;
    });
  }
  breakout('bme280', 'aPurple', 8, 'BME280', (p) => `<text x="15" y="-52" class="plbl">BME280 ${(+p.props.temp).toFixed(1)}°C</text>`);
  breakout('mpu6050', 'aMpu', 11, 'GY-521', () => `<text x="15" y="-52" class="plbl">MPU6050</text><path d="M27 -44 v6 m-2 -4 l2 -2 l2 2 M27 -44 h-6" stroke="#fff" stroke-width=".5" fill="none" opacity=".8"/>`);

  // ---------- LCD 16x2 (I2C backpack) ----------
  i2cWrap('lcd1602', (p, st) => {
    const green = p.props.color === 'green', bl = st.bl;
    const bg = green ? (bl ? '#a6d93f' : '#55702a') : (bl ? '#3a6dff' : '#18286a'), cell = green ? '#0000000f' : '#ffffff12';
    let s = `<rect x="-38" y="-96" width="186" height="92" rx="3" fill="url(#aLcdPcb)" stroke="#0a4a20" stroke-width=".6" filter="url(#fShadow)"/>`;
    [[-32, -90], [142, -90], [-32, -10], [142, -10]].forEach(([x, y]) => { s += hole(x, y, 3); });
    for (let i = 0; i < 16; i++) s += `<circle cx="${-14 + i * 8}" cy="-90" r="2" fill="url(#aGold)"/><circle cx="${-14 + i * 8}" cy="-90" r="1" fill="#0d0f12"/>`;
    s += `<rect x="-26" y="-82" width="162" height="58" rx="2.5" fill="#101114" stroke="#000" stroke-width=".6"/>`;
    s += `<rect x="-20" y="-76" width="150" height="46" rx="1.5" fill="${bg}"/>`;
    if (bl) s += `<rect x="-20" y="-76" width="150" height="46" rx="1.5" fill="${bg}" opacity=".5" filter="url(#fGlow)" pointer-events="none"/>`;
    if (!st.img) for (let r = 0; r < 2; r++) for (let c = 0; c < 16; c++) s += `<rect x="${-15 + c * 140 / 16 + 0.6}" y="${-71 + r * 19}" width="${140 / 16 - 1.6}" height="16" fill="${cell}"/>`;
    s += st.img ? `<image href="${st.img}" x="-15" y="-71" width="140" height="36" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : '';
    s += `<rect x="-20" y="-76" width="150" height="12" fill="url(#gGloss)" opacity=".18" pointer-events="none"/>`;
    // PCF8574 backpack edge + header
    s += `<rect x="-6" y="-14" width="42" height="9" rx="1" fill="#1b1c20"/>` + ['GND', 'VCC', 'SDA', 'SCL'].map((n, i) => silk(i * 10, -16.5, ['GND', 'VCC', 'SCL', 'SDA'][i], 3)).join('');
    s += `<text x="55" y="-100" class="plbl">LCD1602 I2C ${esc(p.props.addr)}</text>`;
    return s;
  });

  // ---------- Servo SG90 ----------
  T.servo.svg = function (p, st) {
    st = st || {}; const a = st.angle !== undefined ? st.angle : 90, rot = 90 - a;
    let s = `<path d="M0 0 V-12" stroke="#6b4426" stroke-width="2.4"/><path d="M10 0 V-12" stroke="#d0342c" stroke-width="2.4"/><path d="M20 0 V-12" stroke="#f2a12a" stroke-width="2.4"/><rect x="-3" y="-16" width="26" height="6" rx="1" fill="#1b1c1f"/>`;
    s += `<rect x="-33" y="-45" width="86" height="9" rx="2" fill="url(#aServo)" stroke="#0d3375" stroke-width=".6"/><circle cx="-28" cy="-40.5" r="2.2" fill="#0b2a5c"/><circle cx="48" cy="-40.5" r="2.2" fill="#0b2a5c"/>`;
    s += `<rect x="-24" y="-58" width="68" height="42" rx="3" fill="url(#aServo)" stroke="#0d3375" stroke-width=".6" filter="url(#fShadow)"/><rect x="2" y="-36" width="38" height="14" rx="1.5" fill="#f5f5f2" opacity=".92"/><text x="21" y="-26.5" font-size="7" font-weight="700" fill="#1f4f9e" text-anchor="middle" font-family="Inter,system-ui,sans-serif" pointer-events="none">SG90</text>`;
    s += `<circle cx="0" cy="-44" r="12" fill="#2b6dd0" stroke="#0d3375" stroke-width=".6"/><circle cx="0" cy="-44" r="7" fill="#e9e9e6"/>`;
    s += `<g transform="rotate(${rot.toFixed(1)} 0 -44)" filter="url(#fShadow)"><path d="M-6 -44 L-3 -86 a3 3 0 0 1 6 0 L6 -44 a6 6 0 0 1 -12 0 z" fill="#fbfbf7" stroke="#b8b8b0" stroke-width=".6"/>${[0, 1, 2, 3, 4].map((i) => `<circle cx="0" cy="${-52 - i * 7}" r="1.1" fill="#9a9a92"/>`).join('')}</g><circle cx="0" cy="-44" r="3" fill="#c8c8c0" stroke="#888" stroke-width=".5"/>`;
    return s + `<text x="58" y="-50" class="plbl" text-anchor="start" style="text-anchor:start">${st.us ? Math.round(a) + '° · ' + Math.round(st.us) + ' µs' : 'no pulse'}</text>` + dots(this.pins(p));
  };

  // ---------- NeoPixels: 5050 packages ----------
  const neoOld = { neopixel: T.neopixel.svg, neoring: T.neoring.svg };
  for (const type of ['neopixel', 'neoring']) T[type].svg = function (p, st) { return neoOld[type].call(this, p, st).replace(/class="neo-led"/g, 'class="neo-led" stroke="#bdb8a8" stroke-width=".6"').replace(/class="neo-pcb"/g, 'class="neo-pcb" fill="#1a1b1e"'); };

  // ---------- DHT22 (white grille) ----------
  T.dht22.svg = function (p) {
    let s = [0, 10, 20, 30].map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="-7" stroke="url(#aLeadV)" stroke-width="1.6"/>`).join('');
    s += `<path d="M-6 -7 v-54 q0 -4 4 -4 h34 q4 0 4 4 v54 z" fill="#f4f4f0" stroke="#b5b5ad" stroke-width=".6" filter="url(#fShadow)"/><rect x="-6" y="-16" width="42" height="9" fill="#e6e6e0" stroke="#b5b5ad" stroke-width=".4"/><circle cx="15" cy="-11.5" r="2" fill="#cfcfc8"/>`;
    for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) s += `<rect x="${-2 + c * 7.6}" y="${-60 + r * 7.2}" width="4.4" height="4.8" rx="1" fill="#2a2b2e" opacity=".85"/>`;
    return s + `<text x="15" y="-70" class="plbl">DHT22 ${(+p.props.temp).toFixed(1)}°C ${(+p.props.hum).toFixed(0)}%</text>` + ['VCC', 'DAT', 'NC', 'GND'].map((t, i) => `<text x="${i * 10}" y="9" class="plbl small" transform="rotate(-90 ${i * 10} 9)" text-anchor="end">${t}</text>`).join('') + dots(this.pins(p));
  };

  // ---------- Text annotation ----------
  const LCOL = { muted: '', white: '#f1f5f9', black: '#111', yellow: '#fbbf24', cyan: '#22d3ee', red: '#f87171', green: '#4ade80' };
  T.label.props = Object.assign({ color: 'muted', bg: false }, T.label.props);
  T.label.edit = [{ k: 'text', label: 'Text', t: 'text' }, { k: 'size', label: 'Size', t: 'num' }, { k: 'color', label: 'Colour', t: 'sel', opts: Object.keys(LCOL) }, { k: 'bg', label: 'Note background', t: 'bool' }];
  T.label.cat = 'Misc';
  T.label.svg = function (p) {
    const sz = +p.props.size || 12, lines = String(p.props.text).split(/\\n|\n/), w = Math.max(...lines.map((l) => l.length)) * sz * 0.6, col = LCOL[p.props.color];
    let s = `<rect x="-4" y="${-sz - 2}" width="${w + 8}" height="${lines.length * sz * 1.2 + 6}" rx="3" class="lbl-hit" fill="${p.props.bg ? '#fff9c4' : 'transparent'}" ${p.props.bg ? 'stroke="#e0c84a" stroke-width=".6" filter="url(#fShadow)"' : ''}/>`;
    lines.forEach((l, i) => { s += `<text x="0" y="${i * sz * 1.2}" class="free-lbl" style="font-size:${sz}px${col ? ';fill:' + col : ''}${p.props.bg ? ';fill:#3a3000' : ''}">${esc(l)}</text>`; });
    return s;
  };
  T.label.dblclick = (p) => { const t = prompt('Annotation text (\\n = new line)', p.props.text); if (t === null) return false; p.props.text = t; return true; };

  // ---------- 4x4 membrane keypad ----------
  const KP = ['123A', '456B', '789C', '*0#D'];
  const KPN = ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'];
  const TRACE = ['#e6e6e6', '#f2c94c', '#f2994a', '#eb5757', '#9b51e0', '#2f80ed', '#27ae60', '#828282'];
  def('keypad', {
    label: 'Keypad 4×4 membrane', cat: 'Input', props: { keys: KP.join('') }, interactive: true, prefix: 'KEYPAD',
    edit: [{ k: 'keys', label: 'Key legends (16 chars, row-major)', t: 'text' }],
    pins: () => KPN.map((n, i) => ({ name: n, x: i * G, y: 0 })),
    size: () => ({ w: 70, h: 10 }),
    keyAt(p, k) { const ks = String(p.props.keys || KP.join('')); const i = ks.toUpperCase().indexOf(String(k).toUpperCase()); return k && String(k).length === 1 && i >= 0 && i < 16 ? i : -1; },
    svg(p, st) {
      const ks = String(p.props.keys || KP.join('')).padEnd(16, ' '), down = st && st.pressed ? st.kidx : -1;
      const X0 = -45, Y0 = -212, W = 160, H = 172;
      let s = `<rect x="${X0}" y="${Y0}" width="${W}" height="${H}" rx="9" fill="url(#aKpBody)" stroke="#121315" stroke-width="1" filter="url(#fShadow)"/><rect x="${X0 + 5}" y="${Y0 + 5}" width="${W - 10}" height="${H - 10}" rx="6" fill="none" stroke="#ffffff1a" stroke-width="1"/>`;
      // ribbon tail
      s += `<path d="M-6 ${Y0 + H - 2} h82 v${-Y0 - H - 4} h-82 z" fill="#e8e8e4" stroke="#bcbcb6" stroke-width=".5"/>`;
      for (let i = 0; i < 8; i++) s += `<rect x="${i * G - 1.6}" y="${Y0 + H - 2}" width="3.2" height="${-Y0 - H - 4}" fill="${TRACE[i]}" opacity=".9"/>`;
      s += `<rect x="-6" y="-12" width="82" height="9" fill="#1b1c1f"/>`;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const i = r * 4 + c, ch = ks[i], red = c === 3 || r === 3 && c !== 1, pr = down === i, x = X0 + 14 + c * 35, y = Y0 + 14 + r * 38;
        s += `<g class="kp-key" data-key="${i}"><rect x="${x}" y="${y + 2}" width="28" height="30" rx="4" fill="#000" opacity=".35"/><rect x="${x}" y="${y + (pr ? 2 : 0)}" width="28" height="30" rx="4" fill="url(#${red ? 'aKeyR' : 'aKeyB'})" stroke="${pr ? '#fff' : '#0003'}" stroke-width="${pr ? 1.2 : 0.6}"/>`;
        s += `<rect x="${x + 2}" y="${y + (pr ? 4 : 2)}" width="24" height="9" rx="3" fill="#fff" opacity="${pr ? 0.08 : 0.18}" pointer-events="none"/><text x="${x + 14}" y="${y + (pr ? 23 : 21)}" font-size="15" font-weight="600" fill="#fff" text-anchor="middle" font-family="Inter,system-ui,sans-serif" pointer-events="none">${esc(ch)}</text></g>`;
      }
      return s + KPN.map((n, i) => `<text x="${i * G}" y="9" class="plbl small" transform="rotate(-90 ${i * G} 9)" text-anchor="end">${n}</text>`).join('') + dots(this.pins(p));
    },
    stamp(p, cx) {
      const st = cx.state(p);
      if (st.pressed && st.kidx >= 0) cx.add({ kind: 'R', a: cx.node(p, 'R' + (1 + (st.kidx >> 2))), b: cx.node(p, 'C' + (1 + (st.kidx & 3))), r: 60, main: true }, p);
    },
    readout(p, cx) { const st = cx.state(p); return st.pressed && st.kidx >= 0 ? `key '${String(p.props.keys || KP.join(''))[st.kidx]}' down (R${1 + (st.kidx >> 2)}–C${1 + (st.kidx & 3)})` : 'click a key or type it on the keyboard while running'; },
  });
  function def(type, d) { d.type = type; T[type] = d; return d; }
})(typeof window !== 'undefined' ? window : globalThis);
