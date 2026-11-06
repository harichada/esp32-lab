// Every example: the breadboard's wires and the drawn schematic are the same circuit.
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['solver.js', 'parts.js', 'parts-art.js', 'sim.js', 'remote_logic.js', 'examples.js', 'basic.js', 'bom.js', 'parts/registry.js', 'parts/sensors.js', 'parts/displays.js', 'parts/examples-sensors-displays.js', 'parts/ics.js', 'parts/passives.js', 'parts/examples-ics.js', 'parts/hwkit.js', 'parts/actuators.js', 'parts/power.js', 'parts/semis.js', 'parts/examples-actuators.js', 'netlist.js', 'schematic.js', 'tests/viewaudit.js']) require('../js/' + f.replace('tests/', '../tests/'));
const { layout, toSvg } = globalThis.Schematic;
const A = globalThis.ViewAudit;
const E = globalThis.Examples;

function summarize(key, report) {
  return report.problems.map((p) => {
    if (p.kind === 'nets') return key + ' nets ' + p.pin + ' 2d[' + p.in2d.join(',') + '] sch[' + p.inSchematic.join(',') + ']';
    if (p.kind === 'misleading-name') return key + ' name ' + p.label + ' on ' + p.pins.join(',');
    if (p.kind === 'flag-unpowered') return key + ' flag ' + p.flag + ' on ' + p.pin + ' not powered in 2d [' + p.in2d.join(',') + ']';
    if (p.kind === 'flag-ungrounded') return key + ' flag GND on ' + p.pin;
    if (p.kind === 'nc-but-connected') return key + ' nc ' + p.pin;
    return key + ' ' + p.kind + ' ' + (p.part || p.pin || '');
  });
}

test('every example: drawn schematic matches breadboard connectivity', () => {
  const keys = E.LIST.map((row) => row[0]);
  assert.ok(keys.length >= 42, 'examples ' + keys.length);
  const problems = [];
  for (const key of keys) {
    const proj = E.EX[key]();
    let svg = '';
    try { svg = toSvg(layout(proj)); }
    catch (e) { problems.push(key + ' draw ' + e.message); continue; }
    const pins = (svg.match(/class="sch-pin"/g) || []).length;
    if (!pins) problems.push(key + ' schematic drew no pins');
    const report = A.auditProject(proj, svg);
    problems.push(...summarize(key, report));
  }
  assert.deepStrictEqual(problems, []);
});
