const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

function lampStore() {
  global.localStorage = mem();
  global.sessionStorage = mem();
  global.localStorage.setItem('esp32lab.projects.v1', JSON.stringify({ p1: entry('p1', 'Lamp', 4) }));
}

test('the attempt flag is set only after a verified receipt, and a retry works', async () => {
  lampStore();
  global.sessionStorage.setItem('cl_migrate_attempt', '1');
  const seen = [];
  global.location = {
    origin: 'http://127.0.0.1:9',
    replace(url) { seen.push(url); },
  };
  let posts = 0;
  await mig.handoff({
    target: 'http://localhost:9',
    path: '/lab',
    query: 'a=1',
    timeout: 50,
    post() {
      posts += 1;
      return Promise.reject(new Error('network'));
    },
  });
  assert.strictEqual(posts, 1);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(global.sessionStorage.getItem('cl_migrate_attempt'), '1');
  assert.strictEqual(global.localStorage.getItem('cl_migrated_to_https'), null);
  assert.ok(global.localStorage.getItem('esp32lab.projects.v1').includes('Lamp'));
  await mig.handoff({
    target: 'http://localhost:9',
    path: '/lab',
    query: 'a=1',
    async post(body) {
      posts += 1;
      return { ok: true, count: 1, checksum: await mig.sha256Hex(body) };
    },
  });
  assert.strictEqual(posts, 2);
  assert.match(global.sessionStorage.getItem('cl_migrate_attempt'), /^[0-9a-f]{64}$/);
  assert.match(global.localStorage.getItem('cl_migrated_to_https'), /^[0-9]+$/);
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].startsWith('http://localhost:9/lab?'));
  assert.ok(seen[0].includes('moved=1'));
  assert.ok(!seen[0].includes('#'));
  assert.ok(!seen[0].includes('Lamp'));
  assert.ok(!seen[0].includes('esp32lab.projects'));
  const again = seen.length;
  await mig.handoff({ target: 'http://localhost:9', path: '/lab', query: 'a=1' });
  assert.strictEqual(seen.length, again + 1);
  assert.strictEqual(seen[again], 'http://localhost:9/lab?a=1');
  assert.ok(global.localStorage.getItem('esp32lab.projects.v1').includes('Lamp'));
});

test('a checksum mismatch or a timeout does not set the attempt flag', async () => {
  lampStore();
  const seen = [];
  global.location = { origin: 'http://127.0.0.1:9', replace(url) { seen.push(url); } };
  await mig.handoff({
    target: 'http://localhost:9',
    path: '/',
    query: '',
    async post() { return { ok: true, count: 1, checksum: '0'.repeat(64) }; },
  });
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(global.sessionStorage.getItem('cl_migrate_attempt'), null);
  assert.strictEqual(global.localStorage.getItem('cl_migrated_to_https'), null);
  await mig.handoff({
    target: 'http://localhost:9',
    path: '/',
    query: '',
    timeout: 30,
    post() { return new Promise(() => {}); },
  });
  assert.strictEqual(global.sessionStorage.getItem('cl_migrate_attempt'), null);
  assert.ok(global.localStorage.getItem('esp32lab.projects.v1').includes('Lamp'));
});

test('a second submit of the same projects does not create another copy', () => {
  const store = mem();
  const projects = { p1: entry('p1', 'Lamp', 4) };
  const obj = record(projects);
  assert.strictEqual(mig.applyBundle(obj, store), 1);
  assert.strictEqual(mig.applyBundle(obj, store), 0);
  const saved = JSON.parse(store.getItem('esp32lab.projects.v1'));
  assert.strictEqual(Object.keys(saved).length, 1);
  assert.strictEqual(saved.p1.name, 'Lamp');
});

test('more than 64 projects is rejected and an oversized body is not posted', async () => {
  const projects = {};
  for (let i = 0; i < 65; i++) projects['p' + i] = entry('p' + i, 'N', 1);
  assert.strictEqual(mig.validate(record(projects)), 'too many projects');
  const ok = {};
  for (let i = 0; i < 64; i++) ok['p' + i] = entry('p' + i, 'N', 1);
  assert.strictEqual(mig.validate(record(ok)), '');
  lampStore();
  const chunk = 'x'.repeat(1100000);
  global.localStorage.setItem('esp32lab.theme', chunk);
  global.localStorage.setItem('esp32lab.flow', chunk);
  const seen = [];
  global.location = { origin: 'http://127.0.0.1:9', replace(url) { seen.push(url); } };
  let posted = false;
  await mig.handoff({
    target: 'http://localhost:9',
    path: '/',
    query: '',
    post() { posted = true; return Promise.resolve({ ok: false }); },
  });
  assert.strictEqual(posted, false);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(global.sessionStorage.getItem('cl_migrate_attempt'), null);
  assert.strictEqual(global.localStorage.getItem('esp32lab.theme'), chunk);
});

test('plain http can hash the payload the same way the server does', async () => {
  const saved = global.crypto;
  const samples = ['', 'abc', '{"a":1,"b":"Lamp"}'];
  try {
    for (const sample of samples) {
      const viaPlatform = await mig.sha256Hex(sample);
      global.crypto = undefined;
      const viaPage = await mig.sha256Hex(sample);
      global.crypto = saved;
      assert.strictEqual(viaPage, viaPlatform);
    }
  } finally {
    global.crypto = saved;
  }
  global.crypto = undefined;
  try {
    assert.strictEqual(await mig.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.strictEqual(await mig.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    global.crypto = saved;
  }
});

test('the move posts the body and never puts project data in a url', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/migrate.js'), 'utf8');
  assert.ok(!src.includes("'/migrate#'"));
  assert.ok(!src.includes('location.hash'));
  assert.ok(!src.includes('__clMove'));
  lampStore();
  const seen = [];
  global.location = {
    origin: 'http://127.0.0.1:9',
    pathname: '/',
    search: '',
    replace(url) { seen.push(String(url)); },
  };
  const created = [];
  global.document = {
    body: { appendChild() {} },
    createElement() {
      const el = {
        style: {},
        children: [],
        appendChild(child) { this.children.push(child); },
        submit() { this.submitted = true; },
      };
      created.push(el);
      return el;
    },
  };
  global.addEventListener = () => {};
  global.removeEventListener = () => {};
  try {
    await mig.handoff({ target: 'http://localhost:9', path: '/lab', query: 'a=1', timeout: 40 });
  } finally {
    delete global.document;
    delete global.addEventListener;
    delete global.removeEventListener;
  }
  const form = created.find((el) => el.method === 'POST');
  assert.ok(form);
  assert.strictEqual(form.action, 'http://localhost:9/migrate');
  assert.strictEqual(form.target, 'cl-move-frame');
  assert.ok(form.submitted);
  assert.ok(!form.action.includes('#'));
  assert.ok(!form.action.includes('Lamp'));
  const input = form.children[0];
  assert.strictEqual(input.name, 'payload');
  assert.ok(input.value.includes('Lamp'));
  assert.ok(!JSON.stringify(seen).includes('Lamp'));
  assert.ok(!JSON.stringify(seen).includes('#'));
  assert.strictEqual(global.sessionStorage.getItem('cl_migrate_attempt'), null);
  assert.ok(global.localStorage.getItem('esp32lab.projects.v1').includes('Lamp'));
});
