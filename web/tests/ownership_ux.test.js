const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '../js/projects.js'), 'utf8');
const { ProjectStore, shouldSendBackup, BACKUP_MS } = require('../js/projects.js');

const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const proj = () => ({ name: 'View', parts: [{ id: 'ESP1', type: 'esp32' }] });
const headers = (map) => ({ get: (name) => map[String(name || '').toLowerCase()] || null });
const created = { status: 201, ok: true, headers: headers({}), json: async () => ({ id: 'srv1', secret: 'sek' }) };
const missing = { status: 404, ok: false, headers: headers({}), json: async () => ({ error: 'not found' }) };

test('the copy and lockout sentences are the ones learners see', () => {
  assert.match(appSrc, /Your copy is ready to edit\./);
  assert.match(appSrc, /This browser can't edit this project\. Open your edit link, or make your own copy\./);
  assert.match(appSrc, /Turn on Back up online to get an edit link\./);
  assert.match(appSrc, /Back up online/);
  assert.match(appSrc, /Anyone with the edit link can change it\./);
  assert.match(storeSrc, /Couldn't make your copy\. Please try again\./);
  assert.match(storeSrc, /To edit this on another device, copy your edit link and keep it somewhere safe\./);
  assert.match(storeSrc, /Saved on this device\. Online backup will try again shortly\./);
  assert.doesNotMatch(storeSrc, /Backup pending/);
  assert.match(appSrc, /Open an online backup…/);
  assert.match(appSrc, /Make a copy, or just start editing, to get your own version\./);
  assert.match(appSrc, /role="status"/);
  assert.match(appSrc, /aria-live="polite"/);
  assert.match(appSrc, /keepalive: true/);
  assert.doesNotMatch(appSrc, /sendBeacon/);
  assert.doesNotMatch(storeSrc, /sendBeacon/);
  assert.match(appSrc, /function beforeEdit\(\) \{ if \(app\.viewOnly\) \{ adoptViewOnly\(\); return; \}/);
  assert.match(appSrc, /\}, 600\);/);
  assert.equal(BACKUP_MS, 10000);
  const view = appSrc.match(/if \(app\.viewOnly\) b\.innerHTML = `([^`]+)`/);
  assert.ok(view, 'view-only banner');
  assert.match(view[1], /id="bShareLink"/);
  assert.doesNotMatch(view[1], /disabled/);
  assert.match(appSrc, /id="bShareLink" class="pb-act">Copy share link/);
});

test('a view-only edit is a local copy and never PUTs the original', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(((opts && opts.method) || 'GET') + ' ' + url);
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST') return created;
    if (method === 'PUT') return { status: 200, ok: true, headers: headers({}), json: async () => ({ id: 'should-not' }) };
    if (String(url).includes('/orig')) return { status: 200, ok: true, headers: headers({}), json: async () => ({ name: 'Orig', parts: [{ id: 'ESP1', type: 'esp32' }] }) };
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  await store.pullServer('orig');
  const seeded = store.get('orig');
  assert.equal(store.isViewOnly('orig'), true);
  const local = store.forkLocal(seeded);
  assert.notEqual(local.id, 'orig');
  assert.equal(store.isPutBlocked('orig'), true);
  assert.equal(calls.filter((c) => c.startsWith('PUT')).length, 0);
  store.serverSync = true;
  const sent = await store.flushBackup(local, { reason: 'save' });
  assert.equal(sent, true);
  assert.equal(calls.filter((c) => c.startsWith('PUT')).length, 0);
  assert.ok(calls.some((c) => c.startsWith('POST api/projects')));
  assert.equal(store.secretFor(store.current()), 'sek');
});

test('the first edit does not call the network until Back up online is flushed', async () => {
  let calls = 0;
  let puts = 0;
  const fetch = async (url, opts) => {
    calls += 1;
    const method = (opts && opts.method) || 'GET';
    if (method === 'PUT') { puts += 1; return { status: 200, ok: true, headers: headers({}), json: async () => ({ id: 'nope' }) }; }
    if (method === 'POST') return created;
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  store.serverSync = false;
  const local = store.forkLocal({ id: 'orig', name: 'View', parts: [{ id: 'ESP1', type: 'esp32' }] });
  assert.notEqual(local.id, 'orig');
  assert.equal(calls, 0);
  store.serverSync = true;
  await store.flushBackup(local, { reason: 'save' });
  assert.equal(puts, 0);
  assert.equal(calls, 1);
});

test('a 403 is not followed by another PUT of that id', async () => {
  let puts = 0;
  let posts = 0;
  const fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'PUT') {
      puts += 1;
      return { status: 403, ok: false, headers: headers({}), json: async () => ({ error: 'view_only', message: 'no' }) };
    }
    if (method === 'POST') {
      posts += 1;
      return created;
    }
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  store.serverSync = true;
  let clock = 0;
  store.now = () => clock;
  const notes = [];
  store.onPushError = (err) => notes.push(err.message);
  const id = store.save(Object.assign(proj(), { id: 'owned' }), { remote: false });
  store.rememberSecret(id, 'sek');
  await store.flushBackup(store.get(id), { reason: 'save' });
  assert.equal(puts, 1);
  assert.deepEqual(notes, ["This browser can't edit this project. Open your edit link, or make your own copy."]);
  clock += 10000;
  await store.flushBackup(store.get(id), { reason: 'save' });
  assert.equal(puts, 1);
  assert.equal(posts, 1);
});

test('server backup waits 10s and a hidden page sends one keepalive fetch', async () => {
  assert.equal(shouldSendBackup(0, 9999, 'timer'), false);
  assert.equal(shouldSendBackup(0, 10000, 'timer'), true);
  assert.equal(shouldSendBackup(5000, 6000, 'hide'), true);
  assert.equal(shouldSendBackup(5000, 6000, 'pagehide'), true);
  const calls = [];
  const timers = [];
  const fetch = async (url, opts) => {
    calls.push(opts || {});
    if ((opts || {}).method === 'POST') return created;
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  store.serverSync = true;
  let clock = 1000;
  store.now = () => clock;
  store.later = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  const sent = (method) => calls.filter((c) => c.method === method);
  const id = store.save(proj(), { remote: false, dirty: false });
  await store.flushBackup(store.get(id), { reason: 'hide', keepalive: true });
  assert.equal(calls.length, 0);
  const edited = store.get(id);
  edited.name = 'Edited';
  store.save(edited, { remote: false });
  store.scheduleBackup(store.get(id));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
  assert.equal(sent('POST').length, 0);
  store.scheduleBackup(store.get(id));
  assert.equal(timers.length, 1);
  clock += 10000;
  await timers[0].fn();
  assert.equal(sent('POST').length, 1);
  assert.equal(sent('PUT').length, 0);
  const again = store.get(store.current());
  again.name = 'Leaving';
  store.save(again, { remote: false });
  clock += 1000;
  await store.flushBackup(store.get(again.id), { reason: 'hide', keepalive: true });
  assert.equal(sent('PUT').length, 1);
  assert.equal(sent('PUT')[0].keepalive, true);
});

test('a 429 keeps the local project, shows the quiet status, and retries once', async () => {
  let posts = 0;
  const fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST') {
      posts += 1;
      if (posts === 1) {
        return { status: 429, ok: false, headers: headers({ 'retry-after': '1' }), json: async () => ({ error: 'rate_limit' }) };
      }
      return { status: 201, ok: true, headers: headers({}), json: async () => ({ id: 'srv9', secret: 'sek' }) };
    }
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  store.serverSync = true;
  store.jitter = () => 0.25;
  const pending = [];
  store.later = (fn, ms) => { pending.push({ fn, ms }); return 0; };
  const alarms = [];
  store.onPushError = (err) => alarms.push(err && err.code);
  const id = store.save(proj(), { remote: false });
  const result = await store.flushBackup(store.get(id), { reason: 'save' });
  assert.equal(result, false);
  assert.equal(posts, 1);
  assert.equal(store.backupNote, 'Saved on this device. Online backup will try again shortly.');
  assert.equal(store.get(id).name, 'View');
  assert.equal(alarms.length, 0);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ms, 1250);
  await pending[0].fn();
  assert.equal(posts, 2);
  assert.equal(store.secretFor('srv9'), 'sek');
  assert.equal(store.get('srv9').name, 'View');
  assert.equal(store.backupNote, '');
  assert.equal(pending.length, 1);
});

test('two consecutive 429s make exactly 2 requests and then stop', async () => {
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return { status: 429, ok: false, headers: headers({ 'retry-after': '1' }), json: async () => ({ error: 'rate_limit' }) };
  };
  const store = new ProjectStore(mem(), fetch);
  store.serverSync = true;
  store.jitter = () => 0;
  const pending = [];
  store.later = (fn, ms) => { pending.push({ fn, ms }); return 0; };
  const id = store.save(proj(), { remote: false });
  await store.flushBackup(store.get(id), { reason: 'save' });
  const retries = () => pending.filter((item) => item.ms < 5000);
  assert.equal(requests, 1);
  assert.equal(retries().length, 1);
  await retries()[0].fn();
  let guard = 0;
  while (retries().length > 1 && guard < 5) {
    const extra = retries()[1];
    pending.splice(pending.indexOf(extra), 1);
    await extra.fn();
    guard += 1;
  }
  assert.equal(requests, 2);
  assert.equal(retries().length, 1);
  assert.equal(store.backupNote, 'Saved on this device. Online backup will try again shortly.');
  assert.equal(store.get(id).name, 'View');
});

test('the edit-link reminder is stored once', async () => {
  const ls = mem();
  const fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      return { status: 201, ok: true, headers: headers({}), json: async () => ({ id: 's' + Math.random().toString(36).slice(2), secret: 'sek' }) };
    }
    return missing;
  };
  const notes = [];
  const store = new ProjectStore(ls, fetch);
  store.serverSync = true;
  store.onEditLinkHint = (msg) => notes.push(msg);
  await store.flushBackup(store.get(store.save(proj(), { remote: false })), { reason: 'save' });
  await store.flushBackup(store.get(store.save(proj(), { remote: false })), { reason: 'save' });
  const again = new ProjectStore(ls, fetch);
  again.serverSync = true;
  again.onEditLinkHint = (msg) => notes.push(msg);
  await again.flushBackup(again.get(again.save(proj(), { remote: false })), { reason: 'save' });
  assert.deepEqual(notes, ['To edit this on another device, copy your edit link and keep it somewhere safe.']);
});
