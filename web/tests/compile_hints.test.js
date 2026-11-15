'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../js/compilehints.js');

const fixDir = path.join(__dirname, 'fixtures/compile');
const read = (name) => fs.readFileSync(path.join(fixDir, name), 'utf8');
const first = (name, source) => H.parse(read(name), source || '').hints[0];

test('missing semicolon names the line and the statement', () => {
  const h = first('semi.txt');
  assert.equal(h.kind, 'semicolon');
  assert.equal(h.line, 12);
  assert.equal(h.column, 26);
  assert.equal(h.sentence, 'Line 12 is missing a semicolon (;) at the end. Add ; after `digitalWrite(LED, HIGH)`.');
});

test('a stage banner in front of gcc output still finds the semicolon', () => {
  const log = 'Compiling sketch...\n' + read('semi.txt') + '\n[0.4s] compile\n';
  const h = H.parse(log, '').hints[0];
  assert.equal(h.sentence, 'Line 12 is missing a semicolon (;) at the end. Add ; after `digitalWrite(LED, HIGH)`.');
});

test('undeclared pinMode typo repeats gcc\'s did you mean', () => {
  const h = first('pinmod.txt');
  assert.equal(h.kind, 'undeclared');
  assert.equal(h.line, 5);
  assert.equal(h.column, 3);
  assert.equal(h.sentence, 'Line 5 calls `pinMod`, which isn\'t a function. Did you mean `pinMode`?');
});

test('undeclared variable typo repeats gcc\'s did you mean', () => {
  const h = first('var.txt');
  assert.equal(h.kind, 'undeclared');
  assert.equal(h.line, 5);
  assert.equal(h.column, 16);
  assert.equal(h.sentence, 'Line 5 uses `LEDD`, which isn\'t defined. Did you mean `LED`?');
});

test('a close identifier is suggested when gcc omits did you mean', () => {
  const log = read('pinmod.txt').replace(/; did you mean ‘pinMode’\?/, '');
  const h = H.parse(log, read('pinmod.ino')).hints[0];
  assert.equal(h.kind, 'undeclared');
  assert.equal(h.sentence, 'Line 5 calls `pinMod`, which isn\'t a function. Did you mean `pinMode`?');
});

test('ascii quotes parse the same as gcc\'s curly quotes', () => {
  const log = read('pinmod.txt').replace(/\u2018|\u2019/g, "'");
  assert.equal(H.parse(log, '').hints[0].sentence, first('pinmod.txt').sentence);
});

test('a misspelled function call names the real function', () => {
  const h = first('fn.txt');
  assert.equal(h.kind, 'undeclared');
  assert.equal(h.sentence, 'Line 5 calls `digitlWrite`, which isn\'t a function. Did you mean `digitalWrite`?');
});

test('a misspelled method uses gcc\'s did you mean', () => {
  const h = first('member.txt');
  assert.equal(h.kind, 'misspelled');
  assert.equal(h.line, 4);
  assert.equal(h.sentence, 'Line 4 calls `printl` on `Serial`, which isn\'t a function there. Did you mean `println`?');
});

test('a missing } points at the brace gcc says is still open', () => {
  const h = first('brace.txt');
  assert.equal(h.kind, 'brace');
  assert.equal(h.line, 4);
  assert.match(h.sentence, /missing a closing `}`/);
  assert.match(h.sentence, /line 2/);
  assert.match(h.sentence, /Add `}`/);
});

test('invalid conversion names both types', () => {
  const h = first('conv.txt');
  assert.equal(h.kind, 'conversion');
  assert.equal(h.line, 2);
  assert.equal(h.column, 11);
  assert.equal(h.sentence, 'Line 2 can\'t use a const char* where an int is required. Change the value or the variable type so they match.');
});

test('a missing #include names the header', () => {
  const h = first('inc.txt');
  assert.equal(h.kind, 'include');
  assert.equal(h.line, 1);
  assert.equal(h.column, 10);
  assert.equal(h.sentence, 'Line 1 can\'t find `NoSuchLib.h`. Install the library that provides it, or correct the #include.');
});

