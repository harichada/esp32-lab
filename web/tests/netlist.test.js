// The netlist is the stored circuit. 2D wires, the 3D scene, and the schematic share it.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'netlist.js', 'schematic.js']) require('../js/' + f);
const { layout, pinNets } = globalThis.Schematic;
const { Sim } = globalThis.SimCore;
const N = globalThis.Netlist;
const E = globalThis.Examples;

function clone(p) { return JSON.parse(JSON.stringify(p)); }
function sig(proj) {
  const sim = new Sim(clone(proj));
  sim.topology();
  return N.partitionKey(sim.pinNet, N.electricalPins(proj));
}
function schSig(proj) { return N.partitionKey(pinNets(proj), N.electricalPins(proj)); }

test('an old wire project gains a netlist and keeps its wires and parts', () => {
  const proj = E.EX.blink();
  assert.ok(!proj.netlist);
  const wires = JSON.stringify(proj.wires);
  const parts = JSON.stringify(proj.parts);
  N.migrate(proj);
  assert.strictEqual(JSON.stringify(proj.wires), wires);
  assert.strictEqual(JSON.stringify(proj.parts), parts);
  assert.strictEqual(proj.netlist.v, 1);
  assert.ok(proj.netlist.nets.length >= 2);
  assert.ok(N.samePartition(proj, proj.netlist));
  N.migrate(proj);
  assert.strictEqual(JSON.stringify(proj.wires), wires, 'a second load does not redraw the board');
});

test('clearing the wires and reloading draws the board back from the netlist', () => {
  const orig = E.EX.ic_555blink();
  const want = sig(orig);
  const proj = clone(orig);
  proj.netlist = N.extract(orig);
  proj.wires = [];
  N.migrate(proj);
  assert.ok(proj.wires.length >= 4, 'realize built jumpers, got ' + proj.wires.length);
  for (const w of proj.wires) {
    assert.ok(w.a && w.b && isFinite(w.a.x) && isFinite(w.b.x) && isFinite(w.a.y) && isFinite(w.b.y), w.id);
    assert.ok(w.id);
  }
  assert.strictEqual(new Set(proj.wires.map((w) => w.id)).size, proj.wires.length);
  assert.strictEqual(sig(proj), want, 'generated 2D/3D wires match the 555 nets');
  assert.strictEqual(schSig(proj), want, 'schematic reads the same nets');
  const sim = new Sim(clone(proj));
  sim.topology();
  const net = (id, pin) => sim.pinNet.get(id + ':' + pin);
  assert.strictEqual(net('U1', 'TRIG'), net('U1', 'THR'));
  assert.strictEqual(net('U1', 'TRIG'), net('R2', '2'));
  assert.strictEqual(net('U1', 'TRIG'), net('C1', '+'));
  assert.strictEqual(net('U1', 'DIS'), net('R2', '1'));
  assert.notStrictEqual(net('U1', 'DIS'), net('U1', 'TRIG'));
});

test('the schematic follows the stored nets when the wires have been removed', () => {
  const proj = E.EX.ic_555blink();
  N.migrate(proj);
  const before = schSig(proj);
  proj.wires = [];
  assert.strictEqual(schSig(proj), before);
  const model = layout(proj);
  assert.ok(!model.fallback, (model.fallbackWhy || []).join('; '));
  const labels = model.texts.filter((t) => t.kind === 'label').map((t) => t.text);
  assert.ok(!labels.includes('TRIG'), labels.join(','));
});

test('editing wires refreshes the netlist', () => {
  const proj = E.EX.blink();
  N.migrate(proj);
  const connected = N.partitionKey(new Map(proj.netlist.nets.flatMap((n) => n.pins.map((p) => [p, n.id]))), N.electricalPins(proj));
  proj.wires = [];
  N.syncFromWires(proj);
  const open = N.partitionKey(new Map(proj.netlist.nets.flatMap((n) => n.pins.map((p) => [p, n.id]))), N.electricalPins(proj));
  assert.notStrictEqual(open, connected);
  assert.ok(N.samePartition(proj, proj.netlist));
});

test('a netlist with no board restores its parts, then its wires', () => {
  const orig = E.EX.b_divider();
  const nl = N.extract(orig);
  const proj = { name: 'restored', parts: [], wires: [], netlist: nl };
  N.migrate(proj);
  assert.deepStrictEqual(proj.parts.map((p) => p.id).sort(), orig.parts.map((p) => p.id).sort());
  assert.strictEqual(sig(proj), sig(orig));
  assert.ok(proj.wires.length > 0);
});

test('every example: one netlist for 2D, 3D and schematic, no stray or duplicate parts', () => {
  const keys = E.LIST.map((row) => row[0]);
  assert.ok(keys.length >= 42, 'example list has ' + keys.length);
  const problems = [];
  for (const key of keys) {
    const fn = E.EX[key];
    if (typeof fn !== 'function') continue;
    let orig;
    try { orig = fn(); } catch (e) { problems.push(key + ' threw ' + e.message); continue; }
    const ids = (orig.parts || []).map((p) => p.id);
    if (new Set(ids).size !== ids.length) problems.push(key + ' duplicate part ids');
    const wires = JSON.stringify(orig.wires || []);
    const parts = JSON.stringify(orig.parts || []);
    const proj = clone(orig);
    try { N.migrate(proj); } catch (e) { problems.push(key + ' migrate ' + e.message); continue; }
    if (JSON.stringify(proj.wires) !== wires) problems.push(key + ' migrate redrew wires');
    if (JSON.stringify(proj.parts) !== parts) problems.push(key + ' migrate moved parts');
    const compIds = proj.netlist.components.map((p) => p.id);
    if (compIds.join() !== ids.join()) problems.push(key + ' netlist parts differ from the board');
    if (!N.samePartition(proj, proj.netlist)) problems.push(key + ' netlist does not match the wires');
    let bareMap, migratedMap;
    try {
      const pins = N.electricalPins(orig);
      const sortPin = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      bareMap = pins.map((p) => [p, pinNets(orig).get(p)]).sort(sortPin);
      migratedMap = pins.map((p) => [p, pinNets(proj).get(p)]).sort(sortPin);
    } catch (e) { problems.push(key + ' pinNets ' + e.message); continue; }
    if (JSON.stringify(bareMap) !== JSON.stringify(migratedMap)) problems.push(key + ' schematic pin map changed once the netlist was attached');
    const want = sig(orig);
    if (schSig(proj) !== want) problems.push(key + ' schematic diverges from the simulator');
    const gen = clone(orig);
    gen.wires = [];
    gen.netlist = N.extract(orig);
    try { N.migrate(gen); } catch (e) { problems.push(key + ' realize ' + e.message); continue; }
    if (sig(gen) !== want) problems.push(key + ' generated wires do not match the nets');
    if (schSig(gen) !== want) problems.push(key + ' schematic of generated wires diverges');
    for (const w of gen.wires) {
      if (!w.a || !w.b || !isFinite(w.a.x) || !isFinite(w.b.x)) problems.push(key + ' generated wire ' + w.id);
    }
  }
  assert.deepStrictEqual(problems, []);
});
