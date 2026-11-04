/* Netlist builder + simulation runtime: turns the editor project (parts + wires on a 0.1" grid) into an MNA
 * circuit, steps it, and exposes pin voltages / part readouts / ESP32 pin inputs. Pure JS (Node-testable). */
(function (root) {
  const P = root.Parts, S = root.Solver;

  // ---------------- ESP32 runtime pin state (shared by QEMU bridge and JS sketch mode) ----------------
  const IOMUX_OFF = { 36: 0x04, 37: 0x08, 38: 0x0c, 39: 0x10, 34: 0x14, 35: 0x18, 32: 0x1c, 33: 0x20, 25: 0x24, 26: 0x28, 27: 0x2c, 14: 0x30, 12: 0x34, 13: 0x38, 15: 0x3c, 2: 0x40, 0: 0x44, 4: 0x48, 16: 0x4c, 17: 0x50, 9: 0x54, 10: 0x58, 11: 0x5c, 6: 0x60, 7: 0x64, 8: 0x68, 5: 0x6c, 18: 0x70, 19: 0x74, 20: 0x78, 21: 0x7c, 22: 0x80, 3: 0x84, 1: 0x88, 23: 0x8c, 24: 0x90 };
  const IOMUX_GPIO = {}; for (const g in IOMUX_OFF) IOMUX_GPIO[IOMUX_OFF[g]] = +g;
  // RTC IO pad registers (offset, pull-up bit, pull-down bit) — measured against ESP-IDF 5 under QEMU
  const RTC_PULL = { 25: [0x84, 27, 28], 26: [0x88, 27, 28], 27: [0xb0, 27, 28], 32: [0x8c, 22, 23], 33: [0x8c, 27, 28], 13: [0xa4, 27, 28], 14: [0xac, 27, 28], 12: [0xa8, 27, 28], 15: [0xa0, 27, 28], 4: [0x94, 27, 28], 2: [0x9c, 27, 28], 0: [0x98, 27, 28] };
  const ADC_LSB_MV = 1100 * 196602 / 65536 / 4096;
  // ESP-IDF line-fitting calibration (esp_adc/esp32/adc_cali_line_fitting.c, eFuse Vref = 1100 mV, 12 dB atten), integer-exact.
  // A real ESP32's SAR response is non-linear above ~2.45 V; the IDF LUT undoes that. We model the chip as the exact
  // inverse of that calibration, so analogRead() gives the raw code a typical chip would and analogReadMilliVolts() is right.
  const IDF_LUT = { 1: [[2240, 2297, 2352, 2405, 2457, 2512, 2564, 2616, 2664, 2709, 2754, 2795, 2832, 2868, 2903, 2937, 2969, 3000, 3030, 3060], [2667, 2706, 2745, 2780, 2813, 2844, 2873, 2901, 2928, 2956, 2982, 3006, 3032, 3059, 3084, 3110, 3135, 3160, 3184, 3209]],
    2: [[2238, 2293, 2347, 2399, 2451, 2507, 2561, 2613, 2662, 2710, 2754, 2792, 2831, 2869, 2904, 2937, 2968, 2999, 3029, 3059], [2657, 2698, 2738, 2774, 2807, 2838, 2867, 2894, 2921, 2946, 2971, 2996, 3020, 3043, 3067, 3092, 3116, 3139, 3162, 3185]] };
  const IDF_SCALE = { 1: 196602, 2: 197170 }, IDF_OFF = { 1: 142, 2: 128 };
  function idfRawToMv(raw, unit = 1, vref = 1100) {
    const a = Math.floor(vref * IDF_SCALE[unit] / 4096), lin = Math.floor((a * raw + 32768) / 65536) + IDF_OFF[unit];
    if (raw < 2880) return lin;
    const [lo, hi] = IDF_LUT[unit], i = Math.floor((raw - 2880) / 64), x2 = 1200 - vref, x1 = vref - 1000, y2 = (i + 1) * 64 + 2880 - raw, y1 = raw - (i * 64 + 2880);
    let v = lo[i] * x2 * y2 + hi[i] * x1 * y2 + lo[i + 1] * x2 * y1 + hi[i + 1] * x1 * y1; v = Math.floor((v + 200 * 64 / 2) / (200 * 64));
    if (raw <= 2944) return Math.floor((lin * (64 - (raw - 2880)) + v * (raw - 2880) + 32) / 64);
    return v;
  }
  const IDF_TBL = {};
  function idfTable(unit) { if (!IDF_TBL[unit]) { const t = new Int32Array(4096); for (let r = 0; r < 4096; r++) t[r] = idfRawToMv(r, unit); IDF_TBL[unit] = t; } return IDF_TBL[unit]; }
  function mvToRaw(mv, unit = 1) {   // raw code whose calibrated voltage is closest to mv
    const t = idfTable(unit); if (mv <= t[0]) return 0; if (mv >= t[4095]) return 4095;
    let lo = 0, hi = 4095; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= mv) lo = m; else hi = m; }
    return mv - t[lo] <= t[hi] - mv ? lo : hi;
  }
  const SIG_GPIO = 256, SIG_RMT0 = 87, SIG_LEDC_HS0 = 71, SIG_LEDC_LS0 = 79;

  class EspRuntime {
    constructor() { this.reset(); }
    reset() {
      this.pins = []; for (let g = 0; g < 40; g++) this.pins.push({ out: false, level: 0, pu: false, pd: false, muxpu: false, muxpd: false, rtcpu: false, rtcpd: false, sig: SIG_GPIO });
      this.iomux = {}; this.rtc = {}; this.inBits = 0n; this.version = 0; this.pinLevel = {}; this.pinInput = new Array(40).fill(0);
    }
    pin(g) { return this.pins[g] || { out: false }; }
    _recalcPull(g) { const p = this.pins[g]; p.pu = p.muxpu || p.rtcpu; p.pd = p.muxpd || p.rtcpd; }
    // messages from QEMU bridge. returns true if circuit drive changed
    apply(m) {
      let ch = false;
      if (m.t === 'gpio') {
        const out = BigInt(m.out >>> 0) | (BigInt(m.out1 >>> 0) << 32n), en = BigInt(m.en >>> 0) | (BigInt(m.en1 >>> 0) << 32n);
        for (let g = 0; g < 40; g++) {
          const p = this.pins[g], o = !!((en >> BigInt(g)) & 1n), l = Number((out >> BigInt(g)) & 1n);
          if (p.out !== o || p.level !== l) { p.out = o; p.level = l; ch = true; }
        }
      } else if (m.t === 'mux') {
        const g = IOMUX_GPIO[m.off]; if (g === undefined) return false;
        const p = this.pins[g], pu = !!(m.v >> 8 & 1), pd = !!(m.v >> 7 & 1);
        if (p.muxpu !== pu || p.muxpd !== pd) { p.muxpu = pu; p.muxpd = pd; this._recalcPull(g); ch = true; }
      } else if (m.t === 'rtc') {
        for (const g in RTC_PULL) {
          const [off, ub, db] = RTC_PULL[g]; if (off !== m.off) continue;
          const p = this.pins[g], pu = !!(m.v >>> ub & 1), pd = !!(m.v >>> db & 1);
          if (p.rtcpu !== pu || p.rtcpd !== pd) { p.rtcpu = pu; p.rtcpd = pd; this._recalcPull(+g); ch = true; }
        }
      } else if (m.t === 'fsel') {
        if (this.pins[m.pin]) { this.pins[m.pin].sig = m.sig; ch = this._applyLedc(); }
      } else if (m.t === 'pwm') {
        this.ledc = this.ledc || {}; const f = m.res ? Math.min(1, m.duty / Math.pow(2, m.res)) : 0;
        const tc = m.div >>> 0, div = (tc >>> 5) & 0x3ffff, b25 = (tc >>> 25) & 1;   // timer conf: bit_num[4:0], div_num[22:5] (10.8), tick_sel bit25
        const clk = m.ch < 8 ? (b25 ? 80e6 : 1e6) : (b25 ? 1e6 : 80e6);
        this.ledc[m.ch] = { duty: f, freq: div && m.res ? clk / (div / 256) / Math.pow(2, m.res) : 0 };
        ch = this._applyLedc();
      } else if (m.t === 'reset') { this.reset(); ch = true; }
      if (ch) this.version++;
      return ch;
    }
    // LEDC channel -> pin (via GPIO matrix signal 71..86) -> average drive level
    _applyLedc() {
      let ch = false; const L = this.ledc || {};
      for (const p of this.pins) {
        const c = p.sig >= SIG_LEDC_HS0 && p.sig < SIG_LEDC_HS0 + 16 ? p.sig - SIG_LEDC_HS0 : -1;
        const d = c >= 0 && L[c] ? L[c].duty : undefined;
        if (p.qpwm !== d) { p.qpwm = d; p.pwm = d; p.pwmFreq = d !== undefined ? L[c].freq : undefined; ch = true; }
      }
      return ch;
    }
    // JS-sketch mode setters
    pinMode(g, mode) {
      const p = this.pins[g]; if (!p) return;
      p.out = mode === 'OUTPUT' || mode === 1 || mode === 3; p.muxpu = mode === 'INPUT_PULLUP' || mode === 5 || mode === 4; p.muxpd = mode === 'INPUT_PULLDOWN' || mode === 9 || mode === 8; p.rtcpu = p.rtcpd = false; p.pwm = undefined;
      this._recalcPull(g); this.version++;
    }
    write(g, v) { const p = this.pins[g]; if (!p) return; const l = v ? 1 : 0; if (p.level !== l || p.pwm !== undefined) { p.level = l; p.pwm = undefined; this.version++; } }
    pwm(g, duty) { const p = this.pins[g]; if (!p) return; p.out = true; if (p.pwm !== duty) { p.pwm = duty; this.version++; } }
    rmtPin(ch) { for (let g = 0; g < 40; g++) if (this.pins[g].sig === SIG_RMT0 + ch) return g; return -1; }
  }

  // ---------------- union-find ----------------
  class UF { constructor() { this.p = new Map(); } find(a) { let p = this.p.get(a); if (p === undefined) { this.p.set(a, a); return a; } if (p === a) return a; const r = this.find(p); this.p.set(a, r); return r; } union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); } }
  const key = (x, y) => Math.round(x) + ',' + Math.round(y);
  const GROUND_PINS = { ground: [['GND', 4]], esp32: [['GND.1', 3], ['GND.2', 3]], vcc33: [['GND', 2]], vcc5: [['GND', 2]], battery: [['-', 1]] };
  const EXTRA_GROUPS = { esp32: [['GND.1', 'GND.2']] };

  class Sim {
    constructor(project) {
      this.project = project; this.state = {}; this.esp = new Map(); this.t = 0; this.log = []; this.warnings = []; this.probes = {}; this.scope = { 1: [], 2: [], 3: [], 4: [] }; this.h = 5e-4;
      this.dirty = true; this.topoDirty = true; this._capV = new Map();
    }
    espRuntime(p) { let r = this.esp.get(p.id); if (!r) { r = new EspRuntime(); this.esp.set(p.id, r); } return r; }
    partState(p) { let s = this.state[p.id]; if (!s) s = this.state[p.id] = {}; return s; }
    // ---------- topology ----------
    topology() {
      const uf = new UF(), pinKey = new Map(), proj = this.project;
      for (const p of proj.parts) {
        const d = P.T[p.type]; if (!d) continue;
        for (const pin of d.pins(p)) { const w = P.pinWorld(p, pin), k = key(w.x, w.y); pinKey.set(p.id + ':' + pin.name, k); uf.find(k); }
        const groups = [...(d.groups ? d.groups(p) : []), ...(EXTRA_GROUPS[p.type] || [])];
        for (const g of groups) for (let i = 1; i < g.length; i++) uf.union(pinKey.get(p.id + ':' + g[0]), pinKey.get(p.id + ':' + g[i]));
      }
      for (const w of proj.wires) { const a = key(w.a.x, w.a.y), b = key(w.b.x, w.b.y); uf.union(a, b); }
      // every Ground symbol is the global GND: tie them to each other and to the ESP32 GND pins
      const gk = [];
      for (const p of proj.parts) { if (p.type === 'ground') gk.push(pinKey.get(p.id + ':GND')); if (p.type === 'esp32') gk.push(pinKey.get(p.id + ':GND.1')); }
      for (let i = 1; i < gk.length; i++) uf.union(gk[0], gk[i]);
      // ground selection
      let gbest = null, gprio = -1;
      for (const p of proj.parts) for (const [pn, pr] of (GROUND_PINS[p.type] || [])) { const k = pinKey.get(p.id + ':' + pn); if (k && pr > gprio) { gprio = pr; gbest = uf.find(k); } }
      const netId = new Map(); let n = 1;
      if (gbest) netId.set(gbest, 0);
      const pinNet = new Map();
      // only nets touched by a non-breadboard pin or a wire become nodes (keeps matrix small)
      const used = new Set();
      for (const p of proj.parts) { if (p.type === 'breadboard') continue; const d = P.T[p.type]; if (!d) continue; for (const pin of d.pins(p)) used.add(uf.find(pinKey.get(p.id + ':' + pin.name))); }
      for (const w of proj.wires) { used.add(uf.find(key(w.a.x, w.a.y))); used.add(uf.find(key(w.b.x, w.b.y))); }
      for (const r of used) if (!netId.has(r)) netId.set(r, n++);
      for (const [pk, k] of pinKey) { const r = uf.find(k); pinNet.set(pk, netId.has(r) ? netId.get(r) : -1); }
      this.uf = uf; this.netId = netId; this.pinNet = pinNet; this.nNodes = n; this.topoDirty = false; this.dirty = true;
      this.pinKey = pinKey;
    }
    netAt(x, y) { if (this.topoDirty) this.topology(); const r = this.uf.find(key(x, y)); return this.netId.has(r) ? this.netId.get(r) : -1; }
    // ---------- build circuit ----------
    build() {
      if (this.topoDirty) this.topology();
      const C = new S.Circuit(this.nNodes); const owner = new Map(); const mains = new Map(); this.probes = {};
      const self = this;
      const cx = {
        node: (p, name) => { const n = self.pinNet.get(p.id + ':' + name); return n === undefined || n < 0 ? 0 : n; },
        add: (e, p) => { C.add(e); owner.set(e, p.id); if (e.main) mains.set(p.id, e); if (e.kind === 'C') { const k = p.id + ':' + (e.idx = (e.idx || 0)); e._key = p.id; e.vprev = self._capV.get(p.id) || 0; } return e; },
        join() {}, markGround() {},
        esp: (p) => self.espRuntime(p), state: (p) => self.partState(p),
        probe: (p, node) => { self.probes[p.props.ch || 1] = node; },
      };
      for (const p of this.project.parts) { const d = P.T[p.type]; if (d && d.stamp) d.stamp(p, cx); }
      if (this.circuit && this.circuit.n === C.n && this.circuit.x) { C._index(); if (this.circuit.x.length === C.size) C.x = this.circuit.x.slice(); }
      C.t = this.t;
      this.circuit = C; this.owner = owner; this.mains = mains; this.dirty = false;
      this._espVersions = [...this.esp.values()].map((r) => r.version).join(',');
    }
    needsRebuild() { if (this.dirty || this.topoDirty) return true; const v = [...this.esp.values()].map((r) => r.version).join(','); return v !== this._espVersions; }
    hasDynamics() { return this.project.parts.some((p) => p.type === 'capacitor' || p.type === 'scope'); }
    // advance simulated time by dt seconds (transient), measuring parts afterwards
    advance(dt, maxSteps = 400) {
      if (this.needsRebuild()) this.build();
      const C = this.circuit;
      if (!this.hasDynamics()) { C.solve(1, false); C._h = dt; this.t += dt; this._after(dt); return; }
      let h = this.h, steps = Math.min(maxSteps, Math.max(1, Math.ceil(dt / h))); h = dt / steps;
      for (let i = 0; i < steps; i++) {
        if (this.needsRebuild()) this.build();
        const c = this.circuit; c._h = h; c.step(h); this.t += h;
        for (const e of c.el) if (e.kind === 'C') this._capV.set(e._key, e.vprev);
        this._sample();
      }
      this._after(dt);
    }
    // quasi-static re-solve used for lock-step GPIO replies (capacitors hold their voltage)
    settle() {
      if (this.needsRebuild()) this.build();
      const C = this.circuit; C._h = 1e-6;
      if (this.hasDynamics()) C.solve(1e-6, false); else C.solve(1, false);
      this._after(0, true);
    }
    _sample() {
      for (const ch in this.probes) { const a = this.scope[ch]; a.push([this.t, this.circuit.v(this.probes[ch])]); if (a.length > 20000) a.splice(0, a.length - 16000); }
    }
    _after(dt, quiet) {
      const C = this.circuit, self = this;
      const cx = {
        main: (p) => self.mains.get(p.id), V: (n) => C.v(n), I: (e) => C.current(e), state: (p) => self.partState(p), log: (m) => self.log.push(m), pinV: (p, n) => self.pinVoltage(p, n), esp: (p) => self.espRuntime(p),
      };
      this.cx = cx;
      if (!quiet) {
        let burned = false;
        for (const p of this.project.parts) { const d = P.T[p.type]; if (d && d.measure) { const was = self.partState(p).burned; d.measure(p, cx, dt); if (!was && self.partState(p).burned) burned = true; } }
        if (burned) this.dirty = true;
        if (!this.hasDynamics()) this._sample();
        this.warnings = [];
        for (const p of this.project.parts) { const d = P.T[p.type]; if (d && d.warn) { const w = d.warn(p, cx); if (w) this.warnings.push({ id: p.id, msg: w }); } }
        if (!C.converged) this.warnings.push({ id: null, msg: `solver did not converge (${C.iters} it)` });
      }
      // ESP32 input levels with hysteresis
      for (const p of this.project.parts) if (p.type === 'esp32') {
        const rt = this.espRuntime(p);
        for (const name of [...P.ESP_TOP, ...P.ESP_BOT]) {
          const g = P.espGpio(name); if (g < 0) continue;
          const n = this.pinNet.get(p.id + ':' + name), v = n > 0 ? C.v(n) : 0;
          const prev = rt.pinInput[g];
          rt.pinInput[g] = v > 2.0 ? 1 : v < 1.3 ? 0 : prev;
          rt.pinLevel[g] = rt.pins[g].out ? rt.pins[g].level : 0;
          rt.pinV = rt.pinV || []; rt.pinV[g] = v;
        }
        this.partState(p).pinLevel = rt.pinLevel;
      }
    }
    inputBits(p) { const rt = this.espRuntime(p); let lo = 0, hi = 0; for (let g = 0; g < 40; g++) if (rt.pinInput[g]) { if (g < 32) lo |= (1 << g); else hi |= (1 << (g - 32)); } return { in: lo >>> 0, in1: hi }; }
    pinVoltage(p, name) { const n = this.pinNet.get(p.id + ':' + name); return n > 0 && this.circuit ? this.circuit.v(n) : 0; }
    nodeVoltage(n) { return n > 0 && this.circuit ? this.circuit.v(n) : 0; }
    readout(p) { const d = P.T[p.type]; return d && d.readout && this.cx ? d.readout(p, this.cx) : ''; }
    // 12-bit SAR ADC at 11/12 dB attenuation, modelled as the inverse of ESP-IDF's eFuse-Vref line fit
    // (Vref 1100 mV: 0.8057 mV/LSB + 142 mV offset), so analogReadMilliVolts() in firmware returns the node voltage.
    analogRead(p, g) { const v = this.pinVoltageGpio(p, g); return mvToRaw(v * 1000, g >= 32 ? 1 : 2); }
    analogMilliVolts(p, g) { const raw = this.analogRead(p, g); return raw <= 0 ? 0 : idfRawToMv(raw, g >= 32 ? 1 : 2); }
    pinVoltageGpio(p, g) { const rt = this.espRuntime(p); return (rt.pinV && rt.pinV[g]) || 0; }
    resetState() { this.state = {}; this._capV = new Map(); this.t = 0; this.scope = { 1: [], 2: [], 3: [], 4: [] }; for (const r of this.esp.values()) r.reset(); this.dirty = true; }
  }

  const api = { Sim, EspRuntime, IOMUX_OFF, RTC_PULL, SIG_RMT0, idfRawToMv, mvToRaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SimCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
