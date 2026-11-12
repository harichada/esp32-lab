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
  const api = { clamp: clamp, worldAt: worldAt, applyView: applyView, orbit: orbit, cloneSel: cloneSel, cancelEditorGesture: cancelEditorGesture };
  root.Pinch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
