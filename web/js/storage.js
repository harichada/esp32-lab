/* Browser storage. One wrapper for every key the lab writes.
   When <html data-cl-env="staging"> (or <meta name="cl-env" content="staging">) is present,
   every key is stored as esp32lab-staging:<key>. With the flag off, the key is unchanged,
   so an existing browser keeps the projects it already has. */
(function (root) {
  const PREFIX = 'esp32lab-staging:';
  // One list. projects.js and the https handoff read these names from here.
  const KEYS = {
    projects: 'esp32lab.projects.v1',
    current: 'esp32lab.current.v1',
    serverSync: 'esp32lab.serverSync',
    legacyProject: 'esp32lab.project.v1',
    flow: 'esp32lab.flow',
    ortho: 'esp32lab.ortho',
    view: 'esp32lab.view',
    theme: 'esp32lab.theme',
    haptics: 'esp32lab.haptics',
    sound: 'esp32lab.sound',
    netlog: 'netlog',
  };
  const OWNED_KEYS = Object.keys(KEYS).map((name) => KEYS[name]);
  const OWNED_PREFIXES = ['esp32lab.ui.'];
  const MIGRATED_FLAG = 'cl_migrated_to_https';
  const ATTEMPT_FLAG = 'cl_migrate_attempt';
  function ownedKey(name) {
    if (OWNED_KEYS.indexOf(name) !== -1) return true;
    for (let i = 0; i < OWNED_PREFIXES.length; i++) {
      const pfx = OWNED_PREFIXES[i];
      if (name.indexOf(pfx) !== 0) continue;
      return /^[A-Za-z0-9._-]{1,40}$/.test(name.slice(pfx.length));
    }
    return false;
  }
  function staging() {
    try {
      if (root.__CL_STAGING === true) return true;
      if (root.__CL_STAGING === false) return false;
      const doc = root.document;
      const el = doc && doc.documentElement;
      if (el && el.getAttribute && el.getAttribute('data-cl-env') === 'staging') return true;
      const meta = doc && doc.querySelector && doc.querySelector('meta[name="cl-env"]');
      if (meta && String(meta.getAttribute ? meta.getAttribute('content') : meta.content) === 'staging') return true;
    } catch (e) { /* node tests without a document */ }
    return false;
  }
  function key(k) { return staging() ? PREFIX + k : k; }
  function raw(kind) {
    const store = root[kind];
    if (!store) throw new Error('no ' + kind);
    return store;
  }
  function wrap(kind) {
    return {
      getItem(k) { return raw(kind).getItem(key(k)); },
      setItem(k, v) { raw(kind).setItem(key(k), String(v)); },
      removeItem(k) { raw(kind).removeItem(key(k)); },
    };
  }
  function collect() {
    const items = [];
    const seen = {};
    const local = wrap('localStorage');
    for (let i = 0; i < OWNED_KEYS.length; i++) {
      const logical = OWNED_KEYS[i];
      const value = local.getItem(logical);
      if (!value) continue;
      if (logical === KEYS.projects && (value === '{}' || value === 'null')) continue;
      seen[logical] = 1;
      items.push({ k: logical, v: String(value) });
    }
    const store = raw('localStorage');
    const phys = staging() ? PREFIX : '';
    for (let p = 0; p < OWNED_PREFIXES.length; p++) {
      const needle = phys + OWNED_PREFIXES[p];
      for (let i = 0; i < store.length; i++) {
        const stored = store.key(i);
        if (!stored || stored.indexOf(needle) !== 0) continue;
        const logical = stored.slice(phys.length);
        if (seen[logical] || !ownedKey(logical)) continue;
        const value = store.getItem(stored);
        if (!value) continue;
        seen[logical] = 1;
        items.push({ k: logical, v: String(value) });
      }
    }
    return items;
  }
  const api = {
    PREFIX: PREFIX,
    KEYS: KEYS,
    OWNED_KEYS: OWNED_KEYS,
    OWNED_PREFIXES: OWNED_PREFIXES,
    MIGRATED_FLAG: MIGRATED_FLAG,
    ATTEMPT_FLAG: ATTEMPT_FLAG,
    ownedKey: ownedKey,
    collect: collect,
    staging: staging,
    key: key,
    get local() { return wrap('localStorage'); },
    get session() { return wrap('sessionStorage'); },
  };
  root.clStorage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
