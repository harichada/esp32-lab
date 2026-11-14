import { test, expect, type Page } from '@playwright/test';

const LINE = "Can't reach the build server right now. Your work is safe; Run will work again when it's back.";
const SLOT = 'Timed out waiting for a build slot after 120 s — try again shortly';

async function install(page: Page, opts: { strip?: boolean; health?: 'ok' | 'down' | 'bad' } = {}) {
  const strip = !!opts.strip;
  let health = opts.health || 'ok';
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    if (path === '/' || path.endsWith('/index.html')) {
      const res = await route.fetch();
      let body = await res.text();
      if (strip && !body.includes('name="statusstrip"')) {
        body = body.replace('<head>', '<head>\n<meta name="statusstrip" content="1">');
      }
      await route.fulfill({ response: res, body });
      return;
    }
    if (path.includes('/api/health')) {
      if (health === 'down') { await route.abort(); return; }
      const ok = health === 'ok';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok }) });
      return;
    }
    if (path.includes('/api/compile/progress')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' });
      return;
    }
    if (path.includes('/api/compile')) {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '3' },
        body: JSON.stringify({ ok: false, reason: 'timeout', log: SLOT }),
      });
      return;
    }
    if (path.includes('/api/')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
  return {
    setHealth(next: 'ok' | 'down' | 'bad') { health = next; },
  };
}

async function openLab(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/?ex=blink&resume=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { app?: { proj?: unknown } }).app?.proj);
}

test.describe('status strip off keeps today', () => {
  test('a queue timeout still uses the status chip and a toast', async ({ page }) => {
    await install(page, { strip: false, health: 'ok' });
    await openLab(page, 1280);
    await page.locator('#bRun').click();
    await expect(page.locator('#stText')).toHaveText(SLOT);
    await expect(page.locator('.toast').last()).toContainText('build slot');
    await expect(page.locator('#statusStrip')).toHaveCount(0);
    await expect(page.locator('#compileStrip')).not.toHaveClass(/timeout-card/);
    await expect(page.locator('#serial')).toContainText('build slot');
  });
});

test.describe('compile timeout copy', () => {
  test('an unchanged example omits It is saved, and the sentence is only on the card', async ({ page }) => {
    await install(page, { strip: true, health: 'ok' });
    await openLab(page, 390);
    await page.locator('#mIgnite').click();
    const card = page.locator('#compileStrip.timeout-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveText(SLOT);
    await expect(card).not.toContainText("It's saved.");
    await expect(card).toHaveAttribute('role', 'status');
    await expect(page.locator('#mCompileToast')).toBeHidden();
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page.locator('#mTickT')).not.toContainText("It's saved");
    await expect(page.locator('#mTickT')).not.toContainText('build slot');
    await expect(page.locator('#serial')).not.toContainText('build slot');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(wide).toBe(false);
    await expect(page.locator('#mMore')).toBeHidden();
  });

  test('a saved copy says It is saved once, and the chip and toast stay clear of the editor', async ({ page }) => {
    await install(page, { strip: true, health: 'ok' });
    await openLab(page, 1280);
    await page.evaluate(() => {
      const app = (window as unknown as { app: { readOnly: boolean; proj: { example?: string; id: string; name: string }; store: { save: (p: unknown) => void } } }).app;
      app.readOnly = false;
      delete app.proj.example;
      app.proj.id = 'pcopy';
      app.proj.name = 'Blink copy';
      app.store.save(app.proj);
    });
    await page.locator('#bRun').click();
    const card = page.locator('#compileStrip.timeout-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveText(SLOT + ". It's saved.");
    const fit = await page.locator('#stText').evaluate((el) => ({
      text: el.textContent || '',
      clipped: el.scrollWidth > el.clientWidth + 1,
    }));
    expect(fit.text).not.toContain("It's saved");
    expect(fit.text).not.toContain('build slot');
    expect(fit.clipped).toBe(false);
    await expect(page.locator('.toast')).toHaveCount(0);
    const overlap = await page.evaluate(() => {
      const card = document.getElementById('compileStrip')!.getBoundingClientRect();
      const editor = document.getElementById('codeWrap')!.getBoundingClientRect();
      return !(card.bottom <= editor.top || card.top >= editor.bottom);
    });
    expect(overlap).toBe(false);
    const shown = await card.evaluate((el) => getComputedStyle(el).textOverflow);
    expect(shown).not.toBe('ellipsis');
  });
});

test.describe('build server line', () => {
  for (const width of [390, 1280]) {
    test(`a stopped backend explains Run at ${width} before anyone opens a menu`, async ({ page }) => {
      await install(page, { strip: true, health: 'down' });
      await openLab(page, width);
      const strip = page.locator('#statusStrip');
      await expect(strip).toBeVisible();
      await expect(strip).toHaveText(LINE);
      await expect(strip).toHaveAttribute('role', 'status');
      const run = page.locator(width < 700 ? '#mIgnite' : '#bRun');
      await expect(run).toBeVisible();
      const beside = await page.evaluate((phone) => {
        const strip = document.getElementById('statusStrip')!.getBoundingClientRect();
        const run = document.querySelector(phone ? '#mIgnite' : '#bRun')!.getBoundingClientRect();
        const menu = document.body.dataset.msheet || '';
        const scroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        const dot = document.getElementById('connDot');
        const dotShown = !!(dot && getComputedStyle(dot).display !== 'none' && dot.getBoundingClientRect().width > 0);
        return {
          menu,
          scroll,
          dotShown,
          runClear: phone ? strip.right <= run.left + 1 : strip.top >= run.top,
          text: (document.getElementById('statusStrip')!.textContent || ''),
        };
      }, width < 700);
      expect(beside.menu).toBe('');
      expect(beside.scroll).toBe(false);
      expect(beside.text).toBe(LINE);
      expect(beside.runClear).toBe(true);
      if (width < 700) expect(beside.dotShown).toBe(false);
      const before = await strip.getAttribute('data-said');
      await run.click();
      await expect(strip).toHaveText(LINE);
      await expect.poll(async () => strip.getAttribute('data-said')).not.toBe(before);
      await expect(page.locator('.toast')).toHaveCount(0);
      await expect(page.locator('#serial')).not.toContainText("Can't reach the simulator");
    });
  }

  test('a degraded backend uses the same line and a recovery removes it', async ({ page }) => {
    const gate = await install(page, { strip: true, health: 'bad' });
    await openLab(page, 1280);
    await expect(page.locator('#statusStrip')).toHaveText(LINE);
    gate.setHealth('ok');
    await expect(page.locator('#statusStrip')).toHaveCount(0);
  });

  test('a healthy phone does not grow a status dot', async ({ page }) => {
    await install(page, { strip: true, health: 'ok' });
    await openLab(page, 390);
    await page.waitForTimeout(400);
    await expect(page.locator('#statusStrip')).toHaveCount(0);
    const dot = await page.evaluate(() => {
      const el = document.getElementById('connDot');
      if (!el) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && el.getBoundingClientRect().width > 0;
    });
    expect(dot).toBe(false);
  });
});
