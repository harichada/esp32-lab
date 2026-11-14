const test = require('node:test');
const assert = require('node:assert');
const { ProjectStore } = require('../js/projects.js');
const S = require('../js/schematic.js');

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
function proj(extra) {
  return Object.assign({ name: 'Blink', parts: [{ id: 'ESP1', type: 'esp32', x: 0, y: 0 }], wires: [] }, extra || {});
}

test('Duplicate carries an explicit layout choice and leaves a missing choice unset', () => {
  const ls = mem();
  const store = new ProjectStore(ls, null);
  const saved = store.copy(proj({ example: 'blink' }));
  assert.equal(ls.getItem('esp32lab.schLayout.' + saved.id), null);
  assert.equal(S.layoutModeOf({ id: saved.id }, ls), 'tidy');
  ls.setItem('esp32lab.schLayout.' + saved.id, 'board');
  const dup = store.duplicate(saved.id);
  assert.notEqual(dup.id, saved.id);
  assert.equal(ls.getItem('esp32lab.schLayout.' + dup.id), 'board');
  assert.equal(ls.getItem('esp32lab.schLayout.' + saved.id), 'board');
  assert.equal(store.get(dup.id).schLayout, undefined);
  ls.setItem('esp32lab.schLayout.' + saved.id, 'tidy');
  const tidy = store.duplicate(saved.id);
  assert.equal(ls.getItem('esp32lab.schLayout.' + tidy.id), 'tidy');
  const plain = store.copy(proj({ example: 'button', name: 'Button' }));
  assert.equal(ls.getItem('esp32lab.schLayout.' + plain.id), null);
  assert.equal(S.layoutModeOf({ id: plain.id }, ls), 'tidy');
});

test('Import carries schLayout and ignores a missing or invalid value', () => {
  const ls = mem();
  const store = new ProjectStore(ls, null);
  ls.setItem('esp32lab.schLayout.draft.dkeep', 'board');
  ls.setItem('esp32lab.schLayout.draftIndex', JSON.stringify(['dkeep']));
  const board = store.importJson(proj({ schLayout: 'board', draftId: 'dkeep', name: 'Board' }));
  assert.equal(ls.getItem('esp32lab.schLayout.' + board.id), 'board');
  assert.equal(store.get(board.id).schLayout, undefined);
  assert.equal(store.get(board.id).draftId, undefined);
  assert.equal(ls.getItem('esp32lab.schLayout.draft.dkeep'), 'board');
  const tidy = store.importJson(JSON.stringify(proj({ schLayout: 'tidy', name: 'Tidy' })));
  assert.equal(ls.getItem('esp32lab.schLayout.' + tidy.id), 'tidy');
  const none = store.importJson(proj({ name: 'None' }));
  assert.equal(ls.getItem('esp32lab.schLayout.' + none.id), null);
  const bad = store.importJson(proj({ schLayout: 'sideways', name: 'Bad' }));
  assert.equal(ls.getItem('esp32lab.schLayout.' + bad.id), null);
  const exported = JSON.parse(store.exportJson(board.id));
  assert.equal(exported.schLayout, 'board');
  assert.equal(store.get(board.id).schLayout, undefined);
  const again = store.importJson(store.exportJson(board.id));
  assert.notEqual(again.id, board.id);
  assert.equal(ls.getItem('esp32lab.schLayout.' + again.id), 'board');
  assert.equal(ls.getItem('esp32lab.schLayout.' + board.id), 'board');
});

test('Make a copy carries an example session choice onto the new project', () => {
  const session = mem();
  const local = mem();
  const store = new ProjectStore(local, null);
  const ex = proj({ example: 'blink' });
  S.writeLayout(ex, 'board', session);
  assert.equal(session.getItem('esp32lab.schLayout.ex.blink'), 'board');
  const carried = S.storedLayout(ex, session);
  const c = store.copy(ex);
  assert.equal(ex.example, 'blink');
  assert.equal(local.getItem('esp32lab.schLayout.' + c.id), null);
  Object.assign(ex, { id: c.id, name: c.name, copiedFrom: c.copiedFrom });
  delete ex.example;
  store.save(ex);
  if (carried) S.writeLayout(ex, carried, local);
  assert.equal(local.getItem('esp32lab.schLayout.' + c.id), 'board');
  assert.equal(session.getItem('esp32lab.schLayout.ex.blink'), 'board');
  assert.equal(S.layoutModeOf({ id: c.id }, local), 'board');
  assert.equal(store.get(c.id).schLayout, undefined);
  const fresh = proj({ example: 'simon' });
  assert.equal(S.storedLayout(fresh, session), '');
  const n = store.copy(fresh);
  assert.equal(local.getItem('esp32lab.schLayout.' + n.id), null);
  assert.equal(S.layoutModeOf({ id: n.id }, local), 'tidy');
});

