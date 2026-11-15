const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const sentence = "Can't reach the simulator right now. Your work is saved on this device. Try again in a moment.";

test('a failed compile says what happened and what to do', () => {
  assert.ok(src.includes(sentence));
  assert.equal(src.includes('backend unreachable'), false);
  assert.equal(src.includes('start server/server.py'), false);
  assert.match(src, /short: 'Offline'/);
  assert.match(src, /serialAppend\('\\n' \+ OFFLINE \+ '\\n'\)/);
});
