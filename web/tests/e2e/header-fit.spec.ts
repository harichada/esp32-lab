// Permanent header-fit spec. Serves web/ from the config's webServer and
// never calls githack or the live site: /api/* and the run WebSocket are mocked.
//
// Zoom:
// - 100%: the matrix width and height are the CSS viewport. deviceScaleFactor is 1.
// - 125%: equivalent viewport scaling, not CSS zoom. A W×H window at 125% lays
//   out in round(W/1.25) × round(H/1.25) CSS pixels, and deviceScaleFactor is
//   1.25 so device pixels match that window. CSS zoom on the root is not used:
//   Chrome multiplies getBoundingClientRect by zoom and leaves
//   documentElement.clientWidth alone, so pastClient would fail a header that fits.
// - dsf 1.5: the same CSS viewports again (and the 125% viewports again) with
//   deviceScaleFactor 1.5. That is Lab Consumer's Linux Chrome, which captured
//   a 1280×800 window as 1920×1200.
//
// Scrollbars: overlay (headless Chrome, gutter 0), classic 15px, and classic 17px.
// Classic is a headed Chrome with --disable-features=OverlayScrollbar, plus
// html{overflow-y:scroll} and ::-webkit-scrollbar{width}. The reserved gutter
// is not always the requested width, so the spec tries that width and the
// neighbouring pixel until documentElement.clientWidth is exactly 15px or 17px
// under innerWidth.
// pastClient uses documentElement.clientWidth, not innerWidth.
//
// The pill shows a short word that has to read in full: Idle, Building…, Queued.
// When the bar runs out of room the word shortens (Build, Wait, Run) and then
// becomes the status dot, whose accessible name is still that word. The
// building sentence and the longest queued sentence are the phase detail.
// They must match #stLive and the status title. The queued sentence is the
// longest one the page can show for a queued compile.
//
// The project title is never hidden. It may ellipsize, stays at least 12ch
// wide (or the full name, when that is shorter), and its aria-label and title
// are the full name. Its own ellipsis is not a clip. An ancestor that cuts it
// off still fails the case.
import { chromium, test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BUILDING = 'Building your code… the first build takes longer.';
const QUEUED = 'Preparing network stack (first run after restart), about 40 s…';
const LONG_TITLE = 'Blink (real firmware) (copy 17)';
const DEFAULT_TITLE = 'Blink (real firmware)';

const WIDTHS = [821, 850, 900, 940, 1280];
const HEIGHTS = [780, 900];
const STATES = ['idle', 'building', 'queued'] as const;
const BARS = [
  { id: 'overlay', px: 0 },
  { id: 'classic15', px: 15 },
  { id: 'classic17', px: 17 },
] as const;
// zoom 1 keeps the matrix size. zoom 1.25 shrinks the CSS viewport.
// dsf 1.5 is applied to both zooms.
const SCALES = [
  { id: 'z100', zoom: 1, dsf: 1 },
  { id: 'z125', zoom: 1.25, dsf: 1.25 },
  { id: 'z100-dsf15', zoom: 1, dsf: 1.5 },
  { id: 'z125-dsf15', zoom: 1.25, dsf: 1.5 },
] as const;

type State = (typeof STATES)[number];
type Scale = (typeof SCALES)[number];

const shots = path.resolve(__dirname, '../../../test-results');

function pill(state: State) {
  if (state === 'building') return 'Building…';
  if (state === 'queued') return 'Queued';
  return 'Idle';
}
function shortStatus(word: string) {
  if (word === 'Building…') return 'Build';
  if (word === 'Queued') return 'Wait';
  if (word === 'Running') return 'Run';
  return word;
}
function sentence(state: State) {
  if (state === 'building') return BUILDING;
  if (state === 'queued') return QUEUED;
  return 'Idle';
}
function layoutOf(width: number, height: number, zoom: number) {
  if (zoom === 1) return { width, height };
  return { width: Math.round(width / zoom), height: Math.round(height / zoom) };
}

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/health')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (url.includes('/api/compile/progress')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\//, (ws) => {
    ws.onMessage(() => {});
  });
  await page.addInitScript(() => {
    function measureHeader() {
      const client = document.documentElement.clientWidth;
      const nodes = [
        ...document.querySelectorAll('header#top button, header#top select, header#top a, header#top label.btn'),
        document.querySelector('#status'),
        document.querySelector('#stText'),
        document.querySelector('#projTitle'),
        document.querySelector('header#top .crumb'),
        document.querySelector('#connDot'),
      ];
      const seen = new Set();
      const bad = [];
      for (const el of nodes) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        if (rect.width < 1 || rect.height < 1) continue;
        const pastClient = rect.left < -0.5 || rect.right > client + 0.5;
        let clippedByAncestor = false;
        let clipOf = '';
        for (let a = el.parentElement; a; a = a.parentElement) {
          const acs = getComputedStyle(a);
          const ox = acs.overflowX;
          if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') {
            const ar = a.getBoundingClientRect();
            const edge = ar.left + a.clientWidth + (parseFloat(acs.borderRightWidth) || 0);
            if (rect.right > edge + 0.5) {
              clippedByAncestor = true;
              clipOf = (a.id || a.tagName) + ' edge ' + edge.toFixed(1);
              break;
            }
          }
        }
        const overflowHidden = cs.overflowX === 'hidden' || cs.overflow === 'hidden';
        const ellipsis = cs.textOverflow === 'ellipsis' && overflowHidden;
        // The project title is allowed to ellipsize. Every other control is not.
        const truncated = el.id === 'projTitle' ? false : (el.scrollWidth > el.clientWidth + 0.5 || ellipsis);
        if (pastClient || clippedByAncestor || truncated) {
          bad.push({
            name: el.id || el.getAttribute('aria-label') || el.className || el.tagName,
            pastClient,
            clippedByAncestor,
            clipOf,
            truncated,
            ellipsis,
            left: +rect.left.toFixed(1),
            right: +rect.right.toFixed(1),
            sw: el.scrollWidth,
            cw: el.clientWidth,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          });
        }
      }
      const st = document.getElementById('stText');
      const live = document.getElementById('stLive');
      const status = document.getElementById('status');
      return {
        client,
        inner: window.innerWidth,
        stText: st ? st.textContent : '',
        live: live ? live.textContent : '',
        title: status ? status.getAttribute('title') || '' : '',
        bad,
      };
    }
    window.measureHeader = measureHeader;
  });
}

