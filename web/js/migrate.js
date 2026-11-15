/* One-time move of this browser's saved lab from the http origin to https.
   The server never stores the payload. Keys come from clStorage, not a second list. */
(function (root) {
  if (typeof module !== 'undefined' && module.exports && !root.clStorage) require('./storage.js');
  const S = root.clStorage;
  const FRAGMENT_BUDGET = Math.floor(1.5 * 1024 * 1024);
  const BODY_CAP = 2 * 1024 * 1024;
  const PROJECT_CAP = 1024 * 1024;
  const MAX_ITEMS = 64;
  const MAX_PROJECTS = 64;
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
        if (ids.length > MAX_PROJECTS) return 'too many projects';
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

  const FAIL_TEXT = 'Your projects are still safe at the original address. Nothing was deleted. To retry, go back and open this site again.';

  function canonical(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function hexBytes(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 256).toString(16).slice(1);
    return out;
  }

  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

  // The handoff page is plain HTTP, which has no crypto.subtle. This is the
  // same SHA-256 the HTTPS page and the server use.
  function sha256Bytes(data) {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const bitLen = data.length * 8;
    const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(padded.length - 4, bitLen >>> 0, false);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let i = 0; i < padded.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false);
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
        const s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (let t = 0; t < 64; t++) {
        const s1b = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + s1b + ch + K[t] + w[t]) >>> 0;
        const s0b = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0b + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => ov.setUint32(i * 4, v, false));
    return out;
  }

  async function sha256Hex(text) {
    const bytes = bytesOf(text);
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle && subtle.digest) {
      try {
        const buf = await subtle.digest('SHA-256', bytes);
        return hexBytes(new Uint8Array(buf));
      } catch (e) { /* plain HTTP has no subtle */ }
    }
    return hexBytes(sha256Bytes(bytes));
  }

  function projectCount(obj) {
    const items = (obj && obj.items) || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].k !== S.KEYS.projects) continue;
      try {
        const parsed = JSON.parse(items[i].v);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
      } catch (e) { return 0; }
    }
    return 0;
  }

  function acceptReceipt(expectedChecksum, expectedCount, msg) {
    if (!msg || msg.ok !== true) return false;
    if (typeof msg.checksum !== 'string' || msg.checksum !== expectedChecksum) return false;
    return Number(msg.count) === expectedCount;
  }

  function commitReceipt(checksum) {
    try { S.session.setItem(S.ATTEMPT_FLAG, checksum); } catch (e) { /* a missing session flag does not block a retry */ }
    try { S.local.setItem(S.MIGRATED_FLAG, String(Date.now())); } catch (e) { /* the http copy stays */ }
  }

  function showFail(origin) {
    const doc = root.document;
    if (!doc || !doc.body) return;
    doc.body.textContent = '';
    const main = doc.createElement('main');
    main.className = 'move';
    const h = doc.createElement('h1');
    h.textContent = 'Projects were not moved';
    const p = doc.createElement('p');
    p.textContent = FAIL_TEXT;
    main.appendChild(h);
    main.appendChild(p);
    if (origin) {
      const a = doc.createElement('a');
      a.className = 'btn';
      a.href = origin + '/';
      a.textContent = 'Back to the original address';
      main.appendChild(a);
    }
    doc.body.appendChild(main);
  }

  function tellParent(framed, origin, data) {
    if (!framed || !root.parent || !root.parent.postMessage) return;
    try { root.parent.postMessage(data, origin || '*'); } catch (e) { /* the parent still has its own timeout */ }
  }

  async function handoff(opts) {
    opts = opts || {};
    const target = opts.target;
    const path = safePath(opts.path || '/') || '/';
    const query = safeQuery(opts.query || '') || '';
    const dest = destOf(target, path, query, null);
    const here = root.location && root.location.origin;
    let items = [];
    try {
      if (S.local.getItem(S.MIGRATED_FLAG)) {
        root.location.replace(dest);
        return;
      }
      items = S.collect();
    } catch (e) {
      showFail(here);
      return;
    }
    if (!items.length) {
      root.location.replace(dest);
      return;
    }
    const record = bundle(items, here, path, query, Date.now());
    if (validate(record)) {
      showFail(here);
      return;
    }
    const body = canonical(record);
    if (bytesOf(body).length > BODY_CAP || ('payload=' + encodeURIComponent(body)).length > BODY_CAP) {
      showFail(here);
      return;
    }
    let checksum = '';
    try { checksum = await sha256Hex(body); } catch (e) {
      showFail(here);
      return;
    }
    const count = projectCount(record);
    const timeout = opts.timeout || 8000;

    function succeed(msg) {
      if (!acceptReceipt(checksum, count, msg)) {
        showFail(here);
        return;
      }
      commitReceipt(checksum);
      root.location.replace(destOf(target, path, query, count));
    }

    if (typeof opts.post === 'function') {
      let timer;
      try {
        const msg = await Promise.race([
          Promise.resolve(opts.post(body)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeout); }),
        ]);
        clearTimeout(timer);
        succeed(msg);
      } catch (e) {
        clearTimeout(timer);
        showFail(here);
      }
      return;
    }

    const doc = root.document;
    if (!doc || !doc.body || !doc.createElement) {
      showFail(here);
      return;
    }
    let settled = false;
    let timer;
    function finishMove(msg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (root.removeEventListener) root.removeEventListener('message', onMsg);
      if (!msg) showFail(here);
      else succeed(msg);
    }
    function onMsg(ev) {
      let expected = '';
      try { expected = new URL(target).origin; } catch (e) { expected = ''; }
      if (!expected || !ev || ev.origin !== expected) return;
      const data = ev.data || {};
      if (data.type !== 'cl-move') return;
      finishMove(data);
    }
    timer = setTimeout(() => finishMove(null), timeout);
    if (root.addEventListener) root.addEventListener('message', onMsg);
    try {
      const frame = doc.createElement('iframe');
      frame.name = 'cl-move-frame';
      frame.title = 'Project move';
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0';
      const form = doc.createElement('form');
      form.method = 'POST';
      form.action = target + '/migrate';
      form.target = frame.name;
      form.acceptCharset = 'UTF-8';
      const input = doc.createElement('input');
      input.type = 'hidden';
      input.name = 'payload';
      input.value = body;
      form.appendChild(input);
      doc.body.appendChild(frame);
      doc.body.appendChild(form);
      form.submit();
    } catch (e) {
      finishMove(null);
    }
  }

  async function receive(opts) {
    opts = opts || {};
    const doc = root.document;
    let obj = null;
    const embedded = doc && doc.getElementById && doc.getElementById('cl-migrate-payload');
    if (embedded && embedded.textContent) {
      try { obj = JSON.parse(embedded.textContent); } catch (e) { obj = null; }
    }
    if (root.history && root.history.replaceState && root.location) {
      try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) { /* the first script already cleared a stray fragment */ }
    }
    const framed = !!(root.parent && root.parent !== root);
    const failOrigin = obj && typeof obj.origin === 'string' ? obj.origin : '';
    const problem = obj ? validate(obj) : 'not a move record';
    if (problem) {
      tellParent(framed, failOrigin, { type: 'cl-move', ok: false });
      showFail(failOrigin);
      return;
    }
    let mine = '';
    try { mine = await sha256Hex(canonical(obj)); } catch (e) { mine = ''; }
    const count = projectCount(obj);
    if ((opts.checksum && opts.checksum !== mine) || (opts.count != null && Number(opts.count) !== count)) {
      tellParent(framed, failOrigin, { type: 'cl-move', ok: false });
      showFail(failOrigin);
      return;
    }
    let imported = 0;
    try {
      imported = applyBundle(obj, S.local);
    } catch (e) {
      tellParent(framed, failOrigin, { type: 'cl-move', ok: false });
      showFail(failOrigin);
      return;
    }
    tellParent(framed, failOrigin, { type: 'cl-move', ok: true, count: count, checksum: mine });
    if (framed) return;
    const path = safePath(obj.path || '/') || '/';
    const query = safeQuery(obj.query || '') || '';
    root.location.replace(destOf(opts.target, path, query, imported));
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
    canonical: canonical,
    sha256Hex: sha256Hex,
    projectCount: projectCount,
    acceptReceipt: acceptReceipt,
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
