/* Independent 2D-versus-schematic audit.
 * 2D nets come from part pins, breadboard strips (a–e and f–j of one column),
 * the four power rails, and wire ends that land on a hole or a pin.
 * The schematic side is parsed from the SVG that is actually drawn: pin dots,
 * wire paths, VCC/GND flags (same name is one net), no-connect marks, and labels.
 * It does not call Sim.topology, Netlist, or Schematic.pinNets.
 */
(function (root) {
  // Resolved at call time. The script may be injected before parts.js runs.
  const lib = () => (root && root.Parts) || (typeof globalThis !== 'undefined' ? globalThis.Parts : null);

  class UF {
    constructor() { this.p = new Map(); }
    find(a) {
      let x = this.p.get(a);
      if (x === undefined) { this.p.set(a, a); return a; }
      if (x === a) return a;
      const r = this.find(x); this.p.set(a, r); return r;
    }
    union(a, b) {
      if (a == null || b == null) return;
      const ra = this.find(a), rb = this.find(b);
      if (ra !== rb) this.p.set(ra, rb);
    }
  }
  const xy = (x, y) => Math.round(x) + ',' + Math.round(y);
  const rotPt = (x, y, r) => {
    switch ((r || 0) & 3) {
      case 1: return [-y, x];
      case 2: return [-x, -y];
      case 3: return [y, -x];
      default: return [x, y];
    }
  };

  // Column strips and the four rails, from hole names printed on the board.
  function stripOf(name) {
    const row = /^([a-j])(\d+)$/.exec(name);
    if (row) return (row[1] < 'f' ? 'ae' : 'fj') + row[2];
    const rail = /^(tn|tp|bp|bn)/.exec(name);
    return rail ? rail[1] : null;
  }

  function internalTies(part, pinNames) {
    const ties = [];
    const P = lib();
    const d = P && P.T && P.T[part.type];
    if (d && d.groups) {
      let groups = [];
      try { groups = d.groups(part) || []; } catch (e) { groups = []; }
      for (const g of groups) if (g && g.length > 1) ties.push(g.slice());
    }
    const byStem = new Map();
    for (const name of pinNames) {
      const m = /^(.*)\.[lr]$/.exec(name);
      if (!m) continue;
      if (!byStem.has(m[1])) byStem.set(m[1], []);
      byStem.get(m[1]).push(name);
    }
    for (const names of byStem.values()) if (names.length > 1) ties.push(names);
    if (pinNames.includes('GND.1') && pinNames.includes('GND.2')) ties.push(['GND.1', 'GND.2']);
    return ties;
  }

  function netsFromPins(pins, wires) {
    const uf = new UF();
    const at = new Map();
    for (const pin of pins) {
      uf.find(pin.id);
      const k = xy(pin.x, pin.y);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(pin.id);
    }
    const byPart = new Map();
    for (const pin of pins) {
      if (!byPart.has(pin.part)) byPart.set(pin.part, []);
      byPart.get(pin.part).push(pin);
    }
    for (const list of byPart.values()) {
      const sample = list[0];
      for (const g of internalTies({ id: sample.part, type: sample.type, props: sample.props || {} }, list.map((p) => p.name))) {
        for (let i = 1; i < g.length; i++) uf.union(sample.part + ':' + g[0], sample.part + ':' + g[i]);
      }
    }
    const byStrip = new Map();
    for (const pin of pins) {
      const s = stripOf(pin.name);
      if (!s) continue;
      if (!byStrip.has(pin.part + ':' + s)) byStrip.set(pin.part + ':' + s, []);
      byStrip.get(pin.part + ':' + s).push(pin.id);
    }
    for (const ids of byStrip.values()) for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
    for (const ids of at.values()) for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
    // A Ground symbol is the circuit ground, same as a GND flag. The ESP32 GND pins
    // are that node too: the 2D highlight joins every ground symbol to the devkit ground.
    const gndPins = pins.filter((p) => p.type === 'ground' || (p.type === 'esp32' && /^GND/.test(p.name)));
    for (let i = 1; i < gndPins.length; i++) uf.union(gndPins[0].id, gndPins[i].id);
    for (const w of wires || []) {
      const ends = [w.a, w.b];
      const nodes = ends.map((p) => 'xy:' + xy(p.x, p.y));
      uf.union(nodes[0], nodes[1]);
      ends.forEach((p, i) => { for (const id of at.get(xy(p.x, p.y)) || []) uf.union(nodes[i], id); });
    }
    const netOf = new Map();
    let n = 0;
    const rootId = new Map();
    for (const pin of pins) {
      if (pin.type === 'breadboard' || pin.type === 'label') continue;
      const r = uf.find(pin.id);
      if (!rootId.has(r)) rootId.set(r, n++);
      netOf.set(pin.id, rootId.get(r));
    }
    return netOf;
  }

  function fromProject(proj) {
    const pins = [];
    for (const part of proj.parts || []) {
      const P = lib();
      const d = P && P.T && P.T[part.type];
      if (!d || !d.pins) continue;
      let list = [];
      try { list = d.pins(part) || []; } catch (e) { continue; }
      for (const pin of list) {
        const [rx, ry] = rotPt(pin.x, pin.y, part.rot || 0);
        pins.push({
          id: part.id + ':' + pin.name, part: part.id, type: part.type, name: pin.name,
          x: part.x + rx, y: part.y + ry, props: part.props || {},
        });
      }
    }
    return { pins, netOf: netsFromPins(pins, proj.wires || []) };
  }

  // Read the breadboard SVG the editor actually painted.
  function fromStage(svg) {
    const pins = [];
    const wires = [];
    for (const g of svg.querySelectorAll('g.part')) {
      const tr = g.getAttribute('transform') || '';
      const tm = /translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)(?:\s*rotate\(\s*([-\d.]+)\s*\))?/.exec(tr) || [];
      const ox = +tm[1] || 0, oy = +tm[2] || 0, deg = +tm[3] || 0;
      const part = g.dataset.id;
      const type = (g.dataset.type) || '';
      for (const el of g.querySelectorAll('[data-pin]')) {
        let lx, ly;
        if (el.tagName === 'circle') { lx = +el.getAttribute('cx'); ly = +el.getAttribute('cy'); }
        else {
          lx = +el.getAttribute('x') + (+el.getAttribute('width') || 0) / 2;
          ly = +el.getAttribute('y') + (+el.getAttribute('height') || 0) / 2;
        }
        const [rx, ry] = rotPt(lx, ly, Math.round(deg / 90));
        pins.push({ id: part + ':' + el.dataset.pin, part, type, name: el.dataset.pin, x: ox + rx, y: oy + ry, props: {} });
      }
    }
    // Part type is not on the DOM. Fill it from a parallel project when the caller passes it.
    for (const g of svg.querySelectorAll('g.wire')) {
      const ends = [...g.querySelectorAll('circle.w-end')].map((c) => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }));
      if (ends.length >= 2) wires.push({ a: ends[0], b: ends[1] });
    }
    return { pins, wires, netOf: null };
  }

  function pathSegs(d) {
    const segs = [];
    let x = 0, y = 0, sx = 0, sy = 0;
    const re = /([MLHVZ])([^MLHVZ]*)/gi;
    let m;
    while ((m = re.exec(d || ''))) {
      const cmd = m[1].toUpperCase();
      const nums = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number);
      if (cmd === 'M' || cmd === 'L') {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const nx = nums[i], ny = nums[i + 1];
          if (cmd === 'L' || segs.length) segs.push({ x1: x, y1: y, x2: nx, y2: ny });
          x = nx; y = ny;
          if (cmd === 'M') { sx = x; sy = y; }
        }
      } else if (cmd === 'H') {
        for (const nx of nums) { segs.push({ x1: x, y1: y, x2: nx, y2: y }); x = nx; }
      } else if (cmd === 'V') {
        for (const ny of nums) { segs.push({ x1: x, y1: y, x2: x, y2: ny }); y = ny; }
      } else if (cmd === 'Z') {
        segs.push({ x1: x, y1: y, x2: sx, y2: sy }); x = sx; y = sy;
      }
    }
    return segs.filter((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 0.2);
  }
  function nearSeg(p, s, tol) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) return Math.hypot(p.x - s.x1, p.y - s.y1) <= tol;
    let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy)) <= tol;
  }
  function startOf(d) {
    const m = /M\s*(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/i.exec(d || '');
    return m ? { x: +m[1], y: +m[2] } : null;
  }

  function connectDrawn(drawn) {
    const { pins } = drawn;
    const wires = drawn.wires;
    const flags = drawn.flags;
    const gnds = drawn.gnds;
    const ncs = drawn.ncs;
    const labels = drawn.labels;
    const uf = new UF();
    for (const pin of pins) uf.find(pin.id);
    const segs = wires.flat();
    // Pins that touch one polyline, and polylines that meet, are one net.
    const pinNodes = pins.map((p) => p.id);
    for (let i = 0; i < segs.length; i++) {
      const node = 'seg:' + i;
      uf.find(node);
      for (const pin of pins) if (nearSeg(pin, segs[i], 3)) uf.union(node, pin.id);
      for (let j = 0; j < i; j++) {
        const a = segs[i], b = segs[j];
        const touch = [[a.x1, a.y1], [a.x2, a.y2]].some(([x, y]) => nearSeg({ x, y }, b, 2))
          || [[b.x1, b.y1], [b.x2, b.y2]].some(([x, y]) => nearSeg({ x, y }, a, 2));
        if (touch) uf.union('seg:' + i, 'seg:' + j);
      }
    }
    const pinAt = (x, y) => pins.find((p) => Math.hypot(p.x - x, p.y - y) <= 3);
    const flagNames = new Set(flags.map((f) => f.name).filter(Boolean));
    const flagOf = new Map();
    for (const f of flags) {
      const pin = pinAt(f.x, f.y);
      if (!pin || !f.name) continue;
      flagOf.set(pin.id, f.name);
      const key = 'flag:' + f.name;
      uf.union(pin.id, key);
    }
    for (const g of gnds) {
      const pin = pinAt(g.x, g.y);
      if (pin) uf.union(pin.id, 'flag:GND');
    }
    const ncOf = new Set();
    for (const n of ncs) {
      let best = null, bd = 14;
      for (const pin of pins) {
        const d = Math.hypot(pin.x - n.x, pin.y - n.y);
        if (d < bd) { bd = d; best = pin; }
      }
      if (best) ncOf.add(best.id);
    }
    const labelOf = [];
    for (const lab of labels) {
      let best = null, bd = 24;
      for (let i = 0; i < segs.length; i++) {
        if (nearSeg(lab, segs[i], bd)) { bd = Math.hypot(lab.x - (segs[i].x1 + segs[i].x2) / 2, lab.y - (segs[i].y1 + segs[i].y2) / 2); best = i; }
      }
      // Prefer the closest segment within 22px by point distance, not midpoint distance.
      best = null; bd = 22;
      for (let i = 0; i < segs.length; i++) if (nearSeg(lab, segs[i], 18) && true) {
        const dx = segs[i].x2 - segs[i].x1, dy = segs[i].y2 - segs[i].y1, l2 = dx * dx + dy * dy || 1;
        let t = ((lab.x - segs[i].x1) * dx + (lab.y - segs[i].y1) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(lab.x - (segs[i].x1 + t * dx), lab.y - (segs[i].y1 + t * dy));
        if (d < bd) { bd = d; best = i; }
      }
      if (best != null) {
        labelOf.push({ text: lab.text, seg: best });
        // A wire labeled with a flag's name is that flag's net (VCC, 9V, 3.7V, …).
        if (flagNames.has(lab.text)) uf.union('seg:' + best, 'flag:' + lab.text);
      }
    }
    for (const lab of labelOf) lab.net = uf.find('seg:' + lab.seg);
    const netOf = new Map();
    for (const pin of pins) netOf.set(pin.id, uf.find(pin.id));
    const gndRoot = gnds.length ? uf.find('flag:GND') : null;
    return {
      pins, parts: drawn.parts, refs: drawn.refs, vals: drawn.vals, netOf, flagOf, ncOf, labelOf,
      notes: drawn.notes, pinNodes, gndRoot,
    };
  }

  function fromSchematicSvg(svg) {
    const pins = [];
    const pinRe = /<circle class="sch-pin"[^>]*cx="([^"]+)" cy="([^"]+)"[^>]*data-pin="([^"]*)"[^>]*data-pid="([^"]*)"[^>]*\/?>/g;
    let m;
    while ((m = pinRe.exec(svg))) pins.push({ x: +m[1], y: +m[2], name: m[3], part: m[4], id: m[4] + ':' + m[3] });
    const parts = [...svg.matchAll(/<g class="sch-sym[^"]*" data-pid="([^"]*)">/g)].map((g) => g[1]);
    const refs = [...svg.matchAll(/<text class="sch-ref"[^>]*>([^<]*)<\/text>/g)].map((g) => g[1]);
    const vals = [...svg.matchAll(/<text class="sch-val"[^>]*>([^<]*)<\/text>/g)].map((g) => g[1]);
    const wires = [...svg.matchAll(/<path d="([^"]+)" class="sch-wire"\/>/g)].map((g) => pathSegs(g[1]));
    const flags = [];
    const railRe = /<path d="([^"]+)" class="sch-stroke sch-rail"\/>(?:<text class="sch-flag"[^>]*>([^<]*)<\/text>)?/g;
    while ((m = railRe.exec(svg))) {
      const at = startOf(m[1]);
      if (at) flags.push({ x: at.x, y: at.y, name: m[2] || '' });
    }
    const gnds = [...svg.matchAll(/<path d="([^"]+)" class="sch-stroke sch-gnd"\/>/g)].map((g) => startOf(g[1])).filter(Boolean);
    const ncs = [];
    for (const g of svg.matchAll(/<path class="sch-nc" d="([^"]+)"\/>/g)) {
      const nums = (g[1].match(/-?\d*\.?\d+/g) || []).map(Number);
      if (nums.length >= 2) ncs.push({ x: nums[0] + 4.5, y: nums[1] + 4.5 });
    }
    const labels = [...svg.matchAll(/<text class="sch-netlbl"[^>]*x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
      .map((g) => ({ x: +g[1], y: +g[2], text: g[3] }));
    const notes = [...svg.matchAll(/<text class="sch-note"[^>]*>([^<]*)<\/text>/g)].map((g) => g[1]);
    return connectDrawn({ pins, parts, refs, vals, wires, flags, gnds, ncs, labels, notes });
  }

  function fromSchematicDom(rootEl) {
    const pins = [...rootEl.querySelectorAll('circle.sch-pin')].map((el) => ({
      x: +el.getAttribute('cx'), y: +el.getAttribute('cy'),
      name: el.dataset.pin || el.getAttribute('data-pin'),
      part: el.dataset.pid || el.getAttribute('data-pid'),
      id: (el.dataset.pid || el.getAttribute('data-pid')) + ':' + (el.dataset.pin || el.getAttribute('data-pin')),
    }));
    const parts = [...rootEl.querySelectorAll('g.sch-sym')].map((g) => g.dataset.pid || g.getAttribute('data-pid'));
    const text = (cls) => [...rootEl.querySelectorAll('text.' + cls)].map((t) => t.textContent.trim());
    const refs = text('sch-ref');
    const vals = text('sch-val');
    const notes = text('sch-note');
    const wires = [...rootEl.querySelectorAll('path.sch-wire')].map((p) => pathSegs(p.getAttribute('d')));
    const flags = [...rootEl.querySelectorAll('path.sch-rail')].map((p) => {
      const at = startOf(p.getAttribute('d'));
      const nxt = p.nextElementSibling;
      const name = nxt && nxt.matches && nxt.matches('text.sch-flag') ? nxt.textContent.trim() : '';
      return at ? { x: at.x, y: at.y, name } : null;
    }).filter(Boolean);
    const gnds = [...rootEl.querySelectorAll('path.sch-gnd')].map((p) => startOf(p.getAttribute('d'))).filter(Boolean);
    const ncs = [...rootEl.querySelectorAll('path.sch-nc')].map((p) => {
      const nums = (p.getAttribute('d').match(/-?\d*\.?\d+/g) || []).map(Number);
      return nums.length >= 2 ? { x: nums[0] + 4.5, y: nums[1] + 4.5 } : null;
    }).filter(Boolean);
    const labels = [...rootEl.querySelectorAll('text.sch-netlbl')].map((t) => ({
      x: +t.getAttribute('x'), y: +t.getAttribute('y'), text: t.textContent.trim(),
    }));
    return connectDrawn({ pins, parts, refs, vals, wires, flags, gnds, ncs, labels, notes });
  }

  function schPin(pin, sch) {
    const exact = sch.pins.find((p) => p.part === pin.part && p.name === pin.name);
    if (exact) return exact;
    const stem = String(pin.name).replace(/\.[lr]$/i, '');
    if (stem !== pin.name) {
      const hit = sch.pins.find((p) => p.part === pin.part && p.name === stem);
      if (hit) return hit;
    }
    const P = lib();
    const d = P && P.T && P.T[pin.type];
    if (d && d.groups) {
      let groups = [];
      try { groups = d.groups({ id: pin.part, type: pin.type, props: pin.props || {} }) || []; } catch (e) { groups = []; }
      for (const g of groups) {
        if (!g || !g.includes(pin.name)) continue;
        const shown = String(g[0]).replace(/\.[lr]$/i, '');
        const hit = sch.pins.find((p) => p.part === pin.part && (p.name === shown || p.name === g[0]));
        if (hit) return hit;
      }
    }
    return null;
  }

  function powered(pinIds, byId) {
    return pinIds.some((id) => {
      const p = byId.get(id);
      if (!p) return false;
      return /^(3V3|5V|VCC|VDD|VIN|\+|VOUT)$/.test(p.name)
        && /^(esp32|battery|battery9v|aapack|coincell|cell18650|bench|vcc33|vcc5|buck|ldo)$/.test(p.type);
    });
  }
  function grounded(pinIds, byId) {
    return pinIds.some((id) => {
      const p = byId.get(id);
      return p && (p.type === 'ground' || /^(GND(\.\d+)?|VSS|-)$/.test(p.name));
    });
  }

  function diff(board, sch) {
    const problems = [];
    const byId = new Map(board.pins.map((p) => [p.id, p]));
    const elec = board.pins.filter((p) => p.type !== 'breadboard' && p.type !== 'label');
    const partIds = [...new Set(elec.map((p) => p.part))];
    const schParts = new Set(sch.parts);
    const omittedOk = new Set();
    for (const id of partIds) {
      if (schParts.has(id)) continue;
      const pins = elec.filter((p) => p.part === id);
      const onlyGround = pins.every((p) => p.type === 'ground');
      if (onlyGround) {
        const mates = elec.filter((p) => board.netOf.get(p.id) === board.netOf.get(pins[0].id) && p.part !== id);
        const drawnGnd = mates.some((p) => {
          const s = schPin(p, sch);
          return s && sch.gndRoot && sch.netOf.get(s.id) === sch.gndRoot;
        });
        if (drawnGnd || !mates.length) { omittedOk.add(id); continue; }
      }
      problems.push({ kind: 'missing-schematic', part: id, type: pins[0] && pins[0].type });
    }
    for (const id of schParts) {
      if (!partIds.includes(id)) problems.push({ kind: 'missing-2d', part: id });
    }
    const mapped = [];
    for (const pin of elec) {
      if (omittedOk.has(pin.part)) continue;
      const s = schPin(pin, sch);
      if (!s) {
        if (!schParts.has(pin.part)) continue;
        problems.push({ kind: 'pin-missing', pin: pin.id });
        continue;
      }
      mapped.push({ pin, s });
    }
    const seen = new Set();
    for (const a of mapped) {
      const in2 = mapped.filter((b) => board.netOf.get(b.pin.id) === board.netOf.get(a.pin.id)).map((b) => b.pin.id).sort();
      const inS = mapped.filter((b) => sch.netOf.get(b.s.id) === sch.netOf.get(a.s.id)).map((b) => b.pin.id).sort();
      if (in2.join('|') === inS.join('|')) continue;
      const key = in2.join('|') + '||' + inS.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ kind: 'nets', pin: a.pin.id, in2d: in2, inSchematic: inS });
    }
    const members = (net) => elec.filter((p) => board.netOf.get(p.id) === net).map((p) => p.id);
    for (const [id, name] of sch.flagOf) {
      const row = mapped.find((a) => a.s.id === id);
      if (!row) continue;
      const group = members(board.netOf.get(row.pin.id));
      const supply = /^(VCC|3V3|5V|VIN|\+V)$/.test(name);
      if (supply && !powered(group, byId)) problems.push({ kind: 'flag-unpowered', pin: row.pin.id, flag: name, in2d: group });
      if (name === 'GND' && !grounded(group, byId)) problems.push({ kind: 'flag-ungrounded', pin: row.pin.id, flag: name, in2d: group });
    }
    for (const id of sch.ncOf) {
      const row = mapped.find((a) => a.s.id === id);
      if (!row) continue;
      const group = members(board.netOf.get(row.pin.id)).filter((p) => p !== row.pin.id);
      const schGroup = mapped.filter((b) => sch.netOf.get(b.s.id) === sch.netOf.get(row.s.id)).map((b) => b.pin.id);
      if (group.length || schGroup.length > 1) problems.push({ kind: 'nc-but-connected', pin: row.pin.id, in2d: group, inSchematic: schGroup });
    }
    const labelled = new Set();
    for (const lab of sch.labelOf) {
      const on = mapped.filter((a) => sch.netOf.get(a.s.id) === lab.net);
      const stem = (n) => String(n).toUpperCase().replace(/\.[LR]$/, '');
      const byPart = new Map();
      for (const a of on) {
        if (!byPart.has(a.pin.part)) byPart.set(a.pin.part, new Set());
        byPart.get(a.pin.part).add(stem(a.pin.name));
      }
      const boring = /^(1|2|\+|-|A|K)$/;
      const key = lab.text + '@' + on.map((a) => a.pin.id).sort().join(',');
      if (labelled.has(key)) continue;
      labelled.add(key);
      const label = stem(lab.text);
      if (/^(VCC|3V3|5V|VIN|GND|\+V|\d+(?:\.\d+)?V)$/.test(label)) continue;
      for (const set of byPart.values()) {
        const meaningful = [...set].filter((n) => !boring.test(n));
        if (meaningful.length >= 2 && set.has(label)) {
          problems.push({ kind: 'misleading-name', label: lab.text, pins: on.map((a) => a.pin.id) });
          break;
        }
      }
    }
    // One label text is one net. A second copy on another net is a false connection.
    const labelNets = new Map();
    for (const lab of sch.labelOf) {
      if (!labelNets.has(lab.text)) labelNets.set(lab.text, new Set());
      labelNets.get(lab.text).add(lab.net);
    }
    for (const [text, nets] of labelNets) {
      if (nets.size < 2) continue;
      const pins = mapped.filter((a) => nets.has(sch.netOf.get(a.s.id))).map((a) => a.pin.id);
      problems.push({ kind: 'misleading-name', label: text, pins });
    }
    const float2 = new Set(), floatS = new Set();
    for (const id of partIds) {
      if (omittedOk.has(id)) continue;
      const mine = elec.filter((p) => p.part === id);
      const touches = mine.some((p) => elec.some((q) => q.part !== id && board.netOf.get(q.id) === board.netOf.get(p.id)));
      if (!touches) float2.add(id);
      if (!schParts.has(id)) continue;
      const smine = mapped.filter((a) => a.pin.part === id);
      const stouches = smine.some((a) => mapped.some((b) => b.pin.part !== id && sch.netOf.get(b.s.id) === sch.netOf.get(a.s.id)));
      if (!stouches) floatS.add(id);
    }
    for (const id of floatS) if (!float2.has(id)) problems.push({ kind: 'floating-schematic', part: id });
    for (const id of float2) if (!floatS.has(id) && schParts.has(id)) problems.push({ kind: 'floating-2d', part: id });
    return { problems, parts: { board: partIds, schematic: [...schParts], refs: sch.refs, vals: sch.vals, notes: sch.notes } };
  }

  function auditProject(proj, svg) {
    const board = fromProject(proj);
    const sch = fromSchematicSvg(svg);
    return diff(board, sch);
  }

  const api = { fromProject, fromStage, fromSchematicSvg, fromSchematicDom, diff, auditProject, netsFromPins, rotPt };
  root.ViewAudit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
