// Schematic fit, My Projects at phone width, and the result toast versus the hint.
// Static files only. /api is mocked. Nothing here calls the live host.
import { test, expect, type Page } from '@playwright/test';

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"ok":true}',
  }));
  await page.routeWebSocket(/\/api\//, (ws) => { ws.onMessage(() => {}); });
}

async function ready(page: Page) {
  await page.goto('/?ex=blink');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { cmd?: { viewSch?: unknown } } }).app?.cmd?.viewSch)).toBe(true);
}

function overlap(a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }) {
  return a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
}

test('schematic toolbar and canvas fit at 768 and 1000', async ({ page }) => {
  await install(page);
  await ready(page);
  for (const width of [768, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => (window as unknown as { app: { cmd: { viewSch: () => void } } }).app.cmd.viewSch());
    await page.waitForTimeout(50);
    const box = await page.evaluate(() => {
      const client = document.documentElement.clientWidth;
      const wrap = document.getElementById('stageWrap')!;
      const wr = wrap.getBoundingClientRect();
      const shown = (el: Element | null) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1) return null;
        return { l: r.left, t: r.top, r: r.right, b: r.bottom };
      };
      const tools = shown(document.querySelector('.canvas-tools'));
      const zoom = shown(document.querySelector('.zoom-tools'));
      const kids = [...document.querySelectorAll('.canvas-tools > *, .zoom-tools > *')].map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (cs.display === 'none' || r.width < 1) return null;
        return { id: (el as HTMLElement).id || el.className, l: r.left, r: r.right, past: r.right - wr.right, before: wr.left - r.left };
      }).filter(Boolean);
      return {
        docOver: document.documentElement.scrollWidth - client,
        tools, zoom,
        toolsPast: tools ? tools.r - wr.right : 0,
        zoomPast: zoom ? zoom.r - wr.right : 0,
        kids,
      };
    });
    expect(box.docOver, width + ' horizontal scroll').toBeLessThanOrEqual(1);
    expect(box.tools, width + ' toolbar').toBeTruthy();
    expect(box.toolsPast, width + ' toolbar past canvas').toBeLessThanOrEqual(0.5);
    expect(box.zoomPast, width + ' zoom past canvas').toBeLessThanOrEqual(0.5);
    const outside = (box.kids as Array<{ id: string; past: number; before: number }>).filter((k) => k.past > 0.5 || k.before > 0.5);
    expect(outside, width + ' ' + JSON.stringify(outside)).toEqual([]);
  }
});

test('projects stay inside 320 and 390 and From server is reachable', async ({ page }) => {
  await install(page);
  await ready(page);
  const long = 'SupercalifragilisticExpialidociousWeatherStationSensorNodeNumberTwelve';
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate((name) => {
      const all: Record<string, unknown> = {};
      for (let i = 0; i < 12; i += 1) {
        const id = 'p' + i;
        const label = i === 0 ? name : name + ' ' + i;
        all[id] = { id, name: label, updated: Date.now() - i * 1000, from: '', proj: { id, name: label, parts: [], wires: [] } };
      }
      (window as unknown as { clStorage: { local: { setItem: (k: string, v: string) => void } } }).clStorage.local.setItem('esp32lab.projects.v1', JSON.stringify(all));
      (window as unknown as { app: { cmd: { projects: () => void } } }).app.cmd.projects();
    }, long);
    const chip = page.locator('#bFromServer');
    await expect(chip).toBeVisible();
    await chip.focus();
    await expect(chip).toBeFocused();
    const box = await page.evaluate(() => {
      const client = document.documentElement.clientWidth;
      const modal = document.querySelector('#projDlg .modal-box') as HTMLElement;
      const mr = modal.getBoundingClientRect();
      const bad: string[] = [];
      for (const el of modal.querySelectorAll('button, .pn, .row')) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.right > mr.right + 1 || r.left < mr.left - 1 || r.right > client + 1) {
          bad.push((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48) + ' @' + r.right.toFixed(0));
        }
      }
      const open = document.querySelector('#projDlg [data-a="open"]') as HTMLElement;
      const or = open.getBoundingClientRect();
      return {
        docOver: document.documentElement.scrollWidth - client,
        bad: bad.slice(0, 6),
        openInside: or.left >= -0.5 && or.right <= client + 0.5 && or.width > 20,
        openText: open.textContent,
      };
    });
    expect(box.docOver, width + ' page').toBeLessThanOrEqual(1);
    expect(box.bad, width + ' overflow').toEqual([]);
    expect(box.openText).toBe('Open');
    expect(box.openInside).toBe(true);
    await page.locator('#projDlg [data-a="close"]').click();
  }
});

test('result toast does not cover the hint at 390', async ({ page }) => {
  await install(page);
  await ready(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.evaluate(() => {
    const app = (window as unknown as { app: { setCompilePhase: (p: string) => void; cmd: { toast: (m: string) => void } } }).app;
    app.setCompilePhase('building');
    app.cmd.toast('Build finished. Open the serial monitor.');
  });
  const boxes = await page.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1) return null;
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    return { toast: rect('.toast'), hint: rect('.hint'), compile: rect('#mCompileToast') };
  });
  expect(boxes.toast).toBeTruthy();
  expect(boxes.hint).toBeTruthy();
  expect(overlap(boxes.toast!, boxes.hint!)).toBe(false);
  if (boxes.compile) expect(overlap(boxes.toast!, boxes.compile)).toBe(false);
});
