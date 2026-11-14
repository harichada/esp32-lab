/* Compile-timeout copy and the build-server line. Idle unless
 * <meta name="statusstrip" content="1"> is present. Text only. */
(function (root) {
  const LINE = "Can't reach the build server right now. Your work is safe; Run will work again when it's back.";
  const COMPILE_TIMEOUT_BASE = 'The compile timed out. Press Run again.';
  const ON = { '1': 1, 'true': 1, 'yes': 1, 'on': 1 };

  function enabled(doc) {
    doc = doc || root.document;
    if (!doc || !doc.querySelector) return false;
    const meta = doc.querySelector('meta[name="statusstrip"]');
    if (!meta) return false;
    const v = (meta.getAttribute('content') || '').trim().toLowerCase();
    return !!ON[v];
  }

  function hasUserCopy(proj, readOnly, store) {
    if (readOnly || !proj || proj.example || !proj.id) return false;
    if (store && typeof store.get === 'function') return !!store.get(proj.id);
    return true;
  }

  function timeoutSentence(base, saved) {
    const text = String(base || '').trim();
    const body = text || COMPILE_TIMEOUT_BASE;
    if (!saved) return body;
    if (/It['\u2019]s saved\./.test(body)) return body;
    const gap = /[.!?…]$/.test(body) ? ' ' : '. ';
    return body + gap + "It's saved.";
  }

  function isCompileTimeout(log) {
    return /compile timed out\b/i.test(String(log || ''));
  }

  function showTimeout(doc, sentence) {
    doc = doc || root.document;
    if (!doc || !doc.getElementById) return null;
    const strip = doc.getElementById('compileStrip');
    if (!strip) return null;
    strip.textContent = String(sentence || '');
    strip.hidden = false;
    if (strip.classList) strip.classList.add('timeout-card');
    strip.setAttribute('role', 'status');
    strip.setAttribute('aria-live', 'polite');
    strip.setAttribute('aria-hidden', 'false');
    const toast = doc.getElementById('mCompileToast');
    if (toast) {
      toast.textContent = '';
      toast.hidden = true;
      toast.setAttribute('aria-hidden', 'true');
    }
    return strip;
  }

  function clearTimeoutCard(doc) {
    doc = doc || root.document;
    if (!doc || !doc.getElementById) return;
    const strip = doc.getElementById('compileStrip');
    if (!strip || !strip.classList || !strip.classList.contains('timeout-card')) return;
    strip.classList.remove('timeout-card');
    strip.removeAttribute('role');
    strip.removeAttribute('aria-live');
  }

  function showDown(doc) {
    doc = doc || root.document;
    if (!doc) return null;
    let el = doc.getElementById && doc.getElementById('statusStrip');
    if (!el) {
      el = doc.createElement('p');
      el.id = 'statusStrip';
      el.className = 'status-strip';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const run = doc.querySelector && doc.querySelector('.runctl');
      if (run && run.parentNode) run.parentNode.insertBefore(el, run.nextSibling);
      else if (doc.body) doc.body.appendChild(el);
    }
    el.textContent = LINE;
    el.hidden = false;
    return el;
  }

  function hideDown(doc) {
    doc = doc || root.document;
    if (!doc || !doc.getElementById) return;
    const el = doc.getElementById('statusStrip');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function repeat(doc) {
    const el = showDown(doc);
    if (!el) return;
    el.textContent = '';
    const write = () => {
      el.textContent = LINE;
      const n = Number(el.getAttribute('data-said') || '0') + 1;
      el.setAttribute('data-said', String(n));
    };
    if (typeof setTimeout === 'function') setTimeout(write, 20);
    else write();
  }

  const api = {
    LINE: LINE,
    COMPILE_TIMEOUT_BASE: COMPILE_TIMEOUT_BASE,
    enabled: enabled,
    hasUserCopy: hasUserCopy,
    timeoutSentence: timeoutSentence,
    isCompileTimeout: isCompileTimeout,
    showTimeout: showTimeout,
    clearTimeoutCard: clearTimeoutCard,
    showDown: showDown,
    hideDown: hideDown,
    repeat: repeat,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StatusStrip = api;
})(typeof window !== 'undefined' ? window : globalThis);
