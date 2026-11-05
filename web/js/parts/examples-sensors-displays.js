/* Examples for the sensor / display add-on parts (JS-sketch mode, so they run without the QEMU backend). */
(function (root) {
  const P = root.Parts, R = root.PartsReg;
  let uid = 0;
  const part = (type, x, y, props = {}, rot = 0, pid) => ({ id: pid || type.slice(0, 3) + 'x' + (++uid), type, x, y, rot, props: Object.assign({}, P.T[type].props, props) });
  const pin = (p, name) => P.pinWorld(p, P.T[p.type].pins(p).find((z) => z.name === name));
  const wire = (color, ...pts) => ({ id: 'wx' + (++uid), a: pts[0], b: pts[pts.length - 1], pts: pts.slice(1, -1), color });
  // signal from a module pin (above the board) down to an ESP32 top-header pin through its own horizontal lane
  function kit() {
    const esp = part('esp32', 300, 420, { power: 'usb' }, 0, 'esp'), parts = [esp], wires = [];
    let lane = 300;
    const sig = (q, qp, ep, color = 'orange') => { const a = pin(q, qp), b = pin(esp, ep); lane += 8; wires.push(wire(color, a, { x: a.x, y: lane }, { x: b.x, y: lane }, b)); };
    const power = (q, vcc = 'VCC', gnd = 'GND', v = 'vcc33') => {
      const a = pin(q, vcc), g = pin(q, gnd);
      const s = part(v, a.x - 30, a.y + 40, {}, 0); parts.push(s); wires.push(wire('red', a, { x: a.x, y: a.y + 20 }, { x: a.x - 30, y: a.y + 20 }, pin(s, '+')));
      const sg = part('ground', s.x + 20, s.y + 20, {}, 0); parts.push(sg); wires.push(wire('black', pin(s, 'GND'), pin(sg, 'GND')));
      const gg = part('ground', g.x, g.y + 30, {}, 0); parts.push(gg); wires.push(wire('black', g, pin(gg, 'GND')));
    };
    return { esp, parts, wires, sig, power, add: (q) => { parts.push(q); return q; } };
  }
  const SENS_JS = `// Sensor panel (JS sketch): joystick, LDR module, PIR, HC-SR04 and soil moisture.
// Move the sliders in the Inspector (select a part), hold the PIR / joystick to trigger them.
const JOY_X = 34, JOY_Y = 35, JOY_SW = 27, LDR_AO = 32, LDR_DO = 33, PIR = 26, TRIG = 25, ECHO = 14, SOIL = 36;

function setup() {
  Serial.begin(115200);
  pinMode(JOY_SW, INPUT_PULLUP); pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); pinMode(PIR, INPUT); pinMode(LDR_DO, INPUT);
}

function distanceCm() {           // HC-SR04: 10 us trigger, then time the ECHO pulse (58 us per cm)
  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  let n = 0; while (!digitalRead(ECHO) && n++ < 500) delayMicroseconds(20);
  const t0 = micros(); n = 0; while (digitalRead(ECHO) && n++ < 2000) delayMicroseconds(20);
  return (micros() - t0) / 58;
}

function loop() {
  const cm = distanceCm();
  Serial.printf("joy %4d,%4d sw=%d | light %4d %s | PIR %s | %3.0f cm | soil %4d\\n",
    analogRead(JOY_X), analogRead(JOY_Y), digitalRead(JOY_SW), analogRead(LDR_AO), digitalRead(LDR_DO) ? "dark  " : "bright",
    digitalRead(PIR) ? "MOTION" : "idle  ", cm, analogRead(SOIL));
  delay(400);
}
`;
  R.example('sensorsjs', '★ Sensor panel: joystick, LDR, PIR, HC-SR04, soil (JS)', () => {
    const k = kit();
    const joy = k.add(part('joystick', 60, 220, {}, 0, 'JOY1')); k.power(joy, '+5V', 'GND');
    k.sig(joy, 'VRx', 'D34', 'yellow'); k.sig(joy, 'VRy', 'D35', 'green'); k.sig(joy, 'SW', 'D27', 'blue');
    const ldr = k.add(part('ldrmod', 190, 220, {}, 0, 'LDRM1')); k.power(ldr);
    k.sig(ldr, 'AO', 'D32', 'yellow'); k.sig(ldr, 'DO', 'D33', 'purple');
    const pir = k.add(part('pir', 310, 220, {}, 0, 'PIR1')); k.power(pir);
    k.sig(pir, 'OUT', 'D26', 'orange');
    const us = k.add(part('hcsr04', 440, 220, {}, 0, 'US1')); k.power(us);
    k.sig(us, 'TRIG', 'D25', 'white'); k.sig(us, 'ECHO', 'D14', 'green');
    const soil = k.add(part('soil', 580, 220, {}, 0, 'SOIL1')); k.power(soil);
    k.sig(soil, 'AO', 'VP', 'yellow');
    return { name: 'Sensor panel (JS sketch)', mode: 'js', code: SENS_JS, parts: k.parts, wires: k.wires, notes: 'JS sketch: analog modules are real dividers in the solved circuit (analogRead = node voltage); the HC-SR04 answers a TRIG pulse with an ECHO pulse of 58 µs/cm in simulated time; the PIR output holds high for its hold time after motion (hold the part or tick "Motion present").' };
  });

  const DISP_JS = `// TM1637 4-digit counter + MAX7219 8x8 animation, bit-banged from a JS sketch.
const CLK = 18, DIO = 19;                  // TM1637 (open-drain: INPUT = released high)
const MDIN = 23, MCS = 5, MCLK = 4;        // MAX7219
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
let count = 0;

function line(p, v) { if (v) pinMode(p, INPUT); else { pinMode(p, OUTPUT); digitalWrite(p, LOW); } delayMicroseconds(5); }
function tmStart() { line(DIO, 0); }
function tmStop() { line(CLK, 0); line(DIO, 0); line(CLK, 1); line(DIO, 1); }
function tmByte(b) {
  for (let i = 0; i < 8; i++) { line(CLK, 0); line(DIO, (b >> i) & 1); line(CLK, 1); }
  line(CLK, 0); line(DIO, 1); line(CLK, 1); line(CLK, 0);   // ACK clock
}
function tmShow(n, colon) {
  tmStart(); tmByte(0x40); tmStop();
  tmStart(); tmByte(0xC0);
  const d = [Math.floor(n / 1000) % 10, Math.floor(n / 100) % 10, Math.floor(n / 10) % 10, n % 10];
  for (let i = 0; i < 4; i++) tmByte(SEG[d[i]] | (i == 1 && colon ? 0x80 : 0));
  tmStop();
  tmStart(); tmByte(0x8F); tmStop();       // display on, brightness 7
}
function mx(reg, val) {
  digitalWrite(MCS, LOW); delayMicroseconds(2);
  const w = (reg << 8) | val;
  for (let i = 15; i >= 0; i--) { digitalWrite(MDIN, (w >> i) & 1); delayMicroseconds(2); digitalWrite(MCLK, HIGH); delayMicroseconds(2); digitalWrite(MCLK, LOW); delayMicroseconds(2); }
  digitalWrite(MCS, HIGH); delayMicroseconds(2);
}
const HEART = [0x00, 0x66, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C, 0x18];

function setup() {
  Serial.begin(115200);
  pinMode(MDIN, OUTPUT); pinMode(MCS, OUTPUT); pinMode(MCLK, OUTPUT); digitalWrite(MCS, HIGH);
  line(CLK, 1); line(DIO, 1);
  mx(0x0F, 0); mx(0x09, 0); mx(0x0B, 7); mx(0x0A, 8); mx(0x0C, 1);
}

function loop() {
  tmShow(count, count % 2 == 0);
  const beat = count % 2 == 0;
  for (let r = 0; r < 8; r++) mx(r + 1, beat ? HEART[r] : (HEART[r] >> 1) & 0x3C);
  Serial.printf("count %d\\n", count);
  count++;
  delay(500);
}
`;
  R.example('displaysjs', '★ TM1637 counter + MAX7219 heart (JS)', () => {
    const k = kit();
    const tm = k.add(part('tm1637', 100, 230, {}, 0, 'TM1')); k.power(tm);
    k.sig(tm, 'CLK', 'D18', 'yellow'); k.sig(tm, 'DIO', 'D19', 'green');
    const mx = k.add(part('max7219', 330, 230, {}, 0, 'MTX1')); k.power(mx, 'VCC', 'GND', 'vcc5');
    k.sig(mx, 'DIN', 'D23', 'orange'); k.sig(mx, 'CS', 'D5', 'purple'); k.sig(mx, 'CLK', 'D4', 'blue');
    const lcd = k.add(part('lcd2004', 520, 230, {}, 0, 'LCD1')); k.power(lcd);
    return { name: 'TM1637 + MAX7219 displays (JS sketch)', mode: 'js', code: DISP_JS, parts: k.parts, wires: k.wires, notes: 'JS sketch bit-bangs the TM1637 2-wire protocol (start/stop/ACK, auto-increment) and MAX7219 16-bit frames; the parts decode the real pin edges. The 20×4 LCD (I2C) is driven by real firmware (LiquidCrystal_PCF8574 with lcd.begin(20, 4)).' };
  });
})(typeof window !== 'undefined' ? window : globalThis);
