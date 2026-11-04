const test = require('node:test'), assert = require('node:assert');
const D = require('../js/spidev.js'), S = require('../js/sim.js');
test('ILI9341: CASET/RASET/RAMWR RGB565 with MADCTL BGR', () => {
  const t = new D.ILI9341(), c = (b) => t.xfer(b, { dc: 0 }), d = (b) => t.xfer(b, { dc: 1 });
  c(0x36); d(0x48); c(0x2A); [0, 10, 0, 11].forEach(d); c(0x2B); [0, 20, 0, 20].forEach(d); c(0x2C); [0xF8, 0x00, 0x07, 0xE0].forEach(d);
  assert.deepStrictEqual(t.rgb(10, 20), [255, 0, 0]); assert.deepStrictEqual(t.rgb(11, 20), [0, 255, 0]);
});
test('MCP3008: single-ended read, standard 3-byte frame', () => {
  const m = new D.MCP3008(() => ({ vref: 3.3, ch: [0, 0, 0, 2.0, 0, 0, 0, 0] }));
  const r = [0x01, 0x80 | 3 << 4, 0].map((b) => m.xfer(b)); assert.strictEqual(((r[1] & 3) << 8) | r[2], Math.floor(2.0 / 3.3 * 1024));
});
test('SD card: CMD0/CMD8/ACMD41/CMD58 then CMD17 returns FAT boot sector', () => {
  const sd = new D.SDCard(), x = (bytes, n) => { bytes.forEach((b) => sd.xfer(b)); const o = []; for (let i = 0; i < n; i++) o.push(sd.xfer(0xff)); return o; };
  assert.ok(x([0x40, 0, 0, 0, 0, 0x95], 2).includes(1));
  assert.deepStrictEqual(x([0x48, 0, 0, 1, 0xAA, 0x87], 6).slice(1, 6), [1, 0, 0, 1, 0xAA]);
  x([0x77, 0, 0, 0, 0, 1], 2); assert.ok(x([0x69, 0x40, 0, 0, 0, 1], 2).includes(0));
  const o = x([0x51, 0, 0, 0, 0, 1], 520); const k = o.indexOf(0xfe); assert.ok(k > 0); assert.strictEqual(o[k + 1 + 510], 0x55); assert.strictEqual(o[k + 1 + 511], 0xAA);
  assert.strictEqual(sd.file('hello.txt').trim(), 'Hello from the virtual SD card!');
});
test('ADC model is the exact inverse of the IDF line-fitting + LUT calibration', () => {
  for (const mv of [200, 1000, 2400, 2500, 2700, 2950, 3100]) assert.ok(Math.abs(S.idfRawToMv(S.mvToRaw(mv)) - mv) <= 2, String(mv));
  assert.strictEqual(S.mvToRaw(3300), 4095);
});
