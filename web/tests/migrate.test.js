const test = require('node:test');
const assert = require('node:assert');

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => Array.from(m.keys())[i],
    get length() { return m.size; },
  };
}

global.localStorage = mem();
global.sessionStorage = mem();
const mig = require('../js/migrate.js');

function entry(id, name, updated, extra) {
  return {
    id: id,
    name: name,
    updated: updated,
    proj: Object.assign({ id: id, name: name, parts: [], wires: [] }, extra || {}),
  };
}

function record(projects) {
  return {
    v: 1,
    origin: 'http://127.0.0.1:9',
    exportedAt: 10,
    path: '/',
    query: '',
    items: [{ k: 'esp32lab.projects.v1', v: JSON.stringify(projects) }],
  };
}

test('the post cap is 2 MB and each project is checked before a merge', () => {
  assert.strictEqual(mig.BODY_CAP, 2 * 1024 * 1024);
  const projects = { p1: entry('p1', 'Lamp', 1, { blob: 'x'.repeat(mig.PROJECT_CAP) }) };
  assert.strictEqual(mig.validate(record(projects)), 'bad project');
  assert.strictEqual(mig.validate(record({ p1: entry('p1', 'Lamp', 1) })), '');
  assert.strictEqual(mig.validate({ v: 2, origin: 'http://127.0.0.1', exportedAt: 1, path: '/', query: '', items: [] }), 'unsupported version');
});

test('a collision keeps the https project and imports one moved copy', () => {
  const local = { p1: entry('p1', 'Already here', 3) };
  const incoming = { p1: entry('p1', 'From HTTP', 9) };
  const merged = mig.mergeProjects(JSON.stringify(local), JSON.stringify(incoming));
  const out = JSON.parse(merged.json);
  assert.strictEqual(out.p1.name, 'Already here');
  assert.strictEqual(out.p1.updated, 3);
  const copies = Object.values(out).filter((item) => item.name.indexOf('(moved copy)') !== -1);
  assert.strictEqual(copies.length, 1);
  assert.strictEqual(copies[0].name, 'From HTTP (moved copy)');
  assert.notStrictEqual(copies[0].id, 'p1');
  assert.strictEqual(merged.imported, 1);
});

test('an identical project is kept once and a newer timestamp is kept', () => {
  const local = { p1: entry('p1', 'Lamp', 3) };
  const incoming = { p1: entry('p1', 'Lamp', 9) };
  const merged = mig.mergeProjects(JSON.stringify(local), JSON.stringify(incoming));
  const out = JSON.parse(merged.json);
  assert.strictEqual(Object.keys(out).length, 1);
  assert.strictEqual(out.p1.updated, 9);
  assert.strictEqual(merged.imported, 0);
});

test('applyBundle writes the https copy and does not delete the source record', () => {
  const httpsStore = mem();
  httpsStore.setItem('esp32lab.theme', 'dark');
  const httpStore = mem();
  const projects = { p1: entry('p1', 'Lamp', 4) };
  httpStore.setItem('esp32lab.projects.v1', JSON.stringify(projects));
  const obj = record(projects);
  obj.items.push({ k: 'esp32lab.theme', v: 'light' });
  assert.strictEqual(mig.applyBundle(obj, httpsStore), 1);
  assert.strictEqual(httpsStore.getItem('esp32lab.theme'), 'dark');
  assert.ok(httpsStore.getItem('esp32lab.projects.v1').includes('Lamp'));
  assert.strictEqual(httpStore.getItem('esp32lab.projects.v1'), JSON.stringify(projects));
});

test('pack and unpack round-trip under the fragment budget', async () => {
  const obj = record({ p1: entry('p1', 'Lamp', 4) });
  const packed = await mig.pack(obj);
  assert.ok(packed.startsWith('0.') || packed.startsWith('1.'));
  assert.ok(packed.length <= mig.FRAGMENT_BUDGET);
  const back = await mig.unpack(packed);
  assert.strictEqual(back.items[0].k, 'esp32lab.projects.v1');
  assert.ok(back.items[0].v.includes('Lamp'));
});

test('the http flag is set only by finish, and a set flag skips another export', async () => {
  global.localStorage = mem();
  global.sessionStorage = mem();
  global.localStorage.setItem('esp32lab.projects.v1', JSON.stringify({ p1: entry('p1', 'Lamp', 4) }));
  const seen = [];
  global.location = {
    origin: 'http://127.0.0.1:9',
    replace(url) { seen.push(url); },
  };
  await mig.handoff({ target: 'http://localhost:9', path: '/lab', query: 'a=1' });
  assert.ok(seen[0].startsWith('http://localhost:9/migrate#'));
  assert.strictEqual(global.localStorage.getItem('cl_migrated_to_https'), null);
  assert.ok(global.localStorage.getItem('esp32lab.projects.v1').includes('Lamp'));
  mig.finish({ flag: true, back: 'http://localhost:9/lab?moved=1', target: 'http://localhost:9' });
  const flag = global.localStorage.getItem('cl_migrated_to_https');
  assert.match(flag, /^[0-9]+$/);
  seen.length = 0;
  await mig.handoff({ target: 'http://localhost:9', path: '/lab', query: 'a=1' });
  assert.strictEqual(seen[0], 'http://localhost:9/lab?a=1');
  assert.ok(!seen[0].includes('#'));
});
