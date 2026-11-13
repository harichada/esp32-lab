// An unknown or missing build id is a learner sentence, not the server reason code.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('an unknown build id is shown as an expired build', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const sentence = 'This build has expired. Press Run to build it again.';
  const at = src.indexOf("case 'error'");
  assert.ok(at > 0);
  const block = src.slice(at, at + 800);
  assert.ok(block.includes(sentence), block);
  assert.ok(block.includes("m.reason === 'unknown'"));
  assert.ok(block.includes("m.msg === 'unknown build id'"));
  assert.ok(block.includes("setStatus('err', shown)"));
  assert.equal(block.includes("setStatus('err', 'error')"), false);
});
