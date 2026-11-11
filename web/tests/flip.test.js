'use strict';
// Physical flip is a 180° end-swap for two-terminal parts. Multi-pin parts and
// the breadboard stay put while ALLOW_MIRROR_MULTIPIN is false. schFlip* is
// schematic display only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Parts: P, Sim, Netlist, Schematic, Examples } = require('./tools/load-parts');

function pin(part, name) {
  return P.pinWorld(part, P.T[part.type].pins(part).find((q) => q.name === name));
}
function at(x, y) { return { x, y }; }
function groups(proj) {
  return Netlist.extract(proj).nets.map((n) => n.pins.slice().sort().join(',')).sort();
}

test('a part saved without flip flags keeps its pin positions', () => {
  const r = { id: 'R1', type: 'resistor', x: 100, y: 200, rot: 0, props: { ohms: 330 } };
  assert.deepEqual(pin(r, '1'), at(100, 200));
  assert.deepEqual(pin(r, '2'), at(140, 200));
  assert.equal(P.canPhysicalFlip(r), true);
  assert.equal(P.canPhysicalFlip({ type: 'breadboard' }), false);
  assert.equal(P.canPhysicalFlip({ type: 'esp32', props: {} }), false);
  assert.equal(P.ALLOW_MIRROR_MULTIPIN, false);
});

test('flipping a resistor or LED swaps the two strips, and twice is identity', () => {
  const blink = Examples.EX.blink();
  const led = blink.parts.find((p) => p.id === 'LED1');
  const r = blink.parts.find((p) => p.id === 'R1');
  const before = { a: pin(led, 'A'), c: pin(led, 'C'), r1: pin(r, '1'), r2: pin(r, '2') };
  led.flipX = true;
  assert.deepEqual(pin(led, 'A'), before.c);
  assert.deepEqual(pin(led, 'C'), before.a);
  r.flipY = true;
  assert.deepEqual(pin(r, '1'), before.r2);
  assert.deepEqual(pin(r, '2'), before.r1);
  led.flipX = false;
  r.flipY = false;
  assert.deepEqual(pin(led, 'A'), before.a);
  assert.deepEqual(pin(r, '1'), before.r1);
});

test('flip combined with each rotation lands on the known pin coordinates', () => {
  const r = { id: 'R1', type: 'resistor', x: 100, y: 200, rot: 0, flipX: true, props: {} };
  const expectR = [
    [at(140, 200), at(100, 200)],
    [at(100, 240), at(100, 200)],
    [at(60, 200), at(100, 200)],
    [at(100, 160), at(100, 200)],
  ];
  for (let rot = 0; rot < 4; rot++) {
    r.rot = rot;
    assert.deepEqual(pin(r, '1'), expectR[rot][0], 'resistor pin 1 rot ' + rot);
    assert.deepEqual(pin(r, '2'), expectR[rot][1], 'resistor pin 2 rot ' + rot);
  }
  const led = { id: 'D1', type: 'led', x: 100, y: 200, rot: 0, flipX: true, props: { color: 'red' } };
  const expectL = [
    [at(110, 200), at(100, 200)],
    [at(100, 210), at(100, 200)],
    [at(90, 200), at(100, 200)],
    [at(100, 190), at(100, 200)],
  ];
  for (let rot = 0; rot < 4; rot++) {
    led.rot = rot;
    assert.deepEqual(pin(led, 'A'), expectL[rot][0], 'LED A rot ' + rot);
    assert.deepEqual(pin(led, 'C'), expectL[rot][1], 'LED C rot ' + rot);
  }
});

test('multi-pin flip flags do not move pins while mirroring is off', () => {
  const q = { id: 'Q1', type: 'npn', x: 80, y: 90, rot: 1, props: {} };
  const before = P.T.npn.pins(q).map((pin) => P.pinWorld(q, pin));
  q.flipX = true; q.flipY = true;
  const after = P.T.npn.pins(q).map((pin) => P.pinWorld(q, pin));
  assert.deepEqual(after, before);
  assert.equal(P.canPhysicalFlip(q), false);
  assert.equal(P.bodySpin(q), null);
});

