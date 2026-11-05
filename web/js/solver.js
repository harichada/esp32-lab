/* Circuit solver: Modified Nodal Analysis + Newton-Raphson (nonlinear devices) + backward-Euler transient.
 * Pure JS, no DOM. Works in browser (window.Solver) and Node (module.exports).
 *
 * Netlist: { nodes: N (node 0 = ground), elements: [...] }.  Element kinds:
 *   R  {a,b,r}                    resistor
 *   V  {a,b,v, rs?}               ideal voltage source (a = +); adds a branch current unknown (current a->b through source = i)
 *   I  {a,b,i}                    current source pushing i from a to b through the external circuit (enters node b)
 *   C  {a,b,c}                    capacitor (BE companion in transient, open in DC unless dcShort)
 *   D  {a,k,is,n,rs?,bv?}         Shockley diode (+ optional reverse breakdown bv for zener)
 *   Q  {c,b,e,type:'npn'|'pnp', is, bf, br}   Ebers-Moll transport model
 *   M  {d,g,s,type:'n'|'p', vth, k, lambda}   square-law MOSFET
 *   LDO {in,out,gnd,vreg,drop}    behavioural regulator: Vout = clamp(Vin - drop, 0, vreg), current drawn from VIN
 *   G  {a,b,g}                    conductance (stamped like R)
 *   OA {p,n,o,vp,vn,a,ro,hi,lo,oc} behavioural op-amp / comparator output (tanh-limited between rails; oc = open collector)
 *   L  {a,b,l,st}                 inductor (backward Euler companion; current kept in st.iL across rebuilds)
 *   PT {c,e,il}                   phototransistor collector current il·tanh(Vce/0.15)
 */
