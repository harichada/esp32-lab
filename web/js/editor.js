/* SVG schematic/breadboard editor: palette drop, drag, snapping to the 0.1" grid (and breadboard holes),
 * wires with bend points and colours, rotate/delete, undo/redo, pan/zoom, hover tooltips. */
(function (root) {
  const P = root.Parts, G = 10, NS = 'http://www.w3.org/2000/svg';
  const snap = (v) => Math.round(v / G) * G;
  // Workbench (ui2) is off unless the page set data-ui="2". Every branch below
  // keeps the previous editor when that attribute is absent.
  function ui2On() {
    try {
      const doc = typeof document !== 'undefined' ? document : null;
      const el = doc && doc.documentElement;
      return !!(el && el.dataset && el.dataset.ui === '2');
    } catch (e) { return false; }
  }
  const WIRE_COLORS = { green: '#3ddc84', red: '#ff4d4d', black: '#1b1b1b', blue: '#4d8dff', yellow: '#ffd23d', orange: '#ff9a3d', white: '#e8e8e8', purple: '#b06bff', gray: '#9aa3b2', brown: '#a0632e' };
  class Editor {
    constructor(svg, hooks) {
      this.svg = svg; this.hooks = hooks; this.lParts = svg.querySelector('#lParts'); this.lWires = svg.querySelector('#lWires'); this.lOver = svg.querySelector('#lOver');
      this.view = { x: -40, y: -40, s: 1 }; this.sel = null; this.multi = new Set(); this._clip = null; this.undoS = []; this.redoS = []; this.mode = null; this.wireColor = 'auto'; this.partEls = new Map(); this.svgCache = new Map(); this.ortho = true; this._pinIdx = null; this.hoverPin = null; this.warnings = [];
      this.lOver.innerHTML = '<g class="ov-hl"></g><g class="ov-wire"></g>'; this.ovHl = this.lOver.firstChild; this.ovWire = this.lOver.lastChild;
      this.hintEl = svg.parentElement && svg.parentElement.querySelector('.hint'); this.menu = null;
      this._bind();
    }
    setProject(proj) { this.proj = proj; this.sel = null; this.undoS = []; this.redoS = []; this.mode = null; this._hover = null; this.hoverPin = null; this._setWarnings([]); if (this.hooks.hover) this.hooks.hover(null); this.render(); }
    snapshot() {
      const o = { parts: this.proj.parts, wires: this.proj.wires, sel: this.sel || null };
      if (ui2On() && this.multi && this.multi.size) o.multi = [...this.multi];
      return JSON.stringify(o);
    }
    push() { if (this.hooks.beforeEdit) this.hooks.beforeEdit(); this.undoS.push(this.snapshot()); if (this.undoS.length > 200) this.undoS.shift(); this.redoS = []; }
    // The snapshot replaces part objects. Gestures and the pin index were holding
    // the old objects, so the next click missed the part the pointer was on and
    // Delete still removed whatever the Inspector had drawn. Drop those handles,
    // put the selection back on its id, and tell the Inspector.
    _restore(s) {
      const o = JSON.parse(s); this.proj.parts = o.parts; this.proj.wires = o.wires;
      this.mode = null; this._pinIdx = null;
      if (this.ovWire) this.ovWire.innerHTML = '';
      if (this.ovHl) this.ovHl.innerHTML = '';
      const keep = o.sel !== undefined ? o.sel : this.sel;
      const partOk = keep && keep.part && this.part(keep.part);
      const wireOk = keep && keep.wire && this.wire(keep.wire);
      this.sel = partOk ? { part: keep.part } : wireOk ? { wire: keep.wire } : null;
      if (ui2On()) {
        const ids = Array.isArray(o.multi) ? o.multi.filter((id) => this.part(id)) : [];
        this.multi = new Set(ids.length ? ids : (this.sel && this.sel.part ? [this.sel.part] : []));
      }
      this._setWarnings([]);
      this._clearHoverIfGone();
      this.render(); this.hooks.changed(true); if (this.hooks.selected) this.hooks.selected(this.sel);
    }
    undo() { if (!this.undoS.length) return; this.redoS.push(this.snapshot()); this._restore(this.undoS.pop()); }
    redo() { if (!this.redoS.length) return; this.undoS.push(this.snapshot()); this._restore(this.redoS.pop()); }
    // ---------- coordinates ----------
    applyView() {
      const r = this.svg.getBoundingClientRect();
      this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${r.width / this.view.s} ${r.height / this.view.s}`);
      this._scaleBoardLabels();
    }
    // Part values on the breadboard use the same viewBox zoom as the schematic.
    // Keep them at least 11 screen px, and never larger than their natural size when zoomed in.
    _scaleBoardLabels() {
      if (!this.svg || !this.svg.querySelectorAll) return;
      let scale = this.view.s > 0 ? this.view.s : 1;
      try {
        const m = this.svg.getScreenCTM && this.svg.getScreenCTM();
        if (m) {
          const s = Math.hypot(m.a, m.b);
          if (s > 0.02 && isFinite(s)) scale = s;
        }
      } catch (e) { /* keep the view zoom */ }
      const target = (natural) => (scale >= 1 ? Math.max(11, Math.min(natural, natural * scale)) : Math.max(11, natural * scale));
      this.svg.querySelectorAll('text.plbl:not(.small)').forEach((el) => {
        if (!el.dataset.natural) {
          let n = 8;
          try {
            const f = parseFloat((root.getComputedStyle ? root.getComputedStyle(el) : getComputedStyle(el)).fontSize);
            if (f > 0 && f < 11.5 && isFinite(f)) n = f;
          } catch (e2) { /* 8 */ }
          el.dataset.natural = String(n);
        }
        const n = +el.dataset.natural || 8;
        el.style.fontSize = (target(n) / scale) + 'px';
      });
    }
    toWorld(ev) { const r = this.svg.getBoundingClientRect(); return { x: this.view.x + (ev.clientX - r.left) / this.view.s, y: this.view.y + (ev.clientY - r.top) / this.view.s }; }
    markUserView() { this._autoFit = false; }
    fit() {
      // Phone layout calls this from a timer that can run before the example is loaded.
      if (!this.proj) return;
      const bb = this.bounds(); const r = this.svg.getBoundingClientRect(); if (!bb || r.width < 2 || r.height < 2) return;
      const frame = root.Pinch.frameOf(this.svg);
      const limits = { min: 0.15, max: 3 };
      const clear = root.Pinch.resolveClear(frame, bb, 14, limits);
      const fit = root.Pinch.fitView(bb, frame.stage, clear, 14, limits);
      const s = fit.s;
      this.view = { s: s, x: fit.x, y: fit.y };
      this._autoFit = true; this._fitSize = Math.round(r.width) + 'x' + Math.round(r.height); this.applyView();
      const z = document.getElementById('zoomPct');
      if (z && !document.body.classList.contains('viewsch') && !document.body.classList.contains('view3d')) z.textContent = Math.round(s * 100) + '%';
    }
    bounds() {
      if (!this.proj || !this.proj.parts) return null;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
      for (const p of this.proj.parts) { const d = P.T[p.type]; if (!d) continue; const sz = d.size(p); const c = [[-30, -50], [sz.w + 30, sz.h + 30]]; for (const [a, b] of c) { const [rx, ry] = P.orientPt(a, b, p); add(p.x + rx, p.y + ry); } }
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
        const selOn = (this.sel && this.sel.part === p.id) || (ui2On() && this.multi && this.multi.has(p.id));
        const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'part' + (selOn ? ' sel' : '') + (P.T[p.type].interactive || P.T[p.type].click ? ' inter' : '')); g.setAttribute('data-id', p.id); g.dataset.id = p.id;
        g.setAttribute('transform', P.partTransform(p));
        const html = this.partSvg(p); g.innerHTML = html; this._upright(g, p); this.svgCache.set(p.id, html);
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
        const html = this.partSvg(p); if (this.svgCache.get(p.id) !== html) { g.innerHTML = html; this._upright(g, p); this.svgCache.set(p.id, html); }
      }
    }
    select(s) {
      this.sel = s;
      if (ui2On() && !this._keepMulti) {
        this.multi = new Set();
        if (s && s.part) this.multi.add(s.part);
      }
      const multi = ui2On() && this.multi;
      for (const [id, g] of this.partEls) g.classList.toggle('sel', !!(s && s.part === id) || !!(multi && multi.has(id)));
      this.renderWires(); this.hooks.selected(s); if (!this.mode) this.setHint();
    }
    // ---------- model ops ----------
    addPart(type, x, y) {
      if (root.GuestParts && root.GuestParts.blocks(type)) { root.GuestParts.promptType(type); return null; }
      const d = P.T[type]; this.push();
      let n = 1; const pre = (d.prefix || type.slice(0, 3).toUpperCase()); while (this.proj.parts.some((p) => p.id === pre + n)) n++;
      const p = { id: pre + n, type, x: snap(x), y: snap(y), rot: 0, props: JSON.parse(JSON.stringify(d.props || {})) };
      this.proj.parts.push(p); this.render(); this.select({ part: p.id }); this.hooks.changed(true);
      if (ui2On()) { try { this.fit(); } catch (e) { /* the part is already on the board */ } }
      return p;
    }
    // Palette click and the command palette. Empty strips, same rule as placeNewPart.seatOk.
    // ui2 drops the part in free space beside what is already placed, inside the view.
    addPartInView(type) {
      const r = this.svg.getBoundingClientRect();
      const x = this.view.x + r.width / this.view.s / 2, y = this.view.y + r.height / this.view.s / 2;
      const seat = ui2On() ? this.freeSeat(type, x, y) : (P.placeOnEmptyStrips ? P.placeOnEmptyStrips(this.proj.parts, type, x, y, 0) : { x, y });
      return this.addPart(type, seat.x, seat.y);
    }
    freeSeat(type, x, y) {
      const parts = (this.proj && this.proj.parts) || [];
      let tx = x, ty = y;
      const bodies = parts.filter((p) => p && p.type !== 'breadboard' && p.type !== 'label' && P.T[p.type]);
      if (bodies.length) {
        let right = -1e9, mid = 0;
        for (const p of bodies) {
          const sz = P.T[p.type].size(p) || { w: 40, h: 16 };
          right = Math.max(right, p.x + (sz.w || 40));
          mid = p.y;
        }
        tx = right + 36; ty = mid;
      }
      try {
        const r = this.svg.getBoundingClientRect();
        const s = this.view.s || 1;
        if (r.width > 2 && r.height > 2) {
          const m = 24 / s;
          tx = Math.min(Math.max(tx, this.view.x + m), this.view.x + r.width / s - m - 40);
          ty = Math.min(Math.max(ty, this.view.y + m), this.view.y + r.height / s - m - 16);
        }
      } catch (e) { /* keep the seat beside the last part */ }
      return P.placeOnEmptyStrips ? P.placeOnEmptyStrips(parts, type, tx, ty, 0) : { x: snap(tx), y: snap(ty) };
    }
    part(id) { return this.proj && this.proj.parts.find((p) => p.id === id); }
    // Id on the element, not a part object cached before the last undo.
    _partIdOf(el) { return el && (el.dataset.id || (el.getAttribute && el.getAttribute('data-id'))) || ''; }
    _pinKey(x, y) { return Math.round(x) + ',' + Math.round(y); }
    _pinWorlds(p) {
      const d = P.T[p.type]; if (!d || !d.pins) return [];
      let pins = []; try { pins = d.pins(p) || []; } catch (e) { return []; }
      return pins.map((pin) => ({ name: pin.name, ...P.pinWorld(p, pin) }));
    }
    _setWarnings(list) {
      this.warnings = list || [];
      if (this.hooks.warnings) this.hooks.warnings(this.warnings);
    }
    // Move wire ends that sit on this part's pins to the pins' new positions.
    // An end that also meets another part cannot move without breaking that
    // joint: leave it and say so, instead of quietly leaving the pin open.
    _followWires(part, before) {
      const warnings = [];
      const oldAt = new Map();
      for (const pin of before) {
        const k = this._pinKey(pin.x, pin.y);
        if (!oldAt.has(k)) oldAt.set(k, []);
        oldAt.get(k).push(pin.name);
      }
      const others = new Map();
      for (const q of this.proj.parts) {
        if (q.id === part.id) continue;
        for (const pin of this._pinWorlds(q)) {
          const k = this._pinKey(pin.x, pin.y);
          if (!others.has(k)) others.set(k, []);
          others.get(k).push(q.id + '.' + pin.name);
        }
      }
      const now = new Map(this._pinWorlds(part).map((pin) => [pin.name, pin]));
      const ends = [];
      for (const w of this.proj.wires) ends.push({ w, end: 'a', x: w.a.x, y: w.a.y }, { w, end: 'b', x: w.b.x, y: w.b.y });
      for (const e of ends) {
        const names = oldAt.get(this._pinKey(e.x, e.y));
        if (!names) continue;
        const share = others.get(this._pinKey(e.x, e.y)) || [];
        if (names.length !== 1 || share.length) {
          const who = names.map((n) => part.id + '.' + n).join(', ');
          warnings.push({ id: part.id, msg: share.length ? `wire ${e.w.id} cannot follow ${who} — that point also connects ${share.join(', ')}` : `wire ${e.w.id} cannot follow ${who} — those pins no longer share one point` });
          continue;
        }
        const np = now.get(names[0]); if (!np) continue;
        e.w[e.end].x = np.x; e.w[e.end].y = np.y;
      }
      return warnings;
    }
    rotateSel() {
      if (!this.sel || !this.sel.part) return;
      const p = this.part(this.sel.part); if (!p) return;
      const before = this._pinWorlds(p);
      this.push();
      p.rot = ((p.rot || 0) + 1) & 3;
      const warnings = this._followWires(p, before);
      this._pinIdx = null;
      this.render();
      this._setWarnings(warnings);
      this.hooks.changed(true);
      if (this.hooks.selected) this.hooks.selected(this.sel);
    }
    // axis 'x' or 'y'. On the breadboard a two-terminal part turns 180° (either
    // axis — there is only one real flip). In the schematic, H and V are display-only.
    flipSel(axis) {
      if (!this.sel || !this.sel.part) return;
      const p = this.part(this.sel.part); if (!p) return;
      const sch = document.body.classList.contains('viewsch');
      if (sch) {
        this.push();
        if (axis === 'y') p.schFlipY = !p.schFlipY; else p.schFlipX = !p.schFlipX;
        this.hooks.changed(true); this.hooks.selected(this.sel); return;
      }
      if (!P.canPhysicalFlip(p)) return;
      const before = this._pinWorlds(p);
      this.push();
      if (P.ALLOW_MIRROR_MULTIPIN && !P.isTwoTerminal(p)) {
        if (axis === 'y') p.flipY = !p.flipY; else p.flipX = !p.flipX;
      } else { p.flipX = !p.flipX; p.flipY = false; }
      const seat = P.reseat(this.proj.parts, p);
      if (seat) { p.x = seat.x; p.y = seat.y; }
      const warnings = this._followWires(p, before);
      this._pinIdx = null;
      this.render();
      this._setWarnings(warnings);
      this.hooks.changed(true); this.hooks.selected(this.sel);
    }
    // A 180° body turn would invert lettering. Spin each label back about its
    // own anchor so it stays upright and unmirrored. Geometry still turns.
    _upright(g, p) {
      const s = P.bodySpin(p); if (!s) return;
      g.querySelectorAll('text').forEach((el) => {
        const x = parseFloat(el.getAttribute('x')) || 0, y = parseFloat(el.getAttribute('y')) || 0;
        const prev = el.getAttribute('transform') || '';
        const fix = s.turn ? `rotate(180 ${x} ${y})` : `translate(${x} ${y}) scale(${s.flipX ? -1 : 1} ${s.flipY ? -1 : 1}) translate(${-x} ${-y})`;
        el.setAttribute('transform', prev ? fix + ' ' + prev : fix);
      });
    }
    deleteSel() {
      if (ui2On() && this.multi && this.multi.size > 1) {
        const ids = new Set(this.multi);
        if (this.sel && this.sel.part) ids.add(this.sel.part);
        const keys = new Set();
        for (const p of this.proj.parts) if (ids.has(p.id)) for (const pin of this._pinWorlds(p)) keys.add(this._pinKey(pin.x, pin.y));
        this.push();
        this.proj.parts = this.proj.parts.filter((p) => !ids.has(p.id));
        this.proj.wires = this.proj.wires.filter((w) => !(keys.has(this._pinKey(w.a.x, w.a.y)) && keys.has(this._pinKey(w.b.x, w.b.y))));
        this.multi = new Set(); this.sel = null; this.render(); this.hooks.changed(true); this.hooks.selected(null);
        this._clearHoverIfGone(); this.focusCanvas(); return;
      }
      if (!this.sel) return;
      if (this.sel.wire && !this.sel.part) {
        if (!this.wire(this.sel.wire)) return;
        this.push();
        this.proj.wires = this.proj.wires.filter((w) => w.id !== this.sel.wire);
        this.sel = null; this.render(); this.hooks.changed(true); this.hooks.selected(null);
        this._clearHoverIfGone();
        this.focusCanvas();
        return;
      }
      // A selection whose part was replaced or removed must not delete whatever
      // happens to be left. The Inspector's part wins when it disagrees, so
      // Delete removes the part on screen.
      if (!this.sel.part || !this.part(this.sel.part)) return;
      let id = this.sel.part;
      const shown = this.hooks.shownPart && this.hooks.shownPart();
      if (shown && shown !== id) { if (!this.part(shown)) return; id = shown; }
      this.push();
      this.proj.parts = this.proj.parts.filter((p) => p.id !== id);
      this.sel = null; this.render(); this.hooks.changed(true); this.hooks.selected(null);
      this._clearHoverIfGone();
      // Inspector and phone-sheet Delete leave focus in a value field, which swallows Ctrl+Z.
      this.focusCanvas();
    }
    focusCanvas() {
      const svg = this.svg; if (!svg || typeof svg.focus !== 'function') return;
      try {
        const ae = document.activeElement;
        if (ae && ae !== svg && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '') && typeof ae.blur === 'function') ae.blur();
      } catch (e) { /* focus is a convenience */ }
      try { if (typeof svg.hasAttribute !== 'function' || !svg.hasAttribute('tabindex')) svg.setAttribute('tabindex', '-1'); } catch (e) { /* */ }
      try { if (svg.style) svg.style.outline = 'none'; svg.focus({ preventScroll: true }); }
      catch (e) { /* focus must not scroll the page; the shortcut still works when focus is already here */ }
    }
    setWireColor(c) { this.wireColor = c; if (this.sel && this.sel.wire) { const w = this.proj.wires.find((q) => q.id === this.sel.wire); if (w) { this.push(); w.color = c; this.renderWires(); } } }
    pinIndex() {   // world positions of every pin (non-breadboard first so they win ties with the hole underneath)
      if (!this.proj) return [];
      if (this._pinIdx) return this._pinIdx; const a = [];
      for (const p of this.proj.parts) { const d = P.T[p.type]; if (!d) continue; for (const pin of d.pins(p)) a.push({ part: p, pin, pos: P.pinWorld(p, pin), bb: p.type === 'breadboard' }); }
      a.sort((x, y) => x.bb - y.bb); return (this._pinIdx = a);
    }
    pinNear(w, ev, maxR) {   // nearest pin within a finger/cursor-sized radius (bigger for touch, constant on screen)
      const touch = !!(ev && ev.pointerType === 'touch');
      const px = touch ? 22 : 11, cap = maxR || 14;
      let r = Math.min(cap, Math.max(4, px / (this.view.s || 1)));
      if (ui2On()) {
        const fat = touch || (typeof document !== 'undefined' && document.body && document.body.classList.contains('m'));
        const want = fat ? 22 : 8;
        r = Math.min(fat ? 44 : 16, Math.max(4, want / (this.view.s || 1)));
      }
      let best = null, bd = r * r;
      for (const q of this.pinIndex()) { const dx = q.pos.x - w.x, dy = q.pos.y - w.y, d = dx * dx + dy * dy + (q.bb ? 0.5 : 0); if (d < bd) { bd = d; best = q; } }
      return best;
    }
    pinAtEvent(ev) {
      // ui2: a pin is live within 16px on a mouse and 44px on a finger, without drawing a bigger pad.
      if (ui2On() && this.proj && ev && ev.target && ev.target.closest && !ev.target.closest('.w-bend') && !ev.target.closest('.wire')) {
        const wpt = this.toWorld(ev);
        const near = this.pinNear(wpt, ev);
        if (near) {
          const fat = ev.pointerType === 'touch' || (document.body && document.body.classList.contains('m'));
          const limit = fat ? 22 : 8;
          const sd = Math.hypot(near.pos.x - wpt.x, near.pos.y - wpt.y) * (this.view.s || 1);
          if (sd <= limit + 0.5) return near;
        }
      }
      const el = ev.target && ev.target.closest && ev.target.closest('[data-pin]');
      if (el) { const g = el.closest('.part'); const p = g && this.part(this._partIdOf(g)); const pin = p && P.T[p.type].pins(p).find((q) => q.name === el.dataset.pin); if (pin) { const near = this.pinNear(this.toWorld(ev), ev); if (near && !near.bb && near.part && near.part.id !== p.id) return near; return { part: p, pin, pos: P.pinWorld(p, pin), bb: p.type === 'breadboard' }; } }
      if (ev.target && ev.target.closest && ev.target.closest('.w-bend')) return null;
      const pg = ev.target && ev.target.closest && ev.target.closest('.part'), part = pg && this.part(this._partIdOf(pg));
      // A part body, lead, or label selects the part. It must not snap to a nearby leg and start a wire.
      if (part && part.type !== 'breadboard') return null;
      const onWire = ev.target && ev.target.closest && ev.target.closest('.wire');
      return this.pinNear(this.toWorld(ev), ev, onWire ? 5 : 14);
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
    setHint(t) { if (!this.hintEl) return; if (document.body.classList.contains('viewsch')) { this.hintEl.textContent = root.Pinch.schematicHint(); return; } this.hintEl.textContent = t || this.defaultHint(); }
    defaultHint() {
      if (this.sel && this.sel.wire) return 'Wire selected: Delete/Backspace removes · right-click for colour · double-click adds a bend · drag bends';
      if (document.body.classList.contains('m')) return 'Tap a part to select it. Tap a pin, then another pin, to wire';
      // R and F are advertised only for the part that is actually selected.
      // A pushbutton can turn, but it cannot flip, so the hint must not say F.
      let s = 'Click a part to select it. Click a pin, then another pin, to wire';
      const p = this.sel && this.sel.part && this.part(this.sel.part);
      if (!p) return s;
      s += ' · R rotate';
      if (P.canPhysicalFlip(p)) s += ' · F flip';
      return s;
    }
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
      svg.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        if (!ui2On() || !this.proj) return;
        const type = (document.documentElement.dataset && document.documentElement.dataset.dragPart) || '';
        if (!type || !P.T[type]) return;
        this._ghostW = this.toWorld(ev); this._ghostType = type;
        if (this._ghostRaf) return;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => fn();
        this._ghostRaf = raf(() => { this._ghostRaf = 0; if (this._ghostType) this._showGhost(this._ghostType, this._ghostW); });
      });
      svg.addEventListener('drop', (ev) => {
        ev.preventDefault(); const t = ev.dataTransfer.getData('text/x-part'); this._clearGhost();
        if (t && P.T[t]) { const w = this.toWorld(ev); const seat = ui2On() ? this.freeSeat(t, w.x, w.y) : (P.placeDroppedPart ? P.placeDroppedPart(this.proj.parts, t, w.x, w.y, 0) : w); this.addPart(t, seat.x, seat.y); }
      });
      window.addEventListener('dragend', () => this._clearGhost());
      svg.addEventListener('pointerleave', () => this._emitHover(null));
      window.addEventListener('resize', () => this.applyView());
      // A fitted desktop zoom (often ~177% on a wide canvas) used to survive a shrink to phone
      // width, so the breadboard opened clipped. Refit while the view is still the automatic one.
      if (typeof ResizeObserver !== 'undefined') {
        let raf = 0;
        new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            const box = this.svg.getBoundingClientRect();
            if (box.width < 2 || box.height < 2 || !this.proj) return;
            const prev = (this._fitSize || '').split('x').map(Number);
            if (prev.length === 2 && Math.abs(box.width - prev[0]) < 2 && Math.abs(box.height - prev[1]) < 2) return;
            if (this._autoFit || !this._fitSize) this.fit();
          });
        }).observe(this.svg);
      }
    }
    cancelWire() { if (this.mode && this.mode.k === 'wire') { this.mode = null; this.ovWire.innerHTML = ''; this.highlight(null); this.setHint(); } this.closeMenu(); }
    closeMenu() { if (this.menu) { this.menu.remove(); this.menu = null; } }
    wire(id) { return this.proj.wires.find((w) => w.id === id); }
    deleteWire(id) { if (!this.wire(id)) return; this.push(); this.proj.wires = this.proj.wires.filter((w) => w.id !== id); if (this.sel && this.sel.wire === id) this.sel = null; this.renderWires(); this._clearHoverIfGone(); this.hooks.changed(true); this.hooks.selected(this.sel); this.setHint(); }
    colorWire(id, c) { const w = this.wire(id); if (!w) return; this.push(); w.color = c; this.renderWires(); this.hooks.changed(false); }
    addBend(id, at) {
      const w = this.wire(id); if (!w) return; const pts = [w.a, ...(w.pts || []), w.b]; let bi = 0, bd = 1e18;
      for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / L)), ex = a.x + t * dx - at.x, ey = a.y + t * dy - at.y, d = ex * ex + ey * ey; if (d < bd) { bd = d; bi = i; } }
      this.push(); w.pts = w.pts || []; w.pts.splice(bi, 0, { x: snap(at.x), y: snap(at.y) }); this.select({ wire: id }); this.hooks.changed(false);
    }
    wireMenu(id, ev) {
      this.closeMenu(); const wrap = this.svg.parentElement, r = wrap.getBoundingClientRect(), m = document.createElement('div'); m.className = 'ctxmenu';
      const delLab = ui2On() ? 'Delete wire' : '🗑 Delete wire';
      const bendLab = ui2On() ? 'Add bend here' : '＋ Add bend here';
      m.innerHTML = `<button data-a="del">${delLab}</button><button data-a="bend">${bendLab}</button>${(this.wire(id).pts || []).length ? '<button data-a="straight">Remove bends</button>' : ''}<div class="ctx-colors">${Object.entries(WIRE_COLORS).map(([n, c]) => `<span data-c="${n}" title="${n}" style="background:${c}"></span>`).join('')}</div>`;
      m.style.left = (ev.clientX - r.left) + 'px'; m.style.top = (ev.clientY - r.top) + 'px'; const at = this.toWorld(ev);
      m.onclick = (e) => { const b = e.target.closest('[data-a],[data-c]'); if (!b) return; if (b.dataset.c) this.colorWire(id, b.dataset.c); else if (b.dataset.a === 'del') this.deleteWire(id); else if (b.dataset.a === 'bend') this.addBend(id, at); else { this.push(); this.wire(id).pts = []; this.renderWires(); this.hooks.changed(false); } this.closeMenu(); };
      wrap.appendChild(m); this.menu = m;
    }
    _emitHover(h) {
      this._hover = h || null;
      if (!h) this.hoverPin = null;
      if (this.hooks.hover) this.hooks.hover(h || null);
    }
    // The tooltip keeps the last part it was showing. Hide it once that part or wire is gone
    // (Delete, undo/redo, or a project that no longer contains it).
    _clearHoverIfGone() {
      const h = this._hover;
      if (!h) return;
      const proj = this.proj;
      const partGone = h.part && (!proj || !(proj.parts || []).some((p) => p.id === h.part.id));
      const wireGone = h.wire && (!proj || !(proj.wires || []).some((w) => w.id === h.wire.id));
      if (!proj || partGone || wireGone) this._emitHover(null);
    }
    _down(ev) {
      // Pointer events can land before the example fetch finishes and setProject runs.
      if (!this.proj || !this.proj.parts) return;
      // A drag started before undo still points at the replaced part object.
      if (this.mode && this.mode.p && !this.proj.parts.includes(this.mode.p)) this.mode = null;
      if (this.mode && this.mode.w && !this.proj.wires.includes(this.mode.w)) this.mode = null;
      if (ui2On() && this._spacePan && ev.button === 0) { this.mode = { k: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y }; return; }
      if (ev.button === 1 || (ev.button === 0 && ev.altKey && !this.pinAtEvent(ev))) { this.mode = { k: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y }; return; }
      if (ev.button !== 0) return;
      const partEl = ev.target.closest && ev.target.closest('.part'); const p = partEl && this.part(this._partIdOf(partEl));
      if (ui2On() && ev.shiftKey && p && p.type !== 'breadboard') { this._toggleMulti(p.id); return; }
      const pinEl = ev.target.closest && ev.target.closest('[data-pin]');
      const onBody = !!(p && p.type !== 'breadboard' && !pinEl);
      const w = this.toWorld(ev);
      let pin = null;
      if (ui2On()) {
        const slop = this.pinAtEvent(ev);
        const pinHit = !!(slop && !slop.bb);
        if (onBody && !pinHit && this.mode && this.mode.k === 'wire') this.cancelWire();
        pin = slop;
      } else {
        // A body tap selects, even mid-wire. It must not drop a bend or land the wire on a nearby pin.
        if (onBody && this.mode && this.mode.k === 'wire') this.cancelWire();
        pin = onBody ? null : this.pinAtEvent(ev);
      }
      if (this.mode && this.mode.k === 'wire') {
        const m = this.mode;
        if (pin) { if (pin.pos.x === m.a.x && pin.pos.y === m.a.y && !m.pts.length) { this.cancelWire(); return; } this._finishWire(pin.pos, pin); return; }
        const last = m.pts.length ? m.pts[m.pts.length - 1] : m.a; const q = { x: snap(w.x), y: snap(w.y) };
        if (ev.detail >= 2) { this._finishWire(q); return; }   // double click ends a wire on empty space
        m.pts.push(...this._ortho(last, q)); this._drawWirePreview(w); return;
      }
      const bEl = ev.target.closest && ev.target.closest('.w-bend');
      if (bEl) { const wid = bEl.closest('.wire').dataset.wid; this.push(); this.mode = { k: 'bend', w: this.wire(wid), i: +bEl.dataset.bend }; svg_capture(this.svg, ev); return; }
      if (pin && !(p && p.type === 'breadboard' && ev.shiftKey)) { this.closeMenu(); this.mode = { k: 'wire', a: pin.pos, pts: [], start: pin, t0: Date.now() }; this._drawWirePreview(w); this.highlight(pin); this.setHint(`Wiring from ${this.pinLabel(pin)} — click the target pin · click empty space to add a bend · Esc / right-click cancels`); return; }
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
      if (ui2On() && !ev.altKey && !this._spacePan) {
        this.select(null);
        this.mode = { k: 'marquee', x0: w.x, y0: w.y, sx: ev.clientX, sy: ev.clientY, moved: false };
        return;
      }
      this.select(null);
      this.mode = { k: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y };
    }
    _ortho(a, q) {
      const basic = this.ortho && a.x !== q.x && a.y !== q.y ? [{ x: q.x, y: a.y }, q] : [q];
      if (!ui2On() || !this.ortho || !this.proj) return basic;
      return this._routeAround(a, q, basic);
    }   // L-shaped bends; ui2 steps around part bodies when that path is clear
    _drawWirePreview(w) {
      const m = this.mode, last = m.pts.length ? m.pts[m.pts.length - 1] : m.a, tgt = this.pinNear(w), end = tgt ? tgt.pos : { x: snap(w.x), y: snap(w.y) };
      const pts = [m.a, ...m.pts, ...this._ortho(last, end)].map((q) => `${q.x},${q.y}`).join(' ');
      this.ovWire.innerHTML = `<polyline points="${pts}" class="w-preview" style="stroke:${this.wireColor === 'auto' ? this.autoColor(m.start, null) : (WIRE_COLORS[this.wireColor] || this.wireColor)}"/>` + (tgt ? `<circle cx="${end.x}" cy="${end.y}" r="5.5" class="hl-target"/>` : '');
    }
    _finishWire(b, endPin) {
      const m = this.mode; this.mode = null; this.ovWire.innerHTML = ''; this.highlight(null); this.setHint();
      if (b.x === m.a.x && b.y === m.a.y && !m.pts.length) return;
      const last = m.pts.length ? m.pts[m.pts.length - 1] : m.a; if (this.ortho) { const c = this._ortho(last, b); if (c.length > 1) m.pts.push(...c.slice(0, -1)); }
      this.push();
      let n = 1; while (this.proj.wires.some((w) => w.id === 'w' + n)) n++;
      this.proj.wires.push({ id: 'w' + n, a: { ...m.a }, b: { x: b.x, y: b.y }, pts: m.pts, color: this.wireColor === 'auto' ? this.autoColor(m.start, endPin) : this.wireColor });
      this.renderWires(); this.hooks.changed(true);
    }
    _move(ev) {
      if (this.mode && this.mode.p && this.proj && !this.proj.parts.includes(this.mode.p)) this.mode = null;
      if (this.mode && this.mode.w && this.proj && !this.proj.wires.includes(this.mode.w)) this.mode = null;
      const w = this.toWorld(ev), m = this.mode;
      if (m && m.k === 'marquee') {
        if (Math.hypot(ev.clientX - m.sx, ev.clientY - m.sy) > 4) m.moved = true;
        const x = Math.min(m.x0, w.x), y = Math.min(m.y0, w.y), ww = Math.abs(w.x - m.x0), hh = Math.abs(w.y - m.y0);
        this.ovHl.innerHTML = `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" class="ui2-marquee" pointer-events="none"/>`;
        return;
      }
      if (m && m.k === 'pan') { if (ev.clientX !== m.sx || ev.clientY !== m.sy) this.markUserView(); this.view.x = m.vx - (ev.clientX - m.sx) / this.view.s; this.view.y = m.vy - (ev.clientY - m.sy) / this.view.s; this.applyView(); return; }
      if (m && m.k === 'knob') { const dlt = ((ev.clientX - m.sx) - (ev.clientY - m.sy)) / 150; m.p.props.pos = Math.min(1, Math.max(0, m.pos0 + dlt)); this.hooks.changed(false); this.refreshDynamic(); this.hooks.selected(this.sel); return; }
      if (m && m.k === 'wire') { this._drawWirePreview(w); const t = this.pinNear(w, ev); this.highlight(m.start, t ? [t.pos] : []); this._emitHover(t ? { ev, pin: t, part: t.part, world: w, label: this.pinLabel(t) } : null); return; }
      if (m && m.k === 'bend') { const q = { x: snap(w.x), y: snap(w.y) }; const b = m.w.pts[m.i]; if (b.x !== q.x || b.y !== q.y) { b.x = q.x; b.y = q.y; m.moved = true; this.renderWires(); } return; }
      if (m && m.k === 'drag') {
        const nx = snap(m.ox + w.x - m.sx), ny = snap(m.oy + w.y - m.sy);
        if (nx !== m.p.x || ny !== m.p.y) {
          if (!m.moved) {
            this.push(); m.moved = true;
            m.group = (ui2On() && this.multi && this.multi.has(m.p.id)) ? [...this.multi] : [m.p.id];
          }
          const dx = nx - m.p.x, dy = ny - m.p.y;
          const ids = m.group || [m.p.id];
          for (const id of ids) {
            const q = this.part(id); if (!q) continue;
            q.x += dx; q.y += dy;
            const g = this.partEls.get(id); if (g) g.setAttribute('transform', P.partTransform(q));
          }
          this._pinIdx = null;
          if (m.p.type !== 'breadboard') {   // show which breadboard holes/strips the part's legs will land in
            const holes = []; for (const pin of P.T[m.p.type].pins(m.p)) { const pw = P.pinWorld(m.p, pin); const h = this.pinIndex().find((q) => q.bb && q.pos.x === pw.x && q.pos.y === pw.y); if (h) holes.push(h.pos); }
            this.highlight(null, holes);
            if (ui2On() && holes.length) { try { this.ovHl.insertAdjacentHTML('beforeend', this._stripMarks(holes)); } catch (e) { /* the pin circles already mark the joint */ } }
          }
        }
        return;
      }
      const pin = this.pinAtEvent(ev); const partEl = ev.target.closest && ev.target.closest('.part');
      const wEl = !pin && ev.target.closest && ev.target.closest('.wire');
      const hk = pin ? pin.pos.x + ',' + pin.pos.y : (wEl ? 'w:' + wEl.dataset.wid : ''); if (hk !== this.hoverPin) { this.hoverPin = hk; this.highlight(pin); }
      this.svg.classList.toggle('on-pin', !!pin);
      if (wEl) { const wire = this.wire(wEl.dataset.wid); this._emitHover({ ev, wire, world: w }); return; }
      this._emitHover({ ev, pin, part: pin ? pin.part : partEl ? this.part(partEl.dataset.id) : null, world: w, label: pin ? this.pinLabel(pin) : '' });
    }
    _up(ev) {
      if (!this.proj) { this.mode = null; return; }
      const m = this.mode; if (!m) return;
      if (m.k === 'press') { this.hooks.press(m.p, false); this.mode = null; return; }
      if (m.k === 'marquee') {
        this.mode = null; const box = this.ovHl.innerHTML; this.ovHl.innerHTML = '';
        if (!m.moved) { this.select(null); return; }
        const w = this.toWorld(ev);
        const x = Math.min(m.x0, w.x), y = Math.min(m.y0, w.y), ww = Math.abs(w.x - m.x0), hh = Math.abs(w.y - m.y0);
        const ids = [];
        for (const p of this.proj.parts) {
          if (!p || p.type === 'breadboard' || !P.T[p.type]) continue;
          const sz = P.T[p.type].size(p) || { w: 16, h: 16 };
          if (p.x < x + ww && p.x + sz.w > x && p.y < y + hh && p.y + sz.h > y) ids.push(p.id);
        }
        this.multi = new Set(ids);
        this._keepMulti = true;
        this.select(ids.length ? { part: ids[ids.length - 1] } : null);
        this._keepMulti = false;
        if (box && !ids.length) this.select(null);
        return;
      }
      if (m.k === 'drag') { this.mode = null; this.highlight(null); if (m.moved) this.hooks.changed(true); return; }
      if (m.k === 'bend') { this.mode = null; if (m.moved) this.hooks.changed(false); else this.undoS.pop(); return; }
      if (m.k === 'pan') { this.mode = null; return; }
      if (m.k === 'knob') { this.mode = null; return; }
      if (m.k === 'wire') {   // drag-release on a pin finishes a wire too
        const pin = this.pinAtEvent(ev);
        if (pin && (pin.pos.x !== m.a.x || pin.pos.y !== m.a.y) && !m.pts.length) this._finishWire(pin.pos, pin);
      }
    }
    _toggleMulti(id) {
      if (!this.multi) this.multi = new Set();
      if (this.sel && this.sel.part) this.multi.add(this.sel.part);
      if (this.multi.has(id)) this.multi.delete(id); else this.multi.add(id);
      const left = [...this.multi];
      this._keepMulti = true;
      this.select(this.multi.has(id) ? { part: id } : (left.length ? { part: left[left.length - 1] } : null));
      this._keepMulti = false;
      this.render();
    }
    copySel() {
      const ids = new Set(this.multi && this.multi.size ? this.multi : []);
      if (this.sel && this.sel.part) ids.add(this.sel.part);
      const parts = this.proj.parts.filter((p) => ids.has(p.id) && p.type !== 'breadboard').map((p) => JSON.parse(JSON.stringify(p)));
      if (!parts.length) return false;
      const keys = new Set();
      for (const p of parts) for (const pin of this._pinWorlds(p)) keys.add(this._pinKey(pin.x, pin.y));
      const wires = this.proj.wires.filter((w) => keys.has(this._pinKey(w.a.x, w.a.y)) && keys.has(this._pinKey(w.b.x, w.b.y))).map((w) => JSON.parse(JSON.stringify(w)));
      this._clip = { parts, wires };
      return true;
    }
    pasteSel() {
      if (!this._clip || !this._clip.parts.length) return null;
      this.push();
      const dx = 30, dy = 30, made = [];
      for (const src of this._clip.parts) {
        const d = P.T[src.type]; if (!d) continue;
        let n = 1; const pre = (d.prefix || src.type.slice(0, 3).toUpperCase());
        while (this.proj.parts.some((p) => p.id === pre + n) || made.some((p) => p.id === pre + n)) n++;
        const p = JSON.parse(JSON.stringify(src));
        p.id = pre + n; p.x += dx; p.y += dy;
        this.proj.parts.push(p); made.push(p);
      }
      for (const src of this._clip.wires || []) {
        let n = 1; while (this.proj.wires.some((w) => w.id === 'w' + n)) n++;
        const w = JSON.parse(JSON.stringify(src));
        w.id = 'w' + n;
        w.a.x += dx; w.a.y += dy; w.b.x += dx; w.b.y += dy;
        for (const q of w.pts || []) { q.x += dx; q.y += dy; }
        this.proj.wires.push(w);
      }
      this.multi = new Set(made.map((p) => p.id));
      this._keepMulti = true;
      this.select(made.length ? { part: made[made.length - 1].id } : null);
      this._keepMulti = false;
      this.render(); this.hooks.changed(true);
      return made;
    }
    duplicateSel() { return this.copySel() ? this.pasteSel() : null; }
    nudge(dx, dy) {
      const ids = this.multi && this.multi.size ? [...this.multi] : (this.sel && this.sel.part ? [this.sel.part] : []);
      if (!ids.length || (!dx && !dy)) return;
      this.push();
      for (const id of ids) { const p = this.part(id); if (!p) continue; p.x += dx; p.y += dy; }
      this._pinIdx = null; this.render(); this.hooks.changed(true); if (this.hooks.selected) this.hooks.selected(this.sel);
    }
    _clearGhost() { this._ghostType = ''; this._ghostW = null; if (this.ovHl && !this.mode) this.ovHl.innerHTML = ''; }
    _showGhost(type, w) {
      if (!type || !w || !P.T[type] || !this.ovHl) return;
      const seat = this.freeSeat(type, w.x, w.y);
      const fake = { id: 'ghost', type, x: seat.x, y: seat.y, rot: 0, props: JSON.parse(JSON.stringify(P.T[type].props || {})) };
      let svg = ''; try { svg = P.T[type].svg(fake, null) || ''; } catch (e) { svg = ''; }
      const holes = [];
      try {
        for (const pin of P.T[type].pins(fake)) {
          const pw = P.pinWorld(fake, pin);
          const h = this.pinIndex().find((q) => q.bb && q.pos.x === pw.x && q.pos.y === pw.y);
          if (h) holes.push(h.pos);
        }
      } catch (e) { /* the footprint still shows */ }
      this.ovHl.innerHTML = `<g class="ui2-ghost" transform="${P.partTransform(fake)}" opacity="0.5" pointer-events="none">${svg}</g>` + this._stripMarks(holes);
    }
    _stripMarks(points) {
      let s = ''; const seen = new Set(); const idx = this.pinIndex();
      for (const h of points || []) {
        const pin = idx.find((q) => q.bb && q.pos.x === h.x && q.pos.y === h.y);
        if (!pin) continue;
        const m = /^([a-j])(\d+)$/.exec(pin.pin.name); if (!m) continue;
        const side = 'abcde'.includes(m[1]) ? 'abcde' : 'fghij';
        const key = pin.part.id + ':' + side + ':' + m[2];
        if (seen.has(key)) continue; seen.add(key);
        const mates = [];
        for (const L of side) {
          const mate = idx.find((q) => q.bb && q.part.id === pin.part.id && q.pin.name === L + m[2]);
          if (mate) mates.push(mate.pos);
        }
        if (mates.length < 2) continue;
        const xs = mates.map((p) => p.x), ys = mates.map((p) => p.y);
        const x0 = Math.min.apply(null, xs) - 5, y0 = Math.min.apply(null, ys) - 5;
        const x1 = Math.max.apply(null, xs) + 5, y1 = Math.max.apply(null, ys) + 5;
        s += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="3" class="ui2-row" pointer-events="none"/>`;
      }
      return s;
    }
    _obstacleBoxes(a, q) {
      const boxes = [], skip = new Set();
      const owner = (pt) => {
        for (const p of this.proj.parts) {
          if (!p || p.type === 'breadboard' || !P.T[p.type]) continue;
          for (const pin of this._pinWorlds(p)) if (Math.abs(pin.x - pt.x) < 1.2 && Math.abs(pin.y - pt.y) < 1.2) return p.id;
        }
        return '';
      };
      skip.add(owner(a)); skip.add(owner(q));
      for (const p of this.proj.parts) {
        if (!p || skip.has(p.id) || p.type === 'breadboard' || p.type === 'label' || !P.T[p.type]) continue;
        const sz = P.T[p.type].size(p) || { w: 20, h: 10 };
        boxes.push({ x0: p.x - 6, y0: p.y - 8, x1: p.x + (sz.w || 20) + 6, y1: p.y + Math.max(sz.h || 8, 8) + 8 });
      }
      return boxes;
    }
    _segBox(a, b, box) {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      return Math.max(x0, box.x0) <= Math.min(x1, box.x1) && Math.max(y0, box.y0) <= Math.min(y1, box.y1);
    }
    _polyHits(a, pts, boxes) {
      const seq = [a, ...pts];
      for (let i = 0; i < seq.length - 1; i++) for (const box of boxes) if (this._segBox(seq[i], seq[i + 1], box)) return true;
      return false;
    }
    _routeAround(a, q, basic) {
      let boxes = [];
      try { boxes = this._obstacleBoxes(a, q); } catch (e) { return basic; }
      if (!boxes.length || !this._polyHits(a, basic, boxes)) return basic;
      const alt = (a.x !== q.x && a.y !== q.y) ? [{ x: a.x, y: q.y }, q] : [q];
      if (!this._polyHits(a, alt, boxes)) return alt;
      const box = boxes[0];
      const top = box.y0 - 8, bot = box.y1 + 8;
      const y = Math.abs(a.y - top) + Math.abs(q.y - top) <= Math.abs(a.y - bot) + Math.abs(q.y - bot) ? top : bot;
      const yy = snap(y), pts = [];
      if (a.y !== yy) pts.push({ x: snap(a.x), y: yy });
      if (snap(q.x) !== snap(a.x)) pts.push({ x: snap(q.x), y: yy });
      pts.push({ x: q.x, y: q.y });
      if (!this._polyHits(a, pts, boxes)) return pts;
      return basic;
    }
    _wheel(ev) {
      ev.preventDefault();
      const partEl = ev.target.closest('.part'); const p = partEl && this.part(partEl.dataset.id);
      if (p && P.T[p.type].wheel && !ev.ctrlKey) { if (P.T[p.type].wheel(p, Math.sign(ev.deltaY))) { this.hooks.changed(false); this.refreshDynamic(); this.hooks.selected(this.sel); } return; }
      this.markUserView();
      const w = this.toWorld(ev), f = Math.exp(-ev.deltaY * 0.0015), s = Math.min(4, Math.max(0.15, this.view.s * f));
      this.view.x = w.x - (w.x - this.view.x) * this.view.s / s; this.view.y = w.y - (w.y - this.view.y) * this.view.s / s; this.view.s = s; this.applyView();
    }
  }
  function svg_capture(svg, ev) { try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Y and Ctrl/Cmd+Shift+Z redo. z/Z and y/Y so Caps Lock still matches.
  // A value field (input, textarea, select) returns null: the browser keeps native text undo.
  function editChord(e) {
    if (!e) return null;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return null;
    if (!(e.ctrlKey || e.metaKey)) return null;
    const k = String(e.key || '').toLowerCase();
    const z = k === 'z' || e.code === 'KeyZ';
    const y = k === 'y' || e.code === 'KeyY';
    if (z && e.shiftKey) return 'redo';
    if (z) return 'undo';
    if (y) return 'redo';
    return null;
  }
  Editor.editChord = editChord;
  root.Editor = Editor; root.WIRE_COLORS = WIRE_COLORS;
})(window);
