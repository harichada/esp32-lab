// Like-breadboard schematic. Static files only: /api and the run socket are mocked.
// Blink, the Wi-Fi/IR remote, and Simon (a crowded board) at 390 and 1280.
import { test, expect, type Page } from '@playwright/test';

const EXAMPLES = [
  { id: 'blink', part: 'R1' },
  { id: 'remote', part: 'R1' },
  { id: 'simon', part: '' },
] as const;

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\//, (ws) => {
    ws.onMessage(() => {});
  });
}

async function openExample(page: Page, id: string, width: number) {
  await page.setViewportSize({ width: width, height: width === 390 ? 844 : 800 });
  await page.goto('/?ex=' + id + '&resume=0');
  await page.waitForFunction((key) => {
    const app = (window as unknown as { app?: { proj?: { example?: string; parts?: unknown[] }; schematic?: unknown } }).app;
    return !!(app && app.proj && app.proj.example === key && app.proj.parts && app.proj.parts.length && app.schematic);
  }, id);
  await page.locator('#bViewSch').click();
  await expect(page.locator('.toast')).not.toHaveCount(0);
  await page.waitForFunction(() => document.body.classList.contains('viewsch') && !!document.querySelector('#stageSch.on .sch-hit'));
  await expect.poll(async () => page.evaluate(() => {
    const hit = document.querySelector('#stageSch .sch-hit');
    return hit ? hit.getBoundingClientRect().width : 0;
  })).toBeGreaterThan(8);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
  }));
  await chromeClear(page, id + '@' + width + ' while the toast is up');
}

type Box = { x: number; y: number; x2: number; y2: number; id: string; text: string };

async function drawing(page: Page) {
  return page.evaluate(() => {
    const model = (window as unknown as {
      app: { schematic: { model: {
        bounds: { x: number; y: number; w: number; h: number };
        symbols: { id: string; x: number; y: number; w: number; h: number }[];
        texts: { x: number; y: number; x2: number; y2: number; own: string | null; text: string; kind?: string; size?: number }[];
      } } };
    }).app.schematic.model;
    const bodies: Box[] = model.symbols.map((s) => ({ x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h, id: s.id, text: '' }));
    const labels: Box[] = (model.texts || []).map((t) => ({ x: t.x, y: t.y, x2: t.x2, y2: t.y2, id: t.own || '', text: t.text }));
    const screenBodies: Box[] = [];
    document.querySelectorAll('#stageSch .sch-hit').forEach((el) => {
      const r = el.getBoundingClientRect();
      const host = el.closest('.sch-sym');
      screenBodies.push({ x: r.left, y: r.top, x2: r.right, y2: r.bottom, id: (host && (host as HTMLElement).dataset.pid) || '', text: '' });
    });
    const toggle = document.getElementById('schLayout');
    const t = toggle ? toggle.getBoundingClientRect() : null;
    const buttons = [...document.querySelectorAll('#schLayout button')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        name: (el.textContent || '').trim(),
        w: r.width,
        h: r.height,
        pressed: el.getAttribute('aria-pressed'),
        disabled: (el as HTMLButtonElement).disabled,
      };
    });
    const svg = document.getElementById('stageSch') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const box = svg.getBoundingClientRect();
    const zoom = vb.width > 0 ? box.width / vb.width : 0;
    let css = 1;
    const scale = (svg as SVGSVGElement & { currentScale?: number }).currentScale;
    if (scale && isFinite(scale) && scale > 0) css *= scale;
    const tr = getComputedStyle(svg).transform;
    const matrix = tr && tr.match(/matrix\(([^)]+)\)/);
    if (matrix) {
      const p = matrix[1].split(',').map((n) => Number(n));
      const sx = Math.hypot(p[0] || 0, p[1] || 0);
      if (sx > 0 && isFinite(sx)) css *= sx;
    }
    const partTexts = (model.texts || []).filter((text) => text.kind === 'ref' || text.kind === 'val' || text.kind === 'title');
    const font = partTexts.reduce((m, text) => Math.min(m, text.size || 11), Infinity);
    const b = model.bounds;
    const covers = vb.x <= b.x + 8 && vb.y <= b.y + 8 && vb.x + vb.width >= b.x + b.w - 8 && vb.y + vb.height >= b.y + b.h - 8;
    const fitAll = document.getElementById('schFitAll');
    const esp = (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.find((p) => p.type === 'esp32');
    const espEl = esp ? svg.querySelector('.sch-sym[data-pid="' + esp.id + '"] .sch-hit') : null;
    const er = espEl ? espEl.getBoundingClientRect() : null;
    const tools = document.querySelector('.canvas-tools');
    const trTools = tools ? tools.getBoundingClientRect() : null;
    const cx = er ? (er.left + er.right) / 2 : 0;
    const cy = er ? (er.top + er.bottom) / 2 : 0;
    const espInView = !!er && er.width > 4 && er.height > 4 && cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
      && !(trTools && cx >= trTools.left && cx <= trTools.right && cy >= trTools.top && cy <= trTools.bottom);
    const edge = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    let top = 0;
    let bottom = window.innerHeight;
    for (const sel of ['header#top', '.projbanner']) {
      const r = edge(sel);
      if (r && r.bottom > top && r.top < window.innerHeight * 0.5) top = Math.max(top, r.bottom);
    }
    for (const sel of ['.canvas-tools', '.hint']) {
      const r = edge(sel);
      if (r && r.top < bottom && r.bottom > window.innerHeight * 0.4) bottom = Math.min(bottom, r.top);
    }
    const open = { left: 0, top, right: window.innerWidth, bottom };
    const wired = new Set((window as unknown as { Schematic: { openFrame: (m: unknown) => { ids: string[] } } }).Schematic.openFrame(model).ids);
    const outside: string[] = [];
    for (const body of screenBodies) {
      if (!wired.has(body.id)) continue;
      if (body.x < open.left - 1 || body.y < open.top - 1 || body.x2 > open.right + 1 || body.y2 > open.bottom + 1) outside.push(body.id);
    }
    return {
      bodies: bodies,
      labels: labels,
      screenBodies: screenBodies,
      toggle: t ? { x: t.left, y: t.top, x2: t.right, y2: t.bottom, w: t.width, h: t.height } : null,
      buttons: buttons,
      screenPx: (isFinite(font) ? font : 11) * zoom * css,
      zoomPct: zoom * 100,
      wiredOutside: outside,
      openTop: open.top,
      openBottom: open.bottom,
      covers: covers,
      fitAll: !!(fitAll && !fitAll.hidden),
      espInView: espInView,
      hidden: !!(toggle && toggle.hidden),
      innerH: window.innerHeight,
    };
  });
}

