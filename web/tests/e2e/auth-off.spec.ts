// Sign-in off is the static lab. auth.js must not ask /auth/session, and
// that missing request must not leave a console error.
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

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

test('sign-in off makes no auth request and no console error', async ({ page }) => {
  const errors: string[] = [];
  const note = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  page.on('console', note);
  page.on('pageerror', (err) => errors.push(String(err)));
  const auth: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/auth')) auth.push(req.url());
  });
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push(res.status() + ' ' + res.url());
  });
  await install(page);
  await page.goto('/?ex=blink');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { cmd?: unknown } }).app?.cmd)).toBe(true);
  await expect.poll(() => page.evaluate(() => !!document.querySelector('meta[name="cl-auth"]'))).toBe(false);
  expect(auth).toEqual([]);
  expect(errors).toEqual([]);
});
