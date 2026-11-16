// Workbench (ui2) at desktop 1280x800 and phone 390x844. The flag is off
// unless the address says ?ui=2, so these cases opt in. API calls are mocked.
import AxeBuilder from '@axe-core/playwright';
import fs from 'fs';
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
  'heading-order',
  'scrollable-region-focusable',
];

const ALLOW = 'esp32,breadboard,led,resistor,pushbutton,potentiometer,buzzer,ground,vcc33,vcc5,label';

async function install(page: Page, opts?: { guest?: boolean }) {
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
    if (opts && opts.guest) {
      if (!body.includes('name="cl-auth"')) body = body.replace('<head>', '<head>\n<meta name="cl-auth" content="1">');
      if (!body.includes('name="guestparts"')) body = body.replace('<head>', '<head>\n<meta name="guestparts" content="' + ALLOW + '">');
      if (!body.includes('guestparts.js')) body = body.replace('<script src="js/app.js', '<script src="js/guestparts.js?v=4"></script>\n<script src="js/app.js');
    }
    await route.fulfill({ response: res, body });
  });
  await page.route('**/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ signed_in: false, providers: { google: true, github: true }, csrf: '', display_name: '' }),
  }));
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/compile') && route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: '0123456789abcdef', log: 'ok\n', cached: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\/run\//, (ws) => {
    ws.onMessage(() => {});
    ws.send(JSON.stringify({ t: 'session', sid: 'ui2', grace_s: 30 }));
    ws.send(JSON.stringify({ t: 'status', msg: 'qemu started' }));
  });
  return errors;
}

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { cmd?: unknown }; UI2?: { on?: () => boolean } }).UI2?.on?.())).toBe(true);
  await expect.poll(() => page.evaluate(() => document.body.dataset.ui2 === '1')).toBe(true);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withRules(RULES).analyze();
  const bad = results.violations.map((v) => v.id + ' ' + v.nodes.map((n) => n.target.join(' ') + ' ' + (n.failureSummary || '')).join(' | '));
  expect(bad, bad.join('\n')).toEqual([]);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: '/opt/cursor/artifacts/' + name });
}

test('first-run card, Blink in 15 clicks, copy and the lock bar', async ({ page }) => {
  const errors = await install(page, { guest: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ui=2&resume=0');
  await ready(page);
  await expect(page.locator('#ui2Start')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app: { proj: unknown } }).app.proj)).toBeNull();
  await axe(page);
  await shot(page, 'ui2-after-desk-dark-start.png');

  await page.evaluate(() => {
    (window as unknown as { __clicks?: number }).__clicks = 0;
    document.addEventListener('click', () => { (window as unknown as { __clicks: number }).__clicks++; }, true);
  });
  await page.getByRole('button', { name: 'Start guided Blink' }).click();
  await expect.poll(() => page.evaluate(() => {
    const parts = (window as unknown as { app: { proj?: { parts?: { type: string }[] } } }).app.proj?.parts || [];
    return parts.some((p) => p.type === 'esp32');
  })).toBe(true);
  await page.locator('.pitem[data-type="led"]').click();
  await page.locator('.pitem[data-type="resistor"]').click();
  const ids = await page.evaluate(() => (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.map((p) => ({ id: p.id, type: p.type })));
  const led = ids.find((p) => p.type === 'led')!;
  const res = ids.find((p) => p.type === 'resistor')!;
  const esp = ids.find((p) => p.type === 'esp32')!;
  async function clickPin(partId: string, pinName: string) {
    const pt = await page.evaluate(({ partId, pinName }) => {
      const wapp = window as unknown as { app: { editor: { part: (id: string) => { type: string } } }; Parts: { T: Record<string, { pins: (p: unknown) => { name: string }[] }>; pinWorld: (p: unknown, pin: unknown) => { x: number; y: number } } };
      const part = wapp.app.editor.part(partId);
      const pin = wapp.Parts.T[part.type].pins(part).find((q) => q.name === pinName);
      const world = wapp.Parts.pinWorld(part, pin);
      const svg = document.getElementById('stage') as unknown as SVGSVGElement;
      const sp = svg.createSVGPoint();
      sp.x = world.x; sp.y = world.y;
      const s = sp.matrixTransform(svg.getScreenCTM()!);
      return { x: s.x, y: s.y };
    }, { partId, pinName });
    await page.mouse.click(pt.x, pt.y);
  }
  await clickPin(esp.id, 'D2');
  await clickPin(res.id, '1');
  await clickPin(res.id, '2');
  await clickPin(led.id, 'A');
  await clickPin(led.id, 'C');
  await clickPin(esp.id, 'GND.1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { app: { proj: { wires: unknown[] } } }).app.proj.wires.length)).toBe(3);
  await page.locator('#ui2Run').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app?: { compilePhase?: string } }).app?.compilePhase)).toBe('running');
  const clicks = await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
  expect(clicks).toBeLessThanOrEqual(15);
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/ui2-blink-clicks.json', JSON.stringify({ clicks, target: 15 }) + '\n');

  const before = await page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length);
  await page.evaluate(({ ledId, resId }) => {
    const ed = (window as unknown as { app: { editor: { select: (s: unknown) => void; svg: SVGSVGElement } } }).app.editor;
    ed.select(null);
    const fire = (id: string) => {
      const el = document.querySelector('#lParts [data-id="' + id + '"]') as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.x + 2, clientY: r.y + 2, button: 0, shiftKey: true, pointerId: 1, pointerType: 'mouse' }));
    };
    fire(ledId); fire(resId);
    const active = document.activeElement as HTMLElement | null;
    if (active && active.blur) active.blur();
    ed.svg.focus();
  }, { ledId: led.id, resId: res.id });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(() => page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length)).toBe(before + 2);

  await page.locator('#ui2SideTabs [data-side="parts"]').click();
  await page.locator('#ui2PalTools [data-set="all"]').click();
  const bar = page.locator('#ui2Lock');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveText('Sign in to unlock all parts');
  const locked = page.locator('.pitem-locked').first();
  await expect(locked).toBeVisible();
  await expect(locked).not.toContainText('Sign in free to use this part');
  await locked.click({ force: true });
  await expect(page.locator('#authDlg')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('desktop light and the running canvas', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ui=2&ex=blink&resume=0');
  await ready(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await axe(page);
  await shot(page, 'ui2-after-desk-light.png');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot(page, 'ui2-after-desk-dark.png');
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test.describe('phone', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('one tap adds one part, and light and dark stay clear', async ({ page }) => {
    const errors = await install(page, { guest: true });
    await page.goto('/?ui=2&ex=blink&resume=0');
    await ready(page);
    await axe(page);
    await shot(page, 'ui2-after-phone-dark.png');
    const before = await page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length);
    await page.locator('#ui2Phone [data-a="parts"]').tap();
    const led = page.locator('#mTrack .pitem[data-type="led"]');
    await expect(led).toBeVisible();
    await led.tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length)).toBe(before + 1);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await axe(page);
    await shot(page, 'ui2-after-phone-light.png');
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });
});

test('before shots of the current UI', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ex=blink&resume=0');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { app?: { cmd?: unknown } }).app?.cmd)).toBe(true);
  await shot(page, 'ui2-before-desk-dark.png');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await shot(page, 'ui2-before-desk-light.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(400);
  await shot(page, 'ui2-before-phone-dark.png');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await shot(page, 'ui2-before-phone-light.png');
});
