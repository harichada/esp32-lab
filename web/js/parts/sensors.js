/* Sensor modules (add-on part file, see js/parts/registry.js). Analog modules are real resistor networks in the solved
 * circuit (so analogRead in firmware/JS sketch reads the node voltage); digital/protocol sensors decode the ESP32's pin
 * activity in espStep() and drive their output pin through a 60 Ω switch to VCC/GND (or release it). */
(function (root) {
  const P = root.Parts, R = root.PartsReg, esc = P.esc;
  // ---------- shared artwork helpers (dark, glossy, gold pins) ----------
  const DEFS = `
<linearGradient id="sdPcbBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d6fd6"/><stop offset="1" stop-color="#173f86"/></linearGradient>
<linearGradient id="sdPcbBlk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e333b"/><stop offset="1" stop-color="#14161a"/></linearGradient>
<linearGradient id="sdPcbGrn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8a48"/><stop offset="1" stop-color="#0d5428"/></linearGradient>
<linearGradient id="sdPcbRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8302c"/><stop offset="1" stop-color="#7e1714"/></linearGradient>
<linearGradient id="sdPcbPur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7b42b8"/><stop offset="1" stop-color="#43206e"/></linearGradient>
<linearGradient id="sdGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7dd84"/><stop offset="1" stop-color="#b8892a"/></linearGradient>
<linearGradient id="sdChip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2c31"/><stop offset="1" stop-color="#0c0d0f"/></linearGradient>
<radialGradient id="sdMetal" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#f4f6f8"/><stop offset=".55" stop-color="#aab2bb"/><stop offset="1" stop-color="#5d656e"/></radialGradient>
<radialGradient id="sdDome" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#e3e5e8"/><stop offset="1" stop-color="#a9adb3"/></radialGradient>
<radialGradient id="sdKnob" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#5b6068"/><stop offset="1" stop-color="#121417"/></radialGradient>
<radialGradient id="sdGloss" cx=".3" cy=".2" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  function injectDefs() { const d = document.querySelector('#stage defs'); if (d && !d.querySelector('#sdGold')) d.insertAdjacentHTML('beforeend', DEFS); }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectDefs); else injectDefs(); }
  const A = {
    row: (names, y = 0) => names.map((n, i) => ({ name: n, x: i * 10, y })),
    dots: (pins) => pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join(''),
    hdr: (n, y = -6) => Array.from({ length: n }, (_, i) => `<rect x="${i * 10 - 4.4}" y="${y - 4.4}" width="8.8" height="8.8" rx=".8" fill="#17181b" stroke="#000" stroke-width=".4"/><rect x="${i * 10 - 1.8}" y="${y - 1.8}" width="3.6" height="3.6" rx=".5" fill="url(#sdGold)"/>`).join(''),
    legs: (n, y1 = -6) => Array.from({ length: n }, (_, i) => `<line x1="${i * 10}" y1="0" x2="${i * 10}" y2="${y1}" stroke="#c9ced4" stroke-width="1.6"/>`).join(''),
    lbls: (names, y = 9) => names.map((t, i) => `<text x="${i * 10}" y="${y}" class="plbl small" transform="rotate(-90 ${i * 10} ${y})" text-anchor="end">${esc(t)}</text>`).join(''),
    pcb: (x, y, w, h, fill = 'url(#sdPcbBlue)', rx = 3) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="#0008" stroke-width=".6" filter="url(#fShadow)"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="url(#sdGloss)" pointer-events="none"/>`,
    mh: (x, y, r = 2.4) => `<circle cx="${x}" cy="${y}" r="${r + 1}" fill="url(#sdGold)"/><circle cx="${x}" cy="${y}" r="${r}" fill="#0d0f12"/>`,
    chip: (x, y, w, h, t) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="url(#sdChip)" stroke="#000" stroke-width=".4"/>${t ? `<text x="${x + w / 2}" y="${y + h / 2 + 1.5}" font-size="4" fill="#9aa1aa" text-anchor="middle" font-family="ui-monospace,monospace" pointer-events="none">${esc(t)}</text>` : ''}`,
    silk: (x, y, t, sz = 4.4, anchor = 'middle') => `<text x="${x}" y="${y}" font-size="${sz}" fill="#f2f2f2" font-family="ui-monospace,Menlo,monospace" text-anchor="${anchor}" pointer-events="none">${esc(t)}</text>`,
    smd: (x, y, c = '#c9b98d') => `<rect x="${x}" y="${y}" width="5" height="2.6" rx=".4" fill="${c}" stroke="#0006" stroke-width=".3"/>`,
    led: (x, y, on, col = '#ff3b30') => `<rect x="${x - 2.5}" y="${y - 1.5}" width="5" height="3" rx=".6" fill="${on ? col : '#5a2a2a'}"/>` + (on ? `<circle cx="${x}" cy="${y}" r="6" fill="${col}" opacity=".55" filter="url(#fGlow)" pointer-events="none"/>` : ''),
    trim: (x, y) => `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="1" fill="#2f63c9" stroke="#0006" stroke-width=".4"/><circle cx="${x}" cy="${y}" r="3" fill="#e9e3c8"/><path d="M${x - 2} ${y} h4 M${x} ${y - 2} v4" stroke="#776" stroke-width=".8"/>`,
    title: (x, y, t) => `<text x="${x}" y="${y}" class="plbl">${esc(t)}</text>`,
  };
  root.SDArt = A;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const vsrc = (cx, p, a, b, ratio, rTot = 20e3) => {   // divider from pin a (VCC) to GND giving ratio·Vcc on b
    const x = clamp(ratio, 0.001, 0.999); cx.add({ kind: 'R', a: cx.node(p, a), b: cx.node(p, b), r: rTot * (1 - x) }, p); cx.add({ kind: 'R', a: cx.node(p, b), b: cx.node(p, 'GND'), r: rTot * x }, p);
  };
  const driveOut = (cx, p, pin, v, vcc = 'VCC') => { if (v === 1) cx.add({ kind: 'R', a: cx.node(p, pin), b: cx.node(p, vcc), r: 60 }, p); else if (v === 0) cx.add({ kind: 'R', a: cx.node(p, pin), b: cx.node(p, 'GND'), r: 60 }, p); };
  const load = (cx, p, ma, vcc = 'VCC') => cx.add({ kind: 'R', a: cx.node(p, vcc), b: cx.node(p, 'GND'), r: 3.3 / (ma / 1000), main: true }, p);
  const CAT = 'Sensors';

  // ---------- DHT11 (blue) : same single-wire protocol as the DHT22 hook, decoded here from pin pull-up toggles ----------
  R.register('dht11', {
    label: 'DHT11 temp/humidity', cat: CAT, props: { temp: 22, hum: 55 }, prefix: 'DHT',
    edit: [{ k: 'temp', label: 'Temperature (°C)', t: 'range', min: 0, max: 50, step: 1, live: true }, { k: 'hum', label: 'Humidity (%)', t: 'range', min: 20, max: 90, step: 1, live: true }],
    pins: () => A.row(['VCC', 'DATA', 'NC', 'GND']), size: () => ({ w: 30, h: 10 }),
    svg(p) {
      let s = A.legs(4) + `<rect x="-5" y="-56" width="40" height="50" rx="3" fill="#3b8fe0" stroke="#1d4f86" stroke-width=".8" filter="url(#fShadow)"/><rect x="-5" y="-56" width="40" height="50" rx="3" fill="url(#sdGloss)"/>`;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s += `<rect x="${-1 + c * 9}" y="${-50 + r * 9}" width="5.5" height="6" rx="1" fill="#103a66"/>`;
      return s + A.title(15, -60, `DHT11 ${Math.round(p.props.temp)}°C ${Math.round(p.props.hum)}%`) + A.lbls(['VCC', 'DAT', 'NC', 'GND']) + A.dots(this.pins(p));
    },
    bytes(p) { const h = Math.round(clamp(+p.props.hum, 0, 99)), t = Math.round(clamp(+p.props.temp, 0, 60)); return [h, 0, t, 0, (h + t) & 255]; },
    stamp(p, cx) { const st = cx.state(p); load(cx, p, 1); cx.add({ kind: 'R', a: cx.node(p, 'DATA'), b: cx.node(p, 'VCC'), r: 10e3 }, p); driveOut(cx, p, 'DATA', st.drive); },
    espStep(p, c) {   // identical state machine to app.js dhtStep(): start pulse (MCU drives low), then each pull-up toggle clocks one bit
      const io = c.gpio(p, 'DATA'), st = c.state(p); if (!io) return; const pin = io.pin;
      if (pin.out && !pin.level) { st.armed = true; st.bit = -1; st.lastPu = null; st.drive = undefined; }
      else if (st.armed && !pin.out) {
        if (st.lastPu === null) st.lastPu = pin.pu;
        else if (pin.pu !== st.lastPu) {
          st.lastPu = pin.pu; st.bit++;
          if (st.bit < 40) { const b = this.bytes(p); st.drive = (b[st.bit >> 3] >> (7 - (st.bit & 7))) & 1; } else { st.drive = undefined; st.armed = false; st.reads = (st.reads || 0) + 1; }
        }
      }
    },
    readout(p, cx) { const st = cx.state(p); return st.reads ? `${st.reads} reads` : 'not read yet'; },
  }, { bom: () => ({ key: 'dht11', name: 'DHT11 temp/humidity module', q: 'DHT11 temperature humidity sensor module' }) });

  // ---------- DS18B20 (TO-92) ----------
  R.register('ds18b20', {
    label: 'DS18B20 1-Wire temperature', cat: CAT, props: { temp: 21.5 }, prefix: 'TS',
    edit: [{ k: 'temp', label: 'Temperature (°C)', t: 'range', min: -55, max: 125, step: 0.0625, live: true }],
    pins: () => A.row(['GND', 'DQ', 'VDD']), size: () => ({ w: 20, h: 10 }),
    svg(p) { return A.legs(3, -10) + `<path d="M-5 -10 h30 v-12 a15 12 0 0 0 -30 0 z" fill="url(#sdChip)" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><path d="M-3 -12 h26" stroke="#ffffff22"/>` + A.silk(10, -16, 'DS18B20', 3.6) + A.title(10, -38, `${(+p.props.temp).toFixed(2)}°C`) + A.lbls(['GND', 'DQ', 'VDD']) + A.dots(this.pins(p)); },
    stamp(p, cx) { load(cx, p, 1, 'VDD'); },
    // 12-bit scratchpad (what a 1-Wire bridge would return): LSB, MSB, TH, TL, cfg, FF, 0C, 10, CRC
    scratch(p) { const t = Math.round(clamp(+p.props.temp, -55, 125) * 16) & 0xffff; const b = [t & 255, t >> 8, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10]; let crc = 0; for (let x of b) for (let i = 0; i < 8; i++) { const m = (crc ^ x) & 1; crc >>= 1; if (m) crc ^= 0x8c; x >>= 1; } b.push(crc); return b; },
    readout(p) { return `${(+p.props.temp).toFixed(2)} °C · 1-Wire bus timing not bridged yet (needs a QEMU OneWire shim)`; },
  }, { bom: () => ({ key: 'ds18b20', name: 'DS18B20 temperature sensor (TO-92) + 4.7 kΩ', q: 'DS18B20 temperature sensor TO-92' }) });

  // ---------- HC-SR04 ultrasonic ----------
  R.register('hcsr04', {
    label: 'HC-SR04 ultrasonic distance', cat: CAT, props: { cm: 50 }, prefix: 'US',
    edit: [{ k: 'cm', label: 'Distance (cm)', t: 'range', min: 2, max: 400, step: 1, live: true }],
    pins: () => A.row(['VCC', 'TRIG', 'ECHO', 'GND']), size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      const e = st && st.echo;
      const can = (x) => `<circle cx="${x}" cy="-34" r="17" fill="url(#sdMetal)" stroke="#3c434b" stroke-width="1"/><circle cx="${x}" cy="-34" r="12.5" fill="#202328"/>${Array.from({ length: 6 }, (_, i) => `<circle cx="${x}" cy="-34" r="${2 + i * 1.8}" fill="none" stroke="#3b4048" stroke-width=".6"/>`).join('')}`;
      return A.hdr(4) + A.pcb(-34, -58, 98, 48) + A.mh(-30, -54, 1.6) + A.mh(60, -54, 1.6) + A.mh(-30, -14, 1.6) + A.mh(60, -14, 1.6) + can(-13) + can(43) + A.chip(8, -44, 14, 8, '') + `<rect x="9" y="-26" width="12" height="5" rx="2" fill="#d8d8d0" stroke="#888" stroke-width=".4"/>` + A.silk(15, -50, 'HC-SR04', 4.6) +
        (e ? `<path d="M-13 -58 q14 -10 28 0 M-17 -64 q18 -14 36 0" stroke="#7fd3ff" fill="none" stroke-width="1.2" opacity=".8"/>` : '') + A.title(15, -62, `${Math.round(p.props.cm)} cm`) + A.lbls(['VCC', 'TRG', 'ECH', 'GND']) + A.dots(this.pins(p));
    },
    stamp(p, cx) { const st = cx.state(p); load(cx, p, 2); cx.add({ kind: 'R', a: cx.node(p, 'TRIG'), b: cx.node(p, 'GND'), r: 10e3 }, p); driveOut(cx, p, 'ECHO', st.echo ? 1 : 0); },
    espStep(p, c) {
      const st = c.state(p), tr = c.drive(p, 'TRIG');
      if (st.lastTrig === 1 && tr === 0) { const d = clamp(+p.props.cm, 2, 400) / 100; st.t0 = c.t + 450e-6; st.t1 = st.t0 + 2 * d / 343; st.pings = (st.pings || 0) + 1; }   // 8×40 kHz burst ≈ 0.45 ms after the trigger falls
      st.lastTrig = tr;
    },
    tick(p, c) { const st = c.state(p); const e = st.t0 !== undefined && c.t >= st.t0 && c.t < st.t1; if (e !== !!st.echo) { st.echo = e; return true; } return false; },
    echoUs(p) { return 2 * clamp(+p.props.cm, 2, 400) / 100 / 343 * 1e6; },
    readout(p, cx) { const st = cx.state(p); return `echo ${Math.round(this.echoUs(p))} µs · ${st.pings || 0} pings`; },
    warn(p, cx) { if (cx.pinV(p, 'VCC') - cx.pinV(p, 'GND') > 4.5) return null; },
  }, { bom: () => ({ key: 'hcsr04', name: 'HC-SR04 ultrasonic distance sensor', q: 'HC-SR04 ultrasonic sensor module', note: 'ECHO is 5 V: use a 1k/2k divider into the ESP32' }) });

  // ---------- PIR HC-SR501 ----------
  R.register('pir', {
    label: 'PIR motion HC-SR501', cat: CAT, props: { motion: false, hold: 3 }, prefix: 'PIR', interactive: true,
    edit: [{ k: 'motion', label: 'Motion present', t: 'bool' }, { k: 'hold', label: 'Hold time (s)', t: 'range', min: 0.5, max: 30, step: 0.5, live: true }],
    pins: () => A.row(['VCC', 'OUT', 'GND']), size: () => ({ w: 20, h: 10 }),
    svg(p, st) {
      const on = st && st.out;
      return A.hdr(3) + A.pcb(-22, -60, 64, 52, 'url(#sdPcbGrn)') + A.mh(-18, -56, 1.6) + A.mh(38, -56, 1.6) + `<circle cx="10" cy="-36" r="22" fill="url(#sdDome)" stroke="#9aa0a7" stroke-width=".8" filter="url(#fShadow)"/>` +
        Array.from({ length: 4 }, (_, i) => `<circle cx="10" cy="-36" r="${5 + i * 4.5}" fill="none" stroke="#c4c8cd" stroke-width=".7"/>`).join('') + `<path d="M-12 -36 h44 M10 -58 v44" stroke="#c4c8cd" stroke-width=".5"/>` +
        (on ? `<circle cx="10" cy="-36" r="24" fill="#ff5a3c" opacity=".18" filter="url(#fGlow)"/>` : '') + A.led(34, -14, on) + A.title(10, -64, on ? 'PIR · MOTION' : 'PIR · idle') + A.lbls(['VCC', 'OUT', 'GND']) + A.dots(this.pins(p));
    },
    stamp(p, cx) { const st = cx.state(p); cx.add({ kind: 'R', a: cx.node(p, 'VCC'), b: cx.node(p, 'GND'), r: 5 / 65e-6, main: true }, p); driveOut(cx, p, 'OUT', st.out ? 1 : 0, 'VCC'); },
    tick(p, c) {   // OUT is 3.3 V from the on-board regulator; retriggerable hold
      const st = c.state(p); if (p.props.motion === true || p.props.motion === 'true' || st.pressed) st.last = c.t;
      const out = st.last !== undefined && c.t - st.last < (+p.props.hold || 3); if (out !== !!st.out) { st.out = out; if (out) st.triggers = (st.triggers || 0) + 1; return true; } return false;
    },
    readout(p, cx) { const st = cx.state(p); return `${st.out ? 'OUT HIGH' : 'OUT low'} · ${st.triggers || 0} triggers (hold the part to wave a hand)`; },
  }, { bom: () => ({ key: 'pir', name: 'PIR motion sensor HC-SR501', q: 'HC-SR501 PIR motion sensor module' }) });
  // PIR OUT should be 3.3 V even on 5 V supply: override drive to use an internal 3.3 V level
  P.T.pir.stamp = function (p, cx) { const st = cx.state(p), v = cx.node(p, 'VCC'), g = cx.node(p, 'GND'), o = cx.node(p, 'OUT'); cx.add({ kind: 'R', a: v, b: g, r: 5 / 65e-6, main: true }, p); if (st.out) { cx.add({ kind: 'V', a: o, b: g, v: 3.3, rs: 100 }, p); } else cx.add({ kind: 'R', a: o, b: g, r: 100 }, p); };

  // ---------- comparator modules (LM393): AO divider + DO with trimmer threshold ----------
  function lm393(type, o) {
    R.register(type, {
      label: o.label, cat: CAT, props: Object.assign({ thr: 0.5 }, o.props), prefix: o.prefix, interactive: !!o.press,
      edit: o.edit.concat([{ k: 'thr', label: 'DO threshold (trimmer, fraction of VCC)', t: 'range', min: 0.05, max: 0.95, step: 0.01, live: true }]),
      pins: () => A.row(o.pins), size: () => ({ w: (o.pins.length - 1) * 10, h: 10 }),
      svg(p, st) { st = st || {}; return A.hdr(o.pins.length) + o.body(p, st) + A.led(o.ledX || 0, -14, true, '#ff3b30') + A.led((o.ledX || 0) + 8, -14, st.doLit, '#38e26b') + A.lbls(o.pins.map((n) => n.replace('VCC', 'VCC'))) + A.dots(this.pins(p)); },
      ratio(p, st) { return o.ratio(p, st || {}); },
      stamp(p, cx) {
        const st = cx.state(p); load(cx, p, o.ma || 3);
        if (o.pins.includes('AO')) vsrc(cx, p, 'VCC', 'AO', this.ratio(p, st), o.rTot || 20e3);
        if (o.pins.includes('DO')) { cx.add({ kind: 'R', a: cx.node(p, 'DO'), b: cx.node(p, 'VCC'), r: 10e3 }, p); if (st.doLow) cx.add({ kind: 'R', a: cx.node(p, 'DO'), b: cx.node(p, 'GND'), r: 30 }, p); }
      },
      tick(p, c, dt) {
        const st = c.state(p); let dirty = false;
        if (o.tick && o.tick(p, st, c, dt)) dirty = true;
        const r = this.ratio(p, st), low = o.doLowWhenAbove ? r > +p.props.thr : r < +p.props.thr;   // LM393 output pulls low (module LED on)
        if (low !== !!st.doLow) { st.doLow = low; dirty = true; } st.doLit = low; return dirty;
      },
      readout(p, cx) { const st = cx.state(p); return `${o.read(p, st)} · AO ${(this.ratio(p, st) * 100).toFixed(0)}% VCC · DO ${st.doLow ? 'LOW' : 'HIGH'}`; },
    }, { bom: o.bom });
  }
  const ldrR = (lux) => P.T.ldr.R(lux);
  lm393('ldrmod', { label: 'LDR light sensor module (AO/DO)', prefix: 'LDRM', pins: ['VCC', 'GND', 'DO', 'AO'], props: { lux: 200 },
    edit: [{ k: 'lux', label: 'Light (lux)', t: 'range', min: 0.1, max: 10000, step: 1, log: true, live: true }], doLowWhenAbove: false,
    ratio: (p) => { const r = ldrR(+p.props.lux); return r / (r + 10e3); }, read: (p) => `${Math.round(p.props.lux)} lx`,
    doLowWhenAbove_: 0,
    body: (p) => A.pcb(-6, -60, 42, 52) + `<circle cx="15" cy="-46" r="8" fill="#d9b25a" stroke="#8a6a28" stroke-width=".6"/><path d="M9 -49 q2 -3 4 0 t4 0 t4 0 M9 -45 q2 -3 4 0 t4 0 t4 0" stroke="#b23a2a" fill="none" stroke-width=".9"/>` + A.trim(26, -28) + A.chip(-1, -33, 12, 9, '393') + A.title(15, -64, `LDR ${Math.round(p.props.lux)} lx`),
    bom: () => ({ key: 'ldrmod', name: 'LDR photoresistor module (LM393, AO+DO)', q: 'photoresistor light sensor module LM393 analog digital' }) });
  // DO for light: bright -> AO low -> output LOW (module LED on). Reuse doLowWhenAbove=false: low when ratio < thr.
  lm393('soil', { label: 'Soil moisture (capacitive v1.2)', prefix: 'SOIL', pins: ['GND', 'VCC', 'AO'], props: { moist: 40 }, ma: 5,
    edit: [{ k: 'moist', label: 'Soil moisture (%)', t: 'range', min: 0, max: 100, step: 1, live: true }],
    ratio: (p) => 0.84 - 0.46 * clamp(+p.props.moist, 0, 100) / 100, read: (p) => `${Math.round(p.props.moist)}% moisture`,
    body: (p) => { const m = clamp(+p.props.moist, 0, 100), h = Math.round(m * 0.9);
      return `<path d="M-8 -6 v-40 h36 v40 z M-8 -46 h36 v-84 l-18 14 l-18 -14 z" fill="url(#sdPcbBlk)" stroke="#000" stroke-width=".6" filter="url(#fShadow)"/>` +
        `<rect x="-20" y="${-116 + 90 - h}" width="60" height="${h}" fill="#6b4a2a" opacity=".45" rx="3"/><line x1="-20" y1="-66" x2="40" y2="-66" stroke="#c9a36a" stroke-dasharray="3 2" stroke-width=".7"/>` +
        `<rect x="-3" y="-120" width="26" height="70" rx="2" fill="none" stroke="#c9a24a" stroke-width=".8" opacity=".55"/>` + A.chip(4, -36, 12, 10, '555') + A.smd(-4, -20) + A.smd(23, -20) +
        A.silk(10, -92, 'CAPACITIVE', 3.6) + A.silk(10, -86, 'SOIL v1.2', 3.6) + A.title(10, -136, `Soil ${Math.round(m)}%`); },
    bom: () => ({ key: 'soil', name: 'Capacitive soil moisture sensor v1.2', q: 'capacitive soil moisture sensor v1.2' }) });
  lm393('mq2', { label: 'MQ-2 gas / smoke sensor', prefix: 'GAS', pins: ['VCC', 'GND', 'DO', 'AO'], props: { ppm: 300 }, ma: 150, doLowWhenAbove: true,
    edit: [{ k: 'ppm', label: 'Gas (ppm LPG/smoke)', t: 'range', min: 100, max: 10000, step: 1, log: true, live: true }],
    ratio: (p) => { const rs = 10 * Math.pow(clamp(+p.props.ppm, 50, 20000) / 1000, -0.47), rl = 5; return rl / (rs + rl); }, read: (p) => `${Math.round(p.props.ppm)} ppm`,
    body: (p) => A.pcb(-6, -64, 42, 56) + `<circle cx="15" cy="-42" r="15" fill="url(#sdMetal)" stroke="#4e555d"/><circle cx="15" cy="-42" r="11" fill="#9a8a6a"/>` +
      Array.from({ length: 7 }, (_, i) => `<line x1="${5 + i * 3.3}" y1="-52" x2="${5 + i * 3.3}" y2="-32" stroke="#6d6048" stroke-width=".6"/><line x1="5" y1="${-52 + i * 3.3}" x2="25" y2="${-52 + i * 3.3}" stroke="#6d6048" stroke-width=".6"/>`).join('') + A.trim(31, -21) + A.title(15, -68, `MQ-2 ${Math.round(p.props.ppm)} ppm`),
    bom: () => ({ key: 'mq2', name: 'MQ-2 gas/smoke sensor module', q: 'MQ-2 gas smoke sensor module', note: 'heater needs 5 V ~150 mA; divide AO for the 3.3 V ADC' }) });
  lm393('sound', { label: 'Sound sensor (mic, LM393)', prefix: 'MIC', pins: ['AO', 'GND', 'VCC', 'DO'], props: { db: 45 }, ledX: 4, doLowWhenAbove: false, press: true,
    edit: [{ k: 'db', label: 'Sound level (dB SPL)', t: 'range', min: 30, max: 110, step: 1, live: true }],
    tick: (p, st) => { const loud = !!st.pressed; if (loud !== !!st.clap) { st.clap = loud; return true; } return false; },
    ratio: (p, st) => 0.5 - 0.42 * clamp(((st && st.clap ? 105 : +p.props.db) - 30) / 80, 0, 1), read: (p, st) => `${st.clap ? 105 : Math.round(p.props.db)} dB${st.clap ? ' (clap!)' : ''}`,
    body: (p, st) => A.pcb(-8, -56, 46, 48, 'url(#sdPcbRed)') + `<circle cx="15" cy="-40" r="10" fill="#1d1f23" stroke="#888" stroke-width="1.2"/><circle cx="15" cy="-40" r="6.5" fill="#2e3136"/>${Array.from({ length: 5 }, (_, i) => `<line x1="10" y1="${-44 + i * 2}" x2="20" y2="${-44 + i * 2}" stroke="#555" stroke-width=".5"/>`).join('')}` + A.trim(31, -26) + A.chip(-3, -30, 10, 8, '') + A.title(15, -60, `MIC ${st && st.clap ? 'CLAP' : Math.round(p.props.db) + ' dB'}`),
    bom: () => ({ key: 'sound', name: 'Sound sensor module (KY-037 / LM393 mic)', q: 'KY-037 sound sensor module microphone' }) });

  // ---------- VS1838B IR receiver (38 kHz demodulated, active-low output) ----------
  const NEC_KEYS = { 'OK (0x1C)': 0x1c, 'UP (0x18)': 0x18, 'DOWN (0x52)': 0x52, 'LEFT (0x08)': 0x08, 'RIGHT (0x5A)': 0x5a, '1 (0x45)': 0x45, '2 (0x46)': 0x46, '3 (0x47)': 0x47, 'POWER (0x45)': 0x45 };
  function necMarks(addr, cmd) {   // [[level, seconds]] of the demodulated output (LOW = carrier present)
    const out = [[0, 9e-3], [1, 4.5e-3]], bits = [addr & 255, ~addr & 255, cmd & 255, ~cmd & 255];
    for (const b of bits) for (let i = 0; i < 8; i++) { out.push([0, 562e-6]); out.push([1, (b >> i) & 1 ? 1687e-6 : 562e-6]); }
    out.push([0, 562e-6]); return out;
  }
  R.register('irrecv', {
    label: 'IR receiver VS1838B (38 kHz)', cat: CAT, props: { key: 'OK (0x1C)', addr: 0 }, prefix: 'IR', interactive: true,
    edit: [{ k: 'key', label: 'Remote button sent on press', t: 'sel', opts: Object.keys(NEC_KEYS) }, { k: 'addr', label: 'NEC address', t: 'num' }],
    pins: () => A.row(['OUT', 'GND', 'VCC']), size: () => ({ w: 20, h: 10 }),
    svg(p, st) {
      const rx = st && st.lvl === 0;
      return A.legs(3, -12) + `<rect x="-6" y="-34" width="32" height="22" rx="3" fill="url(#sdChip)" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><path d="M-2 -12 v-6 h24 v6" fill="#26292e"/><circle cx="10" cy="-30" r="9" fill="#2a2d33" stroke="#4a5059"/><ellipse cx="7" cy="-33" rx="3.5" ry="2.5" fill="#fff" opacity=".18"/>` +
        (rx ? `<g stroke="#b49cff" fill="none" stroke-width="1.1" opacity=".85"><path d="M24 -44 a8 8 0 0 1 0 12"/><path d="M29 -48 a13 13 0 0 1 0 20"/></g>` : '') + A.title(10, -46, 'VS1838B') + A.lbls(['OUT', 'GND', 'VCC']) + A.dots(this.pins(p));
    },
    stamp(p, cx) { const st = cx.state(p); load(cx, p, 0.6); cx.add({ kind: 'R', a: cx.node(p, 'OUT'), b: cx.node(p, 'VCC'), r: 33e3 }, p); if (st.lvl === 0) cx.add({ kind: 'R', a: cx.node(p, 'OUT'), b: cx.node(p, 'GND'), r: 50 }, p); },
    tick(p, c) {
      const st = c.state(p);
      if (st.pressed && !st.wasPressed) { st.frame = necMarks(+p.props.addr || 0, NEC_KEYS[p.props.key] !== undefined ? NEC_KEYS[p.props.key] : 0x1c); st.t0 = c.t; st.sent = (st.sent || 0) + 1; }
      st.wasPressed = !!st.pressed;
      let lvl = 1; if (st.frame) { let t = st.t0, done = true; for (const [l, d] of st.frame) { if (c.t < t + d) { lvl = l; done = false; break; } t += d; } if (done) st.frame = null; }
      if (lvl !== (st.lvl === undefined ? 1 : st.lvl)) { st.lvl = lvl; return true; } return false;
    },
    necMarks,
    readout(p, cx) { const st = cx.state(p); return `${st.sent || 0} NEC frames sent · press & hold the part to send ${esc(p.props.key)}`; },
  }, { bom: () => ({ key: 'irrecv', name: 'IR receiver VS1838B 38 kHz (+ remote kit)', q: 'VS1838B IR receiver remote control kit' }) });

  // ---------- KY-040 rotary encoder ----------
  const QUAD = [[1, 1], [0, 1], [0, 0], [1, 0]];   // CLK, DT phases for one clockwise detent
  R.register('ky040', {
    label: 'Rotary encoder KY-040', cat: 'Input', props: { pos: 0 }, prefix: 'ENC', interactive: true,
    edit: [{ k: 'pos', label: 'Position (detents)', t: 'range', min: -50, max: 50, step: 1, live: true }],
    pins: () => A.row(['GND', '+', 'SW', 'DT', 'CLK']), size: () => ({ w: 40, h: 10 }),
    svg(p, st) {
      const a = (+p.props.pos || 0) * 18, pr = st && st.pressed;
      return A.hdr(5) + A.pcb(-8, -66, 56, 58) + A.mh(-4, -62, 1.6) + A.mh(44, -62, 1.6) + `<rect x="5" y="-54" width="30" height="30" rx="2" fill="#bfc5cc" stroke="#6f767e"/>` +
        `<g transform="rotate(${a} 20 -39)"><circle cx="20" cy="-39" r="${pr ? 12 : 13}" fill="url(#sdKnob)" stroke="#000" stroke-width=".6"/>${Array.from({ length: 20 }, (_, k) => `<line x1="20" y1="-52" x2="20" y2="-49.5" stroke="#000a" stroke-width=".9" transform="rotate(${k * 18} 20 -39)"/>`).join('')}<rect x="19" y="-49" width="2" height="7" rx="1" fill="#ddd"/></g>` +
        A.title(20, -70, `KY-040 · ${+p.props.pos || 0}`) + A.lbls(['GND', '+', 'SW', 'DT', 'CLK']) + A.dots(this.pins(p));
    },
    wheel(p, d) { p.props.pos = clamp((+p.props.pos || 0) - d, -50, 50); return true; },
    stamp(p, cx) {
      const st = cx.state(p), ph = QUAD[((st.phase || 0) % 4 + 4) % 4], v = cx.node(p, '+'), g = cx.node(p, 'GND');
      load(cx, p, 0.2, '+');
      for (const [pin, lv] of [['CLK', ph[0]], ['DT', ph[1]]]) { cx.add({ kind: 'R', a: cx.node(p, pin), b: v, r: 10e3 }, p); if (!lv) cx.add({ kind: 'R', a: cx.node(p, pin), b: g, r: 20 }, p); }
      cx.add({ kind: 'R', a: cx.node(p, 'SW'), b: v, r: 10e3 }, p); if (st.pressed) cx.add({ kind: 'R', a: cx.node(p, 'SW'), b: g, r: 20 }, p);
    },
    tick(p, c) {   // walk the quadrature sequence towards the target position, one phase per 2 ms
      const st = c.state(p); if (st.at === undefined) { st.at = 0; st.phase = 0; st.target0 = +p.props.pos || 0; }
      const target = ((+p.props.pos || 0) - st.target0) * 4; if (st.at === target) return st.swWas !== (st.swWas = !!st.pressed);
      if (st.tNext !== undefined && c.t < st.tNext) return false;
      st.at += Math.sign(target - st.at); st.phase = st.at; st.tNext = c.t + 2e-3; return true;
    },
    readout(p, cx) { const st = cx.state(p); return `pos ${+p.props.pos || 0} · scroll over the knob to turn, hold to press`; },
  }, { bom: () => ({ key: 'ky040', name: 'Rotary encoder module KY-040', q: 'KY-040 rotary encoder module' }) });

  // ---------- analog joystick (2 pots + push switch) ----------
  R.register('joystick', {
    label: 'Analog joystick (XY + switch)', cat: 'Input', props: { x: 0, y: 0 }, prefix: 'JOY', interactive: true,
    edit: [{ k: 'x', label: 'X (−1…1)', t: 'range', min: -1, max: 1, step: 0.01, live: true }, { k: 'y', label: 'Y (−1…1)', t: 'range', min: -1, max: 1, step: 0.01, live: true }],
    pins: () => A.row(['GND', '+5V', 'VRx', 'VRy', 'SW']), size: () => ({ w: 40, h: 10 }),
    svg(p, st) {
      const x = 20 + 9 * (+p.props.x || 0), y = -42 - 9 * (+p.props.y || 0), pr = st && st.pressed;
      return A.hdr(5) + A.pcb(-10, -80, 60, 70, 'url(#sdPcbBlk)') + A.mh(-6, -76, 1.8) + A.mh(46, -76, 1.8) + `<rect x="1" y="-62" width="38" height="40" rx="3" fill="#2a2c30" stroke="#000"/><circle cx="20" cy="-42" r="17" fill="#15171a" stroke="#3c4048"/>` +
        `<circle cx="${x}" cy="${y}" r="${pr ? 11 : 12}" fill="url(#sdKnob)" stroke="#000"/>${Array.from({ length: 4 }, (_, i) => `<circle cx="${x}" cy="${y}" r="${3 + i * 2.2}" fill="none" stroke="#ffffff14"/>`).join('')}` +
        A.title(20, -84, `JOY ${(+p.props.x).toFixed(2)}, ${(+p.props.y).toFixed(2)}`) + A.lbls(['GND', '+5V', 'VRx', 'VRy', 'SW']) + A.dots(this.pins(p));
    },
    stamp(p, cx) {
      const st = cx.state(p), v = cx.node(p, '+5V'), g = cx.node(p, 'GND');
      for (const [pin, k] of [['VRx', 'x'], ['VRy', 'y']]) { const f = clamp((1 + (+p.props[k] || 0)) / 2, 0.001, 0.999); cx.add({ kind: 'R', a: v, b: cx.node(p, pin), r: 10e3 * (1 - f) }, p); cx.add({ kind: 'R', a: cx.node(p, pin), b: g, r: 10e3 * f }, p); }
      if (st.pressed) cx.add({ kind: 'R', a: cx.node(p, 'SW'), b: g, r: 0.5, main: true }, p);   // switch to GND; use INPUT_PULLUP
    },
    readout(p, cx) { const st = cx.state(p); return `X ${(+p.props.x).toFixed(2)} Y ${(+p.props.y).toFixed(2)} · SW ${st.pressed ? 'pressed' : 'open'} (needs INPUT_PULLUP)`; },
  }, { bom: () => ({ key: 'joy', name: 'Analog joystick module (KY-023)', q: 'KY-023 analog joystick module' }) });

  // ---------- BMP280 (I2C, chip-id 0x58; register model shared with BME280) ----------
  function bmpDev(q) {
    const D = root.I2CDev; const d = new D.BME280(() => ({ temp: +q.props.temp, hum: 0, press: +q.props.press })); d.r[0xD0] = 0x58; return d;
  }
  R.register('bmp280', {
    label: 'BMP280 temp/pressure (I2C)', cat: CAT, props: { addr: '0x76', addrs: ['0x76', '0x77'], temp: 22.5, press: 1013.25 }, prefix: 'BMP',
    edit: [{ k: 'addr', label: 'I2C address', t: 'sel', opts: ['0x76', '0x77'] }, { k: 'temp', label: 'Temperature (°C)', t: 'range', min: -40, max: 85, step: 0.1, live: true }, { k: 'press', label: 'Pressure (hPa)', t: 'range', min: 300, max: 1100, step: 0.25, live: true }],
    pins: () => A.row(['GND', 'VCC', 'SCL', 'SDA']), size: () => ({ w: 30, h: 10 }),
    svg(p) { return A.hdr(4) + A.pcb(-6, -44, 42, 36, 'url(#sdPcbPur)') + A.mh(-1, -39, 1.8) + A.mh(31, -39, 1.8) + `<rect x="10" y="-33" width="10" height="9" rx="1" fill="url(#sdMetal)" stroke="#555" stroke-width=".4"/><circle cx="12" cy="-31" r=".8" fill="#333"/>` + A.smd(2, -20) + A.smd(23, -20) + A.title(15, -48, `BMP280 ${(+p.props.temp).toFixed(1)}°C ${(+p.props.press).toFixed(0)} hPa`) + A.lbls(['GND', 'VCC', 'SCL', 'SDA']) + A.dots(this.pins(p)); },
    stamp(p, cx) { const v = cx.node(p, 'VCC'); load(cx, p, 0.5); cx.add({ kind: 'R', a: cx.node(p, 'SCL'), b: v, r: 10e3 }, p); cx.add({ kind: 'R', a: cx.node(p, 'SDA'), b: v, r: 10e3 }, p); },
    readout(p, cx) { const st = cx.state(p); return `${p.props.addr} · ${st.i2cInfo || 'no traffic yet'}`; },
  }, { i2c: bmpDev, bom: () => ({ key: 'bmp280', name: 'BMP280 pressure/temperature module (I2C)', q: 'BMP280 pressure sensor module I2C 3.3V' }) });

  // ---------- HX711 24-bit load-cell ADC + bar load cell ----------
  R.register('hx711', {
    label: 'HX711 + load cell (scale)', cat: CAT, props: { grams: 0, scale: 420, offset: 8400 }, prefix: 'HX',
    edit: [{ k: 'grams', label: 'Load (g)', t: 'range', min: 0, max: 5000, step: 1, live: true }, { k: 'scale', label: 'Counts per gram', t: 'num' }, { k: 'offset', label: 'Zero offset (counts)', t: 'num' }],
    pins: () => A.row(['GND', 'DT', 'SCK', 'VCC']), size: () => ({ w: 30, h: 10 }),
    svg(p, st) {
      const g = +p.props.grams || 0, bend = Math.min(3, g / 1500);
      return A.hdr(4) + A.pcb(-6, -48, 42, 40, 'url(#sdPcbGrn)') + A.chip(6, -38, 18, 12, 'HX711') + A.smd(0, -22) + A.smd(25, -22) + A.silk(15, -14, 'GND DT SCK VCC', 3) +
        `<path d="M-6 -44 C-20 -60 -30 -70 -40 -78" stroke="#d33" stroke-width="1.4" fill="none"/><path d="M-6 -40 C-22 -58 -32 -66 -40 -74" stroke="#222" stroke-width="1.4" fill="none"/><path d="M-6 -36 C-24 -54 -34 -62 -40 -70" stroke="#eee" stroke-width="1.4" fill="none"/><path d="M-6 -32 C-26 -50 -36 -58 -40 -66" stroke="#2a7" stroke-width="1.4" fill="none"/>` +
        `<path d="M-120 -80 h80 v14 h-80 z" transform="rotate(${-bend} -40 -73)" fill="url(#sdMetal)" stroke="#6b737c"/><rect x="-96" y="-77" width="30" height="8" rx="4" fill="#4a5058" transform="rotate(${-bend} -40 -73)"/>` +
        (g > 0 ? `<rect x="-112" y="${-80 - Math.min(26, 6 + g / 250)}" width="22" height="${Math.min(26, 6 + g / 250)}" rx="2" fill="#c08a3a" stroke="#6a4a1a"/>` : '') +
        A.title(-40, -110, `${g.toFixed(0)} g`) + A.lbls(['GND', 'DT', 'SCK', 'VCC']) + A.dots(this.pins(p));
    },
    raw(p) { let v = Math.round((+p.props.offset || 0) + (+p.props.grams || 0) * (+p.props.scale || 420)); v = clamp(v, -0x800000, 0x7fffff); return v & 0xffffff; },
    stamp(p, cx) { const st = cx.state(p); load(cx, p, 1.5); driveOut(cx, p, 'DT', st.dt === undefined ? 0 : st.dt); },
    espStep(p, c) {   // DOUT low = ready. Each SCK rising edge shifts the next bit (MSB first); pulses 25-27 select gain, then DOUT returns high until the next conversion
      const st = c.state(p), sck = c.drive(p, 'SCK');
      if (st.lastSck === 0 && sck === 1) {
        if (st.n === undefined) st.n = 0;
        if (st.n === 0) st.word = this.raw(p);
        st.n++;
        if (st.n <= 24) st.dt = (st.word >> (24 - st.n)) & 1; else { st.dt = 1; }
      } else if (st.lastSck === 1 && sck === 0 && st.n >= 25) { st.gain = st.n === 25 ? 128 : st.n === 26 ? 32 : 64; st.n = 0; st.dt = 0; st.reads = (st.reads || 0) + 1; }
      st.lastSck = sck;
    },
    readout(p, cx) { const st = cx.state(p); return `raw ${this.raw(p) << 8 >> 8} · ${st.reads || 0} reads`; },
  }, { bom: () => ({ key: 'hx711', name: 'HX711 amplifier + 5 kg bar load cell', q: 'HX711 load cell 5kg kit' }) });
})(typeof window !== 'undefined' ? window : globalThis);
