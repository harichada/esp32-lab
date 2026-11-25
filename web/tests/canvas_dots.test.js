// Studio Dark: one breadboard on a dotted canvas. Dots off the board do not conduct.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Parts: P, Sim } = require('./tools/load-parts');

if (!global.document) global.document = { documentElement: { dataset: {} } };
if (!global.document.documentElement) global.document.documentElement = { dataset: {} };
if (!global.document.documentElement.dataset) global.document.documentElement.dataset = {};
global.document.documentElement.dataset.ui = '3';

function load(board) {
  board.props = Object.assign({ cols: 63 }, board.props || {});
  board.rot = board.rot || 0;
  board.type = 'breadboard';
  return board;
}

test('an old grown board loads as one classic board and parts keep their places', () => {
  const bb = load({ id: 'bb', x: 12, y: -4, props: { cols: 160, c0: -8, c1: 160, b0: -1, b1: 3 } });
  const led = { id: 'D1', type: 'led', x: 1000, y: 480, rot: 0, props: { color: 'red' } };
  const shown = P.bbShown(bb);
  assert.equal(shown.plain, true);
  assert.equal(shown.c0, 1);
  assert.equal(shown.c1, 63);
  assert.equal(led.x, 1000);
  assert.equal(led.y, 480);
  assert.equal(bb.x, 12);
  assert.equal(bb.y, -4);
  const pins = P.T.breadboard.pins(bb);
  const a1 = pins.find((h) => h.name === 'a1');
  assert.deepEqual(a1, { name: 'a1', x: 10, y: 40 });
  assert.equal(P.pinWorld(bb, a1).x, 22);
  assert.equal(P.pinWorld(bb, a1).y, 36);
  assert.equal(pins.some((h) => h.name === 'a100' || h.name === 'a1@1'), false);
  const svg = P.T.breadboard.svg(bb);
  assert.match(svg, /data-pin="a1"/);
  assert.doesNotMatch(svg, /data-pin="a100"/);
  assert.doesNotMatch(svg, /@/);
  assert.match(svg, /width="642"/);
  assert.equal(P.bbSpan(bb).c1, 160, 'the saved span stays in the file');
});

test('dots off the board are not connected, and a wire or a shared pin is', () => {
  const bb = load({ id: 'bb', x: 0, y: 0, props: { cols: 63, c0: 1, c1: 160, b0: 0, b1: 1 } });
  const r1 = { id: 'R1', type: 'resistor', x: 1000, y: 40, rot: 0, props: { r: 220 } };
  const r2 = { id: 'R2', type: 'resistor', x: 1000, y: 50, rot: 0, props: { r: 220 } };
  const proj = { parts: [bb, r1, r2], wires: [] };
  let sim = new Sim(proj);
  sim.topology();
  assert.notEqual(sim.netAt(1000, 40), sim.netAt(1000, 50), 'adjacent off-board dots are not a strip');
  assert.notEqual(sim.netAt(1000, 40), -1);
  assert.equal(sim.netAt(1080, 40), -1, 'an empty dot is not a net by itself');

  proj.wires.push({ id: 'w1', a: { x: 1040, y: 40 }, b: { x: 1040, y: 50 }, pts: [], color: 'green' });
  sim = new Sim(proj);
  sim.topology();
  assert.equal(sim.netAt(1040, 40), sim.netAt(1040, 50), 'a wire joins the two parts');
  assert.notEqual(sim.netAt(1000, 40), sim.netAt(1000, 50), 'the other ends stay separate');
  assert.notEqual(sim.netAt(1080, 40), sim.netAt(1040, 40));

  const shared = {
    parts: [
      bb,
      { id: 'R3', type: 'resistor', x: 800, y: 200, rot: 0, props: { r: 100 } },
      { id: 'R4', type: 'resistor', x: 800, y: 200, rot: 0, props: { r: 100 } },
    ],
    wires: [],
  };
  sim = new Sim(shared);
  sim.topology();
  assert.equal(sim.netAt(800, 200), sim.netAt(800, 200));
  assert.equal(sim.pinNet.get('R3:1'), sim.pinNet.get('R4:1'), 'pins on the same dot are one net');
  assert.notEqual(sim.pinNet.get('R3:1'), sim.pinNet.get('R3:2'));
});
