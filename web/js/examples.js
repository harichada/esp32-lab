/* Example projects. Coordinates are on the 10 px (0.1") grid; see parts.js for pin offsets. */
(function (root) {
  const P = root.Parts;
  let uid = 0; const id = (p) => p + (++uid);
  const part = (type, x, y, props = {}, rot = 0, pid) => ({ id: pid || id(type.slice(0, 3)), type, x, y, rot, props: Object.assign({}, P.T[type].props, props) });
  const pin = (p, name) => { const q = P.T[p.type].pins(p).find((z) => z.name === name); if (!q) throw new Error('no pin ' + name + ' on ' + p.type); return P.pinWorld(p, q); };
  const bb = (b, row, col) => { const h = P.T.breadboard.pins(b).find((z) => z.name === row + col); return { x: b.x + h.x, y: b.y + h.y }; };
  const W = [];
  const wire = (a, b, color = 'green', pts = []) => ({ id: id('w'), a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, pts: pts.map(([x, y]) => ({ x, y })), color });
  // manhattan polyline as a single wire with bend points
  const path = (color, ...p) => wire(p[0], p[p.length - 1], color, p.slice(1, -1).map((q) => [q.x, q.y]));
  const pt = (x, y) => ({ x, y });

  const BLINK = `/*
  Blink

  Turns an LED on for one second, then off for one second, repeatedly.
  (Unmodified Arduino IDE example 01.Basics/Blink. On ESP32 DevKit LED_BUILTIN = GPIO2.)
*/

// the setup function runs once when you press reset or power the board
void setup() {
  // initialize digital pin LED_BUILTIN as an output.
  pinMode(LED_BUILTIN, OUTPUT);
}

// the loop function runs over and over again forever
void loop() {
  digitalWrite(LED_BUILTIN, HIGH);  // turn the LED on (HIGH is the voltage level)
  delay(1000);                      // wait for a second
  digitalWrite(LED_BUILTIN, LOW);   // turn the LED off by making the voltage LOW
  delay(1000);                      // wait for a second
}
`;
  const BUTTON = `/*
  Button

  Turns on and off a light emitting diode(LED) connected to digital pin 13,
  when pressing a pushbutton attached to pin 2.

  The circuit:
  - LED attached from pin 13 to ground through 220 ohm resistor
  - pushbutton attached to pin 2 from +5V (3V3 on ESP32)
  - 10K resistor attached to pin 2 from ground

  (Unmodified Arduino IDE example 02.Digital/Button.)
*/

// constants won't change. They're used here to set pin numbers:
const int buttonPin = 2;  // the number of the pushbutton pin
const int ledPin = 13;    // the number of the LED pin

// variables will change:
int buttonState = 0;  // variable for reading the pushbutton status

void setup() {
  // initialize the LED pin as an output:
  pinMode(ledPin, OUTPUT);
  // initialize the pushbutton pin as an input:
  pinMode(buttonPin, INPUT);
}

void loop() {
  // read the state of the pushbutton value:
  buttonState = digitalRead(buttonPin);

  // check if the pushbutton is pressed. If it is, the buttonState is HIGH:
  if (buttonState == HIGH) {
    // turn LED on:
    digitalWrite(ledPin, HIGH);
  } else {
    // turn LED off:
    digitalWrite(ledPin, LOW);
  }
}
`;
  const TRANSISTOR = `// NPN low-side switch: GPIO4 -> 1k -> 2N2222 base, LED + 100R from 5 V (VIN) to the collector.
void setup() {
  Serial.begin(115200);
  pinMode(4, OUTPUT);
}

void loop() {
  digitalWrite(4, HIGH);
  Serial.println("transistor ON  (LED lit, Vce(sat) ~0.1 V)");
  delay(700);
  digitalWrite(4, LOW);
  Serial.println("transistor OFF");
  delay(700);
}
`;
  const POT_JS = `// JS sketch mode (analogRead/analogWrite run against the circuit solver in virtual time).
function setup() {
  Serial.begin(115200);
  pinMode(25, OUTPUT);
}

function loop() {
  const raw = analogRead(34);              // 0..4095 (12-bit)
  analogWrite(25, raw >> 4);               // 0..255 PWM duty -> average LED drive
  Serial.printf("pot=%4d  duty=%3d%%\\n", raw, Math.round(raw / 40.95));
  delay(200);
}
`;
  const POT_INO = `// Potentiometer -> LED brightness. Plain Arduino-ESP32 code: analogRead (SAR ADC1) + analogWrite (LEDC PWM).
const int potPin = 34;   // ADC1_CH6
const int ledPin = 25;

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
}

void loop() {
  int raw = analogRead(potPin);          // 0..4095
  analogWrite(ledPin, raw / 16);         // 0..255 duty (LEDC, 1 kHz)
  Serial.printf("pot=%4d  duty=%3d%%  %4u mV\\n", raw, raw * 100 / 4095, analogReadMilliVolts(potPin));
  delay(200);
}
`;
  const RC_JS = `// JS sketch: square wave on GPIO4 charges/discharges 10 kΩ · 47 µF (tau = 0.47 s). Watch the Scope tab.
function setup() { pinMode(4, OUTPUT); Serial.begin(115200); }

function loop() {
  digitalWrite(4, HIGH); Serial.println("charge");    delay(2500);
  digitalWrite(4, LOW);  Serial.println("discharge"); delay(2500);
}
`;

  function espOnBoard() {
    const b = part('breadboard', 0, 0, { cols: 63 }, 0, 'bb1');
    const esp = part('esp32', 20, 50, { power: 'usb' }, 0, 'esp');   // top header in row b (cols 2..16), bottom header in row i
    return { b, esp };
  }
  const EX = {};
  EX.blink = () => {
    const { b, esp } = espOnBoard();
    const r = part('resistor', bb(b, 'g', 25).x - 0, bb(b, 'g', 25).y, { r: 220 }, 0, 'R1');
    const led = part('led', bb(b, 'h', 29).x, bb(b, 'h', 29).y, { color: 'red' }, 0, 'LED1');
    return { name: 'Blink (real firmware)', mode: 'qemu', code: BLINK, parts: [b, esp, r, led], wires: [
      path('yellow', bb(b, 'j', 5), pt(bb(b, 'j', 5).x, 163), pt(bb(b, 'j', 25).x, 163), bb(b, 'j', 25)),
      wire(bb(b, 'j', 30), bb(b, 'bn', 31), 'black'),
      wire(bb(b, 'j', 3), bb(b, 'bn', 3), 'black'),
    ], notes: 'Unmodified Arduino Blink, compiled with arduino-cli (esp32 core) and run in Espressif QEMU. GPIO2 drives the external LED through 220 Ω (and the DevKit\'s blue LED).' };
  };
  EX.button = () => {
    const { b, esp } = espOnBoard();
    const btn = part('pushbutton', bb(b, 'e', 20).x, bb(b, 'e', 20).y, { key: 'b', label: 'BTN (b)' }, 0, 'BTN1');
    const rp = part('resistor', bb(b, 'g', 20).x, bb(b, 'g', 20).y, { r: 10000 }, 0, 'R2');
    const r = part('resistor', bb(b, 'c', 35).x, bb(b, 'c', 35).y, { r: 220 }, 0, 'R1');
    const led = part('led', bb(b, 'd', 39).x, bb(b, 'd', 39).y, { color: 'green' }, 0, 'LED1');
    return { name: 'Button + LED (real firmware)', mode: 'qemu', code: BUTTON, parts: [b, esp, btn, rp, r, led], wires: [
      path('yellow', bb(b, 'j', 5), pt(bb(b, 'j', 5).x, 163), pt(bb(b, 'j', 20).x, 163), bb(b, 'j', 20)),
      wire(bb(b, 'j', 2), bb(b, 'bp', 2), 'red'),            // 3V3 -> bottom + rail
      wire(bb(b, 'bp', 22), bb(b, 'j', 22), 'red'),          // + rail -> button other side
      wire(bb(b, 'j', 3), bb(b, 'bn', 3), 'black'),          // GND.1 -> bottom - rail
      path('black', bb(b, 'j', 24), pt(bb(b, 'j', 24).x + 5, 170), bb(b, 'bn', 25)),           // pulldown -> GND
      path('orange', bb(b, 'a', 4), pt(bb(b, 'a', 4).x, 30), pt(bb(b, 'a', 35).x, 30), bb(b, 'a', 35)), // GPIO13 -> R1
      wire(bb(b, 'a', 40), bb(b, 'tn', 40), 'black'),        // LED cathode -> top - rail
      wire(bb(b, 'a', 3), bb(b, 'tn', 3), 'black'),          // GND.2 -> top - rail
    ], notes: 'Unmodified Arduino Button example: pushbutton from 3V3 to GPIO2 with a 10 kΩ pull-down, LED on GPIO13. Click the button (or hold key "b").' };
  };
  EX.pot = () => {
    const esp = part('esp32', 300, 200, { power: 'usb' }, 0, 'esp');
    const pot = part('potentiometer', 120, 120, { r: 10000, pos: 0.5 }, 0, 'POT1');
    const r = part('resistor', 520, 120, { r: 220 }, 0, 'R1');
    const led = part('led', 580, 120, { color: 'blue' }, 0, 'LED1');
    const g = part('ground', 620, 160, {}, 0, 'G1');
    return { name: 'Potentiometer → LED PWM (real firmware)', mode: 'qemu', code: POT_INO, parts: [esp, pot, r, led, g], wires: [
      path('red', pin(pot, '1'), pt(120, 330), pt(300, 330), pin(esp, '3V3')),
      path('black', pin(pot, '2'), pt(140, 320), pt(310, 320), pin(esp, 'GND.1')),
      path('yellow', pin(pot, 'W'), pt(130, 160), pt(410, 160), pin(esp, 'D34')),
      path('orange', pin(esp, 'D25'), pt(370, 140), pt(520, 140), pin(r, '1')),
      wire(pin(r, '2'), pin(led, 'A'), 'orange'),
      path('black', pin(led, 'C'), pt(620, 120), pin(g, 'GND')),
    ], notes: 'Real firmware: analogRead hits the emulated SAR ADC (value = solved node voltage), analogWrite drives LEDC whose duty is bridged to the pin. Drag the pot in the Inspector or scroll over the knob. (Same circuit in JS mode: “Pot (JS sketch)”.) JS: analogRead (12-bit ADC from the solved node voltage) and analogWrite (PWM modelled as average drive). Drag the pot slider in the Inspector or scroll over the knob.' };
  };
  const FADE_INO = `// Hardware LED fade (LEDC fade engine + duty_chng_end interrupt, emulated in QEMU).
const int ledPin = 25;

void setup() {
  Serial.begin(115200);
  ledcAttach(ledPin, 5000, 10);   // 5 kHz, 10-bit
}

void loop() {
  Serial.println("fade up");
  ledcFade(ledPin, 0, 1023, 1500);
  delay(1700);
  Serial.println("fade down");
  ledcFade(ledPin, 1023, 0, 1500);
  delay(1700);
}
`;
  EX.fade = () => Object.assign(EX.pot(), { name: 'LED fade (real firmware, LEDC fade engine)', code: FADE_INO, notes: 'ledcFade() runs on the emulated LEDC hardware fade engine; QEMU steps the duty in virtual time and raises the duty-change-end interrupt the driver waits for.' });
  const I2C_INO = `// I2C: SSD1306 OLED + BME280 + MPU6050 on Wire (SDA=21, SCL=22). Unmodified Adafruit libraries.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_BME280.h>
#include <Adafruit_MPU6050.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
Adafruit_BME280 bme;
Adafruit_MPU6050 mpu;
bool haveBme, haveMpu;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  haveBme = bme.begin(0x76);
  haveMpu = mpu.begin(0x68);
  Serial.printf("BME280 %s, MPU6050 %s\\n", haveBme ? "ok" : "missing", haveMpu ? "ok" : "missing");
}

void loop() {
  float t = haveBme ? bme.readTemperature() : NAN, h = haveBme ? bme.readHumidity() : NAN, p = haveBme ? bme.readPressure() / 100.0 : NAN;
  sensors_event_t a, g, temp;
  if (haveMpu) mpu.getEvent(&a, &g, &temp);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2); display.setCursor(0, 0); display.printf("%.1f C", t);
  display.setTextSize(1); display.setCursor(0, 20); display.printf("%.0f%% RH %.1f hPa", h, p);
  display.setCursor(0, 34); display.printf("ax %.2f ay %.2f", haveMpu ? a.acceleration.x : 0, haveMpu ? a.acceleration.y : 0);
  display.setCursor(0, 44); display.printf("az %.2f m/s2", haveMpu ? a.acceleration.z : 0);
  display.drawRect(0, 56, 128, 8, SSD1306_WHITE); display.fillRect(2, 58, (int)(constrain(t, 0, 50) * 2.48), 4, SSD1306_WHITE);
  display.display();
  Serial.printf("T=%.2f C  H=%.1f %%  P=%.2f hPa  az=%.2f\\n", t, h, p, haveMpu ? a.acceleration.z : 0);
  delay(500);
}
`;
  EX.i2c = () => {
    const esp = part('esp32', 300, 300, { power: 'usb' }, 0, 'esp');
    const oled = part('ssd1306', 100, 500, {}, 0, 'OLED1'), bme = part('bme280', 520, 500, {}, 0, 'BME1'), mpu = part('mpu6050', 600, 500, {}, 0, 'MPU1');
    const parts = [esp, oled, bme, mpu], wires = [];
    const buses = [['GND', 'GND.1', 540, 'black'], ['VCC', '3V3', 550, 'red'], ['SCL', 'D22', 560, 'yellow'], ['SDA', 'D21', 570, 'blue']];
    for (const [mp, ep, y, col] of buses) {
      const pts = [pin(esp, ep), ...[oled, bme, mpu].map((m) => pin(m, mp))];
      for (const q of pts) wires.push(wire(q, pt(q.x, y), col));
      const xs = pts.map((q) => q.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) wires.push(wire(pt(xs[i - 1], y), pt(xs[i], y), col));
    }
    return { name: 'I2C: OLED + BME280 + MPU6050 (real firmware)', mode: 'qemu', code: I2C_INO, parts, wires, notes: 'Unmodified Adafruit SSD1306/BME280/MPU6050 libraries talk to the emulated ESP32 I2C controller; each transaction is bridged in lock-step to the virtual modules here. Select BME1/MPU1 and move the sliders; the OLED shows the framebuffer the firmware wrote.' };
  };
  const SPI_INO = `// SPI: ILI9341 TFT + MCP3008 ADC + microSD on the default VSPI bus (SCK=18, MOSI=23, MISO=19).
// Unmodified Adafruit_ILI9341 / Adafruit_MCP3008 libraries and the ESP32 core's SD (FAT) library.
#include <SPI.h>
#include <SD.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <Adafruit_MCP3008.h>

#define TFT_CS 15
#define TFT_DC 2
#define TFT_RST 4
#define ADC_CS 5
#define SD_CS 17

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);
Adafruit_MCP3008 adc;
bool sdOk;
int n;

void setup() {
  Serial.begin(115200);
  pinMode(TFT_CS, OUTPUT); digitalWrite(TFT_CS, HIGH);   // deselect everything before the first SPI transfer
  pinMode(ADC_CS, OUTPUT); digitalWrite(ADC_CS, HIGH);
  pinMode(SD_CS, OUTPUT); digitalWrite(SD_CS, HIGH);
  tft.begin();
  tft.setRotation(1);
  tft.fillScreen(ILI9341_NAVY);
  tft.fillRect(0, 0, 320, 36, ILI9341_ORANGE);
  tft.setTextColor(ILI9341_BLACK); tft.setTextSize(3); tft.setCursor(8, 7); tft.print("ESP32 SPI lab");
  adc.begin(ADC_CS);
  sdOk = SD.begin(SD_CS);
  Serial.printf("SD %s", sdOk ? "mounted" : "FAILED");
  if (sdOk) {
    Serial.printf(", %llu MB card\\n", SD.cardSize() / (1024 * 1024));
    File f = SD.open("/hello.txt");
    String s = f ? f.readString() : String("(no hello.txt)"); if (f) f.close();
    s.trim();
    Serial.printf("hello.txt: %s\\n", s.c_str());
    tft.setTextColor(ILI9341_YELLOW); tft.setTextSize(1); tft.setCursor(8, 220); tft.print("SD: "); tft.print(s);
    SD.remove("/log.txt");
  } else Serial.println();
}

void loop() {
  int raw = adc.readADC(0);
  float v = raw * 3.3 / 1023;
  tft.fillRect(0, 50, 320, 120, ILI9341_NAVY);
  tft.setTextColor(ILI9341_WHITE); tft.setTextSize(4); tft.setCursor(16, 60); tft.printf("CH0 %4d", raw);
  tft.setTextColor(ILI9341_GREEN); tft.setTextSize(3); tft.setCursor(16, 110); tft.printf("%.3f V", v);
  tft.drawRect(16, 150, 288, 18, ILI9341_WHITE); tft.fillRect(18, 152, raw * 284 / 1023, 14, ILI9341_GREEN);
  if (sdOk) {
    File lg = SD.open("/log.txt", FILE_APPEND);
    if (lg) { lg.printf("%d,%d\\n", n, raw); lg.close(); }
    File r = SD.open("/log.txt"); size_t sz = r ? r.size() : 0; if (r) r.close();
    Serial.printf("MCP3008 CH0=%d (%.3f V)  log.txt %u bytes\\n", raw, v, (unsigned)sz);
  } else Serial.printf("MCP3008 CH0=%d (%.3f V)\\n", raw, v);
  n++;
  delay(300);
}
`;
  EX.spi = () => {
    const esp = part('esp32', 300, 300, { power: 'usb' }, 0, 'esp');
    const tft = part('ili9341', 100, 520, {}, 0, 'TFT1'), mcp = part('mcp3008', 470, 520, {}, 0, 'ADC1'), sd = part('sdcard', 600, 520, {}, 0, 'SD1');
    const pot = part('potentiometer', 720, 440, { r: 10000, pos: 0.62 }, 0, 'POT1');
    const parts = [esp, tft, mcp, sd, pot], wires = [];
    const lanes = [
      ['black', 560, [[esp, 'GND.1'], [tft, 'GND'], [mcp, 'GND'], [sd, 'GND'], [pot, '2']]],
      ['red', 570, [[esp, '3V3'], [tft, 'VCC'], [tft, 'LED'], [mcp, 'VDD'], [sd, 'VCC'], [pot, '1']]],
      ['yellow', 580, [[esp, 'D18'], [tft, 'SCK'], [mcp, 'CLK'], [sd, 'SCK']]],
      ['blue', 590, [[esp, 'D23'], [tft, 'MOSI'], [mcp, 'DIN'], [sd, 'MOSI']]],
      ['green', 600, [[esp, 'D19'], [tft, 'MISO'], [mcp, 'DOUT'], [sd, 'MISO']]],
      ['orange', 610, [[esp, 'D15'], [tft, 'CS']]], ['purple', 620, [[esp, 'D2'], [tft, 'DC']]], ['gray', 630, [[esp, 'D4'], [tft, 'RST']]],
      ['orange', 640, [[esp, 'D5'], [mcp, 'CS']]], ['orange', 650, [[esp, 'TX2'], [sd, 'CS']]],
    ];
    for (const [col, y, ends] of lanes) {
      const pts = ends.map(([q, n]) => pin(q, n));
      for (const q of pts) wires.push(wire(q, pt(q.x, y), col));
      const xs = pts.map((q) => q.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) wires.push(wire(pt(xs[i - 1], y), pt(xs[i], y), col));
    }
    wires.push(path('yellow', pin(pot, 'W'), pt(730, 455), pt(470, 455), pin(mcp, 'CH0')));
    return { name: 'SPI: TFT ILI9341 + MCP3008 + microSD (real firmware)', mode: 'qemu', code: SPI_INO, parts, wires, notes: 'Unmodified Adafruit_ILI9341, Adafruit_MCP3008 and the core SD library drive the emulated ESP32 SPI controller (VSPI). Write-only TFT traffic streams to the page; transactions with the ADC or SD card selected run in lock-step so MISO data comes from the virtual parts. Turn POT1 and watch the TFT; the firmware appends to log.txt on the virtual FAT16 card.' };
  };
  EX.potjs = () => Object.assign(EX.pot(), { name: 'Potentiometer → LED PWM (JS sketch)', mode: 'js', code: POT_JS });
  EX.rc = () => {
    const esp = part('esp32', 100, 200, { power: 'usb' }, 0, 'esp');
    const r = part('resistor', 340, 420, { r: 10000 }, 0, 'R1');
    const c = part('capacitor', 400, 420, { c: 47e-6, kind: 'electrolytic' }, 0, 'C1');
    const g = part('ground', 440, 460, {}, 0, 'G1');
    const p1 = part('scope', 390, 380, { ch: 1 }, 0, 'CH1');
    const p2 = part('scope', 330, 380, { ch: 2 }, 0, 'CH2');
    const vm = part('voltmeter', 470, 420, {}, 0, 'VM1');
    return { name: 'RC charging (scope)', mode: 'js', code: RC_JS, parts: [esp, r, c, g, p1, p2, vm], wires: [
      path('orange', pin(esp, 'D4'), pt(140, 400), pt(330, 400), pt(330, 420), pin(r, '1')),
      wire(pin(p2, 'P'), pt(330, 400), 'orange'),
      wire(pin(r, '2'), pin(c, '+'), 'blue'),
      path('blue', pin(p1, 'P'), pt(390, 420)),
      path('black', pin(c, '-'), pt(440, 420), pin(g, 'GND')),
      path('blue', pt(400, 420), pt(400, 440), pt(470, 440), pin(vm, '+')),
      path('black', pin(vm, '-'), pt(500, 460), pt(440, 460)),
    ], scope: { div: 0.5 }, notes: 'GPIO4 square wave into R=10 kΩ, C=47 µF: τ = RC = 0.47 s. The Scope tab shows CH1 (capacitor) and CH2 (GPIO4).' };
  };
  EX.transistor = () => {
    const esp = part('esp32', 100, 200, { power: 'usb' }, 0, 'esp');
    const rb = part('resistor', 300, 420, { r: 1000 }, 0, 'RB');
    const q = part('npn', 350, 420, { bf: 200 }, 3, 'Q1');           // rot3: E(350,420) B(350,410) C(350,400)
    const led = part('led', 350, 340, { color: 'yellow' }, 1, 'LED1');  // A(350,340) C(350,350)
    const rc = part('resistor', 350, 290, { r: 150 }, 1, 'RC');        // (350,290)-(350,330)
    const g = part('ground', 350, 460, {}, 0, 'G1');
    const sup = part('vcc5', 420, 250, {}, 0, 'V5');
    const g2 = part('ground', 440, 280, {}, 0, 'G2');
    const am = part('ammeter', 350, 250, {}, 1, 'A1');                  // + (350,250) - (350,280)
    return { name: 'Transistor switch (real firmware)', mode: 'qemu', code: TRANSISTOR, parts: [esp, rb, q, led, rc, g, sup, g2, am], wires: [
      path('orange', pin(esp, 'D4'), pt(140, 420), pin(rb, '1')),
      path('orange', pin(rb, '2'), pt(340, 420), pt(340, 410), pin(q, 'B')),
      wire(pin(q, 'E'), pin(g, 'GND'), 'black'),
      wire(pin(q, 'C'), pin(led, 'C'), 'blue'),
      wire(pin(led, 'A'), pin(rc, '2'), 'red'),
      wire(pin(rc, '1'), pin(am, '-'), 'red'),
      path('red', pin(am, '+'), pt(350, 240), pt(420, 240), pin(sup, '+')),
      path('black', pin(sup, 'GND'), pt(440, 250), pin(g2, 'GND')),
    ], notes: 'Real firmware toggles GPIO4; the 2N2222 (Ebers-Moll model) saturates and sinks the LED current from 5 V. Hover the transistor for Ic/Ib/Vce.' };
  };
  EX.remote = () => {
    const esp = part('esp32', 700, 260, { power: 'usb' }, 0, 'esp');
    const parts = [esp], wires = [];
    const KEY = { SonyOn: '1', SonyOff: '2', 'Vol+': '=', 'Vol-': '-', Mute: 'm', Input: 'i', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', OK: 'Enter', Back: 'Backspace', Home: 'h', RokuSelect: 's', RokuHome: 'r', RokuBack: 'b', Mode: 'o', EcoToggle: 'e' };
    const SHORT = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '⏎', Backspace: '⌫' };
    const MAP = root.RemoteLogic.KEYMAP;
    const ROWPIN = ['D13', 'D14', 'D27', 'D26'], COLPIN = ['D25', 'D33', 'D32', 'D19', 'D18'];
    const ROWCOL = ['#ff6b6b', '#ffa94d', '#4dd4ac', '#b197fc'], COLCOL = ['#69db7c', '#4dabf7', '#da77f2', '#e8a76a', '#adb5bd'];
    const cx = (c) => 60 + c * 110, ry = (r) => 120 + r * 90;
    const lastRow = [3, 3, 3, 2, 2];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
      const name = MAP[r][c]; if (!name) continue;
      const d = part('diode', cx(c) + 30, ry(r), {}, 2, `D${r}${c}`);     // A at key pin 1, K toward the row bus
      const k = part('key', cx(c) + 30, ry(r), { key: KEY[name], label: name.replace('Roku', 'R.').replace('Sony', '').replace('EcoToggle', 'Eco').replace('Select', 'Sel') || name }, 0, `K_${name}`);
      parts.push(d, k);
      wires.push(wire(pt(cx(c), ry(r)), pt(cx(c), ry(r) - 30), ROWCOL[r]));                         // diode K -> row bus
      if (c > 0) wires.push(wire(pt(cx(c - 1), ry(r) - 30), pt(cx(c), ry(r) - 30), ROWCOL[r]));   // row bus segment
      if (r < lastRow[c]) wires.push(wire(pt(cx(c) + 60, ry(r)), pt(cx(c) + 60, ry(r + 1)), COLCOL[c]));   // column chain
    }
    // row buses -> ESP32 top header (from above)
    for (let r = 0; r < 4; r++) {
      const lastC = r === 3 ? 2 : 4, lane = 620 + r * 10, top = 40 + r * 8, P1 = pin(esp, ROWPIN[r]);
      wires.push(path(ROWCOL[r], pt(cx(lastC), ry(r) - 30), pt(lane, ry(r) - 30), pt(lane, top), pt(P1.x, top), P1));
    }
    // columns -> ESP32
    for (let c = 0; c < 5; c++) {
      const P1 = pin(esp, COLPIN[c]), x0 = cx(c) + 60, y0 = ry(lastRow[c]);
      if (c <= 2) wires.push(path(COLCOL[c], pt(x0, y0), pt(x0, 560 + c * 10), pt(1220 + c * 10, 560 + c * 10), pt(1220 + c * 10, 14 + c * 8), pt(P1.x, 14 + c * 8), P1));
      else wires.push(path(COLCOL[c], pt(x0, y0), pt(x0, 600 + (c - 3) * 10), pt(P1.x, 600 + (c - 3) * 10), P1));
    }
    // Mode LED on GPIO2
    const r1 = part('resistor', 880, 380, { r: 330 }, 0, 'R1'), led = part('led', 920, 380, { color: 'red' }, 0, 'LED_MODE'), g1 = part('ground', 950, 380, {}, 0, 'G1');
    parts.push(r1, led, g1);
    wires.push(path('yellow', pin(esp, 'D2'), pt(730, 380), pin(r1, '1')), path('black', pin(led, 'C'), pt(950, 380)));
    // IR driver: GPIO4 -> 1k -> Q1 base, 10k base-GND, VBAT -> 22R -> TSAL6200 -> collector
    const r4 = part('resistor', 1000, 440, { r: 1000 }, 0, 'R4');
    const q1 = part('npn', 1060, 480, { bf: 200 }, 0, 'Q1');                 // E 1060, B 1070, C 1080 @ y=480
    const r5 = part('resistor', 1070, 480, { r: 10000 }, 1, 'R5');           // (1070,480)-(1070,520)
    const ir = part('irled', 1080, 470, {}, 1, 'D_IR');                      // A (1080,470) C (1080,480)
    const r6 = part('resistor', 1080, 430, { r: 22 }, 1, 'R6');              // (1080,430)-(1080,470)
    const gq = part('ground', 1040, 540, {}, 0, 'G2'), g5 = part('ground', 1070, 540, {}, 0, 'G3');
    const bat = part('battery', 1000, 200, { v: 3.7, label: 'LiPo 1S' }, 0, 'BAT');
    const gb = part('ground', 1040, 220, {}, 0, 'G4');
    const c3 = part('capacitor', 1100, 250, { c: 100e-6, kind: 'electrolytic' }, 0, 'C3');
    const gc = part('ground', 1120, 270, {}, 0, 'G5');
    const r2 = part('resistor', 880, 200, { r: 100000 }, 0, 'R2'), r3 = part('resistor', 920, 200, { r: 100000 }, 0, 'R3'), gd = part('ground', 960, 220, {}, 0, 'G6');
    parts.push(r4, q1, r5, ir, r6, gq, g5, bat, gb, c3, gc, r2, r3, gd);
    wires.push(
      path('orange', pin(esp, 'D4'), pt(740, 440), pin(r4, '1')),
      path('orange', pin(r4, '2'), pt(1070, 440), pin(q1, 'B')),
      path('black', pin(q1, 'E'), pt(1040, 480), pin(gq, 'GND')),
      wire(pin(r5, '2'), pin(g5, 'GND'), 'black'),
      wire(pin(bat, '-'), pin(gb, 'GND'), 'black'),
      path('red', pin(bat, '+'), pt(1000, 250), pin(c3, '+')),
      path('red', pin(c3, '+'), pt(1100, 330), pt(1080, 330), pin(r6, '1')),
      wire(pin(c3, '-'), pin(gc, 'GND'), 'black'),
      path('red', pin(bat, '+'), pt(1000, 170), pt(880, 170), pin(r2, '1')),
      wire(pin(r3, '2'), pin(gd, 'GND'), 'black'),
      path('white', pin(r2, '2'), pt(920, 230), pt(800, 230), pin(esp, 'D35')),
    );
    const lbl = (t, x, y, s = 13) => part('label', x, y, { text: t, size: s }, 0);
    parts.push(lbl('18-key diode matrix (rows GPIO13/14/27/26 → cols GPIO25/33/32/19/18)', 40, 60, 13), lbl('Mode LED (GPIO2)', 860, 360, 11), lbl('IR driver (GPIO4 → 2N2222 → TSAL6200)', 960, 420, 11), lbl('VBAT divider → GPIO35', 840, 160, 11));
    return { name: 'Wi-Fi/IR TV Remote (real firmware/remote.ino)', mode: 'qemu', fetch: { 'sketch': 'examples/remote/remote.ino', 'remote_logic.h': 'examples/remote/remote_logic.h' }, defines: ['SIM'], parts, wires, devices: true,
      notes: 'The unmodified firmware/remote.ino (+ remote_logic.h) built with its own -DSIM flag. WiFi.begin() brings up real lwIP on QEMU’s open_eth NIC; HTTP (TCP) and Eco UDP packets travel through lwIP and are bridged to the mock TV/Roku/Eco devices (the 802.11 radio itself is not emulated). Matrix scanning runs in GPIO lock-step with the solver, so diode/ghosting behaviour is physical. Keyboard: 1/2 = Sony on/off, = - m i, arrows, Enter, Backspace, h, s, r, b, o = Mode, e = Eco.' };
  };
  EX.blank = () => ({ name: 'Blank (ESP32 on breadboard)', mode: 'qemu', code: 'void setup() {\n  Serial.begin(115200);\n  Serial.println("hello from QEMU");\n}\n\nvoid loop() {\n  delay(1000);\n}\n', parts: Object.values(espOnBoard()), wires: [] });
  // "+ New blank" (Projects dialog): the user picks a Basic circuit or an ESP32 project.
  // Basic = a bare breadboard in circuit mode (no board, no firmware, nothing to compile);
  // ESP32 = the DevKit V1 on a breadboard with an empty sketch, run as real firmware (QEMU).
  const EMPTY_INO = 'void setup() {}\nvoid loop() {}\n';
  const BASIC_CODE = '// Basic circuit — no ESP32, no code. Press Run (or just interact): the circuit is simulated live.\n';
  const BLANK_KINDS = {
    basic: { label: 'Basic circuit', build: () => ({ name: 'New circuit', mode: 'circuit', code: BASIC_CODE, parts: [part('breadboard', 0, 0, { cols: 63 }, 0, 'bb1')], wires: [] }) },
    esp32: { label: 'ESP32', build: () => ({ name: 'New ESP32 project', mode: 'qemu', code: EMPTY_INO, parts: Object.values(espOnBoard()), wires: [] }) },
  };
  function newBlank(kind) {
    const k = BLANK_KINDS[kind]; if (!k) throw new Error('unknown blank kind: ' + kind);
    return k.build();
  }
  // ---- BEGIN fun projects ----
  const TRAFFIC_INO = `// Traffic light with pedestrian crossing.
// Car lights: red D27, yellow D26, green D25.  Pedestrian: WALK (green) D33, DON'T WALK (red) D32.
// Request button on D14 (to GND, internal pull-up).  Buzzer on D4 ticks while it's safe to cross.
const int CAR_R = 27, CAR_Y = 26, CAR_G = 25, PED_G = 33, PED_R = 32, BTN = 14, BUZ = 4;

enum State { CARS_GO, CARS_YELLOW, ALL_RED, WALK, WALK_FLASH, ALL_RED2, RED_YELLOW };
const char *NAMES[] = { "cars GO", "cars YELLOW", "all red", "WALK", "walk ending (flashing)", "all red", "red+yellow (get ready)" };
const unsigned long DUR[] = { 4000, 1500, 1000, 4000, 2500, 1000, 800 };   // ms per state (CARS_GO is the minimum green)

State st = CARS_GO;
unsigned long since = 0;
bool request = false;

void lights(bool r, bool y, bool g, bool pg, bool pr) {
  digitalWrite(CAR_R, r); digitalWrite(CAR_Y, y); digitalWrite(CAR_G, g);
  digitalWrite(PED_G, pg); digitalWrite(PED_R, pr);
}

void enter(State s) {
  st = s; since = millis();
  Serial.printf("[%6lu ms] %s\\n", since, NAMES[s]);
  switch (s) {
    case CARS_GO:     lights(0, 0, 1, 0, 1); break;
    case CARS_YELLOW: lights(0, 1, 0, 0, 1); break;
    case ALL_RED:     lights(1, 0, 0, 0, 1); break;
    case WALK:        lights(1, 0, 0, 1, 0); request = false; break;
    case WALK_FLASH:  lights(1, 0, 0, 1, 0); break;
    case ALL_RED2:    lights(1, 0, 0, 0, 1); noTone(BUZ); break;
    case RED_YELLOW:  lights(1, 1, 0, 0, 1); break;
  }
}

void setup() {
  Serial.begin(115200);
  for (int p : { CAR_R, CAR_Y, CAR_G, PED_G, PED_R }) pinMode(p, OUTPUT);
  pinMode(BTN, INPUT_PULLUP);
  Serial.println("Traffic light ready - press the WALK button (key w)");
  enter(CARS_GO);
}

void loop() {
  unsigned long t = millis() - since;
  if (digitalRead(BTN) == LOW && !request && st <= CARS_YELLOW) {
    request = true;
    Serial.println("  pedestrian request accepted - WAIT");
    tone(BUZ, 1500, 60);
  }
  switch (st) {
    case CARS_GO:     if (request && t >= DUR[st]) enter(CARS_YELLOW); break;
    case CARS_YELLOW: if (t >= DUR[st]) enter(ALL_RED); break;
    case ALL_RED:     if (t >= DUR[st]) enter(WALK); break;
    case WALK:
      if ((t / 250) % 2 == 0) tone(BUZ, 2000); else noTone(BUZ);   // fast "tick-tock" crossing signal
      if (t >= DUR[st]) enter(WALK_FLASH);
      break;
    case WALK_FLASH: {
      bool on = (t / 300) % 2 == 0;
      digitalWrite(PED_G, on);
      if (on) tone(BUZ, 1000); else noTone(BUZ);
      if (t >= DUR[st]) enter(ALL_RED2);
      break;
    }
    case ALL_RED2:   if (t >= DUR[st]) enter(RED_YELLOW); break;
    case RED_YELLOW: if (t >= DUR[st]) enter(CARS_GO); break;
  }
  delay(10);
}
`;
  const REACTION_INO = `// Reaction-time game on an SSD1306 OLED.
// Press the button (key Enter, D14) to arm; wait for the green GO LED (D25) and hit it as fast as you can.
// Pressing too early lights the red LED (D26): false start!
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int BTN = 14, LED_GO = 25, LED_FOUL = 26;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
unsigned long best = 0, total = 0; int rounds = 0;

bool pressed() { return digitalRead(BTN) == LOW; }
void waitRelease() { while (pressed()) delay(5); delay(30); }

void screen(const char *big, const char *small1, const char *small2 = "") {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1); oled.setCursor(0, 0); oled.print("REACTION TEST");
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);
  oled.setTextSize(2); oled.setCursor((128 - strlen(big) * 12) / 2, 20); oled.print(big);
  oled.setTextSize(1); oled.setCursor(0, 44); oled.print(small1);
  oled.setCursor(0, 54); oled.print(small2);
  oled.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  pinMode(LED_GO, OUTPUT); pinMode(LED_FOUL, OUTPUT);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  randomSeed(esp_random());
  Serial.println("Reaction game: press Enter to start a round");
}

void loop() {
  char l1[24], l2[24];
  if (rounds) { snprintf(l1, sizeof l1, "best %lu ms", best); snprintf(l2, sizeof l2, "avg  %lu ms (%d)", total / rounds, rounds); }
  else { strcpy(l1, "press the button"); strcpy(l2, "to start"); }
  screen("READY?", l1, l2);
  while (!pressed()) delay(5);
  waitRelease();

  screen("wait...", "hit the button when", "the GO LED lights");
  unsigned long wait = random(1500, 4000), t0 = millis();
  while (millis() - t0 < wait) {
    if (pressed()) {                                   // false start
      digitalWrite(LED_FOUL, HIGH);
      Serial.println("FALSE START!");
      screen("TOO SOON", "false start -", "round not counted");
      waitRelease(); delay(1200);
      digitalWrite(LED_FOUL, LOW);
      return;
    }
    delay(1);
  }
  digitalWrite(LED_GO, HIGH);
  unsigned long go = micros();
  oled.clearDisplay(); oled.fillRect(0, 0, 128, 64, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK); oled.setTextSize(4); oled.setCursor(28, 18); oled.print("GO!"); oled.display();
  while (!pressed()) {
    if (micros() - go > 3000000UL) { digitalWrite(LED_GO, LOW); Serial.println("too slow (>3 s)"); screen("ASLEEP?", "no press in 3 s"); delay(1200); return; }
  }
  unsigned long ms = (micros() - go) / 1000;
  digitalWrite(LED_GO, LOW);
  rounds++; total += ms; bool rec = !best || ms < best; if (rec) best = ms;
  Serial.printf("reaction: %lu ms%s  (best %lu, avg %lu over %d)\\n", ms, rec ? "  NEW BEST!" : "", best, total / rounds, rounds);
  char big[12]; snprintf(big, sizeof big, "%lu ms", ms);
  screen(big, rec ? "*** new best! ***" : (ms < 250 ? "lightning fast" : ms < 400 ? "nice" : "keep practising"), "press to go again");
  waitRelease(); delay(400);
}
`;
  const SIMON_INO = `// Simon says: repeat the growing colour sequence.
// LEDs: red D27, green D26, blue D25, yellow D33.  Buttons (to GND, pull-ups): D13, D14, D18, D19 = keys 1 2 3 4.
// Buzzer on D23 plays each colour's note.
const int LED[4] = { 27, 26, 25, 33 };
const int KEY[4] = { 13, 14, 18, 19 };
const int NOTE[4] = { 330, 440, 554, 659 };      // E4 A4 C#5 E5 - the classic Simon chord
const char *COL[4] = { "red", "green", "blue", "yellow" };
const int BUZ = 23, MAXLEN = 32;
int seq[MAXLEN], len = 0, best = 0;

void flash(int i, int ms) {
  digitalWrite(LED[i], HIGH); tone(BUZ, NOTE[i]);
  delay(ms);
  digitalWrite(LED[i], LOW); noTone(BUZ);
}

int readKey(unsigned long timeout) {             // -1 on timeout
  unsigned long t0 = millis();
  while (millis() - t0 < timeout) {
    for (int i = 0; i < 4; i++) if (digitalRead(KEY[i]) == LOW) {
      digitalWrite(LED[i], HIGH); tone(BUZ, NOTE[i]);
      while (digitalRead(KEY[i]) == LOW) delay(5);
      delay(40); digitalWrite(LED[i], LOW); noTone(BUZ);
      return i;
    }
    delay(5);
  }
  return -1;
}

void gameOver() {
  Serial.printf("GAME OVER - you reached level %d (best %d)\\n", len - 1, best);
  tone(BUZ, 150); for (int k = 0; k < 4; k++) digitalWrite(LED[k], HIGH);
  delay(800); noTone(BUZ);
  for (int k = 0; k < 4; k++) digitalWrite(LED[k], LOW);
  delay(600);
  len = 0;
  Serial.println("press any button to play again");
  readKey(600000);
  delay(400);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 4; i++) { pinMode(LED[i], OUTPUT); pinMode(KEY[i], INPUT_PULLUP); }
  randomSeed(esp_random());
  Serial.println("SIMON - watch, listen, repeat. Keys 1-4 (or click the buttons).");
  for (int r = 0; r < 2; r++) for (int i = 0; i < 4; i++) flash(i, 90);   // attract sweep
  delay(500);
}

void loop() {
  if (len == MAXLEN) { Serial.println("PERFECT GAME! You beat all 32 levels."); for (int k = 0; k < 12; k++) flash(k % 4, 70); len = 0; }
  seq[len++] = random(4);
  Serial.printf("level %d: ", len);
  int speed = len < 6 ? 420 : len < 12 ? 320 : 230;
  for (int i = 0; i < len; i++) { flash(seq[i], speed); Serial.printf("%s ", COL[seq[i]]); delay(speed / 3); }
  Serial.println();
  for (int i = 0; i < len; i++) {
    int k = readKey(5000);
    if (k != seq[i]) {
      Serial.printf(k < 0 ? "  too slow!\\n" : "  wrong: pressed %s, expected %s\\n", k < 0 ? "" : COL[k], COL[seq[i]]);
      gameOver();
      return;
    }
  }
  if (len > best) best = len;
  Serial.printf("  correct! score %d\\n", len);
  delay(700);
}
`;
  const WEATHER_INO = `// OLED weather station: BME280 (temperature / humidity / pressure) on an SSD1306.
// Key n (D14) cycles pages: overview -> temperature graph -> pressure graph -> forecast.
// Move the BME280 sliders in the Inspector while it runs and watch the graphs and the forecast react.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_BME280.h>

const int BTN = 14;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_BME280 bme;
const int N = 100;
float histT[N], histP[N]; int count = 0, page = 0;
unsigned long lastSample = 0;
bool lastBtn = HIGH;

void push(float *h, float v) { memmove(h, h + 1, (N - 1) * sizeof(float)); h[N - 1] = v; }

void graph(const char *title, float *h, const char *unit) {
  int n = min(count, N); float lo = 1e9, hi = -1e9;
  for (int i = N - n; i < N; i++) { lo = min(lo, h[i]); hi = max(hi, h[i]); }
  if (hi - lo < 1) { float m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  oled.setTextSize(1); oled.setCursor(0, 0); oled.printf("%s %.1f%s", title, h[N - 1], unit);
  oled.setCursor(104, 12); oled.printf("%.0f", hi); oled.setCursor(104, 56); oled.printf("%.0f", lo);
  oled.drawRect(0, 11, 102, 53, SSD1306_WHITE);
  for (int i = N - n + 1; i < N; i++) {
    int x0 = 1 + (i - 1), x1 = 1 + i;
    int y0 = 62 - (int)((h[i - 1] - lo) / (hi - lo) * 49), y1 = 62 - (int)((h[i] - lo) / (hi - lo) * 49);
    oled.drawLine(x0, y0, x1, y1, SSD1306_WHITE);
  }
}

const char *forecast(float dp) {              // pressure tendency over the stored history (hPa)
  if (dp > 1.5) return "Sunny";
  if (dp > 0.5) return "Fair, drier";
  if (dp < -1.5) return "Storm alert";
  if (dp < -0.5) return "Rain likely";
  return "Steady";
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  if (!bme.begin(0x76)) Serial.println("BME280 not found - check wiring");
  delay(100); bme.readTemperature();          // let the first conversion finish; discard it
  oled.setTextColor(SSD1306_WHITE);
  Serial.println("Weather station: key n changes page");
}

void loop() {
  bool b = digitalRead(BTN);
  bool flip = (b == LOW && lastBtn == HIGH);
  if (flip) { page = (page + 1) % 4; Serial.printf("page %d\\n", page); }
  lastBtn = b;
  static float t, h, p;
  bool sample = millis() - lastSample >= 1000 || !count;
  if (sample) {
    lastSample = millis();
    t = bme.readTemperature(); h = bme.readHumidity(); p = bme.readPressure() / 100.0;
    if (!count) for (int i = 0; i < N; i++) { histT[i] = t; histP[i] = p; }
    push(histT, t); push(histP, p); count++;
  }
  if (sample || flip) {
    if (sample && count % 5 == 1) Serial.printf("T=%.1f C  RH=%.0f %%  P=%.1f hPa  -> %s\\n", t, h, p, forecast(histP[N - 1] - histP[N - min(count, N)]));
    oled.clearDisplay();
    if (page == 0) {
      oled.setTextSize(3); oled.setCursor(0, 0); oled.printf("%.1f", t);
      oled.setTextSize(1); oled.print(" o"); oled.setTextSize(2); oled.print("C");
      oled.setTextSize(1);
      oled.setCursor(0, 30); oled.printf("RH %3.0f%%", h);
      oled.drawRect(52, 30, 76, 7, SSD1306_WHITE); oled.fillRect(54, 32, (int)(h * 0.72), 3, SSD1306_WHITE);
      oled.setCursor(0, 42); oled.printf("P  %.1f hPa", p);
      const char *feel = t > 30 ? (h > 60 ? "Hot & sticky" : "Hot") : t < 10 ? "Cold" : (h < 30 ? "Pleasant, dry" : h > 70 ? "Mild, humid" : "Comfortable");
      oled.setCursor(0, 54); oled.print(feel);
    } else if (page == 1) graph("Temp", histT, "C");
    else if (page == 2) graph("Press", histP, "hPa");
    else {
      float dp = histP[N - 1] - histP[N - min(count, N)];
      oled.setTextSize(1); oled.setCursor(0, 0); oled.print("FORECAST");
      oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);
      int cx = 24, cy = 36;
      if (dp > 0.5) { oled.fillCircle(cx, cy, 10, SSD1306_WHITE); for (int a = 0; a < 360; a += 45) oled.drawLine(cx + 13 * cos(a * DEG_TO_RAD), cy + 13 * sin(a * DEG_TO_RAD), cx + 17 * cos(a * DEG_TO_RAD), cy + 17 * sin(a * DEG_TO_RAD), SSD1306_WHITE); }
      else { oled.fillCircle(cx - 6, cy, 8, SSD1306_WHITE); oled.fillCircle(cx + 5, cy - 4, 10, SSD1306_WHITE); oled.fillRect(cx - 14, cy, 30, 8, SSD1306_WHITE);
             if (dp < -0.5) for (int i = 0; i < 4; i++) oled.drawLine(cx - 10 + i * 7, cy + 12, cx - 13 + i * 7, cy + 18, SSD1306_WHITE); }
      oled.setCursor(50, 22); oled.print(forecast(dp));
      oled.setCursor(50, 40); oled.printf("%+.1f hPa", dp);
      oled.setCursor(50, 50); oled.print("trend");
    }
    oled.display();
  }
  delay(20);
}
`;
  const DICE_INO = `// Electronic dice: two dice on an SSD1306. Press ROLL (key Enter, D14) - or shake the MPU6050
// (drag any accelerometer slider quickly in the Inspector) - to roll with a tumbling animation.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MPU6050.h>

const int BTN = 14;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_MPU6050 mpu;
bool haveMpu;
int stats[13], rolls = 0;
float lastA = 9.81;

void die(int x, int y, int v) {                     // 28x28 die face with pips
  oled.fillRoundRect(x, y, 28, 28, 5, SSD1306_WHITE);
  const int L = x + 7, C = x + 14, R = x + 21, T = y + 7, M = y + 14, B = y + 21;
  auto pip = [&](int px, int py) { oled.fillCircle(px, py, 2, SSD1306_BLACK); };
  if (v & 1) pip(C, M);
  if (v >= 2) { pip(L, T); pip(R, B); }
  if (v >= 4) { pip(R, T); pip(L, B); }
  if (v == 6) { pip(L, M); pip(R, M); }
}

void show(int a, int b, int ox, int oy, const char *caption) {
  oled.clearDisplay();
  die(22 + ox, 8 + oy, a); die(78 - ox, 8 - oy, b);
  oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE);
  oled.setCursor((128 - strlen(caption) * 6) / 2, 50); oled.print(caption);
  oled.display();
}

void roll(const char *why) {
  int a = 1, b = 1;
  for (int f = 0; f < 8; f++) {                     // tumble: random faces, jitter, slowing down
    a = random(1, 7); b = random(1, 7);
    show(a, b, random(-3, 4), random(-3, 4), "rolling...");
    delay(40 + f * 15);
  }
  rolls++; stats[a + b]++;
  char cap[24];
  if (a == b) snprintf(cap, sizeof cap, a == 6 ? "DOUBLE SIX!" : a == 1 ? "snake eyes!" : "doubles! = %d", a + b);
  else snprintf(cap, sizeof cap, "%d + %d = %d", a, b, a + b);
  show(a, b, 0, 0, cap);
  Serial.printf("roll #%d (%s): %d + %d = %d%s\\n", rolls, why, a, b, a + b, a == b ? "  doubles!" : "");
  if (rolls % 10 == 0) {
    Serial.print("  totals so far:");
    for (int s = 2; s <= 12; s++) Serial.printf(" %d:%d", s, stats[s]);
    Serial.println();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  haveMpu = mpu.begin(0x68);
  Serial.printf("Dice ready (MPU6050 %s). Press Enter to roll%s.\\n", haveMpu ? "found" : "missing", haveMpu ? " or shake" : "");
  randomSeed(esp_random());
  if (haveMpu) { sensors_event_t e, g, t; mpu.getEvent(&e, &g, &t);   // baseline so boot is not mistaken for a shake
    lastA = sqrt(e.acceleration.x * e.acceleration.x + e.acceleration.y * e.acceleration.y + e.acceleration.z * e.acceleration.z); }
  show(6, 6, 0, 0, "press ROLL / shake");
}

void loop() {
  if (digitalRead(BTN) == LOW) { roll("button"); while (digitalRead(BTN) == LOW) delay(5); delay(30); }
  if (haveMpu) {
    sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
    float m = sqrt(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z);
    if (fabs(m - lastA) > 4.0) { lastA = m; roll("shake"); delay(300); return; }
    lastA = m;
  }
  delay(30);
}
`;
  const STOPWATCH_INO = `// OLED stopwatch with laps. START/STOP = key s (D14), LAP/RESET = key l (D13).
// Running: LAP records a split. Stopped: LAP/RESET clears.  Times also go to Serial.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int BTN_SS = 14, BTN_LAP = 13, LED_RUN = 25;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool running = false;
unsigned long startMs = 0, accum = 0, lastLap = 0;
unsigned long laps[3]; int nLaps = 0;
bool prevSS = HIGH, prevLap = HIGH;

unsigned long elapsed() { return accum + (running ? millis() - startMs : 0); }
void fmt(char *b, size_t n, unsigned long ms) { snprintf(b, n, "%02lu:%02lu.%02lu", ms / 60000, ms / 1000 % 60, ms / 10 % 100); }

void draw() {
  char b[16]; unsigned long e = elapsed();
  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1); oled.setCursor(0, 0); oled.print(running ? "> RUNNING" : e ? "|| STOPPED" : "STOPWATCH");
  oled.setCursor(98, 0); oled.printf("L%d", nLaps);
  fmt(b, sizeof b, e); oled.setTextSize(2); oled.setCursor(4, 14); oled.print(b);
  oled.drawFastHLine(0, 33, 128, SSD1306_WHITE);
  oled.setTextSize(1);
  for (int i = 0; i < min(nLaps, 3); i++) {
    fmt(b, sizeof b, laps[i]); oled.setCursor(0, 37 + i * 9); oled.printf("lap %-2d %s", nLaps - i, b);
  }
  if (!nLaps) { oled.setCursor(0, 40); oled.print("s: start/stop"); oled.setCursor(0, 50); oled.print("l: lap / reset"); }
  // progress ring for the seconds
  int s = e / 1000 % 60; oled.drawCircle(116, 48, 10, SSD1306_WHITE);
  float a = (s / 60.0) * TWO_PI - HALF_PI; oled.drawLine(116, 48, 116 + 9 * cos(a), 48 + 9 * sin(a), SSD1306_WHITE);
  oled.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN_SS, INPUT_PULLUP); pinMode(BTN_LAP, INPUT_PULLUP); pinMode(LED_RUN, OUTPUT);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  Serial.println("Stopwatch: s = start/stop, l = lap/reset");
  draw();
}

void loop() {
  bool ss = digitalRead(BTN_SS), lp = digitalRead(BTN_LAP);
  char b[16];
  if (ss == LOW && prevSS == HIGH) {
    if (running) { accum += millis() - startMs; running = false; fmt(b, sizeof b, accum); Serial.printf("stop  %s\\n", b); }
    else { startMs = millis(); running = true; Serial.println("start"); }
    digitalWrite(LED_RUN, running);
  }
  if (lp == LOW && prevLap == HIGH) {
    if (running) {
      unsigned long e = elapsed(), split = e - lastLap; lastLap = e;
      memmove(laps + 1, laps, 2 * sizeof laps[0]); laps[0] = split; nLaps++;
      char t[16]; fmt(b, sizeof b, split); fmt(t, sizeof t, e); Serial.printf("lap %d  %s  (total %s)\\n", nLaps, b, t);
    } else { accum = 0; lastLap = 0; nLaps = 0; Serial.println("reset"); }
  }
  bool changed = (ss != prevSS) || (lp != prevLap);
  prevSS = ss; prevLap = lp;
  static unsigned long lastDraw;
  if (changed || millis() - lastDraw >= 100) { lastDraw = millis(); draw(); }   // 10 fps keeps the CPU mostly idle
  delay(5);
}
`;
  const VUMETER_INO = `// 8-LED bar-graph VU meter. Turn the pot (D34) to set the level, or flip the slide switch (D4)
// to MUSIC mode for a simulated beat. Peak-hold dot falls back slowly, like a real meter.
const int LEDS[8] = { 13, 14, 27, 26, 25, 33, 32, 23 };   // 5 green, 2 yellow, 1 red
const int POT = 34, MODE_SW = 4;
float level = 0; int peak = 0; unsigned long peakT = 0;

void setup() {
  Serial.begin(115200);
  for (int p : LEDS) pinMode(p, OUTPUT);
  pinMode(MODE_SW, INPUT_PULLUP);           // switch to GND = POT mode, open = MUSIC mode
  analogReadResolution(12);
  for (int i = 0; i < 8; i++) { digitalWrite(LEDS[i], HIGH); delay(60); }   // power-on sweep
  for (int i = 7; i >= 0; i--) { digitalWrite(LEDS[i], LOW); delay(40); }
  Serial.println("VU meter: turn the pot, or flip the switch for MUSIC mode");
}

void loop() {
  bool music = digitalRead(MODE_SW) == HIGH;
  float in;
  if (music) {                                   // kick drum every 500 ms + wobbling melody
    unsigned long t = millis();
    float kick = exp(-(t % 500) / 90.0);
    in = constrain(0.25 + 0.65 * kick + 0.15 * sin(t / 130.0) * sin(t / 47.0) + random(-6, 7) / 100.0, 0, 1);
  } else in = analogRead(POT) / 4095.0;
  level = in > level ? in : level * 0.85 + in * 0.15;   // fast attack, slow release
  int n = round(level * 8);
  if (n >= peak) { peak = n; peakT = millis(); }
  else if (millis() - peakT > 600 && peak > 0) { peak--; peakT = millis() - 450; }
  for (int i = 0; i < 8; i++) digitalWrite(LEDS[i], i < n || (i == peak - 1 && peak > 0));
  static unsigned long lastLog; static int lastN = -1;
  if (n != lastN && millis() - lastLog > 250) {
    lastLog = millis(); lastN = n;
    char bar[9]; for (int i = 0; i < 8; i++) bar[i] = i < n ? '#' : (i == peak - 1 ? '|' : '.'); bar[8] = 0;
    Serial.printf("%s [%s] %3d%%\\n", music ? "MUSIC" : "POT  ", bar, (int)(level * 100));
  }
  delay(20);
}
`;
  const MORSE_INO = `// Morse code transceiver.
// TX: type text in the Serial tab and press Enter - it is keyed out on the LED (D25) and buzzer (D26).
// RX: tap the key (key m, D14) - short = dot, long = dash - and the decoded letters print to Serial.
const int LED = 25, BUZ = 26, KEY = 14, UNIT = 80;   // 80 ms dot = 15 WPM
const char *CODE[] = { ".-", "-...", "-.-.", "-..", ".", "..-.", "--.", "....", "..", ".---", "-.-", ".-..", "--",
                       "-.", "---", ".--.", "--.-", ".-.", "...", "-", "..-", "...-", ".--", "-..-", "-.--", "--.." };
const char *DIGITS[] = { "-----", ".----", "..---", "...--", "....-", ".....", "-....", "--...", "---..", "----." };

const char *encode(char c) {
  c = toupper(c);
  if (c >= 'A' && c <= 'Z') return CODE[c - 'A'];
  if (c >= '0' && c <= '9') return DIGITS[c - '0'];
  return nullptr;
}
char decode(const String &s) {
  for (int i = 0; i < 26; i++) if (s == CODE[i]) return 'A' + i;
  for (int i = 0; i < 10; i++) if (s == DIGITS[i]) return '0' + i;
  return '?';
}
void keyOut(int units) { digitalWrite(LED, HIGH); tone(BUZ, 700); delay(units * UNIT); digitalWrite(LED, LOW); noTone(BUZ); delay(UNIT); }

void send(const String &msg) {
  Serial.printf("TX \\"%s\\"\\n   ", msg.c_str());
  for (char c : msg) {
    if (c == ' ') { Serial.print("/ "); delay(UNIT * 4); continue; }
    const char *m = encode(c); if (!m) continue;
    Serial.printf("%s ", m);
    for (const char *p = m; *p; p++) keyOut(*p == '.' ? 1 : 3);
    delay(UNIT * 2);
  }
  Serial.println("\\nTX done");
}

String line, sym, rxWord;
unsigned long downAt = 0, upAt = 0; bool wasDown = false;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT); pinMode(KEY, INPUT_PULLUP);
  Serial.println("Morse transceiver: type a message + Enter to send; tap key m to receive");
  send("SOS");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\\r' || c == '\\n') { if (line.length()) { send(line); line = ""; } }
    else line += c;
  }
  bool down = digitalRead(KEY) == LOW; unsigned long now = millis();
  if (down && !wasDown) { downAt = now; digitalWrite(LED, HIGH); tone(BUZ, 600); }
  if (!down && wasDown) {
    digitalWrite(LED, LOW); noTone(BUZ);
    sym += (now - downAt) < UNIT * 2.5 ? '.' : '-'; upAt = now;
  }
  if (!down && sym.length() && now - upAt > UNIT * 5) {     // letter gap
    char c = decode(sym); rxWord += c; Serial.printf("RX %s -> %c\\n", sym.c_str(), c); sym = "";
  }
  if (!down && !sym.length() && rxWord.length() && now - upAt > UNIT * 14) { Serial.printf("RX rxWord: %s\\n", rxWord.c_str()); rxWord = ""; }
  wasDown = down;
  delay(5);
}
`;
  const SNAKE_INO = `// Snake on a 128x64 OLED. Steer with the arrow keys (buttons on D13 up, D14 down, D27 left, D26 right).
// Eat the food to grow; the game speeds up as you go. Buzzer on D25 beeps when you eat.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int B_UP = 13, B_DN = 14, B_LT = 27, B_RT = 26, BUZ = 25;
const int CELL = 4, GW = 32, GH = 13, TOP = 11;          // 32x13 board under a score bar
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
struct P { int8_t x, y; };
P body[GW * GH]; int len, dx, dy, score, hiscore = 0, stepMs;
P food; bool alive;

bool on(int x, int y) { for (int i = 0; i < len; i++) if (body[i].x == x && body[i].y == y) return true; return false; }
void place() { do { food = { (int8_t)random(GW), (int8_t)random(GH) }; } while (on(food.x, food.y)); }
void reset() {
  len = 4; for (int i = 0; i < len; i++) body[i] = { (int8_t)(8 - i), 6 };
  dx = 1; dy = 0; score = 0; stepMs = 220; alive = true; place();
  Serial.println("new game - arrow keys to steer");
}
void draw() {
  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE); oled.setTextSize(1);
  oled.setCursor(0, 1); oled.printf("SNAKE  %d", score); oled.setCursor(80, 1); oled.printf("HI %d", hiscore);
  oled.drawRect(0, TOP - 2, 128, GH * CELL + 3, SSD1306_WHITE);
  for (int i = 0; i < len; i++) oled.fillRect(body[i].x * CELL, TOP + body[i].y * CELL, CELL - (i ? 1 : 0), CELL - (i ? 1 : 0), SSD1306_WHITE);
  oled.drawCircle(food.x * CELL + 1, TOP + food.y * CELL + 1, 1, SSD1306_WHITE);
  if (!alive) {
    oled.fillRect(24, 22, 80, 24, SSD1306_BLACK); oled.drawRect(24, 22, 80, 24, SSD1306_WHITE);
    oled.setCursor(37, 26); oled.print("GAME OVER"); oled.setCursor(30, 36); oled.print("press a key");
  }
  oled.display();
}
void input() {
  if (digitalRead(B_UP) == LOW && dy == 0) { dx = 0; dy = -1; }
  else if (digitalRead(B_DN) == LOW && dy == 0) { dx = 0; dy = 1; }
  else if (digitalRead(B_LT) == LOW && dx == 0) { dx = -1; dy = 0; }
  else if (digitalRead(B_RT) == LOW && dx == 0) { dx = 1; dy = 0; }
}
bool anyKey() { return !digitalRead(B_UP) || !digitalRead(B_DN) || !digitalRead(B_LT) || !digitalRead(B_RT); }

void setup() {
  Serial.begin(115200);
  for (int p : { B_UP, B_DN, B_LT, B_RT }) pinMode(p, INPUT_PULLUP);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  randomSeed(esp_random());
  reset(); draw();
}

void loop() {
  if (!alive) {
    if (anyKey()) { while (anyKey()) delay(10); reset(); }
    delay(20); return;
  }
  unsigned long t0 = millis();
  while (millis() - t0 < (unsigned long)stepMs) { input(); delay(5); }
  P h = { (int8_t)(body[0].x + dx), (int8_t)(body[0].y + dy) };
  if (h.x < 0 || h.y < 0 || h.x >= GW || h.y >= GH || on(h.x, h.y)) {
    alive = false; if (score > hiscore) hiscore = score;
    Serial.printf("crash! score %d (high score %d)\\n", score, hiscore);
    tone(BUZ, 120, 500); draw(); delay(600); return;
  }
  bool eat = h.x == food.x && h.y == food.y;
  if (eat) len++;
  memmove(body + 1, body, (len - 1) * sizeof(P)); body[0] = h;
  if (eat) { score++; stepMs = max(90, stepMs - 8); tone(BUZ, 1800, 40); Serial.printf("yum! score %d, length %d\\n", score, len); place(); }
  draw();
}
`;
  const PONG_INO = `// Pong on a 128x64 OLED: your paddle follows the potentiometer (D34), the ESP32 plays the right side.
// First to 5 wins. Buzzer (D25) bleeps on every hit. Turn the knob (scroll over it) to play.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int POT = 34, BUZ = 25, PH = 14, WIN = 5;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
float bx, by, vx, vy, cpuY = 25; int you = 0, cpu = 0;

void serve(int dir) {
  bx = 64; by = random(16, 48); vx = 2.4 * dir; vy = random(-15, 16) / 10.0;
  if (fabs(vy) < 0.5) vy = 0.8;
}
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  randomSeed(esp_random());
  serve(1);
  Serial.println("PONG - you are the left paddle (pot). First to 5!");
}

void loop() {
  int youY = map(analogRead(POT), 0, 4095, 0, 64 - PH);
  // CPU: follows the ball with a capped speed (beatable!)
  float target = by - PH / 2.0; cpuY += constrain(target - cpuY, -1.6, 1.6); cpuY = constrain(cpuY, 0, 64 - PH);
  bx += vx; by += vy;
  if (by < 1 || by > 62) { vy = -vy; by = constrain(by, 1, 62); }
  if (bx <= 4 && vx < 0) {
    if (by >= youY - 1 && by <= youY + PH + 1) { vx = -vx * 1.06; vy += (by - (youY + PH / 2.0)) * 0.18; tone(BUZ, 900, 25); }
    else { cpu++; Serial.printf("CPU scores  you %d : %d cpu\\n", you, cpu); tone(BUZ, 200, 250); serve(1); }
  }
  if (bx >= 123 && vx > 0) {
    if (by >= cpuY - 1 && by <= cpuY + PH + 1) { vx = -vx * 1.04; vy += (by - (cpuY + PH / 2.0)) * 0.15; tone(BUZ, 1200, 25); }
    else { you++; Serial.printf("YOU score!  you %d : %d cpu\\n", you, cpu); tone(BUZ, 1600, 120); serve(-1); }
  }
  vx = constrain(vx, -5, 5); vy = constrain(vy, -3, 3);

  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  for (int y = 0; y < 64; y += 6) oled.drawFastVLine(64, y, 3, SSD1306_WHITE);
  oled.setTextSize(2); oled.setCursor(42, 2); oled.print(you); oled.setCursor(74, 2); oled.print(cpu);
  oled.fillRect(1, youY, 3, PH, SSD1306_WHITE); oled.fillRect(124, (int)cpuY, 3, PH, SSD1306_WHITE);
  oled.fillRect((int)bx - 1, (int)by - 1, 3, 3, SSD1306_WHITE);
  if (you == WIN || cpu == WIN) {
    oled.fillRect(14, 22, 100, 22, SSD1306_BLACK); oled.drawRect(14, 22, 100, 22, SSD1306_WHITE);
    oled.setTextSize(1); oled.setCursor(you == WIN ? 34 : 31, 30); oled.print(you == WIN ? "YOU WIN! :)" : "CPU WINS :(");
    oled.display();
    Serial.printf("%s %d-%d. New match in 3 s\\n", you == WIN ? "You win" : "CPU wins", you, cpu);
    delay(3000); you = cpu = 0; serve(1); return;
  }
  oled.display();
  delay(15);
}
`;
  const LEVEL_INO = `// Digital spirit level / bubble inclinometer: MPU6050 tilt on an SSD1306.
// Drag the MPU6050 "Accel X/Y" sliders in the Inspector to tilt the board.
// The green LED (D25) lights when the board is within 1 degree of level; red (D26) when it is badly tilted.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MPU6050.h>

const int LED_OK = 25, LED_BAD = 26;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_MPU6050 mpu;
float fx = 0, fy = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_OK, OUTPUT); pinMode(LED_BAD, OUTPUT);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  if (!mpu.begin(0x68)) Serial.println("MPU6050 not found");
  Serial.println("Spirit level: tilt the MPU6050 (Accel X/Y sliders)");
}

void loop() {
  sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
  float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * RAD_TO_DEG;
  float roll = atan2(ay, sqrt(ax * ax + az * az)) * RAD_TO_DEG;
  fx = fx * 0.6 + pitch * 0.4; fy = fy * 0.6 + roll * 0.4;          // damped bubble
  bool level = fabs(fx) < 1 && fabs(fy) < 1, bad = fabs(fx) > 15 || fabs(fy) > 15;
  digitalWrite(LED_OK, level); digitalWrite(LED_BAD, bad);

  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  const int cx = 32, cy = 32, R = 30;                             // round bull's-eye vial
  oled.drawCircle(cx, cy, R, SSD1306_WHITE); oled.drawCircle(cx, cy, 7, SSD1306_WHITE);
  oled.drawFastHLine(cx - R, cy, 6, SSD1306_WHITE); oled.drawFastHLine(cx + R - 6, cy, 6, SSD1306_WHITE);
  oled.drawFastVLine(cx, cy - R, 6, SSD1306_WHITE); oled.drawFastVLine(cx, cy + R - 6, 6, SSD1306_WHITE);
  float bxp = constrain(-fx, -30, 30) / 30.0 * (R - 6), byp = constrain(fy, -30, 30) / 30.0 * (R - 6);
  if (level) oled.fillCircle(cx + bxp, cy + byp, 5, SSD1306_WHITE); else oled.drawCircle(cx + bxp, cy + byp, 5, SSD1306_WHITE);
  oled.drawRect(68, 54, 60, 9, SSD1306_WHITE);                    // linear vial for the X axis
  oled.drawFastVLine(98, 54, 9, SSD1306_WHITE);
  oled.fillRect(98 + constrain(-fx, -25, 25) - 3, 56, 6, 5, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(68, 2); oled.printf("X %+5.1f", fx); oled.setCursor(68, 14); oled.printf("Y %+5.1f", fy);
  oled.setCursor(68, 30); oled.setTextSize(level ? 2 : 1); oled.print(level ? "LEVEL" : bad ? "TILTED!" : "adjust..");
  oled.display();
  static unsigned long last; if (millis() - last > 1000) { last = millis(); Serial.printf("pitch %+5.1f  roll %+5.1f  %s\\n", fx, fy, level ? "LEVEL" : bad ? "TILTED" : ""); }
  delay(50);
}
`;
  const SERVO_INO = `// Pot-controlled servo + radar sweep  (ESP32Servo, real LEDC 50 Hz PWM)
// Turn the knob to aim the SG90. Press S to toggle the automatic radar sweep.
#include <ESP32Servo.h>

const int SERVO_PIN = 13, POT_PIN = 34, MODE_PIN = 14, LED_PIN = 25;
Servo arm;
bool sweep = false;
int angle = 90, dir = 1, lastShown = -1;
unsigned long lastStep = 0;

void setup() {
  Serial.begin(115200);
  pinMode(MODE_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  arm.setPeriodHertz(50);
  arm.attach(SERVO_PIN, 544, 2400);   // SG90 pulse range
  Serial.println("Servo ready: knob = angle, S = radar sweep");
}

void loop() {
  static bool was = HIGH;
  bool b = digitalRead(MODE_PIN);
  if (was == HIGH && b == LOW) {
    sweep = !sweep;
    Serial.println(sweep ? "mode: RADAR SWEEP" : "mode: KNOB");
    delay(30);
  }
  was = b;
  digitalWrite(LED_PIN, sweep);

  if (sweep) {
    if (millis() - lastStep >= 20) {
      lastStep = millis();
      angle += dir * 3;
      if (angle >= 180) { angle = 180; dir = -1; }
      if (angle <= 0) { angle = 0; dir = 1; }
    }
  } else {
    angle = map(analogRead(POT_PIN), 0, 4095, 0, 180);
  }
  arm.write(angle);
  if (abs(angle - lastShown) >= 10 || (angle != lastShown && (angle == 0 || angle == 180))) {
    lastShown = angle;
    Serial.printf("angle %3d deg  pulse %4d us\\n", angle, arm.readMicroseconds());
  }
  delay(10);
}
`;
  const NEORING_INO = `// NeoPixel light show: 16-LED WS2812 ring (Adafruit_NeoPixel)
// M = next effect (rainbow, fire, comet, breathing), knob = brightness.
#include <Adafruit_NeoPixel.h>

const int RING_PIN = 5, N = 16, MODE_PIN = 14, POT_PIN = 34;
Adafruit_NeoPixel ring(N, RING_PIN, NEO_GRB + NEO_KHZ800);
const char *names[] = {"rainbow", "fire", "comet", "breathing"};
int mode = 0;
uint8_t heat[N];
uint16_t hue0 = 0;
int head = 0;

void setup() {
  Serial.begin(115200);
  pinMode(MODE_PIN, INPUT_PULLUP);
  ring.begin();
  ring.show();
  Serial.println("NeoPixel ring: M = next effect, knob = brightness");
  Serial.printf("effect: %s\\n", names[mode]);
}

uint32_t heatColor(uint8_t t) {          // black -> red -> orange -> yellow -> white
  uint8_t r = t > 85 ? 255 : t * 3, g = t > 170 ? 255 : t > 85 ? (t - 85) * 3 : 0, b = t > 170 ? (t - 170) * 3 : 0;
  return ring.Color(r, g, b);
}

void loop() {
  static bool was = HIGH;
  bool b = digitalRead(MODE_PIN);
  if (was == HIGH && b == LOW) { mode = (mode + 1) % 4; Serial.printf("effect: %s\\n", names[mode]); ring.clear(); }
  was = b;
  ring.setBrightness(map(analogRead(POT_PIN), 0, 4095, 8, 255));

  switch (mode) {
    case 0:   // rainbow wheel turning around the ring
      for (int i = 0; i < N; i++) ring.setPixelColor(i, ring.gamma32(ring.ColorHSV(hue0 + i * 65536L / N)));
      hue0 += 1024;
      break;
    case 1:   // fire: heat diffuses up both halves of the ring from the bottom
      for (int i = 0; i < N; i++) heat[i] = max(0, heat[i] - (int)random(0, 30));
      for (int i = N / 2; i > 0; i--) { heat[i] = (heat[i - 1] + heat[i] + heat[(i + 1) % N]) / 3; heat[N - i] = heat[i]; }
      if (random(10) < 7) heat[0] = min(255, heat[0] + (int)random(120, 255));
      for (int i = 0; i < N; i++) ring.setPixelColor((i + N / 2) % N, heatColor(heat[i]));
      break;
    case 2:   // comet with a fading tail
      for (int i = 0; i < N; i++) {
        int d = (head - i + N) % N;
        ring.setPixelColor(i, d < 6 ? ring.Color(0, 255 >> d, 255 >> (d / 2)) : 0);
      }
      head = (head + 1) % N;
      break;
    case 3: {  // breathing purple
      uint8_t v = (sin(millis() / 600.0) + 1) * 127;
      ring.fill(ring.Color(v, 0, v / 2));
      break;
    }
  }
  ring.show();
  delay(40);
}
`;
  const LCDCLOCK_INO = `// 16x2 I2C LCD clock with a set-time menu (LiquidCrystal_PCF8574, PCF8574 at 0x27)
// M = menu (set hours -> set minutes -> run), + = increase the selected field.
#include <Wire.h>
#include <LiquidCrystal_PCF8574.h>

LiquidCrystal_PCF8574 lcd(0x27);
const int MENU_PIN = 14, PLUS_PIN = 27;
const char *days[] = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"};
long base = 9L * 3600 + 41 * 60;     // 09:41:00 at boot
unsigned long t0 = 0;
int menu = 0;                         // 0 run, 1 hours, 2 minutes
byte bell[8] = {0b00100, 0b01110, 0b01110, 0b01110, 0b11111, 0b00000, 0b00100, 0b00000};

// Write only the characters that changed (each LCD byte is 6 I2C transfers through the PCF8574, so this keeps the
// loop fast and the buttons responsive).
char shownRow[2][17] = {"                ", "                "};
void put(int r, const char *s) {
  for (int c = 0; c < 16 && s[c]; c++) {
    if (shownRow[r][c] == s[c]) continue;
    int e = c; while (e < 16 && s[e] && shownRow[r][e] != s[e]) e++;
    lcd.setCursor(c, r);
    for (int i = c; i < e; i++) { lcd.write((uint8_t)s[i]); shownRow[r][i] = s[i]; }
    c = e - 1;
  }
}

long now() { return base + (millis() - t0) / 1000; }

bool pressed(int pin, bool &was) { bool b = digitalRead(pin); bool p = was && !b; was = b; return p; }

void setup() {
  Serial.begin(115200);
  pinMode(MENU_PIN, INPUT_PULLUP);
  pinMode(PLUS_PIN, INPUT_PULLUP);
  Wire.begin(); lcd.begin(16, 2);
  lcd.setBacklight(255);
  lcd.createChar(0, bell);
  lcd.setCursor(0, 0); lcd.print(" ESP32 LCD Clock");
  lcd.setCursor(0, 1); lcd.print("  M=menu  +=set ");
  delay(1500);
  lcd.clear();
  t0 = millis();
  Serial.println("LCD clock running");
}

void loop() {
  static bool wm = true, wp = true;
  static long lastLog = -1;
  if (pressed(MENU_PIN, wm)) { menu = (menu + 1) % 3; Serial.printf("menu %d\\n", menu); }
  if (pressed(PLUS_PIN, wp) && menu) {
    base += menu == 1 ? 3600 : 60;
    if (menu == 2 && (now() / 60) % 60 == 0) base -= 3600;      // minutes wrap without touching the hour
    base %= 7L * 86400;
  }
  long t = now();
  bool blink = (millis() / 400) % 2;
  int h = (t / 3600) % 24, m = (t / 60) % 60, s = t % 60, d = (t / 86400) % 7;
  char row[17];
  if (menu == 1 && blink) snprintf(row, sizeof row, "    --:%02d:%02d    ", m, s);
  else if (menu == 2 && blink) snprintf(row, sizeof row, "    %02d:--:%02d    ", h, s);
  else snprintf(row, sizeof row, "    %02d:%02d:%02d    ", h, m, s);
  put(0, row);
  if (menu) snprintf(row, sizeof row, "SET %-7s  +  ", menu == 1 ? "HOURS" : "MINUTES");
  else snprintf(row, sizeof row, "%s  %s  %2d%cC %c", days[d], h < 12 ? "AM" : "PM", 21 + (s / 20), (char)0xDF, (m == 0 && s < 5) ? 0x08 : ' ');   // 0x08 = CGRAM 0 (bell), hourly chime
  put(1, row);
  if (s == 0 && t != lastLog) lastLog = t, Serial.printf("%02d:%02d\\n", h, m);
  delay(10);
}
`;
  const THERMOSTAT_INO = `// DHT22 smart thermostat: 16x2 LCD + heater/fan relays (LEDs)
// Up/Down keys change the set point; the heater runs below it, the fan above it (0.5 C hysteresis).
#include <Wire.h>
#include <LiquidCrystal_PCF8574.h>
#include <DHT.h>

DHT dht(27, DHT22);
LiquidCrystal_PCF8574 lcd(0x27);
const int UP_PIN = 13, DOWN_PIN = 14, HEAT_PIN = 25, FAN_PIN = 26;
float setpoint = 22.0;
bool heating = false, cooling = false;

// Write only the characters that changed (each LCD byte is 6 I2C transfers through the PCF8574, so this keeps the
// loop fast and the buttons responsive).
char shownRow[2][17] = {"                ", "                "};
void put(int r, const char *s) {
  for (int c = 0; c < 16 && s[c]; c++) {
    if (shownRow[r][c] == s[c]) continue;
    int e = c; while (e < 16 && s[e] && shownRow[r][e] != s[e]) e++;
    lcd.setCursor(c, r);
    for (int i = c; i < e; i++) { lcd.write((uint8_t)s[i]); shownRow[r][i] = s[i]; }
    c = e - 1;
  }
}

bool pressed(int pin, bool &was) { bool b = digitalRead(pin); bool p = was && !b; was = b; return p; }

void show(float t, float h) {
  char row[17];
  if (isnan(t)) snprintf(row, sizeof row, "Sensor error!   ");
  else snprintf(row, sizeof row, "%5.1f%cC  %3.0f%%RH ", t, (char)0xDF, h);
  put(0, row);
  snprintf(row, sizeof row, "Set %4.1f %s%c", setpoint, heating ? " HEAT " : cooling ? " COOL " : " idle ", heating ? 0x7E : cooling ? 0x7F : ' ');
  put(1, row);
}

void setup() {
  Serial.begin(115200);
  pinMode(UP_PIN, INPUT_PULLUP); pinMode(DOWN_PIN, INPUT_PULLUP);
  pinMode(HEAT_PIN, OUTPUT); pinMode(FAN_PIN, OUTPUT);
  dht.begin();
  Wire.begin(); lcd.begin(16, 2); lcd.setBacklight(255);
  put(0, "DHT22 thermostat"); put(1, "  reading...    ");
  Serial.println("Thermostat: Up/Down = set point; drag the DHT22 sliders to change the room");
}

void loop() {
  static bool wu = true, wd = true;
  static unsigned long lastRead = 0;
  static float t = NAN, h = NAN;
  bool changed = false;
  if (pressed(UP_PIN, wu)) { setpoint += 0.5; changed = true; Serial.printf("set point %.1f\\n", setpoint); }
  if (pressed(DOWN_PIN, wd)) { setpoint -= 0.5; changed = true; Serial.printf("set point %.1f\\n", setpoint); }
  if (millis() - lastRead >= 2000 || lastRead == 0) {
    lastRead = millis();
    t = dht.readTemperature(); h = dht.readHumidity();
    if (!isnan(t)) {
      if (t < setpoint - 0.5) heating = true; else if (t >= setpoint) heating = false;
      if (t > setpoint + 0.5) cooling = true; else if (t <= setpoint) cooling = false;
      Serial.printf("T=%.1f C  RH=%.1f %%  set %.1f  -> %s\\n", t, h, setpoint, heating ? "HEAT" : cooling ? "COOL" : "idle");
    } else Serial.println("DHT22 read failed");
    changed = true;
  }
  digitalWrite(HEAT_PIN, heating); digitalWrite(FAN_PIN, cooling);
  if (changed) show(t, h);
  delay(20);
}
`;
  // ======================= Fun projects (real firmware) =======================
  // Shared layout: ESP32 at (300,400). Top-header GPIOs route up to rows, bottom-header GPIOs route down;
  // each side's rows are ordered so the wires never cross. LED = GPIO -> R -> LED -> GND symbol.
  function funKit() {
    const esp = part('esp32', 300, 400, { power: 'usb' }, 0, 'esp');
    const parts = [esp], wires = [];
    const add = (...p) => { parts.push(...p); return p[0]; };
    const gnd = (q) => add(part('ground', q.x, q.y, {}, 0));
    const lbl = (t, x, y, s = 12) => add(part('label', x, y, { text: t, size: s }, 0));
    // items: [{ pin, side: 'L'|'R', color, make(y, x) -> endpoint {x,y} }]; header 'top' or 'bot'
    function route(header, items, xL = 160, xR = 500, gap = 40) {
      const y0 = header === 'top' ? 400 : 490, dir = header === 'top' ? -1 : 1;
      for (const side of ['L', 'R']) {
        const g = items.filter((it) => it.side === side).map((it) => ({ ...it, P: pin(esp, it.pin) }));
        g.sort((a, b) => side === 'L' ? a.P.x - b.P.x : b.P.x - a.P.x);   // nearest-the-end pin gets the nearest row
        g.forEach((it, i) => {
          const y = y0 + dir * gap * (i + 1) + (it.dy || 0), end = it.make(y, side === 'L' ? xL : xR);
          wires.push(path(it.color || 'orange', it.P, pt(it.P.x, y), end));
        });
      }
    }
    const led = (color, ohm = 220) => (y, x) => {            // returns the resistor input point
      const r = add(part('resistor', x, y, { r: ohm }, 0)); const l = add(part('led', x + 40, y, { color }, 0)); gnd(pin(l, 'C')); return pin(r, '1');
    };
    const keyL = (key, label) => (y, x) => {                   // key on the left, its outer pin wired to a GND symbol
      const k = add(part('key', x - 30, y, { key, label }, 0)); const g = gnd(pt(x - 50, y)); wires.push(wire(pin(k, '1'), pin(g, 'GND'), 'black')); return pin(k, '2');
    };
    const buzzer = (ohm = 100) => (y, x) => {
      const r = add(part('resistor', x, y, { r: ohm }, 0)); const b = add(part('buzzer', x + 40, y, {}, 0)); gnd(pin(b, '-')); return pin(r, '1');
    };
    // I2C modules side by side below the board, bused like the I2C example (GND/3V3/SCL/SDA lanes under the pins)
    function i2c(mods) {
      const buses = [['GND', 'GND.1', 640, 'black'], ['VCC', '3V3', 650, 'red'], ['SCL', 'D22', 660, 'yellow'], ['SDA', 'D21', 670, 'blue']];
      for (const [mp, ep, y, col] of buses) {
        const pts = [pin(esp, ep), ...mods.map((m) => pin(m, mp))];
        for (const q of pts) wires.push(wire(q, pt(q.x, y), col));
        const xs = pts.map((q) => q.x).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) wires.push(wire(pt(xs[i - 1], y), pt(xs[i], y), col));
      }
    }
    const oled = (x = 160) => add(part('ssd1306', x, 600, {}, 0, 'OLED1'));
    const mpu = (x = 520) => add(part('mpu6050', x, 600, {}, 0, 'MPU1'));
    const bme = (x = 520) => add(part('bme280', x, 600, {}, 0, 'BME1'));
    return { esp, parts, wires, add, gnd, lbl, route, led, keyL, buzzer, i2c, oled, mpu, bme };
  }
  const fun = (name, code, k, notes) => ({ name, mode: 'qemu', code, parts: k.parts, wires: k.wires, notes });

  EX.traffic = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D27', side: 'R', color: '#ff6b6b', make: k.led('red') },
      { pin: 'D26', side: 'R', color: '#ffd43b', make: k.led('yellow') },
      { pin: 'D25', side: 'R', color: '#69db7c', make: k.led('green') },
      { pin: 'D33', side: 'R', color: '#69db7c', make: k.led('green') },
      { pin: 'D32', side: 'R', color: '#ff6b6b', make: k.led('red') },
      { pin: 'D14', side: 'L', color: 'white', make: (y, x) => { const b = k.add(part('pushbutton', x - 20, y, { key: 'w', label: 'WALK (w)' }, 0, 'BTN1')); k.gnd(pin(b, '1.r')); return pin(b, '2.l'); } },
    ]);
    k.route('bot', [{ pin: 'D4', side: 'R', color: 'orange', make: k.buzzer() }]);
    k.lbl('PEDESTRIAN: WALK / DON\'T WALK', 560, 245, 11); k.lbl('CARS: red / yellow / green', 560, 125, 11); k.lbl('Crossing beeper', 600, 535, 11); k.lbl('Request button', 110, 330, 11);
    return fun('Traffic light + pedestrian crossing (real firmware)', TRAFFIC_INO, k, 'A real state machine with millis(): cars stay green until someone presses WALK (key w), then yellow → all-red → WALK with a ticking beeper → flashing → red+yellow → green. The Serial tab logs every phase.');
  };
  EX.reaction = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D25', side: 'R', color: '#69db7c', make: k.led('green') },
      { pin: 'D26', side: 'R', color: '#ff6b6b', make: k.led('red') },
      { pin: 'D14', side: 'L', color: 'white', make: k.keyL('Enter', 'HIT ⏎') },
    ]);
    k.i2c([k.oled(160)]);
    k.lbl('GO', 600, 300, 11); k.lbl('false start', 600, 340, 11);
    return fun('Reaction-time game (OLED, real firmware)', REACTION_INO, k, 'Press HIT (Enter) to arm, wait for the green GO LED, then hit it as fast as you can. Too early lights the red LED. The OLED shows your time, best and average; times are measured on the emulated ESP32 with micros().');
  };
  EX.simon = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D27', side: 'R', color: '#ff6b6b', make: k.led('red') },
      { pin: 'D26', side: 'R', color: '#69db7c', make: k.led('green') },
      { pin: 'D25', side: 'R', color: '#4dabf7', make: k.led('blue') },
      { pin: 'D33', side: 'R', color: '#ffd43b', make: k.led('yellow') },
      { pin: 'D13', side: 'L', color: '#ff6b6b', make: k.keyL('1', 'RED 1') },
      { pin: 'D14', side: 'L', color: '#69db7c', make: k.keyL('2', 'GRN 2') },
    ]);
    k.route('bot', [
      { pin: 'D18', side: 'L', color: '#4dabf7', make: k.keyL('3', 'BLU 3') },
      { pin: 'D19', side: 'L', color: '#ffd43b', make: k.keyL('4', 'YEL 4') },
      { pin: 'D23', side: 'R', color: 'orange', make: k.buzzer() },
    ]);
    k.lbl('Simon: watch the LEDs, then repeat with keys 1-4', 300, 140, 13);
    return fun('Simon memory game (real firmware)', SIMON_INO, k, 'Watch the colour sequence (each colour has its own note on the buzzer), then repeat it with keys 1-4 or by clicking the buttons. Every round adds one step and it speeds up; the Serial tab shows level and score.');
  };
  EX.weather = () => {
    const k = funKit();
    k.route('top', [{ pin: 'D14', side: 'L', color: 'white', make: k.keyL('n', 'PAGE n') }]);
    k.i2c([k.oled(160), k.bme(520)]);
    k.lbl('Drag the BME280 sliders in the Inspector', 470, 520, 11);
    return fun('OLED weather station: BME280 + graphs (real firmware)', WEATHER_INO, k, 'Reads temperature, humidity and pressure from the BME280 once a second and shows an overview, temperature and pressure history graphs, and a pressure-trend forecast. Key n (PAGE) switches pages. Select the BME280 and drag its sliders to change the weather. (The DHT22 has no virtual part yet, so this uses the BME280.)');
  };
  EX.dice = () => {
    const k = funKit();
    k.route('top', [{ pin: 'D14', side: 'L', color: 'white', make: k.keyL('Enter', 'ROLL ⏎') }]);
    k.i2c([k.oled(160), k.mpu(520)]);
    k.lbl('shake = drag an Accel slider fast', 470, 520, 11);
    return fun('Electronic dice: OLED + shake to roll (real firmware)', DICE_INO, k, 'Two dice with a tumbling animation on the OLED. Press ROLL (Enter), or "shake" the MPU6050 by quickly dragging one of its accelerometer sliders. Doubles are called out and every 10 rolls the Serial tab prints the distribution of totals.');
  };
  EX.stopwatch = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D13', side: 'L', color: '#4dabf7', make: k.keyL('l', 'LAP l') },
      { pin: 'D14', side: 'L', color: '#69db7c', make: k.keyL('s', 'START s') },
      { pin: 'D25', side: 'R', color: '#69db7c', make: k.led('green') },
    ]);
    k.i2c([k.oled(160)]);
    k.lbl('running', 600, 320, 11);
    return fun('OLED stopwatch with laps (real firmware)', STOPWATCH_INO, k, 'START/STOP with key s, LAP (while running) or RESET (while stopped) with key l. The OLED shows mm:ss.hh, the last three lap splits and a seconds ring; the green LED is on while it runs. Splits also go to Serial.');
  };
  EX.vumeter = () => {
    const k = funKit();
    const cols = ['green', 'green', 'green', 'green', 'green', 'yellow', 'yellow', 'red'];
    const pins = ['D13', 'D14', 'D27', 'D26', 'D25', 'D33', 'D32'];
    k.route('top', [
      ...pins.map((p, i) => ({ pin: p, side: 'R', color: i < 5 ? '#69db7c' : i < 7 ? '#ffd43b' : '#ff6b6b', make: k.led(cols[i]) })),
      { pin: 'D34', side: 'R', color: 'yellow', make: (y, x) => {       // pot (rotated, wiper toward the board): top end GND, bottom end 3.3 V
        const px = x + 100, pot = k.add(part('potentiometer', px, y - 10, { r: 10000, pos: 0.3 }, 1, 'POT1'));
        const g = k.gnd(pt(px, y - 30)); k.wires.push(wire(pin(pot, '1'), pin(g, 'GND'), 'black'));
        const s = k.add(part('vcc33', px + 40, y + 40, {}, 0, 'V33')); k.gnd(pin(s, 'GND'));
        k.wires.push(path('red', pin(pot, '2'), pt(px, y + 40), pin(s, '+')));
        return pin(pot, 'W'); } },
    ]);
    k.route('bot', [
      { pin: 'D23', side: 'R', color: '#ff6b6b', make: k.led('red') },
      { pin: 'D4', side: 'L', color: 'white', make: (y, x) => { const sw = k.add(part('slideswitch', x - 20, y, { pos: 0 }, 0, 'SW1')); k.gnd(pin(sw, '1')); return pin(sw, '2'); } },
    ]);
    k.lbl('8-LED bar graph (D13 D14 D27 D26 D25 D33 D32 → D23 red)', 470, 60, 11); k.lbl('switch: POT ← → MUSIC', 90, 560, 11); k.lbl('level pot', 640, 352, 11);
    return fun('LED bar-graph VU meter (pot / music, real firmware)', VUMETER_INO, k, 'Eight LEDs (5 green, 2 yellow, 1 red) show the level from the pot on GPIO34 with fast attack, slow release and a falling peak-hold dot. Flip the slide switch to MUSIC for a simulated beat. Scroll over the pot or drag its slider.');
  };
  EX.morse = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D25', side: 'R', color: '#ffd43b', make: k.led('yellow') },
      { pin: 'D26', side: 'R', color: 'orange', make: k.buzzer() },
      { pin: 'D14', side: 'L', color: 'white', make: k.keyL('m', 'KEY m') },
    ]);
    k.lbl('Type in the Serial tab → Morse out · tap m → text in', 300, 240, 13);
    return fun('Morse code transceiver (Serial ↔ LED/buzzer, real firmware)', MORSE_INO, k, 'TX: type a message in the Serial tab and press Enter; it is keyed out at 15 WPM on the LED and buzzer and echoed as dots and dashes. RX: tap the KEY (m) - short for dot, long for dash - and letters and words are decoded to Serial. It sends SOS at boot.');
  };
  EX.snake = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D13', side: 'L', color: '#4dabf7', make: k.keyL('ArrowUp', '↑') },
      { pin: 'D14', side: 'L', color: '#4dabf7', make: k.keyL('ArrowDown', '↓') },
      { pin: 'D27', side: 'L', color: '#da77f2', make: k.keyL('ArrowLeft', '←') },
      { pin: 'D26', side: 'L', color: '#da77f2', make: k.keyL('ArrowRight', '→') },
      { pin: 'D25', side: 'R', color: 'orange', make: k.buzzer() },
    ]);
    k.i2c([k.oled(160)]);
    k.lbl('Arrow keys steer', 80, 200, 12);
    return fun('Snake game on the OLED (real firmware)', SNAKE_INO, k, 'Classic Snake on the 128×64 OLED. Steer with the arrow keys (four buttons on GPIO13/14/27/26), eat the food to grow, and do not hit the walls or yourself. It speeds up as you score; the buzzer beeps on every bite and the high score is kept until reset.');
  };
  EX.pong = () => {
    const k = funKit();
    const pot = k.add(part('potentiometer', 120, 320, { r: 10000, pos: 0.5 }, 0, 'POT1'));
    k.gnd(pin(pot, '2'));
    k.wires.push(path('yellow', pin(pot, 'W'), pt(130, 360), pt(410, 360), pin(k.esp, 'D34')), path('red', pin(pot, '1'), pt(120, 505), pt(300, 505), pin(k.esp, '3V3')));
    k.route('bot', [{ pin: 'D23', side: 'R', color: 'orange', make: k.buzzer() }]);
    k.i2c([k.oled(160)]);
    k.lbl('paddle: scroll over the knob', 70, 270, 12);
    return fun('Pong vs the ESP32 (pot paddle, OLED, real firmware)', PONG_INO, k, 'Your paddle follows the potentiometer on GPIO34 (scroll over the knob or drag its slider); the ESP32 plays the right paddle with a speed limit, so it can be beaten. The ball speeds up with every hit, hitting off-centre adds spin, first to 5 wins.');
  };
  EX.level = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D25', side: 'R', color: '#69db7c', make: k.led('green') },
      { pin: 'D26', side: 'R', color: '#ff6b6b', make: k.led('red') },
    ]);
    k.i2c([k.oled(160), k.mpu(520)]);
    k.lbl('level', 600, 300, 11); k.lbl('tilted', 600, 340, 11); k.lbl('tilt = Accel X/Y sliders', 470, 520, 11);
    return fun('Bubble spirit level: MPU6050 + OLED (real firmware)', LEVEL_INO, k, 'Pitch and roll from the MPU6050 accelerometer drive a damped bubble in a bull\'s-eye vial and a linear vial on the OLED. The green LED lights within 1° of level, the red one beyond 15°. Select the MPU6050 and drag Accel X / Y to tilt it.');
  };
  // ---- new parts: servo, NeoPixel ring, 16x2 LCD, DHT22 ----
  const potR = (k, start = 0.5) => (y, x) => {    // knob on the right: top end GND, bottom end 3.3 V, wiper back to the GPIO
    const px = x + 100, pot = k.add(part('potentiometer', px, y - 10, { r: 10000, pos: start }, 1, 'POT1'));
    const g = k.gnd(pt(px, y - 30)); k.wires.push(wire(pin(pot, '1'), pin(g, 'GND'), 'black'));
    const s = k.add(part('vcc33', px + 40, y + 40, {}, 0, 'V33')); k.gnd(pin(s, 'GND'));
    k.wires.push(path('red', pin(pot, '2'), pt(px, y + 40), pin(s, '+')));
    return pin(pot, 'W');
  };
  EX.servo = () => {
    const k = funKit(); let sv;
    k.route('top', [
      { pin: 'VIN', side: 'L', color: 'red', make: (y, x) => { sv = k.add(part('servo', 60, 250, {}, 0, 'SERVO1')); k.gnd(pin(sv, 'GND')); k.wires.push(path('red', pt(x, y), pt(70, y), pin(sv, 'V+'))); return pt(x, y); } },
      { pin: 'D13', side: 'L', color: 'orange', make: (y, x) => { k.wires.push(path('orange', pt(x, y), pt(80, y), pt(80, 250))); return pt(x, y); } },
      { pin: 'D14', side: 'L', color: 'white', make: k.keyL('s', 'SWEEP (s)') },
      { pin: 'D34', side: 'R', color: 'yellow', make: potR(k, 0.5) },
      { pin: 'D25', side: 'R', color: '#69db7c', make: k.led('green') },
    ]);
    k.lbl('SG90 on 5 V (VIN)', 70, 140, 11); k.lbl('aim knob', 600, 400, 11); k.lbl('sweep mode', 560, 300, 11);
    return fun('Servo: knob aim + radar sweep (ESP32Servo)', SERVO_INO, k, 'A real ESP32Servo sketch: the knob (GPIO34) sets the SG90 angle through a 50 Hz LEDC pulse (544-2400 µs). Press SWEEP (key s) for an automatic radar sweep. The servo horn follows the decoded pulse width at SG90 speed, and its label shows the angle and pulse.');
  };
  EX.neoring = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D14', side: 'L', color: 'white', make: k.keyL('m', 'EFFECT (m)') },
      { pin: 'D34', side: 'R', color: 'yellow', make: potR(k, 0.6) },
    ]);
    const ring = k.add(part('neoring', 600, 680, { n: 16 }, 0, 'RING1')); k.gnd(pin(ring, 'GND'));
    const s = k.add(part('vcc5', 560, 740, {}, 0, 'V5')); k.gnd(pin(s, 'GND'));
    k.wires.push(path('red', pin(ring, 'VCC'), pt(610, 710), pt(560, 710), pin(s, '+')));
    k.wires.push(path('#4dabf7', pin(k.esp, 'D5'), pt(370, 790), pt(620, 790), pin(ring, 'DIN')));
    k.lbl('brightness', 640, 300, 11); k.lbl('16× WS2812B ring on its own 5 V supply', 610, 820, 11);
    return fun('NeoPixel ring light show (WS2812B)', NEORING_INO, k, 'Adafruit_NeoPixel driving a 16-LED WS2812B ring on GPIO5: rainbow wheel, fire, comet and breathing effects. Key m switches the effect; the knob sets the brightness. Every show() frame is sent to the virtual ring, so the colours are exactly what the library computed (GRB wire order).');
  };
  EX.lcdclock = () => {
    const k = funKit();
    k.route('top', [
      { pin: 'D14', side: 'L', color: 'white', make: k.keyL('m', 'MENU (m)') },
      { pin: 'D27', side: 'L', color: '#ffd43b', make: k.keyL('+', 'PLUS (+)') },
    ]);
    const lcd = k.add(part('lcd1602', 520, 600, { addr: '0x27', color: 'blue' }, 0, 'LCD1'));
    k.i2c([lcd]);
    return fun('16×2 LCD clock with set menu (I2C)', LCDCLOCK_INO, k, 'LiquidCrystal_PCF8574 on a PCF8574 backpack at 0x27: the simulator decodes the 4-bit HD44780 protocol from the I2C expander bytes (RS/EN/backlight + D4-D7), including the custom bell glyph (CGRAM) and the degree sign. MENU (m) selects hours/minutes; PLUS (+) changes the blinking field.');
  };
  EX.thermostat = () => {
    const k = funKit(); let dht;
    k.route('top', [
      { pin: 'D13', side: 'L', color: '#ff6b6b', make: k.keyL('ArrowUp', 'UP ↑') },
      { pin: 'D14', side: 'L', color: '#4dabf7', make: k.keyL('ArrowDown', 'DOWN ↓') },
      { pin: 'D27', side: 'L', color: '#9775fa', make: (y, x) => {
        dht = k.add(part('dht22', 60, 220, { temp: 20.5, hum: 48 }, 0, 'DHT1')); k.gnd(pin(dht, 'GND'));
        const s = k.add(part('vcc33', 20, 260, {}, 0, 'V33')); k.gnd(pin(s, 'GND'));
        k.wires.push(path('red', pin(dht, 'VCC'), pt(60, 240), pt(20, 240), pin(s, '+')));
        k.wires.push(path('#9775fa', pt(x, y), pt(70, y), pin(dht, 'DATA'))); return pt(x, y); } },
      { pin: 'D25', side: 'R', color: '#ff6b6b', make: k.led('red') },
      { pin: 'D26', side: 'R', color: '#4dabf7', make: k.led('blue') },
    ]);
    const lcd = k.add(part('lcd1602', 520, 600, { addr: '0x27', color: 'green' }, 0, 'LCD1'));
    k.i2c([lcd]);
    k.lbl('HEAT', 600, 370, 11); k.lbl('FAN', 600, 330, 11); k.lbl('drag the DHT22 sliders →', 60, 130, 11);
    return fun('DHT22 thermostat (LCD + heater/fan)', THERMOSTAT_INO, k, 'A DHT22 (GPIO27) read with the Adafruit DHT library every 2 s; the 16×2 LCD shows temperature, humidity and the set point. UP/DOWN arrows change the set point; the red HEAT LED runs below it and the blue FAN LED above it (0.5 °C hysteresis). Select the DHT22 and drag its temperature slider to watch the thermostat react.');
  };

  const KEYLOCK_INO = `// Keypad door lock: 4x4 membrane keypad (Keypad.h) + 16x2 I2C LCD + SG90 servo bolt + status LEDs
// Type the PIN (default 1234) and press # to unlock. * clears. A = lock now, B = show hint.
#include <Keypad.h>
#include <Wire.h>
#include <LiquidCrystal_PCF8574.h>
#include <ESP32Servo.h>

const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};
byte rowPins[ROWS] = {13, 12, 14, 27};   // R1..R4
byte colPins[COLS] = {26, 25, 33, 32};   // C1..C4
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
LiquidCrystal_PCF8574 lcd(0x27);
Servo bolt;

const int SERVO_PIN = 18, LED_RED = 4, LED_GREEN = 2;
const String PIN_CODE = "1234";
String entry;
bool unlocked = false;
unsigned long unlockedAt = 0;

void prompt() {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("Enter PIN, #=OK");
  lcd.setCursor(0, 1); lcd.print("> ");
  for (unsigned i = 0; i < entry.length(); i++) lcd.print('*');
}

void lock() {
  unlocked = false; bolt.write(0);
  digitalWrite(LED_RED, HIGH); digitalWrite(LED_GREEN, LOW);
  entry = ""; prompt();
  Serial.println("LOCKED");
}

void unlock() {
  unlocked = true; unlockedAt = millis(); bolt.write(90);
  digitalWrite(LED_RED, LOW); digitalWrite(LED_GREEN, HIGH);
  lcd.clear(); lcd.setCursor(0, 0); lcd.print("  ACCESS GRANTED");
  lcd.setCursor(0, 1); lcd.print("  door unlocked");
  Serial.println("UNLOCKED");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_RED, OUTPUT); pinMode(LED_GREEN, OUTPUT);
  Wire.begin();
  Wire.begin(); lcd.begin(16, 2); lcd.setBacklight(255);
  bolt.setPeriodHertz(50);
  bolt.attach(SERVO_PIN, 544, 2400);
  lcd.setCursor(0, 0); lcd.print("Keypad door lock");
  lcd.setCursor(0, 1); lcd.print("ESP32 + Keypad.h");
  delay(1200);
  lock();
}

void loop() {
  char k = keypad.getKey();
  if (k) {
    Serial.printf("key %c\\n", k);
    if (unlocked) { if (k == 'A' || k == '*') lock(); }
    else if (k == '*') { entry = ""; prompt(); }
    else if (k == 'B') { lcd.setCursor(0, 1); lcd.print("hint: 1..4     "); delay(900); prompt(); }
    else if (k == '#') {
      if (entry == PIN_CODE) unlock();
      else {
        lcd.clear(); lcd.setCursor(0, 0); lcd.print(" ACCESS DENIED");
        for (int i = 0; i < 3; i++) { digitalWrite(LED_RED, LOW); delay(120); digitalWrite(LED_RED, HIGH); delay(120); }
        entry = ""; prompt();
      }
    } else if (k != 'A' && entry.length() < 8) { entry += k; prompt(); }
  }
  if (unlocked && millis() - unlockedAt > 8000) lock();   // auto re-lock
}
`;
  EX.keylock = () => {
    const k = funKit(); let sv;
    const kp = k.add(part('keypad', 320, 300, {}, 0, 'KEYPAD1'));
    const map = [['R1', 'D13', 'white'], ['R2', 'D12', 'yellow'], ['R3', 'D14', 'orange'], ['R4', 'D27', 'red'], ['C1', 'D26', 'purple'], ['C2', 'D25', 'blue'], ['C3', 'D33', 'green'], ['C4', 'D32', 'gray']];
    for (const [a, b, c] of map) k.wires.push(wire(pin(kp, a), pin(k.esp, b), c));
    k.route('bot', [
      { pin: 'D18', side: 'R', color: 'orange', make: (y, x) => {
        sv = k.add(part('servo', 680, 400, {}, 0, 'SERVO1')); k.gnd(pin(sv, 'GND'));
        const s5 = k.add(part('vcc5', 640, 450, {}, 0, 'V5')); k.gnd(pin(s5, 'GND'));
        k.wires.push(path('red', pin(sv, 'V+'), pt(690, 425), pt(640, 425), pin(s5, '+')));
        k.wires.push(path('orange', pt(700, y), pin(sv, 'SIG'))); return pt(700, y); } },
      { pin: 'D4', side: 'R', color: 'brown', make: k.led('red') },
      { pin: 'D2', side: 'R', color: 'green', make: k.led('green') },
    ], 160, 560);
    const lcd = k.add(part('lcd1602', 40, 600, { addr: '0x27', color: 'green' }, 0, 'LCD1'));
    k.i2c([lcd]);
    k.lbl('PIN 1234 then #  ·  * clears  ·  A locks', 250, 70, 12);
    k.lbl('type keys on your keyboard or click them', 270, 86, 10);
    k.lbl('LOCKED', 620, 568, 10); k.lbl('OPEN', 620, 608, 10); k.lbl('bolt (servo)', 650, 300, 10);
    return fun('Keypad door lock (Keypad.h + LCD + servo)', KEYLOCK_INO, k, 'A real Keypad.h sketch scans the 4x4 membrane keypad (rows GPIO13/12/14/27 as INPUT_PULLUP, columns GPIO26/25/33/32 driven low one at a time). Each pressed key connects its row to its column in the circuit model, so the scan works exactly like on hardware. Enter 1234 and # to swing the servo bolt open (green LED); * clears, A re-locks. Click the keys or type them on your keyboard while running.');
  };
  // ---- END fun projects ----
  const LIST = [['blink', 'Blink'], ['button', 'Button + LED'], ['pot', 'Potentiometer → LED PWM'], ['potjs', 'Pot → PWM (JS sketch)'], ['fade', 'LED fade (LEDC)'], ['i2c', 'I2C OLED + BME280 + MPU6050'], ['spi', 'SPI TFT + MCP3008 + SD (FAT16 image)'], ['rc', 'RC charging (scope)'], ['transistor', 'Transistor switch'], ['remote', 'Wi-Fi/IR TV Remote'], ['traffic', '★ Traffic light + pedestrian button'], ['reaction', '🎮 Reaction-time game (OLED)'], ['simon', '🎮 Simon memory game'], ['weather', '★ OLED weather station (BME280)'], ['dice', '🎮 Electronic dice (OLED + shake)'], ['stopwatch', '★ OLED stopwatch with laps'], ['vumeter', '★ LED bar-graph VU meter'], ['morse', '★ Morse code transceiver'], ['snake', '🎮 Snake game (OLED)'], ['pong', '🎮 Pong vs the ESP32 (OLED + pot)'], ['level', '★ Bubble spirit level (MPU6050)'], ['servo', '★ Servo knob + radar sweep'], ['neoring', '★ NeoPixel ring light show'], ['lcdclock', '★ 16×2 LCD clock + menu'], ['thermostat', '★ DHT22 thermostat (LCD)'], ['keylock', '★ Keypad door lock (4×4 keypad + LCD + servo)'], ['blank', 'Blank']];
  const api = { EX, LIST, BLINK, BUTTON, EMPTY_INO, BLANK_KINDS: Object.keys(BLANK_KINDS), newBlank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Examples = api;
})(typeof window !== 'undefined' ? window : globalThis);
