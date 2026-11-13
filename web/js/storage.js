/* Browser storage. One wrapper for every key the lab writes.
   When <html data-cl-env="staging"> (or <meta name="cl-env" content="staging">) is present,
   every key is stored as esp32lab-staging:<key>. With the flag off, the key is unchanged,
   so an existing browser keeps the projects it already has. */
(function (root) {
  const PREFIX = 'esp32lab-staging:';
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
  const api = {
    PREFIX: PREFIX,
    staging: staging,
    key: key,
    get local() { return wrap('localStorage'); },
    get session() { return wrap('sessionStorage'); },
  };
  root.clStorage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
