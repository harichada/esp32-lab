'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..');

test('under /staging/ every auth link stays on /staging/', () => {
  const { here } = require('../js/auth.js');
  global.location = {
    href: 'https://lab.example/staging/?ex=blink',
    origin: 'https://lab.example',
    pathname: '/staging/',
    search: '?ex=blink',
    hash: '',
  };
  global.document = {
    querySelector(sel) {
      if (sel === 'meta[name="cl-auth-base"]') return { getAttribute: () => '/staging' };
      return null;
    },
  };
  for (const path of ['auth/google', 'auth/github', 'auth/session', 'auth/logout', 'auth/projects', 'auth/projects/import', 'auth/google/callback']) {
    const url = here(path);
    assert.equal(url.origin, 'https://lab.example');
    assert.ok(url.pathname.startsWith('/staging/'), url.href);
    assert.equal(url.pathname.startsWith('/staging/auth/'), true, url.href);
  }
  global.document = {
    querySelector() { return null; },
  };
  global.location = {
    href: 'https://lab.example/staging',
    origin: 'https://lab.example',
    pathname: '/staging',
    search: '',
    hash: '',
  };
  assert.equal(here('auth/google').pathname, '/staging/auth/google');
});

test('authentication is opt-in and has no static sign-in controls', () => {
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
  assert.match(auth, /Save your /);
  assert.match(auth, /Not now/);
  assert.match(auth, /role', 'dialog'/);
  assert.match(auth, /#4285F4/);
  assert.match(auth, /#34A853/);
  assert.match(auth, /#FBBC05/);
  assert.match(auth, /#EA4335/);
  assert.match(auth, /currentColor/);
  assert.match(auth, /aria-hidden', 'true'/);
  assert.doesNotMatch(auth, /<img|new Image|fetch\(['"]https?:/);
  assert.match(html, /auth\.js\?v=\d+/);
});

test('a cancelled sign-out stays quiet and a real failure still has a message', () => {
  const { signOutCancelled } = require('../js/auth.js');
  const auth = fs.readFileSync(path.join(WEB, 'js/auth.js'), 'utf8');
  assert.equal(signOutCancelled({ name: 'AbortError' }), true);
  assert.equal(signOutCancelled({ name: 'TypeError', message: 'The user aborted a request.' }), true);
  assert.equal(signOutCancelled({ name: 'TypeError', message: 'NS_BINDING_ABORTED' }), true);
  assert.equal(signOutCancelled({ name: 'TypeError', message: 'Failed to fetch' }), false);
  assert.match(auth, /if \(signOutCancelled\(e\)\) return/);
  assert.match(auth, /Sign-out needs a fresh page/);
});

test('phone sign-in is the first More item and opens the provider directly', () => {
  const { useSession, mountMobile } = require('../js/auth.js');
  const byId = {};
  function make(tag) {
    const node = {
      tagName: tag, className: '', hidden: false, children: [], attrs: {}, dataset: {}, text: '', listeners: [],
      set textContent(v) { this.text = String(v); if (v === '') this.children.length = 0; },
      get textContent() { return this.text; },
      set id(v) { this.attrs.id = v; byId[v] = this; },
      get id() { return this.attrs.id || ''; },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; },
      getAttribute(k) { return this.attrs[k]; },
      append(...xs) { this.children.push(...xs); },
      appendChild(x) { this.children.push(x); return x; },
      insertBefore(child, before) {
        const i = this.children.indexOf(before);
        if (i < 0) this.children.unshift(child);
        else this.children.splice(i, 0, child);
      },
      get firstChild() { return this.children[0] || null; },
      addEventListener(_type, fn) { this.listeners.push(fn); },
      focus() {},
      querySelector(sel) {
        const walk = (n) => {
          if (sel === 'button' && n.tagName === 'button' && n !== node) return n;
          for (const child of n.children || []) {
            const hit = walk(child);
            if (hit) return hit;
          }
          return null;
        };
        return sel === 'button' ? walk(node) : null;
      },
      remove() {},
    };
    return node;
  }
  const more = make('div');
  const examples = make('button');
  examples.textContent = 'Examples';
  more.appendChild(examples);
  global.document = {
    querySelector(sel) {
      if (sel === '#mMore .m-more-b') return more;
      if (sel.charAt(0) === '#') return byId[sel.slice(1)] || null;
      return null;
    },
    getElementById(id) { return byId[id] || null; },
    createElement: make,
    addEventListener() {},
    readyState: 'complete',
  };
  global.location = { href: 'http://127.0.0.1/', pathname: '/', search: '', hash: '' };
  useSession({ signed_in: false, providers: { github: true, google: false }, csrf: '' });
  mountMobile();
  const box = more.children[0];
  assert.equal(box.id, 'mAuth');
  assert.equal(box.attrs.role, 'group');
  assert.equal(box.attrs['aria-labelledby'], 'mAuthTitle');
  assert.equal(box.children[0].tagName, 'h2');
  assert.equal(box.children[0].id, 'mAuthTitle');
  assert.equal(box.children[0].textContent, 'Account');
  assert.equal(box.children[1].textContent, 'Sign in');
  assert.equal(box.children[1].id, 'mSignIn');
  assert.equal(more.children[1].textContent, 'Examples');
  useSession({ signed_in: false, providers: { github: true, google: true }, csrf: '' });
  mountMobile();
  const again = more.children[0];
  assert.equal(again.children[0].textContent, 'Account');
  assert.deepEqual(again.children.slice(1).map((b) => b.textContent), ['Sign in']);
  assert.equal(again.children[1].id, 'mSignIn');
  useSession({ signed_in: true, display_name: 'Ada Lovelace', csrf: 'tok', providers: { github: true } });
  mountMobile();
  const signed = more.children[0];
  assert.equal(signed.children[0].id, 'mAuthTitle');
  assert.equal(signed.children[0].textContent, 'Account');
  assert.equal(signed.children[1].id, 'mAuthName');
  assert.equal(signed.children[1].textContent, 'Ada Lovelace');
  assert.equal(signed.children[2].id, 'mSignOut');
});
