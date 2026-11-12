/* Pinch zoom shared by the 2D breadboard, the schematic and the 3D orbit.
 * A gesture remembers the world point under the midpoint between the two fingers.
 * Later moves keep that point under the current midpoint, so zoom and two-finger
 * pan stay anchored, and the scale is clamped. */
(function (root) {
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function worldAt(view, client, rect) {
    const s = view.s || 1;
    return {
      x: view.x + (client.x - rect.left) / s,
      y: view.y + (client.y - rect.top) / s,
    };
  }
  // anchor: { s, dist, wx, wy } from the frame the second finger landed.
  function applyView(anchor, mid, dist, rect, limits) {
    const s = clamp(anchor.s * (dist / Math.max(anchor.dist, 1e-6)), limits.min, limits.max);
    return {
      s: s,
      x: anchor.wx - (mid.x - rect.left) / s,
      y: anchor.wy - (mid.y - rect.top) / s,
    };
  }
  // Perspective dolly. right/up are the camera axes at gesture start (world space).
  // ndc is the midpoint in normalized device coordinates (y up). The world point on
  // the focal plane stays under the midpoint as the radius and the midpoint change.
  function orbit(o) {
    const r = clamp(o.r0 * (o.dist0 / Math.max(o.dist, 1e-6)), o.minR, o.maxR);
    const tan = Math.tan(o.fov / 2);
    const halfH0 = o.r0 * tan, halfW0 = halfH0 * o.aspect;
    const nd0 = o.ndc0;
    const W = {
      x: o.target.x + o.right.x * nd0.x * halfW0 + o.up.x * nd0.y * halfH0,
      y: o.target.y + o.right.y * nd0.x * halfW0 + o.up.y * nd0.y * halfH0,
      z: o.target.z + o.right.z * nd0.x * halfW0 + o.up.z * nd0.y * halfH0,
    };
    const halfH = r * tan, halfW = halfH * o.aspect;
    const nd = o.ndc;
    return {
      r: r,
      world: W,
      target: {
        x: W.x - o.right.x * nd.x * halfW - o.up.x * nd.y * halfH,
        y: W.y - o.right.y * nd.x * halfW - o.up.y * nd.y * halfH,
        z: W.z - o.right.z * nd.x * halfW - o.up.z * nd.y * halfH,
      },
    };
  }
  function cloneSel(s) {
    if (!s) return null;
    if (s.part) return { part: s.part };
    if (s.wire) return { wire: s.wire };
    return null;
  }
  // Drop whatever the first finger started. Restore a dragged part, drop a rubber-band
  // wire (however long it has been up), and put the selection back.
  function cancelEditorGesture(ed, prevSel) {
    if (!ed) return;
    const m = ed.mode;
    if (m && m.k === 'drag' && m.p) {
      if (m.moved) {
        m.p.x = m.ox; m.p.y = m.oy;
        if (ed.undoS && ed.undoS.length) ed.undoS.pop();
      }
    } else if (m && m.k === 'wire') {
      if (typeof ed.cancelWire === 'function') ed.cancelWire();
    } else if (m && m.k === 'bend') {
      if (m.moved && ed.undoS && ed.undoS.length && typeof ed._restore === 'function') ed._restore(ed.undoS.pop());
      else if (ed.undoS && ed.undoS.length) ed.undoS.pop();
    } else if (m && m.k === 'knob' && m.p && m.p.props) {
      m.p.props.pos = m.pos0;
    } else if (m && m.k === 'press' && ed.hooks && typeof ed.hooks.press === 'function') {
      try { ed.hooks.press(m.p, false); } catch (e) { /* release is best-effort */ }
    }
    ed.mode = null;
    if (ed.ovWire) ed.ovWire.innerHTML = '';
    if (typeof ed.highlight === 'function') ed.highlight(null);
    const sel = cloneSel(prevSel);
    if (typeof ed.select === 'function') ed.select(sel);
    else ed.sel = sel;
    if (m && m.k === 'drag' && typeof ed.render === 'function') ed.render();
  }
  function box(r) {
    if (!r) return null;
    const left = +r.left, top = +r.top;
    const right = r.right != null ? +r.right : left + (+r.width || 0);
    const bottom = r.bottom != null ? +r.bottom : top + (+r.height || 0);
    if (!(right > left) || !(bottom > top)) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }
  function rectOf(left, top, right, bottom) {
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }
  // Visible area of the stage after the phone chrome. A control is one edge:
  // a chip in the top row (header, Make a copy, + Parts) raises the top;
  // a wide bar in the lower half (hint, toolbars, Circuit) raises the bottom;
  // a tall control on the right (the zoom stack) insets that side only.
  // A corner chip is never a full-height column. If the leftovers would be a
  // strip, keep the whole stage rather than collapse the picture.
  function clearRect(stage, blockers, gap) {
    const S = box(stage);
    if (!S) return rectOf(0, 0, 0, 0);
    const g = gap == null ? 8 : gap;
    let top = S.top, bottom = S.bottom, left = S.left, right = S.right;
    const H = S.height, W = S.width;
    const topRow = S.top + Math.min(170, H * 0.26);
    for (const raw of blockers || []) {
      const b = box(raw);
      if (!b) continue;
      const ixL = Math.max(b.left, S.left), ixR = Math.min(b.right, S.right);
      const ixT = Math.max(b.top, S.top), ixB = Math.min(b.bottom, S.bottom);
      if (ixR - ixL < 8 || ixB - ixT < 8) continue;
      const slice = { left: ixL, top: ixT, right: ixR, bottom: ixB };
      const wide = (slice.right - slice.left) >= W * 0.55;
      const midY = (slice.top + slice.bottom) / 2;
      const cx = (slice.left + slice.right) / 2;
      if (slice.bottom <= topRow || (wide && midY <= S.top + H * 0.34)) top = Math.max(top, slice.bottom + g);
      else if (slice.top >= S.top + H * 0.5 || (wide && midY >= S.top + H * 0.55)) bottom = Math.min(bottom, slice.top - g);
      else if (cx >= S.left + W * 0.55) right = Math.min(right, slice.left - g);
      else if (cx <= S.left + W * 0.45) left = Math.max(left, slice.right + g);
    }
    if (right - left < W * 0.35 || bottom - top < H * 0.35) return rectOf(S.left, S.top, S.right, S.bottom);
    return rectOf(left, top, right, bottom);
  }
  // Every maximal empty rectangle inside the stage, gap pixels clear of each blocker.
  // A side control (the zoom stack) only blocks its own box, so the area under it
  // stays available. Top and bottom bars still block the band they actually cover.
  function emptyRects(stage, blockers, gap) {
    const S = box(stage);
    if (!S) return [];
    const g = gap == null ? 8 : gap;
    const obs = [];
    for (const raw of blockers || []) {
      const b = box(raw);
      if (!b) continue;
      const left = Math.max(S.left, b.left - g), top = Math.max(S.top, b.top - g);
      const right = Math.min(S.right, b.right + g), bottom = Math.min(S.bottom, b.bottom + g);
      if (right - left < 1 || bottom - top < 1) continue;
      obs.push(rectOf(left, top, right, bottom));
    }
    const ys = [S.top, S.bottom];
    for (const b of obs) { ys.push(b.top, b.bottom); }
    ys.sort((a, c) => a - c);
    const y = [];
    for (const v of ys) if (!y.length || v - y[y.length - 1] > 0.25) y.push(v);
    const rects = [];
    for (let i = 0; i < y.length; i++) {
      for (let j = i + 1; j < y.length; j++) {
        const y0 = y[i], y1 = y[j];
        if (y1 - y0 < 8) continue;
        const spans = [];
        for (const b of obs) {
          if (b.bottom <= y0 + 0.25 || b.top >= y1 - 0.25) continue;
          spans.push([b.left, b.right]);
        }
        spans.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
        let x = S.left;
        for (const [l, r] of spans) {
          if (l > x + 0.25) rects.push(rectOf(x, y0, l, y1));
          if (r > x) x = r;
        }
        if (S.right > x + 0.25) rects.push(rectOf(x, y0, S.right, y1));
      }
    }
    return rects;
  }
  function rawScale(bounds, clear, pad) {
    const C = box(clear);
    if (!C || !bounds) return 0;
    const p = pad == null ? 12 : pad;
    const availW = C.width - 2 * p, availH = C.height - 2 * p;
    if (availW <= 1 || availH <= 1) return 0;
    return Math.min(availW / Math.max(bounds.w, 1e-6), availH / Math.max(bounds.h, 1e-6));
  }
  function bestClear(stage, blockers, bounds, gap, pad, limits) {
    const g = gap == null ? 8 : gap;
    const legacy = clearRect(stage, blockers, g);
    const minS = limits && limits.min != null ? limits.min : 0.12;
    const maxS = limits && limits.max != null ? limits.max : 4;
    const scoreOf = (raw) => (raw >= minS ? Math.min(raw, maxS) : raw);
    let best = legacy, bestS = scoreOf(rawScale(bounds, legacy, pad)), bestA = legacy ? legacy.width * legacy.height : 0, legacyWins = true;
    for (const r of emptyRects(stage, blockers, g)) {
      const s = scoreOf(rawScale(bounds, r, pad));
      const a = r.width * r.height;
      if (s > bestS + 1e-4) { best = r; bestS = s; bestA = a; legacyWins = false; }
      else if (!legacyWins && Math.abs(s - bestS) <= 1e-4 && a > bestA + 0.5) { best = r; bestA = a; }
    }
    return best || rectOf(0, 0, 0, 0);
  }
  function phoneLayout() {
    try {
      return typeof document !== 'undefined' && document.body && document.body.classList.contains('m');
    } catch (e) { return false; }
  }
  // Phone fit uses bestClear. Desktop keeps the edge-inset rect, so a wide
  // window does not move. tight forces the phone choice in tests.
  function resolveClear(frame, bounds, pad, limits, tight) {
    if (!frame) return null;
    const on = tight == null ? phoneLayout() : !!tight;
    if (!on || !bounds || !frame.blockers) return frame.clear;
    return bestClear(frame.stage, frame.blockers, bounds, 8, pad, limits);
  }
  // Center bounds in the clear rect. pad is screen pixels inside that rect.
  // The returned view is the SVG viewBox origin: world = view + (screen - stage) / s.
  function fitView(bounds, stage, clear, pad, limits) {
    const S = box(stage);
    const C = box(clear) || S;
    if (!S || !bounds) return { x: 0, y: 0, s: 1 };
    const p = pad == null ? 12 : pad;
    const minS = limits && limits.min != null ? limits.min : 0.12;
    const maxS = limits && limits.max != null ? limits.max : 4;
    const availW = Math.max(1, C.width - 2 * p);
    const availH = Math.max(1, C.height - 2 * p);
    const s = clamp(Math.min(availW / Math.max(bounds.w, 1e-6), availH / Math.max(bounds.h, 1e-6)), minS, maxS);
    const sx = (C.left + C.right) / 2 - S.left;
    const sy = (C.top + C.bottom) / 2 - S.top;
    return { s: s, x: bounds.x + bounds.w / 2 - sx / s, y: bounds.y + bounds.h / 2 - sy / s };
  }
  function zoomAbout(view, factor, client, stage, limits) {
    const S = box(stage);
    const s = clamp(view.s * factor, limits.min, limits.max);
    const sx = client.x - S.left, sy = client.y - S.top;
    const wx = view.x + sx / view.s, wy = view.y + sy / view.s;
    return { s: s, x: wx - sx / s, y: wy - sy / s };
  }
  function clearCenter(frame) {
    const c = frame.clear;
    return { x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2 };
  }
  const CHROME = 'header#top, #mTicker, .projbanner, #bCopy, #mParts, .zoom-tools, .canvas-tools, .hint, #mIgnite, #mHub, #mSel, .exit3d';
  function frameOf(el) {
    const s = el.getBoundingClientRect();
    const stage = { left: s.left, top: s.top, right: s.right, bottom: s.bottom, width: s.width, height: s.height };
    const blockers = [];
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const phone = phoneLayout();
      document.querySelectorAll(CHROME).forEach((node) => {
        if (node === el) return;
        // The banner is stretched across the canvas. On a phone the only visible
        // control in it is Make a copy, which is measured on its own.
        if (phone && node.classList && node.classList.contains('projbanner')) return;
        let cs; try { cs = getComputedStyle(node); } catch (e) { return; }
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
        const r = node.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        blockers.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      });
    }
    return { stage: stage, clear: clearRect(stage, blockers, 8), blockers: blockers };
  }
  function usesTouchHint() {
    try {
      if (typeof document !== 'undefined' && document.body && document.body.classList.contains('m')) return true;
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) return true;
    } catch (e) { /* keep the desktop hint */ }
    return false;
  }
  // F is a keyboard shortcut. Phones never see it, and the long sentence does not fit the hint.
  function schematicHint(touch) {
    const on = touch == null ? usesTouchHint() : !!touch;
    return on
      ? 'View only. Tap a part to inspect it. Edit wiring in 2D.'
      : 'F mirrors the symbol (drawing only, wiring unchanged)';
  }
  // A finger on the selection toolbar, the properties sheet, or the scrim is still
  // part of a pinch. Those nodes sit outside #stage, so a hit-test that only
  // accepts the SVG drops the finger and the other finger pans. The code dock
  // and the parts tray keep their own scrolling.
  function isPinchSurface(node) {
    const el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!el || typeof el.closest !== 'function') return false;
    if (el.closest('#dock, #palette, #mMore')) return false;
    return !!el.closest('#stageWrap, #mSel, #mPartMenu, #mScrim, #side, .ctxmenu');
  }
  // Chrome does not use the touch identifier as the pointer id: the mouse keeps
  // pointer id 1, and each new contact gets the next pointer id. Pruning the
  // pointer map with Touch.identifier deletes the finger that just landed.
  function createPointerBook() { return { touchToPointer: new Map(), pending: [] }; }
  // A new primary contact means the browser has ended every previous touch of
  // this type. Anything still stored is the selection tap whose pointerup landed
  // on a node that was removed or covered when the toolbar appeared, so it never
  // reached the listener. Returns those ghost ids; the caller drops them.
  function notePointerDown(book, pointerId, info) {
    const dropped = [];
    if (!book) return dropped;
    if (info && info.isPrimary) {
      for (const id of book.pending) if (id !== pointerId) dropped.push(id);
      book.pending = [];
      for (const [tid, pid] of [...book.touchToPointer]) {
        if (pid !== pointerId) { book.touchToPointer.delete(tid); if (dropped.indexOf(pid) < 0) dropped.push(pid); }
      }
    }
    if (book.pending.indexOf(pointerId) < 0) book.pending.push(pointerId);
    return dropped;
  }
  function notePointerUp(book, pointerId) {
    if (!book) return;
    book.pending = book.pending.filter((id) => id !== pointerId);
    for (const [tid, pid] of book.touchToPointer) if (pid === pointerId) book.touchToPointer.delete(tid);
  }
  // A quiet pointer is dropped only when the browser is not still reporting that
  // touch. A finger held still has no moves and no pointerup, and it stays in
  // the touch list, so a pinch a few seconds later can still use it. The pointer
  // sending the current event is always kept.
  function expireQuiet(book, pts, now, exceptId, maxAge) {
    const dropped = [];
    if (!pts) return dropped;
    const age = maxAge == null ? 1000 : maxAge;
    const live = new Set();
    if (book && book.touchToPointer) for (const pid of book.touchToPointer.values()) live.add(pid);
    for (const [id, p] of pts) {
      if (id === exceptId || live.has(id)) continue;
      if (!p || p.t == null || now - p.t <= age) continue;
      pts.delete(id);
      dropped.push(id);
      notePointerUp(book, id);
    }
    return dropped;
  }
  // touches / changed are {identifier} lists. pointerdown is queued until the
  // touchstart that follows it (pointerdown fires first). A pointer still queued
  // from a selection tap that never ended is older than this touchstart, so it
  // is dropped instead of being counted as a third finger.
  function syncPointers(book, pts, touches, changed) {
    const down = touches || [];
    const started = changed || [];
    if (!book || !pts) return pts;
    if (!down.length) {
      book.pending = []; book.touchToPointer.clear(); pts.clear();
      return pts;
    }
    if (started.length && book.pending.length > started.length) {
      const stale = book.pending.splice(0, book.pending.length - started.length);
      for (const id of stale) pts.delete(id);
    }
    for (const t of started) {
      if (!book.pending.length) break;
      book.touchToPointer.set(t.identifier, book.pending.shift());
    }
    const live = new Set();
    for (const t of down) {
      const pid = book.touchToPointer.get(t.identifier);
      if (pid != null) live.add(pid);
    }
    const waiting = new Set(book.pending);
    for (const id of [...pts.keys()]) if (!live.has(id) && !waiting.has(id)) pts.delete(id);
    for (const tid of [...book.touchToPointer.keys()]) {
      if (!down.some((t) => t.identifier === tid)) book.touchToPointer.delete(tid);
    }
    return pts;
  }
  function trackPinchPointer(state, hit) {
    const pts = state.pts;
    if (!hit.track) return { start: pts.size >= 2, size: pts.size, tracked: false, anchorSel: state.anchorSel || null };
    // A stale tap can leave the map non-empty. Capture the selection the first time
    // a real finger arrives so cancel restores what was selected before this gesture.
    if (pts.size === 0 || !state.anchorSel) state.anchorSel = cloneSel(hit.sel);
    pts.set(hit.id, { x: hit.x, y: hit.y, t: hit.now || 0 });
    return { start: pts.size >= 2, size: pts.size, tracked: true, anchorSel: state.anchorSel };
  }
  const api = {
    clamp: clamp, worldAt: worldAt, applyView: applyView, orbit: orbit, cloneSel: cloneSel, cancelEditorGesture: cancelEditorGesture,
    clearRect: clearRect, emptyRects: emptyRects, rawScale: rawScale, bestClear: bestClear, resolveClear: resolveClear,
    fitView: fitView, zoomAbout: zoomAbout, clearCenter: clearCenter, frameOf: frameOf, schematicHint: schematicHint,
    isPinchSurface: isPinchSurface, createPointerBook: createPointerBook, notePointerDown: notePointerDown,
    notePointerUp: notePointerUp, expireQuiet: expireQuiet, syncPointers: syncPointers, trackPinchPointer: trackPinchPointer,
  };
  root.Pinch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
