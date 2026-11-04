const test = require('node:test'); const assert = require('node:assert');
const { NetLog } = require('../js/netlog.js');
test('netlog: add, filter, errors-only, clear', () => {
  const n = new NetLog(); assert.ok(n.enabled);
  n.add({ k: 'wifi', msg: 'lwIP up 10.0.2.15', ts: 1.5 }); n.add({ k: 'http', msg: 'HTTP POST host:8080/sony/IRCC -> 200' });
  n.add({ k: 'udp', msg: 'UDP: no virtual device answered', ok: false });
  assert.strictEqual(n.rows.length, 3); assert.match(n.text(), /\+1\.500s WIFI/);
  n.filter = 'sony'; assert.strictEqual(n.visible().length, 1);
  n.filter = 'errors'; assert.strictEqual(n.visible().length, 1); assert.match(n.text(), /!! UDP/);
  n.filter = ''; n.clear(); assert.strictEqual(n.rows.length, 0);
});
test('netlog: disabled flag drops events', () => { const n = new NetLog(); n.enabled = false; n.add({ k: 'dns', msg: 'x' }); assert.strictEqual(n.rows.length, 0); });
