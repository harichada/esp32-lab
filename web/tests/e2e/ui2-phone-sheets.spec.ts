// Phone sheets must stay inside the visual viewport, including short
// screens where the browser toolbar eats part of 100vh.
import fs from 'fs';
import { test, expect, type Page } from '@playwright/test';

const SIZES = [
  { width: 390, height: 664, name: '390x664' },
  { width: 360, height: 640, name: '360x640' },
  { width: 375, height: 667, name: '375x667' },
  { width: 844, height: 390, name: '844x390' },
];

async function install(page: Page) {
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
    await route.fulfill({ response: res, body });
  });
  await page.route('**/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ signed_in: false, providers: { google: true, github: true }, csrf: '', display_name: '' }),
  }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => document.body.dataset.ui2 === '1' && document.body.classList.contains('m'))).toBe(true);
}

function boxOf(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const oy = vv ? vv.offsetTop : 0;
  const ox = vv ? vv.offsetLeft : 0;
  const vh = vv ? vv.height : window.innerHeight;
  const vw = vv ? vv.width : window.innerWidth;
  const top = r.top - oy;
  const left = r.left - ox;
  const bottom = r.bottom - oy;
  const right = r.right - ox;
  return {
    top, left, bottom, right, vh, vw,
    width: r.width, height: r.height,
    inside: top >= -1 && left >= -1 && bottom <= vh + 1 && right <= vw + 1 && r.width > 2 && r.height > 2,
  };
}

async function expectInside(page: Page, selector: string) {
  await expect.poll(() => page.evaluate(boxOf, selector)).toMatchObject({ inside: true });
}

test.describe('phone sheets stay in the visual viewport', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    test(size.name, async ({ page }) => {
      await install(page);
      await page.setViewportSize({ width: size.width, height: size.height });
      const client = await page.context().newCDPSession(page);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await page.goto('/?ui=2&ex=blink&resume=0');
      await ready(page);

      await page.locator('#ui2Phone [data-a="more"]').tap();
      await expect(page.locator('#ui2Pop')).toBeVisible();
      await expectInside(page, '#ui2Pop');
      if (size.name === '390x664') {
        fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
        await page.screenshot({ path: '/opt/cursor/artifacts/ui2-after-phone-more.png' });
      }
      const gap = await page.evaluate(() => {
        const pop = document.getElementById('ui2Pop')!.getBoundingClientRect();
        const bar = document.getElementById('ui2Phone')!.getBoundingClientRect();
        return bar.top - pop.bottom;
      });
      expect(gap).toBeGreaterThanOrEqual(-1);
      const buttons = page.locator('#ui2Pop button');
      const count = await buttons.count();
      expect(count).toBeGreaterThan(8);
      for (let i = 0; i < count; i++) {
        await buttons.nth(i).scrollIntoViewIfNeeded();
        await expectInside(page, `#ui2Pop button:nth-child(${i + 1})`);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('#ui2Pop')).toHaveCount(0);

      await page.locator('#ui2Phone [data-a="parts"]').tap();
      await expect(page.locator('#palette')).toBeVisible();
      await expectInside(page, '#palette');
      await page.evaluate(() => { const M = (window as unknown as { Mobile?: { setSheet?: (s: string | null) => void } }).Mobile; if (M && M.setSheet) M.setSheet(null); });

      await page.locator('#ui2Phone [data-a="code"]').tap();
      await expect(page.locator('#dock')).toBeVisible();
      await expectInside(page, '#dock');
      await page.evaluate(() => { const M = (window as unknown as { Mobile?: { setSheet?: (s: string | null) => void } }).Mobile; if (M && M.setSheet) M.setSheet(null); });

      await page.evaluate(() => {
        const w = window as unknown as { app: { editor: { select: (s: { part: string }) => void }; proj: { parts: { id: string; type: string }[] } } };
        const led = w.app.proj.parts.find((p) => p.type === 'led');
        if (led) w.app.editor.select({ part: led.id });
      });
      await expect(page.locator('#mSel')).toBeVisible();
      await expectInside(page, '#mSel');
      await page.locator('#mSel [data-a="connect"]').click();
      await expect(page.locator('#ui2Connect')).toBeVisible();
      await expectInside(page, '#ui2Connect');
      await page.locator('#ui2ConnectX').click();
      await page.locator('#mSel [data-a="props"]').click();
      await expect(page.locator('#side')).toBeVisible();
      await expectInside(page, '#side');
      await page.evaluate(() => { const M = (window as unknown as { Mobile?: { setSheet?: (s: string | null) => void } }).Mobile; if (M && M.setSheet) M.setSheet(null); });

      await page.evaluate(() => (document.getElementById('ui2Examples') as HTMLButtonElement).click());
      await expect(page.locator('#ui2Ex .ui2-card')).toBeVisible();
      await expectInside(page, '#ui2Ex .ui2-card');
      await page.keyboard.press('Escape');

      await expect.poll(() => page.locator('#bSignIn').count()).toBe(1);
      await page.evaluate(() => (document.getElementById('bSignIn') as HTMLButtonElement).click());
      await expect(page.locator('#authDlg .modal-box')).toBeVisible();
      await expectInside(page, '#authDlg .modal-box');
      await page.locator('#authDlgClose').click();

      await page.evaluate(() => {
        const w = window as unknown as { app: { cmd: { toast: (m: string) => void } } };
        w.app.cmd.toast('Saved locally');
      });
      await expect(page.locator('.toast').last()).toBeVisible();
      await expectInside(page, '.toast');

      if (size.name === '390x664') {
        await page.evaluate(() => { document.documentElement.dataset.clEnv = 'staging'; });
        const clear = await page.evaluate(() => {
          const banner = document.getElementById('stageBanner')!.getBoundingClientRect();
          const bar = document.getElementById('ui2top')!.getBoundingClientRect();
          return bar.top >= banner.bottom - 1;
        });
        expect(clear).toBe(true);
        await page.screenshot({ path: '/opt/cursor/artifacts/ui2-after-phone-banner.png' });
      }
    });
  }
});
