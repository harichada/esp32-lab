/* Shared helpers for the actuator / power / semiconductor add-on parts (js/parts/actuators.js, power.js, semis.js).
 * Artwork primitives in the same polished dark style as parts-art.js, plus logic-level / driver lookup helpers
 * that work both with the ESP32 (driven GPIO levels) and in basic-circuit mode (node voltages of the last solve). */
(function (root) {
  if (root.HwKit) return;
  const P = root.Parts, esc = P.esc, fmt = P.fmt;
  const DEFS = `
<linearGradient id="hkBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6fd6"/><stop offset="1" stop-color="#16408f"/></linearGradient>
<linearGradient id="hkRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c4262b"/><stop offset="1" stop-color="#7d1015"/></linearGradient>
<linearGradient id="hkGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8a4c"/><stop offset="1" stop-color="#0f5530"/></linearGradient>
<linearGradient id="hkPcb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f36"/><stop offset="1" stop-color="#15171b"/></linearGradient>
<linearGradient id="hkMetal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef1f4"/><stop offset=".4" stop-color="#b9c0c8"/><stop offset=".7" stop-color="#dfe3e7"/><stop offset="1" stop-color="#8d949c"/></linearGradient>
<linearGradient id="hkAlu" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7e858d"/><stop offset=".5" stop-color="#d9dde2"/><stop offset="1" stop-color="#6f767e"/></linearGradient>
<linearGradient id="hkBlk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34373d"/><stop offset="1" stop-color="#111214"/></linearGradient>
<linearGradient id="hkCellBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a8be8"/><stop offset=".5" stop-color="#1f5fb8"/><stop offset="1" stop-color="#103a78"/></linearGradient>
<linearGradient id="hkTerm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fa7e0"/><stop offset="1" stop-color="#1e6f9f"/></linearGradient>
<linearGradient id="hkGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7dd84"/><stop offset="1" stop-color="#b8892a"/></linearGradient>
<linearGradient id="hkCopper" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a4a17"/><stop offset=".5" stop-color="#e59a52"/><stop offset="1" stop-color="#7a3f12"/></linearGradient>`;
  function injectDefs() { const d = document.querySelector('#stage defs'); if (d && !d.querySelector('#hkBlue')) d.insertAdjacentHTML('beforeend', DEFS); }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectDefs); else injectDefs(); }

  const dots = (pins) => pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="2.6" class="pin" data-pin="${esc(q.name)}"/>`).join('');
  const silk = (x, y, t, sz = 4.2, anchor = 'middle', rot, fill = '#f2f2f2') => `<text x="${x}" y="${y}" font-size="${sz}" fill="${fill}" font-family="ui-monospace,Menlo,monospace" text-anchor="${anchor}"${rot !== undefined ? ` transform="rotate(${rot} ${x} ${y})"` : ''} pointer-events="none">${esc(t)}</text>`;
  const header = (xs, y) => xs.map((x) => `<rect x="${x - 4.6}" y="${y - 4.6}" width="9.2" height="9.2" rx=".8" fill="#17181b" stroke="#000" stroke-width=".4"/><rect x="${x - 2}" y="${y - 2}" width="4" height="4" rx=".5" fill="url(#hkGold)"/>`).join('');
  const mhole = (x, y, r = 2.2) => `<circle cx="${x}" cy="${y}" r="${r + 1}" fill="url(#hkGold)"/><circle cx="${x}" cy="${y}" r="${r}" fill="#0d0f12"/>`;
  const lead = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="url(#aLeadV)" stroke-width="1.8"/>`;
  const wireLead = (x, y1, y2, col) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${col}" stroke-width="2.4" stroke-linecap="round"/>`;
  const smoke = (x, y) => `<g class="smoke"><circle cx="${x}" cy="${y}" r="5"/><circle cx="${x + 4}" cy="${y - 10}" r="6"/><circle cx="${x - 2}" cy="${y - 20}" r="7"/></g>`;
  const led = (x, y, on, col = '#ff3b30', r = 2.2) => `<rect x="${x - r}" y="${y - r * 0.7}" width="${2 * r}" height="${1.4 * r}" rx=".5" fill="${on ? col : '#3a2a2a'}" stroke="#0006" stroke-width=".3"/>` + (on ? `<circle cx="${x}" cy="${y}" r="${r * 3}" fill="${col}" opacity=".55" filter="url(#fGlow)" pointer-events="none"/>` : '');
  const plbl = (x, y, t, cls = 'plbl') => `<text x="${x}" y="${y}" class="${cls}">${esc(t)}</text>`;
  // screw terminal block, pins at xs (pitch 10) on row y, body above
  const screws = (xs, y) => { const x0 = Math.min(...xs) - 5, w = Math.max(...xs) - Math.min(...xs) + 10; return `<rect x="${x0}" y="${y - 18}" width="${w}" height="14" rx="1.2" fill="url(#hkTerm)" stroke="#0c3d5c" stroke-width=".5"/>` + xs.map((x) => `<circle cx="${x}" cy="${y - 11}" r="3.3" fill="url(#hkMetal)" stroke="#555" stroke-width=".4"/><path d="M${x - 2.2} ${y - 11} h4.4" stroke="#444" stroke-width=".9"/>`).join(''); };
  // TO-220 package (pins at xs on y=0, body above)
  const to220 = (xs, name, sub, hot) => { const x0 = xs[0] - 8, w = xs[xs.length - 1] - xs[0] + 16; return xs.map((x) => lead(x, 0, -10)).join('') +
    `<rect x="${x0 + 1}" y="-58" width="${w - 2}" height="22" rx="1.5" fill="url(#hkAlu)" stroke="#555" stroke-width=".5" filter="url(#fShadow)"/><circle cx="${x0 + w / 2}" cy="-48" r="4.2" fill="#1b1d21" stroke="#888" stroke-width=".5"/>` +
    `<rect x="${x0}" y="-38" width="${w}" height="28" rx="1.2" fill="url(#hkBlk)" stroke="#000" stroke-width=".5"/>` + silk(x0 + w / 2, -26, name, 4.6) + (sub ? silk(x0 + w / 2, -18, sub, 3.4, 'middle', undefined, '#b9bec6') : '') +
    (hot ? `<rect x="${x0}" y="-58" width="${w}" height="48" rx="2" fill="#ff5a1a" opacity="${Math.min(0.55, hot)}" filter="url(#fGlow)" pointer-events="none"/>` : ''); };
  // TO-92 package with print
  const to92 = (name, sub) => [0, 10, 20].map((x) => lead(x, 0, -6)).join('') + `<path d="M-4 -6 h28 v-10 a14 10 0 0 0 -28 0 z" fill="url(#hkBlk)" stroke="#000" stroke-width=".5" filter="url(#fShadow)"/><path d="M-2 -8 h24" stroke="#ffffff22"/>` + silk(10, -12, name, 3.6) + (sub ? silk(10, -21, sub, 3, 'middle', undefined, '#9aa0a8') : '');
  const lbls = (names, xs, y) => names.map((n, i) => `<text x="${xs[i]}" y="${y}" class="plbl small">${esc(n)}</text>`).join('');

  // ---------- electrical helpers ----------
  const net = (sim, p, name) => { const n = sim.pinNet && sim.pinNet.get(p.id + ':' + name); return n === undefined ? -1 : n; };
  const volt = (sim, p, name) => (sim.circuit ? sim.pinVoltage(p, name) : 0);
  // logic level on a part input: the ESP32's driven GPIO level when it drives the net, else the last solved voltage
  function level(c, p, name, ref, th = 1.5) {
    const g = c.gpio(p, name);
    if (g && g.pin.out) { if (g.pin.pwm !== undefined) return g.pin.pwm > 0.5 ? 1 : 0; return g.pin.level ? 1 : 0; }
    const v = volt(c.sim, p, name) - (ref ? volt(c.sim, p, ref) : 0); return v > th ? 1 : 0;
  }
  // PWM duty (0..1) on an input, or the plain logic level
  function duty(c, p, name, ref, th = 1.5) { const g = c.gpio(p, name); if (g && g.pin.out && g.pin.pwm !== undefined) return Math.max(0, Math.min(1, g.pin.pwm)); return level(c, p, name, ref, th); }
  function pwmFreq(c, p, name) { const g = c.gpio(p, name); return g && g.pin.out && g.pin.pwm !== undefined && g.pin.pwm > 0.02 && g.pin.pwm < 0.98 ? (g.pin.pwmFreq || 0) : 0; }
  // the part (of given types) whose pin `dpin` shares a net with our `mpin`
  function linked(sim, p, mpin, types) {
    const n = net(sim, p, mpin); if (n < 0) return null;
    for (const q of sim.project.parts) { if (q === p || !types.includes(q.type)) continue; for (const pin of P.T[q.type].pins(q)) if (net(sim, q, pin.name) === n) return { part: q, pin: pin.name }; }
    return null;
  }
  // is a flyback diode (any diode type, cathode on `pos`, anode on `neg`) across the two pins?
  const DIODES = ['diode', 'd1n4007', 'd1n5819', 'zener'];
  function hasFlyback(sim, p, pos, neg) {
    const a = net(sim, p, pos), b = net(sim, p, neg); if (a < 0 || b < 0) return false;
    return sim.project.parts.some((q) => DIODES.includes(q.type) && net(sim, q, 'K') === a && net(sim, q, 'A') === b);
  }
  // simple over-power / over-current burn-out bookkeeping (returns true on the step it burns)
  function burnCheck(st, over, dt, hold = 0.2) { st.overT = over ? (st.overT || 0) + dt : 0; if (st.overT > hold && !st.burned) { st.burned = true; return true; } return false; }
  root.HwKit = { DEFS, dots, silk, header, mhole, lead, wireLead, smoke, led, plbl, screws, to220, to92, lbls, net, volt, level, duty, pwmFreq, linked, hasFlyback, burnCheck, esc, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HwKit;
})(typeof window !== 'undefined' ? window : globalThis);
