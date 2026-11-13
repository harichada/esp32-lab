/* User projects ("My Projects"): examples stay pristine; editing one makes a copy that is saved here.
 * Storage: localStorage (always) + optional online backup (/api/projects). The server picks the id
 * and returns an edit secret once. The secret stays in localStorage and in an #edit= fragment,
 * never in a query string. A view-only project is forked locally on the first edit. The backup
 * request is at most once every 10s per project, plus one fetch with keepalive when the page hides. */
(function (root) {
  const KEY = 'esp32lab.projects.v1', CUR = 'esp32lab.current.v1', SRV = 'esp32lab.serverSync', SEC = 'esp32lab.editSecrets.v1';
  const NOPUT = 'esp32lab.noPut.v1', HINT = 'esp32lab.editLinkHint.v1';
  const BACKUP_MS = 10000;
  const LOCKOUT = "This browser can't edit this project. Open your edit link, or make your own copy.";
  const BACKUP_WAIT = 'Lots of people on your network are saving right now. Wait a few seconds and try again; your changes are still here.';
  const SHARE_BUSY = 'Too many people on your network are backing up right now. Try again in a few seconds.';
  const COPY_FAIL = "Couldn't make your copy. Please try again.";
  const HINT_MSG = 'To edit this on another device, copy your edit link and keep it somewhere safe.';
  const SHARE_WAIT = 'Turn on Back up online to share this project.';
  const SHARE_OK = 'Backed up online and copied view-only link.';
  const SHARE_FAIL = "Couldn't back up this project, so there's no link to share yet. Try again in a minute.";
  const BAD_LINK = "This project link doesn't work. Ask the person who sent it to share it again.";
  function escAttr(value) {
    return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shareFailMessage(err) {
    if (err && err.code === 'rate_limit') return SHARE_BUSY;
    return SHARE_FAIL;
  }
  // Copy stays disabled until the server can serve this id. The amber warning is only present once edit works.
  function shareControls(opts) {
    opts = opts || {};
    const reasonId = escAttr(opts.reasonId || 'shareWait');
    const warnId = escAttr(opts.warnId || 'editLinkWarn');
    const shareAttrs = opts.shareAttrs || '';
    const editAttrs = opts.editAttrs || '';
    const goAttrs = opts.goAttrs || '';
    const locked = ` disabled aria-disabled="true" aria-describedby="${reasonId}"`;
    if (!opts.backedUp) {
      const busy = opts.busy ? ' disabled aria-busy="true"' : '';
      const goLabel = opts.busy ? 'Backing up…' : 'Back up online and copy link';
      return `<p id="${reasonId}" class="share-reason">${SHARE_WAIT}</p>`
        + `<button type="button" ${shareAttrs}${locked}>Copy link (view only)</button>`
        + `<button type="button" ${editAttrs}${locked}>Copy link (others can edit)</button>`
        + `<button type="button" ${goAttrs}${busy}>${goLabel}</button>`;
    }
    if (!opts.canEdit) {
      return `<button type="button" ${shareAttrs}>Copy link (view only)</button>`
        + `<span class="edit-link"><button type="button" ${editAttrs}${locked}>Copy link (others can edit)</button>`
        + `<p id="${reasonId}" class="share-reason">${LOCKOUT}</p></span>`;
    }
    return `<button type="button" ${shareAttrs}>Copy link (view only)</button>`
      + `<span class="edit-link"><button type="button" ${editAttrs} aria-describedby="${warnId}">Copy link (others can edit)</button>`
      + `<span id="${warnId}" class="share-warn">Anyone with the edit link can change it.</span></span>`;
  }
  function shouldSendBackup(last, now, reason) {
    if (reason === 'hide' || reason === 'pagehide' || reason === 'retry') return true;
    if (reason !== 'save' && reason !== 'timer') return false;
    if (last == null) return true;
    return now - last >= BACKUP_MS;
  }
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
    constructor(ls, fetchFn) {
      this.ls = ls || root.clStorage.local;
      this.fetch = fetchFn || (root.fetch && root.fetch.bind(root));
      this._pushing = new Map();
      this._lastBackup = new Map();
      this._clean = new Map();
      this._dirty = new Set();
      this._timers = new Map();
      this._inflight = new Map();
      this._retried = new Set();
      this._localOnly = new Set();
      this._hideSent = new Set();
      this._shareFlight = null;
      this.backupMs = BACKUP_MS;
      this.backupNote = '';
      this.now = () => Date.now();
      this.later = (fn, ms) => setTimeout(fn, ms);
      this.jitter = () => Math.random();
    }
    _snap(p) {
      const c = clone(p || {});
      delete c.editSecret; delete c.editSecretHash; delete c.secret; delete c.readOnly;
      return JSON.stringify(c);
    }
    _blocked() { try { return JSON.parse(this.ls.getItem(NOPUT) || '{}') || {}; } catch (e) { return {}; } }
    blockPut(id) { if (!id) return; const all = this._blocked(); all[id] = 1; this.ls.setItem(NOPUT, JSON.stringify(all)); }
    isPutBlocked(id) { return !!(id && this._blocked()[id]); }
    _setNote(msg) { this.backupNote = msg || ''; if (this.onBackupNote) this.onBackupNote(this.backupNote); }
    _noteSaved(id) {
      if (!id || this.ls.getItem(HINT)) return;
      this.ls.setItem(HINT, '1');
      if (this.onEditLinkHint) this.onEditLinkHint(HINT_MSG);
    }
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
    // True only when a GET of this id can succeed: we hold the secret, or this browser loaded it from the server.
    canShare(id) {
      if (!id || this._localOnly.has(id)) return false;
      if (this.secretFor(id)) return true;
      const entry = this._all()[id];
      return !!(entry && entry.viewOnly);
    }
    // One explicit upload. A second call while the first is in flight joins it, so one tap pair creates one project.
    backupAndShare(proj, href) {
      if (this._shareFlight) return this._shareFlight;
      const job = this._backupAndShare(proj, href).finally(() => {
        if (this._shareFlight === job) this._shareFlight = null;
      });
      this._shareFlight = job;
      return job;
    }
    async _backupAndShare(proj, href) {
      if (!proj) throw fail(SHARE_FAIL, 'server');
      const id = await this.pushServer(proj, { reason: 'share' });
      if (!id || !this.secretFor(id)) throw fail(SHARE_FAIL, 'server');
      this.serverSync = true;
      const base = href || (root.location && root.location.href) || 'http://localhost/';
      return this.shareUrl(base, id);
    }
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
      if (!proj.id) { proj.id = newId(); this._localOnly.add(proj.id); }
      const all = this._all(); const p = clone(proj); delete p.readOnly; delete p.editSecret; delete p.editSecretHash; delete p.secret;
      all[p.id] = { id: p.id, name: p.name || 'Untitled', updated: Date.now(), from: p.copiedFrom || '', proj: p, viewOnly: false }; this._put(all);
      this.ls.setItem(CUR, p.id);
      const snap = this._snap(p);
      if (opts && opts.dirty === false) this._clean.set(p.id, snap);
      if (this._clean.get(p.id) === snap) this._dirty.delete(p.id);
      else this._dirty.add(p.id);
      const remote = !opts || opts.remote !== false;
      if (remote && this.serverSync) this.scheduleBackup(p);
      return p.id;
    }
    _clearTimer(id) {
      if (!this._timers.has(id)) return;
      const handle = this._timers.get(id);
      this._timers.delete(id);
      if (handle != null) clearTimeout(handle);
    }
    scheduleBackup(proj) {
      if (!this.serverSync || !proj || !proj.id || this._timers.has(proj.id)) return;
      const id = proj.id;
      const last = this._lastBackup.has(id) ? this._lastBackup.get(id) : null;
      const wait = last == null ? this.backupMs : Math.max(0, this.backupMs - (this.now() - last));
      const handle = this.later(() => {
        this._timers.delete(id);
        return this.flushBackup(this.get(id) || proj, { reason: 'timer' });
      }, wait);
      this._timers.set(id, handle);
    }
    flushBackup(proj, opts) {
      opts = opts || {};
      if (!proj || !proj.id || !this.serverSync || !this.fetch) return Promise.resolve(false);
      const reason = opts.reason || 'save';
      const hide = reason === 'hide' || reason === 'pagehide';
      if (hide && !this._dirty.has(proj.id)) return Promise.resolve(false);
      if (hide && this._hideSent.has(proj.id)) {
        const lastHide = this._lastBackup.has(proj.id) ? this._lastBackup.get(proj.id) : null;
        if (lastHide != null && this.now() - lastHide < this.backupMs) return Promise.resolve(false);
      }
      const last = this._lastBackup.has(proj.id) ? this._lastBackup.get(proj.id) : null;
      if (!shouldSendBackup(last, this.now(), reason)) {
        this.scheduleBackup(proj);
        return Promise.resolve(false);
      }
      if (this._inflight.has(proj.id)) return this._inflight.get(proj.id);
      const id = proj.id;
      const job = this._sendBackup(proj, opts).finally(() => { if (this._inflight.get(id) === job) this._inflight.delete(id); });
      this._inflight.set(id, job);
      return job;
    }
    async _sendBackup(proj, opts) {
      const reason = opts.reason || 'save';
      const hide = reason === 'hide' || reason === 'pagehide';
      if (reason !== 'retry') this._retried.delete(proj.id);
      this._clearTimer(proj.id);
      this._lastBackup.set(proj.id, this.now());
      if (hide) this._hideSent.add(proj.id);
      else this._hideSent.delete(proj.id);
      try {
        const savedId = await this.pushServer(proj, opts);
        const saved = this.get(savedId) || this.get(this.current()) || proj;
        const cleanId = (saved && saved.id) || savedId || proj.id;
        this._clean.set(cleanId, this._snap(saved));
        this._dirty.delete(proj.id);
        this._dirty.delete(cleanId);
        this._retried.delete(proj.id);
        this._retried.delete(cleanId);
        if (this.backupNote) this._setNote('');
        return true;
      } catch (err) {
        this._dirty.add(proj.id);
        const cur = this.current();
        if (cur) this._dirty.add(cur);
        if (err && err.code === 'rate_limit') {
          this._setNote(BACKUP_WAIT);
          const retryId = cur || proj.id;
          // One retry after Retry-After. A second 429 waits for the next edit or the next 10 s window.
          if (reason !== 'retry' && !this._retried.has(retryId)) {
            this._retried.add(retryId);
            const extra = typeof this.jitter === 'function' ? this.jitter() : 0;
            const wait = ((err.retryAfter || 1) + extra) * 1000;
            this.later(() => {
              this._lastBackup.delete(retryId);
              this._lastBackup.delete(proj.id);
              const again = (retryId && this.get(retryId)) || proj;
              return this.flushBackup(again, { reason: 'retry', keepalive: !!opts.keepalive });
            }, wait);
          } else {
            this._retried.add(retryId);
            const held = this.get(retryId) || proj;
            this._lastBackup.set(held.id || retryId, this.now());
            this.scheduleBackup(held);
          }
          return false;
        }
        if (err && (err.code === 'view_only' || err.code === 'invalid') && this.onPushError) this.onPushError(err, proj);
        return false;
      }
    }
    // copy any project (example or user project) into a new user project
    copy(proj, name, opts) {
      const p = clone(proj); p.id = newId(); this._localOnly.add(p.id); p.copiedFrom = proj.example || proj.copiedFrom || proj.id || ''; delete p.example; delete p.readOnly; delete p.editSecret; delete p.secret;
      const base = name || ((proj.name || 'Project').replace(/\s*\(copy( \d+)?\)$/, '') + ' (copy)');
      const names = new Set(this.list().map((e) => e.name)); let n = base, i = 2; while (names.has(n)) n = base.replace(/\)$/, ` ${i++})`);
      p.name = n; this.save(p, opts); return p;
    }
    duplicate(id) { const p = this.get(id); return p ? this.copy(p) : null; }
    forkLocal(proj) {
      if (proj && proj.id) this.blockPut(proj.id);
      return this.copy(proj, null, { remote: false });
    }
    rename(id, name) { const all = this._all(); if (!all[id] || !name) return false; all[id].name = all[id].proj.name = String(name).slice(0, 80); all[id].updated = Date.now(); this._put(all); this._dirty.add(id); if (this.serverSync) this.scheduleBackup(all[id].proj); return true; }
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
    _retryAfter(r) {
      try {
        const raw = r.headers && r.headers.get && r.headers.get('retry-after');
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
      } catch (e) { /* keep the one-second default */ }
      return 1;
    }
    async _read(r, fallback, id) {
      let body = {};
      try { body = await r.json(); } catch (e) { body = {}; }
      if (r.status === 429) {
        const err = fail(BACKUP_WAIT, 'rate_limit');
        err.retryAfter = this._retryAfter(r);
        throw err;
      }
      if (r.status === 403) {
        if (id) this.blockPut(id);
        throw fail(LOCKOUT, 'view_only');
      }
      if (r.status === 400) throw fail(plain(body, fallback || 'This project was rejected.'), 'invalid');
      if (!r.ok) throw fail(fallback || ('Server returned ' + r.status), 'server');
      return body;
    }
    _request(url, method, headers, body, opts) {
      const init = { method, cache: 'no-store', headers, body };
      if (opts && opts.keepalive) init.keepalive = true;
      return this.fetch(url, init);
    }
    async createServer(proj, opts) {
      const msg = this._check(proj);
      if (msg) throw fail(msg, 'invalid');
      if (!this.fetch) throw fail('The server is not available.', 'server');
      const localId = proj.id;
      const body = clone(proj);
      delete body.id; delete body.example; delete body.readOnly; delete body.editSecret; delete body.editSecretHash; delete body.secret;
      const r = await this._request('api/projects', 'POST', { 'content-type': 'application/json' }, JSON.stringify(body), opts);
      const j = await this._read(r, 'Could not make a copy.', localId);
      if (!j.id || !j.secret) throw fail(COPY_FAIL, 'invalid');
      body.id = j.id; body.name = body.name || proj.name || 'Untitled';
      if (localId && localId !== j.id) this.retarget(localId, j.id, body);
      else {
        const all = this._all();
        all[j.id] = { id: j.id, name: body.name, updated: Date.now(), from: body.copiedFrom || '', proj: clone(body), viewOnly: false };
        this._put(all); this.ls.setItem(CUR, j.id);
      }
      this.rememberSecret(j.id, j.secret);
      this._noteSaved(j.id);
      this._lastBackup.set(j.id, this.now());
      proj.id = j.id;
      return body;
    }
    async pushServer(p, opts) {
      if (!this.fetch || !p) return false;
      opts = opts || {};
      if (this.isViewOnly(p.id)) {
        const copy = this.forkLocal(p);
        if (this.onServerId) this.onServerId(p.id, copy.id);
        const created = await this.createServer(copy, opts);
        return created && created.id;
      }
      let secret = this.secretFor(p.id);
      if (this.isPutBlocked(p.id) || this._localOnly.has(p.id)) {
        const old = p.id;
        const created = await this.createServer(p, opts);
        if (created && created.id !== old && this.onServerId) this.onServerId(old, created.id);
        this._localOnly.delete(old);
        return created && created.id;
      }
      if (!secret) {
        let exists = false;
        try {
          const got = await this.fetch('api/projects/' + encodeURIComponent(p.id), { cache: 'no-store' });
          exists = !!got.ok;
        } catch (e) { exists = false; }
        if (!exists) {
          const old = p.id;
          const created = await this.createServer(p, opts);
          if (created && created.id !== old && this.onServerId) this.onServerId(old, created.id);
          return created && created.id;
        }
      }
      const headers = { 'content-type': 'application/json' };
      secret = this.secretFor(p.id);
      if (secret) headers['X-Edit-Secret'] = secret;
      const body = clone(p); delete body.editSecret; delete body.editSecretHash; delete body.secret;
      const r = await this._request('api/projects/' + encodeURIComponent(p.id), 'PUT', headers, JSON.stringify(body), opts);
      const j = await this._read(r, '', p.id);
      if (j.secret) { this.rememberSecret(j.id || p.id, j.secret); this._noteSaved(j.id || p.id); }
      if (j.id && j.id !== p.id) {
        const old = p.id;
        this.retarget(old, j.id, p);
        p.id = j.id;
        if (this.onServerId) this.onServerId(old, j.id);
      }
      const all = this._all();
      if (all[p.id]) { all[p.id].viewOnly = false; this._put(all); }
      this._noteSaved(p.id);
      return p.id;
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
  const api = {
    ProjectStore, newId, shouldSendBackup, BACKUP_MS, shareControls, shareFailMessage,
    SHARE_WAIT, SHARE_OK, SHARE_FAIL, SHARE_BUSY, BACKUP_WAIT, BAD_LINK, LOCKOUT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Projects = api;
})(typeof window !== 'undefined' ? window : globalThis);
