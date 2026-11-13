/* User projects ("My Projects"): examples stay pristine; editing one makes a copy that is saved here.
 * Storage: localStorage (always) + optional server copy (/api/projects, token-gated) when enabled. Pure logic, no DOM. */
(function (root) {
  const KEY = 'esp32lab.projects.v1', CUR = 'esp32lab.current.v1', SRV = 'esp32lab.serverSync';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  class ProjectStore {
    constructor(ls, fetchFn) { this.ls = ls || root.clStorage.local; this.fetch = fetchFn || (root.fetch && root.fetch.bind(root)); }
    _all() { try { return JSON.parse(this.ls.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
    _put(all) { this.ls.setItem(KEY, JSON.stringify(all)); }
    list() { return Object.values(this._all()).map((e) => ({ id: e.id, name: e.name, updated: e.updated, from: e.from || '' })).sort((a, b) => b.updated - a.updated); }
    get(id) { const e = this._all()[id]; return e ? clone(e.proj) : null; }
    // strip runtime-only fields; returns the stored project id
    save(proj) {
      if (!proj.id) proj.id = newId();
      const all = this._all(); const p = clone(proj); delete p.readOnly;
      all[p.id] = { id: p.id, name: p.name || 'Untitled', updated: Date.now(), from: p.copiedFrom || '', proj: p }; this._put(all);
      this.ls.setItem(CUR, p.id); if (this.serverSync) this.pushServer(p).catch(() => {});
      return p.id;
    }
    // copy any project (example or user project) into a new user project
    copy(proj, name) {
      const p = clone(proj); p.id = newId(); p.copiedFrom = proj.example || proj.copiedFrom || proj.id || ''; delete p.example; delete p.readOnly;
      const base = name || ((proj.name || 'Project').replace(/\s*\(copy( \d+)?\)$/, '') + ' (copy)');
      const names = new Set(this.list().map((e) => e.name)); let n = base, i = 2; while (names.has(n)) n = base.replace(/\)$/, ` ${i++})`);
      p.name = n; this.save(p); return p;
    }
    duplicate(id) { const p = this.get(id); return p ? this.copy(p) : null; }
    rename(id, name) { const all = this._all(); if (!all[id] || !name) return false; all[id].name = all[id].proj.name = String(name).slice(0, 80); all[id].updated = Date.now(); this._put(all); if (this.serverSync) this.pushServer(all[id].proj).catch(() => {}); return true; }
    remove(id) { const all = this._all(); delete all[id]; this._put(all); if (this.ls.getItem(CUR) === id) this.ls.removeItem(CUR); if (this.serverSync && this.fetch) this.fetch('api/projects/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {}); }
    current() { return this.ls.getItem(CUR); }
    exportJson(id) { const p = this.get(id); return p ? JSON.stringify(p, null, 1) : null; }
    importJson(text) { const o = typeof text === 'string' ? JSON.parse(text) : text; if (!o || !Array.isArray(o.parts)) throw new Error('not a project JSON (no parts)'); delete o.example; o.id = newId(); o.name = o.name || 'Imported project'; this.save(o); return o; }
    get serverSync() { return this.ls.getItem(SRV) === '1'; }
    set serverSync(v) { this.ls.setItem(SRV, v ? '1' : '0'); }
    async pushServer(p) { if (!this.fetch) return false; const r = await this.fetch('api/projects/' + encodeURIComponent(p.id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }); return r.ok; }
    async listServer() { const r = await this.fetch('api/projects'); return r.ok ? r.json() : []; }
    async pullServer(id) { const r = await this.fetch('api/projects/' + encodeURIComponent(id)); if (!r.ok) throw new Error('server: ' + r.status); const p = await r.json(); p.id = id; const all = this._all(); all[id] = { id, name: p.name || id, updated: Date.now(), from: p.copiedFrom || '', proj: p }; this._put(all); return p; }
  }
  const api = { ProjectStore, newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Projects = api;
})(typeof window !== 'undefined' ? window : globalThis);