test('a library banner is not a hint, and a trailing comment is not part of the semicolon', () => {
  assert.equal(H.parse("Error during build: Library 'Adafruit_SSD1306' not found\nFQBN: esp32:esp32:esp32doit-devkit-v1\n", '').hints.length, 0);
  const commented = 'sketch.ino:4:5: error: expected \';\' before \'}\' token\n   4 |   delay(1000) // wait for a second\n';
  const block = 'sketch.ino:4:5: error: expected \';\' before \'}\' token\n   4 |   delay(1000) /* wait for a second */\n';
  const line = 'Line 4 is missing a semicolon (;) at the end. Add ; after `delay(1000)`.';
  assert.equal(H.parse(commented, '').hints[0].sentence, line);
  assert.equal(H.parse(block, '').hints[0].sentence, line);
  assert.equal(H.parse(commented, '').hints[0].sentence.includes('//'), false);
  assert.equal(H.parse(block, '').hints[0].sentence.includes('/*'), false);
});

test('a missing return type tells you to write void setup()', () => {
  const h = first('noret.txt');
  assert.equal(h.kind, 'return-type');
  assert.equal(h.line, 1);
  assert.equal(h.sentence, 'Line 1 declares `setup` without a return type. Write `void setup()`.');
});

test('the wrong setup() signature says to use void setup()', () => {
  const h = first('sig.txt');
  assert.equal(h.kind, 'signature');
  assert.equal(h.line, 3);
  assert.equal(h.sentence, 'Line 3 declares `setup` with the wrong signature (`int setup()`). Use `void setup()` with no arguments.');
});

test('the wrong loop() signature says to use void loop()', () => {
  const h = first('sigloop.txt');
  assert.equal(h.kind, 'signature');
  assert.equal(h.sentence, 'Line 4 declares `loop` with the wrong signature (`int loop()`). Use `void loop()` with no arguments.');
});

test('too few arguments names the function gcc declared', () => {
  const h = first('few.txt');
  assert.equal(h.kind, 'too-few');
  assert.equal(h.line, 3);
  assert.equal(h.sentence, 'Line 3 passes too few arguments to `digitalWrite`. It is declared as `void digitalWrite(unsigned char, unsigned char)`.');
});

test('too many arguments names the function gcc declared', () => {
  const h = first('many.txt');
  assert.equal(h.kind, 'too-many');
  assert.equal(h.sentence, 'Line 3 passes too many arguments to `delay`. It is declared as `void delay(long unsigned int)`.');
});

test('a variable used outside its block names the declaration', () => {
  const h = first('scope.txt', read('scope.ino'));
  assert.equal(h.kind, 'scope');
  assert.equal(h.line, 4);
  assert.equal(h.column, 3);
  assert.equal(h.sentence, 'Line 4 uses `i` past its block (line 2). Move it inside, or write `int i` on this line.');
});

test('the same gcc line without the sketch is still a sentence', () => {
  const h = first('scope.txt', '');
  assert.equal(h.kind, 'undeclared');
  assert.match(h.sentence, /Line 4 uses `i`/);
  assert.notEqual(h.sentence, '');
});

test('a stray character names the line', () => {
  const h = first('stray.txt');
  assert.equal(h.kind, 'stray');
  assert.equal(h.line, 2);
  assert.equal(h.column, 12);
  assert.equal(h.sentence, 'Line 2 has a stray character (`) the compiler can\'t read. Delete it and retype that part of the line.');
});

test('a string missing its quote names the line', () => {
  const h = first('quote.txt');
  assert.equal(h.kind, 'quote');
  assert.equal(h.line, 2);
  assert.equal(h.sentence, 'Line 2 is missing the closing " of a string. Add " at the end of the text.');
});

test('an unrecognized diagnostic names the line and does not quote the compiler', () => {
  const h = H.parse('sketch.ino:9:1: error: template constraint failure for foo\n', '').hints[0];
  assert.equal(h.kind, 'generic');
  assert.equal(h.line, 9);
  assert.equal(h.sentence, 'Line 9 failed to compile. Check the code on that line.');
  assert.equal(h.sentence.includes('template'), false);
});

test('a log with no GCC error line shows no hint', () => {
  const banner = 'FQBN: esp32:esp32:esp32doit-devkit-v1\nCompilation error: exit status 1\nld: something unexpected happened\n';
  assert.deepEqual(H.parse(banner, '').hints, []);
  assert.deepEqual(H.parse('   \n\n', '').hints, []);
  const spliced = 'FQBN: esp32:esp32:esp32doit-devkit-v1sketch.ino.cpp:4:3: error: \'led\' was not declared in this scope\n';
  assert.deepEqual(H.parse(spliced, '').hints, []);
});

