/* Electronic schematic view (read-only).
 * Same project as the 2D breadboard and the 3D view — nothing here writes parts, wires, or props.
 * When the project carries a netlist, pin connectivity comes from those nets. Otherwise it is the
 * union-find of breadboard strips and wires (breadboard body omitted). Layout then places parts
 * from the MCU / IC / highest-degree part, or from the battery when the circuit is only
 * passives, aligns passives to the pin they talk to, and routes with an orthogonal A*.
 * A supply that feeds a chip or transistor stays a flag once it has 3+ pins. A battery
 * that only feeds discrete branches is drawn as wires, so parallel strings stay visible.
 * GND is a ground symbol, not a long wire.
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

  function layout(proj) {
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
      t.nc = alone;
      t.netName = alone || !m.name ? '' : m.name;
      if (alone || (m.rail === 'flag' && !m.name)) {
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

    // Absolute pins, rails, routes.
    for (const s of symbols) for (const t of s.terms) { t.x = s.x + t.lx; t.y = s.y + t.ly; }
    const rails = [];
    const obstacles = [];
    for (const s of symbols) {
      obstacles.push({ x: s.x - KEEP, y: s.y - KEEP, x2: s.x + s.w + KEEP, y2: s.y + s.h + KEEP, sid: s.id });
      for (const t of s.terms) if (t.rail === 'gnd' || t.rail === 'flag') {
        const g = railGeom(t, s.kind === 'ESP' || s.kind === 'DIP' || s.kind === 'BOX' ? 'mini' : 'full');
        if (!g) continue;
        if (g.kind === 'flag' && rails.some((r) => r.kind === 'flag' && r.name === g.name && Math.abs(r.px - g.px) < 36 && Math.abs(r.py - g.py) < 24)) g.nolabel = true;
        rails.push(g);
        obstacles.push({ x: g.x, y: g.y, x2: g.x2, y2: g.y2, sid: s.id, rail: true });
      }
    }
    const routed = routeNets(symbols, netTerms, meta, obstacles);
    const dots = junctions(routed.polys, symbols);
    const labels = wireLabels(routed.polys, netTerms, meta);
    const texts = placeTexts(symbols, rails, routed.polys, labels);
    const bounds = computeBounds(symbols, rails, routed.polys, labels, texts);
    return { symbols, rails, polys: routed.polys, dots, labels, texts, bounds, fallback: routed.fallback, fallbackWhy: routed.fallbackWhy || [], nets: meta };
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

  function routeNets(symbols, netTerms, meta, obstacles) {
    const pinAt = new Map();
    const endpoints = new Map(); // net -> [{pin, stub}]
    for (const s of symbols) for (const t of s.terms) {
      if (!t.wire) continue;
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
      pinAt.set(t.x + ',' + t.y, t.net);
      pinAt.set(stub.x + ',' + stub.y, t.net);
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
    const ctx = { obstacles, pinAt, used: new Map(), vinfo: new Map(), fallback: false, fallbackWhy: [], board };
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
        if (!path) {
          const why = 'net ' + net + ' ' + pins[0].sid + '.' + pins[0].name + ' → ' + pins[i].sid + '.' + pins[i].name;
          ctx.fallback = true;
          ctx.fallbackWhy.push(why);
          if (typeof console !== 'undefined' && console.warn) console.warn('schematic fallback: ' + why);
          path = orthoFallback(tree[0], goal, ctx.obstacles);
        }
        for (const p of path) tree.push(p);
        branches.push({ path, pin: pins[i] });
      }
      commitPath(ctx, net, [{ x: pins[0].x, y: pins[0].y }, { x: pins[0].sx, y: pins[0].sy }]);
      polys.push({ net, name, pts: simplify([{ x: pins[0].x, y: pins[0].y }, { x: pins[0].sx, y: pins[0].sy }]) });
      for (const b of branches) {
        const pts = simplify([{ x: b.path[0].x, y: b.path[0].y }, ...b.path, { x: b.pin.x, y: b.pin.y }].filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y));
        // path already ends at stub; append pin
        const full = b.path.slice();
        const last = full[full.length - 1];
        if (!last || last.x !== b.pin.sx || last.y !== b.pin.sy) full.push({ x: b.pin.sx, y: b.pin.sy });
        full.push({ x: b.pin.x, y: b.pin.y });
        commitPath(ctx, net, full);
        polys.push({ net, name, pts: simplify(full) });
      }
      void ok;
    }
    return { polys, fallback: ctx.fallback, fallbackWhy: ctx.fallbackWhy };
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
  function orthoFallback(a, b, obstacles) {
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
    for (const path of cands) {
      const clean = path.filter((p, i) => i === 0 || p.x !== path[i - 1].x || p.y !== path[i - 1].y);
      if (!pathHitsObs(clean, obstacles)) return clean;
    }
    return cands[0];
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

  function stepOk(ctx, x, y, nx, ny, di, net, strict, goalK) {
    const horiz = di <= 1;
    const ek = edgeKey(x, y, nx, ny);
    const eu = ctx.used.get(ek);
    if (eu !== undefined && eu !== net) return false;
    const k = nx + ',' + ny;
    const owner = ctx.pinAt.get(k);
    if (owner !== undefined && owner !== net && k !== goalK) return false;
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
    for (const r of ctx.obstacles) if (nx > r.x && nx < r.x2 && ny > r.y && ny < r.y2) return false;
    return true;
  }

  function junctions(polys, symbols) {
    const pins = new Set();
    for (const s of symbols) for (const t of s.terms) pins.add(t.x + ',' + t.y);
    const byNet = new Map();
    for (const pl of polys) {
      if (!byNet.has(pl.net)) byNet.set(pl.net, []);
      const pts = pl.pts;
      for (let i = 1; i < pts.length; i++) {
        let x = pts[i - 1].x, y = pts[i - 1].y, nx = pts[i].x, ny = pts[i].y;
        const horiz = y === ny; const step = horiz ? (nx >= x ? GS : -GS) : (ny >= y ? GS : -GS);
        const n = Math.round(Math.abs(horiz ? nx - x : ny - y) / GS);
        for (let k = 0; k < n; k++) {
          const ax = x, ay = y; if (horiz) x += step; else y += step;
          byNet.get(pl.net).push([ax + ',' + ay, x + ',' + y, horiz ? 'h' : 'v']);
        }
      }
    }
    const dots = [];
    for (const [net, segs] of byNet) {
      const deg = new Map();
      for (const [a, b, axis] of segs) {
        if (!deg.has(a)) deg.set(a, new Set());
        if (!deg.has(b)) deg.set(b, new Set());
        deg.get(a).add(axis + (a < b ? 'o' : 'i'));
        deg.get(b).add(axis + (a < b ? 'i' : 'o'));
      }
      for (const [k, axes] of deg) {
        if (pins.has(k)) continue;
        const [xs, ys] = k.split(',');
        const dx = +xs, dy = +ys;
        if (symbols.some((s) => dx >= s.x && dx <= s.x + s.w && dy >= s.y && dy <= s.y + s.h)) continue;
        // distinct directions: h and v count, plus a T is 3 incident half-edges
        let n = 0; const seen = new Set();
        for (const seg of segs) {
          if (seg[0] === k || seg[1] === k) {
            const id = seg[0] + '>' + seg[1];
            if (seen.has(id)) continue; seen.add(id);
            if (seg[0] === k || seg[1] === k) n++;
          }
        }
        if (n >= 3) dots.push({ x: dx, y: dy, net });
        void axes;
      }
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
      labels.push({ x: mx, y: horiz ? my - 8 : my, name: v.name, net: v.net, anchor: horiz ? 'middle' : 'start' });
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
  function placeTexts(symbols, rails, polys, labels) {
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
      const ref = { kind: 'ref', text: s.ref, size: 12, anchor: 'middle', x: s.x + s.w / 2, y: s.y - 8, move: true };
      items.push(ref); s.refPos = ref;
      if (s.value && s.kind !== 'SRC' && s.kind !== 'MET') {
        const gnd = s.terms.some((t) => t.rail === 'gnd');
        const val = {
          kind: 'val', text: s.value, size: 11, move: true,
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
      const lab = { kind: 'net', text: l.name, size: 10.5, anchor: l.anchor || 'middle', x: l.x, y: l.y, move: true };
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
      let placed = null;
      for (const [dx, dy] of shifts) {
        const box = makeBox(it.text, it.x + dx, it.y + dy, it.size, it.anchor);
        if (!hitAny(box, it)) { placed = box; break; }
      }
      if (!placed) {
        // Last resort: step away until the box is clear, then keep that spot even if the sheet is crowded.
        for (let n = 1; n <= 12 && !placed; n++) {
          const box = makeBox(it.text, it.x + n * 16, it.y - n * 14, it.size, it.anchor);
          if (!hitAny(box, it)) placed = box;
        }
      }
      if (!placed) placed = makeBox(it.text, it.x, it.y - 48, it.size, it.anchor);
      it.x = placed.ax; it.y = placed.ay; it.box = placed;
    }
    for (const l of labels) if (l.labPos) { l.x = l.labPos.x; l.y = l.labPos.y; l.anchor = l.labPos.anchor; }
    return items.filter((it) => it.box).map((it) => Object.assign(it.box, { kind: it.kind, own: it.own || null, text: it.text, pid: it.pid || null }));
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
      s += `<path d="${d}" class="sch-hitnet" data-net="${pl.net}" data-name="${esc(pl.name || '')}"/><path d="${d}" class="sch-wire"/>`;
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
    return `<text class="sch-ref" x="${r.x}" y="${r.y}" style="text-anchor:${r.anchor || 'middle'}">${esc(sym.ref)}</text>` +
      (v && sym.value ? `<text class="sch-val" x="${v.x}" y="${v.y}" style="text-anchor:${v.anchor || 'middle'}">${esc(sym.value)}</text>` : '') +
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
    return `<path d="${d}" class="sch-stroke"/><text class="sch-title" x="${cx}" y="${cy + 4}">${esc(sym.value || sym.title)}</text>`;
  }
  function drawMeter(sym) {
    const cy = axisY(sym), cx = sym.x + sym.w / 2;
    const mode = sym.value || 'V';
    const pins = sym.terms.slice().sort((a, b) => a.x - b.x);
    let d = `M${cx - 16} ${cy} a16 16 0 1 0 32 0 a16 16 0 1 0 -32 0`;
    pins.forEach((t, i) => { d += ' ' + stub(t, i === 0 ? cx - 16 : cx + 16, cy); });
    return `<path d="${d}" class="sch-stroke"/><text class="sch-title" x="${cx}" y="${cy + 4}">${esc(mode)}</text>`;
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
    return `<path d="M${a.x} ${a.y} H${cx - 14} M${b.x} ${b.y} H${cx + 14} M${cx - 14} ${cy} a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0" class="sch-stroke"/>${letter ? `<text class="sch-title" x="${cx}" y="${cy + 4}">${letter}</text>` : ''}${extra}`;
  }
  function drawBox(sym) {
    const notch = sym.kind === 'DIP' ? `<circle class="sch-dot" cx="${sym.x + 8}" cy="${sym.y + 8}" r="2.4"/>` : '';
    const title = sym.titlePos || { x: sym.x + sym.w / 2, y: sym.y + 13, text: sym.kind === 'ESP' ? 'ESP32' : sym.title };
    return `<rect class="sch-body" x="${sym.x}" y="${sym.y}" width="${sym.w}" height="${sym.h}" rx="3"/>${notch}<text class="sch-title" x="${title.x}" y="${title.y}">${esc(title.text || (sym.kind === 'ESP' ? 'ESP32' : sym.title))}</text>`;
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
      this._bind();
    }
    setProject(proj) { this.proj = proj; this._sig = ''; if (this.active) this.rebuild(true); }
    setActive(on) {
      this.active = !!on;
      this.svg.classList.toggle('on', this.active);
      document.body.classList.toggle('viewsch', this.active);
      const hint = this.host.querySelector('.hint');
      if (hint) {
        if (this.active) {
          if (!this._hint0) this._hint0 = hint.textContent;
          hint.textContent = 'Schematic — F mirrors the symbol · Flip H / Flip V in the inspector · drag to pan · scroll to zoom';
        } else if (this._hint0) hint.textContent = this._hint0;
      }
      if (this.active) this.rebuild(true);
    }
    invalidate() { this._sig = ''; if (this.active) this.rebuild(false); }
    /** Re-layout only when the project actually changed (selection and glow stay put). */
    touch() {
      if (!this.active || !this.proj) return;
      if (signature(this.proj) !== this._sig) this.rebuild(false);
    }
    rebuild(fit) {
      if (!this.proj) return;
      const sig = signature(this.proj);
      if (sig === this._sig && this.model) { if (fit) { this.paint(); this.fit(); } return; }
      this._sig = sig;
      try { this.model = layout(this.proj); }
      catch (e) { console.error('schematic layout', e); this.model = { symbols: [], rails: [], polys: [], dots: [], labels: [], bounds: { x: 0, y: 0, w: 10, h: 10 }, fallback: true }; }
      this.paint();
      if (fit) this.fit();
    }
    paint() {
      if (!this.model) return;
      this.svg.innerHTML = `<g id="schRoot">${toSvg(this.model, this.sel)}</g>`;
      this.apply();
    }
    apply() {
      const r = this.svg.getBoundingClientRect();
      const w = r.width || 800, h = r.height || 600;
      this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${w / this.view.s} ${h / this.view.s}`);
      const z = document.getElementById('zoomPct');
      if (z && this.active) z.textContent = Math.round(this.view.s * 100) + '%';
    }
    fit() {
      if (!this.model) return;
      const b = this.model.bounds, r = this.svg.getBoundingClientRect();
      const w = r.width || 800, h = r.height || 600;
      // Leave room for the floating toolbar and the view-only hint along the bottom.
      // The example banner sits over the canvas in screen pixels (~12px offset + ~30px chip).
      // Convert that clearance into world units so fit-to-view never hides the top of the sheet.
      const bannerPx = 58, toolPx = 118, sidePx = 40;
      const s = Math.min(2.4, Math.max(0.12, Math.min((w - sidePx * 2) / Math.max(b.w, 1), (h - bannerPx - toolPx) / Math.max(b.h, 1))));
      this.view.s = s;
      this.view.x = b.x - (w / s - b.w) / 2;
      this.view.y = b.y - bannerPx / s;
      this.apply();
    }
    zoomBy(f, client) {
      const r = this.svg.getBoundingClientRect();
      const cx = client ? client.x : r.left + r.width / 2, cy = client ? client.y : r.top + r.height / 2;
      const wx = this.view.x + (cx - r.left) / this.view.s, wy = this.view.y + (cy - r.top) / this.view.s;
      const s = Math.min(4, Math.max(0.12, this.view.s * f));
      this.view.x = wx - (cx - r.left) / s; this.view.y = wy - (cy - r.top) / s; this.view.s = s;
      this.apply();
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
      svg.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        const pid = e.target.closest && e.target.closest('[data-pid]');
        const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, pid: pid && pid.dataset.pid, drag: false };
        svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
          if (Math.hypot(dx, dy) > 4) start.drag = true;
          if (!start.pid || start.drag) { this.view.x = start.vx - dx / this.view.s; this.view.y = start.vy - dy / this.view.s; this.apply(); }
        };
        const up = (ev) => {
          svg.removeEventListener('pointermove', move);
          svg.removeEventListener('pointerup', up);
          if (start.pid && !start.drag) this.select(start.pid);
          else if (!start.drag && !start.pid) this.select(null);
          this._tip(ev);
        };
        svg.addEventListener('pointermove', move);
        svg.addEventListener('pointerup', up);
      });
      svg.addEventListener('pointermove', (e) => this._tip(e));
      svg.addEventListener('pointerleave', () => { const tip = document.getElementById('tip'); if (tip) tip.hidden = true; });
      svg.addEventListener('wheel', (e) => {
        if (!this.active) return;
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0012), { x: e.clientX, y: e.clientY });
      }, { passive: false });
      const pts = new Map(); let pinch = null;
      svg.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, e); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s: this.view.s }; } }, true);
      svg.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
        if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); this.zoomBy((pinch.s * d / pinch.d) / this.view.s, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }); e.stopPropagation(); }
      }, true);
      const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
      svg.addEventListener('pointerup', end, true); svg.addEventListener('pointercancel', end, true);
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

  const api = { layout, toSvg, SchematicView, signature, pinNets: pinNetMap };
  root.Schematic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
