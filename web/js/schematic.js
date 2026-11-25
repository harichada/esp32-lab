/* Electronic schematic view (read-only).
 * Same project as the 2D breadboard and the 3D view — nothing here writes parts, wires, or props.
 * When the project carries a netlist, pin connectivity comes from those nets. Otherwise it is the
 * union-find of breadboard strips and wires (breadboard body omitted). Layout then places parts
 * from the MCU / IC / highest-degree part, or from the battery when the circuit is only
 * passives, aligns passives to the pin they talk to, and routes with an orthogonal A*.
 * A supply that feeds a chip or transistor stays a flag once it has 3+ pins. A battery
 * that only feeds discrete branches is drawn as wires, so parallel strings stay visible.
 * GND is a ground symbol, not a long wire.
 * SCHEMATIC_MATCH_LAYOUT (default on) offers a Like breadboard seat. The sheet itself
 * opens on the Tidy column layout unless this project has saved board.
 * A saved choice lives at esp32lab.schLayout.<id>. Each unsaved draft has its own
 * esp32lab.schLayout.draft.<draftId> until the first save moves it onto that id.
 * A tab records the drafts it owns in sessionStorage and refreshes lastSeen while
 * it is open. A sweep deletes only this tab's saved or discarded drafts, plus
 * orphans whose lastSeen is older than 24 hours. Another open tab's key stays.
 * The server env of the same name, delivered as <meta name="schmatch" content="0"> or data-schmatch="0",
 * hides that choice for every visitor; ?schmatch= applies only when the server allows it.
 * Off, or the Tidy choice, is this column layout exactly.
 * The breadboard body is never a symbol. Its strips are wires between the parts.
 * A ground part on a net that already has another pin is omitted; that pin draws the GND symbol.
 * Only a part whose every pin is open is parked, under a "Not connected" caption.
 * A* searches the whole board before a straight-line fallback, and a fallback is logged with the net.
 * Editing stays on the 2D canvas. Phones may open this view; 3D stays desktop-only.
 */
