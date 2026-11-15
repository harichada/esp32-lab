/* Plain-language compile errors. The page reads <meta name="compilehints" content="1">,
 * which server.py injects only when COMPILE_HINTS_ENABLED is on. Anything else,
 * including a missing tag, leaves this module idle: it does not create elements.
 * Compiler text is assigned with textContent only.
 */
(function (root) {
  const CAP = 64 * 1024;
  const MAX_LINE = 512;
  const MAX_HINTS = 30;
  const SNIP = 48;
  const ON = { '1': 1, true: 1, yes: 1, on: 1 };
  const TYPES = 'int|char|float|double|bool|boolean|byte|word|auto|String|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|size_t|long|short';
  const KNOWN = ['pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'analogReadMilliVolts', 'delay', 'delayMicroseconds', 'millis', 'micros', 'ledcWrite', 'ledcAttach', 'pulseIn', 'tone', 'noTone', 'attachInterrupt', 'detachInterrupt', 'constrain', 'map', 'println', 'print', 'printf', 'begin', 'available', 'parseInt', 'Serial', 'WiFi', 'Wire', 'SPI', 'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'INPUT_PULLDOWN', 'LED_BUILTIN', 'setup', 'loop'];
  const DIAG_RE = /(?:^|\/)([^/\s:]+\.(?:ino|h|hpp|c|cpp)):(\d+):(\d+):\s*(fatal error|error):\s*(.*)$/;
  const JOB_RE = /^# job ([A-Za-z0-9_-]{8,64})$/;

  function norm(s) {
    return String(s || '').replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"');
  }
  function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    return t.slice(0, n - 1).replace(/\s+$/, '') + '…';
  }
  function escapeReg(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function tagLog(job, text) {
    return '# job ' + job + '\n' + String(text || '');
  }
  function ownsLog(log, job) {
    if (!job || !/^[A-Za-z0-9_-]{8,64}$/.test(job)) return false;
    const first = String(log || '').split('\n', 1)[0];
    const m = JOB_RE.exec(first);
    return !!(m && m[1] === job);
  }
  function untag(log) {
    return String(log || '').replace(/^# job [A-Za-z0-9_-]+\n/, '');
  }
  function acceptLog(log, job) {
    const text = String(log || '');
    if (!/^# job /.test(text)) return text;
    if (!ownsLog(text, job)) return '';
    return untag(text);
  }
  function enabled(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || typeof d.querySelector !== 'function') return false;
    const meta = d.querySelector('meta[name="compilehints"]');
    if (!meta || typeof meta.getAttribute !== 'function') return false;
    const v = String(meta.getAttribute('content') || '').trim().toLowerCase();
    return !!ON[v];
  }
  function asWindow(log) {
    if (log == null) return { text: '', capped: false };
    if (typeof log === 'string') {
      const capped = log.length > CAP;
      return { text: capped ? log.slice(-CAP) : log, capped: capped };
    }
    let bytes = null;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(log)) bytes = log;
    else if (typeof Uint8Array !== 'undefined' && log instanceof Uint8Array) bytes = log;
    if (bytes) {
      const capped = bytes.length > CAP;
      const view = capped ? bytes.subarray(bytes.length - CAP) : bytes;
      let text = '';
      try { text = new TextDecoder('utf-8', { fatal: false }).decode(view); }
      catch (e) {
        const parts = [];
        for (let i = 0; i < view.length; i += 8192) parts.push(String.fromCharCode.apply(null, view.subarray(i, i + 8192)));
        text = parts.join('');
      }
      return { text: text, capped: capped };
    }
    const s = String(log);
    const capped = s.length > CAP;
    return { text: capped ? s.slice(-CAP) : s, capped: capped };
  }
  function clipLines(s) {
    if (!s) return '';
    if (s.indexOf('\n') < 0) return s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s;
    const parts = s.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > MAX_LINE) parts[i] = parts[i].slice(0, MAX_LINE);
    }
    return parts.join('\n');
  }
  function boundLog(log) {
    return clipLines(asWindow(untag(log)).text);
  }
  function stripTrailingComment(s) {
    const src = String(s || '');
    let out = '';
    let quote = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      const n = src[i + 1];
      if (quote) {
        out += c;
        if (c === '\\' && i + 1 < src.length) { out += src[++i]; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") { quote = c; out += c; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) break;
        if (src.slice(end + 2).trim() === '') break;
        out += src.slice(i, end + 2);
        i = end + 1;
        continue;
      }
      out += c;
    }
    return out.replace(/\s+$/, '').trim();
  }
  function snippetAt(rawLines, index, lineNo) {
    for (let i = index + 1; i < rawLines.length && i < index + 10; i++) {
      const m = /^\s*(\d+)\s+\|(.*)$/.exec(rawLines[i]);
      if (!m) continue;
      if (Number(m[1]) === lineNo) return m[2].replace(/\s+$/, '').trim();
    }
    return '';
  }
  function noteLine(rawLines, index, re) {
    for (let i = index + 1; i < rawLines.length && i < index + 16; i++) {
      const m = re.exec(norm(rawLines[i]));
      if (m) return Number(m[1]);
    }
    return null;
  }
  function isCall(snippet, name) {
    if (!snippet || !name) return false;
    return new RegExp('\\b' + escapeReg(name) + '\\s*\\(').test(snippet);
  }
  function levenshtein(a, b) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 2 || la > 40 || lb > 40) return 9;
    const row = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) row[j] = j;
    for (let i = 1; i <= la; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= lb; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
        prev = tmp;
      }
    }
    return row[lb];
  }
  function suggest(name, source) {
    if (!name || name.length > 40) return null;
    const pool = new Set(KNOWN);
    const src = String(source || '').slice(0, 20000);
    const re = /\b[A-Za-z_]\w{1,40}\b/g;
    let m;
    while ((m = re.exec(src))) pool.add(m[0]);
    const maxD = name.length <= 3 ? 1 : 2;
    let best = null, bestD = maxD + 1;
    for (const cand of pool) {
      if (cand === name) continue;
      if (cand.toLowerCase() === name.toLowerCase()) return cand;
      const d = levenshtein(name, cand);
      if (d < bestD) { best = cand; bestD = d; }
    }
    return bestD <= maxD ? best : null;
  }
  function scopeClosed(source, name, useLine) {
    const text = String(source || '');
    if (!text || !name || !(useLine > 1)) return null;
    const lines = text.split('\n');
    const declRe = new RegExp('\\b(?:' + TYPES + ')\\s+' + escapeReg(name) + '\\b');
    let depth = 0, inStr = null, inBlock = false;
    const stack = [];
    let closed = null;
    const stop = Math.min(lines.length, useLine - 1);
    for (let li = 0; li < stop; li++) {
      const line = lines[li];
      const stripped = line.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
      const decl = declRe.test(stripped);
      for (let i = 0; i < line.length; i++) {
        const c = line[i], n = line[i + 1];
        if (inBlock) {
          if (c === '*' && n === '/') { inBlock = false; i++; }
          continue;
        }
        if (inStr) {
          if (c === '\\') { i++; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '/' && n === '/') break;
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
          depth = Math.max(0, depth - 1);
          while (stack.length && stack[stack.length - 1].depth > depth) closed = stack.pop();
        }
      }
      if (decl) stack.push({ line: li + 1, depth: depth });
    }
    return stack.length ? null : (closed && closed.line);
  }
  function hint(kind, diag, sentence) {
    return { kind: kind, line: diag.line, column: diag.column, file: diag.file, sentence: sentence };
  }
  function classify(diag, rawLines, source) {
    const message = diag.message;
    let m;
    if ((m = /stray '([^']*)' in program|extended character (\S+) is not valid/.exec(message))) {
      const ch = m[1] != null && m[1] !== '' ? m[1] : (m[2] || 'a non-ASCII byte');
      return hint('stray', diag, 'Line ' + diag.line + ' has a stray character (' + ch + ') the compiler can\'t read. Delete it and retype that part of the line.');
    }
    if (/missing terminating " character|missing terminating ' character/.test(message)) {
      const q = /missing terminating ' character/.test(message) ? "'" : '"';
      return hint('quote', diag, 'Line ' + diag.line + ' is missing the closing ' + q + ' of a string. Add ' + q + ' at the end of the text.');
    }
    if (/expected ';' before/.test(message)) {
      const bare = stripTrailingComment(diag.snippet || '');
      const shown = bare ? '`' + clip(bare, SNIP) + '`' : 'the end of that line';
      return hint('semicolon', diag, 'Line ' + diag.line + ' is missing a semicolon (;) at the end. Add ; after ' + shown + '.');
    }
    if (/expected '}' at end of input|expected '}' before|function-definition is not allowed here before '\{'/.test(message)) {
      const open = noteLine(rawLines, diag.index, /:(\d+):\d+:\s*note: to match this '\{'/);
      const sentence = open && open !== diag.line
        ? 'Line ' + diag.line + ' is missing a closing `}`. Add `}` before the `{` from line ' + open + '.'
        : 'Line ' + diag.line + ' is missing a closing `}`. Add `}` to close the open block.';
      return hint('brace', diag, sentence);
    }
    if (/expected '\)' before/.test(message)) {
      return hint('paren', diag, 'Line ' + diag.line + ' is missing a `)`. Add `)` to close the `(` on that line.');
    }
    if ((m = /invalid conversion from '([^']*)' to '([^']*)'|cannot convert '([^']*)' to '([^']*)'/.exec(message))) {
      const from = m[1] || m[3] || 'one type';
      const to = m[2] || m[4] || 'another type';
      const art = (w) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
      return hint('conversion', diag, 'Line ' + diag.line + ' can\'t use ' + art(from) + ' where ' + art(to) + ' is required. Change the value or the variable type so they match.');
    }
    if ((m = /^(.+?): No such file or directory/.exec(message))) {
      const file = m[1].trim();
      return hint('include', diag, 'Line ' + diag.line + ' can\'t find `' + file + '`. Install the library that provides it, or correct the #include.');
    }
    if ((m = /too (few|many) arguments to function '([^']*)'/.exec(message))) {
      const sig = m[2];
      const name = (/\b([A-Za-z_]\w*)\s*\(/.exec(sig) || [])[1] || 'that function';
      const how = m[1] === 'few' ? 'too few arguments' : 'too many arguments';
      return hint(m[1] === 'few' ? 'too-few' : 'too-many', diag, 'Line ' + diag.line + ' passes ' + how + ' to `' + name + '`. It is declared as `' + sig + '`.');
    }
    if ((m = /ambiguating new declaration of '([^']*)'/.exec(message))) {
      const name = (/\b(setup|loop)\b/.exec(m[1]) || [])[1] || 'that function';
      return hint('signature', diag, 'Line ' + diag.line + ' declares `' + name + '` with the wrong signature (`' + m[1] + '`). Use `void ' + name + '()` with no arguments.');
    }
    if ((m = /forbids declaration of '(setup|loop)' with no type|'(setup|loop)' does not name a type/.exec(message))) {
      const name = m[1] || m[2];
      return hint('return-type', diag, 'Line ' + diag.line + ' declares `' + name + '` without a return type. Write `void ' + name + '()`.');
    }
    if (/return-statement with a value/.test(message)) {
      return hint('void-return', diag, 'Line ' + diag.line + ' returns a value from a void function. Delete the value after `return`.');
    }
    if ((m = /redefinition of '([^']+)'/.exec(message))) {
      const name = (/\b([A-Za-z_]\w*)\s*\(/.exec(m[1]) || /\b([A-Za-z_]\w*)\s*$/.exec(m[1]) || [])[1] || 'that';
      const typed = /\(/.test(m[1]) ? ('void ' + name + '()') : name;
      return hint('duplicate', diag, 'Line ' + diag.line + ' defines `' + name + '` again. Keep one `' + typed + '` and delete the other.');
    }
    if ((m = /'([^']*)' does not name a type/.exec(message))) {
      return hint('type', diag, 'Line ' + diag.line + ' uses the type `' + m[1] + '` before it exists. Declare `struct ' + m[1] + '` above this line.');
    }
    if ((m = /has no member named '([^']*)'(?:; did you mean '([^']*)')?/.exec(message))) {
      const call = /([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/.exec(diag.snippet || '');
      const obj = call ? call[1] : 'that object';
      const fix = m[2] ? ' Did you mean `' + m[2] + '`?' : ' Check the spelling.';
      return hint('misspelled', diag, 'Line ' + diag.line + ' calls `' + m[1] + '` on `' + obj + '`, which isn\'t a function there.' + fix);
    }
    if ((m = /no matching function for call to '([^']*)'/.exec(message))) {
      return hint('misspelled', diag, 'Line ' + diag.line + ' calls `' + m[1] + '`, which doesn\'t match a function here. Check the name and the arguments.');
    }
    if ((m = /'([^']*)' was not declared in this scope(?:; did you mean '([^']*)')?/.exec(message))) {
      const name = m[1];
      let alt = m[2] || '';
      if (!alt) {
        const closed = scopeClosed(source, name, diag.line);
        if (closed) return hint('scope', diag, 'Line ' + diag.line + ' uses `' + name + '` past its block (line ' + closed + '). Move it inside, or write `int ' + name + '` on this line.');
        alt = suggest(name, source) || '';
      }
      const call = isCall(diag.snippet, name);
      if (call && alt) return hint('undeclared', diag, 'Line ' + diag.line + ' calls `' + name + '`, which isn\'t a function. Did you mean `' + alt + '`?');
      if (call) return hint('undeclared', diag, 'Line ' + diag.line + ' calls `' + name + '`, which isn\'t a function. Check the spelling, or define it.');
      if (alt) return hint('undeclared', diag, 'Line ' + diag.line + ' uses `' + name + '`, which isn\'t defined. Did you mean `' + alt + '`?');
      return hint('undeclared', diag, 'Line ' + diag.line + ' uses `' + name + '`, which isn\'t defined. Check the spelling, or declare it before this line.');
    }
    return hint('generic', diag, 'Line ' + diag.line + ' failed to compile. Check the code on that line.');
  }
  function linkerHint(text) {
    const m = /undefined reference to [`']([^'`]+)[`']/.exec(String(text || ''));
    if (!m) return null;
    const sym = String(m[1] || '').replace(/\(.*/, '') || m[1];
    const shown = clip(sym, 32);
    return { kind: 'linker', line: null, column: null, file: '', sentence: 'The link step can\'t find `' + shown + '`. Define `' + shown + '` or remove the call.' };
  }
  function libraryHint(text, source) {
    const m = /doesn't have a library called ([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/.exec(String(text || ''));
    if (!m) return null;
    const name = m[1];
    const stem = name.replace(/\.h(?:pp)?$/, '');
    const lines = String(source || '').split('\n');
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (/#\s*include/.test(lines[i]) && lines[i].indexOf(stem) >= 0) { line = i + 1; break; }
    }
    return { kind: 'library', line: line, column: 1, file: 'sketch.ino', sentence: 'Line ' + line + ' includes `' + name + '`, which isn\'t available. Remove that `#include`.' };
  }
  function parse(log, source) {
    const windowed = asWindow(log);
    const capped = windowed.capped;
    const text = clipLines(windowed.text);
    const rawLines = text.split('\n');
    const diags = [];
    const seen = new Set();
    for (let i = 0; i < rawLines.length; i++) {
      const m = DIAG_RE.exec(norm(rawLines[i]));
      if (!m || m[4] === 'warning') continue;
      const diag = {
        file: m[1],
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : null,
        message: m[5],
        index: i,
        snippet: snippetAt(rawLines, i, Number(m[2])),
      };
      const key = diag.file + ':' + diag.line + ':' + diag.column + ':' + diag.message;
      if (seen.has(key)) continue;
      seen.add(key);
      diags.push(diag);
      if (diags.length >= MAX_HINTS) break;
    }
    if (!diags.length) {
      const extra = linkerHint(text) || libraryHint(text, source);
      return { hints: extra ? [extra] : [], capped: capped };
    }
    const hints = [];
    for (let i = 0; i < diags.length && hints.length < MAX_HINTS; i++) hints.push(classify(diags[i], rawLines, source));
    return { hints: hints, capped: capped };
  }

  function paint(box) {
    const state = box._hintState;
    const hints = state.parsed.hints;
    const h = hints[state.index] || hints[0];
    box._jump.textContent = h && h.sentence ? h.sentence : '';
    if (hints.length > 1) {
      box._nav.hidden = false;
      box._count.textContent = 'Error ' + (state.index + 1) + ' of ' + hints.length;
    } else {
      box._nav.hidden = true;
      box._count.textContent = '';
    }
  }
  function editorFile(name) {
    const n = String(name || '');
    if (!n || n === 'sketch' || n === 'sketch.ino' || n === 'sketch.ino.cpp' || /\.ino\.cpp$/.test(n)) return 'sketch';
    return n;
  }
  function reveal(ta, item) {
    if (!item) return;
    const app = root.app;
    if (item.file && app && typeof app.openCodeFile === 'function') app.openCodeFile(editorFile(item.file));
    if (!ta || !item.line) return;
    const go = () => {
      const value = String(ta.value || '');
      const lines = value.split('\n');
      const li = Math.max(0, Math.min(lines.length - 1, item.line - 1));
      let offset = 0;
      for (let i = 0; i < li; i++) offset += lines[i].length + 1;
      const col = item.column && item.column > 0 ? item.column - 1 : 0;
      const pos = offset + Math.min(col, lines[li].length);
      try { ta.focus({ preventScroll: true }); } catch (e) { try { ta.focus(); } catch (e2) { /* no focus */ } }
      if (typeof ta.setSelectionRange === 'function') {
        try { ta.setSelectionRange(pos, pos); } catch (e3) { /* detached */ }
      }
      let lh = 20, padT = 10;
      try {
        const cs = getComputedStyle(ta);
        const parsed = parseFloat(cs.lineHeight);
        if (parsed > 0) lh = parsed;
        const pt = parseFloat(cs.paddingTop);
        if (pt >= 0) padT = pt;
      } catch (e4) { /* defaults */ }
      const viewH = ta.clientHeight || 0;
      if (viewH) ta.scrollTop = Math.max(0, padT + li * lh - Math.max(8, viewH * 0.28));
      ta.scrollLeft = 0;
      if (typeof ta.dispatchEvent === 'function') {
        try { ta.dispatchEvent(new Event('scroll')); } catch (e5) { /* no Event */ }
      }
    };
    go();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    if (typeof setTimeout === 'function') setTimeout(go, 360);
  }
  function openEditor(doc) {
    const body = doc && doc.body;
    if (body && body.classList && body.classList.contains('m') && root.Mobile && typeof root.Mobile.setSheet === 'function') {
      root.Mobile.setSheet('code');
    }
    const tab = doc.querySelector && doc.querySelector('[data-tab=code]');
    if (tab && tab.classList && !tab.classList.contains('on') && typeof tab.click === 'function') tab.click();
  }
  function mount(doc) {
    let box = doc.getElementById('compileHints');
    if (box) return box;
    const tab = doc.getElementById('tab-code');
    if (!tab) return null;
    box = doc.createElement('div');
    box.id = 'compileHints';
    box.className = 'compile-hint';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const jump = doc.createElement('button');
    jump.type = 'button';
    jump.id = 'compileHintJump';
    jump.className = 'compile-hint-jump';
    const nav = doc.createElement('div');
    nav.id = 'compileHintNav';
    nav.className = 'compile-hint-nav';
    nav.hidden = true;
    const count = doc.createElement('span');
    count.id = 'compileHintCount';
    const next = doc.createElement('button');
    next.type = 'button';
    next.id = 'compileHintNext';
    next.className = 'compile-hint-next';
    next.textContent = 'Next error';
    nav.appendChild(count);
    nav.appendChild(next);
    const rawBtn = doc.createElement('button');
    rawBtn.type = 'button';
    rawBtn.id = 'compileHintRawBtn';
    rawBtn.className = 'compile-hint-rawbtn';
    rawBtn.textContent = 'Show full compiler output';
    rawBtn.setAttribute('aria-expanded', 'false');
    rawBtn.setAttribute('aria-controls', 'compileHintRaw');
    const raw = doc.createElement('pre');
    raw.id = 'compileHintRaw';
    raw.className = 'compile-hint-raw';
    raw.hidden = true;
    raw.setAttribute('tabindex', '0');
    const more = doc.createElement('button');
    more.type = 'button';
    more.id = 'compileHintMore';
    more.className = 'compile-hint-more';
    more.textContent = 'Details';
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', 'compileHintExtra');
    const extra = doc.createElement('div');
    extra.id = 'compileHintExtra';
    extra.className = 'compile-hint-extra';
    extra.appendChild(nav);
    extra.appendChild(rawBtn);
    extra.appendChild(raw);
    box.appendChild(jump);
    box.appendChild(more);
    box.appendChild(extra);
    box._more = more;
    more.addEventListener('click', () => {
      const open = box.classList ? box.classList.toggle('open') : false;
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    box._jump = jump;
    box._nav = nav;
    box._count = count;
    box._next = next;
    box._rawBtn = rawBtn;
    box._raw = raw;
    if (tab.appendChild) tab.appendChild(box);
    if (tab.classList) tab.classList.add('hint-on');
    jump.addEventListener('click', () => {
      const state = box._hintState;
      if (!state) return;
      reveal(doc.getElementById('code'), state.parsed.hints[state.index]);
    });
    next.addEventListener('click', () => {
      const state = box._hintState;
      if (!state || state.parsed.hints.length < 2) return;
      state.index = (state.index + 1) % state.parsed.hints.length;
      paint(box);
      reveal(doc.getElementById('code'), state.parsed.hints[state.index]);
    });
    rawBtn.addEventListener('click', () => {
      const state = box._hintState;
      const opening = !!raw.hidden;
      raw.hidden = !opening;
      rawBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      rawBtn.textContent = opening ? 'Hide full compiler output' : 'Show full compiler output';
      if (opening) {
        const note = state && state.capped ? 'Showing the last 64 KB of compiler output.\n' : '';
        const text = note + (state ? state.log : '');
        const lines = String(text).split('\n');
        let hit = -1;
        for (let i = 0; i < lines.length; i++) {
          if (DIAG_RE.test(norm(lines[i]))) { hit = i; break; }
        }
        raw.textContent = '';
        for (let i = 0; i < lines.length; i++) {
          const span = doc.createElement('span');
          span.textContent = lines[i] + (i + 1 < lines.length ? '\n' : '');
          if (i === hit) {
            span.className = 'compile-hint-hit';
            span.setAttribute('id', 'compileHintHit');
          }
          raw.appendChild(span);
        }
        raw.scrollTop = hit > 0 ? hit * 18 : 0;
        if (raw.children) {
          for (let i = 0; i < raw.children.length; i++) {
            const child = raw.children[i];
            if (child && child.id === 'compileHintHit' && typeof child.scrollIntoView === 'function') {
              try { child.scrollIntoView({ block: 'nearest' }); } catch (e) { /* no layout */ }
            }
          }
        }
      }
    });
    return box;
  }
  function clear(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || typeof d.getElementById !== 'function') return;
    const box = d.getElementById('compileHints');
    if (box && box.parentNode && box.parentNode.removeChild) box.parentNode.removeChild(box);
    const tab = d.getElementById('tab-code');
    if (tab && tab.classList) tab.classList.remove('hint-on');
  }
  function showFailure(log, opts) {
    opts = opts || {};
    const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!enabled(doc)) return null;
    const source = opts.code != null ? String(opts.code) : (doc && doc.getElementById && doc.getElementById('code') ? doc.getElementById('code').value : '');
    const parsed = parse(log, source);
    if (!parsed.hints.length) {
      clear(doc);
      return parsed;
    }
    const box = mount(doc);
    if (!box) return parsed;
    box._raw.hidden = true;
    if (box.classList) box.classList.remove('open');
    if (box._more) box._more.setAttribute('aria-expanded', 'false');
    box._rawBtn.textContent = 'Show full compiler output';
    box._rawBtn.setAttribute('aria-expanded', 'false');
    box._hintState = { index: 0, parsed: parsed, log: boundLog(log), capped: parsed.capped };
    paint(box);
    openEditor(doc);
    const ta = opts.ta || doc.getElementById('code');
    reveal(ta, parsed.hints[0]);
    return parsed;
  }

  const api = {
    CAP: CAP, MAX_LINE: MAX_LINE, enabled: enabled, boundLog: boundLog, parse: parse,
    showFailure: showFailure, clear: clear, tagLog: tagLog, ownsLog: ownsLog, acceptLog: acceptLog, untag: untag,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CompileHints = api;
})(typeof window !== 'undefined' ? window : globalThis);
