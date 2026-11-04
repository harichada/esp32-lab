/* SVG schematic/breadboard editor: palette drop, drag, snapping to the 0.1" grid (and breadboard holes),
 * wires with bend points and colours, rotate/delete, undo/redo, pan/zoom, hover tooltips. */
(function (root) {
  const P = root.Parts, G = 10, NS = 'http://www.w3.org/2000/svg';
  const snap = (v) => Math.round(v / G) * G;
  const WIRE_COLORS = { green: '#3ddc84', red: '#ff4d4d', black: '#1b1b1b', blue: '#4d8dff', yellow: '#ffd23d', orange: '#ff9a3d', white: '#e8e8e8', purple: '#b06bff', gray: '#9aa3b2', brown: '#a0632e' };
  class Editor {
    constructor(svg, hooks) {
      this.svg = svg; this.hooks = hooks; this.lParts = svg.querySelector('#lParts'); this.lWires = svg.querySelector('#lWires'); this.lOver = svg.querySelector('#lOver');
      this.view = { x: -40, y: -40, s: 1 }; this.sel = null; this.undoS = []; this.redoS = []; this.mode = null; this.wireColor = 'auto'; this.partEls = new Map(); this.svgCache = new Map(); this.ortho = true; this._pinIdx = null; this.hoverPin = null;
      this.lOver.innerHTML = '<g class="ov-hl"></g><g class="ov-wire"></g>'; this.ovHl = this.lOver.firstChild; this.ovWire = this.lOver.lastChild;
      this.hintEl = svg.parentElement && svg.parentElement.querySelector('.hint'); this.menu = null;
      this._bind();
    }
    setProject(proj) { this.proj = proj; this.sel = null; this.undoS = []; this.redoS = []; this.render(); }
    snapshot() { return JSON.stringify({ parts: this.proj.parts, wires: this.proj.wires }); }
    push() { if (this.hooks.beforeEdit) this.hooks.beforeEdit(); this.undoS.push(this.snapshot()); if (this.undoS.length > 200) this.undoS.shift(); this.redoS = []; }
    _restore(s) { const o = JSON.parse(s); this.proj.parts = o.parts; this.proj.wires = o.wires; this.sel = null; this.render(); this.hooks.changed(true); }
    undo() { if (!this.undoS.length) return; this.redoS.push(this.snapshot()); this._restore(this.undoS.pop()); }
    redo() { if (!this.redoS.length) return; this.undoS.push(this.snapshot()); this._restore(this.redoS.pop()); }
    // ---------- coordinates ----------
    applyView() { const r = this.svg.getBoundingClientRect(); this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${r.width / this.view.s} ${r.height / this.view.s}`); }
    toWorld(ev) { const r = this.svg.getBoundingClientRect(); return { x: this.view.x + (ev.clientX - r.left) / this.view.s, y: this.view.y + (ev.clientY - r.top) / this.view.s }; }
    fit() {
      const bb = this.bounds(); const r = this.svg.getBoundingClientRect(); if (!bb || !r.width) return;
      const s = Math.min(3, Math.max(0.2, Math.min(r.width / (bb.w + 80), r.height / (bb.h + 80))));
      this.view = { s, x: bb.x - 40 - (r.width / s - bb.w - 80) / 2, y: bb.y - 40 - (r.height / s - bb.h - 80) / 2 }; this.applyView();
    }
    bounds() {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
      for (const p of this.proj.parts) { const d = P.T[p.type]; if (!d) continue; const sz = d.size(p); const c = [[-30, -50], [sz.w + 30, sz.h + 30]]; for (const [a, b] of c) { const [rx, ry] = P.rotPt(a, b, p.rot || 0); add(p.x + rx, p.y + ry); } }
      for (const w of this.proj.wires) { add(w.a.x, w.a.y); add(w.b.x, w.b.y); for (const q of w.pts || []) add(q.x, q.y); }
      return x0 > x1 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    // ---------- rendering ----------
    partSvg(p) { const d = P.T[p.type]; const st = this.hooks.state ? this.hooks.state(p) : null; try { return d.svg(p, st); } catch (e) { return `<text class="plbl">${p.type}?</text>`; } }
    render() {
      this._pinIdx = null; this.lParts.innerHTML = ''; this.partEls.clear(); this.svgCache.clear();
      const sorted = [...this.proj.parts].sort((a, b) => ((P.T[a.type] || {}).layer ?? 2) - ((P.T[b.type] || {}).layer ?? 2));
      for (const p of sorted) {
        if (!P.T[p.type]) continue;
        const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'part' + (this.sel && this.sel.part === p.id ? ' sel' : '') + (P.T[p.type].interactive || P.T[p.type].click ? ' inter' : '')); g.dataset.id = p.id;
        g.setAttribute('transform', `translate(${p.x},${p.y}) rotate(${(p.rot || 0) * 90})`);
        const html = this.partSvg(p); g.innerHTML = html; this.svgCache.set(p.id, html);
        this.lParts.appendChild(g); this.partEls.set(p.id, g);
      }
      this.renderWires();
    }
    autoColor(a, b) {
      const nm = (q) => q ? String((q.pin && q.pin.name) || q.name || '') : '', n = [nm(a), nm(b)].join(' ').toUpperCase();
      if (/GND|VSS|(^|\s)-(\s|$)|(^|\s)[TB]N\d+/.test(n)) return 'black';
      if (/(^|\s)[TB]P\d+/.test(n)) return 'red';
      if (/3V3|5V|VIN|VCC|VDD|V\+|(^|\s)\+(\s|$)/.test(n)) return 'red';
      const pal = ['green', 'blue', 'yellow', 'orange', 'purple', 'white', 'brown', 'gray'];
      return pal[(this.proj.wires.length) % pal.length];
    }
    static roundPath(pts, r = 6) {
      if (pts.length < 3) return 'M' + pts.map((q) => `${q.x} ${q.y}`).join(' L');
      let d = `M${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length - 1; i++) {
        const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
        const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const rr = Math.min(r, l1 / 2, l2 / 2); if (rr < 0.5) { d += ` L${p1.x} ${p1.y}`; continue; }
        const ax = p1.x + (p0.x - p1.x) * rr / l1, ay = p1.y + (p0.y - p1.y) * rr / l1, bx = p1.x + (p2.x - p1.x) * rr / l2, by = p1.y + (p2.y - p1.y) * rr / l2;
        d += ` L${ax.toFixed(2)} ${ay.toFixed(2)} Q${p1.x} ${p1.y} ${bx.toFixed(2)} ${by.toFixed(2)}`;
      }
      const e = pts[pts.length - 1]; return d + ` L${e.x} ${e.y}`;
    }
    renderWires() {
      let s = '';
      for (const w of this.proj.wires) {
        const pts = [w.a, ...(w.pts || []), w.b].map((q) => `${q.x},${q.y}`).join(' ');
        const dP = Editor.roundPath([w.a, ...(w.pts || []), w.b]), col = WIRE_COLORS[w.color] || w.color || '#3ddc84', sel = this.sel && this.sel.wire === w.id;
        const hd = sel ? (w.pts || []).map((q, i) => `<circle cx="${q.x}" cy="${q.y}" r="3.2" class="w-bend" data-bend="${i}"/>`).join('') : '';
        s += `<g class="wire${sel ? ' sel' : ''}" data-wid="${w.id}"><path d="${dP}" class="w-hit"/><path d="${dP}" class="w-shadow"/><path d="${dP}" class="w-line" style="stroke:${col}"/><path d="${dP}" class="w-hl"/><path d="${dP}" class="w-flow"/><circle cx="${w.a.x}" cy="${w.a.y}" r="2.2" class="w-end" style="fill:${col}"/><circle cx="${w.b.x}" cy="${w.b.y}" r="2.2" class="w-end" style="fill:${col}"/>${hd}</g>`;
      }
      this.lWires.innerHTML = s;
    }
    // re-render only parts whose svg changed (LED brightness, button state, meters)
    refreshDynamic() {
      for (const p of this.proj.parts) {
        const g = this.partEls.get(p.id); if (!g || p.type === 'breadboard') continue;
        const html = this.partSvg(p); if (this.svgCache.get(p.id) !== html) { g.innerHTML = html; this.svgCache.set(p.id, html); }
      }
    }
    select(s) { this.sel = s; for (const [id, g] of this.partEls) g.classList.toggle('sel', !!(s && s.part === id)); this.renderWires(); this.hooks.selected(s); if (!this.mode) this.setHint(); }
    // ---------- model ops ----------
    addPart(type, x, y) {
      const d = P.T[type]; this.push();
      let n = 1; const pre = (d.prefix || type.slice(0, 3).toUpperCase()); while (this.proj.parts.some((p) => p.id === pre + n)) n++;
      const p = { id: pre + n, type, x: snap(x), y: snap(y), rot: 0, props: JSON.parse(JSON.stringify(d.props || {})) };
      this.proj.parts.push(p); this.render(); this.select({ part: p.id }); this.hooks.changed(true); return p;
    }
    part(id) { return this.proj.parts.find((p) => p.id === id); }
    rotateSel() { if (!this.sel || !this.sel.part) return; const p = this.part(this.sel.part); this.push(); p.rot = ((p.rot || 0) + 1) & 3; this.render(); this.hooks.changed(true); }
    deleteSel() {
      if (!this.sel) return; this.push();
      if (this.sel.part) this.proj.parts = this.proj.parts.filter((p) => p.id !== this.sel.part);
      if (this.sel.wire) this.proj.wires = this.proj.wires.filter((w) => w.id !== this.sel.wire);
      this.sel = null; this.render(); this.hooks.changed(true); this.hooks.selected(null);
    }
    setWireColor(c) { this.wireColor = c; if (this.sel && this.sel.wire) { const w = this.proj.wires.find((q) => q.id === this.sel.wire); if (w) { this.push(); w.color = c; this.renderWires(); } } }
    pinIndex() {   // world positions of every pin (non-breadboard first so they win ties with the hole underneath)
      if (this._pinIdx) return this._pinIdx; const a = [];
      for (const p of this.proj.parts) { const d = P.T[p.type]; if (!d) continue; for (const pin of d.pins(p)) a.push({ part: p, pin, pos: P.pinWorld(p, pin), bb: p.type === 'breadboard' }); }
      a.sort((x, y) => x.bb - y.bb); return (this._pinIdx = a);
    }
    pinNear(w, ev, maxR) {   // nearest pin within a finger/cursor-sized radius (bigger for touch, constant on screen)
      const px = ev && ev.pointerType === 'touch' ? 22 : 11, r = Math.min(maxR || 14, Math.max(4, px / this.view.s)); let best = null, bd = r * r;
      for (const q of this.pinIndex()) { const dx = q.pos.x - w.x, dy = q.pos.y - w.y, d = dx * dx + dy * dy + (q.bb ? 0.5 : 0); if (d < bd) { bd = d; best = q; } }
      return best;
    }
    pinAtEvent(ev) {
      const el = ev.target && ev.target.closest && ev.target.closest('[data-pin]');
      if (el) { const g = el.closest('.part'); const p = g && this.part(g.dataset.id); const pin = p && P.T[p.type].pins(p).find((q) => q.name === el.dataset.pin); if (pin) { const near = this.pinNear(this.toWorld(ev), ev); if (near && !near.bb && near.part !== p) return near; return { part: p, pin, pos: P.pinWorld(p, pin), bb: p.type === 'breadboard' }; } }
      if (ev.target && ev.target.closest && ev.target.closest('.w-bend')) return null;
      const pg = ev.target && ev.target.closest && ev.target.closest('.part'), body = (pg && (this.part(pg.dataset.id) || {}).type !== 'breadboard') || (ev.target.closest && ev.target.closest('.wire'));
      return this.pinNear(this.toWorld(ev), ev, body ? 5 : 14);   // over a part's body: only snap when really close to a leg, so the body stays draggable
    }
    pinLabel(h) {
      if (!h) return ''; const p = h.part, n = h.pin.name, d = P.T[p.type] || {};
      if (p.type === 'esp32') { const g = P.espGpio ? P.espGpio(n) : -1; return `ESP32 ${g >= 0 ? 'GPIO' + g + (('D' + g) === n ? '' : ' (' + n + ')') : n}`; }
      if (p.type === 'breadboard') { const m = /^([a-j])(\d+)$/.exec(n); return m ? `Breadboard ${n} (row ${m[2]} ${'abcde'.includes(m[1]) ? 'a–e' : 'f–j'})` : `Breadboard rail ${n}`; }
      return `${p.id} ${d.label || p.type} · pin ${n}`;
    }
    // highlight the hovered pin plus every pin/hole electrically joined to it (breadboard strip, wires, rails)
    highlight(h, extra) {
      let s = '';
      const mark = (q, cls) => { s += `<circle cx="${q.x}" cy="${q.y}" r="${cls === 'hl-pin' ? 5 : 3.6}" class="${cls}"/>`; };
      const nets = [];
      if (h) nets.push(h.pos); for (const q of extra || []) nets.push(q);
      if (nets.length && this.hooks.netKey) {
        const keys = new Set(nets.map((q) => this.hooks.netKey(q.x, q.y)));
        let n = 0; for (const q of this.pinIndex()) if (keys.has(this.hooks.netKey(q.pos.x, q.pos.y))) { mark(q.pos, 'hl-net'); if (++n > 400) break; }
      }
      if (h) mark(h.pos, 'hl-pin'); for (const q of extra || []) mark(q, 'hl-pin');
      this.ovHl.innerHTML = s;
    }
    setHint(t) { if (this.hintEl) this.hintEl.textContent = t || this.defaultHint(); }
    defaultHint() { return this.sel && this.sel.wire ? 'Wire selected: Delete/Backspace removes · right-click for colour · double-click adds a bend · drag bends' : 'Click a pin, then click another pin to wire (drag works too) · hover a pin to see its net · Esc cancels · right-click a wire for options · wheel/pinch = zoom · drag background = pan'; }
    // ---------- interaction ----------
    _bind() {
      const svg = this.svg;
      svg.addEventListener('pointerdown', (ev) => this._down(ev));
      svg.addEventListener('pointermove', (ev) => this._move(ev));
      window.addEventListener('pointerup', (ev) => this._up(ev));
      svg.addEventListener('wheel', (ev) => this._wheel(ev), { passive: false });
      svg.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); if (this.mode && this.mode.k === 'wire') { this.cancelWire(); return; }
        const wEl = ev.target.closest && ev.target.closest('.wire'); if (wEl) { this.select({ wire: wEl.dataset.wid }); this.wireMenu(wEl.dataset.wid, ev); }
      });
      svg.addEventListener('dblclick', (ev) => { { const pg = ev.target.closest && ev.target.closest('.part'), pp = pg && this.part(pg.dataset.id); if (pp && P.T[pp.type].dblclick) { this.push(); if (P.T[pp.type].dblclick(pp)) { this.render(); this.hooks.changed(true); this.hooks.selected(this.sel); } return; } } const t = document.elementFromPoint(ev.clientX, ev.clientY) || ev.target, wEl = t.closest && t.closest('.wire'); if (wEl && !(this.mode && this.mode.k === 'wire') && !(Date.now() - (this._dblBend || 0) < 600)) this.addBend(wEl.dataset.wid, this.toWorld(ev)); });
      window.addEventListener('pointerdown', (ev) => { if (this.menu && !this.menu.contains(ev.target)) this.closeMenu(); }, true);
      svg.addEventListener('dragover', (ev) => ev.preventDefault());
      svg.addEventListener('drop', (ev) => { ev.preventDefault(); const t = ev.dataTransfer.getData('text/x-part'); if (t && P.T[t]) { const w = this.toWorld(ev); this.addPart(t, w.x, w.y); } });
      svg.addEventListener('pointerleave', () => this.hooks.hover(null));
      window.addEventListener('resize', () => this.applyView());
    }
    cancelWire() { if (this.mode && this.mode.k === 'wire') { this.mode = null; this.ovWire.innerHTML = ''; this.highlight(null); this.setHint(); } this.closeMenu(); }
    closeMenu() { if (this.menu) { this.menu.remove(); this.menu = null; } }
    wire(id) { return this.proj.wires.find((w) => w.id === id); }
    deleteWire(id) { if (!this.wire(id)) return; this.push(); this.proj.wires = this.proj.wires.filter((w) => w.id !== id); if (this.sel && this.sel.wire === id) this.sel = null; this.renderWires(); this.hooks.changed(true); this.hooks.selected(this.sel); this.setHint(); }
    colorWire(id, c) { const w = this.wire(id); if (!w) return; this.push(); w.color = c; this.renderWires(); this.hooks.changed(false); }
    addBend(id, at) {
      const w = this.wire(id); if (!w) return; const pts = [w.a, ...(w.pts || []), w.b]; let bi = 0, bd = 1e18;
      for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / L)), ex = a.x + t * dx - at.x, ey = a.y + t * dy - at.y, d = ex * ex + ey * ey; if (d < bd) { bd = d; bi = i; } }
      this.push(); w.pts = w.pts || []; w.pts.splice(bi, 0, { x: snap(at.x), y: snap(at.y) }); this.select({ wire: id }); this.hooks.changed(false);
    }
    wireMenu(id, ev) {
      this.closeMenu(); const wrap = this.svg.parentElement, r = wrap.getBoundingClientRect(), m = document.createElement('div'); m.className = 'ctxmenu';
      m.innerHTML = `<button data-a="del">🗑 Delete wire</button><button data-a="bend">＋ Add bend here</button>${(this.wire(id).pts || []).length ? '<button data-a="straight">Remove bends</button>' : ''}<div class="ctx-colors">${Object.entries(WIRE_COLORS).map(([n, c]) => `<span data-c="${n}" title="${n}" style="background:${c}"></span>`).join('')}</div>`;
      m.style.left = (ev.clientX - r.left) + 'px'; m.style.top = (ev.clientY - r.top) + 'px'; const at = this.toWorld(ev);
      m.onclick = (e) => { const b = e.target.closest('[data-a],[data-c]'); if (!b) return; if (b.dataset.c) this.colorWire(id, b.dataset.c); else if (b.dataset.a === 'del') this.deleteWire(id); else if (b.dataset.a === 'bend') this.addBend(id, at); else { this.push(); this.wire(id).pts = []; this.renderWires(); this.hooks.changed(false); } this.closeMenu(); };
      wrap.appendChild(m); this.menu = m;
    }
    _down(ev) {
      if (ev.button === 1 || (ev.button === 0 && ev.altKey && !this.pinAtEvent(ev))) { this.mode = { k: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y }; return; }
      if (ev.button !== 0) return;
      const w = this.toWorld(ev), pin = this.pinAtEvent(ev);
      if (this.mode && this.mode.k === 'wire') {
        const m = this.mode;
        if (pin) { if (pin.pos.x === m.a.x && pin.pos.y === m.a.y && !m.pts.length) { this.cancelWire(); return; } this._finishWire(pin.pos, pin); return; }
        const last = m.pts.length ? m.pts[m.pts.length - 1] : m.a; const q = { x: snap(w.x), y: snap(w.y) };
        if (ev.detail >= 2) { this._finishWire(q); return; }   // double click ends a wire on empty space
        m.pts.push(...this._ortho(last, q)); this._drawWirePreview(w); return;
      }
      const bEl = ev.target.closest && ev.target.closest('.w-bend');
      if (bEl) { const wid = bEl.closest('.wire').dataset.wid; this.push(); this.mode = { k: 'bend', w: this.wire(wid), i: +bEl.dataset.bend }; svg_capture(this.svg, ev); return; }
      const partEl = ev.target.closest('.part'); const p = partEl && this.part(partEl.dataset.id);
      const onPart = p && p.type !== 'breadboard' && !pin;
      if (pin && !(p && p.type === 'breadboard' && ev.shiftKey) && !(onPart && false)) { this.closeMenu(); this.mode = { k: 'wire', a: pin.pos, pts: [], start: pin, t0: Date.now() }; this._drawWirePreview(w); this.highlight(pin); this.setHint(`Wiring from ${this.pinLabel(pin)} — click the target pin · click empty space to add a bend · Esc / right-click cancels`); return; }
      const wEl = ev.target.closest('.wire');
      if (wEl) { const dbl = this._lastWireDown && this._lastWireDown.id === wEl.dataset.wid && Date.now() - this._lastWireDown.t < 450; this._lastWireDown = { id: wEl.dataset.wid, t: Date.now() };
        if (dbl && this.sel && this.sel.wire === wEl.dataset.wid) { this._lastWireDown = null; this._dblBend = Date.now(); this.addBend(wEl.dataset.wid, w); return; } this.select({ wire: wEl.dataset.wid }); return; }
      if (p) {
        const d = P.T[p.type];
        if (d.wheel && !ev.shiftKey) { this.select({ part: p.id }); this.mode = { k: 'knob', p, sy: ev.clientY, sx: ev.clientX, pos0: +p.props.pos }; svg_capture(this.svg, ev); return; }
        if (this.hooks.running() && d.interactive && !ev.shiftKey) { const kEl = ev.target.closest && ev.target.closest('[data-key]'); if (d.keyAt && !kEl) { /* keypad body: fall through to drag */ } else { this.hooks.press(p, true, kEl ? +kEl.dataset.key : undefined); this.mode = { k: 'press', p }; svg_capture(this.svg, ev); return; } }
        if (d.click && !ev.shiftKey && this.hooks.running()) { if (d.click(p)) { this.render(); this.hooks.changed(false); } return; }
        this.select({ part: p.id });
        this.mode = { k: 'drag', p, ox: p.x, oy: p.y, sx: w.x, sy: w.y, moved: false };
        return;
      }
      this.select(null);
      this.mode = { k: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y };
    }
    _ortho(a, q) { return this.ortho && a.x !== q.x && a.y !== q.y ? [{ x: q.x, y: a.y }, q] : [q]; }   // L-shaped (horizontal then vertical) bends
    _drawWirePreview(w) {
      const m = this.mode, last = m.pts.length ? m.pts[m.pts.length - 1] : m.a, tgt = this.pinNear(w), end = tgt ? tgt.pos : { x: snap(w.x), y: snap(w.y) };
      const pts = [m.a, ...m.pts, ...this._ortho(last, end)].map((q) => `${q.x},${q.y}`).join(' ');
      this.ovWire.innerHTML = `<polyline points="${pts}" class="w-preview" style="stroke:${this.wireColor === 'auto' ? this.autoColor(m.start, null) : (WIRE_COLORS[this.wireColor] || this.wireColor)}"/>` + (tgt ? `<circle cx="${end.x}" cy="${end.y}" r="5.5" class="hl-target"/>` : '');
    }
    _finishWire(b, endPin) {
      const m = this.mode; this.mode = null; this.ovWire.innerHTML = ''; this.highlight(null); this.setHint();
      if (b.x === m.a.x && b.y === m.a.y && !m.pts.length) return;
      const last = m.pts.length ? m.pts[m.pts.length - 1] : m.a; if (this.ortho) { const c = this._ortho(last, b); if (c.length > 1) m.pts.push(c[0]); }
      this.push();
      let n = 1; while (this.proj.wires.some((w) => w.id === 'w' + n)) n++;
      this.proj.wires.push({ id: 'w' + n, a: { ...m.a }, b: { x: b.x, y: b.y }, pts: m.pts, color: this.wireColor === 'auto' ? this.autoColor(m.start, endPin) : this.wireColor });
      this.renderWires(); this.hooks.changed(true);
    }
    _move(ev) {
      const w = this.toWorld(ev), m = this.mode;
      if (m && m.k === 'pan') { this.view.x = m.vx - (ev.clientX - m.sx) / this.view.s; this.view.y = m.vy - (ev.clientY - m.sy) / this.view.s; this.applyView(); return; }
      if (m && m.k === 'knob') { const dlt = ((ev.clientX - m.sx) - (ev.clientY - m.sy)) / 150; m.p.props.pos = Math.min(1, Math.max(0, m.pos0 + dlt)); this.hooks.changed(false); this.refreshDynamic(); this.hooks.selected(this.sel); return; }
      if (m && m.k === 'wire') { this._drawWirePreview(w); const t = this.pinNear(w, ev); this.highlight(m.start, t ? [t.pos] : []); this.hooks.hover(t ? { ev, pin: t, part: t.part, world: w, label: this.pinLabel(t) } : null); return; }
      if (m && m.k === 'bend') { const q = { x: snap(w.x), y: snap(w.y) }; const b = m.w.pts[m.i]; if (b.x !== q.x || b.y !== q.y) { b.x = q.x; b.y = q.y; m.moved = true; this.renderWires(); } return; }
      if (m && m.k === 'drag') {
        const nx = snap(m.ox + w.x - m.sx), ny = snap(m.oy + w.y - m.sy);
        if (nx !== m.p.x || ny !== m.p.y) {
          if (!m.moved) { this.push(); m.moved = true; } m.p.x = nx; m.p.y = ny; this._pinIdx = null; const g = this.partEls.get(m.p.id); g.setAttribute('transform', `translate(${nx},${ny}) rotate(${(m.p.rot || 0) * 90})`);
          if (m.p.type !== 'breadboard') {   // show which breadboard holes/strips the part's legs will land in
            const holes = []; for (const pin of P.T[m.p.type].pins(m.p)) { const pw = P.pinWorld(m.p, pin); const h = this.pinIndex().find((q) => q.bb && q.pos.x === pw.x && q.pos.y === pw.y); if (h) holes.push(h.pos); }
            this.highlight(null, holes);
          }
        }
        return;
      }
      const pin = this.pinAtEvent(ev); const partEl = ev.target.closest && ev.target.closest('.part');
      const hk = pin ? pin.pos.x + ',' + pin.pos.y : ''; if (hk !== this.hoverPin) { this.hoverPin = hk; this.highlight(pin); }
      this.svg.classList.toggle('on-pin', !!pin);
      this.hooks.hover({ ev, pin, part: pin ? pin.part : partEl ? this.part(partEl.dataset.id) : null, world: w, label: pin ? this.pinLabel(pin) : '' });
    }
    _up(ev) {
      const m = this.mode; if (!m) return;
      if (m.k === 'press') { this.hooks.press(m.p, false); this.mode = null; return; }
      if (m.k === 'drag') { this.mode = null; this.highlight(null); if (m.moved) this.hooks.changed(true); return; }
      if (m.k === 'bend') { this.mode = null; if (m.moved) this.hooks.changed(false); else this.undoS.pop(); return; }
      if (m.k === 'pan') { this.mode = null; return; }
      if (m.k === 'knob') { this.mode = null; return; }
      if (m.k === 'wire') {   // drag-release on a pin finishes a wire too
        const pin = this.pinAtEvent(ev);
        if (pin && (pin.pos.x !== m.a.x || pin.pos.y !== m.a.y) && !m.pts.length) this._finishWire(pin.pos, pin);
      }
    }
    _wheel(ev) {
      ev.preventDefault();
      const partEl = ev.target.closest('.part'); const p = partEl && this.part(partEl.dataset.id);
      if (p && P.T[p.type].wheel && !ev.ctrlKey) { if (P.T[p.type].wheel(p, Math.sign(ev.deltaY))) { this.hooks.changed(false); this.refreshDynamic(); this.hooks.selected(this.sel); } return; }
      const w = this.toWorld(ev), f = Math.exp(-ev.deltaY * 0.0015), s = Math.min(4, Math.max(0.15, this.view.s * f));
      this.view.x = w.x - (w.x - this.view.x) * this.view.s / s; this.view.y = w.y - (w.y - this.view.y) * this.view.s / s; this.view.s = s; this.applyView();
    }
  }
  function svg_capture(svg, ev) { try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
  root.Editor = Editor; root.WIRE_COLORS = WIRE_COLORS;
})(window);
