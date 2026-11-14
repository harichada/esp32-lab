// Schematic "like the breadboard" placement is drawing only.
// The tidy layout stays available, and the netlist the simulator reads does not change.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'netlist.js', 'schematic.js']) require('../js/' + f);
const S = globalThis.Schematic;
const { layout, toSvg, separateSymbols, wireJoints, screenLabelPx } = S;
const { Sim } = globalThis.SimCore;
const E = globalThis.Examples;
const P = globalThis.Parts;
const N = globalThis.Netlist;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function hit(a, b) {
  return Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 0.5;
}
function body(s) { return { x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h }; }
function noBodyOverlap(symbols, label) {
  for (let i = 0; i < symbols.length; i++) for (let j = i + 1; j < symbols.length; j++) {
    assert.ok(!hit(body(symbols[i]), body(symbols[j])), label + ' ' + symbols[i].id + ' overlaps ' + symbols[j].id);
  }
}
function seats(model) {
  return model.symbols.map((s) => [s.id, s.x, s.y, s.w, s.h]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
function resistor(id, x, y, rot) {
  return { id: id, type: 'resistor', x: x, y: y, rot: rot || 0, props: { r: 1000 } };
}
function consumed(proj) {
  const copy = clone(proj);
  const sim = new Sim(copy);
  sim.build();
  const pins = [...sim.pinNet.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const el = sim.circuit.el.map((e) => {
    const o = {};
    for (const k of Object.keys(e).sort()) {
      const v = e[k];
      if (typeof v === 'function' || v == null || typeof v === 'object') continue;
      o[k] = v;
    }
    return o;
  });
  return JSON.stringify({ pins: pins, n: sim.nNodes, el: el, nets: N.extract(copy).nets });
}
function ortho(model, label) {
  for (const pl of model.polys) for (let i = 1; i < pl.pts.length; i++) {
    const a = pl.pts[i - 1], b = pl.pts[i];
    assert.ok(a.x === b.x || a.y === b.y, label + ' wire not orthogonal');
  }
}
function textsClear(model, label) {
  const texts = model.texts || [];
  for (const t of texts) assert.ok((t.size || 0) >= S.MIN_LABEL_FONT, label + ' label ' + t.text + ' is ' + t.size);
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    assert.ok(!hit(texts[i], texts[j]), label + ' labels overlap "' + texts[i].text + '" / "' + texts[j].text + '"');
  }
  for (const t of texts) for (const s of model.symbols) {
    if (t.own === s.id) continue;
    assert.ok(!hit(t, body(s)), label + ' label "' + t.text + '" overlaps ' + s.id);
  }
}

test('the match flag defaults on and ?schmatch=0 is the off switch', () => {
  assert.equal(S.SCHEMATIC_MATCH_LAYOUT, true);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../css/theme.css'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8');
  assert.match(html, /schematic\.js\?v=65/);
  assert.match(html, /pinch\.js\?v=62/);
  assert.match(html, /theme\.css\?v=68/);
  assert.match(html, /mobile\.css\?v=72/);
  for (const state of [':hover', ':active', ':focus-visible', ':disabled']) {
    assert.match(css, new RegExp('\\.sch-lay' + state));
  }
  assert.match(css, /min-height:44px/);
  assert.match(css, /min-width:44px/);
  assert.match(mobile, /body\.m \.sch-layout/);
  assert.match(mobile, /min-height:44px/);
});

function docWith(meta, data) {
  return {
    documentElement: { getAttribute: (name) => (name === 'data-schmatch' ? data : null) },
    querySelector: (sel) => (sel === 'meta[name="schmatch"]' && meta != null ? { getAttribute: () => meta, content: meta } : null),
  };
}

test('the server off switch wins, and ?schmatch applies only when the server allows it', () => {
  const prev = S.SCHEMATIC_MATCH_LAYOUT;
  const blink = E.EX.blink();
  const tidy = seats(layout(blink));
  try {
    assert.equal(S.configureMatch(null, ''), true);
    assert.equal(S.configureMatch(null, '?schmatch=0'), false);
    assert.equal(S.configureMatch(null, '?schmatch=1'), true);
    assert.equal(S.configureMatch(null, '?schmatch=sideways'), true);
    assert.equal(S.configureMatch(docWith('0', null), '?schmatch=1'), false);
    assert.equal(S.SCHEMATIC_MATCH_LAYOUT, false);
    S.SCHEMATIC_MATCH_LAYOUT = true;
    assert.equal(S.SCHEMATIC_MATCH_LAYOUT, false, 'a page cannot turn the server switch back on');
    assert.deepStrictEqual(seats(layout(blink, { match: true })), tidy);
    assert.equal(S.configureMatch(docWith(null, '0'), '?schmatch=1'), false);
    assert.equal(S.configureMatch(docWith('1', null), '?schmatch=0'), false);
    assert.equal(S.configureMatch(docWith('1', null), ''), true);
    assert.equal(S.configureMatch(docWith('no', null), '?schmatch=1'), true);
  } finally {
    S.configureMatch(null, '');
    S.SCHEMATIC_MATCH_LAYOUT = prev;
  }
});

function fitScale(box, clear, pad) {
  const availW = Math.max(1, clear.width - pad * 2);
  const availH = Math.max(1, clear.height - pad * 2);
  return Math.max(0.12, Math.min(2.4, Math.min(availW / Math.max(box.w, 1), availH / Math.max(box.h, 1))));
}
function groupInside(model, ids, view, clear) {
  const s = view.s;
  const x0 = view.x, y0 = view.y;
  const x1 = view.x + clear.width / s, y1 = view.y + clear.height / s;
  return model.symbols.filter((sym) => ids.includes(sym.id)).every((sym) => sym.x >= x0 - 1 && sym.y >= y0 - 1 && sym.x + sym.w <= x1 + 1 && sym.y + sym.h <= y1 + 1);
}

test('part labels stay at 11px on screen and shorten instead of shrinking', () => {
  assert.equal(S.labelScreenTarget(12, 0.61), 11);
  assert.equal(S.labelScreenTarget(12, 2), 12);
  assert.equal(S.labelScreenTarget(11, 1), 11);
  assert.equal(S.labelScreenTarget(8, 0.4), 11);
  assert.equal(S.labelScreenTarget(8, 3), 11);
  assert.equal(S.shortPartLabel('R1', '220Ω', 'Resistor'), 'R1 220Ω');
  assert.equal(S.shortPartLabel('LED1', '', ''), 'LED1');
  assert.equal(S.shortPartLabel('', '', 'ESP32'), 'ESP32');
});

test('open zoom frames the wired parts, and only a crowded sheet zooms for part names', () => {
  assert.equal(S.labelScreenPx(9.5, 0.25, 1), 2.375);
  assert.equal(S.labelScreenPx(11, 0.25, 1), 2.75);
  const tight = S.openScale(11, 0.25, 1);
  assert.equal(tight.fitAll, true);
  assert.ok(Math.abs(tight.s - 1) < 1e-9);
  const easy = S.openScale(12, 1.2, 1);
  assert.equal(easy.fitAll, false);
  assert.equal(easy.s, 1.2);
  const phone = { width: 320, height: 412 };
  const desk = { width: 796, height: 219 };
  const blink = layout(E.EX.blink(), { match: true });
  const blinkFrame = S.openFrame(blink);
  assert.deepStrictEqual(blinkFrame.ids.slice().sort(), ['LED1', 'R1', 'esp']);
  assert.equal(blinkFrame.font, 11);
  for (const clear of [phone, desk]) {
    const fitted = fitScale(blinkFrame.box, clear, 14);
    const choice = S.chooseOpen(blinkFrame.font, fitted, 1, { group: blinkFrame.box, esp: blinkFrame.esp, clear, pad: 14, count: blinkFrame.count });
    assert.equal(choice.zoomed, false, 'blink stays framed at ' + (choice.s * 100).toFixed(0) + '%');
    assert.ok(choice.s < 0.9, 'blink is not the old 116% pin zoom');
    assert.ok(groupInside(blink, blinkFrame.ids, { s: choice.s, x: blinkFrame.box.x, y: blinkFrame.box.y }, { width: clear.width - 28, height: clear.height - 28 }));
  }
  const simon = layout(E.EX.simon(), { match: true });
  const simonFrame = S.openFrame(simon);
  assert.ok(simonFrame.count < 24);
  const simonFit = fitScale(simonFrame.box, phone, 14);
  const simonOpen = S.chooseOpen(simonFrame.font, simonFit, 1, { group: simonFrame.box, esp: simonFrame.esp, clear: phone, pad: 14, count: simonFrame.count });
  assert.equal(simonOpen.zoomed, false);
  const remote = layout(E.EX.remote(), { match: true });
  const remoteFrame = S.openFrame(remote);
  assert.ok(remoteFrame.count >= 24);
  const remoteFit = fitScale(remoteFrame.box, phone, 14);
  const remoteOpen = S.chooseOpen(remoteFrame.font, remoteFit, 1, { group: remoteFrame.box, esp: remoteFrame.esp, clear: phone, pad: 14, count: remoteFrame.count });
  assert.equal(remoteOpen.zoomed, true);
  assert.ok(remoteOpen.px >= 11, 'remote part names are ' + remoteOpen.px.toFixed(2) + 'px');
});

test('junction dots mark a shared node and crossings of two nets do not', () => {
  const marks = wireJoints([
    { net: 1, x1: 0, y1: 0, x2: 80, y2: 0 },
    { net: 1, x1: 40, y1: 0, x2: 40, y2: 50 },
    { net: 5, x1: 0, y1: 200, x2: 80, y2: 200 },
    { net: 5, x1: 40, y1: 160, x2: 40, y2: 240 },
    { net: 2, x1: 0, y1: 20, x2: 80, y2: 20 },
    { net: 3, x1: 20, y1: -10, x2: 20, y2: 40 },
    { net: 1, x1: 0, y1: 70, x2: 30, y2: 70 },
    { net: 1, x1: 30, y1: 70, x2: 70, y2: 70 },
    { net: 4, x1: 0, y1: 90, x2: 20, y2: 90 },
    { net: 4, x1: 20, y1: 90, x2: 20, y2: 110 },
    { net: 6, x1: 0, y1: 300, x2: 80, y2: 300 },
    { net: 7, x1: 40, y1: 300, x2: 40, y2: 340 },
  ]);
  const dotAt = (x, y, net) => marks.dots.some((d) => d.x === x && d.y === y && d.net === net);
  assert.ok(dotAt(40, 0, 1), 'T junction of one net');
  assert.ok(dotAt(40, 200, 5), 'plus junction of one net');
  assert.ok(!dotAt(20, 20, 2) && !dotAt(20, 20, 3), 'a crossing is not a dot');
  assert.ok(marks.crosses.some((c) => c.x === 20 && c.y === 20 && c.a !== c.b), 'the crossing is recorded');
  assert.ok(!dotAt(40, 300, 6) && !dotAt(40, 300, 7), 'a wire ending on another net is not a dot');
  assert.ok(marks.crosses.some((c) => c.x === 40 && c.y === 300), 'a wire ending on another net is a crossing');
  assert.ok(!marks.dots.some((d) => d.y === 70), 'a straight run is not a dot');
  assert.ok(!marks.dots.some((d) => d.net === 4), 'a corner is not a dot');
  for (const c of marks.crosses) {
    assert.ok(!marks.dots.some((d) => d.x === c.x && d.y === c.y), 'dot on a crossing at ' + c.x + ',' + c.y);
  }
});

test('collision pass separates stacked, rotated, and crowded symbols the same way twice', () => {
  function run(list) {
    const copy = list.map((s) => Object.assign({}, s));
    separateSymbols(copy);
    return copy.map((s) => [s.id, s.x, s.y]);
  }
  const stacked = [{ id: 'A', x: 0, y: 0, w: 80, h: 40 }, { id: 'B', x: 0, y: 0, w: 80, h: 40 }, { id: 'C', x: 0, y: 0, w: 60, h: 40 }];
  const rotated = [{ id: 'H', x: 10, y: 10, w: 80, h: 20 }, { id: 'V', x: 10, y: 10, w: 40, h: 80 }];
  const many = [];
  for (let i = 0; i < 16; i++) many.push({ id: 'R' + String(i).padStart(2, '0'), x: 40, y: 40, w: 70, h: 24 });
  for (const [name, list] of [['stacked', stacked], ['rotated', rotated], ['many', many]]) {
    const once = run(list);
    const twice = run(list);
    assert.deepStrictEqual(once, twice, name + ' is not deterministic');
    const placed = list.map((s) => Object.assign({}, s));
    separateSymbols(placed);
    noBodyOverlap(placed, name);
  }
});

test('match layout follows the breadboard, hides it, and keeps power as labels', () => {
  const raw = E.EX.blink();
  const before = JSON.stringify(raw);
  const model = layout(raw, { match: true });
  assert.equal(JSON.stringify(raw), before);
  assert.ok(!model.symbols.some((s) => s.part.type === 'breadboard'));
  assert.ok(!toSvg(model).toLowerCase().includes('breadboard'));
  noBodyOverlap(model.symbols, 'blink');
  textsClear(model, 'blink');
  ortho(model, 'blink');
  assert.ok(model.rails.every((r) => r.kind === 'gnd' || r.kind === 'flag'));
  assert.ok(model.rails.some((r) => r.kind === 'gnd'));
  const order = model.symbols.slice().sort((a, b) => a.part.x - b.part.x || a.part.y - b.part.y).map((s) => s.x);
  const sorted = order.slice().sort((a, b) => a - b);
  assert.deepStrictEqual(order, sorted, 'symbol order follows the breadboard left to right');
  const fit = screenLabelPx(model, 390, 700, 48);
  assert.equal(fit.minFont, 11);
  const open = S.openScale(fit.minFont, fit.s, 1);
  assert.equal(S.labelScreenPx(fit.minFont, open.s, 1), open.px);
  const wide = screenLabelPx(model, 1600, 1200, 80);
  const wideOpen = S.openScale(wide.minFont, wide.s, 1);
  if (wide.minPx >= S.READABLE_PX) assert.equal(wideOpen.fitAll, false);
  const again = layout(clone(raw), { match: true });
  assert.deepStrictEqual(seats(model), seats(again));

  const button = layout(E.EX.button(), { match: true });
  const svg = toSvg(button);
  assert.ok(svg.includes('3V3'), '3V3 is a label');
  assert.ok(svg.includes('sch-gnd'));
  assert.ok(button.rails.every((r) => r.kind === 'gnd' || r.kind === 'flag'));
  assert.ok(!button.symbols.some((s) => s.part.type === 'breadboard'));
  noBodyOverlap(button.symbols, 'button');
  textsClear(button, 'button');
  ortho(button, 'button');
});

test('moving or rotating a part moves the matched symbol', () => {
  const proj = E.EX.blink();
  const before = layout(proj, { match: true });
  const moved = clone(proj);
  const r = moved.parts.find((p) => p.id === 'R1');
  r.x += 80;
  r.y += 30;
  const after = layout(moved, { match: true });
  const a = before.symbols.find((s) => s.id === 'R1');
  const b = after.symbols.find((s) => s.id === 'R1');
  assert.ok(a.x !== b.x || a.y !== b.y, 'dragging the resistor did not move its symbol');
  noBodyOverlap(after.symbols, 'moved');

  const flat = layout({ parts: [resistor('R1', 40, 40, 0)], wires: [] }, { match: true });
  const turned = layout({ parts: [resistor('R1', 40, 40, 1)], wires: [] }, { match: true });
  const dirs = (m) => m.symbols[0].terms.map((t) => t.dir).sort().join('');
  assert.notEqual(dirs(flat), dirs(turned), 'rotation did not turn the symbol');
});

test('empty, single, unplaced, off-board, and huge circuits stay finite', () => {
  const empty = layout({ name: 'empty', parts: [], wires: [] }, { match: true });
  assert.equal(empty.symbols.length, 0);
  assert.ok(isFinite(empty.bounds.w) && empty.bounds.w > 0);

  const one = layout({ parts: [resistor('R1', 40, 50, 0)], wires: [] }, { match: true });
  assert.equal(one.symbols.length, 1);
  assert.equal(one.polys.length, 0);
  assert.ok(isFinite(one.symbols[0].x) && isFinite(one.symbols[0].y));

  const loose = layout({
    parts: [resistor('R1', 100, 80, 0), { id: 'R2', type: 'resistor', rot: 0, props: { r: 2200 } }],
    wires: [],
  }, { match: true });
  assert.equal(loose.symbols.length, 2);
  noBodyOverlap(loose.symbols, 'unplaced');
  for (const s of loose.symbols) assert.ok(isFinite(s.x) && isFinite(s.y));

  const board = { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 30 } };
  const near = resistor('R1', 80, 40, 0);
  const far = { id: 'LED1', type: 'led', x: 900, y: 420, rot: 0, props: { color: 'red' } };
  const pin = (part, name) => P.pinWorld(part, P.T[part.type].pins(part).find((q) => q.name === name));
  const off = layout({
    parts: [board, near, far],
    wires: [{ id: 'w1', a: pin(near, '2'), b: pin(far, 'A'), pts: [] }],
  }, { match: true });
  assert.ok(!off.symbols.some((s) => s.part.type === 'breadboard'));
  assert.equal(off.symbols.length, 2);
  assert.ok(off.polys.some((pl) => pl.pts && pl.pts.length >= 2), 'the off-board lead is a wire');
  ortho(off, 'off-board');
  noBodyOverlap(off.symbols, 'off-board');

  const huge = layout({
    parts: [resistor('R1', 1e12, -8e11, 0), resistor('R2', 1e12 + 400, -8e11 + 80, 0)],
    wires: [],
  }, { match: true });
  assert.equal(huge.symbols.length, 2);
  noBodyOverlap(huge.symbols, 'huge');
  for (const s of huge.symbols) {
    assert.ok(isFinite(s.x) && isFinite(s.y));
    assert.ok(Math.abs(s.x) < 1e7 && Math.abs(s.y) < 1e7, s.x + ',' + s.y);
  }
});

