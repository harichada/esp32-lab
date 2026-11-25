// Studio Dark (?ui=3) core flows. The classic UI stays the default.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page, type Locator } from '@playwright/test';

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

const ART = '/opt/cursor/artifacts';

async function install(page: Page, api?: { compile?: Record<string, unknown>; health?: Record<string, unknown> }) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.addInitScript(() => {
    // One clear per tab. Later navigations keep the switch's saved choice.
    if (sessionStorage.getItem('ui3-booted') === '1') return;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('ui3-booted', '1');
  });
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ signed_in: false, providers: { google: true, github: true }, csrf: '', display_name: '' }),
  }));
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/compile') && route.request().method() === 'POST') {
      const body = api && api.compile ? api.compile : { ok: true, id: '0123456789abcdef', log: 'ok\n', cached: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(api && api.health ? api.health : { ok: true }),
  }));
  await page.routeWebSocket(/\/api\/run\//, (ws) => {
    ws.onMessage(() => {});
    ws.send(JSON.stringify({ t: 'session', sid: 'ui3', grace_s: 30 }));
    ws.send(JSON.stringify({ t: 'status', msg: 'qemu started' }));
  });
  return errors;
}

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => document.body.dataset.ui3 === '1')).toBe(true);
}

async function quiet(page: Page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((n) => n.remove()));
}

async function axe(page: Page) {
  await quiet(page);
  const results = await new AxeBuilder({ page }).withRules(RULES).analyze();
  const bad = results.violations.map((v) => v.id + ' ' + v.nodes.map((n) => n.target.join(' ') + ' ' + (n.failureSummary || '')).join(' | '));
  expect(bad, bad.join('\n')).toEqual([]);
}

async function inside(page: Page, loc: Locator) {
  const box = await loc.boundingBox();
  const vp = page.viewportSize();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual((vp?.width || 0) + 2);
  expect(box!.y + box!.height).toBeLessThanOrEqual((vp?.height || 0) + 2);
}

test('welcome loads, stays opt-in, and switches back', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ui=3&resume=0');
  await ready(page);
  await expect(page.locator('#ui3home')).toBeVisible();
  await expect(page.locator('#ui3StartTour')).toBeVisible();
  await expect(page.locator('#ui3Gallery')).toContainText('Blink');
  await expect(page.locator('#ui3top h1')).toHaveText('Circuit Lab');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('esp32lab.ui'))).toBe(null);
  await expect(page.locator('#top')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#uiSwitch')).toHaveText('Switch back');
  await quiet(page);
  await page.screenshot({ path: `${ART}/ui3-desktop-welcome-1440x900.png`, animations: 'disabled' });
  await axe(page);

  await page.locator('#uiSwitch').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui') || '')).toBe('');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('esp32lab.ui'))).toBe('1');
  await expect(page.locator('#uiSwitch')).toHaveText('Try the new interface');
  await expect(page.locator('#bRun')).toBeVisible();
  await page.locator('#uiSwitch').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui'))).toBe('3');
  await expect(page.locator('#ui3top')).toBeVisible();
  await expect(page.locator('#uiSwitch')).toHaveText('Switch back');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a stored Studio Dark choice loses to ?ui=2', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.addInitScript(() => localStorage.setItem('esp32lab.ui', '3'));
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.route('**/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ signed_in: false, providers: { google: true, github: true }, csrf: '', display_name: '' }),
  }));
  await page.goto('/?ui=2&resume=0');
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui'))).toBe('2');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('classic stays the default with the try-it switch', async ({ page }) => {
  await install(page);
  await page.goto('/?resume=0');
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui') || 'classic')).toBe('classic');
  await expect(page.locator('#uiSwitch')).toHaveText('Try the new interface');
  await expect(page.locator('#bRun')).toBeVisible();
});

