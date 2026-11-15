/* Guest starter parts. The server injects <meta name="guestparts"> only when
 * the limit is on (sign-in on, and GUEST_PARTS_LIMIT not turned off). With
 * the tag absent this file, if it were loaded, would leave the lab open.
 * The page does not load this file when the limit is off. */
(function (root) {
  const SENTENCE = 'Sign in free to use this part';
  const DEFAULTS = ['esp32', 'breadboard', 'led', 'resistor', 'pushbutton', 'potentiometer', 'buzzer'];
  let signedIn = false;
  const exampleCache = new Map();

  function docOf(doc) {
    return doc || (typeof document !== 'undefined' ? document : null);
  }
  function metaContent(doc) {
    const d = docOf(doc);
    if (!d || typeof d.querySelector !== 'function') return '';
    const meta = d.querySelector('meta[name="guestparts"]');
    if (!meta || typeof meta.getAttribute !== 'function') return '';
    return String(meta.getAttribute('content') || '').trim();
  }
  function enabled(doc) {
    const raw = metaContent(doc).toLowerCase();
    if (!raw || raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
  }
  function allowList(doc) {
    const raw = metaContent(doc);
    const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return names.length ? names : DEFAULTS.slice();
  }
  function allowed(type, doc) {
    return allowList(doc).indexOf(type) >= 0;
  }
  function noteSession(session) {
    signedIn = !!(session && session.signed_in);
    if (root.app && typeof root.app.refreshGuestParts === 'function') root.app.refreshGuestParts();
  }
  function guest(doc) {
    return enabled(doc) && !signedIn;
  }
  function blocks(type, doc) {
    return guest(doc) && !allowed(type, doc);
  }
  function partTypes(proj) {
    const out = [];
    const seen = new Set();
    const parts = proj && proj.parts;
    if (!Array.isArray(parts)) return out;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] && parts[i].type;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(String(name));
    }
    return out;
  }
  function projectBlocked(proj, doc) {
    if (!guest(doc)) return false;
    const types = partTypes(proj);
    for (let i = 0; i < types.length; i++) if (!allowed(types[i], doc)) return true;
    return false;
  }
  function exampleParts(key) {
    if (exampleCache.has(key)) return exampleCache.get(key);
    let types = null;
    try {
      const factory = root.Examples && root.Examples.EX && root.Examples.EX[key];
      const made = typeof factory === 'function' ? factory() : null;
      types = partTypes(made);
    } catch (e) {
      types = null;
    }
    exampleCache.set(key, types);
    return types;
  }
  function exampleLocked(key, doc) {
    if (!guest(doc)) return false;
    const types = exampleParts(key);
    if (!types) return true;
    for (let i = 0; i < types.length; i++) if (!allowed(types[i], doc)) return true;
    return false;
  }
  function prompt() {
    const auth = root.clAuth;
    if (auth && typeof auth.openMenu === 'function' && auth.openMenu()) return;
    const header = typeof document !== 'undefined' && document.getElementById && document.getElementById('bSignIn');
    if (header && typeof header.click === 'function') { header.click(); return; }
    const phone = typeof document !== 'undefined' && document.querySelector && document.querySelector('#mAuth button');
    if (phone) {
      if (root.Mobile && typeof root.Mobile.setSheet === 'function') root.Mobile.setSheet('more');
      if (typeof phone.focus === 'function') phone.focus();
    }
  }
  function lockSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lock');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    body.setAttribute('x', '3'); body.setAttribute('y', '7');
    body.setAttribute('width', '10'); body.setAttribute('height', '7');
    body.setAttribute('rx', '1');
    const shackle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shackle.setAttribute('d', 'M5 7V5a3 3 0 0 1 6 0v2');
    shackle.setAttribute('fill', 'none');
    shackle.setAttribute('stroke', 'currentColor');
    shackle.setAttribute('stroke-width', '1.6');
    svg.append(body, shackle);
    return svg;
  }
  function markPart(el) {
    if (!el || el.getAttribute('data-guest-locked') === '1') return;
    el.setAttribute('data-guest-locked', '1');
    el.classList.add('pitem-locked');
    el.draggable = false;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-disabled', 'true');
    // The thumbnail is decorative. Hiding it keeps the accessible name equal
    // to the part name plus the sign-in sentence (axe: label-content-name-mismatch).
    // The thumbnail's own text stays in the accessible name. A separate
    // aria-label that left that text out failed label-content-name-mismatch.
    el.setAttribute('title', SENTENCE);
    const note = document.createElement('span');
    note.className = 'pitem-lock';
    note.appendChild(lockSvg());
    const text = document.createElement('span');
    text.textContent = SENTENCE;
    note.appendChild(text);
    el.appendChild(note);
  }
  function markPalette(scope) {
    const rootEl = scope || document;
    if (!rootEl || !rootEl.querySelectorAll || !guest()) return;
    rootEl.querySelectorAll('.pitem').forEach((el) => {
      if (blocks(el.dataset.type)) markPart(el);
    });
  }
  const api = {
    SENTENCE: SENTENCE,
    DEFAULTS: DEFAULTS,
    enabled: enabled,
    allowList: allowList,
    allowed: allowed,
    noteSession: noteSession,
    signedIn: function () { return signedIn; },
    guest: guest,
    blocks: blocks,
    partTypes: partTypes,
    projectBlocked: projectBlocked,
    exampleLocked: exampleLocked,
    prompt: prompt,
    markPalette: markPalette,
    markPart: markPart,
  };
  root.GuestParts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
