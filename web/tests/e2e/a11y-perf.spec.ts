// Specific a11y and lazy-3D checks. axe is not vendored in this repo.
// The page flags default off; these tests turn on only the ones they name.
// /api is mocked. Nothing here calls githack or the live site.
import { test, expect, type Page } from '@playwright/test';

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/health')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\//, (ws) => { ws.onMessage(() => {}); });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/favicon/i.test(text)) return;
    errors.push(text);
  });
  return errors;
}

async function contrastOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    function parse(c: string) {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    function lin(v: number) {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    }
    function L(rgb: number[]) {
      return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    }
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { ok: false, why: 'missing ' + sel, ratio: 0 };
    const fg = parse(getComputedStyle(el).color);
    let node: HTMLElement | null = el;
    let bg: number[] | null = null;
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor);
      const alpha = getComputedStyle(node).backgroundColor;
      if (c && !/rgba\(\d+, \d+, \d+, 0\)/.test(alpha)) { bg = c; break; }
      node = node.parentElement;
    }
    if (!fg || !bg) return { ok: false, why: 'color', ratio: 0 };
    const ratio = (Math.max(L(fg), L(bg)) + 0.05) / (Math.min(L(fg), L(bg)) + 0.05);
    return { ok: ratio >= 4.5, ratio, fg: fg.join(','), bg: bg.join(',') };
  }, selector);
}

test('the shipped page allows zoom, has one h1, and does not prefetch 3D', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page);
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  await page.goto('/?ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await page.waitForTimeout(1500);
  const vp = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(vp || '').not.toMatch(/maximum-scale\s*=/);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('ESP32 Circuit Lab');
  await expect(page.locator('#code')).toHaveAttribute('aria-label', 'Sketch code');
  await expect(page.locator('#palette')).toHaveAttribute('aria-label', 'Parts');
  await expect(page.locator('#palList .pitem').first()).toBeAttached();
  expect(urls.some((u) => u.includes('three.min.js') || u.includes('view3d.js'))).toBe(false);
});

test('lazy3d=0 restores the 3D prefetch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page);
  const three = page.waitForRequest((req) => req.url().includes('three.min.js'), { timeout: 20000 });
  await page.goto('/?lazy3d=0&ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await three;
});

test('lazy 3D is not requested until the view is opened, then a failure can be retried', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page);
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  await page.goto('/?lazy3d=1&ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await page.waitForTimeout(2000);
  expect(urls.some((u) => u.includes('three.min.js') || u.includes('view3d.js'))).toBe(false);
  await page.route('**/three.min.js*', async (route) => {
    await new Promise((r) => setTimeout(r, 250));
    await route.abort();
  });
  await page.click('#bView3d');
  await expect(page.locator('#view3dLoad.is-skel')).toBeVisible();
  await expect(page.locator('.view3d-retry-msg')).toHaveText('Could not load the 3D view. Retry.');
  await expect(page.locator('.view3d-retry')).toBeVisible();
  expect(urls.some((u) => u.includes('three.min.js'))).toBe(true);
});

test('Blink is loaded before the palette when idlepal is on', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page);
  await page.goto('/?idlepal=1&ex=blink');
  await expect(page.locator('#projTitle')).toContainText('Blink');
  await expect(page.locator('#bRun')).toBeEnabled();
  await expect(page.locator('#stText')).toHaveText('Idle');
});

for (const vp of [
  { width: 390, height: 844, phone: true },
  { width: 1280, height: 800, phone: false },
] as const) {
  test(`a11y rules at ${vp.width}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await install(page);
    const errors = watchErrors(page);
    await page.goto(`/?a11y=1&lazy3d=1&idlepal=1&batchlayout=1&ex=blink`);
    await expect(page.locator('#stText')).toHaveText('Idle');
    await expect(page.locator('#selExample option')).not.toHaveCount(0);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText('ESP32 Circuit Lab');
    const vpMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(vpMeta || '').not.toMatch(/maximum-scale\s*=/);
    await expect(page.locator('#code')).toHaveAttribute('aria-label', 'Sketch code');
    const named = await page.evaluate(() => {
      const sel = document.getElementById('selExample') as HTMLSelectElement | null;
      const lab = document.querySelector('label[for="selExample"]');
      const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : '';
      return { aria: sel ? sel.getAttribute('aria-label') : '', title: sel ? sel.getAttribute('title') : '', label: lab ? lab.textContent : '', opt };
    });
    expect(named.opt.length).toBeGreaterThan(0);
    expect(named.aria).toBe(named.opt);
    expect(named.label).toBe(named.opt);
    expect(named.aria).not.toBe(named.title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
    await expect(page.locator('#palette')).toHaveAttribute('aria-label', 'Parts');
    await expect(page.locator('#side')).toHaveAttribute('aria-label', 'Inspector');
    await expect(page.locator('#palList')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#palList')).toHaveAttribute('role', 'region');
    await expect(page.locator('.pcat').first()).toBeAttached({ timeout: 20000 });
    for (const sel of ['#palette .panel-h', '.pcat', '#tabs button[data-tab="serial"]', 'label.fld']) {
      const row = await contrastOf(page, sel);
      expect(row.ok, sel + ' ' + JSON.stringify(row)).toBe(true);
    }
    await page.evaluate(() => (window as unknown as { app: { cmd: { toast: (m: string) => void } } }).app.cmd.toast('Saved'));
    const toast = page.locator('.toast').last();
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toHaveAttribute('aria-live', 'polite');
    if (vp.phone) {
      await expect(page.locator('body')).toHaveClass(/m/);
      const bodyPx = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
      expect(bodyPx).toBeGreaterThanOrEqual(14);
      for (const sel of ['.pcat', '.hint', '#mTicker', '#status']) {
        const px = await page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLElement | null;
          return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
        }, sel);
        expect(px, sel).toBeGreaterThanOrEqual(12);
      }
      await expect(page.locator('#mHub')).toBeVisible();
      const hub = await page.evaluate(() => {
        const el = document.getElementById('mHub');
        const name = el ? (el.getAttribute('aria-label') || '') : '';
        const text = el ? (el.textContent || '') : '';
        return { name, text };
      });
      expect(hub.text.toUpperCase()).toContain('CIRCUIT');
      expect(hub.name.toUpperCase()).toContain('CIRCUIT');
      await expect(page.locator('#mTicker')).toHaveAttribute('role', 'status');
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