async function ready(page: Page) {
  await page.goto('/?ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await expect(page.locator('#projTitle')).toHaveText(DEFAULT_TITLE);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { setCompilePhase?: unknown } }).app?.setCompilePhase)).toBe(true);
}

async function scrollbar(page: Page, px: number) {
  if (!px) {
    await page.evaluate(() => {
      const prev = document.getElementById('classic-scrollbar');
      if (prev) prev.remove();
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)).toBe(0);
    return;
  }
  const got = await page.evaluate((target) => {
    let style = document.getElementById('classic-scrollbar') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'classic-scrollbar';
      document.documentElement.appendChild(style);
    }
    for (const width of [target, target + 1, target - 1, target + 2]) {
      style.textContent = 'html{overflow-y:scroll}::-webkit-scrollbar{width:' + width + 'px}';
      const gutter = window.innerWidth - document.documentElement.clientWidth;
      if (gutter === target) return gutter;
    }
    return window.innerWidth - document.documentElement.clientWidth;
  }, px);
  expect(got, 'classic scrollbar gutter').toBe(px);
}

async function viewport(page: Page, width: number, height: number, zoom: number) {
  const box = layoutOf(width, height, zoom);
  await page.setViewportSize(box);
  const phone = box.width <= 820;
  await expect.poll(() => page.evaluate((want) => document.body.classList.contains('m') === want, phone)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBeGreaterThan(0);
}

async function applyState(page: Page, state: State, title: string) {
  await page.evaluate(({ state, sentence, title }) => {
    const app = (window as unknown as { app: { proj?: { name: string }; setCompilePhase: (p: string, d?: string) => void; syncHeaderFit?: () => void } }).app;
    const titleEl = document.getElementById('projTitle');
    if (titleEl) titleEl.textContent = title;
    if (app.proj) app.proj.name = title;
    if (state === 'queued') app.setCompilePhase('queued', sentence);
    else app.setCompilePhase(state);
    if (app.syncHeaderFit) app.syncHeaderFit();
  }, { state, sentence: sentence(state), title });
  const word = pill(state);
  await expect.poll(async () => {
    const shown = await page.locator('#stText').textContent();
    return shown === word || shown === shortStatus(word);
  }).toBe(true);
  await expect(page.locator('#stLive')).toHaveText(sentence(state));
  await expect(page.locator('#status')).toHaveAttribute('title', sentence(state));
}

type Report = {
  client: number;
  inner: number;
  stText: string;
  live: string;
  title: string;
  bad: Array<Record<string, unknown>>;
  titleFit: { hidden: boolean; wide: boolean; named: boolean; width: number; need: number; aria: string; titleAttr: string };
  pillLabel: string;
  statusLabel: string;
};

async function check(page: Page, id: string, state: State, name: string, failures: string[]) {
  const report = await page.evaluate((name) => {
    const base = (window as unknown as { measureHeader: () => Report }).measureHeader();
    const el = document.getElementById('projTitle');
    const st = document.getElementById('status');
    const pillEl = document.getElementById('stText');
    const fit = { hidden: true, wide: false, named: false, width: 0, need: 0, aria: '', titleAttr: '' };
    if (el) {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      fit.hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || rect.width < 1 || rect.height < 1;
      fit.aria = el.getAttribute('aria-label') || '';
      fit.titleAttr = el.getAttribute('title') || '';
      fit.named = fit.aria === name && fit.titleAttr === name;
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap';
      probe.style.font = cs.font;
      probe.style.letterSpacing = 'normal';
      probe.style.textTransform = 'none';
      probe.textContent = '000000000000';
      document.body.appendChild(probe);
      const ch12 = probe.getBoundingClientRect().width;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.style.textTransform = cs.textTransform;
      probe.textContent = name;
      const full = probe.getBoundingClientRect().width;
      probe.remove();
      fit.need = Math.min(ch12, full);
      fit.width = rect.width;
      fit.wide = rect.width + 1 >= fit.need;
    }
    return Object.assign(base, {
      titleFit: fit,
      pillLabel: pillEl ? pillEl.getAttribute('aria-label') || '' : '',
      statusLabel: st ? st.getAttribute('aria-label') || '' : '',
    });
  }, name);
  const reasons: string[] = [];
  const word = pill(state);
  const mid = shortStatus(word);
  if (report.stText !== word && report.stText !== mid) reasons.push('stText ' + JSON.stringify(report.stText) + ' != ' + JSON.stringify(word));
  if (report.stText !== word && report.pillLabel !== word && report.statusLabel !== word) reasons.push('status name ' + JSON.stringify(report.pillLabel) + ' ' + JSON.stringify(report.statusLabel));
  if (report.live !== sentence(state)) reasons.push('live ' + JSON.stringify(report.live));
  if (report.title !== sentence(state)) reasons.push('title ' + JSON.stringify(report.title));
  if (report.titleFit.hidden) reasons.push('project title hidden');
  if (!report.titleFit.wide) reasons.push('project title width ' + report.titleFit.width + ' needs ' + report.titleFit.need);
  if (!report.titleFit.named) reasons.push('project title aria ' + JSON.stringify(report.titleFit.aria) + ' title ' + JSON.stringify(report.titleFit.titleAttr));
  for (const item of report.bad) {
    const flags = [
      item.pastClient ? 'pastClient' : '',
      item.clippedByAncestor ? 'clippedByAncestor' : '',
      item.truncated ? 'truncated' : '',
    ].filter(Boolean).join('+');
    reasons.push(flags + ' ' + item.name + ' ' + JSON.stringify(item));
  }
  if (!reasons.length) return true;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, id + '.png') });
  failures.push(id + ' client ' + report.client + ' inner ' + report.inner + '\n  ' + reasons.join('\n  '));
  return false;
}

