// Layout-shift sum from a PerformanceObserver installed before navigation.
// Shifts with hadRecentInput are ignored. The budget is 0.02 at both widths.
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

async function shiftSum(page: Page, width: number, height: number) {
  await page.addInitScript(() => {
    const bag = window as unknown as { __cls: number };
    bag.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) bag.__cls += shift.value || 0;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.setViewportSize({ width, height });
  await install(page);
  await page.goto('/?ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle', { timeout: 30000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

test('layout shift sum stays under 0.02 at 390', async ({ page }) => {
  const cls = await shiftSum(page, 390, 844);
  expect(cls).toBeLessThan(0.02);
});

test('layout shift sum stays under 0.02 at 1280', async ({ page }) => {
  const cls = await shiftSum(page, 1280, 800);
  expect(cls).toBeLessThan(0.02);
});
