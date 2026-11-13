/* Reject project files, part ids, and numeric properties before they are stored or drawn. */
(function (root) {
  const FILE_RE = /^[\w.-]+\.(h|hpp|c|cpp|ino)$/;
  const PART_RE = /^[A-Za-z0-9_-]{1,32}$/;
  const KEY_RE = /^[A-Za-z0-9_]{1,32}$/;
  const FILE_MSG = 'That file name is not allowed. Use letters, digits, dot, underscore or hyphen, and an extension of h, hpp, c, cpp or ino.';
  const PART_MSG = 'That part id is not allowed. Use 1 to 32 letters, digits, underscores or hyphens.';
  const FINITE_MSG = 'A property value must be a finite number.';

  function keyName(k) { return KEY_RE.test(k || '') ? k : 'A property'; }
  function finiteMsg(k) { return KEY_RE.test(k || '') ? k + ' must be a finite number.' : FINITE_MSG; }
  function rangeMsg(k, lo, hi) {
    const name = keyName(k);
    if (lo != null && hi != null) return name + ' must be between ' + lo + ' and ' + hi + '.';
    if (lo != null) return name + ' must be at least ' + lo + '.';
    if (hi != null) return name + ' must be at most ' + hi + '.';
    return finiteMsg(k);
  }
  function specsFor(part, catalog) {
    const d = catalog && part && catalog[part.type];
    if (!d || !d.edit) return [];
    return d.edit.filter((e) => e && (e.t === 'num' || e.t === 'range'));
  }
  function checkNumber(key, value, spec) {
    if (typeof value === 'number' && !Number.isFinite(value)) return finiteMsg(key);
    if (!spec) return '';
    if (typeof value !== 'number' || !Number.isFinite(value)) return finiteMsg(key);
    if (spec.min != null && value < spec.min) return rangeMsg(key, spec.min, spec.max);
    if (spec.max != null && value > spec.max) return rangeMsg(key, spec.min, spec.max);
    return '';
  }
  function walkFinite(value, key) {
    if (typeof value === 'number') return Number.isFinite(value) ? '' : finiteMsg(key);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) {
      for (const item of value) { const m = walkFinite(item, key); if (m) return m; }
      return '';
    }
    for (const [k, v] of Object.entries(value)) { const m = walkFinite(v, k); if (m) return m; }
    return '';
  }
  // Returns a plain message, or '' when the project is acceptable.
  function validateProject(proj, catalog) {
    if (!proj || typeof proj !== 'object' || !Array.isArray(proj.parts)) return 'This is not a project.';
    if (proj.files != null) {
      if (typeof proj.files !== 'object' || Array.isArray(proj.files)) return 'Project files are not valid.';
      for (const [name, text] of Object.entries(proj.files)) {
        if (!FILE_RE.test(name)) return FILE_MSG;
        if (typeof text !== 'string') return 'A project file must be text.';
      }
    }
    for (const part of proj.parts) {
      if (!part || typeof part !== 'object') return PART_MSG;
      if (!PART_RE.test(part.id || '')) return PART_MSG;
      const props = part.props;
      if (props == null) continue;
      if (typeof props !== 'object' || Array.isArray(props)) return 'A part property is not valid.';
      const specs = specsFor(part, catalog);
      const byKey = {};
      for (const spec of specs) byKey[spec.k] = spec;
      for (const [k, v] of Object.entries(props)) {
        const msg = checkNumber(k, v, byKey[k]);
        if (msg) return msg;
      }
    }
    return walkFinite(proj.wires || [], '') || '';
  }
  const api = { FILE_RE, PART_RE, FILE_MSG, PART_MSG, FINITE_MSG, validateProject };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ProjCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
