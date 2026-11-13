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
          pillTitle: document.getElementById('status').getAttribute('title'),
          live: document.getElementById('stLive').textContent,
          both: strip.textContent === toast.textContent && toast.textContent === document.getElementById('stLive').textContent,
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
      assert.equal(report.both, true, 'strip, toast and the live text share the sentence');
      assert.equal(report.pill, 'Queued', size.w + ' status shows Queued');
      assert.equal(report.pillTitle, MSG);
      assert.equal(report.live, MSG);
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
      const statusIdle = document.getElementById('status').getBoundingClientRect().width;
      app.setCompilePhase('queued', ${JSON.stringify(MSG)});
      const queued = read();
      app.setCompilePhase('building');
      const building = read();
      const statusBusy = document.getElementById('status').getBoundingClientRect().width;
      const main = document.getElementById('main').getBoundingClientRect().top;
      const label = btn.querySelector('span').textContent;
      app.setCompilePhase('idle');
      return { run, queued, building, label, statusIdle, statusBusy, main, mainAfter: document.getElementById('main').getBoundingClientRect().top };
    })()`);
    for (const key of ['queued', 'building']) {
      assert.ok(Math.abs(widths[key] - widths.run) < 0.5, key + ' width ' + widths[key] + ' vs Run ' + widths.run);
    }
    assert.equal(widths.label, 'Building…');
    assert.ok(Math.abs(widths.statusBusy - widths.statusIdle) < 0.5, 'status width idle ' + widths.statusIdle + ' busy ' + widths.statusBusy);
    assert.equal(widths.main, widths.mainAfter);
    const headerWidths = [821, 850, 900, 940, 1000, 1100, 1280];
    const readHeader = `(async (state) => {
      for (let i = 0; i < 30; i++) {
        if (!document.body.classList.contains('m')) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const read = (which) => {
        app.setCompilePhase(which === 'building' ? 'building' : 'idle');
        const top = document.getElementById('top');
        const nodes = [...document.querySelectorAll('header#top button, header#top select, header#top #status, header#top label.btn, header#top .conn')];
        const vis = [];
        for (const el of nodes) {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
          if (r.width < 2 || r.height < 2) continue;
          vis.push({
            id: el.id || el.getAttribute('aria-label') || el.className,
            left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            sw: el.scrollWidth, cw: el.clientWidth,
            text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          });
        }
        const st = document.getElementById('stText');
        const title = document.getElementById('projTitle');
        const crumb = title && title.closest('.crumb');
        const crumbOn = !!(crumb && getComputedStyle(crumb).display !== 'none' && title.getClientRects().length);
        let crumbOk = !crumbOn;
        if (crumbOn) {
          const probe = document.createElement('span');
          probe.textContent = '00000000';
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(title).font;
          document.body.appendChild(probe);
          crumbOk = title.clientWidth + 1 >= probe.getBoundingClientRect().width;
          probe.remove();
        }
        const menu = document.getElementById('tbMore');
        const more = document.getElementById('bMore');
        const lab = document.querySelector('#bExamples .ex-lab');
        const labCs = lab ? getComputedStyle(lab) : null;
        const labR = lab ? lab.getBoundingClientRect() : { width: 0 };
        return {
          vis,
          face: st.textContent,
          live: document.getElementById('stLive').textContent,
          titleAttr: document.getElementById('status').getAttribute('title'),
          crumbOn,
          crumbOk,
          doc: document.title,
          moreOn: !!(more && getComputedStyle(more).display !== 'none'),
          menuOpen: menu.classList.contains('open'),
          exText: (document.getElementById('bExamples').innerText || '').trim(),
          exLabel: document.getElementById('bExamples').getAttribute('aria-label'),
          exLabW: labCs && labCs.position !== 'absolute' && labCs.visibility !== 'hidden' ? labR.width : 0,
          stageH: document.getElementById('stageWrap').getBoundingClientRect().height,
          headerSw: top.scrollWidth,
          headerCw: top.clientWidth,
          gutter: innerWidth - document.documentElement.clientWidth,
        };
      };
      const one = state ? read(state) : null;
      const idle = state ? null : read('idle');
      const building = state ? null : read('building');
      const shown = idle || one;
      let menu = null;
      if (shown.moreOn && !state) {
        document.getElementById('bMore').click();
        const panel = document.getElementById('tbMore');
        const items = [...panel.querySelectorAll('button, label')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => ({
          id: el.id,
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
          label: el.getAttribute('aria-label') || '',
          right: el.getBoundingClientRect().right,
          sw: el.scrollWidth,
          cw: el.clientWidth,
        }));
        menu = { items, right: panel.getBoundingClientRect().right };
        document.getElementById('bMore').click();
      }
      return { idle, building, one, menu, vw: innerWidth, vh: innerHeight };
    })`;
    const checkBlock = (mode, w, state, block, vw, vh) => {
      assert.equal(block.face, state === 'building' ? 'Building…' : 'Idle', mode + ' ' + w + ' ' + state + ' face ' + block.face);
      if (state === 'building') {
        assert.equal(block.live, 'Building your code… the first build takes longer.');
        assert.equal(block.titleAttr, 'Building your code… the first build takes longer.');
      }
      assert.ok(block.headerSw <= block.headerCw + 1, mode + ' ' + w + ' header sw ' + block.headerSw + ' cw ' + block.headerCw);
      for (const b of block.vis) {
        assert.ok(b.left >= -1 && b.right <= vw + 1 && b.top >= -1 && b.bottom <= vh + 1, mode + ' ' + w + ' ' + state + ' ' + b.id + ' box ' + JSON.stringify(b));
        assert.ok(b.sw <= b.cw + 1, mode + ' ' + w + ' ' + state + ' ' + b.id + ' clipped sw ' + b.sw + ' cw ' + b.cw + ' text ' + b.text);
      }
      assert.ok(block.vis.some((b) => b.id === 'bRun'), mode + ' ' + w + ' ' + state + ' keeps Run');
      assert.ok(block.vis.some((b) => b.id === 'status'), mode + ' ' + w + ' ' + state + ' keeps status');
      assert.ok(!block.vis.some((b) => b.id === 'bTheme' || b.id === 'bKeys' || b.id === 'bCmdk') || w >= 1280, mode + ' ' + w + ' still shows a tool that should be in More');
      if (w < 950) {
        assert.ok(block.vis.some((b) => b.id === 'bExamples'), mode + ' ' + w + ' ' + state + ' keeps Examples');
        assert.equal(block.exLabel, 'Examples');
        assert.match(block.exText, /Examples/);
        assert.ok(block.exLabW >= 40, mode + ' ' + w + ' Examples label width ' + block.exLabW);
        assert.ok(!/^[A-Za-z]▾?$/.test(block.exText), mode + ' ' + w + ' examples is not a single letter');
      } else {
        assert.ok(block.vis.some((b) => b.id === 'selExample'), mode + ' ' + w + ' ' + state + ' keeps the examples menu');
      }
      if (block.headerCw <= 1255 + 24) assert.ok(block.moreOn, mode + ' ' + w + ' shows More');
      if (block.crumbOn) assert.equal(block.crumbOk, true, mode + ' ' + w + ' title shows at least 8 characters');
      else assert.match(block.doc, /Blink/);
    };
    const clip = {};
    for (const mode of ['overlay', 'classic']) {
      if (mode === 'classic') {
        await evalJs(`(() => {
          const s = document.createElement('style');
          s.id = 'classic-scrollbar';
          s.textContent = 'html{overflow-y:scroll}::-webkit-scrollbar{width:15px}';
          document.documentElement.appendChild(s);
          return true;
        })()`);
      }
      clip[mode] = {};
      for (const w of headerWidths) {
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: 780, deviceScaleFactor: 1, mobile: false }, sessionId);
        const edges = await evalJs(readHeader + '()');
        if (mode === 'classic') assert.ok(edges.idle.gutter >= 14, mode + ' ' + w + ' gutter ' + edges.idle.gutter);
        clip[mode][w] = {
          gutter: edges.idle.gutter,
          header: edges.idle.headerCw + '/' + edges.idle.headerSw,
          idle: edges.idle.vis.map((b) => b.id + ':' + b.text),
          building: edges.building.face,
          exLab: edges.idle.exLabW,
          menu: edges.menu && edges.menu.items.map((i) => i.id + ':' + i.text),
        };
        for (const state of ['idle', 'building']) {
          checkBlock(mode, w, state, edges[state], edges.vw, edges.vh);
        }
        if (edges.menu) {
          for (const item of edges.menu.items) {
            assert.ok(item.right <= edges.vw + 1, mode + ' ' + w + ' menu ' + item.id);
            assert.ok(item.sw <= item.cw + 1, mode + ' ' + w + ' menu clip ' + item.id);
          }
          const ids = edges.menu.items.map((i) => i.id);
          assert.ok(ids.indexOf('bCmdk') >= 0 && ids.indexOf('bKeys') >= 0 && ids.indexOf('bTheme') >= 0, mode + ' ' + w + ' menu has the overflow buttons');
          const search = edges.menu.items.find((i) => i.id === 'bCmdk');
          assert.match(search.text, /Search commands/);
        }
      }
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 780, deviceScaleFactor: 1, mobile: false }, sessionId);
      await evalJs(`(async () => {
        for (let i = 0; i < 20; i++) { if (!document.body.classList.contains('m')) break; await new Promise((r) => setTimeout(r, 30)); }
        app.setCompilePhase('building');
        return true;
      })()`);
      const mid = {};
      for (const w of [821, 900, 1100]) {
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: 780, deviceScaleFactor: 1, mobile: false }, sessionId);
        const edges = await evalJs(readHeader + '("building")');
        mid[w] = { face: edges.one.face, ids: edges.one.vis.map((b) => b.id), gutter: edges.one.gutter, header: edges.one.headerCw + '/' + edges.one.headerSw };
        assert.equal(edges.one.face, 'Building…', mode + ' resize ' + w + ' left the build');
        checkBlock(mode, w, 'building', edges.one, edges.vw, edges.vh);
      }
      clip[mode].resizeWhileBuilding = mid;
    }
    console.log('HEADER_CLIP ' + JSON.stringify(clip));
    await evalJs(`(() => { const s = document.getElementById('classic-scrollbar'); if (s) s.remove(); return true; })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 821, height: 780, deviceScaleFactor: 1, mobile: false }, sessionId);
    const tip = await evalJs(`(async () => {
      for (let i = 0; i < 20; i++) { if (!document.body.classList.contains('m')) break; await new Promise((r) => setTimeout(r, 30)); }
      const btn = document.getElementById('bExamples');
      const tip = document.getElementById('exTip');
      btn.focus();
      const focused = getComputedStyle(tip).display;
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const held = btn.classList.contains('tip-hold') && getComputedStyle(tip).display !== 'none';
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const text = tip.textContent;
      return { focused, held, text, label: btn.getAttribute('aria-label') };
    })()`);
    assert.notEqual(tip.focused, 'none', 'examples tooltip shows on focus');
    assert.equal(tip.held, true, 'examples tooltip shows on long-press');
    assert.match(tip.text, /Blink/);
    assert.equal(tip.label, 'Examples');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    const drag = await evalJs(`(async () => {
      for (let i = 0; i < 20; i++) { if (!document.body.classList.contains('m')) break; await new Promise((r) => setTimeout(r, 30)); }
      app.setCompilePhase('building');
      const stage = document.getElementById('stage');
      const on = getComputedStyle(stage).transform;
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 400, clientY: 300 }));
      app.setCompilePhase('idle');
      const held = getComputedStyle(stage).transform;
      stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 400, clientY: 300 }));
      await new Promise((r) => setTimeout(r, 40));
      const released = getComputedStyle(stage).transform;
      return { on, held, released };
    })()`);
    assert.match(drag.on, /matrix/, 'strip shifts the canvas');
    assert.equal(drag.held, drag.on, 'translate stays until pointerup');
    assert.equal(drag.released, 'none', 'translate releases after pointerup');
    const cancelDrag = await evalJs(`(async () => {
      const stage = document.getElementById('stage');
      const at = (id, type) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, clientX: 400, clientY: 300 }));
      app.setCompilePhase('building');
      const down = getComputedStyle(stage).transform;
      at(7, 'pointerdown');
      app.setCompilePhase('idle');
      const held = getComputedStyle(stage).transform;
      at(7, 'pointercancel');
      await new Promise((r) => setTimeout(r, 40));
      const cancelled = getComputedStyle(stage).transform;
      app.setCompilePhase('building');
      const again = getComputedStyle(stage).transform;
      at(8, 'pointerdown');
      app.setCompilePhase('idle');
      const held2 = getComputedStyle(stage).transform;
      at(8, 'lostpointercapture');
      await new Promise((r) => setTimeout(r, 40));
      const lost = getComputedStyle(stage).transform;
      return { down, held, cancelled, again, held2, lost };
    })()`);
    assert.match(cancelDrag.down, /matrix/, 'pointer is down on a shifted canvas');
    assert.equal(cancelDrag.held, cancelDrag.down, 'translate stays after the phase returns to idle');
    assert.equal(cancelDrag.cancelled, 'none', 'pointercancel releases the translate');
    assert.match(cancelDrag.again, /matrix/, 'a second build shifts the canvas again');
    assert.equal(cancelDrag.held2, cancelDrag.again, 'translate stays until the pointer is lost');
    assert.equal(cancelDrag.lost, 'none', 'lostpointercapture releases the translate');
    const reach = await evalJs(`(() => {
      app.setCompilePhase('building');
      const stripH = document.getElementById('compileStrip').getBoundingClientRect().height;
      const pal = document.getElementById('palList');
      const insp = document.querySelector('.insp-body');
      const palPad = parseFloat(getComputedStyle(pal).paddingBottom);
      const inspPad = parseFloat(getComputedStyle(insp).paddingBottom);
      const items = [...pal.querySelectorAll('.pitem')];
      const last = items[items.length - 1];
      pal.scrollTop = pal.scrollHeight;
      const lr = last.getBoundingClientRect();
      const pr = pal.getBoundingClientRect();
      const part = app.proj && app.proj.parts && app.proj.parts[0];
      if (part && app.editor) app.editor.select({ part: part.id });
      insp.scrollTop = insp.scrollHeight;
      const rows = [...insp.children];
      const lastRow = rows[rows.length - 1];
      const ir = lastRow ? lastRow.getBoundingClientRect() : null;
      const ib = insp.getBoundingClientRect();
      return { stripH, palPad, inspPad, lastBottom: lr.bottom, palBottom: pr.bottom, rowBottom: ir && ir.bottom, inspBottom: ib.bottom, n: items.length };
    })()`);
    assert.ok(reach.palPad >= reach.stripH - 1, 'palette padding ' + reach.palPad + ' strip ' + reach.stripH);
    assert.ok(reach.inspPad >= reach.stripH - 1, 'inspector padding ' + reach.inspPad);
    assert.ok(reach.lastBottom <= reach.palBottom + 1, 'last palette item stays in the scrollport');
    assert.ok(reach.rowBottom != null && reach.rowBottom <= reach.inspBottom + 1, 'last inspector row stays in the scrollport');
    const views = await evalJs(`(async () => {
      app.setCompilePhase('queued', ${JSON.stringify(MSG)});
      const before = app.editor.view.s;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', shiftKey: true, bubbles: true }));
      const fitted = app.editor.view.s;
      app.cmd.viewSch();
      const sch = document.body.classList.contains('viewsch');
      if (app.schematic && app.schematic.fit) app.schematic.fit();
      const schFit = !!(app.schematic && Number.isFinite(app.schematic.view ? app.schematic.view.s : app.editor.view.s));
      app.cmd.view2d();
      let three = 'skipped';
      try {
        await Promise.race([
          app.cmd.view3d(),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
        ]);
        three = document.body.classList.contains('view3d') ? 'on' : 'back-to-2d';
        if (app.view3d && app.view3d.fit) app.view3d.fit();
      } catch (e) { three = 'error'; }
      app.cmd.view2d();
      const strip = document.getElementById('compileStrip');
      return { before, fitted, finite: Number.isFinite(fitted), sch, schFit, three, phase: app.compilePhase, text: strip.textContent, hidden: strip.hidden };
    })()`);
    assert.equal(views.finite, true, 'Shift+F fit stays finite');
    assert.equal(views.sch, true, 'schematic opens with the strip up');
    assert.equal(views.schFit, true);
    assert.notEqual(views.three, 'error');
    assert.equal(views.phase, 'queued');
    assert.equal(views.hidden, false);
    assert.match(views.text, /\(position 8\)/);
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    const crossed = await evalJs(`(async () => {
      const wait = async (pred) => {
        for (let i = 0; i < 40; i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 40)); }
        return pred();
      };
      await wait(() => !document.body.classList.contains('m'));
      app.setCompilePhase('queued', ${JSON.stringify(MSG)});
      return true;
    })()`);
    assert.equal(crossed, true);
    await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 800, deviceScaleFactor: 1, mobile: true }, sessionId);
    const at820 = await evalJs(`(async () => {
      for (let i = 0; i < 40; i++) {
        const phone = document.body.classList.contains('m');
        const ticker = document.getElementById('mTicker');
        const tickerOn = ticker && getComputedStyle(ticker).display !== 'none' && ticker.getBoundingClientRect().height > 1;
        const strip = document.getElementById('compileStrip').getBoundingClientRect();
        if (phone && tickerOn && strip.top >= ticker.getBoundingClientRect().bottom - 1) return { ok: true, top: strip.top, ticker: ticker.getBoundingClientRect().bottom };
        await new Promise((r) => setTimeout(r, 40));
      }
      const ticker = document.getElementById('mTicker');
      return { ok: false, phone: document.body.classList.contains('m'), top: document.getElementById('compileStrip').getBoundingClientRect().top, ticker: ticker && ticker.getBoundingClientRect().bottom };
    })()`);
    assert.equal(at820.ok, true, '820 ' + JSON.stringify(at820));
    await send('Emulation.setDeviceMetricsOverride', { width: 821, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    const at821 = await evalJs(`(async () => {
      for (let i = 0; i < 40; i++) {
        const phone = document.body.classList.contains('m');
        const bar = document.getElementById('top').getBoundingClientRect().bottom;
        const strip = document.getElementById('compileStrip').getBoundingClientRect();
        const ticker = document.getElementById('mTicker');
        const tickerOn = ticker && getComputedStyle(ticker).display !== 'none' && ticker.getBoundingClientRect().height > 1;
        if (!phone && !tickerOn && Math.abs(strip.top - bar) < 1.5 && strip.height > 2) return { ok: true, top: strip.top, bar };
        await new Promise((r) => setTimeout(r, 40));
      }
      return { ok: false, phone: document.body.classList.contains('m'), top: document.getElementById('compileStrip').getBoundingClientRect().top };
    })()`);
    assert.equal(at821.ok, true, '821 ' + JSON.stringify(at821));
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
