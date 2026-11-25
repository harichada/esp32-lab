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

function overlaps(a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null) {
  if (!a || !b || a.width < 2 || a.height < 2 || b.width < 2 || b.height < 2) return false;
  return a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1;
}

async function dockOpen(page: Page) {
  await expect(page.locator('body')).toHaveClass(/ui3-code/);
  await expect.poll(async () => {
    const box = await page.locator('#dock').boundingBox();
    const vp = page.viewportSize();
    return !!box && box.x >= -1 && box.width > 80 && box.x + box.width <= (vp?.width || 0) + 2;
  }).toBe(true);
}

async function dockClosed(page: Page) {
  await expect(page.locator('body')).not.toHaveClass(/ui3-code/);
  await expect.poll(async () => {
    const box = await page.locator('#dock').boundingBox();
    const vp = page.viewportSize();
    if (!box) return true;
    return box.x >= (vp?.width || 0) - 2;
  }).toBe(true);
}

async function showCommand(page: Page, name: string) {
  await page.locator('#ui3Search').click();
  await page.locator('#cmdkIn').fill(name);
  await page.locator('#cmdkList .ck', { hasText: name }).first().click();
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
  const views = await page.locator('#ui3views').boundingBox();
  expect(err!.y).toBeGreaterThanOrEqual((top!.y + top!.height) - 1);
  expect(overlaps(err, views)).toBe(false);
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

test('desktop and tablet: every closed panel can be opened again', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#bView2d')).toHaveText('Breadboard');
  await expect(page.locator('#schLayBoard')).toHaveText('Board');
  await expect(page.locator('#ui3Code')).toBeVisible();
  const hint = await page.locator('#stageWrap .hint').boundingBox();
  const pill = await page.locator('#ui3status').boundingBox();
  expect(overlaps(hint, pill)).toBe(false);

  await page.locator('#ui3Code').click();
  await dockOpen(page);
  await expect(page.locator('#tab-code')).toBeVisible();
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);
  await page.locator('#ui3rail [data-rail="code"]').click();
  await dockOpen(page);
  await page.locator('#code').click();
  await page.keyboard.press('Control+j');
  await dockClosed(page);
  await page.keyboard.press('Control+j');
  await dockOpen(page);
  await page.locator('[data-collapse="dock"]').click();
  await dockClosed(page);
  await page.evaluate(() => document.body.classList.add('c-dock'));
  await showCommand(page, 'Show Code panel');
  await dockOpen(page);
  await expect(page.locator('#tab-code')).toBeVisible();

  await page.locator('#tabs [data-tab="serial"]').click();
  await expect(page.locator('#tab-serial')).toBeVisible();
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);
  await showCommand(page, 'Show Serial panel');
  await dockOpen(page);
  await expect(page.locator('#tab-serial')).toBeVisible();
  await page.locator('#ui3DockClose').click();
  await showCommand(page, 'Show Scope panel');
  await dockOpen(page);
  await expect(page.locator('#tab-scope')).toBeVisible();
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);

  await expect(page.locator('#palette')).toBeVisible();
  await page.locator('[data-collapse="palette"]').click();
  await expect(page.locator('#palette')).toBeHidden();
  await page.locator('#ui3rail [data-rail="parts"]').click();
  await expect(page.locator('#palette')).toBeVisible();
  await expect(page.locator('#side')).toBeVisible();
  await page.locator('[data-collapse="side"]').click();
  await expect(page.locator('#side')).toBeHidden();
  await page.locator('#ui3rail [data-rail="inspector"]').click();
  await expect(page.locator('#side')).toBeVisible();

  await page.locator('#bView2d').click();
  await page.locator('.pitem[data-type="resistor"]').first().click();
  await expect(page.locator('#ui3ctx')).toBeVisible();
  await page.locator('#stage').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ui3ctx')).toBeHidden();
  const partId = await page.evaluate(() => (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.filter((p) => p.type === 'resistor').slice(-1)[0].id);
  await page.locator(`#stage [data-id="${partId}"]`).click();
  await expect(page.locator('#ui3ctx')).toBeVisible();
  await page.locator('[data-collapse="side"]').click();
  await expect(page.locator('#side')).toBeHidden();
  await page.locator('#ui3ctx [data-act="props"]').click();
  await expect(page.locator('#side')).toBeVisible();

  await page.locator('#ui3rail [data-rail="projects"]').click();
  await expect(page.locator('#projDlg')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#projDlg')).toBeHidden();

  await page.locator('#ui3rail [data-rail="home"]').click();
  await expect(page.locator('#ui3home')).toBeVisible();
  await page.locator('#ui3Back').click();
  await expect(page.locator('#ui3home')).toBeHidden();
  await page.locator('#ui3rail [data-rail="home"]').click();
  await expect(page.locator('#ui3home')).toBeVisible();
  await page.locator('#ui3Back').click();

  await page.evaluate(() => {
    const strip = document.getElementById('compileStrip');
    if (!strip) return;
    strip.hidden = false;
    strip.textContent = 'error: expected unqualified-id';
  });
  await expect(page.locator('#compileStrip')).toBeVisible();
  expect(overlaps(await page.locator('#compileStrip').boundingBox(), await page.locator('#ui3views').boundingBox())).toBe(false);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator('#ui3Code')).toBeVisible();
  await expect(page.locator('#ui3rail')).toBeHidden();
  await page.locator('#ui3Code').click();
  await dockOpen(page);
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);
  await page.locator('#ui3Code').click();
  await dockOpen(page);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('phone: every closed panel can be opened again', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#bView2d')).toHaveText('Breadboard');
  await expect(page.locator('#schLayBoard')).toHaveText('Board');
  await expect(page.locator('#schLayBoard')).not.toHaveText('Breadboard');

  await page.locator('#ui3tabs [data-phone="code"]').click();
  await dockOpen(page);
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);
  await page.evaluate(() => document.body.classList.add('c-dock'));
  await page.locator('#ui3tabs [data-phone="code"]').click();
  await dockOpen(page);
  await page.locator('#tabs [data-tab="serial"]').click();
  await expect(page.locator('#tab-serial')).toBeVisible();
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);
  await page.locator('#ui3tabs [data-phone="code"]').click();
  await dockOpen(page);
  await page.locator('#tabs [data-tab="serial"]').click();
  await expect(page.locator('#tab-serial')).toBeVisible();
  await page.locator('#tabs [data-tab="scope"]').click();
  await expect(page.locator('#tab-scope')).toBeVisible();
  await page.locator('#ui3DockClose').click();
  await dockClosed(page);
  await page.keyboard.press('Control+j');
  await dockOpen(page);
  await page.keyboard.press('Control+j');
  await dockClosed(page);

  await page.locator('#ui3tabs [data-phone="parts"]').click();
  await expect(page.locator('#palette')).toBeVisible();
  await page.locator('#ui3tabs [data-phone="circuit"]').click();
  await expect(page.locator('#palette')).toBeHidden();
  await page.locator('#ui3tabs [data-phone="parts"]').click();
  await expect(page.locator('#palette')).toBeVisible();
  await page.locator('.pitem[data-type="resistor"]').first().click();
  await page.locator('#ui3tabs [data-phone="circuit"]').click();
  await expect(page.locator('#ui3ctx')).toBeVisible();
  await page.locator('#ui3ctx [data-act="props"]').click();
  await expect(page.locator('#side')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#side')).toBeHidden();
  await expect(page.locator('#ui3ctx')).toBeVisible();
  await page.locator('#ui3ctx [data-act="props"]').click();
  await expect(page.locator('#side')).toBeVisible();
  await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; if (active && active.blur) active.blur(); });
  await page.keyboard.press('Escape');
  await expect(page.locator('#ui3ctx')).toBeHidden();
  const partId = await page.evaluate(() => (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.filter((p) => p.type === 'resistor').slice(-1)[0].id);
  await page.locator('#bView2d').click();
  await page.locator(`#lParts [data-id="${partId}"]`).click({ force: true });
  await expect(page.locator('#ui3ctx')).toBeVisible();

  await page.locator('#ui3tabs [data-phone="more"]').click();
  const more = page.locator('#ui3more');
  await expect(more).toBeVisible();
  await expect(more.locator('#ui3moreProj')).toHaveText(/Blink/);
  await more.locator('[data-go="theme"]').click();
  await expect(more).toBeHidden();
  await page.locator('#ui3tabs [data-phone="more"]').click();
  await more.locator('[data-go="home"]').click();
  await expect(more).toBeHidden();
  await expect(page.locator('#ui3home')).toBeVisible();
  await page.locator('#ui3Back').click();
  await expect(page.locator('#ui3home')).toBeHidden();
  await page.locator('#ui3tabs [data-phone="more"]').click();
  await expect(more.locator('#ui3moreProj')).toHaveText(/Blink/);
  await more.locator('[data-go="home"]').click();
  await expect(page.locator('#ui3home')).toBeVisible();
  await page.locator('#ui3Back').click();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('phone More sheet hides 3D when WebGL is missing and still closes', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (String(type).toLowerCase().indexOf('webgl') >= 0) return null;
      return orig.apply(this, [type, ...args] as never);
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#bView3d')).toBeDisabled();
  await page.locator('#ui3tabs [data-phone="more"]').click();
  await expect(page.locator('#ui3more [data-go="3d"]')).toBeHidden();
  await page.locator('#ui3more [data-go="sch"]').click();
  await expect(page.locator('#ui3more')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/viewsch/);
});

