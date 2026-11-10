/* Instrument suite: 4-channel phosphor oscilloscope (trigger, cursors, FFT, measurements, CSV), 8-lane logic analyzer
 * with UART/I2C decode, and a live telemetry strip. Samples come from the circuit solver: Sim._sample() calls
 * Instruments.sample(sim) after every transient step (h = 0.5 ms, or adaptively finer when a fast timebase is shown),
 * or once per frame for purely resistive circuits. Pure canvas 2D, rendered at display refresh rate while visible. */
(function (root) {
  const HAS_DOM = typeof document !== 'undefined', $ = (s, r) => HAS_DOM ? (r || document).querySelector(s) : null, $$ = (s, r) => HAS_DOM ? [...(r || document).querySelectorAll(s)] : [];
  const CCOL = ['#ffd84a', '#30e0ff', '#ff4fd8', '#6dff8a'];
  const WCOL = ['#7cf3ff', '#ffb35a', '#c69bff'];
  const TB = [1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5, 1];
  const VD = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
  const HDIV = 10, VDIV = 8, CAP = 1 << 18;
  const si = (v, u, d = 3) => { if (!isFinite(v)) return '—'; const a = Math.abs(v); const [k, p] = a === 0 ? [1, ''] : a >= 1e6 ? [1e-6, 'M'] : a >= 1e3 ? [1e-3, 'k'] : a >= 1 ? [1, ''] : a >= 1e-3 ? [1e3, 'm'] : a >= 1e-6 ? [1e6, 'µ'] : [1e9, 'n']; const x = v * k; return (Math.abs(x) >= 100 ? x.toFixed(Math.max(0, d - 3)) : Math.abs(x) >= 10 ? x.toFixed(Math.max(0, d - 2)) : x.toFixed(Math.max(0, d - 1))) + ' ' + p + u; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------- ring buffer of (t, v) ----------------
  class Ring {
    constructor(cap = CAP) { this.cap = cap; this.t = new Float64Array(cap); this.v = new Float32Array(cap); this.n = 0; this.h = 0; }
    clear() { this.n = 0; this.h = 0; }
    push(t, v) { this.t[this.h] = t; this.v[this.h] = v; this.h = (this.h + 1) % this.cap; if (this.n < this.cap) this.n++; }
    i(k) { return (this.h - this.n + k + this.cap) % this.cap; }   // logical -> physical
    T(k) { return this.t[this.i(k)]; } V(k) { return this.v[this.i(k)]; }
    last() { return this.n ? this.V(this.n - 1) : NaN; } lastT() { return this.n ? this.T(this.n - 1) : -Infinity; }
    first(t) { let lo = 0, hi = this.n; while (lo < hi) { const m = (lo + hi) >> 1; if (this.T(m) < t) lo = m + 1; else hi = m; } return lo; }   // first k with T>=t
    at(t) { const k = this.first(t); if (k >= this.n) return this.last(); if (k === 0) return this.V(0); const t0 = this.T(k - 1), t1 = this.T(k); return t1 - t0 > 0 && this.hold ? this.V(k - 1) : this.V(k - 1) + (this.V(k) - this.V(k - 1)) * (t - t0) / ((t1 - t0) || 1); }
    snapshot(t0, t1) { const r = new Ring(Math.max(16, this.n)); const a = Math.max(0, this.first(t0) - 2), b = Math.min(this.n, this.first(t1) + 2); for (let k = a; k < b; k++) r.push(this.T(k), this.V(k)); r.hold = this.hold; return r; }
  }

  // ---------------- probes: what a channel / strip slot / logic lane is attached to ----------------
  function probeLabel(pr) { return pr.label || (pr.kind === 'pin' ? pr.part + '.' + pr.pin : pr.kind === 'wire' ? 'wire ' + pr.wire : pr.kind === 'probe' ? 'probe CH' + pr.ch : 'GPIO' + pr.gpio); }
  function resolveNet(sim, pr) {
    if (pr._pn === sim.pinNet && pr._net !== undefined && pr.kind !== 'probe') return pr._net;
    let n = -1;
    if (pr.kind === 'pin') n = sim.pinNet ? sim.pinNet.get(pr.part + ':' + pr.pin) : -1;
    else if (pr.kind === 'wire') { const w = sim.project.wires.find((q) => q.id === pr.wire); n = w ? sim.netAt(w.a.x, w.a.y) : -1; }
    else if (pr.kind === 'probe') n = sim.probes[pr.ch] !== undefined ? sim.probes[pr.ch] : -1;
    pr._pn = sim.pinNet; pr._net = n === undefined ? -1 : n; return pr._net;
  }
  function readProbe(sim, pr) {
    if (pr.kind === 'gpio') { const esp = sim.project.parts.find((q) => q.type === 'esp32'); if (!esp) return NaN; const rt = sim.espRuntime(esp), p = rt.pins[pr.gpio]; if (!p) return NaN; return p.out ? (p.pwm !== undefined ? p.pwm : p.level) : rt.pinInput[pr.gpio]; }
    const C = sim.circuit; if (!C) return NaN; const n = resolveNet(sim, pr); if (n < 0) return NaN; return n === 0 ? 0 : C.v(n);
  }

  const I = root.Instruments = {
    ch: [1, 2, 3, 4].map((k) => ({ k, on: false, probe: null, buf: new Ring(), vdiv: 1, pos: -3, col: CCOL[k - 1] })),
    watch: [],   // telemetry strip [{probe, buf, col}]
    lanes: [2, 4, 5, 18, 19, 21, 22, 23].map((g) => ({ gpio: g, buf: new Ring(1 << 16), lastV: -1 })),
    tdiv: 0.1, hpos: 0.5, trig: { src: 1, slope: 'rise', mode: 'auto', level: 2.5 }, run: true, single: false, persist: true, fft: false, cursors: false, la: false,
    cur: [0.3, 0.7], sel: 1, armed: false, status: 'AUTO', decoder: { kind: 'none', a: 0, b: 1, baud: 9600 },
    lastT: -1, sr: 0, Ring, si,
  };

  // called by Sim after each step
  I.sample = function (sim) {
    const t = sim.t;
    if (t < I.lastT - 1e-9) I.clearAll();
    if (t === I.lastT) return; I.lastT = t;
    for (const c of I.ch) if (c.on && c.probe) c.buf.push(t, readProbe(sim, c.probe));
    for (const w of I.watch) w.buf.push(t, readProbe(sim, w.probe));
    if (I.la && sim.project.parts.some((q) => q.type === 'esp32')) for (const l of I.lanes) { const v = readProbe(sim, { kind: 'gpio', gpio: l.gpio }) >= 0.5 ? 1 : 0; if (v !== l.lastV || l.buf.n === 0) { l.buf.push(t, v); l.lastV = v; } l.tNow = t; }
  };
  I.clearAll = function () { for (const c of I.ch) c.buf.clear(); for (const w of I.watch) w.buf.clear(); for (const l of I.lanes) { l.buf.clear(); l.lastV = -1; } I.lastT = -1; I.frozen = null; I.trigT = null; };
  // finer solver step while a fast timebase is on screen (so 50 µs/div shows real edges, not 0.5 ms stairs)
  I.wantStep = function () { if (!I.ch.some((c) => c.on) || I.frozen || !I._vis || (root.app && root.app.run && root.app.run.kind === 'js')) return 5e-4; return Math.max(2e-6, Math.min(5e-4, I.tdiv * HDIV / 400)); };

  // ---------------- probing API ----------------
  I.nextFree = () => (I.ch.find((c) => !c.on) || I.ch[I.sel - 1] || I.ch[0]);
  I.probe = function (pr, chk) {
    const c = chk ? I.ch[chk - 1] : I.nextFree(); c.probe = pr; c.on = true; c.buf.clear(); pr._net = undefined;
    I.sel = c.k; if (I.trig.src !== c.k && !I.ch.some((q) => q.on && q.k === I.trig.src && q !== c)) I.trig.src = c.k;
    I.renderUi(); I.toast && I.toast(`CH${c.k} ⟶ ${probeLabel(pr)}`); return c.k;
  };
  I.unprobe = (k) => { const c = I.ch[k - 1]; c.on = false; c.probe = null; c.buf.clear(); I.renderUi(); };
  I.watchProbe = function (pr) {
    const key = JSON.stringify([pr.kind, pr.part, pr.pin, pr.wire, pr.gpio]);
    if (I.watch.some((w) => w.key === key)) return;
    if (I.watch.length >= 3) I.watch.shift();
    const used = new Set(I.watch.map((w) => w.col)); I.watch.push({ key, probe: pr, buf: new Ring(1 << 16), col: WCOL.find((c) => !used.has(c)) || WCOL[0] });
    I.renderStrip(true); I.toast && I.toast('Pinned ' + probeLabel(pr) + ' to telemetry');
  };
  I.unwatch = (i) => { I.watch.splice(i, 1); I.renderStrip(true); };
  I.setProject = function (proj, sim) {
    for (const c of I.ch) { c.on = false; c.probe = null; } I.watch = []; I.clearAll();
    if (proj.scope && proj.scope.div) I.tdiv = TB.reduce((b, x) => Math.abs(Math.log(x / proj.scope.div)) < Math.abs(Math.log(b / proj.scope.div)) ? x : b, 1);
    // legacy “Oscilloscope probe” parts become live channels
    for (const p of proj.parts) if (p.type === 'scope') { const ch = (root.Parts && root.Parts.scopeChannel) ? root.Parts.scopeChannel(p.props.ch) : 1; const c = I.ch[ch - 1]; if (!c) continue; c.on = true; c.probe = { kind: 'probe', ch, label: p.id + ' (CH' + ch + ' probe)' }; }
    const on = I.ch.filter((c) => c.on); if (on.length) I.trig.src = on[0].k;
    I.renderUi(); I.renderStrip(true);
  };

  // ---------------- window / trigger ----------------
  function span() { return I.tdiv * HDIV; }
  function findTrigger(c, tEnd) {
    const b = c.buf; if (!b.n) return null;
    const S = span(), lvl = I.trig.level, hy = Math.max(1e-4, c.vdiv * 0.04), rise = I.trig.slope === 'rise';
    const tMax = tEnd - S * (1 - I.hpos), tMin = Math.max(b.T(0) + S * I.hpos, tEnd - Math.max(S * 6, 0.25));
    let k = Math.min(b.n - 1, b.first(tMax)); let armed = false; let steps = 0;
    for (; k > 0 && steps < 120000; k--, steps++) {   // walk backwards: find the newest qualifying crossing
      const t1 = b.T(k); if (t1 < tMin) break;
      const v0 = b.V(k - 1), v1 = b.V(k);
      if (rise ? (v0 < lvl && v1 >= lvl) : (v0 > lvl && v1 <= lvl)) {
        // hysteresis: the signal must have been beyond the band before the crossing
        let j = k - 1, ok = false; for (let s = 0; j >= 0 && s < 4000; j--, s++) { const v = b.V(j); if (rise ? v < lvl - hy : v > lvl + hy) { ok = true; break; } if (rise ? v > lvl : v < lvl) break; }
        if (ok || armed) { const t0 = b.T(k - 1); return t0 + (t1 - t0) * ((lvl - v0) / ((v1 - v0) || 1)); }
      }
    }
    return null;
  }
  function computeWindow() {
    const S = span(); let tNow = I.lastT; if (tNow < 0) tNow = 0;
    if (I.frozen) return I.frozen.win;
    const tc = I.ch[I.trig.src - 1];
    let tt = tc && tc.on ? findTrigger(tc, tNow) : null;
    if (tt !== null) { I.trigT = tt; I.status = "TRIG'D"; if (I.single) { I.freeze(); I.single = false; I.renderUi(); return I.frozen.win; } }
    else if (I.trig.mode === 'normal' && I.trigT !== null && I.trigT > tNow - Math.max(30 * S, 2)) { I.status = 'WAIT'; tt = I.trigT; }
    else { I.status = I.single ? 'ARMED' : I.trig.mode === 'normal' ? 'WAIT' : 'AUTO'; if (I.trig.mode === 'normal' || I.single) return { t0: tNow - S, t1: tNow, empty: true }; return { t0: tNow - S, t1: tNow }; }
    return { t0: tt - S * I.hpos, t1: tt + S * (1 - I.hpos), tt };
  }
  I.freeze = function () { const w = computeWindowRaw(); I.frozen = { win: w, bufs: I.ch.map((c) => c.buf.snapshot(w.t0 - span(), w.t1 + span())), lanes: I.lanes.map((l) => l.buf.snapshot(w.t0 - span() * 4, w.t1 + span())) }; I.run = false; };
  function computeWindowRaw() { const f = I.frozen; I.frozen = null; const w = computeWindow(); I.frozen = f; return w; }
  const bufOf = (c) => I.frozen ? I.frozen.bufs[c.k - 1] : c.buf;
  const laneBuf = (i) => I.frozen ? I.frozen.lanes[i] : I.lanes[i].buf;

  // ---------------- measurements ----------------
  function measure(b, t0, t1) {
    const a = b.first(t0), z = b.first(t1); if (z - a < 2) return null;
    let mx = -Infinity, mn = Infinity, s = 0, s2 = 0, n = 0;
    for (let k = a; k < z; k++) { const v = b.V(k); if (!isFinite(v)) continue; if (v > mx) mx = v; if (v < mn) mn = v; s += v; s2 += v * v; n++; }
    if (!n) return null;
    const mid = (mx + mn) / 2, hy = (mx - mn) * 0.1; let st = b.V(a) > mid ? 1 : 0; const rises = [], falls = [];
    for (let k = a + 1; k < z; k++) { const v = b.V(k); if (st === 0 && v > mid + hy) { st = 1; rises.push(b.T(k)); } else if (st === 1 && v < mid - hy) { st = 0; falls.push(b.T(k)); } }
    let f = NaN, duty = NaN;
    if (rises.length >= 2 && mx - mn > 0.02) { const r0 = rises[0], r1 = rises[rises.length - 1]; f = (rises.length - 1) / (r1 - r0); let hi = 0, j = 0;
      for (let i = 0; i < rises.length - 1; i++) { while (j < falls.length && falls[j] <= rises[i]) j++; if (j < falls.length && falls[j] < rises[i + 1]) hi += falls[j] - rises[i]; } duty = hi / (r1 - r0); }
    return { max: mx, min: mn, pp: mx - mn, avg: s / n, rms: Math.sqrt(s2 / n), f, duty, n };
  }
  // ---------------- FFT ----------------
  function fft(re, im) {
    const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
  }
  function spectrum(b, t0, t1, N = 2048) {
    if (b.n < 4) return null; const re = new Float64Array(N), im = new Float64Array(N); let m = 0;
    for (let i = 0; i < N; i++) { const v = b.at(t0 + (t1 - t0) * i / N); re[i] = isFinite(v) ? v : 0; m += re[i]; } m /= N;
    for (let i = 0; i < N; i++) re[i] = (re[i] - m) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im); const fs = N / (t1 - t0), out = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) out[k] = 20 * Math.log10(Math.max(1e-9, Math.hypot(re[k], im[k]) * 4 / N));
    out[0] = 20 * Math.log10(Math.max(1e-9, Math.abs(m)));
    return { db: out, fs, df: fs / N };
  }

  // ---------------- rendering ----------------
  let cv, g, ph, pg, W = 0, H = 0, dpr = 1, raf = 0, lastFrame = 0, la, lg;
  function size() {
    if (!cv) return; dpr = Math.min(2, window.devicePixelRatio || 1); const r = cv.getBoundingClientRect(); const w = Math.max(200, Math.round(r.width * dpr)), h = Math.max(120, Math.round(r.height * dpr));
    if (w !== cv.width || h !== cv.height) { cv.width = ph.width = w; cv.height = ph.height = h; W = w; H = h; pg.fillStyle = '#000'; pg.fillRect(0, 0, W, H); }
    if (la && I.la) { const rr = la.getBoundingClientRect(); const lw = Math.max(200, Math.round(rr.width * dpr)), lh = Math.max(60, Math.round(rr.height * dpr)); if (la.width !== lw || la.height !== lh) { la.width = lw; la.height = lh; } }
  }
  function plotArea() { const pad = Math.round(10 * dpr), top = Math.round(26 * dpr), bot = Math.round(30 * dpr); const fftH = I.fft ? Math.round((H - top - bot) * 0.42) : 0; return { x: pad + Math.round(18 * dpr), y: top, w: W - pad * 2 - Math.round(30 * dpr), h: H - top - bot - fftH - (I.fft ? Math.round(14 * dpr) : 0), fy: H - bot - fftH, fh: fftH }; }
  function grid(ctx, A, nx, ny) {
    ctx.save(); ctx.strokeStyle = 'rgba(120,170,210,.10)'; ctx.lineWidth = 1;
    ctx.beginPath(); for (let i = 1; i < nx; i++) { const x = Math.round(A.x + A.w * i / nx) + .5; ctx.moveTo(x, A.y); ctx.lineTo(x, A.y + A.h); } for (let i = 1; i < ny; i++) { const y = Math.round(A.y + A.h * i / ny) + .5; ctx.moveTo(A.x, y); ctx.lineTo(A.x + A.w, y); } ctx.stroke();
    ctx.strokeStyle = 'rgba(140,200,240,.28)'; ctx.beginPath(); const cx = Math.round(A.x + A.w / 2) + .5, cy = Math.round(A.y + A.h / 2) + .5; ctx.moveTo(cx, A.y); ctx.lineTo(cx, A.y + A.h); ctx.moveTo(A.x, cy); ctx.lineTo(A.x + A.w, cy);
    const tk = 4 * dpr; for (let i = 0; i <= nx * 5; i++) { const x = Math.round(A.x + A.w * i / (nx * 5)) + .5; ctx.moveTo(x, cy - tk); ctx.lineTo(x, cy + tk); ctx.moveTo(x, A.y); ctx.lineTo(x, A.y + tk); ctx.moveTo(x, A.y + A.h); ctx.lineTo(x, A.y + A.h - tk); }
    for (let i = 0; i <= ny * 5; i++) { const y = Math.round(A.y + A.h * i / (ny * 5)) + .5; ctx.moveTo(cx - tk, y); ctx.lineTo(cx + tk, y); ctx.moveTo(A.x, y); ctx.lineTo(A.x + tk, y); ctx.moveTo(A.x + A.w, y); ctx.lineTo(A.x + A.w - tk, y); }
    ctx.stroke(); ctx.strokeStyle = 'rgba(140,200,240,.35)'; ctx.strokeRect(A.x + .5, A.y + .5, A.w - 1, A.h - 1);
    // corner brackets
    ctx.strokeStyle = 'rgba(34,211,238,.85)'; ctx.lineWidth = 2 * dpr; const L = 12 * dpr, o = 3 * dpr; ctx.beginPath();
    for (const [x, y, sx, sy] of [[A.x - o, A.y - o, 1, 1], [A.x + A.w + o, A.y - o, -1, 1], [A.x - o, A.y + A.h + o, 1, -1], [A.x + A.w + o, A.y + A.h + o, -1, -1]]) { ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); }
    ctx.stroke(); ctx.restore();
  }
  function trace(ctx, b, c, w, A, wide) {
    const S = w.t1 - w.t0, a = Math.max(0, b.first(w.t0) - 1), z = Math.min(b.n, b.first(w.t1) + 2); if (z - a < 1) return;
    const y = (v) => A.y + A.h / 2 - (v / c.vdiv + c.pos) * A.h / VDIV, X = (t) => A.x + (t - w.t0) / S * A.w;
    const sparse = (z - a) < A.w / 3, step = sparse && (c.probe && (c.probe.kind === 'gpio' || !hasDyn()));
    ctx.beginPath(); let col = -1, mn = 0, mx = 0, started = false, px = 0, pyv = 0;
    const flush = () => { if (col < 0) return; const yy1 = y(mn), yy2 = y(mx); if (!started) { ctx.moveTo(col, y(pyv)); started = true; } ctx.lineTo(col, yy1); if (mx !== mn) ctx.lineTo(col, yy2); ctx.lineTo(col, y(pyv)); };
    for (let k = a; k < z; k++) {
      const v = b.V(k); if (!isFinite(v)) { flush(); col = -1; started = false; continue; }
      const xf = X(b.T(k));
      if (sparse) { if (!started) { ctx.moveTo(xf, y(v)); started = true; } else { if (step) ctx.lineTo(xf, y(pyv)); ctx.lineTo(xf, y(v)); } pyv = v; continue; }
      const xi = Math.round(xf); if (xi !== col) { flush(); col = xi; mn = mx = v; } else { if (v < mn) mn = v; if (v > mx) mx = v; } pyv = v; px = xf;
    }
    flush();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = c.col; ctx.globalAlpha = 0.16; ctx.lineWidth = (wide ? 7 : 5) * dpr; ctx.stroke();
    ctx.globalAlpha = 0.45; ctx.lineWidth = 2.6 * dpr; ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = mixWhite(c.col); ctx.lineWidth = 1.15 * dpr; ctx.stroke();
  }
  const MW = {}; function mixWhite(c) { if (MW[c]) return MW[c]; const n = parseInt(c.slice(1), 16), r = n >> 16, gg = n >> 8 & 255, bb = n & 255, f = (x) => Math.round(x + (255 - x) * 0.55); return (MW[c] = `rgb(${f(r)},${f(gg)},${f(bb)})`); }
  let _dyn = null, _dynF = 0; function hasDyn() { if (_dynF++ % 60 === 0) _dyn = root.app && root.app.sim ? root.app.sim.hasDynamics() : true; return _dyn; }
  function txt(ctx, s, x, y, col, size = 11, align = 'left', weight = 500) { ctx.font = `${weight} ${size * dpr}px "JetBrains Mono",ui-monospace,monospace`; ctx.textAlign = align; ctx.fillStyle = col; ctx.fillText(s, x, y); }

  function draw() {
    size(); if (!W) return;
    const A = plotArea(), w = computeWindow(); I.win = w;
    // phosphor layer
    pg.globalCompositeOperation = 'source-over'; pg.fillStyle = `rgba(0,0,0,${I.persist && I.run ? 0.28 : 1})`; pg.fillRect(0, 0, W, H);
    pg.save(); pg.beginPath(); pg.rect(A.x, A.y - 2 * dpr, A.w, A.h + 4 * dpr); pg.clip(); pg.globalCompositeOperation = 'lighter';
    if (!w.empty) for (const c of I.ch) if (c.on) trace(pg, bufOf(c), c, w, A, c.k === I.sel);
    pg.restore();
    // compose
    const bg = g.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H / 2, Math.max(W, H) * 0.75); bg.addColorStop(0, '#07121c'); bg.addColorStop(1, '#020509');
    g.globalCompositeOperation = 'source-over'; g.fillStyle = bg; g.fillRect(0, 0, W, H);
    grid(g, A, HDIV, VDIV);
    g.globalCompositeOperation = 'lighter'; g.drawImage(ph, 0, 0); g.globalCompositeOperation = 'source-over';
    // ground markers + trigger markers
    for (const c of I.ch) if (c.on) { const y0 = A.y + A.h / 2 - c.pos * A.h / VDIV; if (y0 >= A.y && y0 <= A.y + A.h) { g.fillStyle = c.col; g.beginPath(); g.moveTo(A.x - 2 * dpr, y0); g.lineTo(A.x - 16 * dpr, y0 - 7 * dpr); g.lineTo(A.x - 16 * dpr, y0 + 7 * dpr); g.closePath(); g.fill(); txt(g, String(c.k), A.x - 12 * dpr, y0 + 4 * dpr, '#000', 9, 'center', 700); } }
    const tc = I.ch[I.trig.src - 1];
    if (tc && tc.on) { const yl = A.y + A.h / 2 - (I.trig.level / tc.vdiv + tc.pos) * A.h / VDIV; if (yl >= A.y && yl <= A.y + A.h) { g.fillStyle = tc.col; g.beginPath(); g.moveTo(A.x + A.w + 2 * dpr, yl); g.lineTo(A.x + A.w + 14 * dpr, yl - 6 * dpr); g.lineTo(A.x + A.w + 14 * dpr, yl + 6 * dpr); g.closePath(); g.fill(); g.setLineDash([3 * dpr, 4 * dpr]); g.strokeStyle = tc.col + '55'; g.beginPath(); g.moveTo(A.x, yl); g.lineTo(A.x + A.w, yl); g.stroke(); g.setLineDash([]); } }
    const xt = A.x + A.w * I.hpos; g.fillStyle = '#ff9f1a'; g.beginPath(); g.moveTo(xt, A.y - 1); g.lineTo(xt - 6 * dpr, A.y - 10 * dpr); g.lineTo(xt + 6 * dpr, A.y - 10 * dpr); g.closePath(); g.fill(); txt(g, 'T', xt, A.y - 12 * dpr, '#ff9f1a', 9, 'center', 700);
    // cursors
    const curRead = [];
    if (I.cursors) {
      g.save(); g.setLineDash([5 * dpr, 4 * dpr]); g.lineWidth = 1 * dpr;
      I.cur.forEach((f, i) => { const x = A.x + A.w * f; g.strokeStyle = i ? '#ff9f1a' : '#e8f4ff'; g.beginPath(); g.moveTo(x + .5, A.y); g.lineTo(x + .5, A.y + A.h + (I.fft ? A.h : 0)); g.stroke(); txt(g, i ? 'B' : 'A', x + 4 * dpr, A.y + A.h - 6 * dpr, i ? '#ff9f1a' : '#e8f4ff', 10, 'left', 700); });
      g.restore();
      const ta = w.t0 + (w.t1 - w.t0) * I.cur[0], tb = w.t0 + (w.t1 - w.t0) * I.cur[1];
      curRead.push(['ΔT', si(tb - ta, 's')], ['1/ΔT', si(1 / Math.abs(tb - ta), 'Hz')]);
      const sc = I.ch[I.sel - 1]; if (sc && sc.on) { const b = bufOf(sc), va = b.at(ta), vb = b.at(tb); curRead.push([`A·CH${sc.k}`, si(va, 'V')], [`B·CH${sc.k}`, si(vb, 'V')], ['ΔV', si(vb - va, 'V')]); }
      I.curRead = curRead;
    } else I.curRead = null;
    // HUD text
    txt(g, `${si(I.tdiv, 's')}/div`, A.x, H - 10 * dpr, '#cfe8ff', 11, 'left', 600);
    let xx = A.x + 110 * dpr; for (const c of I.ch) if (c.on) { txt(g, `CH${c.k} ${si(c.vdiv, 'V')}/`, xx, H - 10 * dpr, c.col, 11, 'left', 600); xx += 108 * dpr; }
    if (W / dpr > 560) txt(g, `${root.app && root.app.sim && root.app.sim.slowmo ? 'SLOW-MO · ' : ''}t=${(I.lastT < 0 ? 0 : I.lastT).toFixed(4)}s · ${I.sr ? si(I.sr, 'S/s') : '— S/s'}`, A.x + A.w, H - 10 * dpr, '#7b93aa', 10, 'right');
    const stc = I.status === "TRIG'D" ? '#6dff8a' : I.status === 'AUTO' ? '#ffd84a' : '#ff9f1a';
    txt(g, I.frozen ? '■ STOP' : '▶ ' + I.status, A.x, 16 * dpr, I.frozen ? '#ff5a5a' : stc, 11, 'left', 700);
    if (tc && tc.on) txt(g, `TRIG CH${tc.k} ${I.trig.slope === 'rise' ? '↑' : '↓'} ${si(I.trig.level, 'V')} · ${I.trig.mode.toUpperCase()}`, A.x + A.w, 16 * dpr, '#9fb6cc', 10.5, 'right');
    if (!I.ch.some((c) => c.on)) { txt(g, 'NO PROBES', A.x + A.w / 2, A.y + A.h / 2 - 8 * dpr, 'rgba(160,210,240,.75)', 14, 'center', 700); txt(g, 'press ⌁ PROBE, then click any pin or wire · or Inspector → ⌁', A.x + A.w / 2, A.y + A.h / 2 + 14 * dpr, 'rgba(140,180,210,.6)', 11, 'center'); }
    if (I.armed) { g.fillStyle = 'rgba(255,159,26,.1)'; g.fillRect(A.x, A.y, A.w, A.h); txt(g, 'PROBE ARMED — click a pin or wire on the circuit', A.x + A.w / 2, A.y + 24 * dpr, '#ffb04a', 12, 'center', 700); }
    // FFT
    if (I.fft) drawFft(A, w);
    if (I.la) drawLogic(w);
  }
  function drawFft(A, w) {
    const F = { x: A.x, y: A.fy, w: A.w, h: A.fh }; grid(g, F, 10, 4);
    const c = I.ch[I.sel - 1]; if (!c || !c.on) { txt(g, 'FFT: select a channel', F.x + 8 * dpr, F.y + 16 * dpr, '#7b93aa', 11); return; }
    const sp = (I._spT && performance.now() - I._spT < 120 && I._sp) || (I._sp = spectrum(bufOf(c), w.t0, w.t1), I._spT = performance.now(), I._sp); if (!sp) return;
    const n = sp.db.length, top = 20, bot = -100, y = (d) => F.y + (top - d) / (top - bot) * F.h;
    g.save(); g.beginPath(); g.rect(F.x, F.y, F.w, F.h); g.clip(); g.beginPath(); g.moveTo(F.x, F.y + F.h);
    let pk = 1; for (let k = 1; k < n; k++) if (sp.db[k] > sp.db[pk]) pk = k;
    for (let x = 0; x < F.w; x++) { const k0 = Math.floor(x / F.w * n), k1 = Math.max(k0 + 1, Math.floor((x + 1) / F.w * n)); let m = -200; for (let k = k0; k < k1 && k < n; k++) m = Math.max(m, sp.db[k]); g.lineTo(F.x + x, y(m)); }
    g.lineTo(F.x + F.w, F.y + F.h); g.closePath(); const gr = g.createLinearGradient(0, F.y, 0, F.y + F.h); gr.addColorStop(0, c.col + 'aa'); gr.addColorStop(1, c.col + '08'); g.fillStyle = gr; g.fill();
    g.shadowColor = c.col; g.shadowBlur = 8 * dpr; g.strokeStyle = mixWhite(c.col); g.lineWidth = 1.1 * dpr; g.stroke(); g.restore();
    const fmax = sp.fs / 2; txt(g, `FFT CH${c.k} · Hann · 0–${si(fmax, 'Hz')} · ${si(fmax / 10, 'Hz')}/div · 20 dB/div`, F.x + 6 * dpr, F.y + 14 * dpr, '#9fb6cc', 10);
    txt(g, `PEAK ${si(pk * sp.df, 'Hz')} ${sp.db[pk].toFixed(1)} dBV`, F.x + F.w - 6 * dpr, F.y + 14 * dpr, c.col, 10.5, 'right', 700);
    I.fftPeak = { f: pk * sp.df, db: sp.db[pk] };
  }
  // ---------------- logic analyzer ----------------
  function decode(w) {
    const d = I.decoder, out = []; if (d.kind === 'none') return out;
    const A = laneBuf(d.a), B = laneBuf(d.b); if (!A.n) return out;
    const lvl = (b, t) => { const k = b.first(t + 1e-12); return k === 0 ? b.V(0) : b.V(k - 1); };
    if (d.kind === 'uart') {
      const bit = 1 / d.baud; let k = Math.max(1, A.first(w.t0 - 12 * bit));
      for (; k < A.n; k++) { const t = A.T(k); if (t > w.t1) break; if (A.V(k) === 0 && A.V(k - 1) === 1) { let byte = 0; for (let i = 0; i < 8; i++) byte |= lvl(A, t + bit * (1.5 + i)) << i; const stop = lvl(A, t + bit * 9.5); out.push({ lane: d.a, t0: t, t1: t + bit * 10, s: (byte >= 32 && byte < 127 ? `'${String.fromCharCode(byte)}' ` : '') + '0x' + byte.toString(16).padStart(2, '0') + (stop ? '' : ' FE') }); k = A.first(t + bit * 9.6) - 1; } }
    } else if (d.kind === 'i2c') {   // a = SDA, b = SCL
      const ev = []; for (let k = 1; k < A.n; k++) ev.push([A.T(k), 'sda', A.V(k)]); for (let k = 1; k < B.n; k++) ev.push([B.T(k), 'scl', B.V(k)]); ev.sort((x, y) => x[0] - y[0]);
      let inT = false, bits = [], tb = 0;
      for (const [t, s, v] of ev) {
        if (s === 'sda' && lvl(B, t) === 1) { if (v === 0) { inT = true; bits = []; out.push({ lane: d.a, t0: t, t1: t, s: 'S' }); } else { inT = false; out.push({ lane: d.a, t0: t, t1: t, s: 'P' }); } continue; }
        if (s === 'scl' && v === 1 && inT) { if (!bits.length) tb = t; bits.push(lvl(A, t)); if (bits.length === 9) { const byte = bits.slice(0, 8).reduce((a, b) => a * 2 + b, 0); out.push({ lane: d.a, t0: tb, t1: t, s: '0x' + byte.toString(16).padStart(2, '0') + (bits[8] ? ' NAK' : ' ACK') }); bits = []; } }
      }
    }
    return out.filter((e) => e.t1 >= w.t0 && e.t0 <= w.t1);
  }
  function drawLogic(w) {
    if (!la) return; const L = la.width, Hh = la.height, n = I.lanes.length, lh = Hh / n, x0 = 64 * dpr, ww = L - x0 - 8 * dpr, S = w.t1 - w.t0, X = (t) => x0 + (t - w.t0) / S * ww;
    lg.fillStyle = '#020509'; lg.fillRect(0, 0, L, Hh);
    lg.strokeStyle = 'rgba(120,170,210,.08)'; lg.lineWidth = 1; lg.beginPath(); for (let i = 0; i <= HDIV; i++) { const x = Math.round(x0 + ww * i / HDIV) + .5; lg.moveTo(x, 0); lg.lineTo(x, Hh); } lg.stroke();
    const hasEsp = root.app && root.app.proj && root.app.proj.parts.some((q) => q.type === 'esp32');
    I.lanes.forEach((l, i) => {
      const b = laneBuf(i), yH = i * lh + lh * 0.22, yL = i * lh + lh * 0.78, col = i < 4 ? '#6dff8a' : '#30e0ff';
      lg.fillStyle = i % 2 ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.03)'; lg.fillRect(0, i * lh, L, lh);
      txt(lg, `D${i}`, 6 * dpr, i * lh + lh / 2 + 4 * dpr, '#5f7a93', 10, 'left', 700); txt(lg, `GPIO${l.gpio}`, 24 * dpr, i * lh + lh / 2 + 4 * dpr, '#cfe8ff', 10, 'left', 600);
      if (!b.n) return;
      lg.beginPath(); let k = Math.max(0, b.first(w.t0) - 1), v = b.V(k); lg.moveTo(x0, v ? yH : yL);
      for (k = k + 1; k < b.n && b.T(k) <= w.t1; k++) { const x = Math.max(x0, X(b.T(k))); lg.lineTo(x, v ? yH : yL); v = b.V(k); lg.lineTo(x, v ? yH : yL); }
      const tEnd = Math.min(w.t1, I.frozen ? w.t1 : I.lastT); lg.lineTo(Math.max(x0, X(tEnd)), v ? yH : yL);
      lg.strokeStyle = col; lg.globalAlpha = 0.25; lg.lineWidth = 4 * dpr; lg.stroke(); lg.globalAlpha = 1; lg.lineWidth = 1.2 * dpr; lg.stroke();
    });
    for (const e of decode(w)) { const xa = Math.max(x0, X(e.t0)), xb = Math.min(x0 + ww, Math.max(X(e.t1), xa + 14 * dpr)), y = e.lane * lh + lh * 0.18, h = lh * 0.64; lg.fillStyle = 'rgba(255,159,26,.18)'; lg.strokeStyle = '#ff9f1a'; lg.lineWidth = 1; lg.beginPath(); lg.roundRect ? lg.roundRect(xa, y, xb - xa, h, 3 * dpr) : lg.rect(xa, y, xb - xa, h); lg.fill(); lg.stroke(); txt(lg, e.s, (xa + xb) / 2, y + h / 2 + 4 * dpr, '#ffd9a6', 9.5, 'center', 700); }
    if (!hasEsp) txt(lg, 'Logic analyzer reads ESP32 GPIO levels — this project has no ESP32', L / 2, Hh / 2, '#7b93aa', 11, 'center');
  }

  // ---------------- telemetry strip ----------------
  let stripEl = null;
  I.renderStrip = function (rebuild) {
    stripEl = stripEl || $('#telStrip'); if (!stripEl) return;
    if (rebuild) {
      stripEl.hidden = !I.watch.length; document.body.classList.toggle('has-tel', !!I.watch.length);
      stripEl.innerHTML = `<span class="tel-h">TELEMETRY</span>` + I.watch.map((w, i) => `<div class="tel-i" style="--c:${w.col}"><div class="tel-l"><span class="tel-n">${esc(probeLabel(w.probe))}</span><span class="tel-v" data-i="${i}">—</span></div><canvas width="160" height="30" data-i="${i}"></canvas><button class="tel-x" data-x="${i}" title="Unpin">×</button><button class="tel-s" data-s="${i}" title="Send to scope">⌁</button></div>`).join('');
    }
    const now = I.lastT, d = Math.min(2, window.devicePixelRatio || 1);
    I.watch.forEach((w, i) => {
      const v = w.buf.last(), ve = stripEl.querySelector(`.tel-v[data-i="${i}"]`); if (ve) ve.textContent = isFinite(v) ? si(v, w.probe.kind === 'gpio' ? '' : 'V') : 'n/c';
      const c = stripEl.querySelector(`canvas[data-i="${i}"]`); if (!c) return; const cw = Math.round(c.clientWidth * d) || 160, ch = Math.round(c.clientHeight * d) || 30; if (c.width !== cw) c.width = cw; if (c.height !== ch) c.height = ch;
      const x = c.getContext('2d'); x.clearRect(0, 0, cw, ch); const b = w.buf, S = 5, t0 = now - S; const a = b.first(t0); if (b.n - a < 1) return;
      let mn = Infinity, mx = -Infinity; for (let k = a; k < b.n; k++) { const v2 = b.V(k); if (isFinite(v2)) { mn = Math.min(mn, v2); mx = Math.max(mx, v2); } } if (!isFinite(mn)) return; if (mx - mn < 0.05) { mn -= 0.05; mx += 0.05; }
      const Y = (v2) => ch - 3 * d - (v2 - mn) / (mx - mn) * (ch - 6 * d), step = Math.max(1, Math.floor((b.n - a) / (cw * 2)));
      x.beginPath(); for (let k = a; k < b.n; k += step) { const px = (b.T(k) - t0) / S * cw, v2 = b.V(k); if (k === a) x.moveTo(px, Y(v2)); else x.lineTo(px, Y(v2)); }
      x.strokeStyle = w.col; x.lineWidth = 3 * d; x.globalAlpha = .25; x.stroke(); x.globalAlpha = 1; x.lineWidth = 1.2 * d; x.stroke();
      x.lineTo(cw, ch); x.lineTo(0, ch); x.closePath(); const gr = x.createLinearGradient(0, 0, 0, ch); gr.addColorStop(0, w.col + '33'); gr.addColorStop(1, w.col + '00'); x.fillStyle = gr; x.fill();
    });
  };
  I.tickerItems = () => I.watch.map((w) => [probeLabel(w.probe), isFinite(w.buf.last()) ? si(w.buf.last(), 'V') : 'n/c']);

  // ---------------- UI ----------------
  const optsTB = () => TB.map((x) => `<option value="${x}" ${x === I.tdiv ? 'selected' : ''}>${si(x, 's')}</option>`).join('');
  I.mount = function (host, opts) {
    I.app = opts.app; I.toast = opts.toast;
    host.innerHTML = `<div id="scopeInst" class="inst">
      <div class="inst-top"><span class="inst-brand"><b>MSO-4</b><i>MIXED-SIGNAL · 4 CH · 8 D</i></span><span class="inst-sr mono" id="instSr">—</span><span class="inst-sp"></span>
        <button class="ib" data-a="probe" title="Arm probe: click a pin or wire (P)">⌁ PROBE</button><button class="ib" data-a="auto" title="Autoscale">AUTOSET</button><button class="ib" data-a="single" title="Single-shot capture">SINGLE</button><button class="ib rs" data-a="run" title="Run / Stop (space when focused)">RUN</button>
        <span class="ivs"></span><button class="ib tg" data-a="persist" title="Phosphor persistence">PERSIST</button><button class="ib tg" data-a="cursors" title="Cursor pair">CURSORS</button><button class="ib tg" data-a="fft" title="FFT spectrum of selected channel">FFT</button><button class="ib tg" data-a="la" title="Logic analyzer (ESP32 GPIO)">LOGIC</button><button class="ib" data-a="csv" title="Export visible window as CSV">CSV ⤓</button><button class="ib" data-a="clear" title="Clear capture">CLR</button></div>
      <div class="inst-body"><div class="inst-screen"><canvas id="scopeCv"></canvas><div class="inst-cur mono" id="instCur"></div></div>
        <div class="inst-side">
          <div class="isec"><div class="ish">HORIZONTAL</div><div class="irow"><button class="ik" data-a="tb-">−</button><select id="instTb">${optsTB()}</select><button class="ik" data-a="tb+">+</button></div><label class="irow"><span>POS</span><input type="range" id="instHp" min="0.05" max="0.95" step="0.05" value="${I.hpos}"></label></div>
          <div class="isec"><div class="ish">TRIGGER</div><div class="irow"><select id="instTs">${[1, 2, 3, 4].map((k) => `<option value="${k}">CH${k}</option>`).join('')}</select><div class="iseg" id="instSl"><button data-v="rise">↑</button><button data-v="fall">↓</button></div></div>
            <div class="iseg w" id="instTm"><button data-v="auto">AUTO</button><button data-v="normal">NORM</button></div><label class="irow"><span>LVL</span><input type="range" id="instTl" min="-5" max="10" step="0.01"><b class="mono" id="instTlv"></b></label></div>
          <div class="isec grow"><div class="ish">MEASURE <small id="instMs"></small></div><div id="instMeas" class="imeas mono"></div></div>
        </div></div>
      <div class="inst-ch" id="instCh"></div>
      <div class="inst-la" id="instLa" hidden><div class="la-bar"><span class="ish">LOGIC · ESP32 GPIO</span><span id="laSel"></span><span class="inst-sp"></span><label>DECODE <select id="laDec"><option value="none">none</option><option value="uart">UART</option><option value="i2c">I²C</option></select></label><span id="laDecOpt"></span></div><canvas id="laCv"></canvas></div>
    </div>`;
    cv = $('#scopeCv'); g = cv.getContext('2d'); ph = document.createElement('canvas'); pg = ph.getContext('2d'); la = $('#laCv'); lg = la.getContext('2d');
    const inst = $('#scopeInst');
    inst.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
      if (a === 'probe') I.arm(!I.armed);
      else if (a === 'run') { if (I.frozen) { I.frozen = null; I.run = true; I.single = false; } else I.freeze(); }
      else if (a === 'single') { I.frozen = null; I.run = true; I.single = true; I.trigT = null; }
      else if (a === 'persist') I.persist = !I.persist; else if (a === 'cursors') I.cursors = !I.cursors; else if (a === 'fft') I.fft = !I.fft;
      else if (a === 'la') { I.la = !I.la; $('#instLa').hidden = !I.la; }
      else if (a === 'csv') I.exportCsv(); else if (a === 'clear') I.clearAll(); else if (a === 'auto') I.autoset();
      else if (a === 'tb-' || a === 'tb+') { const i = TB.indexOf(I.tdiv); I.tdiv = TB[Math.max(0, Math.min(TB.length - 1, i + (a === 'tb+' ? 1 : -1)))]; }
      I.renderUi();
    });
    $('#instTb').onchange = (e) => { I.tdiv = +e.target.value; I.renderUi(); };
    $('#instHp').oninput = (e) => { I.hpos = +e.target.value; };
    $('#instTs').onchange = (e) => { I.trig.src = +e.target.value; I.renderUi(); };
    $('#instSl').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { I.trig.slope = b.dataset.v; I.renderUi(); } };
    $('#instTm').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { I.trig.mode = b.dataset.v; I.renderUi(); } };
    $('#instTl').oninput = (e) => { I.trig.level = +e.target.value; $('#instTlv').textContent = si(I.trig.level, 'V'); };
    $('#laDec').onchange = (e) => { I.decoder.kind = e.target.value; if (e.target.value === 'i2c') { I.decoder.a = Math.max(0, I.lanes.findIndex((l) => l.gpio === 21)); I.decoder.b = Math.max(0, I.lanes.findIndex((l) => l.gpio === 22)); } I.renderUi(); };
    $('#instCh').addEventListener('click', (e) => { const card = e.target.closest('[data-ch]'); if (!card) return; const k = +card.dataset.ch, c = I.ch[k - 1], b = e.target.closest('[data-c]');
      if (b && b.dataset.c === 'x') { I.unprobe(k); return; } if (b && b.dataset.c === 'pin' && c.probe) { I.watchProbe(c.probe); return; } if (b && b.dataset.c === 'arm') { I.arm(true, k); return; }
      if (b && (b.dataset.c === 'v-' || b.dataset.c === 'v+')) { const i = VD.indexOf(c.vdiv); c.vdiv = VD[Math.max(0, Math.min(VD.length - 1, i + (b.dataset.c === 'v+' ? 1 : -1)))]; }
      if (b && (b.dataset.c === 'p-' || b.dataset.c === 'p+')) c.pos += b.dataset.c === 'p+' ? 0.5 : -0.5;
      I.sel = k; I.renderUi(); });
    $('#instCh').addEventListener('change', (e) => { const card = e.target.closest('[data-ch]'); if (!card) return; const c = I.ch[+card.dataset.ch - 1]; if (e.target.dataset.c === 'vd') c.vdiv = +e.target.value; I.renderUi(); });
    // wheel on screen: timebase; shift+wheel: selected channel V/div
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const up = e.deltaY > 0; if (e.shiftKey) { const c = I.ch[I.sel - 1], i = VD.indexOf(c.vdiv); c.vdiv = VD[Math.max(0, Math.min(VD.length - 1, i + (up ? 1 : -1)))]; } else { const i = TB.indexOf(I.tdiv); I.tdiv = TB[Math.max(0, Math.min(TB.length - 1, i + (up ? 1 : -1)))]; } I.renderUi(); }, { passive: false });
    // cursor dragging
    let drag = -1;
    cv.addEventListener('pointerdown', (e) => { if (!I.cursors) return; const r = cv.getBoundingClientRect(), A = plotArea(), fx = ((e.clientX - r.left) * dpr - A.x) / A.w; drag = Math.abs(fx - I.cur[0]) < Math.abs(fx - I.cur[1]) ? 0 : 1; I.cur[drag] = Math.max(0, Math.min(1, fx)); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (drag < 0) return; const r = cv.getBoundingClientRect(), A = plotArea(); I.cur[drag] = Math.max(0, Math.min(1, ((e.clientX - r.left) * dpr - A.x) / A.w)); });
    cv.addEventListener('pointerup', () => { drag = -1; });
    // stage click while armed -> probe (capture phase, before the editor starts a wire)
    const st = $('#stage');
    st.addEventListener('pointerdown', (e) => {
      if (!I.armed) return; const ed = I.app.editor; const pin = ed.pinAtEvent(e) || (ed.pinNear ? ed.pinNear(ed.toWorld(e), e, 9) : null); const wEl = !pin && e.target.closest && e.target.closest('.wire');
      let pr = null;
      if (pin && pin.part) pr = pin.part.type === 'scope' ? { kind: 'probe', ch: +pin.part.props.ch || 1 } : { kind: 'pin', part: pin.part.id, pin: pin.pin.name, label: ed.pinLabel ? ed.pinLabel(pin) : null };
      else if (wEl) pr = { kind: 'wire', wire: wEl.dataset.wid };
      if (!pr) return; e.stopPropagation(); e.preventDefault();
      if (pin && pin.part && pin.part.type === 'breadboard') pr.label = 'net @ ' + pr.pin;
      I.probe(pr, I.armCh); I.arm(false); if (I.onProbed) I.onProbed();
    }, true);
    window.addEventListener('keydown', (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (e.key === 'Escape' && I.armed) I.arm(false); else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && I.visible()) I.arm(!I.armed); });
    const se = $('#telStrip'); if (se) se.addEventListener('click', (e) => { const x = e.target.closest('[data-x]'), s2 = e.target.closest('[data-s]'); if (x) I.unwatch(+x.dataset.x); else if (s2) { const w = I.watch[+s2.dataset.s]; if (w) I.probe(Object.assign({}, w.probe)); } });
    if (window.ResizeObserver) { new ResizeObserver(() => size()).observe(cv); new ResizeObserver(() => I.app.editor && I.app.editor.applyView && I.app.editor.applyView()).observe(st); }   // dock grows with the scope tab: keep the editor's view mapping in sync
    I.renderUi(); loop();
  };
  I.arm = function (v, k) { I.armed = v; I.armCh = v ? k : undefined; document.body.classList.toggle('probe-armed', v); I.renderUi(); if (v && I.onArm) I.onArm(); };
  I.visible = () => { const el = $('#scopeInst'); return !!(el && el.offsetParent !== null && el.getBoundingClientRect().height > 40); };
  I.autoset = function () {
    for (const c of I.ch) if (c.on) { const m = measure(c.buf, I.lastT - Math.max(span(), 1), I.lastT); if (!m) continue; const pp = Math.max(m.pp, 0.02); c.vdiv = VD.find((x) => pp / x <= 6) || 5; c.pos = -((m.max + m.min) / 2) / c.vdiv; c.pos = Math.round(c.pos * 2) / 2; if (c.k === I.trig.src) I.trig.level = +((m.max + m.min) / 2).toFixed(3); }
    const tc = I.ch[I.trig.src - 1]; if (tc && tc.on) { const m = measure(tc.buf, I.lastT - 4, I.lastT); if (m && isFinite(m.f)) I.tdiv = TB.find((x) => x * HDIV >= 2.5 / m.f) || 1; }
    I.frozen = null; I.run = true; I.single = false;
  };
  I.exportCsv = function () {
    const w = I.win || computeWindow(), on = I.ch.filter((c) => c.on); if (!on.length) { I.toast && I.toast('No channels to export', true); return; }
    const base = bufOf(on[0]), a = base.first(w.t0), z = base.first(w.t1); const rows = ['time_s,' + on.map((c) => `CH${c.k} ${probeLabel(c.probe)} (V)`.replace(/,/g, ' ')).join(',')];
    for (let k = a; k < z; k++) { const t = base.T(k); rows.push(t.toPrecision(10) + ',' + on.map((c) => { const v = bufOf(c).at(t); return isFinite(v) ? v.toPrecision(6) : ''; }).join(',')); }
    const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), u = URL.createObjectURL(blob), aa = document.createElement('a'); aa.href = u; aa.download = `scope_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`; document.body.appendChild(aa); aa.click(); aa.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
    I.lastCsv = rows; I.toast && I.toast(`Exported ${rows.length - 1} samples × ${on.length} ch`);
  };
  I.renderUi = function () {
    const inst = $('#scopeInst'); if (!inst) return;
    const tog = (a, v) => { const b = inst.querySelector(`[data-a="${a}"]`); if (b) b.classList.toggle('on', !!v); };
    tog('persist', I.persist); tog('cursors', I.cursors); tog('fft', I.fft); tog('la', I.la); tog('probe', I.armed); tog('single', I.single);
    const rb = inst.querySelector('[data-a=run]'); rb.textContent = I.frozen ? 'STOPPED' : 'RUNNING'; rb.classList.toggle('stop', !!I.frozen);
    $('#instTb').innerHTML = optsTB(); $('#instTs').value = String(I.trig.src); $('#instTl').value = I.trig.level; $('#instTlv').textContent = si(I.trig.level, 'V');
    $$('#instSl [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === I.trig.slope)); $$('#instTm [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === I.trig.mode));
    $('#instCh').innerHTML = I.ch.map((c) => `<div class="ich ${c.on ? 'on' : ''} ${I.sel === c.k ? 'sel' : ''}" data-ch="${c.k}" style="--c:${c.col}"><div class="ich-h"><b>CH${c.k}</b><span class="ich-src">${c.on ? esc(probeLabel(c.probe)) : 'unassigned'}</span>${c.on ? `<button data-c="pin" title="Pin to telemetry strip">📌</button><button data-c="x" title="Remove probe">×</button>` : `<button data-c="arm" title="Arm probe for this channel">⌁</button>`}</div>
      <div class="ich-r"><button data-c="v-">−</button><select data-c="vd">${VD.map((x) => `<option value="${x}" ${x === c.vdiv ? 'selected' : ''}>${si(x, 'V')}/div</option>`).join('')}</select><button data-c="v+">+</button><span class="ich-p">POS</span><button data-c="p-">▼</button><button data-c="p+">▲</button></div><div class="ich-v mono" data-live="${c.k}">—</div></div>`).join('');
    $('#laSel').innerHTML = I.lanes.map((l, i) => `<select data-lane="${i}" title="D${i} source">${Array.from({ length: 40 }, (_, gg) => gg).filter((gg) => ![6, 7, 8, 9, 10, 11, 20, 24, 28, 29, 30, 31, 37, 38].includes(gg)).map((gg) => `<option value="${gg}" ${gg === l.gpio ? 'selected' : ''}>D${i}:${gg}</option>`).join('')}</select>`).join('');
    $$('#laSel select').forEach((s) => s.onchange = () => { const l = I.lanes[+s.dataset.lane]; l.gpio = +s.value; l.buf.clear(); l.lastV = -1; });
    const d = I.decoder, laneOpt = (k) => I.lanes.map((l, i) => `<option value="${i}" ${i === d[k] ? 'selected' : ''}>D${i}</option>`).join('');
    $('#laDec').value = d.kind;
    $('#laDecOpt').innerHTML = d.kind === 'uart' ? `RX <select data-d="a">${laneOpt('a')}</select> BAUD <select data-d="baud">${[300, 1200, 2400, 9600, 19200, 115200].map((x) => `<option ${x === d.baud ? 'selected' : ''}>${x}</option>`).join('')}</select>` : d.kind === 'i2c' ? `SDA <select data-d="a">${laneOpt('a')}</select> SCL <select data-d="b">${laneOpt('b')}</select>` : '';
    $$('#laDecOpt select').forEach((s) => s.onchange = () => { d[s.dataset.d] = +s.value; });
  };
  function updateSide() {
    // sample rate estimate
    const c = I.ch.find((q) => q.on && q.buf.n > 20); if (c) { const b = c.buf, k = b.n - 1, j = Math.max(0, k - 200); I.sr = (k - j) / ((b.T(k) - b.T(j)) || 1); }
    const sr = $('#instSr'); if (sr) sr.textContent = `${I.sr ? si(I.sr, 'S/s') : '— S/s'} · Δt ${I.sr ? si(1 / I.sr, 's') : '—'} · REC ${si(I.ch.reduce((m, q) => Math.max(m, q.buf.n), 0), 'pts', 3).replace(' pts', ' pts')}`;
    const w = I.win; if (!w) return; let h = '';
    for (const q of I.ch) if (q.on) { const m = measure(bufOf(q), w.t0, w.t1); const lv = $(`[data-live="${q.k}"]`); if (lv) lv.textContent = isFinite(bufOf(q).last()) ? si(bufOf(q).last(), 'V', 4) : 'n/c';
      h += `<div class="im" style="--c:${q.col}"><b>CH${q.k}</b>${m ? `<span>Vpp</span><i>${si(m.pp, 'V')}</i><span>Vmax</span><i>${si(m.max, 'V')}</i><span>Vmin</span><i>${si(m.min, 'V')}</i><span>Vavg</span><i>${si(m.avg, 'V')}</i><span>Vrms</span><i>${si(m.rms, 'V')}</i><span>Freq</span><i>${si(m.f, 'Hz')}</i><span>Period</span><i>${si(1 / m.f, 's')}</i><span>Duty</span><i>${isFinite(m.duty) ? (m.duty * 100).toFixed(1) + ' %' : '—'}</i>` : '<span>no data in window</span>'}</div>`; }
    $('#instMeas').innerHTML = h || '<div class="muted">Probe a signal to see Vpp, Vrms, frequency, duty…</div>';
    const cr = $('#instCur'); if (cr) { cr.hidden = !I.curRead; if (I.curRead) cr.innerHTML = I.curRead.map(([k, v]) => `<span><b>${k}</b>${v}</span>`).join(''); }
  }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (!cv) return;
    const vis = I.visible(); I._vis = vis;
    if (vis) { try { draw(); } catch (e) { console.error(e); } if (!ts || ts - lastFrame > 150) { lastFrame = ts || 0; try { updateSide(); } catch (e) { console.error(e); } } }
    if (!I._st || (ts || 0) - I._st > 66) { I._st = ts || 0; if (I.watch.length) I.renderStrip(false); }
  }
  I.state = () => ({ ch: I.ch.map((c) => ({ k: c.k, on: c.on, n: c.buf.n, label: c.on ? probeLabel(c.probe) : null, last: c.buf.last(), vdiv: c.vdiv })), status: I.status, tdiv: I.tdiv, sr: I.sr, win: I.win, frozen: !!I.frozen, watch: I.watch.map((w) => ({ label: probeLabel(w.probe), n: w.buf.n, last: w.buf.last() })), lanes: I.lanes.map((l) => ({ gpio: l.gpio, n: l.buf.n })) });
  I.measure = (k) => { const c = I.ch[k - 1], w = I.win || computeWindow(); return measure(bufOf(c), w.t0, w.t1); };
  I._test = { Ring, measure, spectrum, fft, findTrigger: (c, t) => findTrigger(c, t), decode: (w) => decode(w) };
  if (typeof module !== 'undefined' && module.exports) module.exports = I;
})(typeof window !== 'undefined' ? window : globalThis);
