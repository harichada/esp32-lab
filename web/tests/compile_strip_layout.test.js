// The top-bar pill is clipped at tablet width, so the queued sentence has its own
// surface: a fixed strip under the bar from 641px up, and the phone toast below that.
// Neither is in normal flow, so showing the sentence does not move the page.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const MSG = 'Waiting for another build to finish… (position 8)';
const WIDTHS = [
  { w: 390, h: 844, surface: 'toast' },
  { w: 768, h: 1024, surface: 'strip' },
  { w: 960, h: 800, surface: 'strip' },
  { w: 1024, h: 768, surface: 'strip' },
  { w: 1280, h: 800, surface: 'strip' },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('the full queue message, including the position, is visible at 390, 768, 960, 1024 and 1280', async () => {
  const web = path.join(__dirname, '..');
  const httpPort = await freePort();
  const dbgPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'esp32-strip-'));
  const http = spawn('python3', ['-m', 'http.server', String(httpPort), '--bind', '127.0.0.1'], { cwd: web, stdio: 'ignore' });
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + dbgPort,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', (c) => { chromeLog += c; if (chromeLog.length > 4000) chromeLog = chromeLog.slice(-4000); });
  const stop = () => { http.kill('SIGKILL'); chrome.kill('SIGKILL'); };
  try {
    const version = await waitJson('http://127.0.0.1:' + dbgPort + '/json/version');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    let seq = 0;
    const waiters = new Map();
    const send = (method, params = {}, sessionId) => {
      const id = ++seq;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout ' + method)), 20000);
        waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
      });
    };
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiters.has(m.id)) {
        const done = waiters.get(m.id);
        waiters.delete(m.id);
        done(m);
      }
    });
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    const evalJs = async (expression) => {
      const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (m.result && m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 600));
      return m.result && m.result.result && m.result.result.value;
    };
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + httpPort + '/?ex=blink' }, sessionId);
    const ready = await evalJs(`(async () => {
      for (let i = 0; i < 80; i++) {
        if (window.app && app.setCompilePhase && document.getElementById('compileStrip') && document.getElementById('mCompileToast')) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    assert.equal(ready, true, 'page ready');

    for (const size of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.w <= 820,
      }, sessionId);
      const placed = await evalJs(`(async () => {
        const wantPhone = ${size.w} <= 820;
        for (let i = 0; i < 40; i++) {
          if (document.body.classList.contains('m') === wantPhone) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return document.body.classList.contains('m');
      })()`);
      assert.equal(placed, true, 'layout settled at ' + size.w);
      const before = await evalJs(`(() => {
        const main = document.getElementById('main').getBoundingClientRect();
        const top = document.getElementById('top').getBoundingClientRect();
        return { mainTop: main.top, mainH: main.height, topH: top.height };
      })()`);
      const report = await evalJs(`(() => {
        const msg = ${JSON.stringify(MSG)};
        app.setCompilePhase('queued', msg);
        const strip = document.getElementById('compileStrip');
        const toast = document.getElementById('mCompileToast');
        const pill = document.getElementById('stText');
        const shown = (el) => {
          if (!el || el.hidden) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 2 && r.height > 2;
        };
        const el = shown(strip) ? strip : shown(toast) ? toast : null;
        if (!el) return { ok: false, why: 'no surface', strip: strip.hidden, toast: toast.hidden, phone: document.body.classList.contains('m') };
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()];
        const slop = 1.5;
        const clipped = rects.some((rc) => rc.right > box.right + slop || rc.bottom > box.bottom + slop || rc.left < box.left - slop || rc.top < box.top - slop);
        const offscreen = rects.some((rc) => rc.left < -slop || rc.top < -slop || rc.right > innerWidth + slop || rc.bottom > innerHeight + slop);
        const main = document.getElementById('main').getBoundingClientRect();
        const top = document.getElementById('top').getBoundingClientRect();
        return {
          ok: true,
          which: el.id,
          text: el.textContent,
          pill: pill.textContent,
          both: strip.textContent === toast.textContent && toast.textContent === pill.textContent,
          whiteSpace: s.whiteSpace,
          overflow: s.overflow,
          textOverflow: s.textOverflow,
          position: s.position,
          clipped, offscreen,
          rects: rects.length,
          boxW: box.width,
          mainTop: main.top, mainH: main.height, topH: top.height,
        };
      })()`);
      assert.equal(report.ok, true, size.w + ' ' + JSON.stringify(report));
      assert.equal(report.which, size.surface === 'toast' ? 'mCompileToast' : 'compileStrip', size.w + ' surface');
      assert.equal(report.text, MSG);
      assert.match(report.text, /\(position 8\)/);
      assert.equal(report.both, true, 'pill, strip and toast share the sentence');
      assert.equal(report.whiteSpace, 'normal');
      assert.notEqual(report.overflow, 'hidden');
      assert.notEqual(report.textOverflow, 'ellipsis');
      assert.equal(report.position, 'fixed');
      assert.equal(report.clipped, false, size.w + ' clips the position');
      assert.equal(report.offscreen, false, size.w + ' paints the position outside the viewport');
      assert.ok(report.rects >= 1);
      assert.equal(report.mainTop, before.mainTop, 'canvas did not move');
      assert.equal(report.mainH, before.mainH, 'canvas height did not change');
      assert.equal(report.topH, before.topH, 'top bar height did not change');
      if (size.surface === 'strip') assert.ok(report.boxW > size.w * 0.9, 'strip is full width at ' + size.w);
    }
    ws.close();
  } catch (err) {
    err.message += '\nchrome: ' + chromeLog.slice(-500);
    throw err;
  } finally {
    stop();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function waitJson(url) {
  let last = '';
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = String(r.status);
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('chrome not ready: ' + last);
}
