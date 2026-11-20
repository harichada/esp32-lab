'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ProjectStore } = require('../js/projects.js');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function rig() {
  const data = new Map(), timers = new Map(), listeners = {};
  let nextTimer = 0, denyWrites = false;
  const ls = {
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem(k, v) {
      if (denyWrites) throw new Error('quota');
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
  const store = new ProjectStore(ls, null);
  const fields = new Map();
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { value: '', style: {}, textContent: '' });
    return fields.get(id);
  };
  const addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const app = { proj: null, readOnly: false, saveState: 'saved', file: 'sketch',
    world: {}, editor: { setProject() {}, select() {}, fit() {} }, store };
  let alerts = 0;
  const box = {
    app, store, P: { T: {} }, Sim: class {},
    Devices: { MockWorld: class {} },
    document: { hidden: false, querySelector: field, addEventListener },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    stopRun() {}, renderFileTabs() {}, modeNote() {}, serialClear() {}, serialAppend() {},
    setStatus() {}, syncExampleReady() {}, renderBanner() {}, setUrl() {}, toast() {},
    showStorageFull() { alerts++; },
    $: field,
    syncCode() {
      if (app.file === 'sketch') app.proj.code = field('#code').value;
      else app.proj.files[app.file] = field('#code').value;
    },
    loadCode() { field('#code').value = app.file === 'sketch' ? app.proj.code : app.proj.files[app.file]; },
  };
  box.window = box;
  box.addEventListener = addEventListener;
  vm.createContext(box);
  vm.runInContext(
    section('  function normalize(p)', '  // Stays set for the life of the view.') +
    section('  async function loadExample', '  if (window.Examples && Examples.EX') +
    section('  function makeCopy(auto)', '  function beforeEdit') +
    section('  function beforeEdit', '  function setProjectTitle') +
    section('  function save() {', '  function projectsDialog() {'), box);
  const original = { name: 'First', mode: 'qemu', code: 'original', files: {}, defines: [], parts: [], wires: [] };
  store.save(original);
  box.setProject(original);
  let saves = 0;
  const persist = store.save.bind(store);
  store.save = (project) => { saves++; return persist(project); };
  return {
    box, app, store, field, original,
    edit(text) { field('#code').value = text; box.syncCode(); box.autosave(); },
    tick() {
      const queued = [...timers.values()];
      timers.clear();
      queued.forEach((fn) => fn());
    },
    fire(type, event = {}) { (listeners[type] || []).forEach((fn) => fn(event)); },
    deny(value) { denyWrites = value; },
    alerts: () => alerts,
    saves: () => saves,
  };
}

test('switching before the debounce saves the outgoing edit, not the example', () => {
  const r = rig();
  r.edit('last edit');
  const example = { name: 'Example', example: 'blink', code: 'untouched', parts: [], wires: [] };
  r.box.setProject(example, { readOnly: true });
  r.tick();
  assert.equal(r.store.get(r.original.id).code, 'last edit');
  assert.equal(r.app.proj, example);
  assert.equal(r.app.readOnly, true);
  assert.equal(example.id, undefined);
  assert.equal(r.store.list().length, 1);
});

test('opening the current project flushes before reading its stored version', () => {
  const r = rig();
  r.edit('latest');
  r.box.openProject(r.original.id);
  r.tick();
  assert.equal(r.app.proj.code, 'latest');
  assert.equal(r.store.get(r.original.id).code, 'latest');
});

test('a failed flush preserves the active edit and blocks replacement until retry', () => {
  const r = rig();
  const next = { name: 'Next', code: 'next', parts: [], wires: [] };
  r.store.save(next);
  r.edit('keep me');
  r.deny(true);
  r.box.setProject(next);
  assert.equal(r.app.proj, r.original);
  assert.equal(r.app.proj.code, 'keep me');
  assert.equal(r.store.get(r.original.id).code, 'original');
  assert.equal(r.app.saveState, 'unsaved');
  assert.ok(r.alerts() > 0);
  r.deny(false);
  r.box.save();
  assert.equal(r.store.get(r.original.id).code, 'keep me');
  assert.equal(r.app.saveState, 'saved');
  r.box.openProject(next.id);
  assert.equal(r.app.proj.id, next.id);
});

