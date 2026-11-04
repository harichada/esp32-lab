/* Virtual SPI parts driven byte-by-byte from the emulated ESP32 SPI2/SPI3 controllers (QEMU bridge).
 * xfer(mosiByte, ctx) -> misoByte. ctx.dc = level of the part's D/C pin. deselect() when its CS goes high. Pure JS (Node-testable). */
(function (root) {
  'use strict';
  // ---------------- ILI9341 240x320 TFT (RGB565, MADCTL rotations) ----------------
  class ILI9341 {
    constructor(w = 240, h = 320) { this.W = w; this.H = h; this.fb = new Uint8ClampedArray(w * h * 4); this.reset(); for (let i = 3; i < this.fb.length; i += 4) this.fb[i] = 255; this.version = 0; this.bytes = 0; }
    reset() { this.cmd = 0; this.args = []; this.xs = 0; this.xe = this.W - 1; this.ys = 0; this.ye = this.H - 1; this.mad = 0; this.on = false; this.sleep = true; this.inv = false; this.hi = -1; this.cx = 0; this.cy = 0; }
    deselect() { this.hi = -1; }
    xfer(b, ctx) {
      this.bytes++;
      if (!ctx.dc) {   // command
        this.cmd = b; this.args = []; this.hi = -1;
        switch (b) {
          case 0x01: this.reset(); break;
          case 0x11: this.sleep = false; break;
          case 0x10: this.sleep = true; break;
          case 0x29: this.on = true; this.version++; break;
          case 0x28: this.on = false; this.version++; break;
          case 0x20: this.inv = false; this.version++; break;
          case 0x21: this.inv = true; this.version++; break;
          case 0x2C: this.cx = this.xs; this.cy = this.ys; break;
          default: break;
        }
        return 0xff;
      }
      const a = this.args;
      switch (this.cmd) {
        case 0x2A: a.push(b); if (a.length === 4) { this.xs = a[0] << 8 | a[1]; this.xe = a[2] << 8 | a[3]; } break;
        case 0x2B: a.push(b); if (a.length === 4) { this.ys = a[0] << 8 | a[1]; this.ye = a[2] << 8 | a[3]; } break;
        case 0x36: this.mad = b; break;
        case 0x2C: case 0x3C:
          if (this.hi < 0) { this.hi = b; break; }
          this.pixel((this.hi << 8) | b); this.hi = -1; break;
        default: a.push(b);
      }
      return 0xff;
    }
    pixel(c) {
      const W = this.W, H = this.H, m = this.mad; let x = this.cx, y = this.cy;
      if (m & 0x20) { const t = x; x = y; y = t; }
      if (!(m & 0x40)) x = W - 1 - x;
      if (m & 0x80) y = H - 1 - y;
      if (x >= 0 && y >= 0 && x < W && y < H) {
        let r = (c >> 11) & 31, g = (c >> 5) & 63, bl = c & 31; if (!(m & 0x08)) { const t = r; r = bl; bl = t; }   // the glass is BGR: MADCTL.BGR=1 shows true colours
        const o = (y * W + x) * 4; this.fb[o] = r << 3 | r >> 2; this.fb[o + 1] = g << 2 | g >> 4; this.fb[o + 2] = bl << 3 | bl >> 2; this.version++;
      }
      if (++this.cx > this.xe) { this.cx = this.xs; if (++this.cy > this.ye) this.cy = this.ys; }
    }
    rgb(x, y) { const o = (y * this.W + x) * 4; return [this.fb[o], this.fb[o + 1], this.fb[o + 2]]; }
  }
  // ---------------- MCP3008 8-ch 10-bit ADC (bit-level protocol, any byte alignment) ----------------
  class MCP3008 {
    constructor(volts) { this.volts = volts; this.deselect(); this.conv = 0; }
    deselect() { this.st = 0; this.n = 0; this.cfg = 0; this.val = 0; this.outBit = 0; }
    bit(i) {   // one SCK cycle: sample DIN, return DOUT
      let o = 1;
      if (this.st === 0) { if (i) { this.st = 1; this.n = 0; this.cfg = 0; } }
      else if (this.st === 1) { this.cfg = this.cfg << 1 | i; if (++this.n === 4) { this.st = 2; } }
      else if (this.st === 2) {   // sample clock (DOUT hi-Z), conversion latched
        const v = this.volts(), ch = this.cfg & 7, sgl = this.cfg >> 3 & 1;
        const d = sgl ? v.ch[ch] : (ch & 1 ? v.ch[ch] - v.ch[ch - 1] : v.ch[ch] - v.ch[ch + 1]);
        this.val = Math.max(0, Math.min(1023, Math.floor(d / v.vref * 1024))); this.conv++; this.st = 6;
      } else if (this.st === 6) { o = 0; this.st = 3; this.n = 0;   // null bit
      } else if (this.st === 3) { o = this.val >> (9 - this.n) & 1; if (++this.n === 10) { this.st = 4; this.n = 0; } }
      else if (this.st === 4) { o = this.val >> this.n & 1; if (++this.n === 10) this.st = 5; }   // LSB-first tail
      else o = 0;
      return o;
    }
    xfer(b) { let r = 0; for (let k = 7; k >= 0; k--) r = r << 1 | this.bit(b >> k & 1); return r; }
  }
  // ---------------- SD card (SPI mode, SDHC, sparse FAT16 image) ----------------
  function crc16(d, o, n) { let c = 0; for (let i = 0; i < n; i++) { c ^= d[o + i] << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1 ^ 0x1021) & 0xffff : c << 1 & 0xffff; } return c; }
  function fat16Image(files, sectors = 131072) {
    const S = new Map(), sec = (n) => { let s = S.get(n); if (!s) S.set(n, s = new Uint8Array(512)); return s; };
    const spc = 4, rsv = 1, nf = 2, rootEnt = 512, spf = 129, fat1 = rsv, root = rsv + nf * spf, data = root + rootEnt * 32 / 512;
    const b = sec(0), w16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = v >> 8 & 255; }, w32 = (a, o, v) => { w16(a, o, v & 0xffff); w16(a, o + 2, v >>> 16); }, str = (a, o, s) => { for (let i = 0; i < s.length; i++) a[o + i] = s.charCodeAt(i); };
    b.set([0xEB, 0x3C, 0x90]); str(b, 3, 'MSDOS5.0'); w16(b, 11, 512); b[13] = spc; w16(b, 14, rsv); b[16] = nf; w16(b, 17, rootEnt); w16(b, 19, 0); b[21] = 0xF8; w16(b, 22, spf); w16(b, 24, 63); w16(b, 26, 255); w32(b, 28, 0); w32(b, 32, sectors);
    b[36] = 0x80; b[38] = 0x29; w32(b, 39, 0x51A0C0DE); str(b, 43, 'ESP32SIM   '); str(b, 54, 'FAT16   '); b[510] = 0x55; b[511] = 0xAA;
    const setFat = (cl, v) => { for (let f = 0; f < nf; f++) { const o = cl * 2, s = sec(fat1 + f * spf + (o >> 9)); w16(s, o & 511, v); } };
    setFat(0, 0xFFF8); setFat(1, 0xFFFF);
    let ent = 0, cl = 2; const rs = (i) => sec(root + (i * 32 >> 9)), ro = (i) => i * 32 & 511;
    { const s = rs(ent), o = ro(ent++); str(s, o, 'ESP32SIM   '); s[o + 11] = 0x08; }
    for (const [name, text] of files) {
      const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text, ncl = Math.max(1, Math.ceil(bytes.length / (spc * 512)));
      const [bn, ext] = name.toUpperCase().split('.'); const s = rs(ent), o = ro(ent++);
      str(s, o, (bn + '        ').slice(0, 8) + ((ext || '') + '   ').slice(0, 3)); s[o + 11] = 0x20; w16(s, o + 22, 0x6000); w16(s, o + 24, 0x5D62); w16(s, o + 26, cl); w32(s, o + 28, bytes.length);
      for (let i = 0; i < ncl; i++) { setFat(cl + i, i === ncl - 1 ? 0xFFFF : cl + i + 1); }
      for (let i = 0; i < bytes.length; i += 512) sec(data + (cl - 2) * spc + (i >> 9)).set(bytes.subarray(i, i + 512));
      cl += ncl;
    }
    return { S, sectors };
  }
  class SDCard {
    constructor(img) { this.img = img || fat16Image([['HELLO.TXT', 'Hello from the virtual SD card!\r\n']]); this.idle = true; this.acmd = false; this.deselect(); this.reads = 0; this.writes = 0; this.log = []; }
    deselect() { this.q = []; this.mode = 'cmd'; this.pk = []; }
    block(n) { return this.img.S.get(n) || new Uint8Array(512); }
    queueBlock(n) { const d = this.block(n), c = crc16(d, 0, 512); this.q.push(0xff, 0xfe, ...d, c >> 8, c & 255); this.reads++; }
    r1() { return this.idle ? 1 : 0; }
    command(c, arg) {
      const q = this.q, ac = this.acmd; this.acmd = false; q.push(0xff);
      if (this.log.length < 400) this.log.push((ac ? 'A' : '') + c);
      if (ac && c === 41) { this.idle = false; q.push(0); return; }
      if (ac && (c === 42 || c === 23 || c === 22)) { q.push(this.r1()); if (c === 22) { q.push(0xff, 0xfe, 0, 0, 0, 0, 0xff, 0xff); } return; }
      switch (c) {
        case 0: this.idle = true; q.push(1); break;
        case 8: q.push(this.r1(), 0, 0, 1, arg & 0xff); break;
        case 9: case 10: {
          const r = new Uint8Array(16);
          if (c === 9) { r.set([0x40, 0x0E, 0x00, 0x32, 0x5B, 0x59, 0x00, 0x00]); const cs = this.img.sectors / 1024 - 1; r[7] = cs >> 16 & 63; r[8] = cs >> 8 & 255; r[9] = cs & 255; r[10] = 0x7F; r[11] = 0x80; r[12] = 0x0A; r[13] = 0x40; r[14] = 0x00; r[15] = 0x01; }
          else { r.set([0x03, 0x53, 0x44, 0x53, 0x49, 0x4D, 0x53, 0x44, 0x10, 0x12, 0x34, 0x56, 0x78, 0x01, 0x6A, 0x01]); }
          const k = crc16(r, 0, 16); q.push(0, 0xff, 0xfe, ...r, k >> 8, k & 255); break;
        }
        case 12: this.mode = 'cmd'; this.q = [0xff, 0]; break;
        case 13: q.push(0, 0); break;
        case 16: case 59: q.push(this.r1()); break;
        case 17: q.push(0); this.queueBlock(arg); break;
        case 18: q.push(0); this.mode = 'rmulti'; this.next = arg; this.queueBlock(this.next++); break;
        case 24: q.push(0); this.mode = 'wwait'; this.wmulti = false; this.wblk = arg; break;
        case 25: q.push(0); this.mode = 'wwait'; this.wmulti = true; this.wblk = arg; break;
        case 55: this.acmd = true; q.push(this.r1()); break;
        case 58: { const ocr = this.idle ? 0x00FF8000 : 0xC0FF8000; q.push(this.r1(), ocr >>> 24, ocr >> 16 & 255, ocr >> 8 & 255, ocr & 255); break; }
        default: q.push(this.r1() | 4);
      }
    }
    xfer(b) {
      const out = this.q.length ? this.q.shift() : 0xff;
      if (this.mode === 'wwait') {
        if (b === 0xfe || b === 0xfc) { this.mode = 'wdata'; this.wbuf = []; }
        else if (b === 0xfd && this.wmulti) { this.mode = 'cmd'; this.q.push(0xff); }
        return out;
      }
      if (this.mode === 'wdata') {
        this.wbuf.push(b);
        if (this.wbuf.length === 514) { this.img.S.set(this.wblk++, Uint8Array.from(this.wbuf.slice(0, 512))); this.writes++; this.q.push(0x05); this.mode = this.wmulti ? 'wwait' : 'cmd'; }
        return out;
      }
      if (this.pk.length || (b & 0xC0) === 0x40) {
        this.pk.push(b);
        if (this.pk.length === 6) { const p = this.pk; this.pk = []; if (this.mode === 'rmulti' && (p[0] & 63) !== 12) return out; this.command(p[0] & 63, (p[1] << 24 | p[2] << 16 | p[3] << 8 | p[4]) >>> 0); }
        return out;
      }
      if (this.mode === 'rmulti' && !this.q.length) this.queueBlock(this.next++);
      return out;
    }
    file(name) {   // read a root-directory file back out of the image (for the Inspector / tests)
      const root = 259, data = 291, N = name.toUpperCase().split('.'), key = (N[0] + '        ').slice(0, 8) + ((N[1] || '') + '   ').slice(0, 3);
      for (let i = 0; i < 512; i++) {
        const s = this.block(root + (i * 32 >> 9)), o = i * 32 & 511; if (!s[o]) break;
        if (String.fromCharCode(...s.subarray(o, o + 11)) !== key || s[o] === 0xE5) continue;
        let cl = s[o + 26] | s[o + 27] << 8, size = (s[o + 28] | s[o + 29] << 8 | s[o + 30] << 16 | s[o + 31] << 24) >>> 0; const out = [];
        while (cl >= 2 && cl < 0xFFF8 && out.length < size) {
          for (let k = 0; k < 4; k++) out.push(...this.block(data + (cl - 2) * 4 + k));
          const fs = this.block(1 + (cl * 2 >> 9)); cl = fs[cl * 2 & 511] | fs[(cl * 2 & 511) + 1] << 8;
        }
        return new TextDecoder().decode(Uint8Array.from(out.slice(0, size)));
      }
      return null;
    }
  }
  const api = { ILI9341, MCP3008, SDCard, fat16Image, crc16 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SPIDev = api;
})(typeof window !== 'undefined' ? window : globalThis);