test('stacked, rotated, and many parts on one spot do not overlap', () => {
  const stacked = layout({
    parts: [resistor('R1', 20, 20, 0), resistor('R2', 20, 20, 0), resistor('R3', 20, 20, 0)],
    wires: [],
  }, { match: true });
  noBodyOverlap(stacked.symbols, 'stacked parts');
  const rotated = layout({
    parts: [resistor('R1', 20, 20, 0), resistor('R2', 20, 20, 1), resistor('R3', 20, 20, 2)],
    wires: [],
  }, { match: true });
  noBodyOverlap(rotated.symbols, 'rotated parts');
  const parts = [];
  for (let i = 0; i < 12; i++) parts.push(resistor('R' + i, 15, 15, i % 4));
  const many = layout({ parts: parts, wires: [] }, { match: true });
  assert.equal(many.symbols.length, 12);
  noBodyOverlap(many.symbols, 'many parts');
  assert.deepStrictEqual(seats(many), seats(layout({ parts: parts, wires: [] }, { match: true })));
});

test('flag off is the tidy layout, and the netlist is identical in every state', () => {
  const blink = E.EX.blink();
  const tidy = seats(layout(blink));
  const prev = S.SCHEMATIC_MATCH_LAYOUT;
  try {
    S.SCHEMATIC_MATCH_LAYOUT = false;
    assert.deepStrictEqual(seats(layout(blink, { match: true })), tidy, 'flag off still matched the breadboard');
    assert.deepStrictEqual(seats(layout(blink, { match: false })), tidy);
  } finally {
    S.SCHEMATIC_MATCH_LAYOUT = prev;
  }
  assert.notDeepStrictEqual(seats(layout(blink, { match: true })), tidy);

  for (const key of ['blink', 'button', 'remote']) {
    const proj = E.EX[key]();
    const base = consumed(proj);
    const raw = JSON.stringify(proj);
    const seen = [];
    for (const flag of [true, false]) {
      S.SCHEMATIC_MATCH_LAYOUT = flag;
      for (const match of [true, false]) {
        const copy = clone(proj);
        layout(copy, { match: match });
        assert.equal(JSON.stringify(copy), raw, key + ' layout mutated the project');
        seen.push(consumed(copy));
      }
    }
    S.SCHEMATIC_MATCH_LAYOUT = prev;
    for (const snap of seen) assert.equal(snap, base, key + ' netlist changed');
  }
});

test('the arrangement is remembered per project, with one key for an unsaved board', () => {
  const mem = new Map();
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  assert.equal(S.layoutStoreKey({ id: 'p1' }), 'esp32lab.schLayout.p1');
  assert.equal(S.layoutStoreKey({}), 'esp32lab.schLayout.unsaved');
  assert.equal(S.layoutStoreKey(null), 'esp32lab.schLayout.unsaved');
  assert.equal(S.layoutModeOf({ id: 'p1' }, store), 'board');
  store.setItem(S.layoutStoreKey({ id: 'p1' }), 'tidy');
  assert.equal(S.layoutModeOf({ id: 'p1' }, store), 'tidy');
  assert.equal(S.layoutModeOf({ id: 'p2' }, store), 'board');
  store.setItem(S.layoutStoreKey({ id: 'p1' }), 'sideways');
  assert.equal(S.layoutModeOf({ id: 'p1' }, store), 'board');
  store.setItem(S.layoutStoreKey({}), 'tidy');
  assert.equal(S.layoutModeOf({}, store), 'tidy');
  assert.equal(S.layoutModeOf({ id: 'p2' }, store), 'board');
});
