import { test, expect, type Page } from '@playwright/test';

interface Project {
  id?: string;
  code: string;
  parts: object[];
  wires: object[];
  files: Record<string, string>;
  defines: string[];
}
interface Lab {
  proj: Project;
  readOnly: boolean;
  importProject: (raw: object) => boolean;
  openCodeFile: (name: string) => void;
  store: { get: (id: string) => Project; current: () => string; list: () => object[] };
  cmd: { save: () => boolean; loadExample: (key: string) => Promise<boolean> };
}
type LabWindow = Window & { app: Lab };

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.fallback() : route.abort();
  });
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"ok":true}',
  }));
  await page.routeWebSocket(/\/api\//, (ws) => { ws.onMessage(() => {}); });
  await page.goto('/?ex=blink&ui=2&resume=0');
  await expect.poll(() => page.evaluate(() => !!(window as LabWindow).app?.cmd)).toBe(true);
  await expect(page.locator('#ui2Save')).toHaveText('Example');
}

for (const width of [390, 1280]) {
  test(`a fast example switch preserves edits without saving the example at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await install(page);
    const result = await page.evaluate(async () => {
      const app = (window as LabWindow).app;
      app.cmd.save();
      const id = app.proj.id!;
      const textarea = document.getElementById('code') as HTMLTextAreaElement;
      textarea.value += '\n// FAST-SWITCH';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const label = document.getElementById('ui2Save')!.textContent;
      await app.cmd.loadExample('blink');
      return { id, label, persisted: app.store.get(id).code, example: app.proj.code };
    });
    expect(result.label).toBe('Not saved');
    expect(result.persisted).toContain('FAST-SWITCH');
    expect(result.example).not.toContain('FAST-SWITCH');
    await expect(page.locator('#ui2Save')).toHaveText('Example');
    await page.clock.install();
    await page.clock.fastForward(1000);
    expect(await page.evaluate(() => {
      const app = (window as LabWindow).app;
      return { count: app.store.list().length, id: app.proj.id, readOnly: app.readOnly };
    })).toEqual({ count: 1, id: undefined, readOnly: true });
    await page.reload();
    expect(await page.evaluate((id) => (window as LabWindow).app.store.get(id).code, result.id)).toContain('FAST-SWITCH');
  });
}

test('failed saving blocks import and a retry retains headers, defines and the active project', async ({ page }) => {
  await install(page);
  const original = await page.evaluate(() => {
    const app = (window as LabWindow).app;
    app.cmd.save();
    const id = app.proj.id!;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'esp32lab.projects.v1') throw new DOMException('Full', 'QuotaExceededError');
      original.call(this, key, value);
    };
    window.addEventListener('test-allow-writes', () => { Storage.prototype.setItem = original; }, { once: true });
    app.proj.files['config.h'] = '';
    app.openCodeFile('config.h');
    const code = document.getElementById('code') as HTMLTextAreaElement;
    code.value = '#define LED 4';
    code.dispatchEvent(new Event('input', { bubbles: true }));
    const defines = document.getElementById('inDefines') as HTMLInputElement;
    defines.value = 'SIM, USER_TEST';
    defines.dispatchEvent(new Event('input', { bubbles: true }));
    const opened = app.importProject({ name: 'Do not import', code: '', parts: [], wires: [] });
    return { id, opened, current: app.store.current(), count: app.store.list().length, url: location.href };
  });
  expect(original.opened).toBe(false);
  expect(original.current).toBe(original.id);
  expect(original.count).toBe(1);
  await expect(page.locator('#storageFull')).toBeVisible();
  await expect(page.locator('#ui2Save')).toHaveText('Not saved');
  expect(page.url()).toBe(original.url);
  const saved = await page.evaluate(() => {
    window.dispatchEvent(new Event('test-allow-writes'));
    const app = (window as LabWindow).app;
    return { ok: app.cmd.save(), project: app.store.get(app.proj.id!) };
  });
  expect(saved.ok).toBe(true);
  expect(saved.project.files['config.h']).toBe('#define LED 4');
  expect(saved.project.defines).toEqual(['SIM', 'USER_TEST']);
  await expect(page.locator('#ui2Save')).toHaveText('Saved locally');
  await page.reload();
  expect(await page.evaluate(() => (window as LabWindow).app.proj.files['config.h'])).toBe('#define LED 4');
});

test('Tab indentation in an example makes and saves a local copy', async ({ page }) => {
  await install(page);
  const code = page.locator('#code');
  await code.focus();
  await code.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await code.press('Tab');
  await expect.poll(() => page.evaluate(() => (window as LabWindow).app.readOnly)).toBe(false);
  await expect.poll(() => page.evaluate(() => {
    const app = (window as LabWindow).app;
    return app.store.get(app.proj.id!).code.startsWith('  ');
  })).toBe(true);
  await expect(page.locator('#ui2Save')).toHaveText('Saved locally');
});