(function (root) {
  const P = root.Parts;
  const GS = 10, STUB = 30, KEEP = 30;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SRC = new Set(['battery', 'battery9v', 'aapack', 'coincell', 'cell18650', 'bench', 'vcc33', 'vcc5', 'buck', 'ldo']);
  const SKIP = new Set(['breadboard', 'label']);
  // These parts are why a supply rail is a flag. A circuit of only passives is drawn with wires.
  const ACTIVE = new Set(['ESP', 'DIP', 'BOX', 'NPN', 'PNP', 'NMOS']);
  const GROUND_PINS = { ground: [['GND', 4]], esp32: [['GND.1', 3], ['GND.2', 3]], vcc33: [['GND', 2]], vcc5: [['GND', 2]], battery: [['-', 1]] };

  class UF {
    constructor() { this.p = new Map(); }
    find(a) { let p = this.p.get(a); if (p === undefined) { this.p.set(a, a); return a; } if (p === a) return a; const r = this.find(p); this.p.set(a, r); return r; }
    union(a, b) { if (a == null || b == null) return; const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
  }
  const kxy = (x, y) => Math.round(x) + ',' + Math.round(y);

  function pinNetMap(proj) {
    const uf = new UF(), pinKey = new Map();
    for (const p of proj.parts || []) {
      const d = P.T[p.type]; if (!d || !d.pins) continue;
      let pins = []; try { pins = d.pins(p) || []; } catch (e) { continue; }
      for (const pin of pins) { const w = P.pinWorld(p, pin), k = kxy(w.x, w.y); pinKey.set(p.id + ':' + pin.name, k); uf.find(k); }
      const groups = [...(d.groups ? d.groups(p) : []), ...(p.type === 'esp32' ? [['GND.1', 'GND.2']] : [])];
      for (const g of groups) for (let i = 1; i < g.length; i++) uf.union(pinKey.get(p.id + ':' + g[0]), pinKey.get(p.id + ':' + g[i]));
    }
    const stored = proj.netlist && Array.isArray(proj.netlist.nets) && proj.netlist.nets.length;
    if (stored) {
      for (const net of proj.netlist.nets) {
        let anchor = null;
        for (const pk of net.pins || []) {
          const k = pinKey.get(pk);
          if (k == null) continue;
          if (anchor == null) anchor = k;
          else uf.union(anchor, k);
        }
      }
    } else {
      for (const w of proj.wires || []) uf.union(kxy(w.a.x, w.a.y), kxy(w.b.x, w.b.y));
    }
    const gk = [];
    for (const p of proj.parts || []) {
      if (p.type === 'ground') gk.push(pinKey.get(p.id + ':GND'));
      if (p.type === 'esp32') gk.push(pinKey.get(p.id + ':GND.1'));
    }
    for (let i = 1; i < gk.length; i++) uf.union(gk[0], gk[i]);
    let gbest = null, gprio = -1;
    for (const p of proj.parts || []) {
      const d = P.T[p.type];
      for (const [pn, pr] of (GROUND_PINS[p.type] || (d && d.groundPins) || [])) {
        const k = pinKey.get(p.id + ':' + pn); if (k && pr > gprio) { gprio = pr; gbest = uf.find(k); }
      }
    }
    const netId = new Map(); let n = 1;
    if (gbest) netId.set(gbest, 0);
    const pinNet = new Map();
    for (const [pk, k] of pinKey) { const r = uf.find(k); if (!netId.has(r)) netId.set(r, n++); pinNet.set(pk, netId.get(r)); }
    return pinNet;
  }

  function compact(v, unit) {
    const n = P.parseVal(v); if (!isFinite(n)) return '';
    return P.fmt(n, unit).replace(/\s+/g, '');
  }
  function valueOf(part) {
    const pr = part.props || {}, t = part.type, d = P.T[t];
    if (t === 'resistor' || t === 'ldr' || t === 'rnet' || t === 'potentiometer' || t === 'trimmer') return compact(pr.r, 'Ω');
    if (t === 'ntc') return compact(pr.r25 || 10000, 'Ω');
    if (t === 'capacitor' || t === 'ecap' || t === 'ccap') return compact(pr.c, 'F');
    if (t === 'inductor') return compact(pr.l, 'H');
    if (t === 'led' || t === 'irled') return pr.color || (t === 'irled' ? 'IR' : '');
    if (t === 'zener') return (pr.vz || '') + 'V';
    if (t === 'bench' && d && d.vset) return d.vset(part) + 'V';
    if (SRC.has(t) && pr.v) return String(pr.v).replace(/\.0$/, '') + 'V';
    if (t === 'vcc33') return '3.3V';
    if (t === 'vcc5') return '5V';
    if (t === 'crystal') return compact(pr.f, 'Hz');
    if (t === 'fuse') return (pr.rating || '') + 'A';
    if (t === 'lamp') return (pr.v || '') + 'V';
    if (t === 'multimeter' || t === 'voltmeter' || t === 'ammeter') return pr.mode || (t === 'ammeter' ? 'A' : 'V');
    return '';
  }
  function refOf(part, seq) {
    if (/^[A-Z]{1,6}\d+$/.test(part.id) && part.id.length <= 8) return part.id;
    const map = { resistor: 'R', capacitor: 'C', ecap: 'C', ccap: 'C', inductor: 'L', diode: 'D', zener: 'D', d1n4007: 'D', d1n5819: 'D', led: 'D', irled: 'D', npn: 'Q', pnp: 'Q', n2n3904: 'Q', p2n3906: 'Q', tip120: 'Q', nmos: 'Q', irlz44n: 'Q', phototransistor: 'Q', esp32: 'U', ne555: 'U', ground: 'GND', battery: 'BT', battery9v: 'BT', bench: 'PS', multimeter: 'M', pushbutton: 'SW', key: 'SW', toggle: 'SW', potentiometer: 'RV', ldr: 'LDR', keypad: 'KP', servo: 'M' };
    let pre = map[part.type];
    if (!pre && /^(ic|cd|lm|ne|74)/.test(part.type)) pre = 'U';
    pre = pre || 'U';
    seq[pre] = (seq[pre] || 0) + 1;
    return pre + seq[pre];
  }
  function kindOf(part, nTerms) {
    const t = part.type;
    const map = { resistor: 'R', ldr: 'LDR', ntc: 'NTC', capacitor: 'C', ecap: 'C', ccap: 'C', inductor: 'L', diode: 'D', zener: 'Z', d1n4007: 'D', d1n5819: 'D', photodiode: 'D', led: 'LED', irled: 'LED', npn: 'NPN', pnp: 'PNP', n2n3904: 'NPN', p2n3906: 'PNP', tip120: 'NPN', nmos: 'NMOS', irlz44n: 'NMOS', phototransistor: 'PT', pushbutton: 'SW', key: 'SW', tact12: 'SW', toggle: 'SW', latchbtn: 'SW', reed: 'SW', tilt: 'SW', slideswitch: 'SW3', potentiometer: 'POT', trimmer: 'POT', ground: 'GND', battery: 'BAT', battery9v: 'BAT', aapack: 'BAT', coincell: 'BAT', cell18650: 'BAT', bench: 'SRC', vcc33: 'SRC', vcc5: 'SRC', esp32: 'ESP', multimeter: 'MET', voltmeter: 'MET', ammeter: 'MET', fuse: 'F', lamp: 'LAMP', crystal: 'XTAL', buzzer: 'SPK', buzzerp: 'SPK', motor: 'MOT' };
    if (map[t]) return map[t];
    if (nTerms >= 6 && nTerms % 2 === 0 && /^(ne555|lm358|lm393|ic74|ic740|cd40|cd45|l293|uln|pc817)/.test(t)) return 'DIP';
    return 'BOX';
  }
  function titleOf(part) {
    if (part.type === 'esp32') return 'ESP32';
    if (part.type === 'ne555') return 'NE555';
    const d = P.T[part.type];
    const s = (d && d.label) || part.type;
    return String(s).replace(/\s*\(.*$/, '').slice(0, 22);
  }
  function ledColor(part) {
    if (part.type === 'irled') return '#b49cff';
    const c = P.LEDCOL && P.LEDCOL[part.props && part.props.color];
    return (c && c[0]) || '#ff2a2a';
  }

  function termsOf(part, pinNet) {
    const d = P.T[part.type]; if (!d || !d.pins) return [];
    let pins = []; try { pins = d.pins(part) || []; } catch (e) { return []; }
    const groups = d.groups ? d.groups(part) : [];
    const used = new Set(), terms = [];
    for (const g of groups) {
      if (!g || !g.length) continue;
      g.forEach((n) => used.add(n));
      const name = String(g[0]).replace(/\.[lr]$/i, '') || g[0];
      terms.push({ name, net: pinNet.get(part.id + ':' + g[0]), num: 0 });
    }
    pins.forEach((pin, i) => {
      if (used.has(pin.name)) return;
      terms.push({ name: pin.name, net: pinNet.get(part.id + ':' + pin.name), num: i + 1 });
    });
    return terms.filter((t) => t.net !== undefined);
  }
  function termPins(part, term) {
    const d = P.T[part.type];
    if (!d || !d.groups) return [term.name];
    let groups = [];
    try { groups = d.groups(part) || []; } catch (e) { groups = []; }
    for (const g of groups) {
      if (!g || !g.length) continue;
      const name = String(g[0]).replace(/\.[lr]$/i, '') || g[0];
      if (name === term.name) return g.slice();
    }
    return [term.name];
  }

  function netKind(net, terms, drawSupply) {
    if (net === 0) return { rail: 'gnd', name: 'GND', wire: false };
    if (terms.length < 2) return { rail: null, name: '', wire: false };
    const names = terms.map((t) => String(t.name).toUpperCase());
    const src = terms.find((t) => SRC.has(t.type) && /^(\+|VOUT)$/.test(t.name));
    let name = null;
    if (names.includes('3V3')) name = '3V3';
    else if (names.includes('5V')) name = '5V';
    else if (names.includes('VCC') || names.includes('VDD')) name = 'VCC';
    else if (names.includes('VIN') && terms.some((t) => t.type === 'esp32' || t.type === 'ldo' || t.type === 'buck')) name = 'VIN';
    else if (src) {
      if (src.type === 'vcc33') name = '3V3';
      else if (src.type === 'vcc5') name = '5V';
      else if (src.type === 'bench' && P.T.bench && P.T.bench.vset) name = P.T.bench.vset(src.part) + 'V';
      else if (src.part.props && src.part.props.v) name = String(src.part.props.v).replace(/\.0$/, '') + 'V';
      else name = '+V';
    } else if (names.includes('V+')) name = '+V';
    if (!name) return { rail: null, name: '', wire: true };
    // A chip supply with 3+ pins is a flag. A discrete battery feeding several
    // branches is drawn, otherwise those branches look like separate circuits.
    if (terms.length >= 3 && !drawSupply) return { rail: 'flag', name, wire: false };
    return { rail: null, name, wire: true };
  }

  // How many parts a net is from a source output. GND stays unranked.
  function netRank(netTerms) {
    const bySid = new Map();
    for (const terms of netTerms.values()) for (const t of terms) {
      if (!bySid.has(t.sid)) bySid.set(t.sid, []);
      bySid.get(t.sid).push(t);
    }
    const rank = new Map();
    const q = [];
    const push = (net, r) => {
      if (net === 0 || net === undefined) return;
      const cur = rank.get(net);
      if (cur !== undefined && cur <= r) return;
      rank.set(net, r);
      q.push(net);
    };
    for (const [net, terms] of netTerms) {
      if (terms.some((t) => SRC.has(t.type) && /^(\+|VOUT)$/.test(t.name))) push(net, 0);
    }
    let qi = 0;
    while (qi < q.length && qi < 8000) {
      const net = q[qi++];
      const r = rank.get(net);
      const seen = new Set();
      for (const t of netTerms.get(net) || []) {
        if (seen.has(t.sid)) continue;
        seen.add(t.sid);
        for (const o of bySid.get(t.sid) || []) push(o.net, r + 1);
      }
    }
    return rank;
  }

  function snap(v) { return Math.round(v / GS) * GS; }
  function snapCeil(v) { return Math.ceil((v - 1e-9) / GS) * GS; }

  // Default on. The server's 0 (meta or data-schmatch) wins over ?schmatch=.
  // ?schmatch=0 / ?schmatch=1 apply only when the server left the flag on.
  let serverOff = false;
  let matchFlag = true;
  function serverDeniesMatch(doc) {
    try {
      if (!doc) return false;
      const el = doc.documentElement;
      if (el && typeof el.getAttribute === 'function' && el.getAttribute('data-schmatch') === '0') return true;
      if (typeof doc.querySelector !== 'function') return false;
      const meta = doc.querySelector('meta[name="schmatch"]');
      if (!meta) return false;
      const content = typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : meta.content;
      return String(content) === '0';
    } catch (e) { return false; }
  }
  function urlMatch(search) {
    if (search == null || search === '') return null;
    let q = null;
    try { q = new URLSearchParams(String(search)).get('schmatch'); }
    catch (e) { return null; }
    if (q === '0') return false;
    if (q === '1') return true;
    return null;
  }
  function configureMatch(doc, search) {
    serverOff = serverDeniesMatch(doc);
    if (serverOff) { matchFlag = false; return false; }
    const q = urlMatch(search);
    matchFlag = q == null ? true : q;
    return matchFlag;
  }
  (function initMatchFlag() {
    try {
      const search = root.location && root.location.search;
      configureMatch(root.document, search || '');
    } catch (e) { serverOff = false; matchFlag = true; }
  })();
  function matchFlagOn() { return !serverOff && !!matchFlag; }

  const LAYOUT_STORE = 'esp32lab.schLayout';
  const DRAFT_INDEX = LAYOUT_STORE + '.draftIndex';
  const TAB_DRAFTS = LAYOUT_STORE + '.tabDrafts';
  // An orphan draft is one no open tab has refreshed within this long.
  const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
  const DRAFT_HEARTBEAT_MS = 60 * 1000;
  const MIN_LABEL_FONT = 9.5;
  const DRAFT_ID = /^[A-Za-z0-9_-]{1,40}$/;
  let draftSeq = 0;
  function newDraftId() {
    draftSeq += 1;
    return 'd' + Date.now().toString(36) + draftSeq.toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function ensureDraftId(proj) {
    if (!proj || proj.example) return '';
    if (proj.id != null && String(proj.id) !== '') return '';
    if (!DRAFT_ID.test(String(proj.draftId || ''))) proj.draftId = newDraftId();
    return String(proj.draftId);
  }
  function layoutStoreKey(proj) {
    if (proj && proj.example) return LAYOUT_STORE + '.ex.' + String(proj.example);
    if (proj && proj.id != null && String(proj.id) !== '') return LAYOUT_STORE + '.' + String(proj.id);
    const draft = ensureDraftId(proj);
    return LAYOUT_STORE + '.draft.' + (draft || 'none');
  }
  // A saved project keeps the choice in localStorage at esp32lab.schLayout.<id>
  // as the plain text "board" or "tidy". Each unsaved draft uses
  // esp32lab.schLayout.draft.<draftId>. The value is that same plain text, or
  // {"mode":"board"|"tidy","lastSeen":<ms>}. Plain text still selects the mode.
  // This tab lists the drafts it owns in sessionStorage esp32lab.schLayout.tabDrafts.
  // The first save copies the mode onto the project id and drops the draft key.
  // A read-only example keeps the choice in sessionStorage for this tab only.
  // Missing or unknown values are Tidy. Only mode "board" selects Like breadboard.
  function layoutStoreOf(proj, store) {
    if (store) return store;
    const box = root.clStorage;
    if (!box) return null;
    return proj && proj.example ? box.session : box.local;
  }
  function readIndex(store) {
    let list = [];
    try { list = JSON.parse(store.getItem(DRAFT_INDEX) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
    return list.filter((id) => DRAFT_ID.test(String(id || '')));
  }
  function reportStorageFull(err) {
    try { if (typeof root.onStorageFull === 'function') root.onStorageFull(err); }
    catch (e) { /* the notice must not hide the failed write */ }
  }
  function writeIndex(store, list) {
    try {
      if (!list.length) {
        const cur = store.getItem(DRAFT_INDEX);
        if (cur == null || cur === '[]') return;
      }
      store.setItem(DRAFT_INDEX, JSON.stringify(list));
    } catch (e) { reportStorageFull(e); }
  }
  function noteDraft(id, store) {
    if (!store || !DRAFT_ID.test(String(id || ''))) return;
    const list = readIndex(store);
    if (list.indexOf(id) < 0) list.push(id);
    writeIndex(store, list);
    claimDraft(id);
  }
  function decodeLayout(raw) {
    if (raw === 'board' || raw === 'tidy') return { mode: raw, lastSeen: 0 };
    if (!raw) return { mode: '', lastSeen: 0 };
    try {
      const o = JSON.parse(raw);
      if (o && (o.mode === 'board' || o.mode === 'tidy')) {
        const seen = Number(o.lastSeen);
        return { mode: o.mode, lastSeen: Number.isFinite(seen) && seen > 0 ? seen : 0 };
      }
    } catch (e) { /* not JSON */ }
    return { mode: '', lastSeen: 0 };
  }
  function tabSession(session) {
    if (session) return session;
    const box = root.clStorage;
    return box ? box.session : null;
  }
  function readOwn(session) {
    const s = tabSession(session);
    if (!s || !s.getItem) return [];
    let list = [];
    try { list = JSON.parse(s.getItem(TAB_DRAFTS) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
    return list.filter((id) => DRAFT_ID.test(String(id || '')));
  }
  function writeOwn(session, list) {
    const s = tabSession(session);
    if (!s || !s.setItem) return;
    try {
      if (!list.length) {
        const cur = s.getItem(TAB_DRAFTS);
        if (cur == null || cur === '[]') return;
      }
      s.setItem(TAB_DRAFTS, JSON.stringify(list));
    } catch (e) { reportStorageFull(e); }
  }
  function claimDraft(id, session) {
    if (!DRAFT_ID.test(String(id || ''))) return;
    const list = readOwn(session);
    if (!tabSession(session)) return;
    if (list.indexOf(id) < 0) list.push(id);
    writeOwn(session, list);
  }
  function forgetDraft(id, session) {
    if (!tabSession(session)) return;
    writeOwn(session, readOwn(session).filter((x) => x !== id));
  }
  function layoutModeOf(proj, store) {
    let v = '';
    try {
      const s = layoutStoreOf(proj, store);
      if (proj && !proj.example && !(proj.id != null && String(proj.id) !== '')) noteDraft(ensureDraftId(proj), s);
      if (s && s.getItem) v = s.getItem(layoutStoreKey(proj)) || '';
    } catch (e) { v = ''; }
    return decodeLayout(v).mode === 'board' ? 'board' : 'tidy';
  }
  function storedLayout(proj, store) {
    let v = '';
    try {
      const s = layoutStoreOf(proj, store);
      if (s && s.getItem) v = s.getItem(layoutStoreKey(proj)) || '';
    } catch (e) { v = ''; }
    const mode = decodeLayout(v).mode;
    if (mode === 'board' || mode === 'tidy') return mode;
    if (proj && (proj.schLayout === 'board' || proj.schLayout === 'tidy')) return proj.schLayout;
    return '';
  }
  function writeLayout(proj, mode, store) {
    if (!proj || (mode !== 'board' && mode !== 'tidy')) return;
    try {
      const s = layoutStoreOf(proj, store);
      if (!s || !s.setItem) return;
      const draft = !proj.example && !(proj.id != null && String(proj.id) !== '');
      if (draft) noteDraft(ensureDraftId(proj), s);
      const value = draft ? JSON.stringify({ mode: mode, lastSeen: Date.now() }) : mode;
      s.setItem(layoutStoreKey(proj), value);
    } catch (e) { reportStorageFull(e); }
  }
  // Refresh this tab's draft heartbeats. Skips a key touched less than a minute ago.
  function touchOwned(now, local, session) {
    const t = now || Date.now();
    const box = root.clStorage;
    const loc = local || (box && box.local);
    const ses = session || (box && box.session);
    if (!loc || !ses) return;
    for (const id of readOwn(ses)) {
      const key = LAYOUT_STORE + '.draft.' + id;
      let raw = '';
      try { raw = loc.getItem(key) || ''; } catch (e) { continue; }
      const rec = decodeLayout(raw);
      if (rec.mode !== 'board' && rec.mode !== 'tidy') continue;
      if (rec.lastSeen && t - rec.lastSeen < DRAFT_HEARTBEAT_MS) continue;
      try { loc.setItem(key, JSON.stringify({ mode: rec.mode, lastSeen: t })); } catch (e) { reportStorageFull(e); }
    }
  }
  // Copy an explicit board/tidy choice onto another project. A missing choice
  // stays missing, so the destination still opens on Tidy. Does not remove the source key.
  function carryLayout(from, to, opt) {
    const fromStore = opt && (opt.fromStore || opt.store);
    const toStore = opt && (opt.toStore || opt.store);
    const mode = storedLayout(from, fromStore);
    if (!mode) return '';
    writeLayout(to, mode, toStore);
    return mode;
  }
  function dropDraftKey(store, id) {
    if (!store || !DRAFT_ID.test(String(id || ''))) return false;
    try {
      if (store.removeItem) store.removeItem(LAYOUT_STORE + '.draft.' + id);
    } catch (e) { return false; }
    writeIndex(store, readIndex(store).filter((x) => x !== id));
    return true;
  }
  // First save: the draft key becomes the plain project value, then the draft key goes.
  function migrateDraftLayout(proj, store) {
    if (!proj || !proj.draftId || proj.id == null || String(proj.id) === '') return;
    const s = store || layoutStoreOf(proj);
    const id = String(proj.draftId);
    if (!s) { delete proj.draftId; forgetDraft(id); return; }
    let raw = '';
    try { raw = s.getItem(LAYOUT_STORE + '.draft.' + id) || ''; } catch (e) { raw = ''; }
    const mode = decodeLayout(raw).mode;
    if ((mode === 'board' || mode === 'tidy') && s.setItem) {
      try { s.setItem(LAYOUT_STORE + '.' + String(proj.id), mode); } catch (e) { reportStorageFull(e); return; }
    }
    if (!dropDraftKey(s, id)) return;
    delete proj.draftId;
    forgetDraft(id);
  }
  function releaseDraft(proj, store) {
    if (!proj || !proj.draftId) return;
    const s = store || layoutStoreOf(proj);
    const id = String(proj.draftId);
    if (s && !dropDraftKey(s, id)) return;
    delete proj.draftId;
    forgetDraft(id);
  }
  // This tab drops drafts it saved or discarded, and orphans quiet for DRAFT_TTL_MS.
  // A key this tab still owns, a key with a fresh lastSeen, and a plain board/tidy
  // value are kept, so another open tab's draft is never deleted. Project keys and
  // example keys are not in this loop. The retired esp32lab.schLayout.unsaved key is.
  function sweepDrafts(store, opt) {
    if (!store) return;
    if (Array.isArray(opt)) opt = { own: opt };
    const now = (opt && opt.now) || Date.now();
    const own = new Set(((opt && opt.own) || []).filter((id) => DRAFT_ID.test(String(id || ''))));
    const drop = new Set(((opt && opt.drop) || []).filter((id) => DRAFT_ID.test(String(id || ''))));
    const left = [];
    for (const id of readIndex(store)) {
      const key = LAYOUT_STORE + '.draft.' + id;
      let remove = false;
      if (drop.has(id)) remove = true;
      else if (!own.has(id)) {
        let raw = '';
        try { raw = store.getItem(key) || ''; } catch (e) { raw = ''; }
        const seen = decodeLayout(raw).lastSeen;
        if (seen > 0 && now - seen > DRAFT_TTL_MS) remove = true;
      }
      if (!remove) { left.push(id); continue; }
      try { if (store.removeItem) store.removeItem(key); }
      catch (e) { left.push(id); }
    }
    writeIndex(store, left);
    try { if (store.removeItem) store.removeItem(LAYOUT_STORE + '.unsaved'); } catch (e) { /* none */ }
    try {
      const ch = root.__schDraftCh;
      if (ch && ch.postMessage) ch.postMessage({ t: 'ping' });
    } catch (e) { /* no channel */ }
  }
  function pageIsBrowser() {
    try {
      const ua = root.navigator && root.navigator.userAgent;
      if (!ua || /Node\.js/i.test(String(ua))) return false;
      return !!(root.document && root.location && /^https?:/.test(String(root.location.protocol || '')));
    } catch (e) { return false; }
  }
  function startDraftCare() {
    if (!pageIsBrowser() || root.__schDraftCare) return;
    root.__schDraftCare = true;
    const kick = () => { try { touchOwned(); } catch (e) { /* storage off */ } };
    try { root.document.addEventListener('visibilitychange', kick); } catch (e) { /* none */ }
    try { root.addEventListener('pagehide', kick); } catch (e) { /* none */ }
    try {
      const timer = root.setInterval(kick, DRAFT_HEARTBEAT_MS);
      if (timer && timer.unref) timer.unref();
    } catch (e) { /* none */ }
    try {
      if (typeof root.BroadcastChannel === 'function') {
        const ch = new root.BroadcastChannel('esp32lab.schLayout');
        ch.onmessage = () => kick();
        root.__schDraftCh = ch;
      }
    } catch (e) { /* no channel */ }
    try {
      const own = readOwn();
      touchOwned();
      if (root.clStorage && root.clStorage.local) sweepDrafts(root.clStorage.local, { own: own });
    } catch (e) { /* storage off */ }
  }
  try { if (pageIsBrowser()) startDraftCare(); } catch (e) { /* node, or storage off */ }
  function editorDragging() {
    try {
      const ed = root.app && root.app.editor;
      return !!(ed && ed.mode && ed.mode.k === 'drag');
    } catch (e) { return false; }
  }

  // Where the part sits in 2D. Missing or non-finite coordinates are not a place.
  function partAnchor(part) {
    if (!part || SKIP.has(part.type)) return null;
    const x = +part.x, y = +part.y;
    if (!isFinite(x) || !isFinite(y)) return null;
    const d = P.T[part.type];
    if (!d || !d.pins) return { x: x, y: y };
    let pins = [];
    try { pins = d.pins(part) || []; } catch (e) { pins = []; }
    if (!pins.length) return { x: x, y: y };
    let sx = 0, sy = 0, n = 0;
    for (const pin of pins) {
      let w = null;
      try { w = P.pinWorld(part, pin); } catch (e) { w = null; }
      if (!w || !isFinite(w.x) || !isFinite(w.y)) continue;
      sx += w.x; sy += w.y; n++;
    }
    if (!n) return { x: x, y: y };
    return { x: sx / n, y: sy / n };
  }

  // Two-lead parts follow the way the part is turned on the board. Other symbols keep
  // the tidy pin sides; only their seat moves.
  const LEAD_KIND = new Set(['R', 'LDR', 'NTC', 'C', 'L', 'D', 'Z', 'LED', 'SW', 'F', 'LAMP', 'XTAL', 'SPK', 'MOT', 'MET', 'PT']);
  function orientLeads(s) {
    if (!s || !s.part || !LEAD_KIND.has(s.kind) || !s.terms || s.terms.length !== 2) return;
    const d = P.T[s.part.type];
    if (!d || !d.pins) return;
    if (!isFinite(+s.part.x) || !isFinite(+s.part.y)) return;
    let pins = [];
    try { pins = d.pins(s.part) || []; } catch (e) { return; }
    if (pins.length < 2) return;
    let a, b;
    try { a = P.pinWorld(s.part, pins[0]); b = P.pinWorld(s.part, pins[1]); } catch (e) { return; }
    if (!a || !b || !isFinite(a.x) || !isFinite(b.x) || !isFinite(a.y) || !isFinite(b.y)) return;
    const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
    const byName = new Map(pins.map((p) => [p.name, p]));
    const worldOf = (t, idx) => {
      const pin = byName.get(t.name) || pins[idx] || pins[0];
      try { return P.pinWorld(s.part, pin); } catch (e) { return idx ? b : a; }
    };
    if (vertical) {
      s.w = 40; s.h = 70;
      const ts = s.terms.slice().sort((u, v) => worldOf(u, s.terms.indexOf(u)).y - worldOf(v, s.terms.indexOf(v)).y || String(u.name).localeCompare(String(v.name)));
      ts[0].dir = 't'; ts[0].lx = 20; ts[0].ly = 0;
      ts[1].dir = 'b'; ts[1].lx = 20; ts[1].ly = s.h;
    } else {
      s.w = 80; s.h = 20;
      const ts = s.terms.slice().sort((u, v) => worldOf(u, s.terms.indexOf(u)).x - worldOf(v, s.terms.indexOf(v)).x || String(u.name).localeCompare(String(v.name)));
      ts[0].dir = 'l'; ts[0].lx = 0; ts[0].ly = 10;
      ts[1].dir = 'r'; ts[1].lx = s.w; ts[1].ly = 10;
    }
    s.pad = pads(s);
  }

  function chooseScale(pts) {
    const dists = [];
    let maxX = 0, maxY = 0;
    for (let i = 0; i < pts.length; i++) {
      maxX = Math.max(maxX, pts[i].x);
      maxY = Math.max(maxY, pts[i].y);
      let best = Infinity;
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (d > 1) best = Math.min(best, d);
      }
      if (best < Infinity) dists.push(best);
    }
    if (!dists.length) return 4;
    dists.sort((a, b) => a - b);
    const pitch = dists[Math.floor((dists.length - 1) / 2)];
    let scale = 48 / pitch;
    if (!(scale > 0) || !isFinite(scale)) scale = 2;
    const span = Math.max(maxX, maxY, 1);
    const cap = 720 / span;
    if (scale > cap) scale = cap;
    if (scale < 0.35) scale = 0.35;
    if (scale > 3) scale = 3;
    return scale;
  }

  function boxesOverlap(a, b) {
    return Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 0.5;
  }
  function anySymbolHit(syms) {
    const boxes = syms.map(symbolBox);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) return true;
    }
    return false;
  }
  // Pull seats toward their centre until the padded boxes would touch.
  // Order on the board stays; the empty space between parts does not.
  function tightenSymbols(symbols) {
    const syms = (symbols || []).filter((s) => s && s.w > 0 && s.h > 0 && isFinite(s.x) && isFinite(s.y));
    if (syms.length < 2 || anySymbolHit(syms)) return;
    let cx = 0, cy = 0;
    for (const s of syms) { cx += s.x + s.w / 2; cy += s.y + s.h / 2; }
    cx /= syms.length; cy /= syms.length;
    const base = syms.map((s) => ({ s: s, x: s.x, y: s.y }));
    const apply = (scale) => {
      for (const b of base) {
        const px = b.x + b.s.w / 2, py = b.y + b.s.h / 2;
        b.s.x = snap(cx + (px - cx) * scale - b.s.w / 2);
        b.s.y = snap(cy + (py - cy) * scale - b.s.h / 2);
      }
    };
    let best = 1;
    for (let step = 1; step <= 40; step++) {
      const scale = 1 - step * 0.02;
      apply(scale);
      if (anySymbolHit(syms)) { apply(best); return; }
      best = scale;
    }
  }

  function symbolBox(s) {
    const p = s.pad || { T: 18, B: 16, L: 10, R: 10 };
    const top = Math.max(p.T || 0, 18);
    const bot = Math.max(p.B || 0, 16);
    // Side room is a wire lane, so a lead can leave the pin without entering the neighbour.
    const left = Math.max(p.L || 0, 22);
    const right = Math.max(p.R || 0, 22);
    return {
      id: s.id,
      x: s.x - left,
      y: s.y - top,
      x2: s.x + (s.w || 0) + right,
      y2: s.y + (s.h || 0) + bot,
      s: s,
    };
  }

  // Push symbol boxes apart. Later boxes only move right or down, on the grid,
  // so the same boxes always land in the same places.
  function separateSymbols(symbols) {
    const syms = (symbols || []).filter((s) => s && isFinite(s.x) && isFinite(s.y) && s.w > 0 && s.h > 0);
    const limit = syms.length * syms.length + 8;
    let guard = 0;
    while (guard++ < limit) {
      const boxes = syms.map(symbolBox).sort((a, b) => a.y - b.y || a.x - b.x || String(a.id).localeCompare(String(b.id)));
      let moved = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const ix = Math.min(a.x2, b.x2) - Math.max(a.x, b.x);
          const iy = Math.min(a.y2, b.y2) - Math.max(a.y, b.y);
          if (ix <= 0.5 || iy <= 0.5) continue;
          if (ix <= iy) b.s.x += snapCeil(ix);
          else b.s.y += snapCeil(iy);
          b.s.x = snap(b.s.x);
          b.s.y = snap(b.s.y);
          const nb = symbolBox(b.s);
          b.x = nb.x; b.y = nb.y; b.x2 = nb.x2; b.y2 = nb.y2;
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const s of syms) { s.x = snap(s.x); s.y = snap(s.y); }
    return symbols;
  }

  // Seat symbols on the 2D anchors. Parts with no place keep the tidy seat and
  // are parked beside the mapped group. Huge coordinates are scaled into range.
  function reseatToBreadboard(symbols) {
    const anchored = [];
    const loose = [];
    for (const s of symbols) {
      const a = partAnchor(s.part);
      if (!a) loose.push(s);
      else anchored.push({ s: s, a: a });
    }
    if (!anchored.length) return;
    for (const it of anchored) orientLeads(it.s);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of anchored) {
      minX = Math.min(minX, it.a.x); minY = Math.min(minY, it.a.y);
      maxX = Math.max(maxX, it.a.x); maxY = Math.max(maxY, it.a.y);
    }
    const MAX_SPAN = 2400;
    let spanX = maxX - minX, spanY = maxY - minY;
    if (!isFinite(spanX) || spanX < 0) spanX = 0;
    if (!isFinite(spanY) || spanY < 0) spanY = 0;
    let k = 1;
    if (spanX > MAX_SPAN) k = Math.min(k, MAX_SPAN / spanX);
    if (spanY > MAX_SPAN) k = Math.min(k, MAX_SPAN / spanY);
    if (!isFinite(k) || k <= 0) k = 1;
    const pts = anchored.map((it) => ({ x: (it.a.x - minX) * k, y: (it.a.y - minY) * k }));
    const scale = chooseScale(pts);
    for (let i = 0; i < anchored.length; i++) {
      const s = anchored[i].s;
      s.x = snap(pts[i].x * scale - s.w / 2);
      s.y = snap(pts[i].y * scale - s.h / 2);
      if (!isFinite(s.x) || !isFinite(s.y)) { s.x = 0; s.y = 0; }
      s.pad = pads(s);
      s._matched = true;
    }
    if (loose.length) {
      let right = 0, top = Infinity;
      for (const s of symbols) if (s._matched) {
        const p = s.pad || pads(s);
        right = Math.max(right, s.x + s.w + (p.R || 0));
        top = Math.min(top, s.y - (p.T || 0));
      }
      loose.sort((a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id)));
      let x = snap(right + 80), y = snap(isFinite(top) ? top : 0), rowH = 0;
      const wrap = x + 980;
      for (const s of loose) {
        s.pad = s.pad || pads(s);
        const slot = s.pad.L + s.w + s.pad.R;
        if (x > right + 80 && x + slot > wrap) { x = snap(right + 80); y = snap(y + rowH + 28); rowH = 0; }
        s.x = snap(x + s.pad.L);
        s.y = snap(y + s.pad.T);
        x += slot + 40;
        rowH = Math.max(rowH, s.pad.T + s.h + s.pad.B);
      }
    }
    separateSymbols(symbols);
    tightenSymbols(symbols);
    for (const s of symbols) delete s._matched;
  }

  function orthoHit(a, b) {
    if (!!a.h === !!b.h) return null;
    const h = a.h ? a : b, v = a.h ? b : a;
    const hx0 = Math.min(h.x1, h.x2), hx1 = Math.max(h.x1, h.x2);
    const vy0 = Math.min(v.y1, v.y2), vy1 = Math.max(v.y1, v.y2);
    const x = v.x1, y = h.y1;
    if (x < hx0 || x > hx1 || y < vy0 || y > vy1) return null;
    const hEnd = x === hx0 || x === hx1;
    const vEnd = y === vy0 || y === vy1;
    return { x: x, y: y, hEnd: hEnd, vEnd: vEnd };
  }

  // A dot is a shared node of one net (three or more wire ends). A crossing of
  // two nets is not a dot, even when the lines occupy the same point.
  function wireJoints(segs) {
    const dots = [];
    const crosses = [];
    const list = [];
    for (const s of segs || []) {
      if (!s) continue;
      const x1 = +s.x1, y1 = +s.y1, x2 = +s.x2, y2 = +s.y2;
      if (![x1, y1, x2, y2].every(isFinite)) continue;
      if (x1 === x2 && y1 === y2) continue;
      if (x1 !== x2 && y1 !== y2) continue;
      list.push({ net: s.net, x1: x1, y1: y1, x2: x2, y2: y2, h: y1 === y2 });
    }
    const splits = list.map((s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]);
    const samePt = (p, q) => p.x === q.x && p.y === q.y;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const hit = orthoHit(list[i], list[j]);
        if (!hit) continue;
        if (list[i].net === list[j].net) {
          if (!splits[i].some((p) => samePt(p, hit))) splits[i].push({ x: hit.x, y: hit.y });
          if (!splits[j].some((p) => samePt(p, hit))) splits[j].push({ x: hit.x, y: hit.y });
        } else if ((!hit.hEnd && !hit.vEnd) || hit.hEnd !== hit.vEnd) {
          crosses.push({ x: hit.x, y: hit.y, a: list[i].net, b: list[j].net });
        }
      }
    }
    const deg = new Map();
    const bump = (net, x, y) => {
      const k = String(net) + '|' + x + '|' + y;
      deg.set(k, (deg.get(k) || 0) + 1);
    };
    for (let i = 0; i < list.length; i++) {
      const pts = splits[i].slice().sort((p, q) => p.x - q.x || p.y - q.y);
      const u = [];
      for (const p of pts) if (!u.length || !samePt(u[u.length - 1], p)) u.push(p);
      for (let n = 1; n < u.length; n++) {
        bump(list[i].net, u[n - 1].x, u[n - 1].y);
        bump(list[i].net, u[n].x, u[n].y);
      }
    }
    const seen = new Set();
    for (const [k, n] of deg) {
      if (n < 3) continue;
      const cut = k.indexOf('|');
      const rest = k.slice(cut + 1);
      const mid = rest.indexOf('|');
      const x = +rest.slice(0, mid), y = +rest.slice(mid + 1);
      const id = x + ',' + y + ':' + k.slice(0, cut);
      if (seen.has(id)) continue;
      seen.add(id);
      const net = list.find((s) => String(s.net) === k.slice(0, cut)).net;
      dots.push({ x: x, y: y, net: net });
    }
    dots.sort((a, b) => a.y - b.y || a.x - b.x || String(a.net).localeCompare(String(b.net)));
    return { dots: dots, crosses: crosses };
  }

  const READABLE_PX = 11;
  // Part names and values. ESP32 pin names are 9.5 and are not this floor:
  // using them opened Blink at 116% and pushed the LED off the phone.
  const PART_KIND = { ref: 1, val: 1, title: 1 };
  function partLabelFont(model) {
    let min = Infinity;
    for (const t of (model && model.texts) || []) {
      if (!PART_KIND[t.kind]) continue;
      min = Math.min(min, t.size || 11);
    }
    return isFinite(min) ? min : 11;
  }
  function espSymbol(model) {
    const syms = (model && model.symbols) || [];
    return syms.find((s) => s.kind === 'ESP') || syms.find((s) => s.part && s.part.type === 'esp32') || null;
  }
  // Parts joined to the ESP32 by schematic wires, including a series LED
  // on the far side of its resistor. Supply flags are not wires, so a shared
  // GND rail does not pull the rest of the board into the frame.
  function wiredIds(model) {
    const syms = (model && model.symbols) || [];
    const esp = espSymbol(model);
    if (!esp) return new Set(syms.map((s) => s.id));
    const adj = new Map(syms.map((s) => [s.id, new Set()]));
    const nets = new Map();
    for (const s of syms) for (const t of s.terms || []) {
      if (!t.wire || t.nc || t.net == null) continue;
      if (!nets.has(t.net)) nets.set(t.net, []);
      nets.get(t.net).push(s.id);
    }
    for (const list of nets.values()) {
      const ids = [...new Set(list)];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        adj.get(ids[i]).add(ids[j]);
        adj.get(ids[j]).add(ids[i]);
      }
    }
    const seen = new Set([esp.id]);
    const q = [esp.id];
    while (q.length) {
      const id = q.pop();
      for (const next of adj.get(id) || []) if (!seen.has(next)) { seen.add(next); q.push(next); }
    }
    return seen;
  }
  function directIds(model) {
    const esp = espSymbol(model);
    const ids = new Set(esp ? [esp.id] : []);
    if (!esp) return ids;
    const nets = new Set();
    for (const t of esp.terms || []) if (t.wire && !t.nc && t.net != null) nets.add(t.net);
    for (const s of (model && model.symbols) || []) {
      if ((s.terms || []).some((t) => t.wire && !t.nc && nets.has(t.net))) ids.add(s.id);
    }
    return ids;
  }
  function clusterBox(model, ids) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const add = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const s of (model && model.symbols) || []) {
      if (ids && !ids.has(s.id)) continue;
      add(s.x, s.y); add(s.x + s.w, s.y + s.h);
    }
    for (const t of (model && model.texts) || []) {
      if (!PART_KIND[t.kind]) continue;
      if (ids && t.own && !ids.has(t.own)) continue;
      if (ids && !t.own) continue;
      add(t.x, t.y); add(t.x2, t.y2);
    }
    if (x0 > x1) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function openFrame(model) {
    const ids = wiredIds(model);
    const esp = espSymbol(model);
    return {
      ids: [...ids],
      count: ids.size,
      box: clusterBox(model, ids),
      esp: esp ? { x: esp.x, y: esp.y, w: esp.w, h: esp.h } : null,
      font: partLabelFont(model),
    };
  }
  // On-screen pixels: drawing-unit font × zoom × any CSS scale on the svg.
  function labelScreenPx(fontPx, zoom, cssScale) {
    const font = fontPx > 0 && isFinite(fontPx) ? fontPx : 11;
    const z = zoom > 0 && isFinite(zoom) ? zoom : 0;
    const css = cssScale > 0 && isFinite(cssScale) ? cssScale : 1;
    return font * z * css;
  }
  // Readability math for one font. fitAll means the caller zoomed past a full fit.
  function openScale(minFont, fittedS, cssScale) {
    const css = cssScale > 0 && isFinite(cssScale) ? cssScale : 1;
    const font = minFont > 0 && isFinite(minFont) ? minFont : 11;
    const fitted = fittedS > 0 && isFinite(fittedS) ? fittedS : 0.12;
    const fittedPx = labelScreenPx(font, fitted, css);
    if (fittedPx >= READABLE_PX) return { s: fitted, px: fittedPx, fitAll: false };
    const s = READABLE_PX / (font * css);
    return { s: s, px: labelScreenPx(font, s, css), fitAll: true };
  }
  function clearAvail(clear, pad) {
    const w = clear && (clear.width != null ? clear.width : clear.right - clear.left);
    const h = clear && (clear.height != null ? clear.height : clear.bottom - clear.top);
    return { w: Math.max(1, (w || 1) - 2 * pad), h: Math.max(1, (h || 1) - 2 * pad) };
  }
  function boxFits(box, s, clear, pad) {
    if (!box || !(s > 0) || !clear) return false;
    const a = clearAvail(clear, pad);
    return box.w * s <= a.w + 0.5 && box.h * s <= a.h + 0.5;
  }
  // Framing fit wins while it keeps every wired part on screen.
  // Zoom past it only when part names would be a few pixels (the remote):
  // Blink is about 6px and Simon about 3.5px at the framing fit, and raising
  // those to 11px pushes the LED off the phone. A Simon-sized board stays
  // framed even if the clear rect shifts by a few pixels.
  function chooseOpen(font, fittedS, css, info) {
    const cssS = css > 0 && isFinite(css) ? css : 1;
    const f = font > 0 && isFinite(font) ? font : 11;
    const fitted = fittedS > 0 && isFinite(fittedS) ? fittedS : 0.12;
    const px = labelScreenPx(f, fitted, cssS);
    const pad = info && info.pad != null ? info.pad : 14;
    const clear = info && info.clear;
    if (px >= READABLE_PX - 1e-6) return { s: fitted, px: px, zoomed: false };
    const sRead = READABLE_PX / (f * cssS);
    if (boxFits(info && info.group, sRead, clear, pad)) return { s: sRead, px: labelScreenPx(f, sRead, cssS), zoomed: true };
    const crowded = px < 3.2 && info && info.count >= 24 && info.esp;
    if (!crowded) return { s: fitted, px: px, zoomed: false };
    if (boxFits(info.esp, sRead, clear, pad)) return { s: sRead, px: labelScreenPx(f, sRead, cssS), zoomed: true };
    let lo = fitted, hi = sRead, best = fitted;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (boxFits(info.esp, mid, clear, pad)) { best = mid; lo = mid; }
      else hi = mid;
    }
    if (best > fitted + 1e-3) return { s: best, px: labelScreenPx(f, best, cssS), zoomed: true };
    return { s: fitted, px: px, zoomed: false };
  }
  function focusBox(model, s, clear, pad) {
    const esp = espSymbol(model);
    if (!esp) return clusterBox(model, wiredIds(model));
    const fits = (b) => boxFits(b, s, clear, pad);
    let box = { x: esp.x, y: esp.y, w: esp.w, h: esp.h };
    if (!fits(box)) return box;
    const ids = directIds(model);
    const cx = esp.x + esp.w / 2, cy = esp.y + esp.h / 2;
    const near = ((model && model.symbols) || []).filter((sym) => ids.has(sym.id) && sym.id !== esp.id);
    near.sort((a, b) => {
      const da = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);
      const db = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
      return da - db || String(a.id).localeCompare(String(b.id));
    });
    for (const sym of near) {
      const x = Math.min(box.x, sym.x), y = Math.min(box.y, sym.y);
      const next = { x: x, y: y, w: Math.max(box.x + box.w, sym.x + sym.w) - x, h: Math.max(box.y + box.h, sym.y + sym.h) - y };
      if (fits(next)) box = next;
    }
    return box;
  }
  function viewAt(box, s, stage, clear) {
    const sx = ((+clear.left + +clear.right) / 2) - (+stage.left || 0);
    const sy = ((+clear.top + +clear.bottom) / 2) - (+stage.top || 0);
    return { s: s, x: box.x + box.w / 2 - sx / s, y: box.y + box.h / 2 - sy / s };
  }
  function worldRect(view, stage, clear, pad) {
    const s = view.s || 1;
    const p = pad || 0;
    return {
      x: view.x + (clear.left + p - (stage.left || 0)) / s,
      y: view.y + (clear.top + p - (stage.top || 0)) / s,
      x2: view.x + (clear.right - p - (stage.left || 0)) / s,
      y2: view.y + (clear.bottom - p - (stage.top || 0)) / s,
    };
  }
  function espHeld(view, esp, stage, clear, pad) {
    if (!view || !esp || !clear) return false;
    const r = worldRect(view, stage, clear, pad);
    return esp.x >= r.x - 2 && esp.y >= r.y - 2 && esp.x + esp.w <= r.x2 + 2 && esp.y + esp.h <= r.y2 + 2;
  }
  function symbolsHeld(view, model, stage, clear, pad) {
    const syms = (model && model.symbols) || [];
    for (let i = 0; i < syms.length; i++) if (!espHeld(view, syms[i], stage, clear, pad)) return false;
    return true;
  }
  function sheetInside(bounds, view, stage, clear, pad) {
    if (!bounds || !view || !clear) return false;
    const r = worldRect(view, stage, clear, pad);
    return r.x <= bounds.x + 8 && r.y <= bounds.y + 8 && r.x2 >= bounds.x + bounds.w - 8 && r.y2 >= bounds.y + bounds.h - 8;
  }
  function cssScaleOf(el) {
    let s = 1;
    try {
      if (el && el.currentScale && isFinite(+el.currentScale) && +el.currentScale > 0) s = +el.currentScale;
      const cs = root.getComputedStyle && el && root.getComputedStyle(el);
      const tr = cs && cs.transform;
      if (tr && tr !== 'none') {
        const m = String(tr).match(/matrix\(([^)]+)\)/);
        if (m) {
          const p = m[1].split(',').map((n) => +n);
          const sx = Math.hypot(p[0] || 0, p[1] || 0);
          if (sx > 0 && isFinite(sx)) s *= sx;
        }
      }
    } catch (e) { /* keep 1 */ }
    return s > 0 && isFinite(s) ? s : 1;
  }
  function placeReadable(model, frame, fitted, css) {
    const open = openScale(partLabelFont(model), fitted.s, css);
    if (!open.fitAll) return { view: { s: fitted.s, x: fitted.x, y: fitted.y }, open: open };
    const syms = (model && model.symbols) || [];
    const sym = syms.find((s) => s.kind === 'ESP') || syms.find((s) => s.part && s.part.type === 'esp32');
    const b = (model && model.bounds) || { x: 0, y: 0, w: 1, h: 1 };
    const cx = sym ? sym.x + sym.w / 2 : b.x + b.w / 2;
    const cy = sym ? sym.y + sym.h / 2 : b.y + b.h / 2;
    const stage = frame.stage || { left: 0, top: 0 };
    const clear = frame.clear || stage;
    const sx = ((+clear.left + +clear.right) / 2) - (+stage.left || 0);
    const sy = ((+clear.top + +clear.bottom) / 2) - (+stage.top || 0);
    const s = open.s;
    return { view: { s: s, x: cx - sx / s, y: cy - sy / s }, open: open };
  }
  // The readable zoom is larger than a fit, so a symbol can sit on the
  // arrangement control. Nudge the sheet, keeping the ESP32 on screen.
  function liftOff(view, model, svg) {
    if (!view || !svg || typeof document === 'undefined' || !document.getElementById) return view;
    const bar = document.getElementById('schLayout');
    if (!bar) return view;
    const br = bar.getBoundingClientRect();
    if (br.width < 1 || br.height < 1) return view;
    const host = svg.getBoundingClientRect();
    const block = { x: br.left, y: br.top, x2: br.right, y2: br.bottom };
    const syms = (model && model.symbols) || [];
    const s = view.s;
    const hits = (x, y) => {
      for (const sym of syms) {
        const x1 = host.left + (sym.x - x) * s;
        const y1 = host.top + (sym.y - y) * s;
        const ix = Math.min(x1 + sym.w * s, block.x2) - Math.max(x1, block.x);
        const iy = Math.min(y1 + sym.h * s, block.y2) - Math.max(y1, block.y);
        if (ix > 1 && iy > 1) return true;
      }
      return false;
    };
    if (!hits(view.x, view.y)) return view;
    const esp = syms.find((sym) => sym.kind === 'ESP') || syms.find((sym) => sym.part && sym.part.type === 'esp32');
    let best = null;
    const span = 220;
    const step = 8;
    for (let py = -span; py <= span; py += step) {
      for (let px = -span; px <= span; px += step) {
        const x = view.x - px / s;
        const y = view.y - py / s;
        if (esp) {
          const cx = host.left + (esp.x + esp.w / 2 - x) * s;
          const cy = host.top + (esp.y + esp.h / 2 - y) * s;
          if (cx < 24 || cy < 24 || cx > host.right - 24 || cy > block.y - 24) continue;
        }
        if (hits(x, y)) continue;
        const dist = px * px + py * py;
        if (!best || dist < best.dist) best = { x: x, y: y, dist: dist };
      }
    }
    return best ? { s: s, x: best.x, y: best.y } : view;
  }
  function coversToggle(view, model) {
    if (!view || typeof document === 'undefined' || !document.getElementById) return false;
    const bar = document.getElementById('schLayout');
    const svg = document.getElementById('stageSch');
    if (!bar || !svg) return false;
    const br = bar.getBoundingClientRect();
    if (br.width < 1 || br.height < 1) return false;
    const host = svg.getBoundingClientRect();
    const s = view.s;
    for (const sym of (model && model.symbols) || []) {
      const x1 = host.left + (sym.x - view.x) * s;
      const y1 = host.top + (sym.y - view.y) * s;
      const ix = Math.min(x1 + sym.w * s, br.right) - Math.max(x1, br.left);
      const iy = Math.min(y1 + sym.h * s, br.bottom) - Math.max(y1, br.top);
      if (ix > 1 && iy > 1) return true;
    }
    return false;
  }
  // Screen size of the smallest part name or value after a fit into this viewport.
  function screenLabelPx(model, width, height, chrome) {
    const b = (model && model.bounds) || { w: 1, h: 1 };
    const pad = 14;
    const block = chrome || 0;
    const availW = Math.max(1, width - pad * 2);
    const availH = Math.max(1, height - pad * 2 - block);
    const raw = Math.min(availW / Math.max(b.w || 1, 1), availH / Math.max(b.h || 1, 1));
    const s = Math.max(0.12, Math.min(2.4, raw));
    const font = partLabelFont(model);
    const min = labelScreenPx(font, s, 1);
    return { s: s, minPx: min, minFont: font, raw: raw };
  }
  function textWidth(text, px) { return Math.max(4, Math.ceil(String(text || '').length * px * 0.62)); }
  function pinText(t, kind) { return (kind === 'DIP' && t.num ? t.num + ' ' : '') + (t.name || ''); }
  function placeEdge(list, dir, s) {
    if (!list.length) return;
    const gaps = list.map((t) => Math.max(40, snap(textWidth(pinText(t, s.kind), 9.5) + 22)));
    const sum = gaps.reduce((a, b) => a + b, 0);
    let x = Math.max(0, (s.w - sum) / 2);
    list.forEach((t, i) => {
      t.dir = dir;
      t.lx = snap(x + gaps[i] / 2);
      t.ly = dir === 't' ? 0 : s.h;
      x += gaps[i];
    });
    for (let i = 1; i < list.length; i++) {
      const need = snap((gaps[i - 1] + gaps[i]) / 2);
      if (list[i].lx < list[i - 1].lx + need) list[i].lx = list[i - 1].lx + need;
    }
    const last = list[list.length - 1];
    if (last.lx > s.w - GS) s.w = snap(last.lx + GS);
    for (const t of list) t.lx = Math.max(GS, Math.min(s.w - GS, t.lx));
  }

  function layout(proj, opt) {
    const wantMatch = !!(opt && opt.match) && matchFlagOn();
    const pinNet = pinNetMap(proj);
    const seq = {};
    const symbols = [];
    for (const part of proj.parts || []) {
      if (SKIP.has(part.type) || !P.T[part.type]) continue;
      const terms = termsOf(part, pinNet);
      if (!terms.length && part.type !== 'label') continue;
      if (!terms.length) continue;
      symbols.push({
        id: part.id, part, ref: refOf(part, seq), value: valueOf(part), title: titleOf(part),
        kind: kindOf(part, terms.length), terms, layer: 0, comp: 0,
        elec: part.type === 'ecap' || (part.props && part.props.kind === 'electrolytic'),
        led: (part.type === 'led' || part.type === 'irled') ? ledColor(part) : null,
      });
    }
    const byId = new Map(symbols.map((s) => [s.id, s]));
    const netTerms = new Map();
    for (const s of symbols) for (const t of s.terms) {
      t.part = s.part; t.type = s.part.type; t.sid = s.id;
      if (!netTerms.has(t.net)) netTerms.set(t.net, []);
      netTerms.get(t.net).push(t);
    }
    const meta = new Map();
    const drawSupply = !symbols.some((s) => ACTIVE.has(s.kind));
    for (const [net, terms] of netTerms) meta.set(net, netKind(net, terms, drawSupply));
    // Two different nets must not share a supply name. A repeated "VCC" or "3V3"
    // would read as one rail. The first net keeps the name; the others are drawn
    // as wires with no supply label.
    {
      const taken = new Set();
      for (const m of meta.values()) {
        if (!m.name || m.rail === 'gnd') continue;
        if (taken.has(m.name)) {
          m.name = '';
          if (m.rail === 'flag') { m.rail = null; m.wire = true; }
        } else taken.add(m.name);
      }
    }
    for (const s of symbols) for (const t of s.terms) {
      const m = meta.get(t.net) || { rail: null, name: '', wire: false };
      const alone = (netTerms.get(t.net) || []).length < 2;
      // A supply flag only exists when this pin's net really is that supply.
      // An open pin is a no-connect: no rail, no wire, no invented "VCC" label.
      // Ground is the exception: a single pin on net 0 still gets the GND symbol.
      const isGnd = m.rail === 'gnd';
      t.nc = alone && !isGnd;
      t.netName = (alone && !isGnd) || !m.name ? '' : m.name;
      if ((alone && !isGnd) || (m.rail === 'flag' && !m.name)) {
        t.rail = null; t.wire = false;
      } else {
        t.rail = (s.kind === 'GND' && m.rail === 'gnd') ? null : m.rail;
        t.wire = !!m.wire && t.rail !== 'gnd' && t.rail !== 'flag';
        if (m.rail === 'gnd' && s.kind !== 'GND') t.rail = 'gnd';
        if (m.rail === 'flag') { t.rail = 'flag'; t.wire = false; }
        if (!m.wire && m.rail !== 'gnd' && m.rail !== 'flag') { t.wire = false; t.rail = null; }
      }
    }
    // A battery (or other source) that only carries a VCC flag looks parked. Draw one
    // wire from its output into a load on that net; the remaining pins keep the flag.
    for (const [net, terms] of netTerms) {
      const m = meta.get(net);
      if (!m || m.rail !== 'flag') continue;
      const src = terms.find((t) => SRC.has(t.type) && /^(\+|VOUT)$/.test(t.name) && !t.nc);
      if (!src) continue;
      const load = terms.find((t) => t !== src && !t.nc && (t.type === 'resistor' || t.type === 'ldr' || t.type === 'potentiometer' || t.type === 'trimmer'))
        || terms.find((t) => t !== src && !t.nc && /^(VCC|VDD|3V3|5V|VIN)$/i.test(t.name))
        || terms.find((t) => t !== src && !t.nc);
      if (!load) continue;
      src.rail = null; src.wire = true;
      load.rail = null; load.wire = true;
    }

    // A Ground part on a net that already reaches another pin is the same net the
    // GND rail draws. Keep one only when ground parts are the entire net.
    {
      const drop = new Set();
      const byNet = new Map();
      for (const s of symbols) if (s.part.type === 'ground' && s.terms[0]) {
        const net = s.terms[0].net;
        if (!byNet.has(net)) byNet.set(net, []);
        byNet.get(net).push(s);
      }
      for (const [net, gs] of byNet) {
        const mate = (netTerms.get(net) || []).some((t) => t.type !== 'ground');
        for (const s of (mate ? gs : gs.slice(1))) drop.add(s.id);
      }
      if (drop.size) {
        for (let i = symbols.length - 1; i >= 0; i--) if (drop.has(symbols[i].id)) symbols.splice(i, 1);
        for (const [net, terms] of [...netTerms]) {
          const next = terms.filter((t) => !drop.has(t.sid));
          if (next.length) netTerms.set(net, next); else netTerms.delete(net);
        }
        byId.clear();
        for (const s of symbols) byId.set(s.id, s);
      }
    }

    // The simulator's ground net is the one that is actually 0 V. A stored netlist
    // can disagree with the wires, and a lone ground pin used to be drawn as a
    // no-connect. Any non-ground symbol pin the solver calls ground gets a symbol.
    if (root.SimCore && root.SimCore.Sim) {
      let sim = null;
      try { sim = new root.SimCore.Sim(proj); sim.topology(); } catch (e) { sim = null; }
      if (sim && sim.pinNet) {
        for (const s of symbols) {
          if (!s.part || s.kind === 'GND' || s.part.type === 'ground') continue;
          for (const t of s.terms) {
            const pins = termPins(s.part, t);
            if (!pins.some((n) => sim.pinNet.get(s.part.id + ':' + n) === 0)) continue;
            t.nc = false;
            t.rail = 'gnd';
            t.wire = false;
            t.netName = 'GND';
          }
        }
      }
    }

    // Signal graph: nets that are actually drawn as wires.
    const adj = new Map(symbols.map((s) => [s.id, new Set()]));
    for (const [net, terms] of netTerms) {
      const m = meta.get(net);
      if (!m || !m.wire) continue;
      const wired = terms.filter((t) => t.wire);
      const ids = [...new Set(wired.map((t) => t.sid))];
      // A battery bus is a star from the source. Linking every load to every
      // other load made the middle of a series string look like the hub.
      const src = m.name && wired.find((t) => SRC.has(t.type) && /^(\+|VOUT)$/.test(t.name));
      if (src && ids.length > 2) {
        for (const id of ids) if (id !== src.sid) { adj.get(src.sid).add(id); adj.get(id).add(src.sid); }
        continue;
      }
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { adj.get(ids[i]).add(ids[j]); adj.get(ids[j]).add(ids[i]); }
    }
    const seen = new Set();
    const comps = [];
    function absorb(id, bag) {
      const q = [id]; seen.add(id);
      while (q.length) {
        const u = q.pop(); bag.add(u);
        for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); q.push(v); }
      }
    }
    const rootsPref = symbols.filter((s) => s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX');
    const order = [...symbols].sort((a, b) => (adj.get(b.id).size - adj.get(a.id).size) || (b.terms.length - a.terms.length));
    const seeds = [...rootsPref, ...order];
    for (const s of seeds) if (!seen.has(s.id) && adj.get(s.id).size) { const bag = new Set(); absorb(s.id, bag); comps.push(bag); }
    // Modules that share a net — a signal wire, a supply flag, GND, or a breadboard
    // rail — are one circuit even when no schematic wire is drawn between them.
    function liveNets(bag) {
      const nets = new Set();
      for (const id of bag) for (const t of byId.get(id).terms) if (!t.nc) nets.add(t.net);
      return nets;
    }
    function mergeBags(list) {
      if (list.length < 2) return list;
      const parent = list.map((_, i) => i);
      function findC(i) { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; }
      const netOwner = new Map();
      list.forEach((bag, i) => {
        for (const net of liveNets(bag)) {
          if (!netOwner.has(net)) netOwner.set(net, findC(i));
          else parent[findC(i)] = findC(netOwner.get(net));
        }
      });
      const out = new Map();
      list.forEach((bag, i) => {
        const r = findC(i);
        if (!out.has(r)) out.set(r, new Set());
        for (const id of bag) out.get(r).add(id);
      });
      return [...out.values()];
    }
    let compList = mergeBags(comps);
    let grew = true;
    while (grew) {
      grew = false;
      for (const bag of compList) {
        const nets = liveNets(bag);
        for (const s of symbols) {
          if (seen.has(s.id)) continue;
          if (!s.terms.some((t) => !t.nc && nets.has(t.net))) continue;
          bag.add(s.id); seen.add(s.id); grew = true;
        }
      }
    }
    // A part with a live pin (its own GND pins, or the only ground symbol) is a circuit.
    // Parking is only for a part whose every pin has no other terminal.
    for (const s of symbols) if (!seen.has(s.id) && s.terms.some((t) => !t.nc)) {
      compList.push(new Set([s.id])); seen.add(s.id);
    }
    compList = mergeBags(compList);
    const parkedIds = symbols.filter((s) => !seen.has(s.id)).map((s) => s.id);
    const rank = netRank(netTerms);

    let compTop = 0;
    compList.forEach((bag, ci) => {
      const ids = [...bag];
      const ranked = ids.slice().sort((a, b) => adj.get(b).size - adj.get(a).size);
      const device = ids.find((id) => byId.get(id).kind === 'ESP') || ids.find((id) => byId.get(id).kind === 'DIP');
      const passive = ids.every((id) => !ACTIVE.has(byId.get(id).kind));
      const src = ranked.find((id) => SRC.has(byId.get(id).part.type) && adj.get(id).size > 0);
      const wideSupply = ids.some((id) => byId.get(id).terms.some((t) => t.wire && t.netName && (netTerms.get(t.net) || []).filter((u) => u.wire).length >= 3));
      // Prefer the battery only when several discrete branches share it. A single
      // series chain still starts at its highest-degree part, as before.
      const root = device || (passive && wideSupply && src) || ranked[0];
      const layer = new Map();
      const q = [[root, 0]]; layer.set(root, 0);
      while (q.length) {
        const [u, L] = q.shift();
        for (const v of adj.get(u) || []) if (bag.has(v) && !layer.has(v)) { layer.set(v, L + 1); q.push([v, L + 1]); }
      }
      // Parts pulled in through GND or a supply (no signal path from the root) sit upstream.
      for (const id of ids) if (!layer.has(id)) layer.set(id, -1);
      let flow = 1;
      const rootS = byId.get(root);
      if (rootS.kind === 'ESP') {
        let left = 0, right = 0;
        for (const t of rootS.terms) {
          if (!t.wire) continue;
          if (P.ESP_BOT.includes(t.name)) left++; else right++;
        }
        flow = left >= right ? -1 : 1;
      }
      for (const id of ids) { const s = byId.get(id); s.layer = layer.has(id) ? layer.get(id) : -1; s.comp = ci; s.flow = flow; s.root = root; }
      // Batteries and supplies sit one column upstream of the device they feed, even when the
      // supply net is drawn as a wire (otherwise BFS parks them downstream of a resistor).
      ids.forEach((id) => {
        const s = byId.get(id);
        if (id !== root && (SRC.has(s.part.type) || adj.get(id).size === 0)) s.layer = -1;
      });
      // barycenter within the layer
      const idsByL = new Map();
      for (const id of ids) { const L = byId.get(id).layer; if (!idsByL.has(L)) idsByL.set(L, []); idsByL.get(L).push(id); }
      function neighLayers(id, pin) {
        const out = [];
        for (const o of netTerms.get(pin.net) || []) if (o.sid !== id && bag.has(o.sid)) out.push(byId.get(o.sid).layer);
        return out;
      }
      for (let pass = 0; pass < 4; pass++) {
        const Ls = [...idsByL.keys()].sort((a, b) => a - b);
        const seqL = pass % 2 ? Ls : Ls.slice().reverse();
        for (const L of seqL) {
          const arr = idsByL.get(L);
          const score = new Map();
          for (const id of arr) {
            let n = 0, s = 0;
            for (const v of adj.get(id) || []) if (bag.has(v)) {
              const ol = byId.get(v).layer;
              if (ol === L) continue;
              const idx = (idsByL.get(ol) || []).indexOf(v);
              if (idx >= 0) { s += idx; n++; }
            }
            score.set(id, n ? s / n : (idsByL.get(L).indexOf(id)));
          }
          arr.sort((a, b) => score.get(a) - score.get(b) || String(a).localeCompare(String(b)));
        }
      }
      // Parallel branches are compared with the breadboard. Keep that layer in the
      // breadboard's top-to-bottom order.
      if (passive && wideSupply) {
        for (const arr of idsByL.values()) arr.sort((a, b) => (byId.get(a).part.y - byId.get(b).part.y) || (byId.get(a).part.x - byId.get(b).part.x) || String(a).localeCompare(String(b)));
      }
      for (const id of ids) buildGeom(byId.get(id), { neighLayers, flow, bag, rank, passive: drawSupply });
      for (const id of ids) applySchMirror(byId.get(id));
      placeComp(ids.map((id) => byId.get(id)), flow, idsByL);
      let minY = Infinity, maxY = -Infinity;
      for (const id of ids) {
        const s = byId.get(id);
        minY = Math.min(minY, s.y - (s.pad ? s.pad.T : 0));
        maxY = Math.max(maxY, s.y + s.h + (s.pad ? s.pad.B : 0));
      }
      const dy = compTop - minY;
      if (dy) for (const id of ids) byId.get(id).y += dy;
      compTop = maxY + dy + 70;
    });

    // A part is parked only when every pin is open. It is not on a breadboard rail,
    // a shared ground, or any other net.
    if (parkedIds.length) {
      let band = 0, any = false;
      for (const s of symbols) if (!parkedIds.includes(s.id) && s.y !== undefined) {
        any = true;
        band = Math.max(band, s.y + s.h + ((s.pad && s.pad.B) || 24));
      }
      let x = 0, y = any ? snap(band + 80) : 20, rowH = 0;
      const wrap = 980;
      for (const id of parkedIds) {
        const s = byId.get(id);
        s.parked = true; s.flow = 1; s.layer = 0; s.comp = -1; s.root = id;
        buildGeom(s, { neighLayers: () => [], flow: 1, bag: new Set([id]) });
        applySchMirror(s);
        const p = pads(s);
        s.pad = p;
        const slot = p.L + s.w + p.R;
        if (x > 0 && x + slot > wrap) { x = 0; y += rowH + 28; rowH = 0; }
        s.x = snap(x + p.L); s.y = snap(y + p.T);
        x += slot + KEEP * 2 + GS * 2;
        rowH = Math.max(rowH, p.T + s.h + p.B);
      }
    }

    if (wantMatch) {
      try { reseatToBreadboard(symbols); }
      catch (err) { if (typeof console !== 'undefined' && console.error) console.error('schematic match', err); }
    }

    // On the breadboard seating a supply flag is only safe when its name sits on
    // that net's wire and on no other. Draw those pins as wires instead, so the
    // line itself is the connection.
    if (wantMatch) {
      for (const s of symbols) for (const t of s.terms) {
        if (t.rail !== 'flag') continue;
        t.rail = null;
        t.wire = true;
      }
    }

    // Absolute pins, rails, routes.
    for (const s of symbols) for (const t of s.terms) { t.x = s.x + t.lx; t.y = s.y + t.ly; }
    const rails = [];
    const obstacles = [];
    // Match layout already kept a lane between symbols. A fat keep-out fills that lane
    // and the router then has to cut through a body.
    const margin = wantMatch ? 4 : KEEP;
    for (const s of symbols) {
      obstacles.push({ x: s.x - margin, y: s.y - margin, x2: s.x + s.w + margin, y2: s.y + s.h + margin, sid: s.id });
      for (const t of s.terms) if (t.rail === 'gnd' || t.rail === 'flag') {
        const g = railGeom(t, s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX' ? 'mini' : 'full');
        if (!g) continue;
        if (g.kind === 'flag' && rails.some((r) => r.kind === 'flag' && r.name === g.name && Math.abs(r.px - g.px) < 36 && Math.abs(r.py - g.py) < 24)) g.nolabel = true;
        rails.push(g);
        obstacles.push({ x: g.x, y: g.y, x2: g.x2, y2: g.y2, sid: s.id, rail: true });
      }
    }
    const routed = routeNets(symbols, netTerms, meta, obstacles, wantMatch);
    let polys = routed.polys;
    let dots = junctions(polys, symbols);
    let labels = wireLabels(polys, netTerms, meta);
    let texts = placeTexts(symbols, rails, polys, labels, wantMatch);
    const tidyNets = routed.tidyNets || [];
    if (wantMatch) {
      let bad = connectivityFaults(symbols, polys, labels);
      if ((routed.unfixed || []).length || bad.length) {
        const tidy = layout(proj, { match: false });
        tidy.sheetFallback = true;
        tidy.notice = 'The tidy layout is shown for this circuit.';
        tidy.tidyNets = tidyNets;
        const why = (routed.unfixed || []).concat(bad).join(',');
        if (typeof console !== 'undefined' && console.warn) console.warn('schematic: tidy layout for this circuit (' + why + ')');
        return tidy;
      }
    }
    const bounds = computeBounds(symbols, rails, polys, labels, texts);
    return {
      symbols, rails, polys: polys, dots, labels, texts, bounds,
      fallback: routed.fallback, fallbackWhy: routed.fallbackWhy || [], nets: meta,
      tidyNets: tidyNets, sheetFallback: false, notice: '',
    };
  }

  // Pins of one net must be one drawn component, and a component must not hold two nets.
  // Flags of one name are one net. A label within 16 of its wire joins that wire to the flag.
  function connectivityFaults(symbols, polys, labels) {
    const uf = new UF();
    const pins = [];
    for (const s of symbols) for (const t of s.terms || []) {
      if (t.nc) continue;
      if (!t.wire && t.rail !== 'flag' && t.rail !== 'gnd') continue;
      const id = t.sid + ':' + t.name;
      pins.push({
        id: id, net: t.net, x: t.x, y: t.y, rail: t.rail,
        name: t.rail === 'gnd' ? 'GND' : (t.netName || ''),
      });
      uf.find(id);
    }
    const segs = [];
    for (const pl of polys || []) {
      const pts = pl.pts || [];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].x === pts[i - 1].x && pts[i].y === pts[i - 1].y) continue;
        segs.push({ x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y });
      }
    }
    for (let i = 0; i < segs.length; i++) {
      uf.find('seg:' + i);
      for (const pin of pins) if (pointSegDist(pin, segs[i]) <= PIN_GAP) uf.union('seg:' + i, pin.id);
      for (let j = 0; j < i; j++) if (segNear(segs[i], segs[j])) uf.union('seg:' + i, 'seg:' + j);
    }
    for (const pin of pins) {
      if (pin.rail === 'gnd') uf.union(pin.id, 'flag:GND');
      else if (pin.rail === 'flag' && pin.name) uf.union(pin.id, 'flag:' + pin.name);
    }
    for (const lab of labels || []) {
      if (!lab.name && !lab.text) continue;
      const text = lab.name || lab.text;
      let best = null, bd = 17;
      for (let i = 0; i < segs.length; i++) {
        const d = pointSegDist(lab, segs[i]);
        if (d < bd) { bd = d; best = i; }
      }
      if (best == null || bd > 16) continue;
      const named = pins.some((p) => (p.rail === 'flag' || p.rail === 'gnd') && p.name === text);
      if (named) uf.union('seg:' + best, 'flag:' + text);
    }
    const bad = new Set();
    const byNet = new Map();
    for (const pin of pins) {
      if (!byNet.has(pin.net)) byNet.set(pin.net, []);
      byNet.get(pin.net).push(pin);
    }
    for (const [net, list] of byNet) {
      const roots = new Set(list.map((p) => uf.find(p.id)));
      if (roots.size > 1) bad.add(net);
    }
    const byRoot = new Map();
    for (const pin of pins) {
      const r = uf.find(pin.id);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(pin.net);
    }
    for (const list of byRoot.values()) {
      const nets = new Set(list);
      if (nets.size > 1) for (const n of nets) bad.add(n);
    }
    return [...bad];
  }

  function opp(dir) { return { l: 'r', r: 'l', t: 'b', b: 't' }[dir] || 'r'; }
  // KiCad-style symbol mirror. Display only: pin names keep their nets, so the
  // breadboard and the netlist do not change. Text is drawn upright afterwards.
  function applySchMirror(s) {
    const part = s && s.part;
    if (!part || (!part.schFlipX && !part.schFlipY) || !s.w) return;
    const fx = !!part.schFlipX, fy = !!part.schFlipY;
    for (const t of s.terms || []) {
      if (fx) { t.lx = s.w - t.lx; if (t.dir === 'l' || t.dir === 'r') t.dir = opp(t.dir); }
      if (fy) { t.ly = s.h - t.ly; if (t.dir === 't' || t.dir === 'b') t.dir = opp(t.dir); }
    }
  }
  function sideOf(flow, which) { // which: 'up' (toward lower layer) | 'down' (toward higher layer)
    if (which === 'up') return flow > 0 ? 'l' : 'r';
    return flow > 0 ? 'r' : 'l';
  }

  function buildGeom(s, ctx) {
    const flow = s.flow || 1;
    const two = new Set(['R', 'LDR', 'NTC', 'C', 'L', 'D', 'Z', 'LED', 'SW', 'F', 'LAMP', 'XTAL', 'SPK', 'MOT', 'MET', 'PT']);
    function want(t) {
      if (t.rail === 'gnd') return 'b';
      if (t.rail === 'flag') return 'flag';
      const ls = ctx.neighLayers(s.id, t).filter((L) => L >= 0);
      if (!ls.length) return 'down';
      const avg = ls.reduce((a, b) => a + b, 0) / ls.length;
      if (avg < s.layer - 0.05) return 'up';
      if (avg > s.layer + 0.05) return 'down';
      return 'down';
    }
    if (s.kind === 'GND') {
      s.w = 40; s.h = 30; s.terms[0].dir = 't'; s.terms[0].lx = 20; s.terms[0].ly = 0; s.terms[0].rail = null; return;
    }
    if (s.kind === 'ESP') {
      const left = P.ESP_BOT.map((n) => s.terms.find((t) => t.name === n)).filter(Boolean);
      const right = P.ESP_TOP.map((n) => s.terms.find((t) => t.name === n)).filter(Boolean);
      const n = Math.max(left.length, right.length, 1);
      s.w = 160; s.h = 20 + n * 20;
      const put = (list, dir) => list.forEach((t, i) => { t.dir = dir; t.lx = dir === 'l' ? 0 : s.w; t.ly = 20 + i * 20; });
      put(left, 'l'); put(right, 'r');
      return;
    }
    if (s.kind === 'NPN' || s.kind === 'PNP' || s.kind === 'NMOS') {
      s.w = 80; s.h = 100;
      const find = (...ns) => s.terms.find((t) => ns.includes(t.name));
      const B = find('B', 'G'), C = find('C', 'D'), E = find('E', 'S');
      const up = sideOf(flow, 'up');
      if (B) { B.dir = up; B.lx = up === 'l' ? 0 : s.w; B.ly = 50; }
      if (C) { C.dir = 't'; C.lx = 40; C.ly = 0; }
      if (E) { E.dir = 'b'; E.lx = 40; E.ly = s.h; }
      for (const t of s.terms) if (t.lx === undefined) { t.dir = 'r'; t.lx = s.w; t.ly = 50; }
      return;
    }
    if (s.kind === 'DIP' || (s.kind === 'BOX' && s.terms.length > 4)) {
      const pins = s.terms;
      const left = [], right = [], top = [], bot = [];
      const powerName = /^(VCC|VDD|V\+|3V3|5V|VIN|VBAT)$/i;
      for (const t of pins) {
        const w = want(t);
        if (t.rail === 'gnd' || (String(t.name).toUpperCase() === 'GND' && !t.wire)) bot.push(t);
        else if (t.rail === 'flag' || (powerName.test(t.name) && !t.wire && !t.nc)) top.push(t);
        else if (w === 'up') (sideOf(flow, 'up') === 'l' ? left : right).push(t);
        else (sideOf(flow, 'down') === 'r' ? right : left).push(t);
      }
      // More than three power pins won't stay readable on the lid — extras go to the sides.
      while (top.length > 3) {
        const extra = top.findIndex((t) => !powerName.test(t.name));
        const t = top.splice(extra >= 0 ? extra : top.length - 1, 1)[0];
        (sideOf(flow, 'down') === 'r' ? right : left).push(t);
      }
      if (!left.length && !right.length && !top.length && !bot.length) pins.forEach((t, i) => (i < pins.length / 2 ? left : right).push(t));
      const n = Math.max(left.length, right.length, 1);
      s.h = 30 + n * 20;
      const sideW = (list) => list.reduce((m, t) => Math.max(m, textWidth(pinText(t, s.kind), 9.5)), 0);
      const edgeNeed = (list) => {
        if (!list.length) return 0;
        const sum = list.reduce((a, t) => a + Math.max(40, snap(textWidth(pinText(t, s.kind), 9.5) + 18)), 0);
        return snap(sum + 20);
      };
      s.w = snap(Math.max(s.kind === 'DIP' ? 120 : 140, edgeNeed(top), edgeNeed(bot), sideW(left) + sideW(right) + textWidth(s.title || '', 11) + 64));
      const putV = (list, dir) => list.forEach((t, i) => { t.dir = dir; t.lx = dir === 'l' ? 0 : s.w; t.ly = 30 + i * 20; });
      putV(left, 'l'); putV(right, 'r');
      placeEdge(top, 't', s);
      placeEdge(bot, 'b', s);
      for (const t of right) t.lx = s.w;
      return;
    }
    if (s.kind === 'POT' || s.kind === 'SW3') {
      s.w = 80; s.h = 60;
      const a = s.terms[0], b = s.terms[s.terms.length - 1];
      const mid = s.terms.find((t) => /^(W|2)$/.test(t.name)) || s.terms[1];
      if (s.kind === 'SW3') {
        const c = s.terms.find((t) => t.name === '2') || s.terms[1];
        const t1 = s.terms.find((t) => t.name === '1') || s.terms[0];
        const t3 = s.terms.find((t) => t.name === '3') || s.terms[2];
        c.dir = 'l'; c.lx = 0; c.ly = 30;
        t1.dir = 'r'; t1.lx = s.w; t1.ly = 20;
        t3.dir = 'r'; t3.lx = s.w; t3.ly = 40;
      } else {
        const p1 = s.terms.find((t) => t.name === '1') || a;
        const p2 = s.terms.find((t) => t.name === '2') || b;
        const wip = s.terms.find((t) => t.name === 'W') || mid;
        p1.dir = 'l'; p1.lx = 0; p1.ly = 40;
        p2.dir = 'r'; p2.lx = s.w; p2.ly = 40;
        wip.dir = 't'; wip.lx = 40; wip.ly = 0;
      }
      for (const t of s.terms) if (t.lx === undefined) { t.dir = 'r'; t.lx = s.w; t.ly = 30; }
      return;
    }
    if (s.kind === 'BAT' || s.kind === 'SRC') {
      s.w = 80; s.h = 60;
      const plus = s.terms.find((t) => t.name === '+' || t.name === 'VOUT') || s.terms[0];
      const minus = s.terms.find((t) => t.name === '-' || t.name === 'GND') || s.terms[1];
      plus.dir = sideOf(flow, 'down'); plus.lx = plus.dir === 'r' ? s.w : 0; plus.ly = 20;
      if (minus) {
        if (minus.rail === 'gnd' || minus.name === '-' || minus.name === 'GND') { minus.dir = 'b'; minus.lx = 40; minus.ly = s.h; }
        else { minus.dir = opp(plus.dir); minus.lx = minus.dir === 'r' ? s.w : 0; minus.ly = 20; }
      }
      for (const t of s.terms) if (t.lx === undefined) { t.dir = 'b'; t.lx = 40; t.ly = s.h; }
      return;
    }
    // Generic 2-pin (and small boxes). Every coordinate stays on the 10px routing grid.
    const ts = s.terms.slice();
    if (ts.length === 1) {
      s.w = 80; s.h = 40;
      const t = ts[0]; t.dir = 'b'; t.lx = 40; t.ly = s.h; return;
    }
    if (ts.length === 2) {
      let da = want(ts[0]), db = want(ts[1]);
      const toDir = (w) => (w === 'b' ? 'b' : w === 'flag' ? 't' : sideOf(flow, w === 'up' ? 'up' : 'down'));
      da = toDir(da); db = toDir(db);
      if (da === db) {
        if (ts[0].rail === 'gnd') da = 'b';
        else if (ts[1].rail === 'gnd') db = 'b';
        else if (ts[0].rail === 'flag') da = opp(db === 't' || db === 'b' ? 'l' : db);
        else if (ts[1].rail === 'flag') db = opp(da === 't' || da === 'b' ? 'l' : da);
        else db = opp(da);
      }
      if (ts[0].rail === 'gnd' && db !== 'b') da = 'b';
      if (ts[1].rail === 'gnd' && da !== 'b') db = 'b';
      if (ts[0].rail === 'flag' && (db === 'l' || db === 'r')) da = opp(db);
      if (ts[1].rail === 'flag' && (da === 'l' || da === 'r')) db = opp(da);
      const vertical = da === 't' || da === 'b' || db === 't' || db === 'b';
      s.w = 80;
      s.h = vertical ? 60 : 20;
      const midY = vertical ? 20 : 10;
      const put = (t, dir) => {
        t.dir = dir;
        if (dir === 'l') { t.lx = 0; t.ly = midY; }
        else if (dir === 'r') { t.lx = s.w; t.ly = midY; }
        else if (dir === 't') { t.lx = 40; t.ly = 0; }
        else { t.lx = 40; t.ly = s.h; }
      };
      put(ts[0], da); put(ts[1], db);
      if (ts[0].lx === ts[1].lx && ts[0].ly === ts[1].ly) put(ts[1], opp(da));
      // A series LED points from the supply toward the load. Layering can fold a
      // string around the middle part and leave the cathode on the battery side.
      if (ctx.passive && ctx.rank && (s.kind === 'LED' || s.kind === 'D')) {
        const anode = ts.find((t) => t.name === 'A' || t.name === '+');
        const cath = anode && ts.find((t) => t !== anode);
        if (anode && cath) {
          const ra = ctx.rank.get(anode.net);
          const rc = ctx.rank.get(cath.net);
          const up = sideOf(flow, 'up');
          const anodeCloser = ra !== undefined && (rc === undefined || ra < rc);
          if (anodeCloser && anode.dir !== up && (anode.dir === 'l' || anode.dir === 'r')) {
            if (cath.rail === 'gnd') put(anode, up);
            else if (cath.dir === 'l' || cath.dir === 'r') { put(anode, up); put(cath, opp(up)); }
          }
        }
      }
      return;
    }
    s.w = 100; s.h = 30 + Math.ceil(ts.length / 2) * 20;
    const lh = [], rh = [];
    ts.forEach((t) => (want(t) === 'up' ? lh : rh).push(t));
    if (!lh.length || !rh.length) { lh.length = 0; rh.length = 0; ts.forEach((t, i) => (i % 2 ? rh : lh).push(t)); }
    const rows = Math.max(lh.length, rh.length, 1);
    if (s.kind === 'BOX') {
      const side = (list) => list.reduce((m, t) => Math.max(m, textWidth(pinText(t, s.kind), 9.5)), 0);
      s.w = snap(Math.max(120, side(lh) + side(rh) + textWidth(s.title || '', 11) + 56));
    }
    lh.forEach((t, i) => { t.dir = 'l'; t.lx = 0; t.ly = 30 + i * 20; });
    rh.forEach((t, i) => { t.dir = 'r'; t.lx = s.w; t.ly = 30 + i * 20; });
    s.h = 30 + rows * 20;
  }

  function pads(s) {
    let T = 20, B = 20, L = 10, R = 10;
    for (const t of s.terms) {
      const full = !(s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX');
      const extra = t.rail === 'gnd' ? (full ? 40 : 30) : t.rail === 'flag' ? 30 : (t.wire ? 10 : 0);
      if (t.dir === 'l') L = Math.max(L, extra);
      if (t.dir === 'r') R = Math.max(R, extra);
      if (t.dir === 't') T = Math.max(T, 20 + (t.rail ? extra : 0));
      if (t.dir === 'b') B = Math.max(B, 20 + (t.rail ? extra : 0));
    }
    if (s.value) B = Math.max(B, 20);
    return { T, B, L, R };
  }

  function placeComp(syms, flow, idsByL) {
    const layers = [...idsByL.keys()].sort((a, b) => a - b);
    // Visual left → right
    const vis = flow > 0 ? layers.slice() : layers.slice().reverse();
    const CHAN = 100;
    let x = 0;
    for (const L of vis) {
      const col = (idsByL.get(L) || []).map((id) => syms.find((s) => s.id === id)).filter(Boolean);
      let y = 0, maxW = 0;
      for (const s of col) {
        const p = pads(s);
        s.pad = p;
        s.x = x + p.L; s.y = y + p.T;
        y += p.T + s.h + p.B + 20;
        maxW = Math.max(maxW, p.L + s.w + p.R);
      }
      x += maxW + CHAN;
    }
    // Align each symbol's upstream pin to the mate pin already placed (closer to the root).
    const ordered = flow > 0 ? layers.slice() : layers.slice().reverse();
    // Walk from the root outward. Root layer is 0; sources are -1.
    const outward = layers.slice().sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
    const done = new Set();
    // Place root layer first as the anchor (its y stays).
    for (const id of idsByL.get(0) || []) done.add(id);
    for (const L of outward) {
      if (L === 0) continue;
      const col = idsByL.get(L) || [];
      for (const id of col) {
        const s = syms.find((q) => q.id === id); if (!s) continue;
        const toward = L < 0 ? 0 : (L > 0 ? L - 1 : L + 1);
        let best = null;
        for (const t of s.terms) {
          if (!t.wire) continue;
          const mates = [];
          // mates filled below via closure — use s.terms nets through symbols list
        }
        void toward; void best;
      }
    }
    alignOutward(syms, idsByL);
    openChainRows(syms);
    packOverlaps(syms);
    packHorizontal(syms);
    for (const s of syms) { s.x = snap(s.x); s.y = snap(s.y); }
  }

  // Parallel branches off one battery are separate series chains. Give every part in a
  // chain the chain's row height so a ground symbol on the LED does not collide with
  // the branch below, then line each chain up on its series pins.
  function openChainRows(syms) {
    if (!syms.length || syms.some((s) => ACTIVE.has(s.kind))) return;
    const busCount = new Map();
    for (const s of syms) for (const t of s.terms) if (t.wire && t.netName) busCount.set(t.net, (busCount.get(t.net) || 0) + 1);
    if (![...busCount.values()].some((n) => n >= 3)) return;
    const parent = new Map(syms.map((s) => [s.id, s.id]));
    const find = (id) => {
      let p = parent.get(id);
      if (p !== id) { p = find(p); parent.set(id, p); }
      return p;
    };
    const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const netPins = new Map();
    for (const s of syms) for (const t of s.terms) {
      if (!t.wire) continue;
      if (!netPins.has(t.net)) netPins.set(t.net, []);
      netPins.get(t.net).push({ s, t });
    }
    for (const pins of netPins.values()) {
      const ids = [...new Set(pins.map((p) => p.s.id))];
      if (ids.length === 2) unite(ids[0], ids[1]);
    }
    const slotOf = (s) => { const p = s.pad || pads(s); return p.T + s.h + p.B; };
    const groups = new Map();
    for (const s of syms) {
      const r = find(s.id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(s);
    }
    const pitch = new Map();
    for (const g of groups.values()) {
      const h = Math.max(...g.map(slotOf));
      for (const s of g) pitch.set(s.id, h);
    }
    const byL = new Map();
    for (const s of syms) {
      const L = s.layer || 0;
      if (!byL.has(L)) byL.set(L, []);
      byL.get(L).push(s);
    }
    for (const col of byL.values()) {
      col.sort((a, b) => a.y - b.y || String(a.id).localeCompare(String(b.id)));
      const top = col[0];
      let y = top.y - ((top.pad && top.pad.T) || 0);
      for (const s of col) {
        const p = s.pad || pads(s);
        s.y = y + p.T;
        y += Math.max(slotOf(s), pitch.get(s.id) || 0) + 20;
      }
    }
    const layers = [...byL.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    const done = new Set((byL.get(0) || []).map((s) => s.id));
    for (const L of layers) {
      if (L === 0) continue;
      const col = (byL.get(L) || []).slice().sort((a, b) => a.y - b.y);
      for (const s of col) {
        let shift = null;
        for (const t of s.terms) {
          if (!t.wire) continue;
          const pins = netPins.get(t.net) || [];
          if (new Set(pins.map((p) => p.s.id)).size !== 2) continue;
          const mates = pins.filter((m) => m.s !== s && done.has(m.s.id));
          if (!mates.length) continue;
          const m = mates[0];
          const sh = (m.s.y + m.t.ly) - (s.y + t.ly);
          if (shift === null || Math.abs(sh) < Math.abs(shift)) shift = sh;
        }
        if (shift) s.y += Math.round(shift / GS) * GS;
        done.add(s.id);
      }
    }
  }

  function alignOutward(syms, idsByL) {
    const byId = new Map(syms.map((s) => [s.id, s]));
    const netPins = new Map();
    for (const s of syms) for (const t of s.terms) {
      if (!netPins.has(t.net)) netPins.set(t.net, []);
      netPins.get(t.net).push({ s, t });
    }
    const layers = [...idsByL.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    const done = new Set(idsByL.get(0) || []);
    for (const L of layers) {
      if (L === 0) continue;
      for (const id of idsByL.get(L) || []) {
        const s = byId.get(id); if (!s) continue;
        const hasSeries = s.terms.some((t) => {
          if (!t.wire) return false;
          const n = new Set((netPins.get(t.net) || []).map((m) => m.s.id));
          return n.size === 2;
        });
        let shift = null;
        for (const t of s.terms) {
          if (!t.wire) continue;
          const all = netPins.get(t.net) || [];
          const mates = all.filter((m) => m.s !== s && done.has(m.s.id));
          if (!mates.length) continue;
          // A shared supply bus is not a series partner. Keep each branch on its
          // own row instead of stacking every load on the battery pin.
          const wired = all.filter((m) => m.t.wire);
          if (hasSeries && wired.length > 2 && t.netName) continue;
          const ty = mates.reduce((a, m) => a + m.s.y + m.t.ly, 0) / mates.length;
          const my = s.y + t.ly;
          const sh = ty - my;
          if (shift === null || Math.abs(sh) < Math.abs(shift)) shift = sh;
        }
        if (shift) s.y += Math.round(shift / GS) * GS;
        done.add(id);
      }
    }
  }

  function packHorizontal(syms) {
    // Facing pins grow stubs of STUB px. Bodies that share a row need a gap so those stubs,
    // and the wires that follow, never meet inside a symbol or on the same grid edge.
    const gap = KEEP * 2 + GS * 2;
    let guard = 0, moved = true;
    while (moved && guard++ < 40) {
      moved = false;
      const boxes = syms.map((s) => ({ x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h, s })).sort((a, b) => a.x - b.x || a.y - b.y);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.y2 <= b.y + 4 || b.y2 <= a.y + 4) continue;
        if (b.x >= a.x2 + gap) continue;
        const push = Math.ceil((a.x2 + gap - b.x) / GS) * GS;
        b.s.x += push; b.x += push; b.x2 += push; moved = true;
      }
    }
  }

  function packOverlaps(syms) {
    const box = (s) => {
      const p = s.pad || pads(s);
      return { x: s.x - p.L, y: s.y - p.T, x2: s.x + s.w + p.R, y2: s.y + s.h + p.B, s };
    };
    let guard = 0;
    let moved = true;
    while (moved && guard++ < 40) {
      moved = false;
      const boxes = syms.map(box).sort((a, b) => a.y - b.y || a.x - b.x);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x2 <= b.x + 4 || b.x2 <= a.x + 4) continue;
        if (a.y2 <= b.y + 4) continue;
        const push = Math.ceil((a.y2 - b.y + 16) / GS) * GS;
        b.s.y += push; b.y += push; b.y2 += push; moved = true;
      }
    }
  }

  function railGeom(t, size) {
    const mini = size === 'mini';
    const x = t.x, y = t.y, dir = t.dir || 'b';
    if (t.rail === 'flag') {
      const name = t.netName || '';
      if (!name) return null;
      let x0 = x, y0 = y, x2 = x, y2 = y;
      if (dir === 't') { y0 = y - 28; y2 = y; x0 = x - 18; x2 = x + Math.max(18, name.length * 7); }
      else if (dir === 'b') { y0 = y; y2 = y + 28; x0 = x - 18; x2 = x + Math.max(18, name.length * 7); }
      else if (dir === 'l') { x0 = x - 16 - name.length * 7; x2 = x; y0 = y - 10; y2 = y + 10; }
      else { x0 = x; x2 = x + 16 + name.length * 7; y0 = y - 10; y2 = y + 10; }
      return { kind: 'flag', name, x: x0, y: y0, x2, y2, px: x, py: y, dir, pid: t.sid, pin: t.name };
    }
    // ground symbol box
    const h = mini ? 16 : 26, w = mini ? 16 : 28;
    let x0, y0, x2, y2;
    if (dir === 'b') { x0 = x - w / 2; x2 = x + w / 2; y0 = y; y2 = y + h; }
    else if (dir === 't') { x0 = x - w / 2; x2 = x + w / 2; y0 = y - h; y2 = y; }
    else if (dir === 'l') { x0 = x - w - 8; x2 = x; y0 = y - 2; y2 = y + h; }
    else { x0 = x; x2 = x + w + 8; y0 = y - 2; y2 = y + h; }
    return { kind: 'gnd', name: 'GND', x: x0, y: y0, x2, y2, px: x, py: y, dir, mini, pid: t.sid, pin: t.name };
  }

  function inside(p, r) { return p.x > r.x && p.x < r.x2 && p.y > r.y && p.y < r.y2; }

  // A foreign wire closer than this reads as the same net. A pin is joined at 3
  // by the same measurement the drawn sheet uses. A right-angle cross whose
  // intersection sits in both interiors is not a join.
  const WIRE_GAP = 2;
  const PIN_GAP = 3;
  function pointSegDist(p, s) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) return Math.hypot(p.x - s.x1, p.y - s.y1);
    let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy));
  }
  function segHoriz(s) { return Math.abs(s.y1 - s.y2) <= 1e-6 && Math.abs(s.x1 - s.x2) > 1e-6; }
  function segVert(s) { return Math.abs(s.x1 - s.x2) <= 1e-6 && Math.abs(s.y1 - s.y2) > 1e-6; }
  function cleanCross(a, b) {
    let h = null, v = null;
    if (segHoriz(a) && segVert(b)) { h = a; v = b; }
    else if (segHoriz(b) && segVert(a)) { h = b; v = a; }
    else return false;
    const x = v.x1, y = h.y1;
    const hx0 = Math.min(h.x1, h.x2), hx1 = Math.max(h.x1, h.x2);
    const vy0 = Math.min(v.y1, v.y2), vy1 = Math.max(v.y1, v.y2);
    return x > hx0 + WIRE_GAP && x < hx1 - WIRE_GAP && y > vy0 + WIRE_GAP && y < vy1 - WIRE_GAP;
  }
  function segNear(a, b) {
    if (cleanCross(a, b)) return false;
    if (pointSegDist({ x: a.x1, y: a.y1 }, b) <= WIRE_GAP) return true;
    if (pointSegDist({ x: a.x2, y: a.y2 }, b) <= WIRE_GAP) return true;
    if (pointSegDist({ x: b.x1, y: b.y1 }, a) <= WIRE_GAP) return true;
    if (pointSegDist({ x: b.x2, y: b.y2 }, a) <= WIRE_GAP) return true;
    if (segHoriz(a) && segHoriz(b) && Math.abs(a.y1 - b.y1) <= WIRE_GAP) {
      const a0 = Math.min(a.x1, a.x2), a1 = Math.max(a.x1, a.x2);
      const b0 = Math.min(b.x1, b.x2), b1 = Math.max(b.x1, b.x2);
      if (Math.min(a1, b1) > Math.max(a0, b0)) return true;
    }
    if (segVert(a) && segVert(b) && Math.abs(a.x1 - b.x1) <= WIRE_GAP) {
      const a0 = Math.min(a.y1, a.y2), a1 = Math.max(a.y1, a.y2);
      const b0 = Math.min(b.y1, b.y2), b1 = Math.max(b.y1, b.y2);
      if (Math.min(a1, b1) > Math.max(a0, b0)) return true;
    }
    return false;
  }
  function segsOf(pts) {
    const s = simplify(pts);
    const out = [];
    for (let i = 1; i < s.length; i++) out.push({ x1: s[i - 1].x, y1: s[i - 1].y, x2: s[i].x, y2: s[i].y });
    return out;
  }
  function pathBad(pts, ctx, net) {
    const segs = segsOf(pts);
    for (const seg of segs) {
      for (const p of ctx.pins || []) {
        if (p.net === net) continue;
        if (pointSegDist(p, seg) <= PIN_GAP) return true;
      }
      for (const o of ctx.segs || []) {
        if (o.net === net) continue;
        if (segNear(seg, o)) return true;
      }
      if (ctx.obstacles && pathHitsObs([{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }], ctx.bodyObs || ctx.obstacles)) return true;
    }
    return false;
  }
  function addDrawn(ctx, net, pts) {
    for (const s of segsOf(pts)) ctx.segs.push({ net: net, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
  }
  function chooseClearLeads(symbols, obstacles) {
    const pins = [];
    for (const s of symbols) for (const t of s.terms) if (t.wire) pins.push(t);
    pins.sort((a, b) => (a.net - b.net) || String(a.sid).localeCompare(String(b.sid)) || String(a.name).localeCompare(String(b.name)));
    const segs = [];
    const pinPts = pins.map((t) => ({ x: t.x, y: t.y, net: t.net }));
    const stepOf = (t) => t.dir === 'l' ? [-1, 0] : t.dir === 'r' ? [1, 0] : t.dir === 't' ? [0, -1] : [0, 1];
    for (const t of pins) {
      const [sx, sy] = stepOf(t);
      const perps = [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([dx, dy]) => dx !== sx || dy !== sy);
      const cands = [];
      for (let n = 3; n <= 16; n++) cands.push([{ x: t.x, y: t.y }, { x: snap(t.x + sx * n * GS), y: snap(t.y + sy * n * GS) }]);
      for (let along = 2; along <= 6; along++) for (const [px, py] of perps) for (let n = 1; n <= 8; n++) {
        const bend = { x: snap(t.x + sx * along * GS), y: snap(t.y + sy * along * GS) };
        cands.push([
          { x: t.x, y: t.y },
          bend,
          { x: snap(bend.x + px * n * GS), y: snap(bend.y + py * n * GS) },
        ]);
      }
      const bodies = (obstacles || []).filter((r) => r.sid !== t.sid && !r.rail);
      let chosen = null;
      for (const pts of cands) {
        const end = pts[pts.length - 1];
        if ((obstacles || []).some((r) => inside(end, r))) continue;
        if (pathHitsObs(pts, bodies)) continue;
        if (pathBad(pts, { segs: segs, pins: pinPts, obstacles: null }, t.net)) continue;
        chosen = pts;
        break;
      }
      // No clear stub. Start the route at the pin itself rather than draw a lead
      // along another net.
      if (!chosen) chosen = [{ x: t.x, y: t.y }];
      t.lead = simplify(chosen);
      t.sx = t.lead[t.lead.length - 1].x;
      t.sy = t.lead[t.lead.length - 1].y;
      for (const s of segsOf(t.lead)) segs.push({ net: t.net, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
    }
  }
  function outerPaths(a, b, board) {
    const cands = [];
    const put = (pts) => cands.push(pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y));
    for (const m of [40, 80, 120, 180, 260, 360, 480]) {
      const top = snap(board.minY - m), bot = snap(board.maxY + m);
      const left = snap(board.minX - m), right = snap(board.maxX + m);
      put([a, { x: a.x, y: top }, { x: b.x, y: top }, b]);
      put([a, { x: a.x, y: bot }, { x: b.x, y: bot }, b]);
      put([a, { x: left, y: a.y }, { x: left, y: b.y }, b]);
      put([a, { x: right, y: a.y }, { x: right, y: b.y }, b]);
      put([a, { x: a.x, y: top }, { x: right, y: top }, { x: right, y: b.y }, b]);
      put([a, { x: a.x, y: bot }, { x: left, y: bot }, { x: left, y: b.y }, b]);
    }
    return cands;
  }
  function insideAny(p, obstacles) {
    return (obstacles || []).some((r) => p.x > r.x && p.x < r.x2 && p.y > r.y && p.y < r.y2);
  }
  // Walk out of the symbols to a point past the board, then join those points
  // on a lane no other net is using. That is the tidy route for one net.
  function tidyLink(a, b, ctx, net) {
    const goal = { x: b.x, y: b.y };
    const tree = [{ x: a.x, y: a.y }];
    // The breadboard channel is blocked. Cross symbol bodies if needed, but never
    // another net. A right-angle cross of a foreign wire is still allowed.
    const prevPass = ctx.passSid, prevBody = ctx.bodyObs;
    ctx.passSid = true;
    ctx.bodyObs = [];
    const done = (path) => { ctx.passSid = prevPass; ctx.bodyObs = prevBody; return path; };
    if (goal.x !== tree[0].x || goal.y !== tree[0].y) {
      for (const strict of [true, false, 'open']) {
        const path = astar(tree, goal, ctx, net, strict, ctx.board);
        if (path && !pathBad(path, ctx, net)) return done(simplify(path));
      }
    }
    const board = ctx.board;
    const dirsOf = (p) => {
      const all = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const primary = p.dir === 'l' ? [-1, 0] : p.dir === 'r' ? [1, 0] : p.dir === 't' ? [0, -1] : p.dir === 'b' ? [0, 1] : null;
      return primary ? [primary].concat(all.filter((d) => d[0] !== primary[0] || d[1] !== primary[1])) : all;
    };
    const runOut = (p) => {
      for (const [dx, dy] of dirsOf(p)) {
        const pts = [{ x: p.x, y: p.y }];
        let x = p.x, y = p.y;
        for (let n = 0; n < 100; n++) {
          const nx = snap(x + dx * GS), ny = snap(y + dy * GS);
          if (insideAny({ x: nx, y: ny }, ctx.bodyObs || ctx.obstacles)) break;
          x = nx; y = ny;
          pts.push({ x: x, y: y });
          if (x < board.minX - GS || x > board.maxX + GS || y < board.minY - GS || y > board.maxY + GS) return pts;
        }
      }
      return null;
    };
    const pa = runOut(a), pb = runOut(b);
    if (!pa || !pb) return done(null);
    const ea = pa[pa.length - 1], eb = pb[pb.length - 1];
    for (const m of [GS, GS * 4, GS * 8, GS * 14, GS * 22, GS * 32]) {
      const top = snap(board.minY - m), bot = snap(board.maxY + m);
      const left = snap(board.minX - m), right = snap(board.maxX + m);
      const mids = [
        [ea, { x: ea.x, y: top }, { x: eb.x, y: top }, eb],
        [ea, { x: ea.x, y: bot }, { x: eb.x, y: bot }, eb],
        [ea, { x: left, y: ea.y }, { x: left, y: eb.y }, eb],
        [ea, { x: right, y: ea.y }, { x: right, y: eb.y }, eb],
      ];
      for (const mid of mids) {
        const full = simplify(pa.concat(mid.slice(1), pb.slice(0, -1).reverse()));
        if (pathHitsObs(full, ctx.bodyObs || ctx.obstacles)) continue;
        if (pathBad(full, ctx, net)) continue;
        return done(full);
      }
    }
    return done(null);
  }

  function routeNets(symbols, netTerms, meta, obstacles, clearance) {
    const pinAt = new Map();
    const endpoints = new Map(); // net -> [{pin, stub}]
    if (clearance) chooseClearLeads(symbols, obstacles);
    for (const s of symbols) for (const t of s.terms) {
      if (!t.wire) continue;
      if (!clearance) {
        let stub = stubOf(t, STUB);
        for (let k = 0; k < 10; k++) {
          const key = stub.x + ',' + stub.y;
          const owner = pinAt.get(key);
          const taken = owner !== undefined && owner !== t.net;
          const buried = obstacles.some((r) => inside(stub, r));
          const cuts = leadCuts(t, stub, obstacles);
          if (!taken && !buried && !cuts) break;
          stub = stubOf(t, STUB + (k + 1) * GS);
        }
        t.sx = stub.x; t.sy = stub.y;
        t.lead = [{ x: t.x, y: t.y }, { x: stub.x, y: stub.y }];
      }
      pinAt.set(t.x + ',' + t.y, t.net);
      pinAt.set(t.sx + ',' + t.sy, t.net);
      if (!endpoints.has(t.net)) endpoints.set(t.net, []);
      endpoints.get(t.net).push(t);
    }
    const nets = [...endpoints.entries()].sort((a, b) => a[1].length - b[1].length || a[0] - b[0]);
    let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
    const grow = (x, y) => { bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x); bMinY = Math.min(bMinY, y); bMaxY = Math.max(bMaxY, y); };
    for (const r of obstacles) { grow(r.x, r.y); grow(r.x2, r.y2); }
    for (const pins of endpoints.values()) for (const t of pins) { grow(t.x, t.y); grow(t.sx, t.sy); }
    if (!isFinite(bMinX)) { bMinX = 0; bMaxX = 0; bMinY = 0; bMaxY = 0; }
    const spanX = Math.ceil((bMaxX - bMinX + 160) / GS), spanY = Math.ceil((bMaxY - bMinY + 160) / GS);
    const board = { minX: bMinX - 80, maxX: bMaxX + 80, minY: bMinY - 80, maxY: bMaxY + 80, cap: Math.min(250000, Math.max(40000, spanX * spanY * 4)) };
    const ctx = {
      obstacles, pinAt, used: new Map(), vinfo: new Map(), fallback: false, fallbackWhy: [], board,
      segs: [], pins: [], tidyNets: [], unfixed: [], clearance: !!clearance,
    };
    if (clearance) {
      for (const pins of endpoints.values()) for (const t of pins) ctx.pins.push({ x: t.x, y: t.y, net: t.net });
      for (const [net, pins] of endpoints) for (const t of pins) {
        commitPath(ctx, net, t.lead);
        addDrawn(ctx, net, t.lead);
      }
    }
    const polys = []; // {net, name, pts}
    for (const [net, pins] of nets) {
      if (pins.length < 2) continue;
      const name = (meta.get(net) && meta.get(net).name) || '';
      const tree = [{ x: pins[0].sx, y: pins[0].sy }];
      const branches = [];
      let ok = true;
      for (let i = 1; i < pins.length; i++) {
        const goal = { x: pins[i].sx, y: pins[i].sy };
        const near = routeWindow(tree, goal, 180, 20000);
        let path = astar(tree, goal, ctx, net, true, near);
        if (!path) path = astar(tree, goal, ctx, net, false, near);
        if (!path) path = astar(tree, goal, ctx, net, true, ctx.board);
        if (!path) path = astar(tree, goal, ctx, net, false, ctx.board);
        if (!path) path = astar(tree, goal, ctx, net, 'open', ctx.board);
        if (path && clearance && pathBad(path, ctx, net)) path = null;
        if (!path && clearance) {
          let around = null;
          for (const from of tree) {
            around = tidyLink(from, goal, ctx, net);
            if (around) break;
          }
          if (around) {
            path = around;
            if (!ctx.tidyNets.includes(net)) {
              ctx.tidyNets.push(net);
              if (typeof console !== 'undefined' && console.warn) console.warn('schematic: tidy route for net ' + net);
            }
          }
        }
        if (!path) {
          const why = 'net ' + net + ' ' + pins[0].sid + '.' + pins[0].name + ' → ' + pins[i].sid + '.' + pins[i].name;
          ctx.fallback = true;
          ctx.fallbackWhy.push(why);
          if (typeof console !== 'undefined' && console.warn) console.warn('schematic fallback: ' + why);
          path = orthoFallback(tree[0], goal, ctx.obstacles, clearance ? ctx : null, net);
          if (path && clearance && pathBad(path, ctx, net)) path = null;
          if (!path) { ctx.unfixed.push(net); ok = false; break; }
        }
        for (const p of path) tree.push(p);
        branches.push({ path, pin: pins[i] });
      }
      if (clearance) {
        for (const t of pins) polys.push({ net, name, pts: simplify(t.lead) });
      } else {
        commitPath(ctx, net, [{ x: pins[0].x, y: pins[0].y }, { x: pins[0].sx, y: pins[0].sy }]);
        polys.push({ net, name, pts: simplify([{ x: pins[0].x, y: pins[0].y }, { x: pins[0].sx, y: pins[0].sy }]) });
      }
      for (const b of branches) {
        const full = b.path.slice();
        const last = full[full.length - 1];
        if (!last || last.x !== b.pin.sx || last.y !== b.pin.sy) full.push({ x: b.pin.sx, y: b.pin.sy });
        // The lead is already its own polyline when clearance is on. A straight
        // stub-to-pin segment would draw over the jog and onto the other net.
        if (!clearance) full.push({ x: b.pin.x, y: b.pin.y });
        commitPath(ctx, net, full);
        if (clearance) addDrawn(ctx, net, full);
        polys.push({ net, name, pts: simplify(full) });
      }
      void ok;
    }
    if (clearance) repairDirtyNets(ctx, polys, endpoints, meta);
    return { polys, fallback: ctx.fallback, fallbackWhy: ctx.fallbackWhy, tidyNets: ctx.tidyNets, unfixed: ctx.unfixed };
  }

  function repairDirtyNets(ctx, polys, endpoints, meta) {
    const dirty = new Set(ctx.unfixed);
    for (const pins of endpoints.values()) for (const t of pins) if (t._leadDirty) dirty.add(t.net);
    for (let i = 0; i < ctx.segs.length; i++) for (let j = i + 1; j < ctx.segs.length; j++) {
      if (ctx.segs[i].net === ctx.segs[j].net) continue;
      if (segNear(ctx.segs[i], ctx.segs[j])) { dirty.add(ctx.segs[i].net); dirty.add(ctx.segs[j].net); }
    }
    for (const p of ctx.pins) for (const s of ctx.segs) {
      if (s.net === p.net) continue;
      if (pointSegDist(p, s) <= PIN_GAP) { dirty.add(p.net); dirty.add(s.net); }
    }
    for (const net of dirty) {
      for (let i = polys.length - 1; i >= 0; i--) if (polys[i].net === net) polys.splice(i, 1);
      ctx.segs = ctx.segs.filter((s) => s.net !== net);
      const pins = endpoints.get(net) || [];
      const name = (meta.get(net) && meta.get(net).name) || '';
      const built = [];
      let failed = pins.length < 2;
      let at = pins.length ? { x: pins[0].x, y: pins[0].y } : null;
      for (let i = 1; !failed && i < pins.length; i++) {
        const goal = { x: pins[i].x, y: pins[i].y };
        const path = tidyLink(at, goal, ctx, net);
        if (!path) { failed = true; break; }
        addDrawn(ctx, net, path);
        commitPath(ctx, net, path);
        built.push({ net: net, name: name, pts: path });
        at = goal;
      }
      if (failed) {
        ctx.segs = ctx.segs.filter((s) => s.net !== net);
        if (!ctx.unfixed.includes(net)) ctx.unfixed.push(net);
        if (typeof console !== 'undefined' && console.warn) console.warn('schematic unfixed net ' + net + ' pins ' + pins.map((t) => t.sid + '.' + t.name + '@' + t.x + ',' + t.y + (t._leadDirty ? ' dirty' : '')).join(' '));
        continue;
      }
      for (const pl of built) polys.push(pl);
      const ix = ctx.unfixed.indexOf(net);
      if (ix >= 0) ctx.unfixed.splice(ix, 1);
      if (!ctx.tidyNets.includes(net)) {
        ctx.tidyNets.push(net);
        if (typeof console !== 'undefined' && console.warn) console.warn('schematic: tidy route for net ' + net);
      }
    }
  }

  function leadCuts(t, stub, obstacles) {
    for (const r of obstacles) {
      if (r.sid === t.sid) continue;
      if (r.rail) continue;
      const a = { x: t.x, y: t.y }, b = stub;
      if (a.x === b.x) {
        const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        if (a.x > r.x && a.x < r.x2 && y1 > r.y && y0 < r.y2) return true;
      } else if (a.y === b.y) {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        if (a.y > r.y && a.y < r.y2 && x1 > r.x && x0 < r.x2) return true;
      }
    }
    return false;
  }
  function stubOf(t, d) {
    if (t.dir === 'l') return { x: snap(t.x - d), y: t.y };
    if (t.dir === 'r') return { x: snap(t.x + d), y: t.y };
    if (t.dir === 't') return { x: t.x, y: snap(t.y - d) };
    return { x: t.x, y: snap(t.y + d) };
  }
  function edgeKey(x, y, nx, ny) {
    if (x === nx) return 'v:' + x + ':' + Math.min(y, ny);
    return 'h:' + y + ':' + Math.min(x, nx);
  }
  function pathHitsObs(path, obstacles) {
    if (!obstacles) return false;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      for (const r of obstacles) {
        if (a.x === b.x) {
          const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
          if (a.x > r.x && a.x < r.x2 && y1 > r.y && y0 < r.y2) return true;
        } else if (a.y === b.y) {
          const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
          if (a.y > r.y && a.y < r.y2 && x1 > r.x && x0 < r.x2) return true;
        }
      }
    }
    return false;
  }
  function orthoFallback(a, b, obstacles, ctx, net) {
    const cands = [];
    const lane = (x, y) => cands.push([a, { x, y: a.y }, { x, y }, { x: b.x, y }, b]);
    if (a.x === b.x || a.y === b.y) cands.push([a, b]);
    else { cands.push([a, { x: b.x, y: a.y }, b]); cands.push([a, { x: a.x, y: b.y }, b]); }
    const ys = [], xs = [];
    for (const r of obstacles || []) { ys.push(r.y - GS, r.y2 + GS); xs.push(r.x - GS, r.x2 + GS); }
    for (const d of [40, -40, 80, -80, 140, -140, 220, -220, 320, -320]) { ys.push(a.y + d); xs.push(a.x + d); }
    for (const y of ys) cands.push([a, { x: a.x, y }, { x: b.x, y }, b]);
    for (const x of xs) cands.push([a, { x, y: a.y }, { x, y: b.y }, b]);
    for (const y of ys) for (const x of xs) lane(x, y);
    if (ctx && ctx.board) for (const path of outerPaths(a, b, ctx.board)) cands.push(path);
    for (const path of cands) {
      const clean = path.filter((p, i) => i === 0 || p.x !== path[i - 1].x || p.y !== path[i - 1].y);
      if (pathHitsObs(clean, obstacles)) continue;
      if (ctx && pathBad(clean, ctx, net)) continue;
      return clean;
    }
    return ctx ? null : cands[0];
  }
  function simplify(pts) {
    const o = [];
    for (const p of pts) {
      if (o.length && o[o.length - 1].x === p.x && o[o.length - 1].y === p.y) continue;
      o.push({ x: p.x, y: p.y });
    }
    const r = [];
    for (const p of o) {
      const n = r.length;
      if (n >= 2) {
        const a = r[n - 2], b = r[n - 1];
        if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) { r[n - 1] = p; continue; }
      }
      r.push(p);
    }
    return r;
  }
  function commitPath(ctx, net, pts) {
    for (let i = 1; i < pts.length; i++) {
      let x = pts[i - 1].x, y = pts[i - 1].y, nx = pts[i].x, ny = pts[i].y;
      const horiz = y === ny;
      const step = horiz ? (nx > x ? GS : -GS) : (ny > y ? GS : -GS);
      const n = Math.round(Math.abs(horiz ? nx - x : ny - y) / GS);
      for (let k = 0; k < n; k++) {
        const ax = x, ay = y;
        if (horiz) x += step; else y += step;
        ctx.used.set(edgeKey(ax, ay, x, y), net);
        markV(ctx, ax, ay, net, horiz ? 'h' : 'v');
        markV(ctx, x, y, net, horiz ? 'h' : 'v');
      }
    }
  }
  function markV(ctx, x, y, net, axis) {
    const k = x + ',' + y;
    let v = ctx.vinfo.get(k);
    if (!v) { v = { net, axes: new Set() }; ctx.vinfo.set(k, v); }
    if (v.net === net) v.axes.add(axis);
  }

  function routeWindow(tree, goal, margin, cap) {
    let minX = goal.x, maxX = goal.x, minY = goal.y, maxY = goal.y;
    for (const p of tree) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    return { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin, cap };
  }
  function astar(tree, goal, ctx, net, strict, win) {
    const goalK = goal.x + ',' + goal.y;
    const startSet = new Set(tree.map((p) => p.x + ',' + p.y));
    if (startSet.has(goalK)) return [{ x: goal.x, y: goal.y }];
    const parent = new Map();
    const best = new Map();
    const heap = [];
    const push = (c, x, y, dir) => {
      const k = x + ',' + y + ',' + dir;
      if (best.has(k) && best.get(k) <= c) return;
      best.set(k, c);
      const h = (Math.abs(goal.x - x) + Math.abs(goal.y - y)) / GS;
      heap.push({ c: c + h, g: c, x, y, dir });
      let i = heap.length - 1;
      while (i) { const p = (i - 1) >> 1; if (heap[p].c <= heap[i].c) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
    };
    const pop = () => {
      if (!heap.length) return null;
      const top = heap[0], v = heap.pop();
      if (heap.length) {
        heap[0] = v; let i = 0;
        for (;;) {
          let l = i * 2 + 1, r = l + 1, s = i;
          if (l < heap.length && heap[l].c < heap[s].c) s = l;
          if (r < heap.length && heap[r].c < heap[s].c) s = r;
          if (s === i) break;
          const t = heap[s]; heap[s] = heap[i]; heap[i] = t; i = s;
        }
      }
      return top;
    };
    const minX = win.minX, maxX = win.maxX, minY = win.minY, maxY = win.maxY;
    for (const p of tree) push(0, p.x, p.y, -1);
    const dirs = [[GS, 0, 0], [-GS, 0, 1], [0, GS, 2], [0, -GS, 3]];
    let guard = 0;
    const cap = win.cap || 25000;
    while (heap.length && guard++ < cap) {
      const cur = pop();
      if (cur.x === goal.x && cur.y === goal.y) {
        const path = [{ x: cur.x, y: cur.y }];
        let k = cur.x + ',' + cur.y + ',' + cur.dir;
        let safety = 0;
        while (parent.has(k) && safety++ < 5000) {
          const pr = parent.get(k);
          if (startSet.has(pr.x + ',' + pr.y) && !parent.has(pr.x + ',' + pr.y + ',' + pr.dir)) { path.push({ x: pr.x, y: pr.y }); break; }
          path.push({ x: pr.x, y: pr.y });
          k = pr.x + ',' + pr.y + ',' + pr.dir;
          if (startSet.has(pr.x + ',' + pr.y)) break;
        }
        path.reverse();
        return path;
      }
      for (const [dx, dy, di] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
        const turn = cur.dir !== -1 && cur.dir !== di;
        if (cur.dir === -1 && false) continue;
        if (!stepOk(ctx, cur.x, cur.y, nx, ny, di, net, strict, goalK)) continue;
        const nk = nx + ',' + ny + ',' + di;
        const g = cur.g + 1 + (turn ? 5 : 0);
        if (best.has(nk) && best.get(nk) <= g) continue;
        parent.set(nk, { x: cur.x, y: cur.y, dir: cur.dir });
        push(g, nx, ny, di);
      }
    }
    return null;
  }

  function perpInterior(seg, o) {
    const sh = Math.abs(seg.y1 - seg.y2) < 1e-6, sv = Math.abs(seg.x1 - seg.x2) < 1e-6;
    const oh = Math.abs(o.y1 - o.y2) < 1e-6, ov = Math.abs(o.x1 - o.x2) < 1e-6;
    if (!((sh && ov) || (sv && oh))) return false;
    if (pointSegDist({ x: seg.x2, y: seg.y2 }, o) > 0.1) return false;
    const span = oh ? Math.min(Math.abs(seg.x2 - o.x1), Math.abs(seg.x2 - o.x2)) : Math.min(Math.abs(seg.y2 - o.y1), Math.abs(seg.y2 - o.y2));
    return span > WIRE_GAP;
  }
  function leavesInterior(seg, o) {
    const sh = Math.abs(seg.y1 - seg.y2) < 1e-6, sv = Math.abs(seg.x1 - seg.x2) < 1e-6;
    const oh = Math.abs(o.y1 - o.y2) < 1e-6, ov = Math.abs(o.x1 - o.x2) < 1e-6;
    if (!((sh && ov) || (sv && oh))) return false;
    if (pointSegDist({ x: seg.x1, y: seg.y1 }, o) > 0.1) return false;
    const span = oh ? Math.min(Math.abs(seg.x1 - o.x1), Math.abs(seg.x1 - o.x2)) : Math.min(Math.abs(seg.y1 - o.y1), Math.abs(seg.y1 - o.y2));
    return span > WIRE_GAP;
  }
  function sittingOn(ctx, x, y, net, horiz) {
    for (const o of ctx.segs || []) {
      if (o.net === net || pointSegDist({ x: x, y: y }, o) > 0.1) continue;
      const oh = Math.abs(o.y1 - o.y2) < 1e-6;
      const span = oh ? Math.min(Math.abs(x - o.x1), Math.abs(x - o.x2)) : Math.min(Math.abs(y - o.y1), Math.abs(y - o.y2));
      if (span <= WIRE_GAP) return true;
      if (oh === horiz) return true;
    }
    return false;
  }
  function tidyStep(ctx, x, y, nx, ny, horiz, net) {
    const seg = { x1: x, y1: y, x2: nx, y2: ny };
    for (const p of ctx.pins || []) if (p.net !== net && pointSegDist(p, seg) <= PIN_GAP) return false;
    if (sittingOn(ctx, x, y, net, horiz)) return false;
    for (const o of ctx.segs || []) {
      if (o.net === net || !segNear(seg, o) || perpInterior(seg, o) || leavesInterior(seg, o)) continue;
      return false;
    }
    return true;
  }

  function stepOk(ctx, x, y, nx, ny, di, net, strict, goalK) {
    const horiz = di <= 1;
    const ek = edgeKey(x, y, nx, ny);
    const eu = ctx.used.get(ek);
    if (eu !== undefined && eu !== net) return false;
    const k = nx + ',' + ny;
    const owner = ctx.pinAt.get(k);
    if (owner !== undefined && owner !== net && k !== goalK) return false;
    // A tidy retry may cross a foreign wire in the middle of a grid step. It may
    // not stop there, run along it, or come close to a pin that is not its own.
    if (ctx.passSid) {
      if (!tidyStep(ctx, x, y, nx, ny, horiz, net)) return false;
      return true;
    }
    // The goal cell is this net's own stub. Reach it even when another route grazed the point.
    if (k === goalK) return true;
    const info = ctx.vinfo.get(k);
    if (info && info.net !== net) {
      const axis = horiz ? 'h' : 'v';
      if (info.axes.has(axis)) return false;
      if (strict === true) return false;
      // 'open' may cross a foreign corner. A plain retry only hops a straight foreign run.
      if (strict !== 'open' && info.axes.size !== 1) return false;
    }
    if (owner === net) return true;
    if (!ctx.passSid) {
      for (const r of ctx.obstacles) if (nx > r.x && nx < r.x2 && ny > r.y && ny < r.y2) return false;
    }
    return true;
  }

  function junctions(polys, symbols) {
    const pins = new Set();
    for (const s of symbols) for (const t of s.terms) pins.add(t.x + ',' + t.y);
    const segs = [];
    for (const pl of polys || []) {
      const pts = pl.pts || [];
      for (let i = 1; i < pts.length; i++) {
        segs.push({ net: pl.net, x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y });
      }
    }
    const marks = wireJoints(segs);
    const dots = [];
    for (const d of marks.dots) {
      if (pins.has(d.x + ',' + d.y)) continue;
      if (symbols.some((s) => d.x >= s.x && d.x <= s.x + s.w && d.y >= s.y && d.y <= s.y + s.h)) continue;
      dots.push({ x: d.x, y: d.y, net: d.net });
    }
    return dots;
  }

  function wireLabels(polys, netTerms, meta) {
    const labels = [];
    const best = new Map();
    // Supply names belong to the one net netKind named. Copying "VCC" off a pin
    // would put the same name on every separate supply.
    const supply = /^(VCC|3V3|5V|VIN|GND|\+V|\d+(?:\.\d+)?V)$/i;
    for (const pl of polys) {
      const m = meta.get(pl.net);
      let name = pl.name;
      if (!name) {
        const terms = netTerms.get(pl.net) || [];
        const byPart = new Map();
        for (const t of terms) {
          if (!byPart.has(t.sid)) byPart.set(t.sid, new Set());
          if (t.name) byPart.get(t.sid).add(String(t.name).toUpperCase());
        }
        // TRIG tied to THR on the same chip is a junction, not a wire named TRIG.
        const tied = [...byPart.values()].some((set) => [...set].filter((n) => !/^(1|2|\+|-|A|K)$/.test(n)).length >= 2);
        const nice = tied ? '' : terms.map((t) => t.name).find((n) => /^(D\d+|GPIO\d+|3V3|VIN|A\d|OUT|TRIG|THR|DIS|RESET|SDA|SCL|MOSI|MISO|SCK|CS)$/i.test(n) || /^[A-Z]{2,}/.test(n) && n.length <= 6);
        if (nice && !supply.test(nice) && terms.length >= 2) name = String(nice).replace(/^GND\.\d$/, 'GND');
      }
      if (!name || (m && m.rail === 'gnd')) continue;
      for (let i = 1; i < pl.pts.length; i++) {
        const a = pl.pts[i - 1], b = pl.pts[i];
        const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        const prev = best.get(pl.net);
        if (!prev || len > prev.len) best.set(pl.net, { len, a, b, name, net: pl.net });
      }
    }
    // The same text on two nets would read as one net.
    const seen = new Set();
    for (const v of best.values()) {
      if (seen.has(v.name)) v.name = '';
      else seen.add(v.name);
    }
    for (const v of best.values()) {
      if (!v.name || v.len < 30) continue;
      const mx = (v.a.x + v.b.x) / 2, my = (v.a.y + v.b.y) / 2;
      const horiz = v.a.y === v.b.y;
      labels.push({
        x: mx, y: horiz ? my - 8 : my, name: v.name, net: v.net, anchor: horiz ? 'middle' : 'start',
        ax: v.a.x, ay: v.a.y, bx: v.b.x, by: v.b.y,
      });
    }
    return labels;
  }

  function ncPoint(t) {
    const d = 9;
    if (t.dir === 'l') return { x: t.x - d, y: t.y };
    if (t.dir === 'r') return { x: t.x + d, y: t.y };
    if (t.dir === 't') return { x: t.x, y: t.y - d };
    return { x: t.x, y: t.y + d };
  }
  function makeBox(text, x, y, size, anchor) {
    const w = textWidth(text, size), h = size + 3;
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    return { x: x0, y: y - size, w, h, x2: x0 + w, y2: y + 3, text, ax: x, ay: y, anchor };
  }
  function boxesHit(a, b, pad) {
    const p = pad || 0;
    const ix = Math.min(a.x2, b.x2) - Math.max(a.x, b.x);
    const iy = Math.min(a.y2, b.y2) - Math.max(a.y, b.y);
    return ix > 1 - p && iy > 1 - p;
  }
  /** Nudge every label onto a free spot. Side pin names and titles stay inside their own body. */
  function placeTexts(symbols, rails, polys, labels, keepOnWire) {
    const blockers = [];
    for (const s of symbols) blockers.push({ x: s.x - 1, y: s.y - 1, x2: s.x + s.w + 1, y2: s.y + s.h + 1, body: s.id });
    for (const r of rails) if (r.kind === 'gnd') blockers.push({ x: r.x - 2, y: r.y - 2, x2: r.x2 + 2, y2: r.y2 + 2 });
    for (const s of symbols) for (const t of s.terms) if (t.nc && s.kind !== 'ESP') {
      const p = ncPoint(t);
      blockers.push({ x: p.x - 6, y: p.y - 6, x2: p.x + 6, y2: p.y + 6 });
    }
    for (const pl of polys) for (let i = 1; i < pl.pts.length; i++) {
      const a = pl.pts[i - 1], b = pl.pts[i];
      blockers.push({ x: Math.min(a.x, b.x) - 3, y: Math.min(a.y, b.y) - 3, x2: Math.max(a.x, b.x) + 3, y2: Math.max(a.y, b.y) + 3 });
    }
    const items = [];
    for (const s of symbols) {
      const ref = { kind: 'ref', text: s.ref, size: 12, anchor: 'middle', x: s.x + s.w / 2, y: s.y - 8, own: s.id, move: true };
      items.push(ref); s.refPos = ref;
      if (s.value && s.kind !== 'SRC' && s.kind !== 'MET') {
        const gnd = s.terms.some((t) => t.rail === 'gnd');
        const val = {
          kind: 'val', text: s.value, size: 11, own: s.id, move: true,
          anchor: gnd ? 'start' : 'middle',
          x: gnd ? s.x + s.w + 8 : s.x + s.w / 2,
          y: gnd ? s.y + Math.min(16, Math.max(12, s.h * 0.45)) : s.y + s.h + 14,
        };
        items.push(val); s.valPos = val;
      }
      if (s.parked) {
        const below = s.valPos ? s.y + s.h + 36 : s.y + s.h + 16;
        const note = { kind: 'note', text: 'Not connected', size: 10, anchor: 'middle', x: s.x + s.w / 2, y: below, move: true, pid: s.id };
        items.push(note); s.notePos = note;
      }
      if (s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX') {
        const title = {
          kind: 'title', text: s.kind === 'ESP' ? 'ESP32' : (s.title || ''), size: 11, anchor: 'middle',
          x: s.x + s.w / 2, y: s.y + 13, own: s.id, move: true,
        };
        items.push(title); s.titlePos = title;
      }
      if (s.kind === 'SRC' || s.kind === 'MET') {
        const plus = s.terms.find((t) => t.dir === 'l' || t.dir === 'r') || s.terms[0];
        const cx = s.kind === 'MET' ? s.x + s.w / 2 : (plus && plus.dir === 'r' ? plus.x - 26 : plus.x + 26);
        const cy = s.kind === 'MET' ? (plus ? plus.y : s.y + s.h / 2) : (plus ? plus.y : s.y + 20);
        const title = { kind: 'title', text: s.kind === 'MET' ? (s.value || 'V') : (s.value || s.title || ''), size: 11, anchor: 'middle', x: cx, y: cy + 4, own: s.id, move: false };
        if (title.text) { items.push(title); s.titlePos = title; }
      }
      const named = s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX' || s.kind === 'SW3' || s.kind === 'POT';
      if (!named) continue;
      const inside = s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX';
      for (const t of s.terms) {
        if (!t.name) continue;
        let x = t.x, y = t.y, anchor = 'middle', own = null, move = true;
        if (t.dir === 'l') { x = inside ? s.x + 6 : t.x - 6; y = t.y + 3; anchor = inside ? 'start' : 'end'; own = inside ? s.id : null; move = !inside; }
        else if (t.dir === 'r') { x = inside ? s.x + s.w - 6 : t.x + 6; y = t.y + 3; anchor = inside ? 'end' : 'start'; own = inside ? s.id : null; move = !inside; }
        else if (t.dir === 't') { y = t.y - 13; anchor = 'middle'; move = true; }
        else { y = inside ? t.y - 5 : t.y + 12; anchor = 'middle'; own = inside ? s.id : null; move = true; }
        const lab = { kind: 'pin', text: pinText(t, s.kind), size: 9.5, anchor, x, y, own, move };
        items.push(lab); t.labPos = lab;
      }
    }
    for (const r of rails) if (r.kind === 'flag' && r.name && !r.nolabel) {
      const anchor = r.dir === 'l' ? 'end' : r.dir === 'r' ? 'start' : 'middle';
      const x = r.dir === 'l' ? r.px - 10 : r.dir === 'r' ? r.px + 10 : r.px;
      const y = r.dir === 't' ? r.py - 28 : r.dir === 'b' ? r.py + 18 : r.py - 4;
      const lab = { kind: 'flag', text: r.name, size: 10.5, anchor, x, y, move: true };
      items.push(lab); r.labPos = lab;
    }
    for (const l of labels) {
      const lab = {
        kind: 'net', text: l.name, size: 10.5, anchor: l.anchor || 'middle', x: l.x, y: l.y, move: true,
        ax: l.ax, ay: l.ay, bx: l.bx, by: l.by,
      };
      items.push(lab); l.labPos = lab;
    }
    function hitAny(box, self) {
      for (const b of blockers) {
        if (self.own && b.body === self.own) continue;
        if (boxesHit(box, b)) return true;
      }
      for (const o of items) if (o !== self && o.box && boxesHit(box, o.box, 5)) return true;
      return false;
    }
    for (const it of items) if (!it.move) it.box = makeBox(it.text, it.x, it.y, it.size, it.anchor);
    const shifts = [];
    for (const ring of [0, 14, 28, 42, 56, 72, 90]) {
      if (ring === 0) { shifts.push([0, 0]); continue; }
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        shifts.push([Math.round(Math.cos(a) * ring), Math.round(Math.sin(a) * ring)]);
      }
    }
    for (const it of items) {
      if (!it.move) continue;
      const onWire = (x, y) => {
        if (!keepOnWire || it.kind !== 'net' || it.ax == null) return true;
        return pointSegDist({ x: x, y: y }, { x1: it.ax, y1: it.ay, x2: it.bx, y2: it.by }) <= 16;
      };
      let placed = null;
      for (const [dx, dy] of shifts) {
        if (!onWire(it.x + dx, it.y + dy)) continue;
        const box = makeBox(it.text, it.x + dx, it.y + dy, it.size, it.anchor);
        if (!hitAny(box, it)) { placed = box; break; }
      }
      // A breadboard net label has to stay on its own wire. The tidy sheet may
      // step a label clear of its neighbours.
      if (!placed && keepOnWire && it.kind === 'net' && it.ax != null) {
        const horiz = it.ay === it.by;
        for (let i = 0; i <= 12 && !placed; i++) {
          const t = i / 12;
          const x = it.ax + (it.bx - it.ax) * t;
          const y = it.ay + (it.by - it.ay) * t;
          for (const off of [0, -8, 8, -12, 12, -16, 16]) {
            const px = horiz ? x : x + off;
            const py = horiz ? y - off : y;
            if (!onWire(px, py)) continue;
            const box = makeBox(it.text, px, py, it.size, it.anchor);
            if (!hitAny(box, it)) { placed = box; break; }
          }
        }
      }
      if (!placed && !(keepOnWire && it.kind === 'net')) {
        for (let n = 1; n <= 12 && !placed; n++) {
          const box = makeBox(it.text, it.x + n * 16, it.y - n * 14, it.size, it.anchor);
          if (!hitAny(box, it)) placed = box;
        }
      }
      if (!placed && !(keepOnWire && it.kind === 'net')) placed = makeBox(it.text, it.x, it.y - 48, it.size, it.anchor);
      if (!placed) placed = makeBox(it.text, it.x, it.y, it.size, it.anchor);
      it.x = placed.ax; it.y = placed.ay; it.box = placed;
    }
    for (const l of labels) if (l.labPos) { l.x = l.labPos.x; l.y = l.labPos.y; l.anchor = l.labPos.anchor; }
    return items.filter((it) => it.box).map((it) => Object.assign(it.box, { kind: it.kind, own: it.own || null, text: it.text, pid: it.pid || null, size: it.size || MIN_LABEL_FONT }));
  }

  function computeBounds(symbols, rails, polys, labels, texts) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const add = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const s of symbols) { add(s.x - (s.pad ? s.pad.L : 20), s.y - 24); add(s.x + s.w + (s.pad ? s.pad.R : 20), s.y + s.h + 20); }
    for (const r of rails) { add(r.x, r.y); add(r.x2, r.y2); }
    for (const pl of polys) for (const p of pl.pts) add(p.x, p.y);
    for (const l of labels) { add(l.x - 8, l.y - 14); add(l.x + textWidth(l.name, 10.5) + 8, l.y + 4); }
    for (const t of texts || []) { add(t.x, t.y); add(t.x2, t.y2); }
    if (x0 > x1) return { x: 0, y: 0, w: 200, h: 120 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- drawing ----------
  function toSvg(model, sel) {
    let s = '';
    for (const pl of model.polys) {
      if (!pl.pts || pl.pts.length < 2) continue;
      const d = 'M' + pl.pts.map((p) => p.x + ' ' + p.y).join(' L');
      s += `<path d="${d}" class="sch-hitnet" data-net="${pl.net}" data-name="${esc(pl.name || '')}"/>`;
      // One element per segment, so a label can avoid the stroke's box
      // without treating the whole net as one rectangle.
      for (let i = 1; i < pl.pts.length; i++) {
        const a = pl.pts[i - 1], b = pl.pts[i];
        if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 0.5) continue;
        s += `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" class="sch-wire"/>`;
      }
    }
    for (const d of model.dots) s += `<circle class="sch-dot" cx="${d.x}" cy="${d.y}" r="3.3"/>`;
    for (const r of model.rails) s += drawRail(r);
    for (const sym of model.symbols) s += drawSymbol(sym, sel);
    for (const l of model.labels) s += `<text class="sch-netlbl" x="${l.x}" y="${l.y}" text-anchor="${l.anchor || 'middle'}">${esc(l.name)}</text>`;
    return s;
  }
  function drawRail(r) {
    if (r.kind === 'flag') {
      const p = r.labPos;
      const tx = p ? p.x : (r.dir === 'l' ? r.px - 10 : r.dir === 'r' ? r.px + 10 : r.px);
      const ty = p ? p.y : (r.dir === 't' ? r.py - 28 : r.dir === 'b' ? r.py + 18 : r.py - 4);
      const anchor = p ? p.anchor : (r.dir === 'l' ? 'end' : r.dir === 'r' ? 'start' : 'middle');
      const lead = r.dir === 't' ? `M${r.px} ${r.py} V${r.py - 16}` : r.dir === 'b' ? `M${r.px} ${r.py} V${r.py + 14}` : r.dir === 'l' ? `M${r.px} ${r.py} H${r.px - 14}` : `M${r.px} ${r.py} H${r.px + 14}`;
      const label = r.nolabel || !r.name ? '' : `<text class="sch-flag" x="${tx}" y="${ty}" text-anchor="${anchor}">${esc(r.name)}</text>`;
      return `<path d="${lead}" class="sch-stroke sch-rail"/>${label}`;
    }
    const mini = r.mini;
    const a = mini ? 7 : 11, b = mini ? 4 : 7, c = mini ? 2 : 3;
    const g1 = mini ? 6 : 8, g2 = mini ? 11 : 14, g3 = mini ? 15 : 20;
    let d = '';
    const px = r.px, py = r.py;
    if (r.dir === 'b' || r.dir === 'r' || r.dir === 'l') {
      const ox = r.dir === 'l' ? px - (mini ? 14 : 18) : r.dir === 'r' ? px + (mini ? 14 : 18) : px;
      const oy = r.dir === 'b' ? py : py;
      if (r.dir === 'b') d = `M${px} ${py} V${py + g1} M${px - a} ${py + g1} H${px + a} M${px - b} ${py + g2} H${px + b} M${px - c} ${py + g3} H${px + c}`;
      else d = `M${px} ${py} H${ox} M${ox - a} ${oy + g1} H${ox + a} M${ox - b} ${oy + g2} H${ox + b} M${ox - c} ${oy + g3} H${ox + c}`;
    } else d = `M${px} ${py} V${py - g1} M${px - a} ${py - g1} H${px + a} M${px - b} ${py - g2} H${px + b} M${px - c} ${py - g3} H${px + c}`;
    return `<path d="${d}" class="sch-stroke sch-gnd"/>`;
  }
  function pinDots(sym) {
    return sym.terms.map((t) => `<circle class="sch-pin" cx="${t.x}" cy="${t.y}" r="2.2" data-pin="${esc(t.name)}" data-pid="${esc(sym.id)}"/>`).join('');
  }
  function refText(sym) {
    const r = sym.refPos || { x: sym.x + sym.w / 2, y: sym.y - 8, anchor: 'middle' };
    const v = sym.valPos;
    const n = sym.notePos;
    return `<text class="sch-ref" data-kind="ref" data-natural="12" data-full="${esc(sym.ref)}" x="${r.x}" y="${r.y}" style="text-anchor:${r.anchor || 'middle'}">${esc(sym.ref)}</text>` +
      (v && sym.value ? `<text class="sch-val" data-kind="val" data-natural="11" data-full="${esc(sym.value)}" x="${v.x}" y="${v.y}" style="text-anchor:${v.anchor || 'middle'}">${esc(sym.value)}</text>` : '') +
      (n ? `<text class="sch-note" x="${n.x}" y="${n.y}" style="text-anchor:${n.anchor || 'middle'}">${esc(n.text)}</text>` : '');
  }
  function hit(sym) {
    return `<rect class="sch-hit" x="${sym.x}" y="${sym.y}" width="${sym.w}" height="${sym.h}" data-pid="${esc(sym.id)}"/>`;
  }
  function pinName(t, sym, inside) {
    if (sym.kind === 'R' || sym.kind === 'C' || sym.kind === 'L' || sym.kind === 'D' || sym.kind === 'Z' || sym.kind === 'LED') return '';
    if (t.labPos) {
      const p = t.labPos;
      return `<text class="sch-pname" x="${p.x}" y="${p.y}" style="text-anchor:${p.anchor}">${esc(p.text)}</text>`;
    }
    const inward = inside;
    let x = t.x, y = t.y, anchor = 'middle';
    if (t.dir === 'l') { x = inward ? sym.x + 6 : t.x - 6; anchor = inward ? 'start' : 'end'; y = t.y + 3; }
    else if (t.dir === 'r') { x = inward ? sym.x + sym.w - 6 : t.x + 6; anchor = inward ? 'end' : 'start'; y = t.y + 3; }
    else if (t.dir === 't') { y = t.y - 13; }
    else { y = t.y + (inward ? -5 : 12); }
    const label = (sym.kind === 'DIP' && t.num ? t.num + ' ' : '') + t.name;
    return `<text class="sch-pname" x="${x}" y="${y}" style="text-anchor:${anchor}">${esc(label)}</text>`;
  }
  function drawNc(t) {
    const p = ncPoint(t), d = 4.5;
    return `<path class="sch-nc" d="M${p.x - d} ${p.y - d} L${p.x + d} ${p.y + d} M${p.x - d} ${p.y + d} L${p.x + d} ${p.y - d}"/>`;
  }
  function drawSymbol(sym, sel) {
    const on = sel && sel === sym.id ? ' sel' : '';
    let body = '';
    const k = sym.kind;
    if (k === 'R' || k === 'LDR' || k === 'NTC' || k === 'F') body = draw2pinZig(sym, k);
    else if (k === 'C') body = drawCap(sym);
    else if (k === 'L') body = drawInductor(sym);
    else if (k === 'D' || k === 'Z' || k === 'LED') body = drawDiode(sym);
    else if (k === 'NPN' || k === 'PNP') body = drawBjt(sym);
    else if (k === 'NMOS') body = drawMos(sym);
    else if (k === 'PT') body = drawPt(sym);
    else if (k === 'SW' || k === 'SW3') body = drawSw(sym);
    else if (k === 'POT') body = drawPot(sym);
    else if (k === 'GND') body = drawGndPart(sym);
    else if (k === 'BAT') body = drawBat(sym);
    else if (k === 'SRC') body = drawSrc(sym);
    else if (k === 'MET') body = drawMeter(sym);
    else if (k === 'XTAL') body = drawXtal(sym);
    else if (k === 'SPK' || k === 'MOT' || k === 'LAMP') body = drawCircleDev(sym);
    else body = drawBox(sym);
    const names = (k === 'ESP' || k === 'DIP' || k === 'BOX' || k === 'SW3' || k === 'POT') ? sym.terms.map((t) => pinName(t, sym, k === 'ESP' || k === 'DIP' || k === 'BOX')).join('') : '';
    const ncs = sym.kind === 'ESP' ? '' : sym.terms.filter((t) => t.nc).map(drawNc).join('');
    const glow = sym.led ? `<circle class="sch-glow" data-glow="${esc(sym.id)}" cx="${(sym.terms[0] ? (sym.terms[0].x + (sym.terms[1] ? sym.terms[1].x : sym.terms[0].x)) / 2 : sym.x + sym.w / 2)}" cy="${sym.y + sym.h / 2}" r="14" fill="${sym.led}" opacity="0"/>` : '';
    return `<g class="sch-sym${on}" data-pid="${esc(sym.id)}">${body}${glow}${pinDots(sym)}${ncs}${names}${refText(sym)}${hit(sym)}</g>`;
  }
  function horizPins(sym) {
    const hs = sym.terms.filter((t) => t.dir === 'l' || t.dir === 'r');
    if (hs.length >= 2) return hs.slice().sort((a, b) => a.x - b.x);
    const a = sym.terms[0], b = sym.terms[1] || sym.terms[0];
    return [a, b].sort((p, q) => p.x - q.x);
  }
  function axisY(sym) {
    const h = sym.terms.filter((t) => t.dir === 'l' || t.dir === 'r');
    if (h.length) return h.reduce((s, t) => s + t.y, 0) / h.length;
    return sym.y + 20;
  }
  /** Orthogonal lead from a pin to a point on the symbol body. */
  function stub(pin, x, y) {
    if (!pin || (pin.x === x && pin.y === y)) return '';
    if (pin.dir === 't' || pin.dir === 'b') {
      if (pin.x === x) return `M${pin.x} ${pin.y} V${y}`;
      return `M${pin.x} ${pin.y} V${y} H${x}`;
    }
    if (pin.y === y) return `M${pin.x} ${pin.y} H${x}`;
    return `M${pin.x} ${pin.y} H${x} V${y}`;
  }
  function draw2pinZig(sym, k) {
    const y = axisY(sym);
    const x0 = sym.x + 8, x1 = sym.x + sym.w - 8;
    const z0 = x0 + 6, z1 = x1 - 6;
    let d = `M${x0} ${y} H${z0}`;
    const n = 6, dx = (z1 - z0) / n, amp = k === 'F' ? 0 : 6;
    if (k === 'F') d += ` H${z1}`;
    else for (let i = 0; i < n; i++) d += ` L${(z0 + dx * i + dx / 2).toFixed(1)} ${y + (i % 2 ? amp : -amp)} L${(z0 + dx * (i + 1)).toFixed(1)} ${y}`;
    d += ` H${x1}`;
    for (const t of sym.terms) d += ' ' + stub(t, Math.abs(t.x - x0) <= Math.abs(t.x - x1) ? x0 : x1, y);
    if (k === 'F') d += ` M${z0} ${y - 6} H${z1} V${y + 6} H${z0} Z`;
    let extra = '';
    if (k === 'LDR' || k === 'NTC') {
      extra = `<path d="M${z0 + 6} ${y - 14} l6 -6 M${z0 + 14} ${y - 14} l6 -6" class="sch-stroke"/>` +
        `<path d="M${z0 + 4} ${y - 16} l3 3 M${z0 + 12} ${y - 16} l3 3" class="sch-stroke"/>`;
    }
    return `<path d="${d}" class="sch-stroke"/>` + extra;
  }
  function drawCap(sym) {
    const y = axisY(sym);
    const mid = sym.x + sym.w / 2;
    let d = '';
    if (sym.elec) {
      d += `M${mid - 4} ${y - 12} V${y + 12} M${mid + 6} ${y - 12} Q${mid + 1} ${y} ${mid + 6} ${y + 12}`;
      d += ` M${mid - 12} ${y - 14} h6 M${mid - 9} ${y - 17} v6`;
    } else d += `M${mid - 4} ${y - 12} V${y + 12} M${mid + 4} ${y - 12} V${y + 12}`;
    const pins = sym.terms.slice().sort((a, b) => a.x - b.x);
    pins.forEach((t, i) => { d += ' ' + stub(t, i === 0 ? mid - 6 : mid + 6, y); });
    return `<path d="${d}" class="sch-stroke"/>`;
  }
  function drawInductor(sym) {
    const [a, b] = horizPins(sym);
    const y = a.y, x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const z0 = x0 + 12, z1 = x1 - 12, n = 4, dx = (z1 - z0) / n;
    let d = `M${x0} ${y} H${z0}`;
    for (let i = 0; i < n; i++) {
      const x = z0 + i * dx;
      d += ` A${(dx / 2).toFixed(1)} ${(dx / 2).toFixed(1)} 0 0 1 ${x + dx} ${y}`;
    }
    d += ` H${x1}`;
    return `<path d="${d}" class="sch-stroke"/>`;
  }
  function drawDiode(sym) {
    const anode = sym.terms.find((t) => t.name === 'A' || t.name === '+') || sym.terms[0];
    const cath = sym.terms.find((t) => t !== anode) || sym.terms[1];
    const y = axisY(sym);
    // Conventional current: the triangle points at the cathode bar.
    const anodeRight = !!(cath && anode.x >= cath.x);
    const pointingRight = !anodeRight;
    const tip = pointingRight ? sym.x + sym.w - 22 : sym.x + 22;
    const base = pointingRight ? tip - 16 : tip + 16;
    const bar = pointingRight ? tip + 5 : tip - 5;
    let d = `M${base} ${y - 10} L${tip} ${y} L${base} ${y + 10} Z M${bar} ${y - 10} V${y + 10}`;
    d += ' ' + stub(anode, base, y);
    if (cath) d += ' ' + stub(cath, bar, y);
    if (sym.kind === 'Z') {
      const back = pointingRight ? -4 : 4;
      d += ` M${bar} ${y - 10} l${back} -3 M${bar} ${y + 10} l${-back} 3`;
    }
    if (sym.kind === 'LED') {
      const col = sym.led || '#ff2a2a';
      d += ` M${tip - 2} ${y - 16} l8 -8 M${tip - 6} ${y - 12} l8 -8 M${tip + 4} ${y - 22} l-3 1 m3 -1 l-1 3 M${tip} ${y - 18} l-3 1 m3 -1 l-1 3`;
      return `<path d="${d}" class="sch-stroke" stroke="${col}"/>`;
    }
    return `<path d="${d}" class="sch-stroke"/>`;
  }
  function drawBjt(sym) {
    const B = sym.terms.find((t) => t.name === 'B') || sym.terms[0];
    const C = sym.terms.find((t) => t.name === 'C') || sym.terms[1];
    const E = sym.terms.find((t) => t.name === 'E') || sym.terms[2];
    const bx = B.dir === 'l' ? sym.x + 28 : sym.x + sym.w - 28;
    const cy = B.y;
    const pnp = sym.kind === 'PNP';
    let d = `M${B.x} ${B.y} H${bx} M${bx} ${cy - 16} V${cy + 16}`;
    d += ` M${bx} ${cy - 8} L${C.x} ${C.y} M${C.x} ${C.y} V${Math.min(C.y + 18, cy - 8)}`;
    d += ` M${bx} ${cy + 8} L${E.x} ${E.y}`;
    // arrow on emitter
    const ax = (bx + E.x) / 2, ay = (cy + 8 + E.y) / 2;
    if (!pnp) d += ` M${ax - 4} ${ay - 7} L${ax + 2} ${ay} L${ax - 6} ${ay + 3}`;
    else d += ` M${ax + 3} ${ay + 6} L${ax - 3} ${ay - 1} L${ax + 5} ${ay - 4}`;
    d += ` M${sym.x + sym.w / 2} ${sym.y + 18} a22 22 0 1 1 0.1 0`;
    return `<path d="${d}" class="sch-stroke"/>`;
  }
  function drawMos(sym) {
    const G = sym.terms.find((t) => t.name === 'G') || sym.terms[0];
    const Dd = sym.terms.find((t) => t.name === 'D') || sym.terms[1];
    const S = sym.terms.find((t) => t.name === 'S') || sym.terms[2];
    const gx = G.dir === 'l' ? sym.x + 26 : sym.x + sym.w - 26;
    const gy = G.y;
    let d = `M${G.x} ${G.y} H${gx - 8} M${gx - 8} ${gy - 16} V${gy + 16}`;
    d += ` M${gx} ${gy - 14} V${gy - 4} M${gx} ${gy - 4} V${gy + 6} M${gx} ${gy + 6} V${gy + 16}`;
    d += ` M${gx} ${gy - 10} H${gx + 16} V${Dd.y} H${Dd.x}`;
    d += ` M${gx} ${gy + 12} H${gx + 16} V${S.y} H${S.x}`;
    d += ` M${gx + 8} ${gy + 4} l0 8 l6 -4 z`;
    return `<path d="${d}" class="sch-stroke"/>`;
  }
  function drawPt(sym) {
    return drawDiode(Object.assign({}, sym, { kind: 'LED', terms: [{ name: 'A', x: sym.terms[0].x, y: sym.terms[0].y }, sym.terms[1] || sym.terms[0]] }));
  }
  function drawSw(sym) {
    if (sym.kind === 'SW3') {
      const c = sym.terms.find((t) => t.name === '2') || sym.terms[0];
      const a = sym.terms.find((t) => t.name === '1') || sym.terms[1];
      const b = sym.terms.find((t) => t.name === '3') || sym.terms[2];
      const d = `M${c.x} ${c.y} H${c.x + 16} M${a.x} ${a.y} H${a.x - 14} M${b.x} ${b.y} H${b.x - 14} M${c.x + 16} ${c.y} L${a.x - 16} ${a.y + 2}`;
      return `<path d="${d}" class="sch-stroke"/><circle class="sch-dot" cx="${c.x + 16}" cy="${c.y}" r="2"/><circle class="sch-dot" cx="${a.x - 14}" cy="${a.y}" r="2"/><circle class="sch-dot" cx="${b.x - 14}" cy="${b.y}" r="2"/>`;
    }
    const [a, b] = horizPins(sym);
    const y = a.y;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const d = `M${x0} ${y} H${x0 + 16} M${x1} ${y} H${x1 - 16} M${x0 + 16} ${y} L${x1 - 20} ${y - 12}`;
    return `<path d="${d}" class="sch-stroke"/><circle class="sch-dot" cx="${x0 + 16}" cy="${y}" r="2.1"/><circle class="sch-dot" cx="${x1 - 16}" cy="${y}" r="2.1"/>`;
  }
  function drawPot(sym) {
    const zig = draw2pinZig(Object.assign({}, sym, { kind: 'R', terms: sym.terms.filter((t) => t.name !== 'W') }), 'R');
    const w = sym.terms.find((t) => t.name === 'W');
    let arrow = '';
    if (w) arrow = `<path d="M${w.x} ${w.y} V${w.y + 16} M${w.x - 4} ${w.y + 12} L${w.x} ${w.y + 18} L${w.x + 4} ${w.y + 12}" class="sch-stroke"/>`;
    return zig + arrow;
  }
  function drawGndPart(sym) {
    const t = sym.terms[0];
    const px = t.x, py = t.y;
    return `<path d="M${px} ${py} V${py + 8} M${px - 12} ${py + 8} H${px + 12} M${px - 8} ${py + 14} H${px + 8} M${px - 4} ${py + 20} H${px + 4}" class="sch-stroke sch-gnd"/>`;
  }
  function drawBat(sym) {
    const plus = sym.terms.find((t) => t.name === '+') || sym.terms[0];
    const minus = sym.terms.find((t) => t.name === '-' || t.name === 'GND') || sym.terms[1];
    const y = plus.y, x = plus.dir === 'r' ? plus.x - 22 : plus.x + 22;
    let d = `M${plus.x} ${plus.y} H${x} M${x} ${y - 12} V${y + 12} M${x + (plus.dir === 'r' ? -8 : 8)} ${y - 7} V${y + 7}`;
    if (minus) d += ` M${minus.x} ${minus.y} V${y} H${x + (plus.dir === 'r' ? -8 : 8)}`;
    d += ` M${x - 3} ${y - 18} h6 M${x} ${y - 21} v6`;
    return `<path d="${d}" class="sch-stroke"/>`;
  }
  function drawSrc(sym) {
    const plus = sym.terms.find((t) => t.name === '+' || t.name === 'VOUT') || sym.terms[0];
    const cx = plus.dir === 'r' ? plus.x - 26 : plus.x + 26, cy = plus.y;
    let d = `M${plus.x} ${plus.y} H${cx + (plus.dir === 'r' ? 14 : -14)} M${cx - 14} ${cy} a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0`;
    const minus = sym.terms.find((t) => t !== plus);
    if (minus) d += ' ' + stub(minus, cx, cy + (minus.dir === 'b' ? 14 : minus.dir === 't' ? -14 : 0));
    return `<path d="${d}" class="sch-stroke"/><text class="sch-title" data-kind="title" data-natural="11" data-full="${esc(sym.value || sym.title)}" x="${cx}" y="${cy + 4}">${esc(sym.value || sym.title)}</text>`;
  }
  function drawMeter(sym) {
    const cy = axisY(sym), cx = sym.x + sym.w / 2;
    const mode = sym.value || 'V';
    const pins = sym.terms.slice().sort((a, b) => a.x - b.x);
    let d = `M${cx - 16} ${cy} a16 16 0 1 0 32 0 a16 16 0 1 0 -32 0`;
    pins.forEach((t, i) => { d += ' ' + stub(t, i === 0 ? cx - 16 : cx + 16, cy); });
    return `<path d="${d}" class="sch-stroke"/><text class="sch-title" data-kind="title" data-natural="11" data-full="${esc(mode)}" x="${cx}" y="${cy + 4}">${esc(mode)}</text>`;
  }
  function drawXtal(sym) {
    const [a, b] = horizPins(sym);
    const y = a.y, x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), mid = (x0 + x1) / 2;
    return `<path d="M${x0} ${y} H${x1} M${mid - 10} ${y - 8} H${mid + 10} V${y + 8} H${mid - 10} Z M${mid - 16} ${y - 12} V${y + 12} M${mid + 16} ${y - 12} V${y + 12}" class="sch-stroke"/>`;
  }
  function drawCircleDev(sym) {
    const [a, b] = horizPins(sym);
    const cx = (Math.min(a.x, b.x) + Math.max(a.x, b.x)) / 2, cy = a.y;
    const letter = sym.kind === 'MOT' ? 'M' : sym.kind === 'LAMP' ? '✕' : '';
    let extra = '';
    if (sym.kind === 'SPK') extra = `<path d="M${cx + 6} ${cy - 10} q10 10 0 20 M${cx + 10} ${cy - 14} q14 14 0 28" class="sch-stroke"/>`;
    return `<path d="M${a.x} ${a.y} H${cx - 14} M${b.x} ${b.y} H${cx + 14} M${cx - 14} ${cy} a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0" class="sch-stroke"/>${letter ? `<text class="sch-title" data-kind="title" data-natural="11" data-full="${esc(letter)}" x="${cx}" y="${cy + 4}">${letter}</text>` : ''}${extra}`;
  }
  function drawBox(sym) {
    const notch = sym.kind === 'DIP' ? `<circle class="sch-dot" cx="${sym.x + 8}" cy="${sym.y + 8}" r="2.4"/>` : '';
    const title = sym.titlePos || { x: sym.x + sym.w / 2, y: sym.y + 13, text: sym.kind === 'ESP' ? 'ESP32' : sym.title };
    const titleText = title.text || (sym.kind === 'ESP' ? 'ESP32' : sym.title);
    return `<rect class="sch-body" x="${sym.x}" y="${sym.y}" width="${sym.w}" height="${sym.h}" rx="3"/>${notch}<text class="sch-title" data-kind="title" data-natural="11" data-full="${esc(titleText)}" x="${title.x}" y="${title.y}">${esc(titleText)}</text>`;
  }


  // On-screen size of a part name or value. Counter-scale when a fit would
  // draw it under 11px. Zooming in does not grow it past the natural size.
  function labelScreenTarget(natural, zoom) {
    const n = natural > 0 && isFinite(natural) ? natural : READABLE_PX;
    const z = zoom > 0 && isFinite(zoom) ? zoom : 1;
    const grown = n * z;
    if (z >= 1) return Math.max(READABLE_PX, Math.min(n, grown));
    return Math.max(READABLE_PX, grown);
  }
  // 'R1 220Ω' instead of a long name, when the full labels would collide.
  function shortPartLabel(ref, value, title) {
    const r = String(ref || '').trim();
    const v = String(value || '').trim();
    if (r && v) return r + ' ' + v;
    return r || v || String(title || '').trim();
  }
  function labelScaleOf(svg, fallback) {
    try {
      const m = svg && svg.getScreenCTM && svg.getScreenCTM();
      if (m) {
        const s = Math.hypot(m.a, m.b);
        if (s > 0.02 && isFinite(s)) return s;
      }
    } catch (e) { /* use the view zoom */ }
    return fallback > 0.02 && isFinite(fallback) ? fallback : 1;
  }
  function screenBox(el, pad) {
    if (!el || !el.getBoundingClientRect) return null;
    if (el.style && el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    const p = pad > 0 ? pad / 2 : 0;
    const x = r.left - p, y = r.top - p, x2 = r.right + p, y2 = r.bottom + p;
    if (x2 - x < 0.5 || y2 - y < 0.5) return null;
    return { x: x, y: y, x2: x2, y2: y2 };
  }
  // Estimated glyph box. A stroked wire's getBoundingClientRect is flat, so the
  // search cannot measure it on every nudge without laying the sheet out again.
  function textScreenBox(el, ctm, scale) {
    if (!el || (el.style && el.style.display === 'none')) return null;
    const text = el.textContent || '';
    if (!String(text).trim() || !ctm) return null;
    const font = parseFloat(el.style.fontSize) || 12;
    const x = +el.getAttribute('x') || 0;
    const y = +el.getAttribute('y') || 0;
    const px = ctm.a * x + ctm.c * y + ctm.e;
    const py = ctm.b * x + ctm.d * y + ctm.f;
    const chars = Array.from(text).length;
    const sw = font * scale * (0.7 * chars + 0.8);
    const left = px - sw / 2 - 1;
    const top = py - font * scale * 1.1 - 1;
    return { x: left, y: top, x2: left + sw + 2, y2: top + font * scale * 1.35 + 2 };
  }
  function boxesOverlap(a, b) {
    return !!a && !!b && Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 0.5;
  }
  function hitsAny(box, list) {
    if (!box) return false;
    for (let i = 0; i < list.length; i++) if (boxesOverlap(box, list[i])) return true;
    return false;
  }
  function partLabelNodes(sym) {
    return [...sym.querySelectorAll('.sch-ref, .sch-val, .sch-title')];
  }
  function preparePartLabel(el, scale) {
    const natural = +el.dataset.natural || (el.classList.contains('sch-ref') ? 12 : 11);
    if (!el.dataset.full) el.dataset.full = el.textContent || '';
    if (!el.dataset.ax) el.dataset.ax = el.getAttribute('x') || '0';
    if (!el.dataset.ay) el.dataset.ay = el.getAttribute('y') || '0';
    el.style.display = '';
    el.textContent = el.dataset.full;
    el.setAttribute('x', el.dataset.ax);
    el.setAttribute('y', el.dataset.ay);
    // A hair over the floor so font × CTM does not round down to 10.999.
    const screen = Math.max(labelScreenTarget(natural, scale), 11.25);
    el.style.fontSize = (screen / scale) + 'px';
  }
  function rememberLabel(el) {
    el.dataset.restText = el.textContent || '';
    el.dataset.restDisplay = el.style.display || '';
    el.dataset.restX = el.getAttribute('x') || '';
    el.dataset.restY = el.getAttribute('y') || '';
  }
  // Part names and values stay at least 11 screen px. Where the full wording
  // would cover another label, a pin, or a wire, use the short form. If that
  // still does not fit, hide it; hover, focus, and tap bring the full text back.
  function settlePartLabels(svg, fallbackZoom) {
    if (!svg || !svg.querySelectorAll || typeof document === 'undefined') return;
    const host = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    if (host && host.width < 2) return;
    const scale = labelScaleOf(svg, fallbackZoom);
    const labels = [...svg.querySelectorAll('.sch-ref, .sch-val, .sch-title')];
    if (!labels.length) return;
    for (const el of labels) preparePartLabel(el, scale);
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
    const thick = Math.max(1.55 * scale, 1);
    const obstacles = [];
    svg.querySelectorAll('.sch-pin').forEach((el) => {
      const b = screenBox(el, 0);
      if (b) obstacles.push(b);
    });
    svg.querySelectorAll('.sch-wire').forEach((el) => {
      const b = screenBox(el, thick);
      if (b) obstacles.push(b);
    });
    const placed = [];
    const syms = [...svg.querySelectorAll('.sch-sym')].sort((a, b) => String(a.dataset.pid || '').localeCompare(String(b.dataset.pid || '')));
    const shifts = [[0, 0]];
    for (const ring of [16, 32, 48]) {
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        shifts.push([Math.round(Math.cos(a) * ring), Math.round(Math.sin(a) * ring)]);
      }
    }
    function boxesOf(list) {
      return list.map((el) => textScreenBox(el, ctm, scale));
    }
    function blocked(list) {
      const boxes = boxesOf(list);
      if (boxes.some((b) => !b || hitsAny(b, obstacles) || hitsAny(b, placed))) return true;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        if (boxesOverlap(boxes[i], boxes[j])) return true;
      }
      return false;
    }
    function shiftEl(el, dx, dy) {
      el.setAttribute('x', String(Math.round((+el.dataset.ax + dx / scale) * 10) / 10));
      el.setAttribute('y', String(Math.round((+el.dataset.ay + dy / scale) * 10) / 10));
    }
    for (const sym of syms) {
      const mine = partLabelNodes(sym);
      const ref = sym.querySelector('.sch-ref');
      const val = sym.querySelector('.sch-val');
      const title = sym.querySelector('.sch-title');
      const full = [ref, val, title].map((el) => el && el.dataset.full).filter(Boolean);
      const name = [];
      for (const t of full) if (name.indexOf(t) < 0) name.push(t);
      sym.setAttribute('role', 'group');
      sym.setAttribute('aria-label', name.join(' ') || sym.dataset.pid || 'part');
      let hidden = false;
      let mode = 'full';
      if (mine.length && blocked(mine)) {
        const hostEl = ref || title || val;
        const others = mine.filter((el) => el !== hostEl);
        for (const el of others) el.style.display = 'none';
        if (hostEl) {
          hostEl.style.display = '';
          hostEl.textContent = shortPartLabel(ref && ref.dataset.full, val && val.dataset.full, title && title.dataset.full);
          let fitted = false;
          for (const [dx, dy] of shifts) {
            shiftEl(hostEl, dx, dy);
            if (!blocked([hostEl])) { fitted = true; break; }
          }
          if (!fitted) {
            hostEl.style.display = 'none';
            hidden = true;
            mode = 'hide';
          } else mode = 'short';
        } else hidden = true;
      }
      // The search uses an inflated estimate. Measure once, and hide anything
      // that still sits on a pin, a wire, or a label already placed.
      const kept = [];
      for (const el of mine) {
        if (el.style.display === 'none') continue;
        const b = screenBox(el, 0);
        if (!b || hitsAny(b, obstacles) || hitsAny(b, placed) || hitsAny(b, kept)) el.style.display = 'none';
        else kept.push(b);
      }
      const anyVisible = mine.some((el) => el.style.display !== 'none');
      const concealed = mine.some((el) => el.style.display === 'none');
      if (mine.length && !anyVisible) { hidden = true; mode = 'hide'; }
      else if (concealed && mode === 'full') mode = 'short';
      sym.dataset.labHidden = hidden ? '1' : '0';
      sym.dataset.labShort = mode === 'short' ? '1' : '0';
      sym.tabIndex = hidden ? 0 : -1;
      for (const el of mine) rememberLabel(el);
      for (const el of mine) {
        const b = screenBox(el, 0);
        if (b) placed.push(b);
      }
    }
  }
  // The framing fit can leave a symbol on the hint or the toolbar when that
  // control is not a full-width bar. Slide the sheet, same zoom, until every
  // part is on the open canvas.
  function seatOffChrome(view, model, svg) {
    if (!view || !model || !svg || typeof document === 'undefined' || !svg.getBoundingClientRect) return view;
    const host = svg.getBoundingClientRect();
    if (host.width < 2) return view;
    const blocks = [];
    for (const sel of ['header#top', '.projbanner', '.hint', '.canvas-tools', '.zoom-tools']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let cs; try { cs = root.getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      blocks.push({ x: r.left, y: r.top, x2: r.right, y2: r.bottom });
    }
    if (!blocks.length) return view;
    const syms = model.symbols || [];
    const vw = root.innerWidth || host.right;
    const vh = root.innerHeight || host.bottom;
    const bad = (x, y) => {
      const s = view.s;
      for (let i = 0; i < syms.length; i++) {
        const sym = syms[i];
        const x1 = host.left + (sym.x - x) * s;
        const y1 = host.top + (sym.y - y) * s;
        const body = { x: x1, y: y1, x2: x1 + sym.w * s, y2: y1 + sym.h * s };
        if (body.x < -1 || body.y < -1 || body.x2 > vw + 1 || body.y2 > vh + 1) return true;
        for (let k = 0; k < blocks.length; k++) {
          const b = blocks[k];
          if (Math.min(body.x2, b.x2) - Math.max(body.x, b.x) > 1 && Math.min(body.y2, b.y2) - Math.max(body.y, b.y) > 1) return true;
        }
      }
      return false;
    };
    if (!bad(view.x, view.y)) return view;
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let dist = 4; dist <= 80; dist += 4) {
      for (let d = 0; d < dirs.length; d++) {
        const x = view.x - (dirs[d][0] * dist) / view.s;
        const y = view.y - (dirs[d][1] * dist) / view.s;
        if (!bad(x, y)) return { s: view.s, x: x, y: y };
      }
    }
    return view;
  }
  // Screen px a part, its label, or a power mark sits outside the canvas
  // margin or inside an overlay's margin. Zero means the open view fits.
  function safeSlack(svg) {
    if (!svg || !svg.getBoundingClientRect || typeof document === 'undefined') return 0;
    const stage = svg.getBoundingClientRect();
    if (stage.width < 2 || stage.height < 2) return 0;
    const m = 12;
    const safe = { left: stage.left + m, top: stage.top + m, right: stage.right - m, bottom: stage.bottom - m };
    const blocks = [];
    for (const sel of ['.zoom-tools', '.canvas-tools', '.hint', '.projbanner', 'header#top']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let cs; try { cs = root.getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.right < stage.left + 1 || r.left > stage.right - 1 || r.bottom < stage.top + 1 || r.top > stage.bottom - 1) continue;
      blocks.push({ left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m });
    }
    let past = 0;
    svg.querySelectorAll('.sch-hit, .sch-ref, .sch-val, .sch-title, .sch-flag, .sch-netlbl, .sch-gnd, .sch-rail').forEach((el) => {
      let cs; try { cs = root.getComputedStyle(el); } catch (e) { return; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width < 0.4 && r.height < 0.4) return;
      past = Math.max(past, safe.left - r.left, r.right - safe.right, safe.top - r.top, r.bottom - safe.bottom);
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
        const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
        if (ix > 0 && iy > 0) past = Math.max(past, Math.min(ix, iy));
      }
    });
    return past;
  }

  class SchematicView {
    constructor(host, hooks) {
      this.hooks = hooks || {};
      this.host = host;
      this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svg.id = 'stageSch';
      this.svg.setAttribute('class', 'stage-sch');
      this.svg.setAttribute('aria-label', 'Electronic schematic, view only');
      host.appendChild(this.svg);
      this.view = { x: 0, y: 0, s: 1 };
      this.active = false;
      this.sel = null;
      this.proj = null;
      this.model = null;
      this._sig = '';
      this._mode = 'tidy';
      this._queued = false;
      this._fitQueued = false;
      this._mountLayout();
      this._mountFit();
      this._bind();
    }
    _layoutSig() {
      return signature(this.proj || { parts: [], wires: [] }) + '|' + (this._useMatch() ? 'board' : 'tidy');
    }
    _useMatch() { return matchFlagOn() && this._mode !== 'tidy'; }
    setProject(proj) {
      this.proj = proj;
      this._mode = layoutModeOf(proj);
      this._sig = '';
      this._syncLayout();
      if (this.active) this.rebuild(true);
    }
    setActive(on) {
      this.active = !!on;
      this.svg.classList.toggle('on', this.active);
      document.body.classList.toggle('viewsch', this.active);
      const hint = this.host.querySelector('.hint');
      if (hint) {
        if (this.active) {
          if (!this._hint0) this._hint0 = hint.textContent;
          hint.textContent = root.Pinch.schematicHint();
        } else if (this._hint0) hint.textContent = this._hint0;
      }
      this._syncLayout();
      if (!this.active) { this._syncFitAll(false); this._syncNotice(); }
      if (this.active) this.rebuild(true);
    }
    invalidate() { this._sig = ''; if (this.active) this._queue(false); }
    /** Re-layout only when the project actually changed (selection and glow stay put). */
    touch() {
      if (!this.active || !this.proj) return;
      if (this._layoutSig() !== this._sig) this._queue(false);
    }
    // One layout per frame. A drag in 2D keeps moving the part and must not
    // recompute the sheet on every pointer move.
    _queue(fit) {
      this._fitQueued = !!this._fitQueued || !!fit;
      if (this._queued) return;
      this._queued = true;
      const fire = () => {
        this._queued = false;
        const fitNow = !!this._fitQueued;
        this._fitQueued = false;
        if (!this.active) return;
        if (editorDragging()) { this._queue(fitNow); return; }
        this.rebuild(fitNow);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire);
      else setTimeout(fire, 16);
    }
    rebuild(fit) {
      if (!this.proj) return;
      const sig = this._layoutSig();
      if (sig === this._sig && this.model) { if (fit) { this.paint(); this.fit(); } return; }
      this._sig = sig;
      try { this.model = layout(this.proj, { match: this._useMatch() }); }
      catch (e) { console.error('schematic layout', e); this.model = { symbols: [], rails: [], polys: [], dots: [], labels: [], texts: [], bounds: { x: 0, y: 0, w: 10, h: 10 }, fallback: true }; }
      this.paint();
      this._syncNotice();
      if (fit) { this._fitMode = 'open'; this.fit(); }
    }
    fitAll() {
      this._fitGen = (this._fitGen || 0) + 1;
      this._fitMode = 'all';
      this.fit(0);
    }
    setLayoutMode(mode) {
      if (mode !== 'board' && mode !== 'tidy') return;
      if (!matchFlagOn()) return;
      this._mode = mode;
      writeLayout(this.proj, mode);
      this._syncLayout();
      this._sig = '';
      if (this.active) this.rebuild(true);
    }
    _mountLayout() {
      const tools = document.querySelector('.canvas-tools .view-toggle');
      let bar = document.getElementById('schLayout');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'schLayout';
        bar.className = 'sch-layout';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Schematic arrangement');
        const mk = (id, label, mode, tip) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.id = id;
          b.className = 'sch-lay';
          b.textContent = label;
          b.dataset.mode = mode;
          b.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-label', tip);
          b.title = tip;
          return b;
        };
        bar.appendChild(mk('schLayBoard', 'Breadboard', 'board', 'Like breadboard'));
        bar.appendChild(mk('schLayTidy', 'Tidy', 'tidy', 'Tidy arrangement'));
        if (tools) tools.insertAdjacentElement('afterend', bar);
        else if (this.host) this.host.appendChild(bar);
      }
      if (!bar._schBound) {
        bar._schBound = true;
        bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.setLayoutMode(b.dataset.mode)));
        bar.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          const buttons = [...bar.querySelectorAll('button:not(:disabled)')];
          if (!buttons.length) return;
          e.preventDefault();
          const i = Math.max(0, buttons.indexOf(document.activeElement));
          const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
          const next = buttons[(i + step + buttons.length) % buttons.length];
          next.focus();
          this.setLayoutMode(next.dataset.mode);
        });
      }
      bar.hidden = true;
      this._bar = bar;
      this._syncLayout();
    }
    _mountFit() {
      let b = document.getElementById('schFitAll');
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.id = 'schFitAll';
        b.className = 'sch-fitall';
        b.textContent = 'Fit all';
      }
      const zoom = document.querySelector('.zoom-tools');
      if (zoom && b.parentElement !== zoom) {
        const anchor = document.getElementById('bZoomIn');
        if (anchor && anchor.parentElement === zoom) anchor.insertAdjacentElement('afterend', b);
        else zoom.appendChild(b);
      }
      if (!b._schBound) {
        b._schBound = true;
        b.addEventListener('click', () => this.fitAll());
      }
      b.hidden = true;
      this._fitAll = b;
    }
    _syncFitAll(show) {
      const b = this._fitAll;
      if (!b) return;
      const on = !!show && !!this.active;
      b.hidden = !on;
      b.disabled = !on;
      b.tabIndex = on ? 0 : -1;
    }
    _syncLayout() {
      const bar = this._bar;
      if (!bar) return;
      const show = !!this.active && matchFlagOn();
      bar.hidden = !show;
      bar.setAttribute('aria-hidden', show ? 'false' : 'true');
      const ui3 = document.documentElement.getAttribute('data-ui') === '3';
      const short = ui3 ? { board: 'Board', tidy: 'Tidy' } : { board: 'Breadboard', tidy: 'Tidy' };
      const tip = ui3 ? { board: 'Board', tidy: 'Tidy' } : { board: 'Like breadboard', tidy: 'Tidy arrangement' };
      for (const b of bar.querySelectorAll('button')) {
        const mode = b.dataset.mode === 'tidy' ? 'tidy' : 'board';
        const on = mode === (this._mode === 'tidy' ? 'tidy' : 'board');
        if (short[mode]) b.textContent = short[mode];
        if (tip[mode]) { b.setAttribute('aria-label', tip[mode]); b.title = tip[mode]; }
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.disabled = !show;
        b.tabIndex = show ? 0 : -1;
      }
    }
    paint() {
      if (!this.model) return;
      this.svg.innerHTML = `<g id="schRoot">${toSvg(this.model, this.sel)}</g>`;
      this._labelZoom = 0;
      this.apply();
    }
    apply() {
      const r = this.svg.getBoundingClientRect();
      const w = r.width || 800, h = r.height || 600;
      this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${w / this.view.s} ${h / this.view.s}`);
      const z = document.getElementById('zoomPct');
      if (z && this.active) z.textContent = Math.round(this.view.s * 100) + '%';
      // Pan keeps label spacing. Only a new zoom (or a fresh paint) refits them.
      const scale = labelScaleOf(this.svg, this.view.s);
      if (this._labelZoom !== scale) {
        this._labelZoom = scale;
        settlePartLabels(this.svg, this.view.s);
      }
      // Pinch, wheel, keys and double-tap all land here. Fit all follows every one of them.
      if (!this._fitting && this._safeS) this._syncFitAll(this.view.s > this._safeS + 0.02);
    }
    _syncNotice() {
      let n = document.getElementById('schNotice');
      if (!n && this.host) {
        n = document.createElement('p');
        n.id = 'schNotice';
        n.hidden = true;
        n.style.cssText = 'position:absolute;left:12px;top:8px;z-index:6;margin:0;padding:4px 10px;border-radius:8px;background:color-mix(in srgb,var(--l1) 92%,transparent);color:var(--txt2);font-size:12.5px;line-height:1.3;pointer-events:none;border:1px solid var(--line)';
        this.host.appendChild(n);
      }
      if (!n) return;
      const text = this.active && this.model && this.model.notice ? this.model.notice : '';
      n.textContent = text;
      n.hidden = !text;
    }
    _reveal(sym, on) {
      if (!sym) return;
      sym.querySelectorAll('.sch-ref, .sch-val, .sch-title').forEach((el) => {
        if (on) {
          el.style.display = '';
          el.textContent = el.dataset.full || el.textContent;
          if (el.dataset.ax) el.setAttribute('x', el.dataset.ax);
          if (el.dataset.ay) el.setAttribute('y', el.dataset.ay);
        } else {
          el.style.display = el.dataset.restDisplay || '';
          if (el.dataset.restText != null) el.textContent = el.dataset.restText;
          if (el.dataset.restX) el.setAttribute('x', el.dataset.restX);
          if (el.dataset.restY) el.setAttribute('y', el.dataset.restY);
        }
      });
    }
    fit(attempt) {
      if (!this.model) return;
      this._fitting = true;
      const n = attempt || 0;
      const b = this.model.bounds, r = this.svg.getBoundingClientRect();
      // Opening the view toggles display in the same turn. The first box can
      // still be the hidden size, which left the sheet at the breadboard zoom.
      if ((r.width < 2 || r.height < 2) && n < 8 && typeof requestAnimationFrame === 'function') {
        const gen = this._fitGen;
        this._fitting = false;
        requestAnimationFrame(() => { if (this.active && this._fitGen === gen) this.fit(n + 1); });
        return;
      }
      if (r.width < 2 || r.height < 2) { this._fitting = false; return; }
      // Largest zoom whose parts and labels sit in the canvas, 12px clear of
      // the zoom panel, the toolbar, and the hint, and 12px clear of the edges.
      const frame = root.Pinch.frameOf(this.svg);
      const limits = { min: 0.12, max: 2.4 };
      const box = b;
      const margin = 12;
      const stage = frame.stage;
      const inset = {
        left: stage.left + margin, top: stage.top + margin,
        right: stage.right - margin, bottom: stage.bottom - margin,
        width: Math.max(1, stage.width - 2 * margin), height: Math.max(1, stage.height - 2 * margin),
      };
      const blockers = frame.blockers.slice();
      const banner = document.querySelector('.projbanner');
      if (banner) {
        let cs; try { cs = root.getComputedStyle(banner); } catch (e) { cs = null; }
        if (cs && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0) {
          const br = banner.getBoundingClientRect();
          if (br.width > 8 && br.height > 8) blockers.push({ left: br.left, top: br.top, right: br.right, bottom: br.bottom });
        }
      }
      // A tall gap can frame the symbol boxes and still clip the 11px labels.
      // Try the roomiest holes and keep the largest zoom that actually clears.
      const pool = [];
      const seen = new Set();
      const legacy = root.Pinch.clearRect(inset, blockers, margin);
      for (const rect of [legacy].concat(root.Pinch.emptyRects(inset, blockers, margin))) {
        if (!rect || rect.width < 40 || rect.height < 40) continue;
        const key = [rect.left, rect.top, rect.right, rect.bottom].map((n) => Math.round(n)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const raw = root.Pinch.rawScale(box, rect, 0);
        if (raw > 0) pool.push({ rect: rect, raw: raw });
      }
      pool.sort((a, b) => b.raw - a.raw);
      const place = (rect, scale) => {
        const next = viewAt(box, scale, stage, rect);
        this.view.s = next.s; this.view.x = next.x; this.view.y = next.y;
        this._labelZoom = 0;
        this.apply();
        return safeSlack(this.svg) <= 0.5;
      };
      let bestS = 0;
      let bestRect = pool.length ? pool[0].rect : inset;
      for (const c of pool.slice(0, 6)) {
        const hi0 = Math.max(limits.min, Math.min(limits.max, c.raw));
        if (hi0 <= bestS + 0.004) continue;
        if (place(c.rect, hi0)) { bestS = hi0; bestRect = c.rect; continue; }
        let lo = bestS, hi = hi0, win = 0;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          if (mid <= bestS + 0.003) break;
          if (place(c.rect, mid)) { win = mid; lo = mid; }
          else hi = mid;
        }
        if (win > bestS) { bestS = win; bestRect = c.rect; }
      }
      if (!(bestS > 0)) place(bestRect, limits.min);
      else place(bestRect, bestS);
      this._safeS = this.view.s;
      this._wantFitAll = safeSlack(this.svg) > 1;
      this._fitting = false;
      this._syncFitAll(this._wantFitAll);
      if (n === 0 && typeof requestAnimationFrame === 'function') {
        this._fitGen = (this._fitGen || 0) + 1;
        const gen = this._fitGen;
        requestAnimationFrame(() => { if (this.active && this._fitGen === gen) this.fit(1); });
      }
    }
    zoomBy(f, client) {
      this._fitGen = (this._fitGen || 0) + 1;
      const frame = root.Pinch.frameOf(this.svg);
      const limits = { min: 0.12, max: 2.4 };
      const clear = this.model ? root.Pinch.resolveClear(frame, this.model.bounds, 14, limits) : frame.clear;
      const anchor = client || { x: (clear.left + clear.right) / 2, y: (clear.top + clear.bottom) / 2 };
      const v = root.Pinch.zoomAbout(this.view, f, anchor, frame.stage, { min: 0.12, max: 4 });
      this.view.x = v.x; this.view.y = v.y; this.view.s = v.s;
      this.apply();
      if (this._safeS) this._syncFitAll(this.view.s > this._safeS + 0.02);
    }
    select(id) {
      this.sel = id;
      this.svg.querySelectorAll('.sch-sym').forEach((g) => g.classList.toggle('sel', g.dataset.pid === id));
      if (this.hooks.select) this.hooks.select(id);
    }
    sync() {
      if (!this.active || !this.model || !this.hooks.state) return;
      for (const sym of this.model.symbols) {
        if (!sym.led) continue;
        const el = this.svg.querySelector(`[data-glow="${CSS.escape(sym.id)}"]`);
        const st = this.hooks.state(sym.part);
        if (el && st) el.setAttribute('opacity', String(Math.max(0, Math.min(0.85, st.bright || 0)) * 0.9));
      }
    }
    _bind() {
      const svg = this.svg;
      // Bumped when a second finger arrives so the first finger's pan/select session
      // cannot apply a stale delta or select the symbol on the way up.
      let gesture = 0;
      // Phone pinches are owned by mobile.js, including a finger on the selection
      // toolbar. This only drops the one-finger pan/select session that already started.
      this.cancelTouch = () => { gesture += 1; this._pinchLock = true; };
      svg.addEventListener('pointerdown', (e) => {
        this._fitGen = (this._fitGen || 0) + 1;
        if (e.button != null && e.button !== 0) return;
        if (this._pinchLock) { e.preventDefault(); return; }
        const token = gesture;
        const pid = e.target.closest && e.target.closest('[data-pid]');
        const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, pid: pid && pid.dataset.pid, drag: false };
        svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
        const move = (ev) => {
          if (token !== gesture || this._pinchLock) return;
          const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
          if (Math.hypot(dx, dy) > 4) start.drag = true;
          if (!start.pid || start.drag) { this.view.x = start.vx - dx / this.view.s; this.view.y = start.vy - dy / this.view.s; this.apply(); }
        };
        const up = (ev) => {
          svg.removeEventListener('pointermove', move);
          svg.removeEventListener('pointerup', up);
          if (token !== gesture || this._pinchLock) return;
          if (start.pid && !start.drag) this.select(start.pid);
          else if (!start.drag && !start.pid) this.select(null);
          this._tip(ev);
        };
        svg.addEventListener('pointermove', move);
        svg.addEventListener('pointerup', up);
      });
      svg.addEventListener('pointermove', (e) => this._tip(e));
      svg.addEventListener('pointerleave', () => { const tip = document.getElementById('tip'); if (tip) tip.hidden = true; });
      const symOf = (e) => e.target && e.target.closest && e.target.closest('.sch-sym');
      svg.addEventListener('pointerover', (e) => { const sym = symOf(e); if (sym && (sym.dataset.labHidden === '1' || sym.dataset.labShort === '1')) this._reveal(sym, true); });
      svg.addEventListener('pointerout', (e) => {
        const sym = symOf(e);
        const next = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.sch-sym');
        if (sym && sym !== next && sym.dataset.labHold !== '1') this._reveal(sym, false);
      });
      svg.addEventListener('focusin', (e) => { const sym = symOf(e); if (sym) this._reveal(sym, true); });
      svg.addEventListener('focusout', (e) => { const sym = symOf(e); if (sym && sym.dataset.labHold !== '1') this._reveal(sym, false); });
      svg.addEventListener('pointerup', (e) => {
        const sym = symOf(e);
        if (!sym || sym.dataset.labHidden !== '1') return;
        sym.dataset.labHold = sym.dataset.labHold === '1' ? '0' : '1';
        this._reveal(sym, sym.dataset.labHold === '1');
      });
      svg.addEventListener('wheel', (e) => {
        if (!this.active) return;
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0012), { x: e.clientX, y: e.clientY });
      }, { passive: false });
      const pts = new Map(); let pinch = null;
      const pair = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
      svg.addEventListener('pointerdown', (e) => {
        if (document.body.classList.contains('m')) return;
        if (e.pointerType !== 'touch') return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size >= 2) {
          gesture += 1; this._pinchLock = true;
          const m = pair(), rect = svg.getBoundingClientRect();
          const w = root.Pinch.worldAt(this.view, m, rect);
          pinch = { dist: Math.max(m.d, 1), s: this.view.s, wx: w.x, wy: w.y };
          e.preventDefault(); e.stopPropagation();
        }
      }, true);
      svg.addEventListener('pointermove', (e) => {
        if (document.body.classList.contains('m')) return;
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pts.size >= 2) {
          e.preventDefault(); e.stopPropagation();
          const m = pair(), rect = svg.getBoundingClientRect();
          const next = root.Pinch.applyView(pinch, m, m.d, rect, { min: 0.12, max: 4 });
          this.view.s = next.s; this.view.x = next.x; this.view.y = next.y; this.apply();
        }
      }, true);
      const end = (e) => {
        if (document.body.classList.contains('m')) return;
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        // Keep the lock until every finger is up so the remaining finger cannot pan or select.
        // The finger's own pointerup still runs and drops its session without selecting,
        // because the session token no longer matches.
        if (pts.size === 0) this._pinchLock = false;
      };
      svg.addEventListener('pointerup', end, true);
      svg.addEventListener('pointercancel', end, true);
      svg.addEventListener('lostpointercapture', end, true);
      let touchPinch = null;
      const touchPair = (list) => {
        const a = list[0], b = list[1];
        return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
      };
      svg.addEventListener('touchstart', (e) => {
        if (document.body.classList.contains('m') || !this.active || !e.touches || e.touches.length < 2) return;
        const m = touchPair(e.touches), rect = svg.getBoundingClientRect();
        const w = root.Pinch.worldAt(this.view, m, rect);
        touchPinch = { dist: Math.max(m.d, 1), s: this.view.s, wx: w.x, wy: w.y };
        e.preventDefault();
      }, { passive: false });
      svg.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches.length >= 2) e.preventDefault();
        if (document.body.classList.contains('m') || !touchPinch || !e.touches || e.touches.length < 2) return;
        const m = touchPair(e.touches), rect = svg.getBoundingClientRect();
        const next = root.Pinch.applyView(touchPinch, m, m.d, rect, { min: 0.12, max: 4 });
        this.view.s = next.s; this.view.x = next.x; this.view.y = next.y;
        this.apply();
      }, { passive: false });
      const touchEnd = (e) => { if (!e.touches || e.touches.length < 2) touchPinch = null; };
      svg.addEventListener('touchend', touchEnd);
      svg.addEventListener('touchcancel', touchEnd);
      window.addEventListener('resize', () => { if (this.active) this.apply(); });
    }
    _tip(ev) {
      const tip = document.getElementById('tip'); if (!tip || !this.active) return;
      const pin = ev.target.closest && ev.target.closest('[data-pin]');
      const sym = ev.target.closest && ev.target.closest('.sch-sym');
      const net = ev.target.closest && ev.target.closest('[data-net]');
      let html = '';
      if (pin && sym) {
        const part = this.proj && this.proj.parts.find((q) => q.id === sym.dataset.pid);
        const name = pin.dataset.pin;
        let v = '';
        if (part && this.hooks.voltage) { try { v = P.fmt(this.hooks.voltage(part, name), 'V'); } catch (e) { v = ''; } }
        const info = part && part.type === 'esp32' && P.T.esp32.info ? P.T.esp32.info(name) : '';
        html = `<b>${esc(part ? part.id : '')}.${esc(name)}</b>${info ? ' · ' + esc(info) : ''}${v ? '<br>' + v : ''}`;
      } else if (sym) {
        const part = this.proj && this.proj.parts.find((q) => q.id === sym.dataset.pid);
        const d = part && P.T[part.type];
        let r = '';
        if (part && this.hooks.readout) { try { r = this.hooks.readout(part) || ''; } catch (e) { r = ''; } }
        html = part ? `<b>${esc(part.id)}</b> ${esc(d ? d.label : part.type)}${r ? '<br>' + esc(r) : ''}<br><span class="muted">Schematic is view-only</span>` : '';
      } else if (net) {
        html = `<b>Net</b> ${esc(net.dataset.name || ('N' + net.dataset.net))}`;
      }
      if (!html) { tip.hidden = true; return; }
      const wr = this.host.getBoundingClientRect();
      tip.innerHTML = html; tip.hidden = false;
      tip.style.left = (ev.clientX - wr.left + 14) + 'px';
      tip.style.top = (ev.clientY - wr.top + 14) + 'px';
    }
  }

  function signature(proj) {
    return JSON.stringify({
      p: (proj.parts || []).map((q) => [q.id, q.type, q.x, q.y, q.rot, q.schFlipX ? 1 : 0, q.schFlipY ? 1 : 0, q.props]),
      w: (proj.wires || []).map((w) => [Math.round(w.a.x), Math.round(w.a.y), Math.round(w.b.x), Math.round(w.b.y)]),
    });
  }

  const api = {
    layout, toSvg, SchematicView, signature, pinNets: pinNetMap,
    separateSymbols, wireJoints, layoutStoreKey, layoutModeOf, storedLayout, writeLayout, carryLayout, migrateDraftLayout, releaseDraft, sweepDrafts, touchOwned, decodeLayout, DRAFT_TTL_MS, DRAFT_HEARTBEAT_MS, screenLabelPx, labelScreenPx, openScale, chooseOpen, openFrame, labelScreenTarget, shortPartLabel, settlePartLabels, READABLE_PX, MIN_LABEL_FONT,
    configureMatch,
  };
  Object.defineProperty(api, 'SCHEMATIC_MATCH_LAYOUT', {
    get() { return matchFlagOn(); },
    set(v) { if (!serverOff) matchFlag = !!v; },
    enumerable: true,
  });
  root.Schematic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
