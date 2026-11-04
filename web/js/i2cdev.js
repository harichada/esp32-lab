/* Virtual I2C devices driven by real firmware (QEMU I2C controller -> bridge -> here) or JS tests.
 * SSD1306 128x64 OLED, BME280 (T/P/H), MPU6050 (accel/gyro/temp). Each model: start(read) -> ack, write(byte), read() -> byte, stop(). */
(function (root) {
  // ---------------- SSD1306 ----------------
  const ARGS = { 0x20: 1, 0x21: 2, 0x22: 2, 0x81: 1, 0xA8: 1, 0xD3: 1, 0xD5: 1, 0xD9: 1, 0xDA: 1, 0xDB: 1, 0x8D: 1, 0xA3: 2, 0x26: 6, 0x27: 6, 0x29: 5, 0x2A: 5 };
  class SSD1306 {
    constructor() { this.fb = new Uint8Array(128 * 8); this.on = false; this.inv = false; this.contrast = 0x7f; this.mode = 2; this.c0 = 0; this.c1 = 127; this.p0 = 0; this.p1 = 7; this.col = 0; this.page = 0; this.version = 0; this.flipX = false; this.flipY = false; }
    // the command parser keeps its state across I2C transactions: Adafruit's display() sends COLUMNADDR, 0 in one
    // transaction and the end column (127) in the next; resetting here dropped it and the picture wrapped sideways
    start() { this.first = true; this.ctl = null; if (!this.cmd) this.cmd = []; return true; }
    write(b) {
      if (this.ctl === null || this.single) { this.ctl = b; this.single = false; this.cont = !!(b & 0x80); return; }
      if (this.ctl & 0x40) this.data(b); else this.command(b);
      if (this.cont) this.ctl = null;   // Co=1: next byte is a control byte again
    }
    read() { return this.on ? 0x03 : 0x43; }   // status register
    stop() {}
    command(b) {
      this.cmd.push(b); const c = this.cmd[0], need = ARGS[c] || 0;
      if (this.cmd.length <= need) return;
      const a = this.cmd.slice(1); this.cmd = [];
      if (c === 0xAE) this.on = false; else if (c === 0xAF) this.on = true;
      else if (c === 0xA6) this.inv = false; else if (c === 0xA7) this.inv = true;
      else if (c === 0x81) this.contrast = a[0];
      else if (c === 0x20) this.mode = a[0] & 3;
      else if (c === 0x21) { this.c0 = a[0] & 127; this.c1 = a[1] & 127; this.col = this.c0; }
      else if (c === 0x22) { this.p0 = a[0] & 7; this.p1 = a[1] & 7; this.page = this.p0; }
      else if (c >= 0xB0 && c <= 0xB7) this.page = c & 7;
      else if (c <= 0x0F) this.col = (this.col & 0xF0) | c;
      else if (c >= 0x10 && c <= 0x1F) this.col = (this.col & 0x0F) | ((c & 0x0F) << 4);
      else if (c === 0xA0) this.flipX = false; else if (c === 0xA1) this.flipX = true;
      else if (c === 0xC0) this.flipY = false; else if (c === 0xC8) this.flipY = true;
      this.version++;
    }
    data(b) {
      this.fb[this.page * 128 + (this.col & 127)] = b; this.version++;
      if (this.mode === 2) { this.col = (this.col + 1) & 127; return; }   // page addressing
      if (this.mode === 0) { if (++this.col > this.c1) { this.col = this.c0; if (++this.page > this.p1) this.page = this.p0; } }
      else { if (++this.page > this.p1) { this.page = this.p0; if (++this.col > this.c1) this.col = this.c0; } }
    }
    pixel(x, y) { const v = (this.fb[(y >> 3) * 128 + x] >> (y & 7)) & 1; return this.inv ? !v : !!v; }
    // standard Adafruit init uses A1 + C8 (both flips) which together give an upright image
    // Adafruit/u8g2 init use segment remap (A1) + COM remap (C8), which shows the framebuffer upright
    lit(x, y) { return this.on && this.pixel(this.flipX ? x : 127 - x, this.flipY ? y : 63 - y); }
    text() { let s = ''; for (let y = 0; y < 64; y += 2) { for (let x = 0; x < 128; x += 1) s += this.pixel(x, y) ? '#' : '.'; s += '\n'; } return s; }
  }
  // ---------------- PCF8574 backpack + HD44780 16x2 character LCD (LiquidCrystal_I2C) ----------------
  // Expander bits: P0=RS P1=RW P2=EN P3=backlight P4..P7=D4..D7. The HD44780 latches on EN falling edge; it powers up
  // in 8-bit mode (only D7..D4 wired), so the 0x3,0x3,0x3,0x2 init nibbles switch it to 4-bit, then bytes come as nibble pairs.
  const FONT5X7 = '00000000003e5b4f5b3e3e6b4f6b3e1c3e7c3e1c183c7e3c181c577d571c1c5e7f5e1c00183c1800ffe7c3e7ff0018241800ffe7dbe7ff30483a060e2629792926407f050507407f05253f5a3ce73c5a7f3e1c1c08081c1c3e7f14227f22145f5f005f5f06097f017f006689956a606060606094a2ffa29408047e040810207e201008082a1c08081c2a08081e101010100c1e0c1e0c30383e3830060e3e0e06000000000000005f00000007000700147f147f14242a7f2a12231308646236495620500008070300001c2241000041221c002a1c7f1c2a08083e080800807030000808080808000060600020100804023e5149453e00427f400072494949462141494d331814127f1027454545393c4a49493141211109073649494936464949291e0000140000004034000000081422411414141414004122140802015909063e415d594e7c1211127c7f494949363e414141227f4141413e7f494949417f090909013e414151737f0808087f00417f41002040413f017f081422417f404040407f021c027f7f0408107f3e4141413e7f090909063e4151215e7f09192946264949493203017f01033f4040403f1f2040201f3f4038403f631408146303047804036159494d43007f4141410204081020004141417f04020102044040404040000307080020545478407f284444383844444428384444287f385454541800087e090218a4a49c787f0804047800447d40002040403d007f1028440000417f40007c047804787c080404783844444438fc1824241818242418fc7c08040408485454542404043f44243c4040207c1c2040201c3c4030403c44281028444c9090907c4464544c4400083641000000770000004136080002010204023c2623263c1ea1a161123a4040207a385454555921555579412254547842215554784020545579400c1e5272123955555559395454545939555454580000457c410002457d420001457c407d1211127df0282528f07c545545002054547c547c0a097f4932494949323a4444443a324a4848303a4141217a3a42402078009da0a07d3d4242423d3d4040403d3c24ff2424487e4943662b2ffc2f2bff0929f620c0887e090320545479410000447d413048484a32384040227a007a0a0a727d0d19317d2629292f28262929292630484d4020380808080808080808382f10c8acba2f102834fa00007b000008142a142222142a14085500550055aa55aa55aaff55ff55ff000000ff00101010ff00141414ff001010ff00ff1010f010f0141414fc001414f700ff0000ff00ff1414f404fc141417101f10101f101f1414141f00101010f0000000001f101010101f10101010f010000000ff101010101010101010ff10000000ff140000ff00ff00001f10170000fc04f414141710171414f404f40000ff00f714141414141414f700f7141414171410101f101f141414f4141010f010f000001f101f0000001f14000000fc140000f010f01010ff10ff141414ff141010101f00000000f010fffffffffff0f0f0f0f0ffffff0000000000ffff0f0f0f0f0f3844443844fc4a4a4a347e02020606027e027e0263554941633844443c04407e201e2006027e020299a5e7a5991c2a492a1c4c7201724c304a4d4d303048784830bc625a463d3e494949007e0101017e2a2a2a2a2a44445f444440514a444040444a51400000ff0103e080ff000008086b6b083612362436060f090f06000018180000001010003040ff0101001f01011e00191d1712003c3c3c3c0000000000';
  class LCD1602 {
    constructor(cols = 16, rows = 2) { this.cols = cols; this.rows = rows; this.ddram = new Uint8Array(128).fill(0x20); this.cgram = new Uint8Array(64); this.port = 0xff; this.version = 1; this.reset(); }
    reset() { this.bits8 = true; this.half = null; this.ac = 0; this.cg = false; this.inc = true; this.shiftDisp = false; this.disp = false; this.cursor = false; this.blink = false; this.shift = 0; this.lines2 = true; this.version++; }
    start() { this.first = true; return true; }
    write(b) {
      const prev = this.port; this.port = b & 0xff;
      if ((prev & 4) && !(b & 4)) this.strobe(prev);   // EN high -> low: latch with the bus state that was present while EN was high
      if ((prev & 8) !== (b & 8)) this.version++;
    }
    read() { return this.port; }
    stop() {}
    get backlight() { return !!(this.port & 8); }
    strobe(v) {
      const rs = v & 1, nib = (v >> 4) & 15;
      if (v & 2) return;   // read cycle (busy flag) - nothing to latch
      if (this.bits8) { const byte = nib << 4; if (!rs) this.cmd(byte); else this.data(byte); return; }
      if (this.half === null) { this.half = nib; return; }
      const byte = (this.half << 4) | nib; this.half = null;
      if (rs) this.data(byte); else this.cmd(byte);
    }
    cmd(c) {
      if (c & 0x80) { this.ac = c & 0x7f; this.cg = false; }
      else if (c & 0x40) { this.ac = c & 0x3f; this.cg = true; }
      else if (c & 0x20) { if (!(c & 0x10)) { this.bits8 = false; this.half = null; } else this.bits8 = true; this.lines2 = !!(c & 8); }
      else if (c & 0x10) { if (c & 8) this.shift += (c & 4) ? 1 : -1; else this.move((c & 4) ? 1 : -1); }
      else if (c & 0x08) { this.disp = !!(c & 4); this.cursor = !!(c & 2); this.blink = !!(c & 1); }
      else if (c & 0x04) { this.inc = !!(c & 2); this.shiftDisp = !!(c & 1); }
      else if (c & 0x02) { this.ac = 0; this.shift = 0; this.cg = false; }
      else if (c & 0x01) { this.ddram.fill(0x20); this.ac = 0; this.shift = 0; this.inc = true; this.cg = false; }
      this.version++;
    }
    move(d) { this.ac = (this.ac + d) & 0x7f; if (this.ac > 0x27 && this.ac < 0x40) this.ac = d > 0 ? 0x40 : 0x27; if (this.ac > 0x67) this.ac = d > 0 ? 0 : 0x67; }
    data(b) {
      if (this.cg) { this.cgram[this.ac & 63] = b & 31; this.ac = (this.ac + (this.inc ? 1 : -1)) & 63; }
      else { this.ddram[this.ac] = b; this.move(this.inc ? 1 : -1); if (this.shiftDisp) this.shift += this.inc ? 1 : -1; }
      this.version++;
    }
    charAt(r, c) { const base = r ? 0x40 : 0; let a = ((c + this.shift) % 40 + 40) % 40; return this.ddram[base + a]; }
    // 5x8 dot rows for a character code (CGRAM 0-7, HD44780 A00 specials, else the classic 5x7 font)
    glyph(code) {
      if (code < 16) { const o = (code & 7) * 8; return Array.from(this.cgram.slice(o, o + 8)); }
      const map = { 0xDF: 0xF8, 0x7E: 0x1A, 0x7F: 0x1B, 0xFF: 0xDB, 0xA5: 0xF9 };
      const g = map[code] !== undefined ? map[code] : code, rows = new Array(8).fill(0);
      for (let x = 0; x < 5; x++) { const col = parseInt(FONT5X7.substr((g * 5 + x) * 2, 2), 16); for (let y = 0; y < 8; y++) if (col >> y & 1) rows[y] |= 16 >> x; }
      return rows;
    }
    text() { let s = ''; for (let r = 0; r < this.rows; r++) { for (let c = 0; c < this.cols; c++) { const ch = this.charAt(r, c); s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '?'; } s += '\n'; } return s; }
  }
  // ---------------- register-file base ----------------
  class RegDev {
    constructor() { this.r = new Uint8Array(256); this.ptr = 0; }
    // a read burst that begins anywhere inside the data block latches a fresh, coherent sample (Adafruit reads
    // temperature at 0xFA alone, then the block again for pressure; latching only at dataStart returned stale/zero data)
    start(read) { this.first = true; this.burst = read !== false; return true; }
    write(b) { if (this.first) { this.ptr = b; this.first = false; return; } this.r[this.ptr] = b; this.onWrite(this.ptr, b); this.ptr = (this.ptr + 1) & 0xff; }
    read() { if (this.burst && this.ptr >= this.dataStart && this.ptr < this.dataStart + (this.dataLen || 1)) this.latch(); this.burst = false; const v = this.r[this.ptr]; this.ptr = (this.ptr + 1) & 0xff; return v; }
    stop() {}
    onWrite() {} latch() {}
  }
  // ---------------- BME280 ----------------
  const BC = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000, H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30 };
  function bmeTfine(adcT) { const v1 = (adcT / 16384 - BC.T1 / 1024) * BC.T2, v2 = ((adcT / 131072 - BC.T1 / 8192) ** 2) * BC.T3; return v1 + v2; }
  function bmeP(adcP, tf) {
    let v1 = tf / 2 - 64000, v2 = v1 * v1 * BC.P6 / 32768; v2 += v1 * BC.P5 * 2; v2 = v2 / 4 + BC.P4 * 65536;
    v1 = (BC.P3 * v1 * v1 / 524288 + BC.P2 * v1) / 524288; v1 = (1 + v1 / 32768) * BC.P1; if (!v1) return 0;
    let p = 1048576 - adcP; p = (p - v2 / 4096) * 6250 / v1; v1 = BC.P9 * p * p / 2147483648; v2 = p * BC.P8 / 32768; return p + (v1 + v2 + BC.P7) / 16;
  }
  function bmeH(adcH, tf) {
    let h = tf - 76800; h = (adcH - (BC.H4 * 64 + BC.H5 / 16384 * h)) * (BC.H2 / 65536 * (1 + BC.H6 / 67108864 * h * (1 + BC.H3 / 67108864 * h)));
    h = h * (1 - BC.H1 * h / 524288); return Math.max(0, Math.min(100, h));
  }
  function solve(f, target, lo, hi, inc) { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2, v = f(m); if ((v < target) === inc) lo = m; else hi = m; } return Math.round((lo + hi) / 2); }
  class BME280 extends RegDev {
    constructor(env) {
      super(); this.env = env; this.dataStart = 0xF7; this.dataLen = 8; const r = this.r; r[0xD0] = 0x60;
      const le16 = (o, v) => { r[o] = v & 255; r[o + 1] = (v >> 8) & 255; };
      le16(0x88, BC.T1); le16(0x8A, BC.T2); le16(0x8C, BC.T3); le16(0x8E, BC.P1); le16(0x90, BC.P2); le16(0x92, BC.P3); le16(0x94, BC.P4); le16(0x96, BC.P5); le16(0x98, BC.P6); le16(0x9A, BC.P7); le16(0x9C, BC.P8); le16(0x9E, BC.P9);
      r[0xA1] = BC.H1; le16(0xE1, BC.H2); r[0xE3] = BC.H3; r[0xE4] = BC.H4 >> 4; r[0xE5] = (BC.H4 & 15) | ((BC.H5 & 15) << 4); r[0xE6] = BC.H5 >> 4; r[0xE7] = BC.H6;
    }
    onWrite(reg, b) { if (reg === 0xE0 && b === 0xB6) this.r[0xF3] = 0; }
    latch() {
      const e = this.env(); const adcT = solve(bmeTfine, e.temp * 5120, 0, 1048575, true), tf = bmeTfine(adcT);
      const adcP = solve((x) => bmeP(x, tf), e.press * 100, 0, 1048575, false), adcH = solve((x) => bmeH(x, tf), e.hum, 0, 65535, true);
      const r = this.r; r[0xF7] = adcP >> 12; r[0xF8] = (adcP >> 4) & 255; r[0xF9] = (adcP & 15) << 4; r[0xFA] = adcT >> 12; r[0xFB] = (adcT >> 4) & 255; r[0xFC] = (adcT & 15) << 4; r[0xFD] = adcH >> 8; r[0xFE] = adcH & 255;
    }
    read() { if (this.ptr === 0xF3) { this.ptr++; return 0; } return super.read(); }
  }
  // ---------------- MPU6050 ----------------
  class MPU6050 extends RegDev {
    constructor(env) { super(); this.env = env; this.dataStart = 0x3B; this.dataLen = 14; this.r[0x75] = 0x68; this.r[0x6B] = 0x40; }
    onWrite(reg, b) { if (reg === 0x6B && (b & 0x80)) { this.r.fill(0, 0x0D, 0x75); this.r[0x6B] = 0x40; } }
    latch() {
      const e = this.env(), r = this.r, afs = (r[0x1C] >> 3) & 3, gfs = (r[0x1B] >> 3) & 3;
      const s16 = (o, v) => { v = Math.max(-32768, Math.min(32767, Math.round(v))); r[o] = (v >> 8) & 255; r[o + 1] = v & 255; };
      const al = 16384 / (1 << afs), gl = 131 / (1 << gfs);
      s16(0x3B, e.ax * al); s16(0x3D, e.ay * al); s16(0x3F, e.az * al); s16(0x41, (e.temp - 36.53) * 340); s16(0x43, e.gx * gl); s16(0x45, e.gy * gl); s16(0x47, e.gz * gl);
    }
  }
  const api = { LCD1602, SSD1306, BME280, MPU6050, bmeTfine, bmeP, bmeH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.I2CDev = api;
})(typeof window !== 'undefined' ? window : globalThis);
