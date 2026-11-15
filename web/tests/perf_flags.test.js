// Flag-off parity of the files the browser loads without server.py.
// Every behaviour switch is a query or an env var, default off.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const web = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(web, 'js/app.js'), 'utf8');
const mobile = fs.readFileSync(path.join(web, 'js/mobile.js'), 'utf8');
const theme = fs.readFileSync(path.join(web, 'css/theme.css'), 'utf8');
const phone = fs.readFileSync(path.join(web, 'css/mobile.css'), 'utf8');
const three = fs.readFileSync(path.join(web, 'vendor/three.min.js'));

test('the shipped page does not defer scripts or drop maximum-scale', () => {
  assert.match(html, /maximum-scale=1/);
  assert.doesNotMatch(html, /<script[^>]*\sdefer[\s>]/);
  assert.doesNotMatch(html, /<script[^>]*\sasync[\s>]/);
  assert.match(html, /theme\.css\?v=75/);
  assert.match(html, /mobile\.css\?v=79/);
  assert.match(html, /app\.js\?v=86/);
  assert.match(html, /mobile\.js\?v=80/);
  assert.doesNotMatch(html, /<h1[\s>]/);
  assert.doesNotMatch(html, /id="code"[^>]*aria-label/);
  assert.doesNotMatch(html, /id="palette"[^>]*aria-label/);
});

test('app.js gates lazy 3D, idle palette, batched layout, and a11y', () => {
  assert.match(app, /function perfOn\(name\)/);
  assert.match(app, /if \(perfOn\('lazy3d'\)\) return;/);
  assert.match(app, /if \(perfOn\('idlepal'\)\) \{ buildPaletteWhenIdle/);
  assert.match(app, /if \(perfOn\('batchlayout'\)\) \{ syncHeaderFitBatched\(\); return; \}/);
  assert.match(app, /if \(!perfOn\('a11y'\)\) return;/);
  assert.match(app, /Could not load the 3D view\. Retry\./);
  assert.match(app, /loadExample\('blink'\)/);
  const prefetch = app.indexOf('function schedule3dPrefetch');
  const guard = app.indexOf("if (perfOn('lazy3d')) return;", prefetch);
  const device = app.indexOf('if (no3dDevice()) return;', prefetch);
  assert.ok(prefetch > 0 && guard > prefetch && device > guard);
});

test('a11y css and the phone hub name are flag-gated', () => {
  assert.match(theme, /html\[data-a11y="1"\]\{--mut:#9aa3af\}/);
  assert.match(theme, /html\[data-theme=light\]\[data-a11y="1"\]\{--mut:#4e5966\}/);
  assert.match(phone, /html\[data-a11y="1"\] body\.m\{font-size:14px\}/);
  assert.match(mobile, /function hubLabel\(visible\)/);
  assert.match(mobile, /visible \+ ', open mode dial'/);
  assert.match(mobile, /role="status"/);
});

test('index.html has a description, no inline script, and no on* attribute', () => {
  assert.match(html, /<meta name="description" content="[^"]+"/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const match of scripts) {
    assert.match(match[1], /\bsrc=/);
    assert.equal(match[2].trim(), '');
  }
  assert.doesNotMatch(html, /\son[a-zA-Z]+\s*=/);
  assert.match(html, /js\/boot-theme\.js\?v=90/);
  assert.match(html, /js\/boot-view\.js\?v=91/);
  assert.match(html, /js\/force2d\.js\?v=92/);
  assert.match(html, /js\/jssketch\.js\?v=46/);
  assert.match(html, /js\/app\.js\?v=86/);
  assert.doesNotMatch(html, /js\/app\.js\?v=(84|85|87|88|89)/);
  assert.doesNotMatch(html, /js\/projects\.js\?v=48/);
  assert.doesNotMatch(html, /js\/schematic\.js\?v=71/);
});

test('three.min.js has no source map reference', () => {
  assert.equal(three.indexOf(Buffer.from('sourceMappingURL')), -1);
  assert.equal(fs.existsSync(path.join(web, 'vendor/three.min.js.map')), false);
});