test('two real errors keep the first, with a count available to the next', () => {
  const parsed = H.parse(read('e2e.txt'), read('e2e-sketch.ino'));
  assert.equal(parsed.hints.length, 2);
  assert.equal(parsed.hints[0].kind, 'semicolon');
  assert.equal(parsed.hints[0].line, 53);
  assert.equal(parsed.hints[0].column, 146);
  assert.match(parsed.hints[0].sentence, /^Line 53 is missing a semicolon \(;\) at the end\. Add ; after `digitalWrite\(LED, HIGH/);
  assert.equal(parsed.hints[1].kind, 'undeclared');
  assert.equal(parsed.hints[1].line, 56);
  assert.match(parsed.hints[1].sentence, /pinMod/);
  assert.match(parsed.hints[1].sentence, /pinMode/);
});

test('a huge log is capped before it is parsed', () => {
  const head = 'sketch.ino:2:1: error: expected \';\' before \'HEAD_ONLY\' token\n   2 | HEAD_ONLY\n';
  const tail = 'sketch.ino:12:26: error: expected \';\' before \'}\' token\n   12 |   digitalWrite(LED, HIGH)\n      |                          ^\n';
  const pad = 'x'.repeat(H.CAP + 50000);
  const t0 = Date.now();
  const parsed = H.parse(head + pad + '\n' + tail, '');
  const ms = Date.now() - t0;
  assert.ok(ms < 500, 'parse took ' + ms + 'ms');
  assert.equal(parsed.capped, true);
  assert.equal(parsed.hints[0].kind, 'semicolon');
  assert.equal(parsed.hints[0].sentence, 'Line 12 is missing a semicolon (;) at the end. Add ; after `digitalWrite(LED, HIGH)`.');
  assert.equal(JSON.stringify(parsed).includes('HEAD_ONLY'), false);
  assert.ok(H.boundLog(pad).length <= H.CAP);
});

test('the mapper source does not parse compiler text as HTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/compilehints.js'), 'utf8');
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write|DOMParser/.test(src), false);
});

function classListFor(node) {
  const set = new Set((node.className || '').split(/\s+/).filter(Boolean));
  const sync = () => { node.className = [...set].join(' '); };
  return {
    add(...xs) { xs.forEach((c) => set.add(c)); sync(); },
    remove(...xs) { xs.forEach((c) => set.delete(c)); sync(); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      sync();
      return on;
    },
  };
}
function makeDoc(metaContent) {
  const nodes = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      _text: '',
      hidden: false,
      value: '',
      parentNode: null,
      children: [],
      attrs: {},
      _root: false,
      _ev: {},
      clientHeight: 220,
      clientWidth: 280,
      scrollTop: 0,
      scrollLeft: 0,
      setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === 'id') this.id = String(v);
        if (k === 'class') this.className = String(v);
      },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(type, fn) { (this._ev[type] = this._ev[type] || []).push(fn); },
      dispatchEvent(e) { (this._ev[e.type] || []).forEach((fn) => fn(e)); },
      click() { this.dispatchEvent({ type: 'click', target: this }); },
      focus() {},
      setSelectionRange() {},
    };
    Object.defineProperty(node, 'classList', { value: classListFor(node) });
    Object.defineProperty(node, 'textContent', {
      get() {
        if (this.children.length) return this.children.map((c) => (c.textContent == null ? '' : String(c.textContent))).join('');
        return this._text;
      },
      set(v) {
        this._text = v == null ? '' : String(v);
        this.children = [];
      },
    });
    Object.defineProperty(node, 'innerHTML', {
      set() { throw new Error('innerHTML used'); },
      get() { throw new Error('innerHTML used'); },
    });
    nodes.push(node);
    return node;
  }
  const tab = el('div');
  tab.id = 'tab-code';
  tab._root = true;
  const code = el('textarea');
  code.id = 'code';
  code._root = true;
  code.value = 'void setup() {\n  pinMode(2, 1);\n}\nvoid loop() {}\n';
  const doc = {
    body: el('body'),
    createElement: el,
    getElementById(id) {
      return nodes.find((n) => n.id === id && (n.parentNode || n._root)) || null;
    },
    querySelector(sel) {
      if (sel === 'meta[name="compilehints"]') {
        if (metaContent == null) return null;
        return { getAttribute: () => metaContent };
      }
      if (sel === '[data-tab=code]') return { classList: { contains: () => true }, click() {} };
      return null;
    },
  };
  return { doc, nodes, code };
}

test('compiler text is textContent, so an img and a script tag are not created', () => {
  const { doc, nodes } = makeDoc('1');
  const payload = '<img src=x onerror=alert(1)> </script>';
  const log = "sketch.ino:4:5: error: expected ';' before '}' token\n   4 |   " + payload + '\n';
  let ran = 0;
  const prev = global.alert;
  global.alert = () => { ran++; };
  const before = nodes.length;
  try {
    const parsed = H.showFailure(log, { doc, code: 'void setup(){}\nvoid loop(){}\n' });
    assert.ok(parsed);
    assert.match(parsed.hints[0].sentence, /<img src=x onerror=alert\(1\)>/);
    assert.match(parsed.hints[0].sentence, /<\/script>/);
    const box = doc.getElementById('compileHints');
    assert.ok(box);
    assert.match(box._jump.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(box._jump.textContent, /<\/script>/);
    box._rawBtn.click();
    assert.match(box._raw.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(box._raw.textContent, /<\/script>/);
    const created = nodes.slice(before);
    assert.deepEqual(created.filter((n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT' || n.tagName === 'IFRAME'), []);
    for (const n of created) {
      assert.equal(n.children.filter((c) => c.tagName === 'IMG' || c.tagName === 'SCRIPT').length, 0);
    }
    assert.equal(ran, 0);
  } finally {
    global.alert = prev;
  }
});

test('a 1 MB log, invalid bytes, and a very long line finish quickly', () => {
  const tail = 'sketch.ino:12:26: error: expected \';\' before \'}\' token\n   12 |   digitalWrite(LED, HIGH)\n';
  const cases = [
    'y'.repeat(1024 * 1024) + '\n' + tail,
    Buffer.concat([Buffer.alloc(1024 * 1024, 0xff), Buffer.from(tail)]),
    'sketch.ino:8:1: error: ' + 'A'.repeat(200000) + '\n',
  ];
  const expectHint = [true, false, false];
  for (let i = 0; i < cases.length; i++) {
    const log = cases[i];
    const t0 = performance.now();
    const parsed = H.parse(log, '');
    const ms = performance.now() - t0;
    assert.ok(ms < 200, 'parse took ' + ms + 'ms');
    assert.equal(parsed.hints.length >= 1, expectHint[i]);
    if (expectHint[i]) assert.match(parsed.hints[0].sentence, /semicolon/);
    assert.ok(H.boundLog(log).split('\n').every((line) => line.length <= H.MAX_LINE));
  }
  assert.equal(H.boundLog('z'.repeat(H.CAP + 10)).length, H.MAX_LINE);
});

test('the flag-off path does not create hint markup', () => {
  const off = makeDoc(null);
  const n0 = off.nodes.length;
  assert.equal(H.enabled(off.doc), false);
  assert.equal(H.showFailure(read('semi.txt'), { doc: off.doc, code: '' }), null);
  assert.equal(off.nodes.length, n0);
  assert.equal(off.doc.getElementById('compileHints'), null);
  const zero = makeDoc('0');
  assert.equal(H.showFailure('sketch.ino:1:1: error: nope\n', { doc: zero.doc }), null);
  assert.equal(zero.doc.getElementById('compileHints'), null);
});

test('next error advances the sentence and the raw disclosure stays text', () => {
  const { doc } = makeDoc('1');
  H.showFailure(read('e2e.txt'), { doc, code: read('e2e-sketch.ino') });
  const box = doc.getElementById('compileHints');
  assert.match(box._jump.textContent, /semicolon/);
  assert.equal(box._count.textContent, 'Error 1 of 2');
  assert.equal(box._nav.hidden, false);
  box._next.click();
  assert.match(box._jump.textContent, /pinMod/);
  assert.equal(box._count.textContent, 'Error 2 of 2');
  box._jump.click();
  const code = doc.getElementById('code');
  assert.ok(code.scrollTop >= 0);
  assert.equal(code.scrollLeft, 0);
});

test('the raw log scrolls to the first GCC error and the editor stays at the start of the line', () => {
  const { doc } = makeDoc('1');
  const banner = Array.from({ length: 40 }, (_, i) => 'FQBN: esp32:esp32:esp32doit-devkit-v1 note ' + i).join('\n');
  const log = banner + '\nsketch.ino:12:26: error: expected \';\' before \'}\' token\n   12 |   delay(1000) // wait\n';
  H.showFailure(log, { doc, code: 'void setup(){ delay(1000); }\n' });
  const code = doc.getElementById('code');
  assert.equal(code.scrollLeft, 0);
  const box = doc.getElementById('compileHints');
  box._rawBtn.click();
  const hit = doc.getElementById('compileHintHit');
  assert.ok(hit);
  assert.match(hit.textContent, /expected ';' before/);
  assert.ok(box._raw.scrollTop > 0);
  assert.match(box._raw.textContent, /FQBN:/);
  assert.equal(box._raw.children.some((n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT'), false);
});

test('the same undeclared error is the hint twenty times, and two jobs do not share a sketch', () => {
  const sketchA = 'void setup(){ ledA(); }\nvoid loop(){}\n';
  const sketchB = 'void setup(){ ledB(); }\nvoid loop(){}\n';
  const errA = "sketch.ino.cpp:4:3: error: 'ledA' was not declared in this scope\n";
  const errB = "sketch.ino.cpp:9:1: error: 'ledB' was not declared in this scope\n";
  const fqbn = 'FQBN: esp32:esp32:esp32doit-devkit-v1\n';
  const summary = 'Compilation error: exit status 1\n';
  const orders = [
    fqbn + summary + errA,
    errA + fqbn + summary,
    summary + fqbn + errA + 'Used library Version\n',
    'Compiling sketch...\n' + fqbn + errA + summary,
  ];
  let sentence = '';
  for (let i = 0; i < 20; i++) {
    const parsed = H.parse(orders[i % orders.length], sketchA);
    assert.equal(parsed.hints.length, 1);
    assert.equal(parsed.hints[0].kind, 'undeclared');
    assert.match(parsed.hints[0].sentence, /ledA/);
    assert.equal(parsed.hints[0].sentence.includes('FQBN'), false);
    assert.equal(parsed.hints[0].sentence.includes('esp32doit-devkit-v1'), false);
    if (!sentence) sentence = parsed.hints[0].sentence;
    assert.equal(parsed.hints[0].sentence, sentence);
  }
  const jobA = 'job-a-1111';
  const jobB = 'job-b-2222';
  const logA = H.tagLog(jobA, fqbn + errA + summary);
  const logB = H.tagLog(jobB, summary + fqbn + errB);
  assert.equal(H.ownsLog(logA, jobA), true);
  assert.equal(H.ownsLog(logA, jobB), false);
  assert.equal(H.acceptLog(logB, jobA), '');
  assert.match(H.acceptLog(logA, jobA), /ledA/);
  assert.equal(H.parse(H.acceptLog(logB, jobA), sketchA).hints.length, 0);
  const hintA = H.parse(H.acceptLog(logA, jobA), sketchA).hints[0];
  const hintB = H.parse(H.acceptLog(logB, jobB), sketchB).hints[0];
  assert.match(hintA.sentence, /ledA/);
  assert.match(hintB.sentence, /ledB/);
  assert.equal(hintA.sentence.includes('ledB'), false);
  assert.equal(hintB.sentence.includes('ledA'), false);
});

test('the flag-off failure path in app.js is the build-log path', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  assert.match(src, /\$\('#buildDet'\)\.open = true; document\.querySelector\('\[data-tab=build\]'\)\.click\(\); if \(app\.codeview\) app\.codeview\.setLog\(res\.log \|\| ''\); serialAppend\('\\n\[compile failed — see build log in Code tab\]\\n'\); app\.run = null; return;/);
  assert.match(src, /CompileHints\.showFailure/);
  assert.match(src, /res\.job && res\.job !== run\.job/);
});

test('enabled is only the explicit on values', () => {
  const doc = (content) => ({
    querySelector(sel) {
      if (sel !== 'meta[name="compilehints"]' || content == null) return null;
      return { getAttribute: () => content };
    },
  });
  assert.equal(H.enabled(doc(null)), false);
  assert.equal(H.enabled(doc('')), false);
  assert.equal(H.enabled(doc('0')), false);
  assert.equal(H.enabled(doc('no')), false);
  assert.equal(H.enabled(doc('off')), false);
  assert.equal(H.enabled(doc('maybe')), false);
  assert.equal(H.enabled(doc('1')), true);
  assert.equal(H.enabled(doc(' yes ')), true);
  assert.equal(H.enabled(doc('ON')), true);
  assert.equal(H.enabled(doc('true')), true);
});

function hintWords(sentence) {
  return String(sentence).replace(/`[^`]*`/g, ' code ').trim().split(/\s+/).filter(Boolean).length;
}
function hintSentences(sentence) {
  const masked = String(sentence).replace(/`[^`]*`/g, 'code');
  return masked.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
}

test('every hint is at most two sentences and about 25 words', () => {
  const names = fs.readdirSync(fixDir).filter((name) => name.endsWith('.txt'));
  const kinds = new Set();
  for (const name of names) {
    const source = name === 'scope.txt' ? read('scope.ino') : '';
    for (const hint of H.parse(read(name), source).hints) {
      kinds.add(hint.kind);
      assert.ok(hintSentences(hint.sentence) <= 2, hint.sentence);
      assert.ok(hintWords(hint.sentence) <= 25, hintWords(hint.sentence) + ' ' + hint.sentence);
      assert.equal(hint.sentence.includes('//'), false, hint.sentence);
      assert.equal(hint.sentence.includes('/*'), false, hint.sentence);
      assert.equal(/allowlist/i.test(hint.sentence), false, hint.sentence);
    }
  }
  for (const kind of ['semicolon', 'undeclared', 'brace', 'paren', 'void-return', 'duplicate', 'type', 'linker']) {
    assert.equal(kinds.has(kind), true, kind);
  }
});

test('a missing ) , a void return, a duplicate, and a type each get their own hint', () => {
  const paren = first('paren.txt');
  assert.equal(paren.kind, 'paren');
  assert.equal(paren.line, 2);
  assert.match(paren.sentence, /Add `\)`/);
  const back = first('voidret.txt');
  assert.equal(back.kind, 'void-return');
  assert.equal(back.line, 1);
  assert.match(back.sentence, /`return`/);
  const dup = first('dup.txt');
  assert.equal(dup.kind, 'duplicate');
  assert.equal(dup.line, 2);
  assert.match(dup.sentence, /`setup`/);
  assert.match(dup.sentence, /`void setup\(\)`/);
  const type = first('type.txt');
  assert.equal(type.kind, 'type');
  assert.equal(type.line, 1);
  assert.match(type.sentence, /`Foo`/);
  assert.match(type.sentence, /`struct Foo`/);
});

test('an error in helper.h names that file', () => {
  const hint = first('helper.txt');
  assert.equal(hint.file, 'helper.h');
  assert.equal(hint.line, 2);
  assert.equal(hint.kind, 'type');
  assert.match(hint.sentence, /`Foo`/);
});

test('a linker error names the missing symbol and does not quote FQBN', () => {
  const hint = first('link.txt');
  assert.equal(hint.kind, 'linker');
  assert.equal(hint.line, null);
  assert.match(hint.sentence, /`setup`/);
  assert.equal(hint.sentence.includes('FQBN'), false);
  assert.equal(hint.sentence.includes('esp32:esp32'), false);
});

test('an allowlist rejection names the included library and never the allowlist', () => {
  const source = '#include <Adafruit_SSD1306.h>\nvoid setup() {}\nvoid loop() {}\n';
  const log = "Circuit Lab doesn't have a library called Adafruit_SSD1306.h. Check the spelling and capital letters, since names must match exactly, then press Run again.\n";
  const hint = H.parse(log, source).hints[0];
  assert.equal(hint.kind, 'library');
  assert.equal(hint.line, 1);
  assert.equal(hint.file, 'sketch.ino');
  assert.match(hint.sentence, /`Adafruit_SSD1306\.h`/);
  assert.match(hint.sentence, /isn't available/);
  assert.equal(/allowlist/i.test(hint.sentence), false);
  assert.equal(hint.sentence.includes('Wire.h'), false);
  assert.ok(hintSentences(hint.sentence) <= 2);
  assert.ok(hintWords(hint.sentence) <= 25);
});

test('a comment inside a string stays, and code after a block comment stays', () => {
  const str = 'sketch.ino:4:5: error: expected \';\' before \'}\' token\n   4 |   Serial.println("wait // still")\n';
  const after = 'sketch.ino:4:5: error: expected \';\' before \'}\' token\n   4 |   delay(1000) /* keep */ + 1\n';
  assert.match(H.parse(str, '').hints[0].sentence, /wait \/\/ still/);
  assert.match(H.parse(after, '').hints[0].sentence, /delay\(1000\) \/\* keep \*\/ \+ 1/);
});
