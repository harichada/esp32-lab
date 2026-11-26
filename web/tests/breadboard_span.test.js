// An expanded breadboard keeps classic hole coordinates, and a strip far from
// the origin still conducts. node --test web/tests/breadboard_span.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Parts: P, Sim } = require('./tools/load-parts');

function hole(board, name) {
  return P.T.breadboard.pins(board).find((h) => h.name === name);
}
function load(board) {
  board.props = Object.assign({}, P.T.breadboard.props, board.props || {});
  board.rot = board.rot || 0;
  return board;
}

test('a saved 63-column board keeps hole a1, and a larger board does not move it', () => {
  const saved = load({ id: 'bb', type: 'breadboard', x: 12, y: -4, props: { cols: 63 } });
  assert.equal(P.bbClassic(saved), true);
  const a1 = hole(saved, 'a1');
  assert.deepEqual(a1, { name: 'a1', x: 10, y: 40 });
  const world = P.pinWorld(saved, a1);
  assert.equal(hole(saved, 'a64'), undefined);
  const classicGroups = P.T.breadboard.groups(saved);
  assert.deepEqual(classicGroups[0], ['a1', 'b1', 'c1', 'd1', 'e1']);
  const svg = P.T.breadboard.svg(saved);
  assert.match(svg, /data-pin="a1"/);
  assert.match(svg, /width="642"/);
  assert.doesNotMatch(svg, /@/);

  saved.props.c0 = 1;
  saved.props.c1 = 120;
  saved.props.b0 = 0;
  saved.props.b1 = 1;
  const still = hole(saved, 'a1');
  assert.equal(still.x, 10);
  assert.equal(still.y, 40);
  assert.deepEqual(P.pinWorld(saved, still), world);
  const far = hole(saved, 'a100');
  assert.equal(far.x, 10 + 99 * 10);
  assert.equal(far.y, 40);
  const lower = hole(saved, 'a1@1');
  assert.equal(lower.x, 10);
  assert.equal(lower.y, 40 + P.BB_BAND);
  const same = load({ id: 'bb2', type: 'breadboard', x: 0, y: 0, props: { cols: 63, c0: 1, c1: 63, b0: 0, b1: 0 } });
  assert.deepEqual(P.T.breadboard.groups(same), classicGroups);
});

test('a strip far from the origin conducts, and a wire there joins its ends', () => {
  const bb = load({ id: 'bb', type: 'breadboard', x: 0, y: 0, props: { cols: 63, c0: 1, c1: 160, b0: 0, b1: 1 } });
  const x100 = 10 + 99 * 10, x150 = 10 + 149 * 10, yBand = 40 + P.BB_BAND;
  const proj = {
    parts: [
      bb,
      { id: 'r', type: 'resistor', x: x100, y: 40, rot: 0, props: { r: 220 } },
    ],
    wires: [
      { id: 'wstrip', a: { x: x100, y: 50 }, b: { x: x100 + 40, y: 50 }, pts: [], color: 'green' },
      { id: 'wfar', a: { x: x100, y: 40 }, b: { x: x150, y: yBand }, pts: [], color: 'yellow' },
    ],
  };
  const sim = new Sim(proj);
  sim.topology();
  assert.equal(sim.netAt(x100, 40), sim.netAt(x100, 50), 'column 100 a–e is one strip');
  assert.notEqual(sim.netAt(x100, 40), -1);
  assert.equal(sim.netAt(x100, 40), sim.netAt(x150, yBand), 'a wire joins two far holes');
  const alone = sim.netAt(x100 + 80, yBand);
  assert.notEqual(alone, sim.netAt(x100, 40), 'an empty hole on the next band is not that strip');
});

test('covering points on the original board does not rewrite it; points past the edge do', () => {
  const bb = load({ id: 'bb', type: 'breadboard', x: 0, y: 0, props: { cols: 63 } });
  assert.equal(P.bbCover(bb, 200, 40, 240, 40), false);
  assert.equal(bb.props.c0, undefined);
  assert.equal(P.bbClassic(bb), true);
  assert.equal(P.bbCover(bb, 1000, 40, 1040, 40), true);
  assert.ok(bb.props.c1 >= 100);
  assert.equal(hole(bb, 'a1').x, 10);
  assert.equal(hole(bb, 'a1').y, 40);
  assert.ok(hole(bb, 'a100'));
});
