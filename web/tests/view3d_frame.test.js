// 3D framing and the header view chip. node --test tests/view3d_frame.test.js
const test = require('node:test');
const assert = require('node:assert');
const THREE = require('../vendor/three.min.js');
globalThis.THREE = THREE;
require('../js/view3d.js');
require('../js/viewchrome.js');
const { fitCameraToBox, contentPadding } = globalThis.View3DFit;
const { viewChipState, blocks3d } = globalThis.ViewChrome;

// Blink breadboard body in world units (part at the origin): x −6…636, z −14…208, a few mm thick.
function boardBox() {
  return new THREE.Box3(new THREE.Vector3(-6, -38, -14), new THREE.Vector3(636, 24, 208));
}
// What the old fitter actually aimed at: the parts cluster, padded, with the breadboard skipped.
function partsBox() {
  return new THREE.Box3(new THREE.Vector3(-55, -20, -15), new THREE.Vector3(395, 40, 225));
}
function cam(aspect) {
  const c = new THREE.PerspectiveCamera(40, aspect, 1.2, 5000);
  c.updateProjectionMatrix();
  return c;
}
function cornersOf(box) {
  const out = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}
function project(c, box) {
  c.updateMatrixWorld(true);
  return cornersOf(box).map((p) => p.clone().project(c));
}
const MARGIN = { xMin: -0.9, xMax: 0.9, yMin: -0.86, yMax: 0.9 };
function inside(ndc, m) {
  return ndc.every((n) => n.x >= m.xMin && n.x <= m.xMax && n.y >= m.yMin && n.y <= m.yMax && n.z >= -1 && n.z <= 1);
}

// The previous fit: sphere from the longer footprint, distance clamped, look-at pinned near the table.
function legacyPose(c, box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 40);
  const target = new THREE.Vector3(center.x, Math.max(8, Math.min(14, size.y * 0.1 + 5)), center.z);
  const theta = 40 * Math.PI / 180, phi = 1.10;
  const vfov = (c.fov || 40) * Math.PI / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov * 0.5) * Math.max(0.2, c.aspect || 1));
  const fov = Math.min(vfov, hfov);
  const fit = (span * 0.52) / Math.max(0.12, Math.tan(fov * 0.5));
  const r = Math.max(110, Math.min(1100, fit * 1.08 + 30));
  c.position.set(
    target.x + r * Math.sin(phi) * Math.sin(theta),
    target.y + r * Math.cos(phi),
    target.z + r * Math.sin(phi) * Math.cos(theta)
  );
  c.lookAt(target);
  c.updateMatrixWorld(true);
  return r;
}

test('parts-only fit leaves the breadboard outside a desktop view', () => {
  const c = cam(956 / 526);
  legacyPose(c, partsBox());
  const ndc = project(c, boardBox());
  const off = ndc.some((n) => n.x > 1 || n.y < -1 || n.y > 1 || n.x < -1);
  assert.ok(off, 'expected the full board to miss the viewport: ' + ndc.map((n) => n.x.toFixed(2) + ',' + n.y.toFixed(2)).join(' '));
});

test('full board fits a desktop stage and a phone-width stage', () => {
  for (const aspect of [956 / 526, 390 / 790]) {
    const c = cam(aspect);
    const board = boardBox();
    const pose = fitCameraToBox(c, board, { angleDeg: 40, margins: MARGIN });
    const ndc = project(c, board);
    assert.ok(inside(ndc, MARGIN), aspect.toFixed(3) + ' ' + ndc.map((n) => n.x.toFixed(2) + ',' + n.y.toFixed(2)).join(' '));
    assert.ok(c.position.y > board.max.y + 20, 'camera should sit above the board');
    assert.ok(pose.r > 200 && pose.r < 20000, pose.r);
  }
});

test('reframing after an aspect change keeps the board inside', () => {
  const c = cam(956 / 526);
  const board = boardBox();
  fitCameraToBox(c, board, { angleDeg: 40, margins: MARGIN });
  c.aspect = 390 / 790;
  c.updateProjectionMatrix();
  fitCameraToBox(c, board, { angleDeg: 40, margins: MARGIN });
  assert.ok(inside(project(c, board), MARGIN));
});

