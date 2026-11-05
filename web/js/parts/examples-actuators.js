/* Examples for the actuator / power / semiconductor add-on parts. */
(function (root) {
  const P = root.Parts, R = root.PartsReg; if (!P || !R) return;
  let uid = 0;
  const part = (type, x, y, props = {}, rot = 0, id) => ({ id: id || type.slice(0, 3) + (++uid), type, x, y, rot, props: Object.assign(JSON.parse(JSON.stringify(P.T[type].props || {})), props) });
  const pin = (p, name) => { const q = P.T[p.type].pins(p).find((z) => z.name === name); if (!q) throw new Error('no pin ' + name + ' on ' + p.type); return P.pinWorld(p, q); };
  const pt = (x, y) => ({ x, y });
  const W = (color, ...ps) => ({ id: 'w' + (++uid), a: { x: ps[0].x, y: ps[0].y }, b: { x: ps[ps.length - 1].x, y: ps[ps.length - 1].y }, pts: ps.slice(1, -1).map((q) => ({ x: q.x, y: q.y })), color });
  const lw = (color, a, b, mid) => W(color, a, pt(a.x, mid), pt(b.x, mid), b);   // vertical-horizontal-vertical route
  const gnd = (parts, wires, at, dy = 20) => { const g = part('ground', at.x, at.y + dy); parts.push(g); wires.push(W('black', at, pin(g, 'GND'))); };

  const MOTION_INO = `// Relay + L298N DC motor + 28BYJ-48 stepper (ULN2003) — plain Arduino-ESP32, no libraries.
const int IN1 = 13, IN2 = 12, IN3 = 14, IN4 = 27;   // ULN2003 inputs
const int RELAY = 26;                               // 1-ch relay module, LOW-trigger
const int ENA = 25, MA = 33, MB = 32;               // L298N channel A
const uint8_t SEQ[8] = {0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001};  // half-step
int phase = 0;
void stepOnce(int dir) {
  phase = (phase + dir + 8) % 8;
  digitalWrite(IN1, SEQ[phase] >> 3 & 1); digitalWrite(IN2, SEQ[phase] >> 2 & 1);
  digitalWrite(IN3, SEQ[phase] >> 1 & 1); digitalWrite(IN4, SEQ[phase] & 1);
}
void setup() {
  Serial.begin(115200);
  for (int p : {IN1, IN2, IN3, IN4, MA, MB}) pinMode(p, OUTPUT);
  pinMode(RELAY, OUTPUT); digitalWrite(RELAY, HIGH);   // HIGH = relay off on a LOW-trigger module
  digitalWrite(MA, HIGH); digitalWrite(MB, LOW);
}
unsigned long tRelay = 0, tMotor = 0, tStep = 0; int speed = 0, dirStep = 1; bool lamp = false; int steps = 0;
void loop() {
  unsigned long now = millis();
  if (now - tRelay > 2000) { tRelay = now; lamp = !lamp; digitalWrite(RELAY, lamp ? LOW : HIGH); Serial.printf("relay %s\\n", lamp ? "ON" : "off"); }
  if (now - tMotor > 100) {                      // ramp the DC motor up, then reverse
    tMotor = now; speed += 8;
    if (speed > 255) { speed = 60; bool f = digitalRead(MA); digitalWrite(MA, !f); digitalWrite(MB, f); Serial.println("motor reverse"); }
    analogWrite(ENA, speed);
  }
  if (now - tStep >= 2) { tStep = now; stepOnce(dirStep); if (++steps >= 2048) { steps = 0; dirStep = -dirStep; } }   // 2048 half-steps = half a turn
}
`;
  R.example('act_motion', '★ Relay + L298N motor + 28BYJ-48 stepper', () => {
    const parts = [], wires = [];
    const esp = part('esp32', 100, 440, { power: 'usb' }, 0, 'esp'); parts.push(esp);
    const uln = part('uln2003', 40, 280, {}, 0, 'U1'), stp = part('stepper28', 50, 140, {}, 0, 'M2'); parts.push(uln, stp);
    ['A', 'B', 'C', 'D', 'COM'].forEach((o, i) => wires.push(W(['#2f6fff', '#ff7ab8', '#ffd43b', '#ff922b', '#e03131'][i], pin(uln, o), pin(stp, ['BLU', 'PNK', 'YEL', 'ORG', 'RED'][i]))));
    [['IN1', 'D13'], ['IN2', 'D12'], ['IN3', 'D14'], ['IN4', 'D27']].forEach(([a, b], i) => wires.push(lw(['#4dabf7', '#da77f2', '#69db7c', '#ffa94d'][i], pin(uln, a), pin(esp, b), 330 + i * 10)));
    gnd(parts, wires, pin(uln, '-'), 30); wires.push(lw('red', pin(uln, '+'), pin(esp, 'VIN'), 310));
    const rl = part('relay1', 300, 280, { trig: 'low' }, 0, 'K1'); parts.push(rl);
    wires.push(lw('red', pin(rl, 'VCC'), pin(esp, 'VIN'), 300)); gnd(parts, wires, pin(rl, 'GND'), 30); wires.push(lw('#ffd43b', pin(rl, 'IN'), pin(esp, 'D26'), 380));
    const bat = part('battery9v', 380, 120, {}, 0, 'BAT1'), lamp = part('lamp', 290, 110, { v: 9, w: 1 }, 0, 'LAMP1'); parts.push(bat, lamp);
    wires.push(lw('red', pin(bat, '+'), pin(rl, 'COM'), 150)); wires.push(lw('orange', pin(rl, 'NO'), pin(lamp, '1'), 160)); wires.push(W('black', pin(lamp, '2'), pt(320, 90), pt(400, 90), pin(bat, '-')));
    const drv = part('l298n', 520, 440, { j5: true }, 0, 'U2'), mot = part('motor', 520, 240, { v: 9, r: 10 }, 0, 'M1'); parts.push(drv, mot);
    wires.push(W('orange', pin(drv, 'OUT1'), pt(520, 280), pt(520, 260), pin(mot, '+'))); wires.push(W('blue', pin(drv, 'OUT2'), pt(530, 270), pt(550, 270), pin(mot, '-')));
    wires.push(lw('#ff6b6b', pin(drv, 'ENA'), pin(esp, 'D25'), 400)); wires.push(lw('#4dd4ac', pin(drv, 'IN1'), pin(esp, 'D33'), 410)); wires.push(lw('#b197fc', pin(drv, 'IN2'), pin(esp, 'D32'), 420));
    const ps = part('bench', 700, 560, { pos: 0.4, ilim: 2 }, 0, 'PSU1'); parts.push(ps);
    wires.push(lw('red', pin(drv, 'VS'), pin(ps, '+'), 480)); wires.push(lw('black', pin(drv, 'GND'), pin(ps, '-'), 490)); gnd(parts, wires, pin(ps, '-'), 30);
    return { name: 'Relay + L298N DC motor + 28BYJ-48 stepper (real firmware)', mode: 'qemu', code: MOTION_INO, parts, wires,
      notes: 'Real Arduino-ESP32 firmware. GPIO26 clicks the LOW-trigger relay every 2 s (it switches a 9 V lamp through COM→NO). GPIO25 analogWrite() PWM sets the L298N ENA duty — the DC motor ramps up and reverses (IN1/IN2 = GPIO33/32); the module\'s 5 V jumper regulates its logic from the 12 V bench supply. GPIO13/12/14/27 bit-bang the half-step sequence into the ULN2003 (watch the A–D LEDs) and the 28BYJ-48 turns half a revolution each way (4096 half-steps / rev through the 64:1 gearbox). Hover parts for currents.' };
  });

  R.example('b_power', 'Regulated supply + solenoid (fuse, 1N4007, 7805, AMS1117, TIP120)', () => {
    const parts = [], wires = [];
    const bat = part('battery9v', 80, 420, {}, 0, 'BAT1'), fu = part('fuse', 100, 200, { rating: 1 }, 0, 'F1'), d1 = part('d1n4007', 160, 200, {}, 0, 'D1');
    const u1 = part('lm7805', 240, 260, {}, 0, 'U1'), u2 = part('ams1117', 360, 260, {}, 0, 'U2'), r1 = part('resistor', 420, 200, { r: 220 }, 0, 'R1'), led = part('led', 480, 200, { color: 'green', vf: 2.1 }, 0, 'LED1');
    const dmm = part('multimeter', 440, 430, { mode: 'V' }, 0, 'DMM1');
    parts.push(bat, fu, d1, u1, u2, r1, led, dmm);
    wires.push(W('red', pin(bat, '+'), pt(80, 200), pin(fu, '1')), W('red', pin(fu, '2'), pin(d1, 'A')), W('red', pin(d1, 'K'), pt(240, 200), pin(u1, 'IN')));
    wires.push(W('orange', pin(u1, 'OUT'), pt(260, 220), pt(380, 220), pin(u2, 'IN')), W('orange', pin(u2, 'OUT'), pt(370, 200), pin(r1, '1')), W('orange', pin(r1, '2'), pin(led, 'A')));
    const J1 = pt(250, 300), J2 = pt(360, 300), J3 = pt(150, 160);
    wires.push(W('black', pin(u1, 'GND'), J1), W('black', J1, J2), W('black', J2, pin(u2, 'GND')), W('black', J1, pt(250, 460), pt(100, 460), pin(bat, '-')), W('black', pin(led, 'C'), pt(530, 200), pt(530, 300), J2));
    wires.push(W('red', pin(dmm, '+'), pt(pin(dmm, '+').x, 450), pt(580, 450), pt(580, 240), pt(370, 240), pin(u2, 'OUT')), W('black', pin(dmm, 'COM'), pt(pin(dmm, 'COM').x, 460), pt(260, 460), pt(260, 310), pt(250, 310), J1));
    // solenoid switched by a TIP120 from the protected 9 V rail, flyback 1N4007 across the coil
    const sol = part('solenoid', 180, 100, { v: 9, r: 18 }, 0, 'SOL1'), d2 = part('d1n4007', 220, 60, {}, 2, 'D2'), q = part('tip120', 260, 140, {}, 0, 'Q1');
    const btn = part('pushbutton', 330, 110, { color: 'red', label: 'FIRE', key: 'f' }, 0, 'SW1'), rb = part('resistor', 380, 140, { r: 1000 }, 0, 'RB');
    parts.push(sol, d2, q, btn, rb);
    wires.push(W('red', pin(d1, 'K'), pt(200, 160), J3), W('red', J3, pt(150, 100), pin(sol, '+')), W('#9aa0a8', pin(d2, 'K'), pin(sol, '+')), W('#9aa0a8', pin(d2, 'A'), pin(sol, '-')));
    wires.push(W('blue', pin(sol, '-'), pt(220, 120), pt(270, 120), pin(q, 'C')), W('black', pin(q, 'E'), pt(280, 180), pt(250, 180), J1));
    wires.push(W('red', J3, pt(150, 40), pt(330, 40), pin(btn, '1.l')), W('orange', pin(btn, '2.l'), pt(350, 90), pt(380, 90), pin(rb, '1')), W('orange', pin(rb, '2'), pt(pin(rb, '2').x, 170), pt(260, 170), pin(q, 'B')));
    return { name: 'Regulated supply + solenoid driver', mode: 'circuit', code: '// Basic circuit — no ESP32, no code. Press Run (or just interact): the circuit is simulated live.\n', parts, wires,
      notes: '9 V battery → 1 A fuse → 1N4007 (reverse-polarity protection, ~0.9 V drop) → LM7805 (5 V) → AMS1117-3.3 → 220 Ω + green LED. The meter reads the 3.3 V rail; hover the regulators for dissipation and junction temperature (the 7805 needs ≥ 7 V in). Hold FIRE (F key): the TIP120 Darlington pulls in the 9 V solenoid; the 1N4007 across the coil is the flyback diode — delete it and the simulator warns about the inductive kick. Short the 3.3 V rail and watch the fuse blow.' };
  }, (root.Examples && root.Examples.BASIC_CAT) || 'Basic circuits (no ESP32)');
})(typeof window !== 'undefined' ? window : globalThis);