type Pick = { x: number; y: number; id: string; kind: string } | null;

async function view3dReady(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const app = (window as unknown as { app?: { view3d?: { ready?: boolean; camera?: object; canvas?: HTMLCanvasElement; _frames?: number } } }).app;
    const v = app && app.view3d;
    const loader = document.getElementById('view3dLoad');
    return !!(v && v.ready && v.camera && v.canvas && loader && loader.hidden && (v._frames || 0) >= 1 && document.body.classList.contains('view3d'));
  }), { timeout: 30_000 }).toBe(true);
}

async function pick3d(page: Page, want: 'part' | 'empty'): Promise<Pick> {
  return page.evaluate((want) => {
    const w = window as unknown as {
      THREE: {
        Vector2: new () => { set: (x: number, y: number) => void };
        Vector3: new () => { project: (cam: object) => { x: number; y: number; z: number } };
        Box3: new () => { setFromObject: (m: object) => { getCenter: (v: { project: (cam: object) => { x: number; y: number; z: number } }) => { project: (cam: object) => { x: number; y: number; z: number } } } };
        Raycaster: new () => { setFromCamera: (m: object, c: object) => void; intersectObjects: (o: object[], deep: boolean) => { object: { parent?: object; userData?: { wid?: string } } }[] };
      };
      app: { view3d: { canvas: HTMLCanvasElement; camera: object; parts: Map<string, { mesh: { traverse: (fn: (c: object) => void) => void }; part: { type: string; id: string } }>; wires: Map<string, { group: object }> } };
    };
    const v = w.app.view3d;
    const rect = v.canvas.getBoundingClientRect();
    const ray = new w.THREE.Raycaster();
    const classify = (x: number, y: number) => {
      if (document.elementFromPoint(x, y) !== v.canvas) return { kind: 'chrome', id: '' };
      const mouse = new w.THREE.Vector2();
      mouse.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(mouse, v.camera);
      const wires = [...v.wires.values()].map((q) => q.group);
      for (const h of ray.intersectObjects(wires, true)) {
        let o: { parent?: object; userData?: { wid?: string } } | null = h.object;
        while (o && !(o.userData && o.userData.wid)) o = (o.parent as typeof o) || null;
        if (o && o.userData && o.userData.wid) return { kind: 'wire', id: o.userData.wid };
      }
      const parts = [...v.parts.values()];
      const hits = ray.intersectObjects(parts.map((p) => p.mesh), true);
      if (hits[0]) {
        for (const rec of parts) {
          let found = false;
          rec.mesh.traverse((c) => { if (c === hits[0].object) found = true; });
          if (!found) continue;
          return rec.part.type === 'breadboard' ? { kind: 'board', id: rec.part.id } : { kind: 'part', id: rec.part.id };
        }
      }
      return { kind: 'empty', id: '' };
    };
    if (want === 'part') {
      for (const [id, rec] of v.parts) {
        if (rec.part.type === 'breadboard') continue;
        const center = new w.THREE.Box3().setFromObject(rec.mesh).getCenter(new w.THREE.Vector3());
        const p = center.project(v.camera);
        if (p.z > 1) continue;
        const x = rect.left + (p.x * 0.5 + 0.5) * rect.width;
        const y = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
        const hit = classify(x, y);
        if (hit.kind === 'part' && hit.id === id) return { x, y, id, kind: 'part' };
      }
      return null;
    }
    let board: { x: number; y: number; id: string; kind: string } | null = null;
    for (let i = 1; i <= 10; i++) {
      for (let j = 1; j <= 8; j++) {
        const x = rect.left + (i / 11) * rect.width;
        const y = rect.top + (j / 9) * rect.height;
        const hit = classify(x, y);
        if (hit.kind === 'empty') return { x, y, id: '', kind: 'empty' };
        if (hit.kind === 'board' && !board) board = { x, y, id: hit.id, kind: 'board' };
      }
    }
    return board;
  }, want);
}