test('a Breadboard choice on one draft does not leak, and it survives the first save', () => {
  const ls = mem();
  const store = new ProjectStore(ls, null);
  const a = proj({ name: 'A' });
  const b = proj({ name: 'B' });
  S.writeLayout(a, 'board', ls);
  const keyA = S.layoutStoreKey(a);
  const keyB = S.layoutStoreKey(b);
  assert.match(keyA, /^esp32lab\.schLayout\.draft\.d[A-Za-z0-9]+$/);
  assert.match(keyB, /^esp32lab\.schLayout\.draft\.d[A-Za-z0-9]+$/);
  assert.notEqual(keyA, keyB);
  assert.equal(keyA.includes('.unsaved'), false);
  assert.equal(keyB.includes('.unsaved'), false);
  assert.equal(S.layoutModeOf(a, ls), 'board');
  assert.equal(S.layoutModeOf(b, ls), 'tidy');
  assert.equal(ls.getItem(keyB), null);
  const copied = store.copy(a);
  assert.equal(ls.getItem(keyA), 'board');
  assert.equal(ls.getItem('esp32lab.schLayout.' + copied.id), 'board');
  assert.equal(a.draftId != null && String(a.draftId) !== '', true);
  const id = store.save(a);
  assert.equal(a.draftId, undefined);
  assert.equal(ls.getItem(keyA), null);
  assert.equal(ls.getItem('esp32lab.schLayout.' + id), 'board');
  assert.equal(S.layoutModeOf(a, ls), 'board');
  assert.equal(S.layoutModeOf(b, ls), 'tidy');
  store.save(b);
  assert.equal(b.draftId, undefined);
  assert.equal(ls.getItem('esp32lab.schLayout.' + b.id), null);
  assert.equal(S.layoutModeOf({ id: id }, ls), 'board');
  assert.equal(S.layoutModeOf({ id: b.id }, ls), 'tidy');
});

test('stale draft keys are removed without touching project or example keys', () => {
  const ls = mem();
  const keep = {};
  const gone = {};
  S.writeLayout(keep, 'tidy', ls);
  S.writeLayout(gone, 'board', ls);
  ls.setItem('esp32lab.schLayout.p1', 'board');
  ls.setItem('esp32lab.schLayout.ex.blink', 'board');
  ls.setItem('esp32lab.schLayout.unsaved', 'board');
  ls.setItem('esp32lab.schLayout.draft.p1', 'tidy');
  const index = JSON.parse(ls.getItem('esp32lab.schLayout.draftIndex'));
  index.push('p1', '../nope', '');
  ls.setItem('esp32lab.schLayout.draftIndex', JSON.stringify(index));
  const removed = [];
  const orig = ls.removeItem;
  ls.removeItem = (k) => { removed.push(k); orig(k); };
  S.sweepDrafts(ls, [keep.draftId]);
  assert.equal(ls.getItem(S.layoutStoreKey(keep)), 'tidy');
  assert.equal(ls.getItem(S.layoutStoreKey(gone)), null);
  assert.equal(ls.getItem('esp32lab.schLayout.p1'), 'board');
  assert.equal(ls.getItem('esp32lab.schLayout.ex.blink'), 'board');
  assert.equal(ls.getItem('esp32lab.schLayout.unsaved'), null);
  assert.equal(ls.getItem('esp32lab.schLayout.draft.p1'), null);
  assert.deepEqual(JSON.parse(ls.getItem('esp32lab.schLayout.draftIndex')), [keep.draftId]);
  assert.equal(removed.includes('esp32lab.schLayout.p1'), false);
  assert.equal(removed.includes('esp32lab.schLayout.ex.blink'), false);
  assert.ok(removed.includes('esp32lab.schLayout.unsaved'));
  assert.ok(removed.every((k) => k === 'esp32lab.schLayout.unsaved' || k.startsWith('esp32lab.schLayout.draft.')));
});

test('a draft key that cannot be deleted stays in the index', () => {
  const ls = mem();
  const d = {};
  S.writeLayout(d, 'board', ls);
  const key = S.layoutStoreKey(d);
  const orig = ls.removeItem;
  ls.removeItem = (k) => { if (k === key) throw new Error('busy'); orig(k); };
  S.sweepDrafts(ls, []);
  assert.equal(ls.getItem(key), 'board');
  assert.deepEqual(JSON.parse(ls.getItem('esp32lab.schLayout.draftIndex')), [d.draftId]);
  ls.setItem('esp32lab.schLayout.draftIndex', '{');
  ls.setItem('esp32lab.schLayout.p9', 'tidy');
  S.sweepDrafts(ls, []);
  assert.equal(ls.getItem('esp32lab.schLayout.p9'), 'tidy');
  assert.equal(ls.getItem(key), 'board');
  assert.deepEqual(JSON.parse(ls.getItem('esp32lab.schLayout.draftIndex')), []);
});

test('leaving an unsaved draft drops its key and leaves the other draft', () => {
  const ls = mem();
  const a = {};
  const b = {};
  S.writeLayout(a, 'board', ls);
  S.writeLayout(b, 'tidy', ls);
  const keyA = S.layoutStoreKey(a);
  S.releaseDraft(a, ls);
  assert.equal(a.draftId, undefined);
  assert.equal(ls.getItem(keyA), null);
  assert.equal(ls.getItem(S.layoutStoreKey(b)), 'tidy');
  assert.equal(S.layoutModeOf(b, ls), 'tidy');
});
