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
  { w: 641, h: 900, surface: 'strip' },
  { w: 700, h: 900, surface: 'strip' },
  { w: 768, h: 1024, surface: 'strip' },
  { w: 820, h: 900, surface: 'strip' },
  { w: 821, h: 900, surface: 'strip' },
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

test('the queue line clears the ticker, keeps Make a copy clickable, and stays fully visible', async () => {
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
        if (window.app && app.setCompilePhase && document.getElementById('compileStrip') && document.getElementById('mCompileToast') && document.getElementById('bCopy')) return true;
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
        const ticker = document.getElementById('mTicker');
        const tickerBox = ticker && getComputedStyle(ticker).display !== 'none' ? ticker.getBoundingClientRect() : null;
        const tickerOn = !!(tickerBox && tickerBox.height > 1);
        const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        const chromeBottom = Math.max(top.bottom, tickerOn ? tickerBox.bottom : 0);
        const setTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--strip-top')) || 0;
        const copy = document.getElementById('bCopy');
        const copyBox = copy ? copy.getBoundingClientRect() : null;
        const banner = document.getElementById('projBanner');
        const bannerCs = banner ? getComputedStyle(banner) : null;
        let hit = null;
        if (copyBox && copyBox.width > 2) {
          const node = document.elementFromPoint(copyBox.left + copyBox.width / 2, copyBox.top + copyBox.height / 2);
          hit = node && (node === copy || copy.contains(node));
        }
        const covered = [];
        if (el.id === 'compileStrip') {
          for (const node of document.querySelectorAll('button, a, input, select, textarea')) {
            if (node.closest('#compileStrip, #top')) continue;
            const cs = getComputedStyle(node);
            const r = node.getBoundingClientRect();
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
            if (r.width < 2 || r.height < 2) continue;
            if (overlap(r, box)) covered.push(node.id || node.getAttribute('aria-label') || node.tagName);
          }
        }
        let toastH = null;
        if (el.id === 'mCompileToast') {
          const ign = document.getElementById('mIgnite').getBoundingClientRect().top;
          app.setCompilePhase('queued', 'Queued.');
          const shortH = toast.getBoundingClientRect().height;
          const ignShort = document.getElementById('mIgnite').getBoundingClientRect().top;
          app.setCompilePhase('queued', msg);
          toastH = { shortH, longH: toast.getBoundingClientRect().height, ign, ignShort, ignLong: document.getElementById('mIgnite').getBoundingClientRect().top };
        }
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
          pointerEvents: s.pointerEvents,
          clipped, offscreen,
          rects: rects.length,
          boxW: box.width,
          boxTop: box.top,
          boxBottom: box.bottom,
          mainTop: main.top, mainH: main.height, topH: top.height,
          tickerOn, tickerBottom: tickerOn ? tickerBox.bottom : 0,
          chromeBottom, setTop,
          copyTop: copyBox ? copyBox.top : null,
          copyBottom: copyBox ? copyBox.bottom : null,
          copyHit: hit,
          bannerTransform: bannerCs ? bannerCs.transform : '',
          bannerTop: bannerCs ? bannerCs.top : '',
          bannerMargin: bannerCs ? bannerCs.marginTop : '',
          covered,
          toastH,
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
      if (size.surface === 'strip') {
        assert.ok(report.boxW > size.w * 0.9, 'strip is full width at ' + size.w);
        assert.ok(Math.abs(report.boxTop - report.chromeBottom) < 1.5, size.w + ' strip top ' + report.boxTop + ' chrome ' + report.chromeBottom);
        assert.ok(Math.abs(report.setTop - report.chromeBottom) < 1.5, size.w + ' --strip-top ' + report.setTop);
        if (size.w <= 820) {
          assert.equal(report.tickerOn, true, size.w + ' ticker is showing');
          assert.ok(report.boxTop >= report.tickerBottom - 1, size.w + ' strip is under the ticker');
        } else {
          assert.equal(report.tickerOn, false, size.w + ' ticker is hidden');
        }
        assert.ok(report.copyTop != null, 'Make a copy is on screen');
        assert.ok(report.copyTop >= report.boxBottom - 1, size.w + ' Make a copy starts below the strip');
        assert.ok(report.copyBottom <= size.h + 1, 'Make a copy stays in the viewport');
        assert.equal(report.copyHit, true, size.w + ' Make a copy is the click target');
        assert.deepEqual(report.covered, [], size.w + ' strip covers ' + report.covered.join(','));
        assert.match(report.bannerTransform, /matrix/, 'banner uses a transform');
        assert.equal(report.bannerMargin, '0px');
        assert.equal(report.pointerEvents, 'none');
      }
      if (report.toastH) {
        assert.equal(report.toastH.shortH, report.toastH.longH, 'toast height stays at two lines');
        assert.equal(report.toastH.ign, report.toastH.ignShort);
        assert.equal(report.toastH.ignShort, report.toastH.ignLong);
      }
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    const widths = await evalJs(`(async () => {
      for (let i = 0; i < 30; i++) {
        if (!document.body.classList.contains('m') && document.getElementById('bRun').getBoundingClientRect().width > 20) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      const btn = document.getElementById('bRun');
      const read = () => btn.getBoundingClientRect().width;
      app.setCompilePhase('idle');
      const run = read();
      app.setCompilePhase('queued', ${JSON.stringify(MSG)});
      const queued = read();
      app.setCompilePhase('building');
      const building = read();
      btn.querySelector('span').textContent = 'Compiling…';
      const compiling = read();
      const main = document.getElementById('main').getBoundingClientRect().top;
      app.setCompilePhase('idle');
      return { run, queued, building, compiling, main, mainAfter: document.getElementById('main').getBoundingClientRect().top };
    })()`);
    for (const key of ['queued', 'building', 'compiling']) {
      assert.ok(Math.abs(widths[key] - widths.run) < 0.5, key + ' width ' + widths[key] + ' vs Run ' + widths.run);
    }
    assert.equal(widths.main, widths.mainAfter);
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
