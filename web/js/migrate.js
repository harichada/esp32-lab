/* One-time move of this browser's saved lab from the http origin to https.
   The server never stores the payload. Keys come from clStorage, not a second list. */
(function (root) {
  if (typeof module !== 'undefined' && module.exports && !root.clStorage) require('./storage.js');
  const S = root.clStorage;
  const FRAGMENT_BUDGET = Math.floor(1.5 * 1024 * 1024);
  const BODY_CAP = 2 * 1024 * 1024;
  const PROJECT_CAP = 1024 * 1024;
  const MAX_ITEMS = 64;
  const MAX_VALUE = BODY_CAP;
  const MAX_ORIGIN = 200;
  const MAX_QUERY = 4096;
  const MAX_PATH = 512;

  function b64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function b64urlDecode(text) {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesOf(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }
  function textOf(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }
  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function bundle(items, origin, path, query, now) {
    return {
      v: 1,
      origin: String(origin || ''),
      exportedAt: now || Date.now(),
      path: path || '/',
      query: query || '',
      items: items,
    };
  }

  function safePath(path) {
    if (typeof path !== 'string' || path.length < 1 || path.length > MAX_PATH) return null;
    if (path.charAt(0) !== '/' || path.indexOf('//') === 0 || path.indexOf('\\') !== -1) return null;
    if (path.indexOf('..') !== -1) return null;
    for (let i = 0; i < path.length; i++) {
      const c = path.charCodeAt(i);
      if (c < 32 || c === 127) return null;
    }
    return path;
  }
  function safeQuery(query) {
    if (query == null || query === '') return '';
    if (typeof query !== 'string' || query.length > MAX_QUERY) return null;
    if (query.charAt(0) === '?') return null;
    for (let i = 0; i < query.length; i++) {
      const c = query.charCodeAt(i);
      if (c < 32 || c === 127) return null;
    }
    return query;
  }

  function projectOk(id, entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (entry.id !== id || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id)) return false;
    if (typeof entry.name !== 'string' || entry.name.length > 80) return false;
    if (typeof entry.updated !== 'number' || !isFinite(entry.updated)) return false;
    const proj = entry.proj;
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) return false;
    if (proj.parts != null && !Array.isArray(proj.parts)) return false;
    if (proj.wires != null && !Array.isArray(proj.wires)) return false;
    let encoded;
    try { encoded = JSON.stringify(entry); } catch (e) { return false; }
    return !!encoded && encoded.length <= PROJECT_CAP;
  }

  function validate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not a move record';
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      if (['v', 'origin', 'exportedAt', 'path', 'query', 'items'].indexOf(keys[i]) === -1) return 'unexpected field';
    }
    if (obj.v !== 1) return 'unsupported version';
    if (typeof obj.origin !== 'string' || obj.origin.length > MAX_ORIGIN) return 'bad origin';
    if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(obj.origin)) return 'bad origin';
    if (typeof obj.exportedAt !== 'number' || !isFinite(obj.exportedAt)) return 'bad time';
    const path = safePath(obj.path || '/');
    if (!path) return 'bad path';
    const query = safeQuery(obj.query || '');
    if (query == null) return 'bad query';
    if (!Array.isArray(obj.items) || obj.items.length > MAX_ITEMS) return 'bad items';
    const seen = {};
    for (let i = 0; i < obj.items.length; i++) {
      const item = obj.items[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'bad item';
      const ik = Object.keys(item);
      if (ik.length !== 2 || ik.indexOf('k') === -1 || ik.indexOf('v') === -1) return 'bad item';
      if (typeof item.k !== 'string' || !S.ownedKey(item.k)) return 'unknown key';
      if (typeof item.v !== 'string' || item.v.length > MAX_VALUE) return 'value too large';
      if (seen[item.k]) return 'duplicate key';
      seen[item.k] = 1;
      if (item.k === S.KEYS.projects) {
        let parsed;
        try { parsed = JSON.parse(item.v); } catch (e) { return 'projects are not json'; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'projects are not a list';
        const ids = Object.keys(parsed);
        for (let p = 0; p < ids.length; p++) {
          if (ids[p] === '__proto__' || ids[p] === 'constructor' || ids[p] === 'prototype') return 'bad project id';
          if (!projectOk(ids[p], parsed[ids[p]])) return 'bad project';
        }
      }
    }
    return '';
  }

  function sameProj(a, b) {
    try { return JSON.stringify(a && a.proj) === JSON.stringify(b && b.proj) && a.name === b.name; }
    catch (e) { return false; }
  }

  function mergeProjects(localRaw, incomingRaw) {
    const local = localRaw ? JSON.parse(localRaw) : {};
    const incoming = JSON.parse(incomingRaw);
    const names = {};
    Object.keys(local).forEach((id) => { if (local[id] && local[id].name) names[local[id].name] = 1; });
    let imported = 0;
    const remap = {};
    Object.keys(incoming).forEach((id) => {
      const entry = incoming[id];
      const existing = local[id];
      if (!existing) {
        local[id] = entry;
        if (entry.name) names[entry.name] = 1;
        imported += 1;
        return;
      }
      if (sameProj(existing, entry)) {
        if ((entry.updated || 0) > (existing.updated || 0)) existing.updated = entry.updated;
        return;
      }
      const copy = JSON.parse(JSON.stringify(entry));
      let nid = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      while (local[nid]) nid += 'x';
      copy.id = nid;
      if (copy.proj && typeof copy.proj === 'object') copy.proj.id = nid;
      let base = (copy.name || 'Project') + ' (moved copy)';
      let name = base;
      let n = 2;
      while (names[name]) name = base + ' ' + (n++);
      copy.name = name.slice(0, 80);
      if (copy.proj && typeof copy.proj === 'object') copy.proj.name = copy.name;
      names[copy.name] = 1;
      local[nid] = copy;
      remap[id] = nid;
      imported += 1;
    });
    return { json: JSON.stringify(local), imported: imported, remap: remap };
  }

  function applyBundle(obj, ls) {
    const store = ls || S.local;
    const byKey = {};
    obj.items.forEach((item) => { byKey[item.k] = item.v; });
    let imported = 0;
    let remap = {};
    if (byKey[S.KEYS.projects]) {
      const merged = mergeProjects(store.getItem(S.KEYS.projects), byKey[S.KEYS.projects]);
      store.setItem(S.KEYS.projects, merged.json);
      imported = merged.imported;
      remap = merged.remap;
    }
    Object.keys(byKey).forEach((k) => {
      if (k === S.KEYS.projects) return;
      if (store.getItem(k) != null) return;
      let value = byKey[k];
      if (k === S.KEYS.current && remap[value]) value = remap[value];
      store.setItem(k, value);
    });
    return imported;
  }

  async function pack(obj) {
    const json = JSON.stringify(obj);
    const bytes = bytesOf(json);
    const zipped = await deflate(bytes);
    if (zipped && zipped.length < bytes.length) return '1.' + b64url(zipped);
    return '0.' + b64url(bytes);
  }

  async function unpack(text) {
    if (typeof text !== 'string' || (text.indexOf('0.') !== 0 && text.indexOf('1.') !== 0)) return null;
    let bytes;
    try { bytes = b64urlDecode(text.slice(2)); } catch (e) { return null; }
    if (bytes.length > BODY_CAP) return null;
    if (text.charAt(0) === '1') {
      const raw = await inflate(bytes);
      if (!raw || raw.length > BODY_CAP) return null;
      bytes = raw;
    }
    try { return JSON.parse(textOf(bytes)); } catch (e) { return null; }
  }

  function destOf(target, path, query, count) {
    const params = new URLSearchParams(query || '');
    if (count != null) params.set('moved', String(count));
    const q = params.toString();
    return target + (path || '/') + (q ? '?' + q : '');
  }

  function showFail(origin) {
    const doc = root.document;
    if (!doc || !doc.body) return;
    doc.body.textContent = '';
    const p = doc.createElement('p');
    p.textContent = 'These projects could not be moved. Open the original address and export them from My Projects.';
    doc.body.appendChild(p);
    if (origin) {
      const a = doc.createElement('a');
      a.href = origin + '/';
      a.textContent = 'Back to the original address';
      doc.body.appendChild(a);
    }
  }

  async function handoff(opts) {
    const target = opts.target;
    const path = safePath(opts.path || '/') || '/';
    const query = safeQuery(opts.query || '') || '';
    const dest = destOf(target, path, query, null);
    let items = [];
    try {
      if (S.local.getItem(S.MIGRATED_FLAG)) {
        root.location.replace(dest);
        return;
      }
      try {
        if (S.session.getItem(S.ATTEMPT_FLAG) === '1') {
          root.location.replace(dest);
          return;
        }
      } catch (e) { /* session storage can be closed in private mode */ }
      items = S.collect();
    } catch (e) {
      root.location.replace(dest);
      return;
    }
    if (!items.length) {
      root.location.replace(dest);
      return;
    }
    const record = bundle(items, root.location.origin, path, query, Date.now());
    if (validate(record)) {
      showFail(root.location.origin);
      return;
    }
    let packed;
    try { packed = await pack(record); } catch (e) { packed = ''; }
    if (!packed) {
      showFail(root.location.origin);
      return;
    }
    try { S.session.setItem(S.ATTEMPT_FLAG, '1'); } catch (e) { /* still try the move */ }
    if (packed.length <= FRAGMENT_BUDGET) {
      root.location.replace(target + '/migrate#' + packed);
      return;
    }
    if (packed.length > BODY_CAP) {
      showFail(root.location.origin);
      return;
    }
    const doc = root.document;
    const form = doc.createElement('form');
    form.method = 'POST';
    form.action = target + '/migrate';
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = packed;
    form.appendChild(input);
    doc.body.appendChild(form);
    form.submit();
  }

  async function receive(opts) {
    const doc = root.document;
    let obj = null;
    const embedded = doc && doc.getElementById && doc.getElementById('cl-migrate-payload');
    if (embedded && embedded.textContent) {
      try { obj = JSON.parse(embedded.textContent); } catch (e) { obj = null; }
    } else if (typeof root.__clMove === 'string' && root.__clMove) {
      const packed = root.__clMove;
      root.__clMove = '';
      try { obj = await unpack(packed); } catch (e) { obj = null; }
    }
    root.__clMove = '';
    if (root.history && root.history.replaceState && root.location) {
      try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) { /* the first script already cleared the fragment */ }
    }
    const failOrigin = obj && typeof obj.origin === 'string' ? obj.origin : '';
    const problem = obj ? validate(obj) : 'not a move record';
    if (problem) {
      showFail(failOrigin);
      return;
    }
    let imported = 0;
    try {
      imported = applyBundle(obj, S.local);
    } catch (e) {
      showFail(failOrigin);
      return;
    }
    const path = safePath(obj.path || '/') || '/';
    const query = safeQuery(obj.query || '') || '';
    const next = destOf(opts.target, path, query, imported);
    if (opts.confirm && obj.origin) {
      const back = encodeURIComponent(next);
      root.location.replace(obj.origin + '/migrate-done?migrated=1&back=' + back);
      return;
    }
    root.location.replace(next);
  }

  function finish(opts) {
    try {
      if (opts.flag) S.local.setItem(S.MIGRATED_FLAG, String(Date.now()));
      try { S.session.removeItem(S.ATTEMPT_FLAG); } catch (e) { /* session storage may be closed */ }
    } catch (e) { /* the http copy stays; the next visit tries again only in a new tab */ }
    root.location.replace(opts.back || opts.target || '/');
  }

  const api = {
    FRAGMENT_BUDGET: FRAGMENT_BUDGET,
    BODY_CAP: BODY_CAP,
    PROJECT_CAP: PROJECT_CAP,
    bundle: bundle,
    validate: validate,
    mergeProjects: mergeProjects,
    applyBundle: applyBundle,
    pack: pack,
    unpack: unpack,
    handoff: handoff,
    receive: receive,
    finish: finish,
    destOf: destOf,
  };
  root.clMigrate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