async function selection(page: Page) {
  return page.evaluate(() => {
    const app = (window as unknown as { app?: { editor?: { sel?: { part?: string; wire?: string } | null } } }).app;
    const sel = app && app.editor && app.editor.sel;
    return sel ? (sel.part || sel.wire || '') : '';
  });
}

test('3D empty click, Escape, and delete clear the Studio Dark selection', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ui=3&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#ui3home')).toBeHidden();
  const peek = page.locator('#ui3Peek');
  await expect(peek).toBeVisible();
  await inside(page, peek);
  expect(await peek.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');

  await page.locator('#bView3d').click();
  await view3dReady(page);
  expect(await selection(page)).toBe('');
  await expect(page.locator('#ui3ctx')).toBeHidden();

  const part = await pick3d(page, 'part');
  expect(part, 'a 3D part should be clickable').toBeTruthy();
  await page.mouse.click(part!.x, part!.y);
  await expect.poll(() => selection(page)).toBe(part!.id);
  await expect(page.locator('#ui3ctx')).toBeVisible();
  await expect(page.locator('#insp')).toContainText(part!.id);

  const orbit = await pick3d(page, 'empty');
  expect(orbit, 'the 3D view should have empty space').toBeTruthy();
  await page.mouse.move(orbit!.x, orbit!.y);
  await page.mouse.down();
  await page.mouse.move(orbit!.x + 90, orbit!.y + 36, { steps: 8 });
  await page.mouse.up();
  expect(await selection(page)).toBe(part!.id);
  await expect(page.locator('#ui3ctx')).toBeVisible();

  const empty = await pick3d(page, 'empty');
  expect(empty).toBeTruthy();
  await page.mouse.click(empty!.x, empty!.y);
  await expect.poll(() => selection(page)).toBe('');
  await expect(page.locator('#ui3ctx')).toBeHidden();
  await expect(page.locator('#insp')).toContainText('Select a part or wire');

  const again = await pick3d(page, 'part');
  expect(again).toBeTruthy();
  await page.mouse.click(again!.x, again!.y);
  await expect.poll(() => selection(page)).toBe(again!.id);
  await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; if (a && a.blur) a.blur(); });
  await page.keyboard.press('Escape');
  await expect.poll(() => selection(page)).toBe('');
  await expect(page.locator('#ui3ctx')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/view3d/);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/view3d/);

  await page.locator('#bView3d').click();
  await view3dReady(page);
  expect(await selection(page)).toBe('');
  const doomed = await pick3d(page, 'part');
  expect(doomed).toBeTruthy();
  await page.mouse.click(doomed!.x, doomed!.y);
  await expect.poll(() => selection(page)).toBe(doomed!.id);
  await page.locator('#ui3ctx [data-act="del"]').click();
  await expect.poll(() => selection(page)).toBe('');
  await expect(page.locator('#ui3ctx')).toBeHidden();
  expect(await page.evaluate((id) => (window as unknown as { app: { proj: { parts: { id: string }[] } } }).app.proj.parts.some((p) => p.id === id), doomed!.id)).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('classic 3D keeps its selection on an empty click and on Escape', async ({ page }) => {
  const errors = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ex=blink&resume=0');
  await expect(page.locator('html')).not.toHaveAttribute('data-ui', '3');
  await page.locator('#bView3d').click();
  await view3dReady(page);
  expect(await selection(page)).toBe('');
  const part = await pick3d(page, 'part');
  expect(part, 'a classic 3D part should be clickable').toBeTruthy();
  await page.mouse.click(part!.x, part!.y);
  await expect.poll(() => selection(page)).toBe(part!.id);
  const empty = await pick3d(page, 'empty');
  expect(empty).toBeTruthy();
  await page.mouse.click(empty!.x, empty!.y);
  expect(await selection(page)).toBe(part!.id);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/view3d/);
  expect(await selection(page)).toBe(part!.id);
  expect(errors, errors.join('\n')).toEqual([]);
});
