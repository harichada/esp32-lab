// Studio Dark stays opt-in. The page source must not turn it on by itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ui3 = fs.readFileSync(path.join(root, 'js', 'ui3.js'), 'utf8');
const toggle = fs.readFileSync(path.join(root, 'js', 'uitoggle.js'), 'utf8');

test('index.html keeps classic as the default and offers ui=3 beside ui=2', () => {
  assert.equal(index.includes('data-ui="3"'), false, 'the markup must not set data-ui');
  assert.equal(index.includes('data-ui="2"'), false);
  assert.match(index, /q==='3'/);
  assert.match(index, /esp32lab\.ui/);
  assert.match(index, /css\/ui3\.css/);
  assert.match(index, /js\/ui3\.js/);
  assert.match(index, /q==='2'/);
  assert.match(index, /css\/ui2\.css/);
  assert.match(index, /js\/ui2\.js/);
  assert.match(index, /js\/uitoggle\.js/);
});

test('the remembered choice is written only by the visible switch', () => {
  assert.match(toggle, /esp32lab\.ui/);
  assert.match(toggle, /Try the new interface/);
  assert.match(toggle, /Switch back/);
  assert.equal(index.includes("setItem('esp32lab.ui'"), false);
  const mobile = fs.readFileSync(path.join(root, 'js', 'mobile.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'css', 'ui3.css'), 'utf8');
  assert.match(ui3, /data-go="classic">Classic UI/);
  assert.match(ui3, /id="ui3Classic">Classic UI/);
  assert.match(ui3, /getElementById\('uiSwitch'\)/);
  assert.match(mobile, /id="mTryUi"/);
  assert.match(mobile, /Try new UI \(Studio Dark\)/);
  const ui2 = fs.readFileSync(path.join(root, 'js', 'ui2.js'), 'utf8');
  assert.match(ui2, /\['Try new UI \(Studio Dark\)', 'uiSwitch'\]/);
  assert.match(mobile, /getElementById\('uiSwitch'\)/);
  assert.match(css, /\.ui3-tile\{[^}]*background:var\(--l2\)/);
  assert.match(css, /#ui3home\{[^}]*background:var\(--bg\)/);
  assert.equal(css.includes('rgba(255,255,255,.03)'), false);
});

test('Studio Dark does not add an AI prompt or a new service', () => {
  assert.doesNotMatch(ui3, /openai|api[_-]?key|llm|Explain this|Make it fade/i);
  assert.match(ui3, /ui3ctx/);
  assert.match(ui3, /Duplicate/);
  assert.match(ui3, /Start the Blink tour/);
  assert.match(ui3, /id="ui3Code"/);
  assert.match(ui3, /toggleCode/);
  assert.match(ui3, /ui3moreProj/);
  assert.match(ui3, /Board layout|aria-label', 'Board'/);
});

test('a 3D click on empty space clears a Studio Dark selection and the serial peek is styled', () => {
  const view3d = fs.readFileSync(path.join(root, 'js', 'view3d.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'css', 'ui3.css'), 'utf8');
  assert.match(view3d, /Math\.hypot\(e\.clientX - this\._ptr\.x, e\.clientY - this\._ptr\.y\) > 5/);
  assert.match(view3d, /hooks\.onEmpty/);
  assert.match(app, /onEmpty:\s*\(\)\s*=>/);
  assert.match(app, /getAttribute\('data-ui'\) !== '3'/);
  assert.match(app, /getAttribute\('data-ui'\) === '3' && app\.editor && app\.editor\.sel/);
  assert.match(css, /#ui3Peek\{/);
  assert.equal(css.includes('#ui3peek'), false);
});

test('closed Studio Dark panels have a way back, including Escape on My Projects', () => {
  const ui = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  assert.match(ui, /toggleCode/);
  assert.match(ui, /key === 'j'/);
  assert.match(app, /if \(d\.hidden \|\| e\.key !== 'Escape'\) return;/);
  assert.match(app, /d\._onEsc = onEsc/);
});
