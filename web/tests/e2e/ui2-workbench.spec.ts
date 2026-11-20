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
type Part = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
type Project = { id: string; code: string; parts: Part[]; wires: unknown[]; defines: string[] };
type WorkbenchWindow = Window & {
  app: {
    proj: Project; run: { kind: string } | null;
    ensureParts(): Promise<void>;
    store: { get(id: string): Project; save(project: Project): boolean };
    cmd: { save(): boolean };
    editor: {
      addPart(type: string, x: number, y: number): void;
      renderWires(): void; hooks: { changed(topo: boolean): void };
      select(selection: { part: string }): void; svg: SVGSVGElement;
      view: { x: number; y: number; s: number };
    };
  };
  Parts: {
    T: Record<string, { pins(part: Part): { name: string }[] }>;
    pinWorld(part: Part, pin: { name: string }): { x: number; y: number };
  };
  savedStoreSave?: (project: Project) => boolean;
};

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
  await page.screenshot({ path: test.info().outputPath(name) });
}

async function wireGuide(page: Page, bypass: boolean, reversed = false) {
  await page.evaluate(({ bypass, reversed }) => {
    const root = window as WorkbenchWindow, editor = root.app.editor;
    if (!root.app.proj.parts.some(p => p.type === 'led')) editor.addPart('led', 400, 200);
    if (!root.app.proj.parts.some(p => p.type === 'resistor')) editor.addPart('resistor', 300, 200);
    const parts = root.app.proj.parts;
    const esp = parts.find(p => p.type === 'esp32')!;
    const led = parts.find(p => p.type === 'led')!;
    const resistor = parts.find(p => p.type === 'resistor')!;
    const pin = (part: Part, name: string) => root.Parts.pinWorld(part, root.Parts.T[part.type].pins(part).find(p => p.name === name)!);
    const wire = (id: string, a: { x: number; y: number }, b: { x: number; y: number }) => ({ id, a, b, pts: [], color: 'green' });
    const input = reversed ? '2' : '1', output = reversed ? '1' : '2';
    root.app.proj.wires = [
      wire('drive', pin(esp, 'D2'), pin(resistor, input)),
      wire('led', pin(resistor, bypass ? input : output), pin(led, 'A')),
      wire('ground', pin(led, 'C'), pin(esp, 'GND.1')),
    ];
    editor.renderWires();
    editor.hooks.changed(true);
  }, { bypass, reversed });
}

