/* Circuit netlist: the electrical record for an example or a saved project.
 * A netlist is the parts plus the nets (which pins share a node). The 2D breadboard
 * wires and the 3D scene are a drawing of those nets, and the schematic reads them.
 *
 * Old projects store only parts and wires. migrate() keeps that drawing and writes
 * the netlist it already implements, so a saved board opens unchanged. A project that
 * has a netlist and no wires gets its wires from realize(): a spanning tree between
 * the pins of each net, at the parts' current positions. 2D and 3D both draw proj.wires.
 *
 * Editing the board refreshes the netlist from the wires just drawn (syncFromWires),
 * which keeps the three views on one connectivity. Hand-routed example wires are left
 * in place; they are checked to be the same nets, not replaced by the spanning tree.
 */
(function (root) {
  const P = root.Parts;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function electricalPins(proj) {
    const pins = [];
    for (const p of proj.parts || []) {
      if (p.type === 'breadboard' || p.type === 'label') continue;
      const d = P.T[p.type];
      if (!d || !d.pins) continue;
      let list = [];
      try { list = d.pins(p) || []; } catch (e) { continue; }
      for (const pin of list) pins.push(p.id + ':' + pin.name);
    }
    return pins;
  }

  function partitionKey(map, pins) {
    const groups = new Map();
    for (const pin of pins) {
      const id = map.has(pin) ? String(map.get(pin)) : '\u2205' + pin;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(pin);
    }
    return [...groups.values()].map((g) => g.sort().join(',')).sort().join(';');
  }

  function netlistMap(nl) {
    const map = new Map();
    const listed = [];
    for (const net of (nl && nl.nets) || []) {
      for (const pin of net.pins || []) { map.set(pin, net.id); listed.push(pin); }
    }
    return { map, listed };
  }

  // Pins of real parts, grouped the way the simulator groups them (wires, strips, grounds).
  function extract(proj) {
    const sim = new root.SimCore.Sim(proj);
    sim.topology();
    const byNet = new Map();
    for (const pin of electricalPins(proj)) {
      const n = sim.pinNet.get(pin);
      if (n === undefined || n < 0) continue;
      if (!byNet.has(n)) byNet.set(n, []);
      byNet.get(n).push(pin);
    }
    const nets = [...byNet.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, pins]) => ({ id, pins: [...new Set(pins)].sort() }));
    return { v: 1, components: (proj.parts || []).map((p) => clone(p)), nets };
  }

  function samePartition(proj, nl) {
    const pins = electricalPins(proj);
    const { map, listed } = netlistMap(nl);
    if (listed.length !== pins.length) return false;
    for (const pin of pins) if (!map.has(pin)) return false;
    const sim = new root.SimCore.Sim(proj);
    sim.topology();
    return partitionKey(sim.pinNet, pins) === partitionKey(map, pins);
  }

  // Build proj.wires from proj.netlist. Part positions stay where they are.
  function realize(proj) {
    const nl = proj.netlist || { nets: [] };
    const byId = new Map((proj.parts || []).map((p) => [p.id, p]));
    const wires = [];
    const colors = ['#e04545', '#e08a20', '#d6c430', '#3aa0ff', '#37d67a', '#c084fc'];
    let n = 1;
    for (const net of nl.nets || []) {
      const pts = [];
      const seen = new Set();
      for (const pk of net.pins || []) {
        const cut = String(pk).indexOf(':');
        if (cut < 0) continue;
        const part = byId.get(pk.slice(0, cut));
        if (!part) continue;
        const d = P.T[part.type];
        if (!d || !d.pins) continue;
        let pins = [];
        try { pins = d.pins(part) || []; } catch (e) { continue; }
        const spec = pins.find((q) => q.name === pk.slice(cut + 1));
        if (!spec) continue;
        const w = P.pinWorld(part, spec);
        const key = Math.round(w.x) + ',' + Math.round(w.y);
        if (seen.has(key)) continue;
        seen.add(key);
        pts.push({ x: Math.round(w.x), y: Math.round(w.y) });
      }
      if (pts.length < 2) continue;
      const used = [pts[0]];
      const rest = pts.slice(1);
      while (rest.length) {
        let bi = 0, bj = 0, bd = Infinity;
        for (let a = 0; a < used.length; a++) for (let b = 0; b < rest.length; b++) {
          const dist = Math.abs(used[a].x - rest[b].x) + Math.abs(used[a].y - rest[b].y);
          if (dist < bd) { bd = dist; bi = a; bj = b; }
        }
        const A = used[bi];
        const B = rest.splice(bj, 1)[0];
        if (A.x !== B.x || A.y !== B.y) {
          const mid = [];
          if (A.x !== B.x && A.y !== B.y) mid.push({ x: B.x, y: A.y });
          wires.push({ id: 'nlw' + n++, a: { x: A.x, y: A.y }, b: { x: B.x, y: B.y }, pts: mid, color: colors[wires.length % colors.length] });
        }
        used.push(B);
      }
    }
    proj.wires = wires;
    return proj;
  }

  function valid(nl) { return !!(nl && nl.v && Array.isArray(nl.nets)); }

  // Load path. Wires on a saved board are kept; a wire-less netlist is drawn out.
  function migrate(proj) {
    proj.parts = proj.parts || [];
    proj.wires = proj.wires || [];
    const nl = valid(proj.netlist) ? proj.netlist : null;
    if (!proj.parts.length && nl && Array.isArray(nl.components) && nl.components.length) proj.parts = clone(nl.components);
    if (!proj.wires.length && nl && nl.nets.length) {
      proj.netlist = nl;
      realize(proj);
      return proj;
    }
    if (!nl || !samePartition(proj, nl)) proj.netlist = extract(proj);
    return proj;
  }

  function syncFromWires(proj) {
    proj.netlist = extract(proj);
    return proj;
  }

  const api = { extract, migrate, realize, syncFromWires, samePartition, electricalPins, partitionKey };
  root.Netlist = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
