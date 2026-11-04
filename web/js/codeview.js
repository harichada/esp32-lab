/* Code view: syntax highlighting (C/C++/Arduino + JS), line numbers and compiler error markers layered under the
 * real <textarea id="code"> (which stays the editing surface, so undo, IME, selection and tests behave natively). */
(function (root) {
  const KW = 'auto break case catch class const constexpr continue default delete do else enum explicit extern false for friend goto if inline namespace new nullptr operator private protected public register return sizeof static static_cast struct switch template this throw true try typedef typename union using virtual volatile while let var function async await of in instanceof typeof yield import export from null undefined';
  const TY = 'void bool char int short long float double signed unsigned uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t size_t String byte boolean word IPAddress WiFiUDP HTTPClient WiFiClient';
  const AR = 'HIGH LOW INPUT OUTPUT INPUT_PULLUP INPUT_PULLDOWN Serial WiFi LED_BUILTIN setup loop pinMode digitalWrite digitalRead analogRead analogWrite delay millis micros ledcWrite ledcAttach Wire SPI';
  const kw = new Set(KW.split(' ')), ty = new Set(TY.split(' ')), ar = new Set(AR.split(' '));
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const RE = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(^[ \t]*#[ \t]*\w+)|(\b0x[0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]*\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/gm;
  function highlight(src) {
    let out = '', last = 0, m; RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      out += esc(src.slice(last, m.index)); last = RE.lastIndex; const t = esc(m[0]);
      if (m[1]) out += `<span class="tk-c">${t}</span>`; else if (m[2]) out += `<span class="tk-s">${t}</span>`; else if (m[3]) out += `<span class="tk-p">${t}</span>`;
      else if (m[4]) out += `<span class="tk-n">${t}</span>`;
      else { const w = m[5] || m[6]; out += kw.has(w) ? `<span class="tk-k">${t}</span>` : ty.has(w) ? `<span class="tk-t">${t}</span>` : ar.has(w) ? `<span class="tk-m">${t}</span>` : m[5] ? `<span class="tk-f">${t}</span>` : t; }
      if (m[0] === '') RE.lastIndex++;
    }
    return out + esc(src.slice(last));
  }
  // gcc/arduino-cli diagnostics: "sketch.ino:12:5: error: ..." -> {file:{line:{kind,msg}}}
  function parseLog(log) {
    const out = {}; const re = /(?:^|[\s/~.])([\w.-]+\.(?:ino|h|hpp|c|cpp)):(\d+):(?:\d+:)?\s*(fatal error|error|warning):\s*(.*)/gm; let m;
    while ((m = re.exec(log || ''))) { const f = m[1] === 'sketch.ino' ? 'sketch' : m[1]; (out[f] = out[f] || {}); const k = m[3] === 'warning' ? 'w' : 'e'; if (!out[f][m[2]] || k === 'e') out[f][m[2]] = { k, msg: m[4] }; }
    return out;
  }
  class CodeView {
    constructor(ta, pre, gutter, fileFn) {
      this.ta = ta; this.pre = pre; this.gut = gutter; this.file = fileFn || (() => 'sketch'); this.errs = {}; this.last = null; this.lastN = -1;
      ta.addEventListener('input', () => this.refresh()); ta.addEventListener('scroll', () => this.sync());
      setInterval(() => { if (ta.value !== this.last) this.refresh(); }, 250);   // catches programmatic value changes (file switch, project load)
      this.refresh();
    }
    setLog(log) { this.errs = parseLog(log); this.lastN = -1; this.refresh(true); }
    refresh(force) {
      const v = this.ta.value; if (v === this.last && !force) return; this.last = v;
      const E = this.errs[this.file()] || {}, lines = v.split('\n');
      let html = highlight(v);
      if (Object.keys(E).length) { const hl = html.split('\n'); for (const ln in E) if (hl[ln - 1] !== undefined && E[ln].k === 'e') hl[ln - 1] = `<span class="lerr" title="${esc(E[ln].msg)}">${hl[ln - 1] || ' '}</span>`; html = hl.join('\n'); }
      this.pre.innerHTML = html + '\n';
      if (lines.length !== this.lastN || force) { this.lastN = lines.length; let g = ''; for (let i = 1; i <= lines.length; i++) { const e = E[i]; g += e ? `<div class="${e.k}" title="${esc(e.msg)}">${i}</div>` : `<div>${i}</div>`; } this.gut.innerHTML = g + '<div style="height:40px"></div>'; }
      this.sync();
    }
    sync() { this.pre.scrollTop = this.ta.scrollTop; this.pre.scrollLeft = this.ta.scrollLeft; this.gut.scrollTop = this.ta.scrollTop; }
  }
  const api = { CodeView, highlight, parseLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CodeViewMod = api;
})(typeof window !== 'undefined' ? window : globalThis);