test('guide rejects a bypassed resistor and waits for real blinking on every run', async ({ page }) => {
  await install(page);
  await page.goto('/?ui=2&resume=0');
  await ready(page);
  await page.getByRole('button', { name: 'Start guided Blink', exact: true }).click();
  await expect(page.locator('#ui2Start')).toBeHidden();
  await wireGuide(page, true);
  await expect(page.locator('#ui2CoachNow')).toContainText('Step 3 of 5');
  await wireGuide(page, false);
  await expect(page.locator('#ui2CoachNow')).toContainText('Step 4 of 5');
  await page.evaluate(() => {
    const root = window as WorkbenchWindow;
    root.app.proj.wires.pop();
    root.app.editor.hooks.changed(true);
  });
  await expect(page.locator('#ui2CoachNow')).toContainText('Step 3 of 5');
  await wireGuide(page, false, true);
  await expect(page.locator('#ui2CoachNow')).toContainText('Step 4 of 5');
  await page.locator('#ui2CoachCodeOpen').click();
  await page.locator('#ui2CoachCodeNext').click();
  await page.locator('#ui2Run').click();
  await expect(page.locator('body')).toHaveClass(/running/);
  await page.waitForTimeout(500);
  await expect(page.locator('#ui2CoachNow')).toContainText('Waiting for the LED');
  await page.locator('#ui2Run').click();

  await page.locator('#selMode').selectOption('js');
  await page.locator('#code').fill('function setup(){pinMode(2,OUTPUT)}\nfunction loop(){digitalWrite(2,HIGH);delay(200);digitalWrite(2,LOW);delay(200)}');
  await page.locator('#ui2Run').click();
  await expect(page.locator('#ui2CoachNow')).toHaveText('Blink is working. The LED has turned on and off.');
  await shot(page, 'guided-blink-working-desktop.png');
  await page.locator('#ui2Run').click();
  await page.locator('#code').fill('function setup(){pinMode(2,OUTPUT);digitalWrite(2,HIGH)}\nfunction loop(){delay(200)}');
  await page.locator('#ui2Run').click();
  await page.waitForTimeout(600);
  await expect(page.locator('#ui2CoachNow')).toContainText('Waiting for the LED');
  await page.locator('#ui2Run').click();
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 640 }]) {
  test(`guided code walkthrough teaches the starter without replacing edits at ${viewport.width}px`, async ({ page }) => {
    const errors = await install(page);
    await page.setViewportSize(viewport);
    await page.goto('/?ui=2&resume=0');
    await ready(page);
    await page.getByRole('button', { name: 'Start guided Blink', exact: true }).click();
    await expect(page.locator('#ui2Start')).toBeHidden();
    const id = await page.evaluate(() => (window as WorkbenchWindow).app.proj.id);
    const starter = await page.locator('#code').inputValue();
    await wireGuide(page, false);
    await expect(page.locator('#ui2CoachNow')).toContainText('Open code');
    await page.locator('#ui2CoachCodeOpen').click();
    const lesson = page.locator('#ui2CoachCode');
    await expect(lesson).toBeVisible();
    await expect(page.locator('#codeWrap')).toBeVisible();
    await expect(lesson).toContainText('GPIO 2 (D2)');
    await expect(lesson).toContainText('general-purpose input/output');
    await expect(lesson).toContainText('setup() runs once');
    await expect(lesson.locator('pre').first()).toContainText('pinMode(LED_BUILTIN, OUTPUT);');
    await expect(lesson).toContainText('OUTPUT lets the GPIO drive an electrical signal');
    await expect(lesson).toContainText('INPUT is for reading a signal');
    await expect(lesson).toContainText('loop() repeats');
    await expect(lesson.locator('pre').last()).toContainText('digitalWrite(LED_BUILTIN, HIGH);');
    await expect(lesson.locator('pre').last()).toContainText('digitalWrite(LED_BUILTIN, LOW);');
    await expect(lesson).toContainText('delay(1000) waits 1000 milliseconds');
    await expect(page.locator('#code')).toHaveValue(starter);
    await lesson.locator('li').nth(1).scrollIntoViewIfNeeded();
    await shot(page, `guided-gpio-initialization-${viewport.width}.png`);
    if (viewport.width < 820) {
      expect(await lesson.locator('pre').evaluateAll(blocks => blocks.every(block => block.scrollWidth <= block.clientWidth))).toBe(true);
      await lesson.locator('li').last().scrollIntoViewIfNeeded();
      await expect(lesson.locator('li').last()).toBeInViewport({ ratio: 1 });
      await page.locator('#ui2CoachCodeNext').scrollIntoViewIfNeeded();
      const clear = await page.locator('#ui2CoachCodeNext').evaluate(button => {
        const r = button.getBoundingClientRect(), panel = document.getElementById('tab-code')!.getBoundingClientRect();
        return r.top >= panel.top && r.bottom <= panel.bottom;
      });
      expect(clear).toBe(true);
    }
    await axe(page);
    await shot(page, `guided-blink-code-${viewport.width}.png`);
    await page.locator('#ui2CoachCodeNext').click();
    await expect(lesson).toBeHidden();
    await expect(page.locator('#ui2CoachNow')).toContainText('Step 5 of 5');
    await expect(page.locator(viewport.width < 820 ? '#ui2CodeRun' : '#ui2Run')).toBeFocused();
    const edited = starter.replace(/delay\(1000\)/g, 'delay(500)');
    await page.locator('#code').fill(edited);
    if (viewport.width < 820) await page.locator('#dock .m-x').click();
    await page.getByRole('button', { name: 'Review code', exact: true }).click();
    await expect(lesson).toBeVisible();
    await expect(page.locator('#code')).toHaveValue(edited);
    expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.id)).toBe(id);
    if (viewport.width >= 820) {
      await page.locator('#ui2More').click();
      await page.getByRole('menuitem', { name: 'Getting started', exact: true }).click();
      await page.getByRole('button', { name: 'New blank ESP32', exact: true }).click();
      await expect(page.locator('#ui2Start')).toBeHidden();
      expect(await page.evaluate(id => (window as WorkbenchWindow).app.store.get(id).code, id)).toBe(edited);
    } else {
      await page.getByRole('button', { name: 'Dismiss guide', exact: true }).click();
      await expect(page.locator('#ui2CodeRun')).toBeFocused();
    }
    await expect(lesson).toBeHidden();
    await expect(page.locator('#ui2Coach')).toBeHidden();
    expect(errors.filter(e => !/favicon/i.test(e))).toEqual([]);
  });
}