test('the netlist follows the swapped LED legs', () => {
  function circuit(flip) {
    return { parts: [
      { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 63 } },
      { id: 'esp', type: 'esp32', x: 20, y: 50, rot: 0, props: { power: 'usb' } },
      { id: 'r1', type: 'resistor', x: 250, y: 120, rot: 0, props: { r: 220 } },
      { id: 'led', type: 'led', x: 290, y: 130, rot: 0, flipX: !!flip, props: { color: 'red', vf: 1.9 } },
    ], wires: [
      { id: 'w1', a: { x: 50, y: 150 }, b: { x: 250, y: 150 }, color: 'yellow' },
      { id: 'w2', a: { x: 300, y: 150 }, b: { x: 310, y: 190 }, color: 'black' },
      { id: 'w3', a: { x: 30, y: 150 }, b: { x: 30, y: 190 }, color: 'black' },
    ] };
  }
  const mates = (proj, name) => {
    const net = Netlist.extract(proj).nets.find((n) => n.pins.includes('led:' + name));
    return net.pins.filter((pin) => pin !== 'led:A' && pin !== 'led:C').sort();
  };
  const fwd = circuit(false), rev = circuit(true);
  assert.deepEqual(mates(rev, 'A'), mates(fwd, 'C'));
  assert.deepEqual(mates(rev, 'C'), mates(fwd, 'A'));
  assert.notDeepEqual(groups(fwd), groups(rev));
});

test('schematic mirror moves the symbol pin and not the breadboard net', () => {
  const a = Examples.EX.blink();
  const b = JSON.parse(JSON.stringify(a));
  const led = b.parts.find((p) => p.id === 'LED1');
  const world = pin(led, 'A');
  led.schFlipX = true;
  assert.deepEqual(pin(led, 'A'), world);
  assert.deepEqual(groups(a), groups(b));
  const term = (proj) => {
    const s = Schematic.layout(proj).symbols.find((q) => q.id === 'LED1');
    const t = s.terms.find((u) => u.name === 'A' || u.pin === 'A' || u.id === 'A');
    return t.x;
  };
  assert.notEqual(term(b), term(a));
});

test('an end-swap stays on the same side of the row and does not walk off its holes', () => {
  const board = { id: 'BB1', type: 'breadboard', x: 0, y: 0, rot: 0, props: {} };
  const led = { id: 'LED1', type: 'led', x: 200, y: 130, rot: 0, props: { color: 'red' } };
  const beside = { id: 'R1', type: 'resistor', x: 200, y: 160, rot: 0, props: { ohms: 330 } };
  const dome = (part) => { const [x, y] = P.orientPt(5, -16, part); return { x: part.x + x, y: part.y + y }; };
  const before = dome(led);
  const still = P.reseat([board, led, beside], led);
  assert.equal(still.moved, false);
  led.flipX = true;
  const after = dome(led);
  assert.equal(after.y, before.y, 'body stays on the same side of the row');
  assert.equal(after.x, before.x);
  const seat = P.reseat([board, led, beside], led);
  assert.equal(seat.moved, false);
  assert.equal(seat.x, 200);
  assert.equal(led.flipX, true);
  const blink = Examples.EX.blink();
  const d = blink.parts.find((p) => p.id === 'LED1');
  d.flipX = true;
  const home = P.reseat(blink.parts, d);
  assert.equal(home.moved, false);
  assert.equal(home.x, d.x);
  assert.equal(home.y, d.y);
});

test('a reversed blink LED does not light', () => {
  function current(flip) {
    const proj = { parts: [
      { id: 'bb', type: 'breadboard', x: 0, y: 0, rot: 0, props: { cols: 63 } },
      { id: 'esp', type: 'esp32', x: 20, y: 50, rot: 0, props: { power: 'usb' } },
      { id: 'r1', type: 'resistor', x: 250, y: 120, rot: 0, props: { r: 220 } },
      { id: 'led', type: 'led', x: 290, y: 130, rot: 0, flipX: !!flip, props: { color: 'red', vf: 1.9, imax: 0.03 } },
    ], wires: [
      { id: 'w1', a: { x: 50, y: 150 }, b: { x: 250, y: 150 }, color: 'yellow' },
      { id: 'w2', a: { x: 300, y: 150 }, b: { x: 310, y: 190 }, color: 'black' },
      { id: 'w3', a: { x: 30, y: 150 }, b: { x: 30, y: 190 }, color: 'black' },
    ] };
    const sim = new Sim(proj);
    const rt = sim.espRuntime(proj.parts[1]);
    rt.pinMode(2, 'OUTPUT'); rt.write(2, 1); sim.advance(0.01);
    return sim.partState(proj.parts[3]);
  }
  const on = current(false), off = current(true);
  assert.ok(on.i > 0.004 && on.bright > 0.2, 'forward LED lights, i=' + on.i);
  assert.ok(off.i < 1e-5 && off.bright < 0.05, 'reversed LED stays dark, i=' + off.i);
});