async function checkExamples(page: Page, id: string, failures: string[]) {
  const reasons: string[] = [];
  const btn = page.getByRole('button', { name: /Examples/ });
  try {
    await page.keyboard.press('Escape');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAccessibleName(/Examples/);
    const box = await btn.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const client = document.documentElement.clientWidth;
      const past = rect.left < -0.5 || rect.right > client + 0.5 || rect.top < -0.5 || rect.bottom > window.innerHeight + 0.5;
      let clipped = false;
      let clipOf = '';
      for (let a = el.parentElement; a; a = a.parentElement) {
        const acs = getComputedStyle(a);
        const ox = acs.overflowX;
        const oy = acs.overflowY;
        const clips = (v: string) => v === 'hidden' || v === 'auto' || v === 'scroll' || v === 'clip';
        if (clips(ox) || clips(oy)) {
          const ar = a.getBoundingClientRect();
          const edgeR = ar.left + a.clientWidth + (parseFloat(acs.borderRightWidth) || 0);
          const edgeB = ar.top + a.clientHeight + (parseFloat(acs.borderBottomWidth) || 0);
          if (rect.right > edgeR + 0.5 || rect.left < ar.left - 0.5 || rect.bottom > edgeB + 0.5 || rect.top < ar.top - 0.5) {
            clipped = true;
            clipOf = a.id || a.tagName;
            break;
          }
        }
      }
      return { past, clipped, clipOf, label: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '' };
    });
    if (box.past) reasons.push('Examples past the viewport');
    if (box.clipped) reasons.push('Examples clipped by ' + box.clipOf);
    if (!/Examples/.test(box.label)) reasons.push('Examples aria-label ' + JSON.stringify(box.label));
    if (!box.title) reasons.push('Examples has no title');
    const list = page.getByRole('listbox', { name: 'Examples' });
    await btn.click();
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
  } catch (err) {
    reasons.push(err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
  if (!reasons.length) return true;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, id + '.png') });
  failures.push(id + '\n  ' + reasons.join('\n  '));
  return false;
}