test('Getting started preserves pending edits and refuses replacement when saving fails', async ({ page }) => {
  await install(page);
  await page.goto('/?ui=2&resume=0');
  await ready(page);
  await expect(page.locator('#ui2Start .ui2-choice').first()).toHaveText('Start guided Blink');
  await expect(page.getByRole('button', { name: 'Start guided Blink', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#ui2Start [data-go="close"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start guided Blink', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'New blank ESP32', exact: true }).click();
  await expect(page.locator('#ui2Start')).toBeHidden();
  const id = await page.evaluate(() => (window as WorkbenchWindow).app.proj.id);
  await page.evaluate(() => {
    const root = window as WorkbenchWindow;
    root.savedStoreSave = root.app.store.save;
    root.app.store.save = () => false;
  });
  await page.locator('#code').fill('// keep these pending edits');
  await page.locator('#ui2More').click();
  await page.getByRole('menuitem', { name: 'Getting started', exact: true }).click();
  expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.id)).toBe(id);
  await page.getByRole('button', { name: 'Start guided Blink', exact: true }).click();
  await expect(page.locator('#ui2Start')).toBeVisible();
  expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.id)).toBe(id);
  expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.code)).toBe('// keep these pending edits');
  await page.evaluate(() => {
    const root = window as WorkbenchWindow;
    root.app.store.save = root.savedStoreSave!;
    root.app.cmd.save();
  });
  await page.getByRole('button', { name: 'Start guided Blink', exact: true }).click();
  await expect(page.locator('#ui2Start')).toBeHidden();
  expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.id)).not.toBe(id);
  expect(await page.evaluate(id => (window as WorkbenchWindow).app.store.get(id).code, id)).toBe('// keep these pending edits');
});

test('radio arrows and focused controls never edit the selected circuit', async ({ page }) => {
  await install(page);
  await page.goto('/?ui=2&ex=blink&resume=0');
  await ready(page);
  await page.locator('#bCopy').click();
  const before = await page.evaluate(() => {
    const root = window as WorkbenchWindow;
    const esp = root.app.proj.parts.find(p => p.type === 'esp32')!;
    root.app.editor.select({ part: esp.id });
    return { id: esp.id, x: esp.x, y: esp.y, count: root.app.proj.parts.length };
  });
  await page.locator('#ui2SideTabs [data-side="parts"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#ui2SideTabs [data-side="props"]')).toBeFocused();
  await expect(page.locator('#ui2SideTabs [data-side="props"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Delete');
  const after = await page.evaluate(id => {
    const root = window as WorkbenchWindow, p = root.app.proj.parts.find(p => p.id === id)!;
    return { x: p.x, y: p.y, count: root.app.proj.parts.length };
  }, before.id);
  expect(after).toEqual({ x: before.x, y: before.y, count: before.count });
  await page.evaluate(() => (window as WorkbenchWindow).app.editor.svg.focus());
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(id => (window as WorkbenchWindow).app.proj.parts.find(p => p.id === id)!.x, before.id)).toBe(before.x + 10);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.parts.length)).toBe(before.count + 1);
});

test('execution labels explain the language and Advanced retains compiler definitions', async ({ page }) => {
  await install(page);
  await page.goto('/?ui=2&ex=blink&resume=0');
  await ready(page);
  await expect(page.locator('#executionHint')).toContainText('compiled on the server');
  await expect(page.locator('#inDefines')).toBeHidden();
  await page.locator('#codeAdvanced summary').click();
  await page.locator('#inDefines').fill('SIM, GUIDE_CHECK');
  await page.locator('#code').click();
  await page.evaluate(() => (window as WorkbenchWindow).app.cmd.save());
  expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.defines)).toEqual(['SIM', 'GUIDE_CHECK']);
  await page.locator('#selMode').selectOption('js');
  await expect(page.locator('#executionHint')).toContainText('JavaScript runs in this browser');
  await page.locator('#selMode').selectOption('circuit');
  await expect(page.locator('#executionHint')).toContainText('code is not executed');
  await expect(page.getByRole('textbox', { name: 'Search parts', exact: true })).toBeVisible();
});