test('desktop workbench: tidy schematic, part, wire, run, menus', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#ui3home')).toBeHidden();
  await expect(page.locator('#bViewSch')).toHaveClass(/on/);
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => {
    const svg = document.getElementById('stageSch');
    if (!svg || !svg.classList.contains('on')) return false;
    const r = svg.getBoundingClientRect();
    return r.width > 200 && r.height > 200 && r.top < 200 && svg.querySelectorAll('.sch-wire').length > 2;
  })).toBe(true);
  await expect(page.locator('#minimap')).toHaveClass(/off/);
  await quiet(page);
  await page.screenshot({ path: `${ART}/ui3-desktop-workbench-1440x900.png`, animations: 'disabled' });

  await page.locator('#bView2d').click();
  await expect(page.locator('body')).not.toHaveClass(/viewsch/);
  const before = await page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[]; wires: unknown[] } } }).app.proj.parts.length);
  await page.locator('.pitem[data-type="resistor"]').first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length)).toBe(before + 1);
  await expect(page.locator('#ui3ctx')).toBeVisible();
  await expect(page.locator('#ui3ctx')).toContainText('Duplicate');
  await expect(page.getByRole('button', { name: /explain|make it fade/i })).toHaveCount(0);
  await page.locator('#bFit').click();
  const wired = await page.evaluate(() => {
    const root = window as unknown as {
      app: { proj: { parts: { id: string; type: string }[]; wires: unknown[] }; editor: { svg: SVGSVGElement; pinAtEvent(ev: unknown): unknown } };
      Parts: { T: Record<string, { pins(p: unknown): { name: string }[] }>; pinWorld(p: unknown, pin: unknown): { x: number; y: number } };
    };
    const svg = root.app.editor.svg;
    const ctm = svg.getScreenCTM();
    if (!ctm) return false;
    const screen = (x: number, y: number) => {
      const sp = svg.createSVGPoint(); sp.x = x; sp.y = y; const s = sp.matrixTransform(ctm); return { x: s.x, y: s.y };
    };
    const res = root.app.proj.parts.filter((p) => p.type === 'resistor').slice(-1)[0];
    const esp = root.app.proj.parts.find((p) => p.type === 'esp32');
    if (!res || !esp) return false;
    const pin = (part: { type: string }, name: string) => {
      const spec = root.Parts.T[part.type].pins(part).find((q) => q.name === name);
      return spec ? root.Parts.pinWorld(part, spec) : null;
    };
    const a = pin(res, '1'), b = pin(esp, 'D4') || pin(esp, 'D13') || pin(esp, 'D15');
    if (!a || !b) return false;
    const tap = (pt: { x: number; y: number }) => {
      const el = document.elementFromPoint(pt.x, pt.y) || svg;
      const common = { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', common));
      window.dispatchEvent(new PointerEvent('pointerup', common));
    };
    const start = root.app.proj.wires.length;
    tap(screen(a.x, a.y));
    tap(screen(b.x, b.y));
    return root.app.proj.wires.length === start + 1;
  });
  expect(wired).toBe(true);

  await page.locator('#ui3Run').click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('running'))).toBe(true);
  await expect(page.locator('#ui3Run')).toHaveText('Stop');

  await page.locator('#ui3Name').click();
  await expect(page.locator('.ui3-menu')).toBeVisible();
  await inside(page, page.locator('.ui3-menu'));
  await page.keyboard.press('Escape');
  await page.locator('#ui3RunMore').click();
  await expect(page.locator('.ui3-menu')).toContainText('Restart');
  await inside(page, page.locator('.ui3-menu'));
  await page.keyboard.press('Escape');
  await page.locator('#ui3Help').click();
  await expect(page.locator('.ui3-menu')).toContainText('About');
  await inside(page, page.locator('.ui3-menu'));
  await page.keyboard.press('Escape');
  await page.locator('#ui3rail [data-rail="settings"]').click();
  await expect(page.locator('.ui3-menu')).toContainText('Theme');
  await inside(page, page.locator('.ui3-menu'));
  await page.keyboard.press('Escape');
  await page.locator('#ui3rail [data-rail="code"]').click();
  await expect(page.locator('body')).toHaveClass(/ui3-code/);
  await expect(page.locator('#code')).toBeVisible();
  await expect.poll(async () => {
    const box = await page.locator('#dock').boundingBox();
    const vp = page.viewportSize();
    return !!box && box.x >= -1 && box.x + box.width <= (vp?.width || 0) + 2;
  }).toBe(true);
  await inside(page, page.locator('#dock'));
  await page.locator('#ui3DockClose').click();
  await page.locator('#ui3Search').click();
  await expect(page.locator('#cmdk')).toBeVisible();
  await inside(page, page.locator('#cmdk .cmdk-box'));
  await page.keyboard.press('Escape');
  await axe(page);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('phone and narrow phone: tabs, sheets, and a visible compile error', async ({ page }) => {
  const errors = await install(page, { compile: { ok: false, log: 'sketch.ino:1:1: error: expected unqualified-id\n' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ui=3&resume=0');
  await ready(page);
  await expect(page.locator('#ui3home')).toBeVisible();
  await expect(page.locator('#ui3tabs')).toBeHidden();
  await quiet(page);
  await page.screenshot({ path: `${ART}/ui3-phone-welcome-390x844.png`, animations: 'disabled' });
  await axe(page);

  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#ui3tabs')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/\bm\b/);
  await quiet(page);
  await page.screenshot({ path: `${ART}/ui3-phone-workbench-390x844.png`, animations: 'disabled' });

  await page.locator('#ui3tabs [data-phone="parts"]').click();
  await expect(page.locator('#palette')).toBeVisible();
  await inside(page, page.locator('#palette'));
  await page.locator('#ui3tabs [data-phone="code"]').click();
  await expect(page.locator('body')).toHaveClass(/ui3-code/);
  await expect.poll(async () => {
    const box = await page.locator('#dock').boundingBox();
    const vp = page.viewportSize();
    return !!box && box.x >= -1 && box.x + box.width <= (vp?.width || 0) + 2;
  }).toBe(true);
  await inside(page, page.locator('#dock'));
  await page.locator('#ui3DockClose').click();
  await page.locator('#ui3tabs [data-phone="more"]').click();
  const more = page.locator('#ui3more');
  await expect(more).toBeVisible();
  await inside(page, more);
  await more.locator('[data-go="close"]').scrollIntoViewIfNeeded();
  await inside(page, more.locator('[data-go="close"]'));
  await expect(more).toContainText('Build flags');
  await expect(more).toContainText('Open-source notices');
  await page.locator('#ui3tabs [data-phone="circuit"]').click();
  await expect(more).toBeHidden();

  await page.locator('#ui3TabRun').click();
  const strip = page.locator('#compileStrip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('error: expected unqualified-id');
  const top = await page.locator('#ui3top').boundingBox();
  const err = await strip.boundingBox();
  expect(err!.y).toBeGreaterThanOrEqual((top!.y + top!.height) - 1);
  await inside(page, strip);

  await page.setViewportSize({ width: 360, height: 740 });
  await page.locator('#ui3tabs [data-phone="more"]').click();
  await expect(page.locator('#ui3more')).toBeVisible();
  await page.locator('#ui3more [data-go="close"]').scrollIntoViewIfNeeded();
  await inside(page, page.locator('#ui3more [data-go="close"]'));
  await inside(page, page.locator('#ui3tabs'));
  expect(errors, errors.join('\n')).toEqual([]);
});

test('reduced motion drops the run glow animation', async ({ page }) => {
  await install(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  const name = await page.locator('#ui3Run').evaluate((el) => getComputedStyle(el).animationName);
  expect(name).toBe('none');
});

test('a missing backend is announced below the top bar', async ({ page }) => {
  await install(page, { health: { ok: false } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ui=3&resume=0');
  await ready(page);
  const alert = page.locator('#ui3alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/Backend missing|Can't reach the simulator/);
  const top = await page.locator('#ui3top').boundingBox();
  const box = await alert.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual((top!.y + top!.height) - 1);
  await inside(page, alert);
});
