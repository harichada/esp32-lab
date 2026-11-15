/* "JS sketch" mode: an Arduino-flavoured JavaScript sketch runs in the browser against the circuit solver in
 * virtual time. Used when the QEMU backend isn't available and for things the emulator bridge doesn't model yet
 * (analogRead / analogWrite / ledcWrite). This is NOT Xtensa emulation — the UI says so.
 * Write plain functions (setup/loop/your own); `delay()` and calls to your own functions are awaited automatically.
 *
 * JSSKETCH_WORKER (default off): ?jssketchworker=1 or data-jssketch-worker="1" (set by the server when
 * JSSKETCH_WORKER=1) runs the sketch in a Worker. The page does not call eval or the Function constructor.
 * The worker has no DOM. Messages are checked against web/js/jssketch-proto.js. */
(function (root) {
  const WORKER_AWAIT = [
    'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogReadMilliVolts',
    'analogWrite', 'ledcAttach', 'ledcWrite', 'millis', 'micros',
  ];
  function transform(src, extra) {
    const names = new Set(extra || []); src.replace(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, (m, n) => { names.add(n); return m; });
    let out = src.replace(/(^|[^.\w$])function\s+([A-Za-z_$][\w$]*)\s*\(/g, '$1async function $2(');
    const callRe = new RegExp('(^|[^\\.\\w$])(' + ['delay', 'delayMicroseconds', 'yield_', ...names].join('|') + ')\\s*\\(', 'g');
    out = out.replace(callRe, (m, pre, n, off, str) => {
      const before = str.slice(Math.max(0, off - 20), off + pre.length);
      if (/function\s*$/.test(before) || /await\s*$/.test(before)) return m;
      return pre + 'await ' + n + '(';
    });
    return out;
  }
  function workerFlag(env) {
    if (env && env.worker === true) return true;
    if (env && env.worker === false) return false;
    try {
      if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('jssketchworker') === '1') return true;
    } catch (e) { /* no location */ }
    try {
      const el = typeof document !== 'undefined' && document.documentElement;
      if (el && el.dataset && el.dataset.jssketchWorker === '1') return true;
    } catch (e) { /* no document */ }
    return false;
  }
  function proto() {
    if (root.JsSketchProto) return root.JsSketchProto;
    if (typeof require === 'function') {
      try { return require('./jssketch-proto.js'); } catch (e) { return null; }
    }
    return null;
  }
  let protoPromise = null;
  // The worker blob contains the schema. The page must load the same file as a
  // script so it can reject a bad message. Fetching the text and eval'ing it
  // would need unsafe-eval, which this path does not have.
  function ensureProto() {
    const have = proto();
    if (have) return Promise.resolve(have);
    if (protoPromise) return protoPromise;
    protoPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/jssketch-proto.js?v=93';
      s.onload = () => { const p = proto(); if (p) resolve(p); else reject(new Error('schema')); };
      s.onerror = () => reject(new Error('schema'));
      document.head.appendChild(s);
    });
    return protoPromise;
  }
  let harnessCache = null;
  function readLocal(name) {
    if (typeof require !== 'function') return null;
    try {
      const fs = require('fs');
      const path = require('path');
      return fs.readFileSync(path.join(__dirname, name), 'utf8');
    } catch (e) { return null; }
  }
  async function harnessText() {
    if (harnessCache) return harnessCache;
    const a = readLocal('jssketch-proto.js');
    const b = readLocal('jssketch-worker.js');
    if (a && b) { harnessCache = a + '\n' + b; return harnessCache; }
    const [pa, pb] = await Promise.all([
      fetch('js/jssketch-proto.js?v=93').then((r) => r.text()),
      fetch('js/jssketch-worker.js?v=94').then((r) => r.text()),
    ]);
    harnessCache = pa + '\n' + pb;
    return harnessCache;
  }
  function spawnWorker(source) {
    if (typeof Worker !== 'undefined' && typeof document !== 'undefined') {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const w = new Worker(url);
      return {
        post(msg) { w.postMessage(msg); },
        terminate() { w.terminate(); try { URL.revokeObjectURL(url); } catch (e) { /* gone */ } },
        listen(fn) { w.onmessage = (ev) => fn(ev.data); },
        fail(fn) { w.onerror = (ev) => fn(ev && (ev.message || ev)); },
      };
    }
    const { Worker: NodeWorker } = require('node:worker_threads');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const file = path.join(os.tmpdir(), 'esp32lab-jssketch-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.js');
    fs.writeFileSync(file, source);
    const w = new NodeWorker(file);
    return {
      post(msg) { w.postMessage(msg); },
      terminate() { w.terminate(); try { fs.unlinkSync(file); } catch (e) { /* gone */ } },
      listen(fn) { w.on('message', fn); },
      fail(fn) { w.on('error', (err) => fn(err && err.message)); },
    };
  }
  class JsSketch {
    constructor(src, env) {   // env: {sim, espPart, serial(text), onError, worker?}
      this.env = env || {}; this.now = 0; this.timers = []; this.blocked = false; this.running = false; this.src = src; this.ledc = {};
      this.useWorker = workerFlag(this.env); this.usedEval = false; this._worker = null; this._waiters = []; this._failed = false; this._failError = null; this._timer = null;
      this._timeoutMs = (this.env.workerTimeout > 0) ? this.env.workerTimeout : 1500;
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
    _arm() {
      this._disarm();
      this._timer = setTimeout(() => this._fail((proto() || {}).RUNAWAY || 'The sketch was stopped because it ran too long without a pause.'), this._timeoutMs);
    }
    _disarm() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
    _wake() { const ws = this._waiters; this._waiters = []; for (const w of ws) w(); }
    _waitBlocked() {
      if (this.blocked || !this.running || this._failed) return Promise.resolve();
      return new Promise((resolve) => { this._waiters.push(resolve); });
    }
    _fail(message) {
      if (this._failed) return;
      this._failed = true;
      const P = proto();
      const text = P ? P.plainError(message) : String(message || 'The sketch stopped.');
      this._failError = new Error(text);
      this.running = false; this.blocked = true; this._disarm();
      if (this.env.onError) this.env.onError(this._failError);
      if (this._worker) { try { this._worker.terminate(); } catch (e) { /* already gone */ } this._worker = null; }
      this._wake();
    }
    _dispatch(name, args) {
      const api = this._api;
      if (name.indexOf('Serial.') === 0) return api.Serial[name.slice(7)](...args);
      return api[name](...args);
    }
    _onWorker(data) {
      const P = proto();
      const msg = P ? P.validateWorkerMessage(data) : null;
      if (!msg) { this._fail((P && P.BAD) || 'The sketch sent something the page could not use, so it was stopped.'); return; }
      if (msg.type === 'call') {
        let value = null, ok = true, message = '';
        try { value = this._dispatch(msg.name, msg.args); if (value === undefined) value = null; }
        catch (e) { ok = false; message = P ? P.plainError(e) : 'The sketch stopped because a call failed.'; }
        if (this._worker) this._worker.post({ v: 1, type: 'result', id: msg.id, ok, value: ok ? value : null, message });
        return;
      }
      if (msg.type === 'sleep') {
        this._disarm();
        this.timers.push({ t: this.now + Math.max(msg.dt, 1e-6), res: () => { if (this._worker) { this._arm(); this._worker.post({ v: 1, type: 'resume', id: msg.id }); } } });
        this.timers.sort((a, b) => a.t - b.t);
        this.blocked = true;
        this._wake();
        return;
      }
      if (msg.type === 'error') { this._fail(msg.message); return; }
      if (msg.type === 'done') { this.running = false; this.blocked = true; this._disarm(); this._wake(); }
    }
    async _startWorker() {
      let P;
      try { P = await ensureProto(); }
      catch (e) { this._fail('The sketch could not start.'); throw this._failError; }
      const code = transform(this.src, WORKER_AWAIT);
      const src = (await harnessText()) + '\n' + code + '\n';
      this._api = this.api();
      this._worker = spawnWorker(src);
      this._worker.fail((message) => {
        const text = String(message || '');
        const syntax = P && P.SYNTAX || 'The sketch could not start because the code has a syntax error.';
        if (!text || /syntax|unexpected token|unexpected end/i.test(text)) this._fail(syntax);
        else this._fail(text);
      });
      this._worker.listen((data) => this._onWorker(data));
      this.running = true; this.blocked = false; this._arm();
      this._worker.post({ v: 1, type: 'go' });
      await this._waitBlocked();
      if (this._failed) throw this._failError;
    }
    async start() {
      if (this.useWorker) return this._startWorker();
      const api = this.api(), names = Object.keys(api);
      const code = transform(this.src) + '\n;return { setup: typeof setup==="function"?setup:null, loop: typeof loop==="function"?loop:null };';
      let mod;
      try { this.usedEval = true; mod = new Function(...names, code)(...names.map((n) => api[n])); } catch (e) { this.env.onError && this.env.onError(e); throw e; }
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
      if (this.useWorker) return this._runUntilWorker(target, stepCircuit);
      let guard = 0;
      while (this.running && this.timers.length && this.timers[0].t <= target && guard++ < 20000) {
        const tm = this.timers.shift();
        if (tm.t > this.now) { stepCircuit(tm.t - this.now); this.now = tm.t; }
        this.blocked = false; tm.res(); await this._drain();
      }
      if (target > this.now) { stepCircuit(target - this.now); this.now = target; }
    }
    async _runUntilWorker(target, stepCircuit) {
      let guard = 0;
      while (this.running && this.timers.length && this.timers[0].t <= target && guard++ < 20000) {
        const tm = this.timers.shift();
        if (tm.t > this.now) { stepCircuit(tm.t - this.now); this.now = tm.t; }
        this.blocked = false; tm.res(); await this._waitBlocked();
      }
      if (this.running && target > this.now) { stepCircuit(target - this.now); this.now = target; }
    }
    stop() {
      this.running = false; this.timers = []; this._disarm();
      if (this._worker) {
        try { this._worker.post({ v: 1, type: 'stop' }); } catch (e) { /* closed */ }
        try { this._worker.terminate(); } catch (e) { /* closed */ }
        this._worker = null;
      }
    }
  }
  const api = { JsSketch, transform, workerFlag, WORKER_AWAIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JsSketchMod = api;
})(typeof window !== 'undefined' ? window : globalThis);