test('header controls stay inside the client width', async () => {
  fs.mkdirSync(shots, { recursive: true });
  const failures: string[] = [];
  let passed = 0;
  const overlayBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  const classicBrowser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-features=OverlayScrollbar'],
  });
  const contexts: Array<{ scale: Scale; classic: boolean; page: Page; close: () => Promise<void> }> = [];
  try {
    for (const scale of SCALES) {
      for (const classic of [false, true]) {
        const context = await (classic ? classicBrowser : overlayBrowser).newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: scale.dsf,
        });
        const page = await context.newPage();
        await install(page);
        await ready(page);
        contexts.push({ scale, classic, page, close: () => context.close() });
      }
    }

    for (const scale of SCALES) {
      for (const bar of BARS) {
        const page = contexts.find((c) => c.scale === scale && c.classic === (bar.px > 0))!.page;
        await scrollbar(page, bar.px);
        for (const height of HEIGHTS) {
          for (const width of WIDTHS) {
            await viewport(page, width, height, scale.zoom);
            for (const state of STATES) {
              const id = [scale.id, bar.id, width + 'x' + height, state, 'title-default'].join('-');
              await applyState(page, state, DEFAULT_TITLE);
              if (await check(page, id, state, DEFAULT_TITLE, failures)) passed += 1;
            }
            const idleId = [scale.id, bar.id, width + 'x' + height, 'idle', 'title-long'].join('-');
            await applyState(page, 'idle', LONG_TITLE);
            if (await check(page, idleId, 'idle', LONG_TITLE, failures)) passed += 1;
            if (width === 940 || width === 1280) {
              const buildId = [scale.id, bar.id, width + 'x' + height, 'building', 'title-long'].join('-');
              await applyState(page, 'building', LONG_TITLE);
              if (await check(page, buildId, 'building', LONG_TITLE, failures)) passed += 1;
            }
            if (scale.zoom === 1 && (width === 821 || width === 940)) {
              for (const exState of ['idle', 'building'] as const) {
                const exId = [scale.id, bar.id, width + 'x' + height, exState, 'examples-long'].join('-');
                await applyState(page, exState, LONG_TITLE);
                const fitOk = await check(page, exId, exState, LONG_TITLE, failures);
                const openOk = await checkExamples(page, exId, failures);
                if (fitOk && openOk) passed += 1;
              }
            }
          }
          const resizeId = [scale.id, bar.id, 'h' + height, 'resize-building'].join('-');
          let resizeOk = true;
          for (const width of [1280, 821, 940]) {
            await viewport(page, width, height, scale.zoom);
            await applyState(page, 'building', DEFAULT_TITLE);
            const step = resizeId + '-' + width;
            if (!(await check(page, step, 'building', DEFAULT_TITLE, failures))) resizeOk = false;
          }
          if (resizeOk) passed += 1;
        }
      }
    }
  } finally {
    for (const c of contexts) await c.close();
    await overlayBrowser.close();
    await classicBrowser.close();
  }
  const summary = { passed, failed: failures.length, failures };
  fs.writeFileSync(path.join(shots, 'header-fit-summary.json'), JSON.stringify(summary, null, 2));
  console.log('HEADER_FIT passed ' + passed + ' failed ' + failures.length);
  expect(failures, failures.join('\n\n')).toEqual([]);
});
