/* Compile-timeout copy and the build-server line. Idle unless
 * <meta name="statusstrip" content="1"> is present. Text only. */
(function (root) {
  const LINE = "Can't reach the build server right now. Your work is safe; Run will work again when it's back.";
  const HEALTHY_MS = 30000;
  const HEALTH_JITTER = 0.2;
  const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
  const HEALTH_MIN_MS = BACKOFF_MS[0];
  const HEALTH_MAX_MS = BACKOFF_MS[BACKOFF_MS.length - 1];
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
    }
    if (doc.body && el.parentNode !== doc.body && doc.body.appendChild) doc.body.appendChild(el);
    if (el.textContent !== LINE) el.textContent = LINE;
    el.hidden = false;
    return el;
  }
  function healthyDelay(rand) {
    const raw = typeof rand === 'function' ? rand() : (typeof rand === 'number' ? rand : Math.random());
    const unit = Math.min(1, Math.max(0, Number(raw)));
    const span = 1 + (unit - 0.5) * 2 * HEALTH_JITTER;
    return Math.round(HEALTHY_MS * span);
  }
  function nextDelay(prev) {
    const i = BACKOFF_MS.indexOf(Number(prev));
    if (i < 0) return BACKOFF_MS[0];
    return BACKOFF_MS[Math.min(i + 1, BACKOFF_MS.length - 1)];
  }
  function watchHealth(opts) {
    opts = opts || {};
    const isHidden = opts.hidden || (() => false);
    const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
    const random = opts.random || Math.random;
    let timer = null;
    let wasDown = false;
    let fails = 0;
    let inflight = null;
    function waitFor() {
      if (wasDown) return BACKOFF_MS[Math.min(Math.max(fails - 1, 0), BACKOFF_MS.length - 1)];
      return healthyDelay(random);
    }
    function clear() {
      if (timer != null) { clearTimer(timer); timer = null; }
    }
    function arm() {
      clear();
      if (isHidden()) return;
      timer = setTimer(() => { timer = null; return tick(); }, waitFor());
    }
    async function tick() {
      if (isHidden()) { clear(); return; }
      if (inflight) return inflight;
      inflight = (async () => {
        let down = true;
        let health = null;
        try {
          health = await opts.fetch();
          down = !(health && health.ok);
        } catch (e) { down = true; health = null; }
        if (isHidden()) return;
        if (down) {
          if (!wasDown && opts.onDown) opts.onDown(health);
          wasDown = true;
          fails = Math.min(fails + 1, BACKOFF_MS.length);
        } else {
          const recovered = wasDown;
          wasDown = false;
          fails = 0;
          if (recovered && opts.onUp) opts.onUp(health);
        }
        arm();
      })();
      try { await inflight; } finally { inflight = null; }
    }
    function poke() {
      clear();
      return tick();
    }
    function start() {
      wasDown = false;
      fails = 0;
      arm();
    }
    function onVisibility() {
      if (isHidden()) { clear(); return; }
      return poke();
    }
    return { start: start, onVisibility: onVisibility, poke: poke };
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
    HEALTHY_MS: HEALTHY_MS,
    HEALTH_MIN_MS: HEALTH_MIN_MS,
    HEALTH_MAX_MS: HEALTH_MAX_MS,
    BACKOFF_MS: BACKOFF_MS,
    healthyDelay: healthyDelay,
    COMPILE_TIMEOUT_BASE: COMPILE_TIMEOUT_BASE,
    nextDelay: nextDelay,
    watchHealth: watchHealth,
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