test('padding stays a sliver on a breadboard and modest on a small circuit', () => {
  const small = contentPadding(80), board = contentPadding(640);
  assert.ok(small >= 8 && small < 12, small);
  assert.ok(board > small && board <= 18, board);
});

test('series-sized content frames closer than the old stand-in board', () => {
  // Measured solid parts of Series vs parallel, versus the stand-in board the camera used to fit.
  const content = new THREE.Box3(new THREE.Vector3(87, -1, 105), new THREE.Vector3(342, 40, 442));
  const span = Math.max(342 - 87, 442 - 105);
  const padded = content.clone().expandByScalar(contentPadding(span));
  const stand = new THREE.Box3(new THREE.Vector3(40, -47, 90), new THREE.Vector3(352, 59, 490));
  const cA = cam(956 / 526), cB = cam(956 / 526);
  const a = fitCameraToBox(cA, padded, { angleDeg: 40, margins: MARGIN });
  const b = fitCameraToBox(cB, stand, { angleDeg: 40, margins: MARGIN });
  assert.ok(a.r < b.r * 0.9, a.r + ' vs ' + b.r);
  assert.ok(inside(project(cA, padded), MARGIN));
  const board = boardBox();
  const bp = board.clone().expandByScalar(contentPadding(642));
  const c = cam(956 / 526);
  fitCameraToBox(c, bp, { angleDeg: 40, margins: MARGIN });
  assert.ok(inside(project(c, board), MARGIN), 'blink board still inside after the content pad');
});

test('a small circuit still frames without the camera sitting inside it', () => {
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(80, 16, 50));
  const c = cam(1.4);
  const pose = fitCameraToBox(c, box, { margins: MARGIN });
  assert.ok(inside(project(c, box), MARGIN));
  assert.ok(pose.r < 2500, pose.r);
  assert.ok(c.position.distanceTo(box.getCenter(new THREE.Vector3())) > 30);
});

test('header chip names the active view and how to get back to 2D', () => {
  const d2 = viewChipState('2d');
  assert.match(d2.text, /2D/);
  assert.match(d2.aria, /Current view: 2D/);
  assert.doesNotMatch(d2.text, /Schematic|3D/);
  const sch = viewChipState('schematic');
  assert.match(sch.text, /Schematic/);
  assert.match(sch.text, /2D/);
  assert.notStrictEqual(sch.text, '2D');
  assert.match(sch.aria, /schematic/);
  assert.match(sch.aria, /2D editor/);
  const d3 = viewChipState('3d');
  assert.match(d3.text, /3D/);
  assert.match(d3.text, /2D/);
  assert.notStrictEqual(d3.text, '2D');
  assert.match(d3.aria, /Current view: 3D/);
  assert.match(d3.aria, /2D editor/);
  const compact = viewChipState('3d', { compact: true });
  assert.match(compact.text, /3D/);
  assert.ok(compact.text.length < d3.text.length);
});

test('bloom scripts stay off the default 3D path', () => {
  const { wants3dFx } = globalThis.View3DLoad;
  assert.strictEqual(wants3dFx(''), false);
  assert.strictEqual(wants3dFx('?ex=blink'), false);
  assert.strictEqual(wants3dFx('?fx3d=1'), true);
  assert.strictEqual(wants3dFx('?ex=blink&fx3d=1'), true);
  assert.strictEqual(wants3dFx('?fx3d=10'), false);
});

test('3D hides the 2D zoom readout stylesheet rule', () => {
  const fs = require('fs');
  const path = require('path');
  const theme = fs.readFileSync(path.join(__dirname, '../css/theme.css'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8');
  assert.match(theme, /body\.view3d #zoomPct\{display:none!important\}/);
  assert.match(mobile, /body\.m\.view3d #zoomPct\{display:none!important\}/);
});

test('3D stays available at phone width on a desktop pointer', () => {
  assert.strictEqual(blocks3d({ coarse: false, fine: true, touchUA: false, width: 390 }), false);
  assert.strictEqual(blocks3d({ coarse: true, fine: true, touchUA: false, width: 400 }), false);
  assert.strictEqual(blocks3d({ coarse: true, fine: false, touchUA: false, width: 1440 }), true);
  assert.strictEqual(blocks3d({ coarse: false, fine: true, touchUA: true, width: 1440 }), true);
});
