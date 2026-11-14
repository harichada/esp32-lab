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

test('a library the build system cannot find is one sentence', () => {
  const h = H.parse("Error during build: Library 'Adafruit_SSD1306' not found\n", '').hints[0];
  assert.equal(h.kind, 'library');
  assert.equal(h.sentence, 'The library `Adafruit_SSD1306` is not installed. Install it, or remove the #include that asks for it.');
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
  assert.equal(h.sentence, 'Line 4 uses `i` outside the block where it was declared (line 2). Move the use inside that block, or declare `i` again on this line.');
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

test('an unrecognized diagnostic is a sentence plus that compiler line', () => {
  const h = H.parse('sketch.ino:9:1: error: template constraint failure for foo\n', '').hints[0];
  assert.equal(h.kind, 'generic');
  assert.equal(h.line, 9);
  assert.match(h.sentence, /template constraint failure for foo/);
  assert.notEqual(h.sentence.trim(), '');
});

test('a log with no diagnostic is a sentence plus the first compiler line', () => {
  const h = H.parse('ld: something unexpected happened\n', '').hints[0];
  assert.equal(h.kind, 'generic');
  assert.equal(h.sentence, 'The compiler stopped, and this view doesn\'t have a plainer version of that message yet: `ld: something unexpected happened`.');
});

test('an empty log is never a blank sentence', () => {
  const h = H.parse('   \n\n', '').hints[0];
  assert.equal(h.sentence, 'The compiler stopped without a message. Press Run again in a moment.');
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
      textContent: '',
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
  const log = 'sketch.ino:4:2: error: <img src=x onerror=alert(1)>\n</pre><script>alert(1)</script>\n';
  const before = nodes.length;
  const parsed = H.showFailure(log, { doc, code: 'void setup(){}\nvoid loop(){}\n' });
  assert.ok(parsed);
  assert.match(parsed.hints[0].sentence, /<img src=x onerror=alert\(1\)>/);
  const box = doc.getElementById('compileHints');
  assert.ok(box);
  assert.match(box._jump.textContent, /<img src=x onerror=alert\(1\)>/);
  box._rawBtn.click();
  assert.match(box._raw.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(box._raw.textContent, /<\/pre><script>/);
  const created = nodes.slice(before).map((n) => n.tagName);
  assert.deepEqual(created.filter((t) => t === 'IMG' || t === 'SCRIPT' || t === 'IFRAME'), []);
  assert.ok(created.includes('BUTTON'));
  assert.ok(created.includes('PRE'));
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
  assert.ok(doc.getElementById('code').scrollTop >= 0);
});

test('the flag-off failure path in app.js is the build-log path', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  assert.match(src, /\$\('#buildDet'\)\.open = true; document\.querySelector\('\[data-tab=build\]'\)\.click\(\); if \(app\.codeview\) app\.codeview\.setLog\(res\.log \|\| ''\); serialAppend\('\\n\[compile failed — see build log in Code tab\]\\n'\); app\.run = null; return;/);
  assert.match(src, /if \(hintsOn\) \{\s*CompileHints\.showFailure/);
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
