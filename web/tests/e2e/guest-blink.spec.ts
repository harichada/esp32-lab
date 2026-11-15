// A signed-out visitor can still run Blink (LED + resistor). Locked parts
// show the sign-in sentence and open the existing Sign in menu. The API is
// mocked; this does not start QEMU.
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

const ALLOW = 'esp32,breadboard,led,resistor,pushbutton,potentiometer,buzzer';

async function install(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const pathName = new URL(req.url()).pathname;
    if (req.resourceType() !== 'document' || (pathName !== '/' && !pathName.endsWith('/index.html'))) return route.fallback();
    const res = await route.fetch();
    let body = await res.text();
    if (!body.includes('name="cl-auth"')) body = body.replace('<head>', '<head>\n<meta name="cl-auth" content="1">');
    if (!body.includes('name="guestparts"')) {
      body = body.replace('<head>', '<head>\n<meta name="guestparts" content="' + ALLOW + '">');
    }
    if (!body.includes('guestparts.js')) {
      body = body.replace('<script src="js/app.js', '<script src="js/guestparts.js?v=1"></script>\n<script src="js/app.js');
    }
    await route.fulfill({ response: res, body });
  });
  await page.route('**/auth/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ signed_in: false, providers: { google: true, github: true }, csrf: '', display_name: '' }),
  }));
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/health')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (url.includes('/api/compile/progress')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' });
    }
    if (url.includes('/api/compile') && route.request().method() === 'POST') {
      const posted = JSON.parse(route.request().postData() || '{}');
      const parts = posted.parts || [];
      const starter = new Set(ALLOW.split(','));
      const locked = parts.filter((name: string) => !starter.has(name));
      if (locked.length) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'guest_parts', message: 'Sign in free to use this part' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: '0123456789abcdef', log: 'ok\n', cached: true, parts }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\/run\//, (ws) => {
    ws.onMessage(() => {});
    ws.send(JSON.stringify({ t: 'session', sid: 'guestblink', grace_s: 30 }));
    ws.send(JSON.stringify({ t: 'status', msg: 'qemu started' }));
  });
  return errors;
}

test('a guest can run Blink and a locked part opens sign-in', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ex=blink&resume=0');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { cmd?: unknown } }).app?.cmd)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as { app?: { proj?: { parts?: { type: string }[] } } }).app;
    const types = (app && app.proj && app.proj.parts || []).map((p) => p.type);
    return types.includes('led') && types.includes('resistor') && types.includes('esp32');
  })).toBe(true);
  await expect(page.locator('#bSignIn')).toBeVisible();
  const locked = page.locator('.pitem-locked').first();
  await locked.scrollIntoViewIfNeeded();
  await expect(locked).toBeVisible();
  await expect(locked).toContainText('Sign in free to use this part');
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  await expect(locked).toHaveAttribute('role', 'button');
  const axe = await new AxeBuilder({ page }).withRules(RULES).analyze();
  const bad = axe.violations.map((v) => v.id + ' ' + v.nodes.length);
  expect(bad, bad.join('\n')).toEqual([]);
  await locked.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#authMenu')).toBeVisible();
  await page.keyboard.press('Escape');
  const partCount = await page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length);
  await page.locator('#bRun').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app?: { compilePhase?: string } }).app?.compilePhase)).toBe('running');
  const after = await page.evaluate(() => (window as unknown as { app: { proj: { parts: { type: string }[] } } }).app.proj.parts.map((p) => p.type));
  expect(after).toContain('led');
  expect(after).toContain('resistor');
  expect(after.length).toBe(partCount);
  expect(errors).toEqual([]);
});