test('first-run card, Blink in 15 clicks, copy and the lock bar', async ({ page }) => {
  const errors = await install(page, { guest: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ui=2&resume=0');
  await ready(page);
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.load('16px Inter');
    await document.fonts.load('12px "JetBrains Mono"');
    return document.fonts.check('16px Inter') && document.fonts.check('12px "JetBrains Mono"');
  })).toBe(true);
  await expect(page.locator('#ui2Start')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app: { proj: unknown } }).app.proj)).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ui2Start')).toBeHidden();
  await page.evaluate(() => { const s = document.getElementById('ui2Start'); if (s) s.hidden = false; });
  await expect(page.locator('#ui2Start')).toBeVisible();
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
  await page.locator('#ui2CoachCodeOpen').click();
  await page.locator('#ui2CoachCodeNext').click();
  await page.locator('#ui2Run').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app?: { compilePhase?: string } }).app?.compilePhase)).toBe('running');
  const clicks = await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
  expect(clicks).toBeLessThanOrEqual(15);
  fs.mkdirSync(test.info().outputDir, { recursive: true });
  fs.writeFileSync(test.info().outputPath('ui2-blink-clicks.json'), JSON.stringify({ clicks, target: 15 }) + '\n');

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
  await page.evaluate(() => (window as WorkbenchWindow).app.ensureParts());
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
  await page.locator('#ui2Examples').click();
  await expect(page.locator('#ui2ExGrid button').first()).toBeVisible();
  await expect(page.locator('#ui2Ex .ui2-ex-title').first()).toBeVisible();
  await shot(page, 'ui2-after-examples.png');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ui2Ex')).toBeHidden();
  await page.locator('#ui2PalTools [data-set="all"]').click();
  await expect(page.locator('#ui2Chips button', { hasText: 'Semiconductors' })).toBeVisible();
  await shot(page, 'ui2-after-chips.png');
  await page.locator('#side').evaluate((el) => { el.style.visibility = 'visible'; });
  await page.evaluate(() => {
    const ed = (window as unknown as { app: { editor: { select: (s: { part: string }) => void; part: (id: string) => unknown }; proj: { parts: { id: string; type: string }[] } } }).app;
    const esp = ed.proj.parts.find((p) => p.type === 'esp32');
    if (esp) ed.editor.select({ part: esp.id });
    document.body.classList.add('ui2-props');
  });
  await expect(page.locator('#insp table.pins')).toBeVisible();
  await shot(page, 'ui2-after-props.png');
  await page.locator('#ui2top [data-view="schematic"]').click();
  await expect(page.locator('.toast')).toBeVisible();
  await shot(page, 'ui2-after-schematic.png');
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test.describe('phone', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('the guide and Fit stay separate and Help does not replace a circuit', async ({ page }) => {
    await install(page);
    await page.goto('/?ui=2&resume=0');
    await ready(page);
    await page.getByRole('button', { name: 'Start guided Blink', exact: true }).tap();
    await expect(page.locator('#ui2Start')).toBeHidden();
    await expect(page.locator('#ui2CoachNow')).toContainText('Step 1 of 5');
    const id = await page.evaluate(() => (window as WorkbenchWindow).app.proj.id);
    await shot(page, 'mobile-guided-blink.png');
    await page.evaluate(() => {
      const root = window as WorkbenchWindow;
      root.app.editor.addPart('resistor', 300, 650);
      root.app.editor.addPart('led', 300, 800);
    });
    await page.locator('#ui2Fit').tap();
    const clear = await page.evaluate(() => {
      const root = window as WorkbenchWindow;
      const activeIds = new Set(root.app.proj.parts.filter(p => p.type !== 'breadboard').map(p => p.id));
      const blockers = ['ui2Coach', 'ui2Fit'].map(id => document.getElementById(id)!.getBoundingClientRect());
      return [...document.querySelectorAll('#lParts [data-id]')].filter(el => activeIds.has(el.getAttribute('data-id')!)).every(el => {
        const r = el.getBoundingClientRect();
        return blockers.every(b => r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom);
      });
    });
    expect(clear).toBe(true);
    await page.locator('#ui2CoachHide').tap();
    await expect(page.locator('#ui2Coach')).toBeHidden();
    await page.locator('#ui2Phone [data-a="more"]').tap();
    await page.getByRole('menuitem', { name: 'Getting started', exact: true }).tap();
    await expect(page.locator('#ui2Start')).toBeVisible();
    expect(await page.evaluate(() => (window as WorkbenchWindow).app.proj.id)).toBe(id);
    await page.locator('#ui2Start [data-go="close"]').tap();
  });
  test('Run and Stop work with Code open, and Fit survives resize without resetting manual zoom', async ({ page }) => {
    await install(page);
    await page.goto('/?ui=2&ex=blink&resume=0');
    await ready(page);
    await page.locator('#ui2Phone [data-a="code"]').tap();
    await page.locator('#codeAdvanced summary').tap();
    await page.locator('#inDefines').fill('SIM, MOBILE_UI');
    const advancedBox = await page.locator('#inDefines').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
    });
    expect(advancedBox.left).toBeGreaterThanOrEqual(0);
    expect(advancedBox.right).toBeLessThanOrEqual(advancedBox.width);
    expect(advancedBox.bottom).toBeLessThanOrEqual(advancedBox.height);
    await page.locator('#codeAdvanced summary').tap();
    await page.locator('#selMode').selectOption('js');
    await page.locator('#code').fill('function setup(){pinMode(2,OUTPUT)}\nfunction loop(){digitalWrite(2,HIGH);delay(200);digitalWrite(2,LOW);delay(200)}');
    await page.locator('#ui2CodeRun').tap();
    await expect(page.locator('body')).toHaveClass(/running/);
    await shot(page, 'mobile-code-run.png');
    await page.locator('#ui2Phone [data-a="run"]').tap();
    await expect(page.locator('body')).not.toHaveClass(/running/);
    await expect(page.locator('body')).toHaveAttribute('data-msheet', 'dock');
    await expect(page.locator('#ui2CodeRun')).toHaveAccessibleName('Run');
    await page.locator('#dock .m-x').tap();
    await page.locator('#ui2Fit').tap();
    const fits = () => page.evaluate(() => {
      const root = window as WorkbenchWindow;
      const activeIds = new Set(root.app.proj.parts.filter(p => p.type !== 'breadboard').map(p => p.id));
      const stage = document.getElementById('stage')!.getBoundingClientRect();
      const parts = [...document.querySelectorAll('#lParts [data-id]')].filter(el => activeIds.has(el.getAttribute('data-id')!));
      return parts.length >= 3 && parts.every(el => {
        const r = el.getBoundingClientRect();
        return r.left >= stage.left - 2 && r.top >= stage.top - 2 && r.right <= stage.right + 2 && r.bottom <= stage.bottom + 2;
      });
    });
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 390, height: 664 });
    await expect.poll(fits).toBe(true);
    await page.mouse.move(190, 300);
    await page.mouse.wheel(0, -120);
    const manual = await page.evaluate(() => ({ ...(window as WorkbenchWindow).app.editor.view }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as WorkbenchWindow).app.editor.view)).toEqual(manual);
    await page.locator('#ui2Fit').tap();
    await shot(page, 'ui2-usability-phone-code-and-fit.png');
  });
  test('one tap adds one part, and light and dark stay clear', async ({ page }) => {
    const errors = await install(page, { guest: true });
    await page.goto('/?ui=2&ex=blink&resume=0');
    await ready(page);
    await axe(page);
    await expect(page.locator('#ui2Copy')).toBeVisible();
    await expect(page.locator('.projbanner')).toBeHidden();
    const navSize = await page.locator('#ui2Phone button span').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(navSize).toBeGreaterThanOrEqual(12);
    await shot(page, 'ui2-after-phone-dark.png');
    const before = await page.evaluate(() => (window as unknown as { app: { proj: { parts: unknown[] } } }).app.proj.parts.length);
    await page.locator('#ui2Phone [data-a="parts"]').tap();
    await expect(page.locator('#ui2Chips')).toBeVisible();
    await expect(page.locator('.m-chips')).toBeHidden();
    await shot(page, 'ui2-after-phone-parts.png');
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
