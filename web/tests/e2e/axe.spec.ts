// QA's axe rules at phone and desktop, in both themes. Any hit fails the run.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

const RULES = [
  'label-content-name-mismatch',
  'meta-viewport',
  'region',
  'color-contrast',
  'label',
  'label-title-only',
  'landmark-unique',
  'page-has-heading-one',
  'scrollable-region-focusable',
];

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

for (const width of [390, 1280]) {
  for (const theme of ['dark', 'light']) {
    test(`axe stays clear in ${theme} at ${width}`, async ({ page }) => {
      await install(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await page.goto('/?ex=blink&resume=0');
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { cmd?: unknown } }).app?.cmd)).toBe(true);
      const results = await new AxeBuilder({ page }).withRules(RULES).analyze();
      const bad = results.violations.map((v) => {
        const nodes = v.nodes.slice(0, 12).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n')[0]).join('\n    ');
        return v.id + ' (' + v.nodes.length + ')\n    ' + nodes;
      });
      expect(bad, bad.join('\n')).toEqual([]);
    });
  }
}
