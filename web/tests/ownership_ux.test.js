const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '../js/projects.js'), 'utf8');
const { ProjectStore, shouldSendBackup, BACKUP_MS, shareControls, shareFailMessage, SHARE_WAIT, SHARE_FAIL, SHARE_BUSY, BACKUP_WAIT, BAD_LINK } = require('../js/projects.js');

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
  assert.match(storeSrc, /Anyone with the edit link can change it\./);
  assert.match(storeSrc, /Couldn't make your copy\. Please try again\./);
  assert.match(storeSrc, /To edit this on another device, copy your edit link and keep it somewhere safe\./);
  assert.match(storeSrc, /Lots of people on your network are saving right now\. Wait a few seconds and try again; your changes are still here\./);
  assert.match(storeSrc, /Too many people on your network are backing up right now\. Try again in a few seconds\./);
  assert.doesNotMatch(storeSrc, /Saved on this device\. Online backup will try again shortly\./);
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
  assert.match(view[1], /Copy link \(view only\)/);
  assert.match(appSrc, /id="bShareLink" class="pb-act">Copy link \(view only\)/);
  assert.match(storeSrc, /Copy link \(others can edit\)/);
  const owned = shareControls({ backedUp: true, canEdit: true, reasonId: 'shareWait', warnId: 'editLinkWarn', shareAttrs: 'id="bShareLink" class="pb-act"', editAttrs: 'id="bEditLink" class="pb-act"', goAttrs: 'id="bBackupCopy" class="primary"' });
  assert.ok(owned.indexOf('id="bShareLink"') < owned.indexOf('id="bEditLink"'));
  assert.ok(owned.indexOf('id="bEditLink"') < owned.indexOf('editLinkWarn'));
  assert.match(owned, /aria-describedby="editLinkWarn"/);
  assert.match(appSrc, /class="pn-name" title="\$\{nm\}" aria-label="\$\{nm\}"/);
  assert.match(appSrc, /data-a="share"/);
  assert.match(appSrc, /data-a="backupcopy"/);
  assert.ok(appSrc.indexOf("shareAttrs: 'data-a=\"share\"") < appSrc.indexOf("editAttrs: 'data-a=\"editlink\""));
  assert.match(appSrc, /This is your copy\./);
  assert.match(appSrc, /Examples can't be changed, so we made you a copy: \$\{app\.proj\.name\}\. It's in My Projects\./);
  assert.match(appSrc, /setTimeout\(\(\) => \{ el\.textContent = ''; \}, 4000\)/);
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
  assert.equal(store.backupNote, BACKUP_WAIT);
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
  assert.equal(store.backupNote, BACKUP_WAIT);
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

const bannerOpts = {
  reasonId: 'shareWait',
  warnId: 'editLinkWarn',
  shareAttrs: 'id="bShareLink" class="pb-act"',
  editAttrs: 'id="bEditLink" class="pb-act"',
  goAttrs: 'id="bBackupCopy" class="primary"',
};

test('copy is disabled with its reason when there is no backup', () => {
  const html = shareControls(Object.assign({ backedUp: false, canEdit: false }, bannerOpts));
  assert.match(html, /id="bShareLink"[^>]*aria-disabled="true"/);
  assert.match(html, /id="bEditLink"[^>]*aria-disabled="true"/);
  assert.match(html, /aria-describedby="shareWait"/);
  assert.match(html, new RegExp(SHARE_WAIT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /Back up online and copy link/);
  assert.equal(SHARE_WAIT, 'Turn on Back up online to share this project.');
  assert.doesNotMatch(html, /share-warn/);
});

test('the edit warning never shows while the edit button is disabled', () => {
  const local = shareControls(Object.assign({ backedUp: false, canEdit: false }, bannerOpts));
  const view = shareControls(Object.assign({ backedUp: true, canEdit: false }, bannerOpts));
  const owned = shareControls(Object.assign({ backedUp: true, canEdit: true }, bannerOpts));
  assert.match(local, /id="bEditLink"[^>]*aria-disabled="true"/);
  assert.match(view, /id="bEditLink"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(local, /share-warn/);
  assert.doesNotMatch(view, /share-warn/);
  assert.match(owned, /share-warn/);
  assert.doesNotMatch(owned, /aria-disabled/);
  assert.match(appSrc, /setAttribute\('aria-label', name\)/);
  assert.match(appSrc, /pt\.title = name/);
});

test('a successful backup-and-copy yields a link that returns 200', async () => {
  const files = {};
  let posts = 0;
  const fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST') {
      posts += 1;
      const id = 'srv200';
      files[id] = JSON.parse(opts.body);
      return { status: 201, ok: true, headers: headers({}), json: async () => ({ id, secret: 'sek' }) };
    }
    const id = decodeURIComponent(String(url).split('/').pop());
    if (files[id]) return { status: 200, ok: true, headers: headers({}), json: async () => files[id] };
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  assert.equal(store.serverSync, false);
  const id = store.save(proj(), { remote: false });
  assert.equal(store.canShare(id), false);
  const url = await store.backupAndShare(store.get(id), 'http://lab.test/lab');
  assert.equal(posts, 1);
  assert.equal(store.serverSync, true);
  const pid = new URL(url).searchParams.get('p');
  const got = await fetch('api/projects/' + pid);
  assert.equal(got.status, 200);
  assert.equal(store.secretFor(pid), 'sek');
});

test('a failed backup copies nothing and leaves the checkbox off', async () => {
  const fetch = async () => ({ status: 503, ok: false, headers: headers({ 'retry-after': '60' }), json: async () => ({ error: 'down' }) });
  const store = new ProjectStore(mem(), fetch);
  const id = store.save(proj(), { remote: false });
  let copied = null;
  try {
    copied = await store.backupAndShare(store.get(id), 'http://lab.test/lab');
  } catch (err) {
    assert.equal(shareFailMessage(err), SHARE_FAIL);
    copied = null;
  }
  assert.equal(copied, null);
  assert.equal(store.serverSync, false);
  assert.equal(store.canShare(id), false);
  assert.equal(shareFailMessage({ code: 'rate_limit', retryAfter: 4 }), SHARE_BUSY);
  assert.equal(SHARE_BUSY, 'Too many people on your network are backing up right now. Try again in a few seconds.');
});

test('a backup-and-copy 429 copies nothing, keeps the edits, and does not retry', async () => {
  let posts = 0;
  const fetch = async () => {
    posts += 1;
    return { status: 429, ok: false, headers: headers({ 'retry-after': '4' }), json: async () => ({ error: 'rate_limit' }) };
  };
  const store = new ProjectStore(mem(), fetch);
  const id = store.save(Object.assign(proj(), { name: 'Still here' }), { remote: false });
  let copied = 'untouched';
  try {
    copied = await store.backupAndShare(store.get(id), 'http://lab.test/lab');
  } catch (err) {
    assert.equal(err.code, 'rate_limit');
    assert.equal(err.retryAfter, 4);
    assert.equal(shareFailMessage(err), SHARE_BUSY);
    copied = null;
  }
  assert.equal(copied, null);
  assert.equal(posts, 1);
  assert.equal(store.get(id).name, 'Still here');
  assert.equal(store.serverSync, false);
  assert.equal(store.canShare(id), false);
});

test('a double tap creates exactly one project', async () => {
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = async (url, opts) => {
    if ((opts || {}).method === 'POST') {
      posts += 1;
      await gate;
      return { status: 201, ok: true, headers: headers({}), json: async () => ({ id: 'only1', secret: 'sek' }) };
    }
    return missing;
  };
  const store = new ProjectStore(mem(), fetch);
  const id = store.save(proj(), { remote: false });
  const saved = store.get(id);
  const first = store.backupAndShare(saved, 'http://lab.test/lab');
  const second = store.backupAndShare(saved, 'http://lab.test/lab');
  assert.equal(first, second);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(posts, 1);
  assert.equal(left, right);
  assert.equal(new URL(left).searchParams.get('p'), 'only1');
});

test('a missing project and an invalid id show the same recipient notice', () => {
  assert.equal(BAD_LINK, "This project link doesn't work. Ask the person who sent it to share it again.");
  const fn = appSrc.slice(appSrc.indexOf('async function rejectProjectLink'), appSrc.indexOf('function announce'));
  assert.match(fn, /showBadLink\(\)/);
  assert.match(fn, /loadExample\('blink'\)/);
  assert.match(appSrc, /textContent = Projects\.BAD_LINK/);
  assert.match(appSrc, /setAttribute\('role', 'alert'\)/);
  assert.doesNotMatch(appSrc.slice(appSrc.indexOf('function showBadLink'), appSrc.indexOf('async function rejectProjectLink')), /innerHTML/);
  const start = appSrc.slice(appSrc.indexOf('if (pid)'), appSrc.indexOf("if (q && Examples.EX[q])"));
  assert.equal(start.split('rejectProjectLink()').length - 1, 3);
  assert.match(appSrc, /class="backup-row"/);
  assert.match(fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8'), /min-width:12ch/);
  assert.match(fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8'), /text-overflow:ellipsis/);
});
