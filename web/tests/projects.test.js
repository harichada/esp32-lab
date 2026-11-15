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
test('a failed save leaves storage and the unsaved id untouched', () => {
  const raw = mem();
  const s = new ProjectStore(raw, null);
  const first = s.copy(ex());
  first.code = 'kept';
  s.save(first);
  const before = raw.getItem('esp32lab.projects.v1');
  const cur = raw.getItem('esp32lab.current.v1');
  const notes = [];
  global.onStorageFull = (e) => notes.push(e && e.name);
  const deny = {
    getItem: (k) => raw.getItem(k),
    setItem() { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: (k) => raw.removeItem(k),
  };
  const full = new ProjectStore(deny, null);
  const edited = full.get(first.id);
  edited.code = 'not written';
  assert.throws(() => full.save(edited), (e) => e.name === 'QuotaExceededError');
  assert.deepStrictEqual(notes, ['QuotaExceededError']);
  assert.strictEqual(raw.getItem('esp32lab.projects.v1'), before);
  assert.strictEqual(raw.getItem('esp32lab.current.v1'), cur);
  assert.strictEqual(JSON.parse(before)[first.id].proj.code, 'kept');
  assert.strictEqual(edited.code, 'not written');
  const fresh = { name: 'New', code: 'void setup(){/* new */}', parts: [], wires: [] };
  notes.length = 0;
  deny.setItem = () => { throw new Error('disk'); };
  assert.throws(() => full.save(fresh), /disk/);
  assert.strictEqual(fresh.id, undefined);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(raw.getItem('esp32lab.projects.v1'), before);
  delete global.onStorageFull;
});
test('a current-pointer failure rolls the project blob back', () => {
  const raw = mem();
  const s = new ProjectStore(raw, null);
  const first = s.copy(ex());
  const before = raw.getItem('esp32lab.projects.v1');
  const cur = raw.getItem('esp32lab.current.v1');
  const ls = {
    getItem: (k) => raw.getItem(k),
    setItem(k, v) {
      if (k === 'esp32lab.current.v1') throw new Error('cur');
      raw.setItem(k, v);
    },
    removeItem: (k) => raw.removeItem(k),
  };
  const broken = new ProjectStore(ls, null);
  const edited = broken.get(first.id);
  edited.code = 'nope';
  assert.throws(() => broken.save(edited), /cur/);
  assert.strictEqual(raw.getItem('esp32lab.projects.v1'), before);
  assert.strictEqual(raw.getItem('esp32lab.current.v1'), cur);
  assert.strictEqual(JSON.parse(before)[first.id].proj.code.includes('nope'), false);
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
test('an account project opens as a local copy and keeps a different local project', () => {
  const s = new ProjectStore(mem(), null);
  const local = s.copy(ex());
  local.name = 'Desk lamp';
  local.code = 'local-sketch';
  s.save(local);
  const same = s.adoptAccount({ id: local.id, name: 'Desk lamp', code: 'local-sketch', parts: local.parts, wires: [] });
  assert.strictEqual(same.id, local.id);
  assert.strictEqual(s.list().length, 1);
  const other = s.adoptAccount({ id: local.id, name: 'Desk lamp', code: 'account-sketch', parts: [{ id: 'r1', type: 'resistor' }], wires: [] });
  assert.notStrictEqual(other.id, local.id);
  assert.strictEqual(other.name, 'Desk lamp (copy)');
  assert.strictEqual(s.get(local.id).code, 'local-sketch');
  assert.strictEqual(s.get(other.id).code, 'account-sketch');
  assert.strictEqual(s.list().length, 2);
  const named = s.adoptAccount({ id: 'fresh', name: 'Desk lamp', code: 'third', parts: [{ id: 'r2' }], wires: [] });
  assert.strictEqual(named.name, 'Desk lamp (copy 2)');
  assert.strictEqual(s.get(local.id).name, 'Desk lamp');
});
