// A full localStorage must not drop the sketch. Save shows a persistent alert,
// Export downloads the edits, and the page stays as the user left it.
import fs from 'fs';
import { test, expect, type Page } from '@playwright/test';

const MSG = "Couldn't save. Your browser storage is full. Export this project to keep it, then delete old projects in My Projects to free up space.";

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

async function pressSave(page: Page, width: number) {
  if (width <= 820) {
    const save = page.locator('#mMore button[data-a="save"]');
    if (!(await save.isVisible())) await page.locator('#mMenu').click();
    await save.click();
    return;
  }
  await page.locator('#bSave').click();
}

async function fillQuota(page: Page) {
  const filled = await page.evaluate(() => {
    const stuff = (size: number) => {
      const chunk = 'x'.repeat(size);
      let i = 0;
      for (;;) {
        try { localStorage.setItem('quota-' + size + '-' + i, chunk); }
        catch (e) { return i; }
        i += 1;
      }
    };
    const counts = [65536, 1024, 64, 1].map(stuff);
    let full = false;
    try { localStorage.setItem('quota-probe', 'x'); }
    catch (e) { full = true; }
    return { counts, full };
  });
  expect(filled.full, 'localStorage still accepted a byte after ' + filled.counts.join(',')).toBe(true);
}

for (const width of [390, 1280]) {
  test(`Save stays on screen when storage is full at ${width}`, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto('/?ex=blink&resume=0');
    await pressSave(page, width);
    await expect(page.locator('#projBanner')).toContainText('My project');
    await expect(page.locator('.toast')).toHaveCount(0);
    await fillQuota(page);

    const marker = 'STORAGE-FULL-' + width;
    await page.evaluate((text) => {
      const ta = document.getElementById('code') as HTMLTextAreaElement;
      // A one-byte growth of an existing key still fits when a new key does not.
      ta.value = ta.value + '\n/* ' + text + ' ' + 'x'.repeat(2048) + ' */';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, marker);
    await page.evaluate(() => {
      const app = (window as unknown as { app: { proj: { parts: { id: string; x: number; y: number }[] } } }).app;
      const part = app.proj.parts.find((p) => p.id === 'R1') || app.proj.parts[0];
      part.x = (part.x || 0) + 24;
      part.y = (part.y || 0) + 8;
    });
    const before = await page.evaluate(() => {
      const app = (window as unknown as { app: { proj: { id: string; parts: unknown; wires: unknown } } }).app;
      const code = (document.getElementById('code') as HTMLTextAreaElement).value;
      return { id: app.proj.id, code, parts: JSON.stringify(app.proj.parts), wires: JSON.stringify(app.proj.wires) };
    });
    await pressSave(page, width);

    const banner = page.locator('#storageFull');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(page.locator('#storageFullMsg')).toHaveText(MSG);
    const fit = await banner.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top, left: r.left, right: r.right, bottom: r.bottom,
        scroll: el.scrollHeight, client: el.clientHeight,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
    expect(fit.top).toBeGreaterThanOrEqual(0);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.vw + 1);
    expect(fit.bottom).toBeLessThanOrEqual(fit.vh + 1);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    for (const id of ['#storageFullExport', '#storageFullProjects', '#storageFullDismiss']) {
      const box = await page.locator(id).boundingBox();
      expect(box, id).toBeTruthy();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('#storageFullExport')).toHaveClass(/primary/);

    await page.evaluate(() => {
      const w = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame; __raf: typeof requestAnimationFrame };
      w.__raf = w.requestAnimationFrame.bind(window);
      w.requestAnimationFrame = () => 0;
    });
    await page.clock.install();
    await page.clock.fastForward(10000);
    await expect(banner).toBeVisible();
    await expect(page.locator('#storageFullMsg')).toHaveText(MSG);
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page.locator('#projBanner')).not.toContainText(/saved \d/);
    await page.evaluate(() => {
      const w = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame; __raf: typeof requestAnimationFrame };
      w.requestAnimationFrame = w.__raf;
    });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#storageFullExport').click(),
    ]);
    const file = await download.path();
    const json = JSON.parse(fs.readFileSync(file!, 'utf8'));
    expect(json.code).toContain(marker);
    expect(JSON.stringify(json.parts)).toBe(before.parts);
    expect(JSON.stringify(json.wires)).toBe(before.wires);

    const after = await page.evaluate(() => {
      const app = (window as unknown as { app: { proj: { parts: unknown; wires: unknown } } }).app;
      return {
        code: (document.getElementById('code') as HTMLTextAreaElement).value,
        parts: JSON.stringify(app.proj.parts),
        wires: JSON.stringify(app.proj.wires),
      };
    });
    expect(after.code).toBe(before.code);
    expect(after.parts).toBe(before.parts);
    expect(after.wires).toBe(before.wires);
    const stored = await page.evaluate((id) => {
      const all = JSON.parse(localStorage.getItem('esp32lab.projects.v1') || '{}');
      return all[id] && all[id].proj && all[id].proj.code;
    }, before.id);
    expect(stored).not.toContain(marker);
    await expect(banner).toBeVisible();
  });
}

