/* Parts list (Bill of Materials): derives the physical parts for a project from its parts/wires
   and links each one to a stable Amazon search (no ASINs, so links never go dead). */
(function (root) {
  const AZ = (q) => 'https://www.amazon.com/s?k=' + encodeURIComponent(q);
  const fmtR = (r) => r >= 1e6 ? +(r / 1e6).toFixed(2) + 'MΩ' : r >= 1e3 ? +(r / 1e3).toFixed(2) + 'kΩ' : r + 'Ω';
  const fmtRq = (r) => r >= 1e6 ? +(r / 1e6).toFixed(2) + 'M ohm' : r >= 1e3 ? +(r / 1e3).toFixed(2) + 'k ohm' : r + ' ohm';
  const fmtC = (c) => c >= 1e-6 ? +(c * 1e6).toFixed(2) + 'µF' : c >= 1e-9 ? +(c * 1e9).toFixed(2) + 'nF' : +(c * 1e12).toFixed(0) + 'pF';
  const fmtCq = (c) => c >= 1e-6 ? +(c * 1e6).toFixed(2) + 'uF' : c >= 1e-9 ? +(c * 1e9).toFixed(2) + 'nF' : +(c * 1e12).toFixed(0) + 'pF';
  // type -> (props) => {key, name, q, note?}; null = virtual (instrument/supply/label), not a physical part
  const C = {
    esp32: () => ({ key: 'esp32', name: 'ESP32 dev board (DevKitC / DevKit V1, WROOM-32)', q: 'ESP32 DevKitC V4 WROOM-32', note: 'with USB cable' }),
    breadboard: () => ({ key: 'bb', name: 'Breadboard, 830 tie-points', q: '830 point solderless breadboard' }),
    resistor: (p) => ({ key: 'r' + p.r, name: 'Resistor ' + fmtR(p.r) + ' ¼ W', q: fmtRq(p.r) + ' resistor 1/4W' }),
    capacitor: (p) => ({ key: 'c' + p.c + p.kind, name: (p.kind === 'electrolytic' ? 'Electrolytic' : 'Ceramic') + ' capacitor ' + fmtC(p.c), q: fmtCq(p.c) + ' ' + (p.kind === 'electrolytic' ? 'electrolytic' : 'ceramic') + ' capacitor' }),
    led: (p) => ({ key: 'led' + p.color, name: 'LED 5 mm, ' + p.color, q: '5mm ' + p.color + ' LED diode' }),
    irled: () => ({ key: 'irled', name: 'IR LED 940 nm (TSAL6200)', q: 'TSAL6200 940nm IR LED' }),
    diode: () => ({ key: 'd4148', name: 'Diode 1N4148', q: '1N4148 switching diode' }),
    zener: (p) => ({ key: 'z' + p.vz, name: 'Zener diode ' + p.vz + ' V', q: p.vz + 'V zener diode' }),
    npn: () => ({ key: 'npn', name: 'NPN transistor 2N2222', q: '2N2222 NPN transistor TO-92' }),
    pnp: () => ({ key: 'pnp', name: 'PNP transistor 2N2907', q: '2N2907 PNP transistor TO-92' }),
    nmos: () => ({ key: 'nmos', name: 'N-MOSFET AO3400 (logic level)', q: 'AO3400 N-channel MOSFET' }),
    pushbutton: () => ({ key: 'btn', name: 'Tactile pushbutton 6×6 mm', q: '6x6mm tactile push button switch' }),
    key: () => ({ key: 'btn', name: 'Tactile pushbutton 6×6 mm', q: '6x6mm tactile push button switch' }),
    slideswitch: () => ({ key: 'sw', name: 'Slide switch SPDT', q: 'SPDT mini slide switch breadboard' }),
    potentiometer: (p) => ({ key: 'pot' + p.r, name: 'Potentiometer ' + fmtR(p.r) + ' linear', q: fmtRq(p.r).replace(' ohm', '') + ' linear potentiometer breadboard' }),
    ldr: () => ({ key: 'ldr', name: 'Photoresistor (LDR) GL5528', q: 'GL5528 photoresistor LDR' }),
    battery: () => ({ key: 'lipo', name: 'LiPo battery 3.7 V 1S', q: '3.7V 1S LiPo battery JST' }),
    ldo: () => ({ key: 'ldo', name: 'LDO regulator 3.3 V (MCP1700 / AP2112)', q: 'MCP1700 3.3V LDO regulator' }),
    buzzer: () => ({ key: 'buzz', name: 'Active buzzer 3.3–5 V', q: 'active buzzer module 5V' }),
    ssd1306: () => ({ key: 'oled', name: 'OLED SSD1306 128×64 I2C, 0.96"', q: 'SSD1306 0.96 inch OLED I2C 128x64' }),
    bme280: () => ({ key: 'bme', name: 'BME280 temp/pressure/humidity, I2C', q: 'BME280 sensor module I2C 3.3V' }),
    mpu6050: () => ({ key: 'mpu', name: 'MPU6050 accelerometer/gyro (GY-521)', q: 'MPU6050 GY-521 module' }),
    ili9341: () => ({ key: 'tft', name: 'TFT ILI9341 2.4"/2.8" 240×320 SPI', q: 'ILI9341 2.8 inch TFT SPI 240x320' }),
    mcp3008: () => ({ key: 'adc', name: 'MCP3008 8-ch 10-bit ADC (DIP-16)', q: 'MCP3008 ADC DIP' }),
    sdcard: () => ({ key: 'sd', name: 'microSD card module (SPI) + card', q: 'micro SD card module SPI' }),
    lcd1602: () => ({ key: 'lcd', name: 'LCD 16×2 with I2C backpack (PCF8574)', q: '16x2 LCD I2C PCF8574 module' }),
    servo: () => ({ key: 'servo', name: 'Micro servo SG90', q: 'SG90 micro servo' }),
    neopixel: (p) => ({ key: 'np' + p.n, name: 'NeoPixel strip WS2812B (' + p.n + ' LEDs)', q: 'WS2812B ' + p.n + ' LED strip' }),
    neoring: (p) => ({ key: 'nr' + p.n, name: 'NeoPixel ring WS2812B (' + p.n + ' LEDs)', q: 'WS2812B ' + p.n + ' LED ring' }),
    keypad: () => ({ key: 'keypad', name: '4x4 matrix membrane keypad', q: '4x4 matrix membrane keypad' }),
    battery9v: () => ({ key: 'b9v', name: '9 V battery + snap connector', q: '9V battery snap connector with leads' }),
    aapack: (p) => ({ key: 'aa' + p.n, name: p.n + '×AA battery holder with leads (+ ' + p.n + ' AA cells)', q: p.n + ' AA battery holder with wire leads' }),
    coincell: () => ({ key: 'cr2032', name: 'CR2032 coin cell + holder', q: 'CR2032 battery holder with leads' }),
    bench: () => ({ key: 'bench', name: 'Adjustable DC bench power supply 0–30 V', q: 'adjustable DC bench power supply 30V 5A' }),
    lamp: (p) => ({ key: 'lamp' + p.v, name: 'Miniature incandescent lamp ' + p.v + ' V + holder', q: p.v + 'V miniature incandescent bulb with holder' }),
    motor: () => ({ key: 'motor', name: 'Small DC hobby motor 3–6 V', q: 'small DC hobby motor 3V 6V' }),
    toggle: () => ({ key: 'toggle', name: 'SPST toggle switch', q: 'SPST mini toggle switch' }),
    multimeter: () => ({ key: 'dmm', name: 'Digital multimeter', q: 'digital multimeter' }),
    dht22: () => ({ key: 'dht', name: 'DHT22 / AM2302 temp/humidity', q: 'DHT22 AM2302 sensor module' }),
  };
  // Placement searches build temporary parts with these ids. They are not on the board.
  const PROBE = new Set(['_seat', '_new']);
  function list(proj) {
    const m = new Map(); const add = (e, n = 1) => { const o = m.get(e.key); if (o) o.qty += n; else m.set(e.key, Object.assign({ qty: n }, e)); };
    const parts = (proj && proj.parts) || [];
    const seen = new Set();
    let hasEsp = false, hasBb = false;
    for (const p of parts) {
      if (!p || PROBE.has(p.id)) continue;
      if (p.type === 'esp32') hasEsp = true;
      if (p.type === 'breadboard') hasBb = true;
      if (p.id && seen.has(p.id)) continue;
      if (p.id) seen.add(p.id);
      const f = C[p.type]; if (f) add(f(p.props || {}));
    }
    // Match the part type, not the catalog key. An ESP32 or breadboard entry
    // whose key is not 'esp32' / 'bb' must not add a second line of each.
    if (parts.length) {
      if (!hasEsp && proj.mode !== 'circuit') add(C.esp32());
      if (!hasBb) add(C.breadboard());
      const w = ((proj && proj.wires) || []).length;
      add({ key: 'jw', name: 'Jumper wires (M-M / M-F assortment)', q: 'breadboard jumper wires dupont kit', note: w ? '~' + w + ' wires in this circuit' : '' }, 1);
    }
    return [...m.values()].map((e) => Object.assign(e, { url: AZ(e.q) }));
  }
  function componentCount(rows) { return (rows || []).reduce((a, e) => a + (e.key === 'jw' ? 0 : e.qty), 0); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function text(proj) { return 'Parts list — ' + ((proj && proj.name) || 'project') + '\n' + list(proj).map((e) => `${e.qty} × ${e.name}${e.note ? ' (' + e.note + ')' : ''} — ${e.url}`).join('\n'); }
  // Re-render only while the Parts list tab is the open one. `open` is passed by tests;
  // the editor omits it and the tab panel decides.
  function sync(el, proj, open) {
    if (open === undefined && typeof document !== 'undefined') { const tab = document.getElementById('tab-bom'); open = !!(tab && tab.classList.contains('on')); }
    if (!open) return false;
    render(el, proj); return true;
  }
  function render(el, proj) {
    if (!el) return; const L = list(proj);
    const total = componentCount(L);
    el.innerHTML = `<div class="bom-h"><div><div class="bom-t">${esc((proj && proj.name) || 'Project')}</div><div class="muted small">${L.length} line items · ${total} components + jumper wires</div></div><button id="bBomCopy" type="button">Copy list</button></div>` +
      (L.length ? `<div class="bom-list" role="table">${L.map((e) => `<div class="bom-row" role="row"><span class="bom-q mono" role="cell">${e.qty}×</span><span class="bom-n" role="cell">${esc(e.name)}${e.note ? `<small>${esc(e.note)}</small>` : ''}</span><a class="bom-a" role="cell" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Buy on Amazon ↗</a></div>`).join('')}</div>` : '<p class="muted">No physical parts in this project yet.</p>') +
      '<p class="muted small">Links open an Amazon search for a matching part; check pinout/voltage (3.3 V logic) before buying. Supplies, ground symbols, meters and scope probes are virtual and not listed.</p>';
    const b = el.querySelector('#bBomCopy');
    b.onclick = async () => { const t = text(proj); try { await navigator.clipboard.writeText(t); } catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); } b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy list'; }, 1500); };
  }
  root.Bom = { list, text, render, sync, componentCount, CATALOG: C };
  if (typeof module !== 'undefined') module.exports = root.Bom;
})(typeof window !== 'undefined' ? window : globalThis);
