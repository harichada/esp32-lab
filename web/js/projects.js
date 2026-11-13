/* User projects ("My Projects"): examples stay pristine; editing one makes a copy that is saved here.
 * Storage: localStorage (always) + optional server copy (/api/projects). The server picks the id
 * and returns an edit secret once. The secret stays in localStorage and in an #edit= fragment,
 * never in a query string. */
(function (root) {
  const KEY = 'esp32lab.projects.v1', CUR = 'esp32lab.current.v1', SRV = 'esp32lab.serverSync', SEC = 'esp32lab.editSecrets.v1';
  const Check = root.ProjCheck || (typeof require !== 'undefined' ? require('./projcheck.js') : null);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function catalog() { return root.Parts && root.Parts.T; }
  function fail(message, code) { const e = new Error(message); e.code = code || 'invalid'; return e; }
  function plain(body, fallback) {
    const message = body && typeof body.message === 'string' ? body.message : '';
    if (!message || message.length > 300 || /[<>]/.test(message)) return fallback;
    return message;
  }
  class ProjectStore {
    constructor(ls, fetchFn) { this.ls = ls || root.clStorage.local; this.fetch = fetchFn || (root.fetch && root.fetch.bind(root)); this._pushing = new Map(); }
    _all() { try { return JSON.parse(this.ls.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
    _put(all) { this.ls.setItem(KEY, JSON.stringify(all)); }
    _secrets() { try { return JSON.parse(this.ls.getItem(SEC) || '{}') || {}; } catch (e) { return {}; } }
    _check(proj) { return Check ? Check.validateProject(proj, catalog()) : ''; }
    list() { return Object.values(this._all()).map((e) => ({ id: e.id, name: e.name, updated: e.updated, from: e.from || '' })).sort((a, b) => b.updated - a.updated); }
    get(id) { const e = this._all()[id]; return e ? clone(e.proj) : null; }
    secretFor(id) { return this._secrets()[id] || ''; }
    rememberSecret(id, secret) {
      if (!id || !secret) return;
      const all = this._secrets(); all[id] = String(secret); this.ls.setItem(SEC, JSON.stringify(all));
    }
    forgetSecret(id) { const all = this._secrets(); if (!all[id]) return; delete all[id]; this.ls.setItem(SEC, JSON.stringify(all)); }
    isViewOnly(id) { return !this.secretFor(id) && !!(this._all()[id] && this._all()[id].viewOnly); }
    // #edit=<secret> is stored for ?p=<id>, then removed from the address bar. The fragment is not a request.
    consumeEditFragment(loc, history) {
      const hash = (loc && loc.hash) || '';
      if (hash.slice(0, 6).toLowerCase() !== '#edit=') return null;
      let secret = hash.slice(6);
      try { secret = decodeURIComponent(secret); } catch (e) { /* keep the raw fragment */ }
      const search = (loc && loc.search) || '';
      const id = new URLSearchParams(search).get('p');
      if (id && secret) this.rememberSecret(id, secret);
      const next = (loc.pathname || '/') + search;
      if (history && history.replaceState) history.replaceState(null, '', next);
      if (loc) loc.hash = '';
      return { id, secret };
    }
    editUrl(base, id, secret) {
      const u = new URL(base, 'http://127.0.0.1/');
      u.searchParams.delete('ex');
      u.searchParams.set('p', id);
      u.hash = 'edit=' + encodeURIComponent(secret || '');
      return u.toString();
    }
    shareUrl(base, id) {
      const u = new URL(base, 'http://127.0.0.1/');
      u.searchParams.delete('ex');
      u.searchParams.set('p', id);
      u.hash = '';
      return u.toString();
    }
    retarget(oldId, newId, proj) {
      const all = this._all();
      const prev = all[oldId] || {};
      delete all[oldId];
      const p = proj || clone(prev.proj || {});
      p.id = newId;
      all[newId] = { id: newId, name: p.name || prev.name || 'Untitled', updated: Date.now(), from: prev.from || p.copiedFrom || '', proj: clone(p), viewOnly: false };
      this._put(all);
      if (this.ls.getItem(CUR) === oldId) this.ls.setItem(CUR, newId);
      const secs = this._secrets();
      if (secs[oldId] && !secs[newId]) { secs[newId] = secs[oldId]; delete secs[oldId]; this.ls.setItem(SEC, JSON.stringify(secs)); }
    }
    // strip runtime-only fields; returns the stored project id
    save(proj, opts) {
      const msg = this._check(proj);
      if (msg) throw fail(msg, 'invalid');
      if (!proj.id) proj.id = newId();
      const all = this._all(); const p = clone(proj); delete p.readOnly; delete p.editSecret; delete p.editSecretHash; delete p.secret;
      all[p.id] = { id: p.id, name: p.name || 'Untitled', updated: Date.now(), from: p.copiedFrom || '', proj: p, viewOnly: false }; this._put(all);
      this.ls.setItem(CUR, p.id);
      const remote = !opts || opts.remote !== false;
      if (remote && this.fetch && (this.serverSync || this.secretFor(p.id))) this._queuePush(p);
      return p.id;
    }
    _queuePush(p) {
      const key = p.id;
      if (this._pushing.has(key)) return this._pushing.get(key);
      const job = this.pushServer(p).catch((err) => {
        if (err && (err.code === 'view_only' || err.code === 'rate_limit' || err.code === 'invalid') && this.onPushError) this.onPushError(err, p);
      }).finally(() => { if (this._pushing.get(key) === job) this._pushing.delete(key); });
      this._pushing.set(key, job);
      return job;
    }
    // copy any project (example or user project) into a new user project
    copy(proj, name, opts) {
      const p = clone(proj); p.id = newId(); p.copiedFrom = proj.example || proj.copiedFrom || proj.id || ''; delete p.example; delete p.readOnly; delete p.editSecret; delete p.secret;
      const base = name || ((proj.name || 'Project').replace(/\s*\(copy( \d+)?\)$/, '') + ' (copy)');
      const names = new Set(this.list().map((e) => e.name)); let n = base, i = 2; while (names.has(n)) n = base.replace(/\)$/, ` ${i++})`);
      p.name = n; this.save(p, opts); return p;
    }
    duplicate(id) { const p = this.get(id); return p ? this.copy(p) : null; }
    rename(id, name) { const all = this._all(); if (!all[id] || !name) return false; all[id].name = all[id].proj.name = String(name).slice(0, 80); all[id].updated = Date.now(); this._put(all); if (this.serverSync || this.secretFor(id)) this._queuePush(all[id].proj); return true; }
    remove(id) {
      const all = this._all(); delete all[id]; this._put(all); if (this.ls.getItem(CUR) === id) this.ls.removeItem(CUR);
      const secret = this.secretFor(id);
      this.forgetSecret(id);
      if (this.fetch) {
        const headers = {};
        if (secret) headers['X-Edit-Secret'] = secret;
        this.fetch('api/projects/' + encodeURIComponent(id), { method: 'DELETE', cache: 'no-store', headers }).catch(() => {});
      }
    }
    current() { return this.ls.getItem(CUR); }
    exportJson(id) { const p = this.get(id); if (!p) return null; delete p.editSecret; delete p.editSecretHash; delete p.secret; return JSON.stringify(p, null, 1); }
    importJson(text) {
      const o = typeof text === 'string' ? JSON.parse(text) : text;
      if (!o || !Array.isArray(o.parts)) throw new Error('not a project JSON (no parts)');
      const msg = this._check(o);
      if (msg) throw fail(msg, 'invalid');
      delete o.example; delete o.editSecret; delete o.editSecretHash; delete o.secret;
      o.id = newId(); o.name = o.name || 'Imported project'; this.save(o); return o;
    }
    get serverSync() { return this.ls.getItem(SRV) === '1'; }
    set serverSync(v) { this.ls.setItem(SRV, v ? '1' : '0'); }
    async _read(r, fallback) {
      let body = {};
      try { body = await r.json(); } catch (e) { body = {}; }
      if (r.status === 429) throw fail(plain(body, 'Too many project saves. Try again shortly.'), 'rate_limit');
      if (r.status === 403) throw fail(plain(body, 'This copy is view-only. Make a copy to edit it.'), 'view_only');
      if (r.status === 400) throw fail(plain(body, fallback || 'This project was rejected.'), 'invalid');
      if (!r.ok) throw fail(fallback || ('Server returned ' + r.status), 'server');
      return body;
    }
    async createServer(proj) {
      const msg = this._check(proj);
      if (msg) throw fail(msg, 'invalid');
      if (!this.fetch) throw fail('The server is not available.', 'server');
      const localId = proj.id;
      const body = clone(proj);
      delete body.id; delete body.example; delete body.readOnly; delete body.editSecret; delete body.editSecretHash; delete body.secret;
      const r = await this.fetch('api/projects', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await this._read(r, 'Could not make a copy.');
      if (!j.id || !j.secret) throw fail('The server did not return an edit secret.', 'invalid');
      body.id = j.id; body.name = body.name || proj.name || 'Untitled';
      if (localId && localId !== j.id) this.retarget(localId, j.id, body);
      else {
        const all = this._all();
        all[j.id] = { id: j.id, name: body.name, updated: Date.now(), from: body.copiedFrom || '', proj: clone(body), viewOnly: false };
        this._put(all); this.ls.setItem(CUR, j.id);
      }
      this.rememberSecret(j.id, j.secret);
      proj.id = j.id;
      return body;
    }
    async pushServer(p) {
      if (!this.fetch) return false;
      let secret = this.secretFor(p.id);
      if (!secret) {
        let exists = false;
        try {
          const got = await this.fetch('api/projects/' + encodeURIComponent(p.id), { cache: 'no-store' });
          exists = !!got.ok;
        } catch (e) { exists = false; }
        if (!exists) {
          const old = p.id;
          const created = await this.createServer(p);
          if (created.id !== old && this.onServerId) this.onServerId(old, created.id);
          return true;
        }
      }
      const headers = { 'content-type': 'application/json' };
      secret = this.secretFor(p.id);
      if (secret) headers['X-Edit-Secret'] = secret;
      const body = clone(p); delete body.editSecret; delete body.editSecretHash; delete body.secret;
      const r = await this.fetch('api/projects/' + encodeURIComponent(p.id), { method: 'PUT', cache: 'no-store', headers, body: JSON.stringify(body) });
      const j = await this._read(r);
      if (j.secret) this.rememberSecret(j.id || p.id, j.secret);
      if (j.id && j.id !== p.id) {
        const old = p.id;
        this.retarget(old, j.id, p);
        p.id = j.id;
        if (this.onServerId) this.onServerId(old, j.id);
      }
      const all = this._all();
      if (all[p.id]) { all[p.id].viewOnly = false; this._put(all); }
      return true;
    }
    // Only projects whose edit secret this browser holds. The public list is not used.
    async listServer() {
      const ids = Object.keys(this._secrets());
      const out = [];
      for (const id of ids) {
        try {
          const r = await this.fetch('api/projects/' + encodeURIComponent(id), { cache: 'no-store' });
          if (!r.ok) continue;
          const p = await r.json();
          out.push({ id, name: (p && p.name) || id, updated: Date.now() });
        } catch (e) { /* skip a copy this browser can no longer read */ }
      }
      return out;
    }
    async pullServer(id) {
      const r = await this.fetch('api/projects/' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) throw new Error('server: ' + r.status);
      const p = await r.json();
      delete p.editSecret; delete p.editSecretHash; delete p.secret;
      p.id = id;
      const all = this._all();
      all[id] = { id, name: p.name || id, updated: Date.now(), from: p.copiedFrom || '', proj: p, viewOnly: !this.secretFor(id) };
      this._put(all);
      return p;
    }
  }
  const api = { ProjectStore, newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Projects = api;
})(typeof window !== 'undefined' ? window : globalThis);
