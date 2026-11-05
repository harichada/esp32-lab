/* Example projects for the IC / passive add-on parts: NE555 LED blinker (no MCU) and ESP32 + 74HC595 8-LED chaser. */
(function (root) {
  const P = root.Parts, T = P.T, R = root.PartsReg, E = root.Examples;
  let uid = 0, wid = 0;
  const part = (type, x, y, props = {}, rot = 0, pid) => ({ id: pid || type.slice(0, 3) + 'x' + (++uid), type, x, y, rot, props: Object.assign({}, T[type].props, props) });
  const pin = (p, name) => { const q = T[p.type].pins(p).find((z) => z.name === name); if (!q) throw new Error('no pin ' + name + ' on ' + p.type); return P.pinWorld(p, q); };
  const pt = (x, y) => ({ x, y });
  const path = (color, ...q) => ({ id: 'iw' + (++wid), a: { x: q[0].x, y: q[0].y }, b: { x: q[q.length - 1].x, y: q[q.length - 1].y }, pts: q.slice(1, -1).map((z) => ({ x: z.x, y: z.y })), color });
  const basicCat = (E && E.BASIC_CAT) || 'Basic circuits (no ESP32)';

  R.example('ic_555blink', '555 timer LED blinker (no ESP32)', () => {
    const bat = part('battery9v', 120, 420, {}, 0, 'BAT1'), u = part('ne555', 300, 300, {}, 0, 'U1');
    const r1 = part('resistor', 310, 160, { r: 1000 }, 1, 'R1'), r2 = part('resistor', 310, 230, { r: 47000 }, 0, 'R2');
    const c1 = part('ecap', 390, 380, { c: '10u' }, 0, 'C1'), r3 = part('resistor', 200, 315, { r: 470 }, 0, 'R3'), led = part('led', 200, 340, { color: 'red' }, 1, 'LED1');
    const J1 = pt(300, 150), J2 = pt(310, 150), J3 = pt(350, 250), J4 = pt(390, 340), G1 = pt(200, 440), G2 = pt(300, 440);
    return { name: '555 timer LED blinker (astable, no ESP32)', mode: 'circuit', code: '// Basic circuit — no ESP32, no code. Press Run: the NE555 is simulated live.\n', parts: [bat, u, r1, r2, c1, r3, led], wires: [
      path('red', pin(bat, '+'), pt(120, 150), J1), path('red', J1, pin(u, 'VCC')), path('red', J1, J2), path('red', J2, pin(r1, '1')),
      path('red', pin(u, 'RESET'), pt(330, 320), pt(450, 320), pt(450, 150), J2),
      path('orange', pin(r1, '2'), pin(r2, '1')), path('orange', pin(u, 'DIS'), pin(r2, '1')),
      path('yellow', pin(r2, '2'), J3), path('yellow', J3, pt(320, 250), pin(u, 'THR')), path('yellow', J3, pt(390, 250), J4), path('yellow', J4, pin(c1, '+')), path('yellow', J4, pt(310, 340), pin(u, 'TRIG')),
      path('green', pin(u, 'OUT'), pt(320, 315), pin(r3, '2')), path('green', pin(r3, '1'), pin(led, 'A')),
      path('black', pin(bat, '-'), pt(140, 440), G1), path('black', G1, pin(led, 'C')), path('black', G1, G2), path('black', G2, pin(u, 'GND')), path('black', G2, pt(400, 440), pin(c1, '-')),
    ], notes: 'Classic NE555 astable: C1 charges through R1 + R2 to ⅔·VCC (THR) and discharges through R2 into DIS down to ⅓·VCC (TRIG). f ≈ 1.44 / ((R1 + 2·R2)·C1) ≈ 1.5 Hz with 1 k / 47 k / 10 µF. Change C1 (Inspector → Capacitance) or R2 to change the rate; pull RESET low to stop it. Add a Scope probe on C1 to see the ⅓–⅔ sawtooth.' };
  }, basicCat);

  const CHASER = `// ESP32 + 74HC595: 8-LED chaser with shiftOut() (bit-banged on GPIO23 data, GPIO18 clock, GPIO5 latch)
const int DATA_PIN = 23, CLOCK_PIN = 18, LATCH_PIN = 5;

void show(uint8_t bits) {
  digitalWrite(LATCH_PIN, LOW);
  shiftOut(DATA_PIN, CLOCK_PIN, MSBFIRST, bits);   // QH gets bit 7 ... QA gets bit 0
  digitalWrite(LATCH_PIN, HIGH);                    // rising RCLK copies the shift register to the outputs
}

void setup() {
  Serial.begin(115200);
  pinMode(DATA_PIN, OUTPUT); pinMode(CLOCK_PIN, OUTPUT); pinMode(LATCH_PIN, OUTPUT);
  Serial.println("74HC595 chaser");
}

void loop() {
  for (int i = 0; i < 8; i++) { show(1 << i); delay(120); }
  for (int i = 6; i > 0; i--) { show(1 << i); delay(120); }
}
`;
  R.example('ic_595chaser', '★ 74HC595 8-LED chaser (shiftOut)', () => {
    const esp = part('esp32', 100, 100, {}, 0, 'ESP1'), u = part('ic74hc595', 300, 330, {}, 0, 'U1');
    const parts = [esp, u], wires = [], Q = ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'], cols = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'red', 'orange'];
    const J = pt(300, 230), gOE = part('ground', 330, 282, {}, 2, 'GND1'), gU = part('ground', 370, 350, {}, 0, 'GND2');
    parts.push(gOE, gU);
    wires.push(path('red', pin(esp, '3V3'), pt(100, 230), J), path('red', J, pin(u, 'VCC')), path('red', J, pt(360, 230), pin(u, 'SRCLR')));
    wires.push(path('black', pin(u, 'OE'), pin(gOE, 'GND')), path('black', pin(u, 'GND'), pin(gU, 'GND')));
    wires.push(path('blue', pin(esp, 'D23'), pt(240, 250), pt(320, 250), pin(u, 'SER')), path('yellow', pin(esp, 'D18'), pt(180, 260), pt(350, 260), pin(u, 'SRCLK')), path('green', pin(esp, 'D5'), pt(170, 270), pt(340, 270), pin(u, 'RCLK')));
    Q.forEach((n, i) => {
      const x = 200 + i * 30, lane = 345 + i * 7, pp = pin(u, n);
      const r = part('resistor', x, 410, { r: 330 }, 1, 'R' + (i + 1)), l = part('led', x, 470, { color: cols[i] }, 1, 'LED' + (i + 1)), g = part('ground', x, 500, {}, 0, 'G' + (i + 3));
      parts.push(r, l, g);
      wires.push(n === 'QA' ? path('orange', pp, pt(310, 290), pt(290, 290), pt(290, lane), pt(x, lane), pin(r, '1')) : path('orange', pp, pt(pp.x, lane), pt(x, lane), pin(r, '1')));
      wires.push(path('orange', pin(r, '2'), pin(l, 'A')), path('black', pin(l, 'C'), pin(g, 'GND')));
    });
    return { name: '74HC595 8-LED chaser (real firmware)', mode: 'qemu', code: CHASER, parts, wires, notes: 'shiftOut() bit-bangs GPIO23 (SER) and GPIO18 (SRCLK); a rising edge on GPIO5 (RCLK) latches the byte onto QA…QH. The 595 model evaluates every GPIO edge in lock-step with the emulated ESP32, so the chaser is exactly what the firmware sends. OE̅ is tied low, SRCLR̅ high.' };
  });
})(typeof window !== 'undefined' ? window : globalThis);