test('dirty state clears only after persistence, including header edits and explicit Save', () => {
  const r = rig();
  r.original.files['config.h'] = 'old';
  r.app.file = 'config.h';
  r.edit('new header');
  assert.equal(r.app.saveState, 'unsaved');
  r.box.save();
  const saves = r.saves();
  r.tick();
  assert.equal(r.saves(), saves, 'Save cancels the pending debounce');
  assert.equal(r.app.saveState, 'saved');
  assert.equal(r.store.get(r.original.id).files['config.h'], 'new header');
  assert.equal(r.store.get(r.original.id).code, 'original');
});

test('a failed outgoing save prevents import from changing storage or its current pointer', () => {
  const r = rig();
  r.store.save(r.original);
  r.edit('keep this draft');
  r.deny(true);
  assert.equal(r.box.importProject({ name: 'Imported', code: '', parts: [], wires: [] }), false);
  assert.equal(r.store.list().length, 1);
  assert.equal(r.store.current(), r.original.id);
  assert.equal(r.app.proj, r.original);
  assert.equal(r.app.proj.code, 'keep this draft');
});

test('an uncancelled example edit survives a failed copy and can be saved after freeing storage', () => {
  const r = rig();
  const example = { example: 'blink', name: 'Example', code: 'example', parts: [], wires: [] };
  r.box.setProject(example, { readOnly: true });
  r.deny(true);
  let prevented = false;
  assert.equal(r.box.beforeEdit({ preventDefault() { prevented = true; } }), false);
  assert.equal(prevented, true);
  // Some circuit gestures cannot be cancelled like beforeinput can.
  example.parts.push({ id: 'new-led', type: 'led', props: {} });
  r.box.autosave();
  r.box.setProject(r.store.get(r.original.id));
  assert.equal(r.app.proj, example);
  assert.equal(r.app.readOnly, true);
  assert.equal(r.app.saveState, 'unsaved');
  assert.equal(example.id, undefined);
  r.deny(false);
  assert.equal(r.box.flushAutosave(), true);
  assert.equal(r.app.readOnly, false);
  assert.notEqual(example.id, r.original.id);
  assert.equal(r.store.get(example.id).parts[0].id, 'new-led');
  assert.equal(r.store.get(example.id).example, undefined);
  assert.equal(r.store.get(r.original.id).code, 'original');
});

test('a locked example flushes edits and keeps its URL fallback when session storage is unavailable', async () => {
  const r = rig();
  let prompted = '', url;
  r.box.GuestParts = { exampleLocked: () => true, promptExample: (key) => { prompted = key; } };
  r.box.clStorage = { session: { setItem() { throw new Error('session storage unavailable'); } } };
  r.box.setUrl = (value) => { url = value; };
  r.edit('before sign-in');
  await r.box.loadExample('locked');
  assert.equal(r.store.get(r.original.id).code, 'before sign-in');
  assert.equal(r.app.proj, r.original);
  assert.equal(prompted, 'locked');
  assert.equal(url.ex, 'locked');
});

test('pagehide and hiding the page flush pending edits', () => {
  for (const event of ['pagehide', 'visibilitychange']) {
    const r = rig();
    r.edit(event);
    r.box.document.hidden = true;
    r.fire(event);
    assert.equal(r.store.get(r.original.id).code, event);
  }
});

test('failed persistence warns before leaving, but successful saves do not', () => {
  const r = rig();
  r.edit('unsaved');
  r.deny(true);
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  r.fire('beforeunload', event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  r.deny(false);
  prevented = false;
  r.fire('beforeunload', event);
  assert.equal(prevented, false);
  assert.equal(r.store.get(r.original.id).code, 'unsaved');
});
