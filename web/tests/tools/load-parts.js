// Load the ESP32 Lab catalog, simulator, netlist and schematic in the same
// order as web/index.html (editor, UI and 3D view are omitted — they need a DOM).
'use strict';
const path = require('path');

const WEB = path.resolve(__dirname, '../..');
if (typeof global.window === 'undefined') global.window = global;

const FILES = [
  'solver.js',
  'parts.js',
  'parts-art.js',
  'scope.js',
  'sim.js',
  'remote_logic.js',
  'devices.js',
  'netlog.js',
  'i2cdev.js',
  'spidev.js',
  'jssketch.js',
  'examples.js',
  'basic.js',
  'bom.js',
  'parts/registry.js',
  'parts/sensors.js',
  'parts/displays.js',
  'parts/examples-sensors-displays.js',
  'parts/ics.js',
  'parts/passives.js',
  'parts/examples-ics.js',
  'parts/hwkit.js',
  'parts/actuators.js',
  'parts/power.js',
  'parts/semis.js',
  'parts/examples-actuators.js',
  'netlist.js',
  'schematic.js',
];

for (const f of FILES) require(path.join(WEB, 'js', f));

function allTypes() { return Object.keys(globalThis.Parts.T); }

module.exports = {
  WEB,
  REPO: path.resolve(WEB, '..'),
  FILES,
  allTypes,
  Parts: globalThis.Parts,
  Sim: globalThis.SimCore.Sim,
  Netlist: globalThis.Netlist,
  Schematic: globalThis.Schematic,
  Bom: globalThis.Bom,
  Examples: globalThis.Examples,
  PartsReg: globalThis.PartsReg,
};