async function chromeClear(page: Page, where: string) {
  const boxes = await page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.left, y: r.top, x2: r.right, y2: r.bottom, id: '', text: '' };
    };
    return {
      toggle: rect(document.getElementById('schLayout')),
      hint: rect(document.querySelector('#stageWrap .hint')),
      toasts: [...document.querySelectorAll('.toast')].map((el) => rect(el)).filter((r): r is Box => !!r),
      symbols: [...document.querySelectorAll('#stageSch .sch-hit')].map((el) => rect(el)).filter((r): r is Box => !!r),
    };
  });
  expect(boxes.toggle, where + ' toggle').toBeTruthy();
  if (!boxes.toggle) return;
  if (boxes.hint) expect(overlaps(boxes.toggle, boxes.hint), where + ' hint ' + JSON.stringify(boxes.hint)).toBe(false);
  for (const toast of boxes.toasts) expect(overlaps(boxes.toggle, toast), where + ' toast ' + JSON.stringify(toast)).toBe(false);
  for (const symbol of boxes.symbols) expect(overlaps(boxes.toggle, symbol), where + ' symbol ' + JSON.stringify(symbol)).toBe(false);
}

function overlaps(a: Box, b: Box) {
  return Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 1;
}

function assertClear(report: Awaited<ReturnType<typeof drawing>>, where: string) {
  expect(report.hidden, where + ' toggle').toBe(false);
  if (!report.fitAll) expect(report.covers, where + ' fitted').toBe(true);
  expect(report.buttons.map((b) => b.name), where).toEqual(['Like breadboard', 'Tidy']);
  for (const b of report.buttons) {
    expect(b.w, where + ' ' + b.name).toBeGreaterThanOrEqual(44);
    expect(b.h, where + ' ' + b.name).toBeGreaterThanOrEqual(44);
    expect(b.disabled, where).toBe(false);
  }
  expect(report.buttons[0].pressed, where).toBe('true');
  expect(report.buttons[1].pressed, where).toBe('false');
  for (let i = 0; i < report.bodies.length; i++) for (let j = i + 1; j < report.bodies.length; j++) {
    expect(overlaps(report.bodies[i], report.bodies[j]), where + ' bodies ' + report.bodies[i].id + ' ' + report.bodies[j].id).toBe(false);
  }
  for (let i = 0; i < report.labels.length; i++) for (let j = i + 1; j < report.labels.length; j++) {
    expect(overlaps(report.labels[i], report.labels[j]), where + ' labels ' + report.labels[i].text + ' / ' + report.labels[j].text).toBe(false);
  }
  for (const label of report.labels) {
    for (const body of report.bodies) {
      if (label.id && label.id === body.id) continue;
      expect(overlaps(label, body), where + ' label ' + label.text + ' on ' + body.id).toBe(false);
    }
  }
  const toggle = report.toggle;
  expect(toggle, where + ' toggle box').toBeTruthy();
  if (!toggle) return;
  for (const body of report.screenBodies) expect(overlaps(body, toggle as Box), where + ' toggle covers ' + body.id).toBe(false);
}

