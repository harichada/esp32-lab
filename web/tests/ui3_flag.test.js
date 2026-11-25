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
});

test('Studio Dark does not add an AI prompt or a new service', () => {
  assert.doesNotMatch(ui3, /openai|api[_-]?key|llm|Explain this|Make it fade/i);
  assert.match(ui3, /ui3ctx/);
  assert.match(ui3, /Duplicate/);
  assert.match(ui3, /Start the Blink tour/);
});
