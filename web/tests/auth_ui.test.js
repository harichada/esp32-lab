'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..');

test('the page has no sign-in entry until a session exists', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const auth = fs.readFileSync(path.join(WEB, 'js/auth.js'), 'utf8');
  assert.doesNotMatch(html, /Sign in/);
  assert.doesNotMatch(html, /id="bSignIn"/);
  assert.doesNotMatch(html, /id="mSignIn"/);
  assert.doesNotMatch(html, /id="authSlot"/);
  assert.doesNotMatch(html, /id="mAuth"/);
  assert.doesNotMatch(html, /name="cl-auth"/);
  assert.match(auth, /function authOn\(\)/);
  assert.match(auth, /if \(!authOn\(\)\) return/);
  assert.match(auth, /res\.ok \? res\.json\(\) : null/);
  assert.match(auth, /if \(!data \|\| !data\.providers\) return/);
  assert.match(auth, /Save your /);
  assert.match(auth, /Not now/);
  assert.match(auth, /role', 'dialog'/);
  assert.match(html, /auth\.js\?v=2/);
});