for (const example of EXAMPLES) {
  for (const width of [390, 1280]) {
    test(example.id + ' schematic at ' + width, async ({ page }) => {
      await install(page);
      await openExample(page, example.id, width);
      const report = await drawing(page);
      assertClear(report, example.id + '@' + width);
      if (example.id === 'blink' || example.id === 'simon') {
        expect(report.wiredOutside, example.id + '@' + width + ' off screen ' + JSON.stringify(report.wiredOutside)).toEqual([]);
      }
      if (width === 390 && report.toggle) {
        const mid = (report.toggle.y + report.toggle.y2) / 2;
        expect(mid, 'thumb reach').toBeGreaterThan(report.innerH * 0.55);
      }
      const part = example.part || await page.evaluate(() => {
        const p = (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.find((q) => q.type !== 'breadboard' && q.type !== 'label');
        return p ? p.id : '';
      });
      const before = await page.evaluate((id) => {
        const s = (window as unknown as { app: { schematic: { model: { symbols: { id: string; x: number; y: number }[] } } } }).app.schematic.model.symbols.find((s) => s.id === id);
        return s ? s.x + ',' + s.y : '';
      }, part);
      expect(before).not.toBe('');
      await page.locator('#bView2d').click();
      await page.waitForFunction(() => !document.body.classList.contains('viewsch'));
      await page.evaluate((id) => {
        const app = (window as unknown as { app: { proj: { parts: { id: string; x: number; y: number }[] }; editor: { render: () => void }; schematic: { invalidate: () => void } } }).app;
        const p = app.proj.parts.find((q) => q.id === id);
        if (!p) return;
        p.x += 80;
        p.y += 30;
        app.editor.render();
        app.schematic.invalidate();
      }, part);
      await page.locator('#bViewSch').click();
      await page.waitForFunction(() => document.body.classList.contains('viewsch'));
      await expect.poll(async () => page.evaluate((id) => {
        const s = (window as unknown as { app: { schematic: { model: { symbols: { id: string; x: number; y: number }[] } } } }).app.schematic.model.symbols.find((s) => s.id === id);
        return s ? s.x + ',' + s.y : '';
      }, part)).not.toBe(before);
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
      }));
      const moved = await drawing(page);
      assertClear(moved, example.id + '@' + width + ' moved');
      if (example.id === 'blink' || example.id === 'simon') {
        expect(moved.wiredOutside, example.id + '@' + width + ' moved off screen').toEqual([]);
      }
      await expect(page.locator('.toast')).toHaveCount(0);
      await chromeClear(page, example.id + '@' + width + ' after the toast fades');
    });
  }
}

test('remote at 390 keeps labels readable and Fit all shows every part', async ({ page }) => {
  await install(page);
  await openExample(page, 'remote', 390);
  const opened = await drawing(page);
  expect(opened.fitAll).toBe(true);
  expect(opened.screenPx, 'part labels ' + opened.screenPx.toFixed(2) + 'px at ' + opened.zoomPct.toFixed(0) + '%').toBeGreaterThanOrEqual(11);
  expect(opened.espInView).toBe(true);
  const fit = page.locator('#schFitAll');
  await expect(fit).toBeVisible();
  const box = await fit.boundingBox();
  expect(box && box.width).toBeGreaterThanOrEqual(44);
  expect(box && box.height).toBeGreaterThanOrEqual(44);
  await fit.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await drawing(page)).covers).toBe(true);
});

test('Tidy is one key away and is remembered for this project', async ({ page }) => {
  await install(page);
  await openExample(page, 'blink', 1280);
  await page.locator('#schLayTidy').click();
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#schLayBoard').click();
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#schLayBoard').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { proj?: { parts?: unknown[] }; schematic?: unknown } }).app;
    return !!(app && app.proj && app.proj.parts && app.proj.parts.length && app.schematic);
  });
  await page.locator('#bViewSch').click();
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  const stored = await page.evaluate(() => localStorage.getItem('esp32lab.schLayout.unsaved'));
  expect(stored).toBe('tidy');
});

test('schmatch=0 hides the control and keeps a schematic', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ex=blink&resume=0&schmatch=0');
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { proj?: { parts?: unknown[] }; schematic?: { SCHEMATIC_MATCH_LAYOUT?: boolean } } }).app;
    return !!(app && app.proj && app.proj.parts && app.proj.parts.length);
  });
  const flag = await page.evaluate(() => (window as unknown as { Schematic: { SCHEMATIC_MATCH_LAYOUT: boolean } }).Schematic.SCHEMATIC_MATCH_LAYOUT);
  expect(flag).toBe(false);
  await page.locator('#bViewSch').click();
  await page.waitForFunction(() => !!document.querySelector('#stageSch.on .sch-sym'));
  await expect(page.locator('#schLayout')).toBeHidden();
});
