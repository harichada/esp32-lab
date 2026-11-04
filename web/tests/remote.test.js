const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const R = require('../js/remote_logic.js');
require('../js/devices.js');
const D = globalThis.Devices;
// native test captures (C++ remote_logic.h through the real HTTP/UDP stack against mock servers)
const capPath = path.join(__dirname, '../../tests/out/captured.jsonl');
const cap = fs.existsSync(capPath) ? Object.fromEntries(fs.readFileSync(capPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => [e.tag, e])) : null;
const keys = R.KEYMAP.flat().filter(Boolean);

test('captures available', () => { assert.ok(cap, 'missing ' + capPath); });
test('TV-mode keys produce exactly the native-test HTTP requests', () => {
  for (const k of keys) {
    if (k === 'Mode') continue;
    const c = R.keyCommand(k, false), e = cap['tv/' + k];
    assert.ok(e, 'no capture for ' + k);
    if (c.kind === 'SONY_POWER') { assert.strictEqual(e.path, '/sony/system'); assert.strictEqual(R.sonyPowerBody(c.on), e.body, k); assert.strictEqual(e.ctype, 'application/json'); assert.ok(e.psk); }
    else if (c.kind === 'SONY_IRCC') { assert.strictEqual(e.path, '/sony/IRCC'); assert.strictEqual(R.sonyIrccBody(c.arg), e.body, k); assert.strictEqual(e.ctype, R.SONY_IRCC_CTYPE); assert.ok(e.soap && e.psk); }
    else if (c.kind === 'ROKU') { assert.strictEqual(e.path, '/keypress/' + c.arg, k); }
    else if (c.kind === 'ECO') { assert.ok(e, 'eco'); }
  }
});
test('Roku-mode arrows go to Roku ECP, back to TV after Mode', () => {
  for (const k of ['Up', 'Down', 'Left', 'Right']) {
    const c = R.keyCommand(k, true); assert.strictEqual(c.kind, 'ROKU'); assert.strictEqual(cap['roku/' + k].path, '/keypress/' + k);
    const t = R.keyCommand(k, false); assert.strictEqual(R.sonyIrccBody(t.arg), cap['tv2/' + k].body);
  }
});
test('Eco legacy packets byte-identical to native captures', () => {
  const q = R.ecoLegacyPacket('ECO-12345678', false, false, 0x4242, 1000);
  assert.strictEqual(R.hex(q), cap['eco_legacy/0/query'].hex);
  const w = R.ecoLegacyPacket('ECO-12345678', true, true, 0x4343, 1001);
  assert.strictEqual(R.hex(w), cap['eco_legacy/0/write'].hex);
  const w0 = R.ecoLegacyPacket('ECO-12345678', true, false, 0x4343, 1001);
  assert.strictEqual(R.hex(w0), cap['eco_legacy/1/write'].hex);
});
test('SIRC frame timing and decode round-trip', () => {
  for (const code of [0x750, 0xF50, 0xA90, 0x490]) {
    const f = R.sircEncodeFrame(code);
    assert.strictEqual(f.length, 13); assert.strictEqual(f[0][0], 2400);
    assert.strictEqual(f.reduce((s, [m, sp]) => s + m + sp, 0), 45000 + 0, 'frame start-to-start 45 ms');
    assert.strictEqual(R.sircDecode(f.map((x) => x[0])), code);
  }
});
test('mock devices: PSK mismatch -> 403, TV fully off -> no answer, IR power-on wakes', () => {
  const d = new D.MockWorld();
  d.tv.power = 'off'; d.tv.networkStandby = false;
  const req = (url, headers, body) => d.http({ k: 'http', method: 'POST', url, headers, body });
  assert.strictEqual(req('http://192.168.1.50/sony/system', { 'X-Auth-PSK': '0000', 'Content-Type': 'application/json' }, R.sonyPowerBody(true)).code, -1, 'fully off: no network');
  d.ir(0x750); assert.strictEqual(d.tv.power, 'on', 'IR wakes');
  assert.strictEqual(req('http://192.168.1.50/sony/IRCC', { 'X-Auth-PSK': '9999', SOAPACTION: R.SONY_IRCC_SOAPACTION }, R.sonyIrccBody(R.IRCC['Vol+'])).code, 403);
  const v0 = d.tv.volume;
  assert.strictEqual(req('http://192.168.1.50/sony/IRCC', { 'X-Auth-PSK': '0000', SOAPACTION: R.SONY_IRCC_SOAPACTION }, R.sonyIrccBody(R.IRCC['Vol+'])).code, 200);
  assert.strictEqual(d.tv.volume, v0 + 1);
  d.tv.power = 'off'; d.tv.networkStandby = true;
  assert.strictEqual(req('http://192.168.1.50/sony/system', { 'X-Auth-PSK': '0000' }, R.sonyPowerBody(true)).code, 200);
  assert.strictEqual(d.tv.power, 'on', 'network standby allows Wi-Fi power on');
  assert.strictEqual(req('http://192.168.1.60:8060/keypress/Home', {}, '').code, 200);
  const r = d.udp({ k: 'udp', dst: '192.168.1.70', dport: 80, sport: 9, hex: R.hex(R.ecoLegacyPacket('ECO-12345678', true, true, 7, 1)) });
  assert.ok(d.eco.on && r && r.length === 1, 'legacy eco on + reply');
  d.udp({ k: 'udp', dst: '10.13.37.2', dport: 1022, sport: 9090, hex: R.hex(R.kabBuildFixed(false, 1234)) });
  assert.ok(!d.eco.on, 'KAB fixed-body off');
});
