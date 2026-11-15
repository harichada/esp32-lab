const test = require('node:test'); const assert = require('node:assert');
const { ProjectStore } = require('../js/projects.js');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const ex = () => ({ name: 'Blink', example: 'blink', code: 'void setup(){}', parts: [{ id: 'ESP1', type: 'esp32', x: 0, y: 0 }], wires: [] });
test('copy of an example becomes a user project; example object untouched', () => {
  const s = new ProjectStore(mem(), null); const e = ex(); const c = s.copy(e);
  assert.ok(c.id && !c.example && c.copiedFrom === 'blink' && c.name === 'Blink (copy)');
  assert.strictEqual(e.example, 'blink'); assert.strictEqual(s.list().length, 1); assert.strictEqual(s.current(), c.id);
  assert.strictEqual(s.copy(e).name, 'Blink (copy 2)');
});
test('save/get/rename/duplicate/remove/export/import persist', () => {
  const ls = mem(); const s = new ProjectStore(ls, null); const c = s.copy(ex()); c.code += '// x'; s.save(c);
  const s2 = new ProjectStore(ls, null); assert.match(s2.get(c.id).code, /\/\/ x/);
  assert.ok(s2.rename(c.id, 'Mine')); assert.strictEqual(s2.get(c.id).name, 'Mine');
  const d = s2.duplicate(c.id); assert.strictEqual(s2.list().length, 2); assert.notStrictEqual(d.id, c.id);
  const i = s2.importJson(s2.exportJson(c.id)); assert.strictEqual(s2.get(i.id).code, s2.get(c.id).code);
  s2.remove(d.id); assert.strictEqual(s2.list().length, 2); assert.throws(() => s2.importJson('{"x":1}'));
});
test('a 429 holds the next projects request until Retry-After', async () => {
  const calls = [];
  let n = 0;
  const fetchFn = async () => {
    calls.push(Date.now());
    n += 1;
    if (n === 1) {
      return { ok: false, status: 429, headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.2' : null) }, json: async () => [] };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: 's1', name: 'Server' }] };
  };
  const s = new ProjectStore(mem(), fetchFn);
  const first = s.listServer();
  const second = s.listServer();
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(calls.length, 1);
  await first;
  await second;
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1] - calls[0] >= 180, 'second request left after ' + (calls[1] - calls[0]) + 'ms');
});
