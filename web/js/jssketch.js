/* "JS sketch" mode: an Arduino-flavoured JavaScript sketch runs in the browser against the circuit solver in
 * virtual time. Used when the QEMU backend isn't available and for things the emulator bridge doesn't model yet
 * (analogRead / analogWrite / ledcWrite). This is NOT Xtensa emulation — the UI says so.
 * Write plain functions (setup/loop/your own); `delay()` and calls to your own functions are awaited automatically. */
(function (root) {
  function transform(src) {
    const names = new Set(); src.replace(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, (m, n) => { names.add(n); return m; });
    let out = src.replace(/(^|[^.\w$])function\s+([A-Za-z_$][\w$]*)\s*\(/g, '$1async function $2(');
    const callRe = new RegExp('(^|[^.\\w$])(' + ['delay', 'delayMicroseconds', 'yield_', ...names].join('|') + ')\\s*\\(', 'g');
    out = out.replace(callRe, (m, pre, n, off, str) => {
      const before = str.slice(Math.max(0, off - 20), off + pre.length);
      if (/function\s*$/.test(before) || /await\s*$/.test(before)) return m;
      return pre + 'await ' + n + '(';
    });
    return out;
  }
  class JsSketch {
    constructor(src, env) {   // env: {sim, espPart, serial(text), onError}
      this.env = env; this.now = 0; this.timers = []; this.blocked = false; this.running = false; this.src = src; this.ledc = {};
    }
    api() {
      const S = this, sim = this.env.sim, esp = this.env.espPart, rt = sim.espRuntime(esp);
      const read = (g) => { sim.settle(); return rt.pinInput[g] ? 1 : 0; };
      const fmtf = (f, ...a) => { let i = 0; return String(f).replace(/%(-?\d*)(?:\.(\d+))?([dfsuxXc%])/g, (m, w, p, c) => { if (c === '%') return '%'; const v = a[i++]; let s = c === 'f' ? Number(v).toFixed(p === undefined ? 6 : +p) : c === 'x' ? (v >>> 0).toString(16) : c === 'X' ? (v >>> 0).toString(16).toUpperCase() : c === 'c' ? String.fromCharCode(v) : (c === 'd' || c === 'u') ? String(Math.trunc(v)) : String(v); if (w) s = +w < 0 ? s.padEnd(-w) : s.padStart(+w); return s; }); };
      const Serial = { begin() {}, print: (x, b) => S.env.serial(b === 16 ? (x >>> 0).toString(16).toUpperCase() : typeof x === 'number' && b === undefined && !Number.isInteger(x) ? x.toFixed(2) : String(x)), println: (x = '', b) => { Serial.print(x, b); S.env.serial('\r\n'); }, printf: (f, ...a) => S.env.serial(fmtf(f, ...a)), available: () => 0, read: () => -1 };
      return {
        HIGH: 1, LOW: 0, INPUT: 'INPUT', OUTPUT: 'OUTPUT', INPUT_PULLUP: 'INPUT_PULLUP', INPUT_PULLDOWN: 'INPUT_PULLDOWN', LED_BUILTIN: 2,
        pinMode: (g, m) => rt.pinMode(g, m), digitalWrite: (g, v) => rt.write(g, v), digitalRead: read,
        analogRead: (g) => { sim.settle(); return sim.analogRead(esp, g); }, analogReadMilliVolts: (g) => { sim.settle(); return sim.analogMilliVolts(esp, g); },
        analogWrite: (g, v) => rt.pwm(g, Math.max(0, Math.min(255, v)) / 255),
        ledcAttach: (g, f, res) => { S.ledc[g] = res || 8; return true; }, ledcWrite: (g, d) => rt.pwm(g, d / ((1 << (S.ledc[g] || 8)) - 1)),
        millis: () => Math.floor(S.now * 1000), micros: () => Math.floor(S.now * 1e6),
        delay: (ms) => S._sleep(ms / 1000), delayMicroseconds: (us) => S._sleep(us / 1e6), yield_: () => S._sleep(1e-5),
        map: (x, a, b, c, d) => Math.trunc((x - a) * (d - c) / (b - a) + c), constrain: (x, a, b) => Math.min(b, Math.max(a, x)), random: (a, b) => b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a)),
        Serial, console,
      };
    }
    _sleep(dt) { return new Promise((res) => { this.timers.push({ t: this.now + Math.max(dt, 1e-6), res }); this.timers.sort((a, b) => a.t - b.t); this.blocked = true; }); }
    async start() {
      const api = this.api(), names = Object.keys(api);
      const code = transform(this.src) + '\n;return { setup: typeof setup==="function"?setup:null, loop: typeof loop==="function"?loop:null };';
      let mod;
      try { mod = new Function(...names, code)(...names.map((n) => api[n])); } catch (e) { this.env.onError && this.env.onError(e); throw e; }
      this.running = true;
      const main = async () => {
        try {
          if (mod.setup) await mod.setup();
          let n = 0;
          while (this.running) { if (mod.loop) await mod.loop(); if (++n % 1 === 0) await api.yield_(); }
        } catch (e) { this.running = false; this.env.onError && this.env.onError(e); }
      };
      this.blocked = false; main(); await this._drain();
    }
    async _drain() { for (let k = 0; k < 10000 && !this.blocked; k++) await 0; }
    // advance virtual time to `target` seconds, stepping the circuit between timer events
    async runUntil(target, stepCircuit) {
      let guard = 0;
      while (this.running && this.timers.length && this.timers[0].t <= target && guard++ < 20000) {
        const tm = this.timers.shift();
        if (tm.t > this.now) { stepCircuit(tm.t - this.now); this.now = tm.t; }
        this.blocked = false; tm.res(); await this._drain();
      }
      if (target > this.now) { stepCircuit(target - this.now); this.now = target; }
    }
    stop() { this.running = false; this.timers = []; }
  }
  const api = { JsSketch, transform };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JsSketchMod = api;
})(typeof window !== 'undefined' ? window : globalThis);
