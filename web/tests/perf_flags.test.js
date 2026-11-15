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

test('the shipped page defers every script and allows zoom', () => {
  assert.doesNotMatch(html, /maximum-scale\s*=/);
  assert.doesNotMatch(html, /user-scalable\s*=/);
  assert.match(html, /<h1 class="sr-only">ESP32 Circuit Lab<\/h1>/);
  assert.match(html, /id="code"[^>]*aria-label="Sketch code"/);
  assert.match(html, /id="palette"[^>]*aria-label="Parts"/);
  assert.match(html, /id="palList"[^>]*tabindex="0"/);
  assert.match(html, /id="palList"[^>]*role="region"/);
  assert.doesNotMatch(html, /css\/app\.css/);
  assert.match(html, /css\/theme\.css\?v=102/);
  assert.doesNotMatch(html, /css\/mobile\.css/);
  const load = fs.readFileSync(path.join(web, 'js/load.js'), 'utf8');
  assert.match(html, /js\/load\.js\?v=101" defer/);
  assert.match(load, /js\/app\.js\?v=86/);
  assert.match(load, /js\/mobile\.js\?v=98/);
  assert.match(load, /s\.async = false/);
  assert.match(html, /<link rel="stylesheet" href="css\/theme\.css\?v=102">/);
  assert.match(load, /css\/app\.css\?v=97/);
  assert.match(load, /css\/theme-late\.css\?v=103/);
  assert.match(load, /css\/mobile\.css\?v=96/);
  assert.doesNotMatch(html, /<script[^>]*\sasync[\s>]/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert.ok(scripts.length > 0);
  for (const match of scripts) assert.match(match[1], /\sdefer(?:\s|>|$)/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  const crit = fs.readFileSync(path.join(web, 'css/critical.css'), 'utf8').trim();
  assert.equal(style[1].trim(), crit);
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
  const listed = fs.readFileSync(path.join(web, 'js/load.js'), 'utf8');
  assert.match(listed, /js\/boot-theme\.js\?v=90/);
  assert.match(listed, /js\/parts-art\.js\?v=100/);
  assert.match(listed, /js\/boot-view\.js\?v=91/);
  assert.match(listed, /js\/force2d\.js\?v=92/);
  assert.match(listed, /js\/jssketch\.js\?v=46/);
  assert.match(listed, /js\/app\.js\?v=86/);
  assert.doesNotMatch(listed, /js\/app\.js\?v=(84|85|87|88|89)/);
  assert.doesNotMatch(listed, /js\/projects\.js\?v=48/);
  assert.doesNotMatch(listed, /js\/schematic\.js\?v=71/);
});

test('three.min.js has no source map reference', () => {
  assert.equal(three.indexOf(Buffer.from('sourceMappingURL')), -1);
  assert.equal(fs.existsSync(path.join(web, 'vendor/three.min.js.map')), false);
});