(function (root) {
  const VT = 0.025852;
  function sexp(x) { return x < 80 ? Math.exp(x) : Math.exp(80) * (1 + x - 80); }   // overflow-safe exp

  class Circuit {
    constructor(nNodes) { this.n = nNodes; this.el = []; this.gmin = 1e-12; this.x = null; this.t = 0; }
    add(e) { this.el.push(e); return e; }
    // unknown vector layout: [v1..v(n-1), branch currents...]
    _index() {
      let k = this.n - 1;
      for (const e of this.el) if (e.kind === 'V' || e.kind === 'LDO') e._br = k++;
      this.size = k;
      if (!this.x || this.x.length !== k) { this.x = new Float64Array(k); }
    }
    v(node, x = this.x) { return node > 0 ? x[node - 1] : 0; }

    _stamp(A, z, x, h, dc) {
      const n = this.size;
      A.fill(0); z.fill(0);
      const V = (nd) => (nd > 0 ? x[nd - 1] : 0);
      const addA = (i, j, g) => { if (i > 0 && j > 0) A[(i - 1) * n + (j - 1)] += g; };
      const addG = (a, b, g) => { addA(a, a, g); addA(b, b, g); addA(a, b, -g); addA(b, a, -g); };
      const addI = (a, b, i) => { if (a > 0) z[a - 1] -= i; if (b > 0) z[b - 1] += i; };   // current i flowing a->b inside element
      const addAr = (r, c, g) => { A[r * n + c] += g; };
      for (let i = 1; i < this.n; i++) A[(i - 1) * n + (i - 1)] += this.gmin;  // keep floating nodes solvable
      for (const e of this.el) {
        switch (e.kind) {
          case 'R': addG(e.a, e.b, 1 / Math.max(e.r, 1e-6)); break;
          case 'G': addG(e.a, e.b, e.g); break;
          case 'I': addI(e.a, e.b, e.i); break;
          case 'V': {
            const k = e._br;
            if (e.a > 0) { addAr(e.a - 1, k, 1); addAr(k, e.a - 1, 1); }
            if (e.b > 0) { addAr(e.b - 1, k, -1); addAr(k, e.b - 1, -1); }
            if (e.rs) addAr(k, k, -e.rs);
            z[k] += e.v; break;
          }
          case 'C': {
            if (dc) { if (e.dcShort) addG(e.a, e.b, 1e3); break; }
            const g = e.c / h; addG(e.a, e.b, g);
            addI(e.a, e.b, -g * (e.vprev || 0));     // Ieq = g*vprev pushes current into a
            break;
          }
          case 'D': {
            const vd = V(e.a) - V(e.k), nvt = e.n * VT;
            let id = e.is * (sexp(vd / nvt) - 1), gd = e.is * sexp(vd / nvt) / nvt;
            if (e.bv) {   // reverse breakdown (zener)
              const vr = -vd - e.bv, ex = sexp(vr / (VT * (e.nbv || 1))), ib = e.ibv || 1e-3;   // ibv flows at exactly Vz
              id -= ib * ex; gd += ib * ex / (VT * (e.nbv || 1));
            }
            gd += 1e-12;
            addG(e.a, e.k, gd); addI(e.a, e.k, id - gd * vd);
            break;
          }
          case 'Q': {
            const s = e.type === 'pnp' ? -1 : 1;
            const vbe = s * (V(e.b) - V(e.e)), vbc = s * (V(e.b) - V(e.c));
            const ef = sexp(vbe / VT), er = sexp(vbc / VT);
            const If = e.is * (ef - 1), Ir = e.is * (er - 1);
            const gf = e.is * ef / VT, gr = e.is * er / VT;
            // terminal currents (into device, npn sign): ic = If - Ir - Ir/br ; ib = If/bf + Ir/br ; ie = -(ic+ib)
            const ic = If - Ir - Ir / e.br, ib = If / e.bf + Ir / e.br;
            // partials wrt vbe, vbc
            const dic_dvbe = gf, dic_dvbc = -gr - gr / e.br;
            const dib_dvbe = gf / e.bf, dib_dvbc = gr / e.br;
            // vbe = s(Vb-Ve), vbc = s(Vb-Vc). Linearize: i = i0 + J*dv
            const nodes = [e.c, e.b, e.e];
            const I = [s * ic, s * ib, -s * (ic + ib)];
            // d(i_term)/d(V_node) : for current in s-domain times s, and dv = s*dVnode => s*s = 1
            const dIc = [-dic_dvbc, dic_dvbe + dic_dvbc, -dic_dvbe];   // wrt Vc, Vb, Ve
            const dIb = [-dib_dvbc, dib_dvbe + dib_dvbc, -dib_dvbe];
            const dIe = dIc.map((v, i) => -(v + dIb[i]));
            const J = [dIc, dIb, dIe];
            const Vn = nodes.map(V);
            for (let r = 0; r < 3; r++) {
              const nr = nodes[r]; if (nr <= 0) continue;
              let ieq = I[r];
              for (let c = 0; c < 3; c++) { ieq -= J[r][c] * Vn[c]; addA(nr, nodes[c], J[r][c]); }
              z[nr - 1] -= ieq;     // current leaving node nr into device
            }
            // small junction leak conductances for robustness
            addG(e.b, e.e, 1e-12); addG(e.b, e.c, 1e-12);
            break;
          }
          case 'OA': {   // add-on parts (js/parts/ics.js)
            const vd = V(e.p) - V(e.n), o = e.o; if (!(o > 0)) break;
            if (e.oc) {
              const k = e.k || 2000, t = Math.tanh(k * vd), s = 0.5 * (1 - t), gon = 1 / (e.ro || 15), G = gon * s + 1e-9, vo = V(o) - V(e.vn);
              const c = gon * (-0.5 * k * (1 - t * t)) * vo, I0 = G * vo;
              addA(o, o, G); addA(o, e.vn, -G); addA(o, e.p, c); addA(o, e.n, -c);
              z[o - 1] -= I0 - G * vo - c * vd;
            } else {
              const lo = V(e.vn) + (e.lo || 0.02), hi = Math.max(lo + 0.02, V(e.vp) - (e.hi || 1.5)), mid = (lo + hi) / 2, half = (hi - lo) / 2, A = e.a || 2e4;
              // limit the tanh argument's change per Newton iteration (like pn-junction limiting) so high gain can't bang between rails
              let u = A * vd / half; const pb = Math.min(4, Math.max(-4, e._u || 0)); if (!((u > 4 && pb >= 4) || (u < -4 && pb <= -4))) u = Math.min(pb + 1.5, Math.max(pb - 1.5, u)); e._u = u;
              const ve = u * half / A, t = Math.tanh(u), vt = mid + half * t, dv = A * (1 - t * t) + 1e-9, g = 1 / (e.ro || 20);
              addA(o, o, g); addA(o, e.p, -g * dv); addA(o, e.n, g * dv);
              z[o - 1] += g * (vt - dv * ve);
            }
            break;
          }
          case 'L': {
            if (dc) { addG(e.a, e.b, 1e3); break; }
            const g = h / Math.max(e.l, 1e-12); addG(e.a, e.b, g); addI(e.a, e.b, e.iprev || 0); break;
          }
          case 'PT': {
            const vce = V(e.c) - V(e.e), t = Math.tanh(vce / 0.15), i = e.il * t, g = e.il * (1 - t * t) / 0.15 + 1e-12;
            addG(e.c, e.e, g); addI(e.c, e.e, i - g * vce); break;
          }
          case 'M': {
            const s = e.type === 'p' ? -1 : 1;
            let d = e.d, so = e.s;
            let vgs = s * (V(e.g) - V(so)), vds = s * (V(d) - V(so));
            let swap = false;
            if (vds < 0) { swap = true; [d, so] = [so, d]; vgs = s * (V(e.g) - V(so)); vds = -vds; }
            const vov = vgs - e.vth, lam = e.lambda || 0.01;
            let id = 0, gm = 0, gds = 0;
            if (vov > 0) {
              if (vds < vov) { id = e.k * (vov * vds - vds * vds / 2) * (1 + lam * vds); gm = e.k * vds * (1 + lam * vds); gds = e.k * (vov - vds) * (1 + lam * vds) + e.k * (vov * vds - vds * vds / 2) * lam; }
              else { id = 0.5 * e.k * vov * vov * (1 + lam * vds); gm = e.k * vov * (1 + lam * vds); gds = 0.5 * e.k * vov * vov * lam; }
            }
            gds += 1e-9;
            // id flows d -> s (n-type sense). Linearize: id = id0 + gm*(dvgs) + gds*(dvds)
            const Vd = V(d), Vs = V(so), Vg = V(e.g);
            const ieq = s * (id - gm * vgs - gds * vds);
            addA(d, d, gds); addA(d, so, -gds - gm); addA(d, e.g, gm);
            addA(so, d, -gds); addA(so, so, gds + gm); addA(so, e.g, -gm);
            if (d > 0) z[d - 1] -= ieq; if (so > 0) z[so - 1] += ieq;
            e._id = s * id * (swap ? -1 : 1);
            break;
          }
          case 'LDO': {
            const k = e._br, vin = V(e.in) - V(e.gnd);
            const raw = vin - e.drop;
            let vt, dv;
            if (raw >= e.vreg) { vt = e.vreg; dv = 0; } else if (raw > 0) { vt = raw; dv = 1; } else { vt = 0; dv = 0; }
            // equation: V(out)-V(gnd) - dv*(Vin - Vgnd) = vt - dv*vin
            if (e.out > 0) addAr(k, e.out - 1, 1);
            if (e.gnd > 0) addAr(k, e.gnd - 1, -1 + dv);
            if (e.in > 0) addAr(k, e.in - 1, -dv);
            z[k] += vt - dv * vin;
            // branch current j leaves IN, enters OUT
            if (e.out > 0) addAr(e.out - 1, k, -1);
            if (e.in > 0) addAr(e.in - 1, k, 1);
            addG(e.in, e.gnd, 1 / 50000);  // quiescent
            break;
          }
        }
      }
    }

    solve(h = 1e-4, dc = false, maxIter = 120) {
      this._index();
      const n = this.size;
      if (!this._A || this._A.length !== n * n) { this._A = new Float64Array(n * n); this._z = new Float64Array(n); }
      const A = this._A, z = this._z;
      let x = this.x.slice();
      let ok = false, it = 0;
      for (; it < maxIter; it++) {
        this._stamp(A, z, x, h, dc);
        const xn = gauss(A, z, n);
        if (!xn) break;
        let maxd = 0;
        for (let i = 0; i < n; i++) {
          let d = xn[i] - x[i];
          if (i < this.n - 1) {           // node voltages: damp big steps (junction limiting)
            const lim = 0.6;
            if (d > lim) d = lim; else if (d < -lim) d = -lim;
          }
          x[i] += d; maxd = Math.max(maxd, Math.abs(d) / (1 + Math.abs(x[i]) * 1e-3));
        }
        if (maxd < 1e-7) { ok = true; break; }
      }
      this.x = x; this.converged = ok; this.iters = it;
      return ok;
    }
    // advance transient by h: solve, then latch capacitor voltages
    step(h) {
      const ok = this.solve(h, false);
      for (const e of this.el) if (e.kind === 'C') e.vprev = this.v(e.a) - this.v(e.b);
        else if (e.kind === 'L') { e.iprev = (e.iprev || 0) + h / Math.max(e.l, 1e-12) * (this.v(e.a) - this.v(e.b)); if (e.st) e.st.iL = e.iprev; }
      this.t += h;
      return ok;
    }
    dc() { return this.solve(1, true); }
    // current through element (a->b direction for 2-terminal)
    current(e) {
      const V = (nd) => this.v(nd);
      switch (e.kind) {
        case 'R': return (V(e.a) - V(e.b)) / e.r;
        case 'G': return (V(e.a) - V(e.b)) * e.g;
        case 'V': case 'LDO': return this.x[e._br];
        case 'I': return e.i;
        case 'C': return e.c / (this._h || 1e-4) * ((V(e.a) - V(e.b)) - (e.vprev || 0));
        case 'D': { const vd = V(e.a) - V(e.k); let id = e.is * (sexp(vd / (e.n * VT)) - 1); if (e.bv) id -= (e.ibv || 1e-3) * sexp((-vd - e.bv) / (VT * (e.nbv || 1))); return id; }
        case 'Q': {
          const s = e.type === 'pnp' ? -1 : 1, vbe = s * (V(e.b) - V(e.e)), vbc = s * (V(e.b) - V(e.c));
          const If = e.is * (sexp(vbe / VT) - 1), Ir = e.is * (sexp(vbc / VT) - 1);
          return { ic: s * (If - Ir - Ir / e.br), ib: s * (If / e.bf + Ir / e.br) };
        }
        case 'M': return e._id || 0;
        case 'L': return (e.iprev || 0) + (this._h || 1e-4) / Math.max(e.l, 1e-12) * (V(e.a) - V(e.b));
        case 'PT': return e.il * Math.tanh((V(e.c) - V(e.e)) / 0.15);
        case 'OA': { const vd = V(e.p) - V(e.n); if (e.oc) return (1 / (e.ro || 15) * 0.5 * (1 - Math.tanh((e.k || 2000) * vd)) + 1e-9) * (V(e.o) - V(e.vn)); const lo = V(e.vn) + (e.lo || 0.02), hi = Math.max(lo + 0.02, V(e.vp) - (e.hi || 1.5)), half = (hi - lo) / 2; return (V(e.o) - ((lo + hi) / 2 + half * Math.tanh((e.a || 2e4) * vd / half))) / (e.ro || 20); }
      }
      return 0;
    }
  }

  // dense Gaussian elimination with partial pivoting (copies inputs)
  function gauss(A0, b0, n) {
    const A = Float64Array.from(A0), b = Float64Array.from(b0);
    for (let c = 0; c < n; c++) {
      let p = c, mx = Math.abs(A[c * n + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > mx) { mx = v; p = r; } }
      if (mx < 1e-18) { A[c * n + c] = 1e-18; mx = 1e-18; p = c; }
      if (p !== c) {
        for (let k = c; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
        const t = b[c]; b[c] = b[p]; b[p] = t;
      }
      const piv = A[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c] / piv; if (f === 0) continue;
        for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
        b[r] -= f * b[c];
      }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
      x[r] = s / A[r * n + r];
      if (!isFinite(x[r])) return null;
    }
    return x;
  }

  // Diode parameter helper: choose Is so that I(vf) = ifwd with emission coefficient n
  function diodeFromVf(vf, ifwd = 0.02, n = 2) { return { is: ifwd / Math.exp(vf / (n * VT)), n }; }

  const api = { Circuit, gauss, diodeFromVf, VT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Solver = api;
})(typeof window !== 'undefined' ? window : globalThis);
