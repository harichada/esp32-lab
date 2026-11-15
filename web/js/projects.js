/* User projects ("My Projects"): examples stay pristine; editing one makes a copy that is saved here.
 * Storage: localStorage (always) + optional server copy (/api/projects, token-gated) when enabled. Pure logic, no DOM. */
function notifyStorageFull(root, err) {
  try { if (root && typeof root.onStorageFull === 'function') root.onStorageFull(err); }
  catch (e) { /* the page notice is best-effort; the failed write still throws */ }
}
(function (root) {
  const KEY = 'esp32lab.projects.v1', CUR = 'esp32lab.current.v1', SRV = 'esp32lab.serverSync';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  class ProjectStore {
    constructor(ls, fetchFn) {
      this.ls = ls || root.clStorage.local;
      this.fetch = fetchFn || (root.fetch && root.fetch.bind(root));
      this._notBefore = 0;
      this._chain = Promise.resolve();
    }
    // Retry-After is seconds or an HTTP date. A 429 with no usable value waits one second.
    _retryMs(header) {
      if (header == null || String(header).trim() === '') return 1000;
      const text = String(header).trim();
      const secs = Number(text);
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
      const when = Date.parse(text);
      if (Number.isFinite(when)) return Math.max(0, when - Date.now());
      return 1000;
    }
    _noteRetry(r) {
      if (!r || r.status !== 429) return;
      const header = r.headers && typeof r.headers.get === 'function' ? r.headers.get('Retry-After') : null;
      const until = Date.now() + this._retryMs(header);
      if (until > this._notBefore) this._notBefore = until;
    }
    async _gate() {
      const wait = this._notBefore - Date.now();
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
    // One projects request at a time. A 429 holds every later call until Retry-After has passed.
    _ask(url, opts) {
      const run = this._chain.then(async () => {
        await this._gate();
        const r = await this.fetch(url, opts);
        this._noteRetry(r);
        return r;
      });
      this._chain = run.then(() => {}, () => {});
      return run;
    }
    _all() { try { return JSON.parse(this.ls.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
    _put(all) { this.ls.setItem(KEY, JSON.stringify(all)); }
    list() { return Object.values(this._all()).map((e) => ({ id: e.id, name: e.name, updated: e.updated, from: e.from || '' })).sort((a, b) => b.updated - a.updated); }
    snapshot() {
      return Object.values(this._all()).filter((e) => e && e.id && e.proj).map((e) => ({ id: e.id, name: e.name || '', updated: e.updated || 0, proj: e.proj }));
    }
    get(id) { const e = this._all()[id]; return e ? clone(e.proj) : null; }
    // Plain "board"/"tidy", or {"mode","lastSeen"} on a draft. Anything else is unset.
    _layoutMode(raw) {
      if (raw === 'board' || raw === 'tidy') return raw;
      try {
        const o = JSON.parse(raw);
        if (o && (o.mode === 'board' || o.mode === 'tidy')) return o.mode;
      } catch (e) { /* plain text */ }
      return '';
    }
    _layoutOf(id) {
      if (id == null || String(id) === '') return '';
      let v = '';
      try { v = this.ls.getItem('esp32lab.schLayout.' + String(id)) || ''; } catch (e) { v = ''; }
      return this._layoutMode(v);
    }
    _setLayout(id, mode) {
      if (id == null || String(id) === '' || (mode !== 'board' && mode !== 'tidy')) return;
      try { this.ls.setItem('esp32lab.schLayout.' + String(id), mode); }
      catch (e) { notifyStorageFull(root, e); }
    }
    _readLayout(proj) {
      if (!proj) return '';
      if (proj.id != null && String(proj.id) !== '') {
        const saved = this._layoutOf(proj.id);
        if (saved) return saved;
      }
      if (proj.draftId && /^[A-Za-z0-9_-]{1,40}$/.test(String(proj.draftId))) {
        let v = '';
        try { v = this.ls.getItem('esp32lab.schLayout.draft.' + proj.draftId) || ''; } catch (e) { v = ''; }
        const mode = this._layoutMode(v);
        if (mode) return mode;
      }
      return proj.schLayout === 'board' || proj.schLayout === 'tidy' ? proj.schLayout : '';
    }
    // strip runtime-only fields; returns the stored project id.
    // setItem is all-or-nothing: a quota error leaves the previous blob and the
    // on-screen project id untouched, then the caller is told.
    save(proj) {
      if (!proj) throw new Error('no project');
      const draftId = proj.draftId;
      const id = proj.id || newId();
      const all = this._all();
      const p = clone(proj);
      p.id = id;
      delete p.readOnly; delete p.draftId; delete p.schLayout;
      all[id] = { id: id, name: p.name || 'Untitled', updated: Date.now(), from: p.copiedFrom || '', proj: p };
      const prevKey = this.ls.getItem(KEY);
      const prevCur = this.ls.getItem(CUR);
      let wroteKey = false;
      try {
        this._put(all);
        wroteKey = true;
        this.ls.setItem(CUR, id);
      } catch (e) {
        if (wroteKey) {
          try {
            if (prevKey == null) this.ls.removeItem(KEY);
            else this.ls.setItem(KEY, prevKey);
          } catch (_) { /* the new blob did not fit; the previous one still does */ }
          try {
            if (this.ls.getItem(CUR) !== prevCur) {
              if (prevCur == null) this.ls.removeItem(CUR);
              else this.ls.setItem(CUR, prevCur);
            }
          } catch (_) { /* current pointer stays where the failed write left it */ }
        }
        notifyStorageFull(root, e);
        throw e;
      }
      if (!proj.id) proj.id = id;
      if (draftId && root.Schematic && root.Schematic.migrateDraftLayout) {
        try { root.Schematic.migrateDraftLayout(proj, this.ls); }
        catch (e) { notifyStorageFull(root, e); }
      }
      if (this.serverSync) this.pushServer(p).catch(() => {});
      return id;
    }
    // copy any project (example or user project) into a new user project
    copy(proj, name) {
      const mode = this._readLayout(proj);
      const p = clone(proj); p.id = newId(); p.copiedFrom = proj.example || proj.copiedFrom || proj.id || '';
      delete p.example; delete p.readOnly; delete p.draftId; delete p.schLayout;
      const base = name || ((proj.name || 'Project').replace(/\s*\(copy( \d+)?\)$/, '') + ' (copy)');
      const names = new Set(this.list().map((e) => e.name)); let n = base, i = 2; while (names.has(n)) n = base.replace(/\)$/, ` ${i++})`);
      p.name = n; this.save(p);
      if (mode) this._setLayout(p.id, mode);
      return p;
    }
    duplicate(id) { const p = this.get(id); return p ? this.copy(p) : null; }
    rename(id, name) { const all = this._all(); if (!all[id] || !name) return false; all[id].name = all[id].proj.name = String(name).slice(0, 80); all[id].updated = Date.now(); this._put(all); if (this.serverSync) this.pushServer(all[id].proj).catch(() => {}); return true; }
    remove(id) { const all = this._all(); delete all[id]; this._put(all); if (this.ls.getItem(CUR) === id) this.ls.removeItem(CUR); if (this.serverSync && this.fetch) this._ask('api/projects/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {}); }
    current() { return this.ls.getItem(CUR); }
    exportJson(id) {
      const p = this.get(id); if (!p) return null;
      const mode = this._layoutOf(id);
      if (mode) p.schLayout = mode;
      return JSON.stringify(p, null, 1);
    }
    // Same schLayout field as Export, for the open project (Download). The field is
    // only on this JSON copy. Pass mode when the choice lives in another store.
    downloadJson(proj, mode) {
      if (!proj) return null;
      const p = clone(proj);
      delete p.readOnly;
      delete p.draftId;
      const chosen = mode === 'board' || mode === 'tidy' ? mode : this._readLayout(proj);
      if (chosen) p.schLayout = chosen;
      else delete p.schLayout;
      return JSON.stringify(p, null, 1);
    }
    importJson(text) {
      const o = typeof text === 'string' ? JSON.parse(text) : text;
      if (!o || !Array.isArray(o.parts)) throw new Error('not a project JSON (no parts)');
      const mode = o.schLayout === 'board' || o.schLayout === 'tidy' ? o.schLayout : '';
      delete o.example; delete o.draftId; delete o.schLayout;
      o.id = newId(); o.name = o.name || 'Imported project'; this.save(o);
      if (mode) this._setLayout(o.id, mode);
      return o;
    }
    get serverSync() { return this.ls.getItem(SRV) === '1'; }
    set serverSync(v) { this.ls.setItem(SRV, v ? '1' : '0'); }
    async pushServer(p) { if (!this.fetch) return false; const r = await this._ask('api/projects/' + encodeURIComponent(p.id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }); return r.ok; }
    async listServer() { const r = await this._ask('api/projects'); return r.ok ? r.json() : []; }
    async pullServer(id) { const r = await this._ask('api/projects/' + encodeURIComponent(id)); if (!r.ok) throw new Error('server: ' + r.status); const p = await r.json(); p.id = id; const all = this._all(); all[id] = { id, name: p.name || id, updated: Date.now(), from: p.copiedFrom || '', proj: p }; this._put(all); return p; }
  }
  const api = { ProjectStore, newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Projects = api;
})(typeof window !== 'undefined' ? window : globalThis);
