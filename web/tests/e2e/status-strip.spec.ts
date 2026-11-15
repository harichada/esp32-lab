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
      if (strip && !body.includes('statusstrip.js')) {
        body = body.replace('<script src="js/app.js', '<script src="js/statusstrip.js?v=7"></script>\n<script src="js/app.js');
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
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
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
    const flagged = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /compilehints\.js|statusstrip\.js/.test(name)));
    expect(flagged).toEqual([]);
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
  for (const width of [320, 390, 1280]) {
    test(`a stopped backend explains Run at ${width} before anyone opens a menu`, async ({ page }) => {
      await install(page, { strip: true, health: 'down' });
      await openLab(page, width);
      const strip = page.locator('#statusStrip');
      await expect(strip).toBeVisible();
      await expect(strip).toBeInViewport();
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
      const signal = await page.evaluate(() => {
        function inView(el: Element | null) {
          if (!el) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.top >= -1 && box.left >= -1 && box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1;
        }
        return inView(document.getElementById('statusStrip')) || inView(document.getElementById('connDot')) || inView(document.getElementById('mConn'));
      });
      expect(signal).toBe(true);
      if (width < 700) expect(beside.dotShown).toBe(false);
      expect(await strip.evaluate((el) => el.parentElement && el.parentElement.tagName)).toBe('BODY');
      const geom = await page.evaluate((sentence) => {
        const vpH = window.innerHeight;
        const vpW = window.innerWidth;
        const strip = document.getElementById('statusStrip')!;
        const box = strip.getBoundingClientRect();
        function overlaps(a: DOMRect, b: DOMRect) {
          if (b.width < 1 || b.height < 1) return false;
          if (b.bottom < 0 || b.top > vpH || b.right < 0 || b.left > vpW) return false;
          return !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
        }
        const runEl = document.querySelector(document.body.classList.contains('m') ? '#mIgnite' : '#bRun')!;
        const parts = document.querySelector('#palette .panel-h');
        const insp = document.querySelector('#side .panel-h');
        return {
          inside: box.top >= -1 && box.left >= -1 && box.bottom <= vpH + 1 && box.right <= vpW + 1 && box.width > 0 && box.height > 0,
          complete: (strip.textContent || '') === sentence && strip.scrollHeight <= strip.clientHeight + 2,
          run: overlaps(box, runEl.getBoundingClientRect()),
          title: overlaps(box, document.getElementById('projTitle')!.getBoundingClientRect()),
          parts: parts ? overlaps(box, parts.getBoundingClientRect()) : false,
          insp: insp ? overlaps(box, insp.getBoundingClientRect()) : false,
        };
      }, LINE);
      expect(geom.inside).toBe(true);
      expect(geom.complete).toBe(true);
      expect(geom.run).toBe(false);
      expect(geom.title).toBe(false);
      expect(geom.parts).toBe(false);
      expect(geom.insp).toBe(false);
      const before = await strip.getAttribute('data-said');
      await run.click();
      await expect(page.locator('#stText')).toHaveText('Offline');
      await expect(strip).toHaveText(LINE);
      await expect.poll(async () => strip.getAttribute('data-said')).not.toBe(before);
      await expect(page.locator('.toast')).toHaveCount(0);
      await expect(page.locator('#serial')).not.toContainText("Can't reach the simulator");
    });
  }

  test('a stopped backend shows the line once, holds it, then clears when health returns', async ({ page }) => {
    const times: number[] = [];
    const gate = await install(page, { strip: true, health: 'down' });
    await page.route('**/api/health', async (route) => {
      times.push(Date.now());
      await route.fallback();
    });
    await openLab(page, 1280);
    const strip = page.locator('#statusStrip');
    await expect(strip).toHaveText(LINE);
    const mark = await strip.evaluate((el) => {
      el.setAttribute('data-born', '1');
      let n = 0;
      const obs = new MutationObserver(() => { n++; });
      obs.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
      (window as unknown as { __stripChanges?: () => number }).__stripChanges = () => n;
      return el.getAttribute('data-born');
    });
    await page.waitForTimeout(7000);
    await expect(strip).toHaveText(LINE);
    expect(await strip.getAttribute('data-born')).toBe(mark);
    expect(await page.locator('#statusStrip')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __stripChanges: () => number }).__stripChanges())).toBe(0);
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(4500);
    gate.setHealth('ok');
    await expect(page.locator('#statusStrip')).toHaveCount(0);
  });

  test('a degraded backend uses the same line and a recovery removes it', async ({ page }) => {
    const gate = await install(page, { strip: true, health: 'bad' });
    await openLab(page, 1280);
    await expect(page.locator('#statusStrip')).toHaveText(LINE);
    gate.setHealth('ok');
    await expect(page.locator('#statusStrip')).toHaveCount(0);
  });

  test('a healthy phone keeps the connection dot while the strip is off screen', async ({ page }) => {
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
    expect(dot).toBe(true);
  });
});
