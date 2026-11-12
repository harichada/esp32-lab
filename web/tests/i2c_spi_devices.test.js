// Device models behind the I2C OLED + BME280 + MPU6050 and SPI TFT + MCP3008 + SD examples.
// This drives the same classes the QEMU bridge calls. It does not compile or boot firmware:
// this tree has no arduino-cli and no qemu-system-xtensa.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/solver.js');
require('../js/parts.js');
const { Sim } = require('../js/sim.js');
const I2C = require('../js/i2cdev.js');
const SPI = require('../js/spidev.js');
require('../js/examples.js');

function readRegs(dev, reg, n) {
  dev.start(false);
  dev.write(reg);
  dev.start(true);
  const out = [];
  for (let i = 0; i < n; i++) out.push(dev.read());
  dev.stop();
  return out;
}
function s16(hi, lo) { const v = (hi << 8) | lo; return v & 0x8000 ? v - 0x10000 : v; }

test('SSD1306 draws the framebuffer the controller writes, and stays dark until display-on', () => {
  const oled = new I2C.SSD1306();
  oled.start(); oled.write(0x00); oled.write(0xA1); oled.write(0xC8); oled.stop();
  oled.start(); oled.write(0x40); oled.write(0x01); oled.stop();
  assert.equal(oled.lit(0, 0), false, 'pixels stay dark while the panel is off');
  oled.start(); oled.write(0x00); oled.write(0xAF); oled.stop();
  assert.equal(oled.on, true);
  assert.equal(oled.contrast, 0x7f);
  assert.equal(oled.lit(0, 0), true);
  assert.equal(oled.lit(1, 0), false);
  oled.start(); oled.write(0x00); oled.write(0x81); oled.write(0x20); oled.stop();
  assert.equal(oled.contrast, 0x20);
});

test('BME280 id is 0x60 and a sample decodes to the part temperature, humidity and pressure', () => {
  const env = { temp: 23.5, hum: 45, press: 1013.25 };
  const bme = new I2C.BME280(() => env);
  assert.equal(readRegs(bme, 0xD0, 1)[0], 0x60);
  assert.equal(readRegs(bme, 0xF3, 1)[0], 0, 'status is idle');
  const raw = readRegs(bme, 0xF7, 8);
  const adcP = (raw[0] << 12) | (raw[1] << 4) | (raw[2] >> 4);
  const adcT = (raw[3] << 12) | (raw[4] << 4) | (raw[5] >> 4);
  const adcH = (raw[6] << 8) | raw[7];
  const tf = I2C.bmeTfine(adcT);
  const temp = tf / 5120;
  const press = I2C.bmeP(adcP, tf) / 100;
  const hum = I2C.bmeH(adcH, tf);
  assert.ok(Math.abs(temp - env.temp) < 0.05, 'temp ' + temp);
  assert.ok(Math.abs(hum - env.hum) < 0.5, 'hum ' + hum);
  assert.ok(Math.abs(press - env.press) < 1, 'press ' + press);
});

test('MPU6050 WHO_AM_I is 0x68 and accel follows the slider at the selected full-scale', () => {
  const env = { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 25 };
  const mpu = new I2C.MPU6050(() => env);
  assert.equal(readRegs(mpu, 0x75, 1)[0], 0x68);
  assert.equal(readRegs(mpu, 0x6B, 1)[0], 0x40, 'powers up asleep');
  mpu.start(false); mpu.write(0x6B); mpu.write(0x00); mpu.stop();
  const raw = readRegs(mpu, 0x3B, 14);
  assert.equal(s16(raw[0], raw[1]), 0);
  assert.equal(s16(raw[4], raw[5]), 16384, '1 g on Z at ±2 g is 16384 LSB');
  const temp = s16(raw[6], raw[7]) / 340 + 36.53;
  assert.ok(Math.abs(temp - 25) < 0.05, 'temp ' + temp);
  mpu.start(false); mpu.write(0x1C); mpu.write(0x08); mpu.stop(); // ±4 g
  const wide = readRegs(mpu, 0x3B, 6);
  assert.equal(s16(wide[4], wide[5]), 8192);
});

test('ILI9341 stores an RGB565 pixel and the page only paints it after display-on', () => {
  const t = new SPI.ILI9341();
  const c = (b) => t.xfer(b, { dc: 0 }), d = (b) => t.xfer(b, { dc: 1 });
  c(0x3A); d(0x55); // pixel-format command is accepted and ignored
  c(0x36); d(0x48);
  c(0x2A); [0, 10, 0, 11].forEach(d);
  c(0x2B); [0, 20, 0, 20].forEach(d);
  c(0x2C); [0xF8, 0x00].forEach(d);
  assert.equal(t.on, false);
  assert.deepEqual(t.rgb(10, 20), [255, 0, 0]);
  c(0x29);
  assert.equal(t.on, true);
  assert.deepEqual(t.rgb(10, 20), [255, 0, 0]);
});

test('SPI example pot drives MCP3008 channel 0 to a plausible count', () => {
  const proj = globalThis.Examples.EX.spi();
  const sim = new Sim(proj);
  for (let i = 0; i < 8; i++) sim.advance(0.001);
  const mcp = proj.parts.find((p) => p.type === 'mcp3008');
  const g = sim.pinVoltage(mcp, 'GND');
  const vr = sim.pinVoltage(mcp, 'VDD') - g;
  const ch = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => sim.pinVoltage(mcp, 'CH' + i) - g);
  assert.ok(vr > 3 && vr < 3.5, 'vref ' + vr);
  // pos is the fraction of the element from pin 1 (3V3) to the wiper, so 0.62 sits nearer ground.
  const divider = vr * (1 - 0.62);
  assert.ok(Math.abs(ch[0] - divider) < 0.15, 'CH0 ' + ch[0] + ' vs ' + divider);
  const adc = new SPI.MCP3008(() => ({ vref: vr, ch }));
  const r = [0x01, 0x80, 0].map((b) => adc.xfer(b));
  const count = ((r[1] & 3) << 8) | r[2];
  const expect = Math.floor(ch[0] / vr * 1024);
  assert.equal(count, expect);
  assert.ok(count > 300 && count < 550, 'count ' + count);
});

test('SD FAT16 image serves HELLO.TXT and keeps a sector write', () => {
  const hello = 'Hello from the virtual SD card!\r\n';
  const sd = new SPI.SDCard(SPI.fat16Image([['HELLO.TXT', hello]]));
  const x = (bytes, n) => { bytes.forEach((b) => sd.xfer(b)); const o = []; for (let i = 0; i < n; i++) o.push(sd.xfer(0xff)); return o; };
  assert.ok(x([0x40, 0, 0, 0, 0, 0x95], 2).includes(1));
  x([0x77, 0, 0, 0, 0, 1], 2);
  assert.ok(x([0x69, 0x40, 0, 0, 0, 1], 2).includes(0));
  assert.equal(sd.file('hello.txt'), hello);
  const payload = new Uint8Array(512);
  payload[0] = 0x41; payload[1] = 0x42;
  sd.xfer(0x58); sd.xfer(0); sd.xfer(0); sd.xfer(0); sd.xfer(10); sd.xfer(1); // CMD24 sector 10
  sd.xfer(0xff); sd.xfer(0xfe);
  for (const b of payload) sd.xfer(b);
  sd.xfer(0xff); sd.xfer(0xff);
  assert.equal(sd.block(10)[0], 0x41);
  assert.equal(sd.block(10)[1], 0x42);
  assert.equal(sd.file('hello.txt'), hello, 'a sector write does not wipe HELLO.TXT');
});
