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
  await page.setViewportSize({ width: width, height: width === 390 ? 780 : 800 });
  await page.goto('/?ex=' + id + '&resume=0');
  await page.waitForFunction((key) => {
    const app = (window as unknown as { app?: { proj?: { example?: string; parts?: unknown[] }; schematic?: unknown } }).app;
    return !!(app && app.proj && app.proj.example === key && app.proj.parts && app.proj.parts.length && app.schematic);
  }, id);
  await page.locator('#bViewSch').click();
  await page.waitForFunction(() => document.body.classList.contains('viewsch') && !!document.querySelector('#stageSch.on .sch-hit'));
  await expect.poll(async () => page.evaluate(() => {
    const hit = document.querySelector('#stageSch .sch-hit');
    return hit ? hit.getBoundingClientRect().width : 0;
  })).toBeGreaterThan(8);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
  }));
}

type Box = { x: number; y: number; x2: number; y2: number; id: string; text: string };

async function drawing(page: Page) {
  return page.evaluate(() => {
    const model = (window as unknown as {
      app: { schematic: { model: {
        bounds: { x: number; y: number; w: number; h: number };
        symbols: { id: string; x: number; y: number; w: number; h: number }[];
        texts: { x: number; y: number; x2: number; y2: number; own: string | null; text: string }[];
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
    const ref = document.querySelector('#stageSch .sch-ref');
    const vb = (document.getElementById('stageSch') as SVGSVGElement).viewBox.baseVal;
    const b = model.bounds;
    const covers = vb.x <= b.x + 8 && vb.y <= b.y + 8 && vb.x + vb.width >= b.x + b.w - 8 && vb.y + vb.height >= b.y + b.h - 8;
    return {
      bodies: bodies,
      labels: labels,
      screenBodies: screenBodies,
      toggle: t ? { x: t.left, y: t.top, x2: t.right, y2: t.bottom, w: t.width, h: t.height } : null,
      buttons: buttons,
      refPx: ref ? parseFloat(getComputedStyle(ref).fontSize) : 0,
      covers: covers,
      hidden: !!(toggle && toggle.hidden),
      innerH: window.innerHeight,
    };
  });
}

function overlaps(a: Box, b: Box) {
  return Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 1;
}

function assertClear(report: Awaited<ReturnType<typeof drawing>>, where: string) {
  expect(report.hidden, where + ' toggle').toBe(false);
  expect(report.covers, where + ' fitted').toBe(true);
  expect(report.refPx, where + ' font').toBeGreaterThanOrEqual(9);
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
      assertClear(await drawing(page), example.id + '@' + width + ' moved');
    });
  }
}

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