test('storage alert stays off the More sheet at 390', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ex=blink&resume=0');
  const mainBefore = await page.locator('#main').boundingBox();
  expect(mainBefore).toBeTruthy();
  await page.locator('#mMenu').click();
  await expect(page.locator('#mMore')).toBeVisible();
  await fillQuota(page);
  await page.evaluate(() => {
    const ta = document.getElementById('code') as HTMLTextAreaElement;
    ta.value = ta.value + '\n/* STORAGE-SHEET */';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#mMore button[data-a="save"]').click();
  const alert = page.locator('#storageFull');
  await expect(alert).toBeVisible();
  await expect(page.locator('#mMore')).toBeVisible();
  const boxes = await page.evaluate(() => {
    const a = document.getElementById('storageFull')!.getBoundingClientRect();
    const s = document.getElementById('mMore')!.getBoundingClientRect();
    const main = document.getElementById('main')!.getBoundingClientRect();
    const save = document.querySelector('#mMore button[data-a="save"]') as HTMLElement;
    const exp = document.getElementById('storageFullExport')!;
    const point = (el: Element) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
      return { w: r.width, h: r.height, ok: !!(top && (top === el || el.contains(top))) };
    };
    return {
      alert: { top: a.top, left: a.left, right: a.right, bottom: a.bottom, w: a.width, h: a.height },
      sheet: { top: s.top, left: s.left, right: s.right, bottom: s.bottom, w: s.width, h: s.height },
      main: { top: main.top, height: main.height, left: main.left },
      save: point(save),
      exp: point(exp),
    };
  });
  const overlap = boxes.alert.left < boxes.sheet.right && boxes.alert.right > boxes.sheet.left
    && boxes.alert.top < boxes.sheet.bottom && boxes.alert.bottom > boxes.sheet.top;
  expect(overlap).toBe(false);
  expect(boxes.alert.w).toBeGreaterThan(40);
  expect(boxes.alert.h).toBeGreaterThan(40);
  expect(boxes.sheet.w).toBeGreaterThan(40);
  expect(boxes.sheet.h).toBeGreaterThan(40);
  expect(boxes.alert.bottom).toBeLessThanOrEqual(boxes.sheet.top + 1);
  expect(boxes.save.ok).toBe(true);
  expect(boxes.save.h).toBeGreaterThanOrEqual(44);
  expect(boxes.exp.ok).toBe(true);
  expect(boxes.exp.w).toBeGreaterThanOrEqual(44);
  expect(boxes.exp.h).toBeGreaterThanOrEqual(44);
  expect(Math.abs(boxes.main.top - mainBefore!.y)).toBeLessThan(1);
  expect(Math.abs(boxes.main.left - mainBefore!.x)).toBeLessThan(1);
  expect(Math.abs(boxes.main.height - mainBefore!.height)).toBeLessThan(1);
});
