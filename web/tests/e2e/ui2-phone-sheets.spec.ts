// Phone sheets must stay inside the visual viewport, including short
// screens where the browser toolbar eats part of 100vh.
import fs from 'fs';
import { test, expect, type Page } from '@playwright/test';

const SIZES = [
  { width: 360, height: 640, name: '360x640' },
  { width: 375, height: 667, name: '375x667' },
  { width: 390, height: 664, name: '390x664' },
  { width: 390, height: 844, name: '390x844' },
  { width: 414, height: 736, name: '414x736' },
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
  const slack = 0.5;
  return {
    top, left, bottom, right, vh, vw,
    width: r.width, height: r.height,
    inside: top >= -slack && left >= -slack && bottom <= vh + slack && right <= vw + slack && r.width > 2 && r.height > 2,
  };
}

function revealAll(selector: string) {
  const vv = window.visualViewport;
  const oy = vv ? vv.offsetTop : 0;
  const ox = vv ? vv.offsetLeft : 0;
  const vh = vv ? vv.height : window.innerHeight;
  const vw = vv ? vv.width : window.innerWidth;
  const slack = 0.5;
  const measure = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const top = r.top - oy;
    const left = r.left - ox;
    const bottom = r.bottom - oy;
    const right = r.right - ox;
    return {
      text: (el.textContent || '').trim().slice(0, 48),
      top, left, bottom, right, vh, vw, h: r.height,
      ok: top >= -slack && left >= -slack && bottom <= vh + slack && right <= vw + slack && r.width > 2 && r.height > 2,
    };
  };
  const items = [...document.querySelectorAll(selector)].filter((el) => {
    const node = el as HTMLElement;
    return !node.hidden && node.getClientRects().length > 0;
  }) as HTMLElement[];
  const fails: ReturnType<typeof measure>[] = [];
  for (const el of items) {
    let node: HTMLElement | null = el.parentElement;
    const scrollers: HTMLElement[] = [];
    while (node) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX)) scrollers.push(node);
      node = node.parentElement;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const sc of scrollers) {
        const er = el.getBoundingClientRect();
        const sr = sc.getBoundingClientRect();
        if (er.top < sr.top - slack) sc.scrollTop -= sr.top - er.top;
        if (er.bottom > sr.bottom + slack) sc.scrollTop += er.bottom - sr.bottom;
        if (er.left < sr.left - slack) sc.scrollLeft -= sr.left - er.left;
        if (er.right > sr.right + slack) sc.scrollLeft += er.right - sr.right;
      }
    }
    const box = measure(el);
    if (!box.ok) fails.push(box);
  }
  return { total: items.length, fails };
}

async function expectInside(page: Page, selector: string) {
  await expect.poll(() => page.evaluate(boxOf, selector)).toMatchObject({ inside: true });
}

test.describe('phone sheets stay in the visual viewport', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    test(size.name, async ({ page }) => {
      await install(page);
      await page.addInitScript(() => {
        const root = document.documentElement;
        root.style.setProperty('--sai-t', '47px');
        root.style.setProperty('--sai-b', '34px');
        root.style.setProperty('--sai-l', '0px');
        root.style.setProperty('--sai-r', '0px');
      });
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
      const abovePuck = await page.evaluate(() => {
        const pop = document.getElementById('ui2Pop')!.getBoundingClientRect();
        const puck = document.querySelector('#ui2Phone [data-a="run"]')!.getBoundingClientRect();
        return { clear: pop.bottom <= puck.top + 0.5, width: pop.width, popBottom: pop.bottom, puckTop: puck.top };
      });
      expect(abovePuck.clear, JSON.stringify(abovePuck)).toBe(true);
      expect(abovePuck.width).toBeLessThanOrEqual(420.5);
      if (size.height <= 520) {
        const cols = await page.locator('#ui2Pop').evaluate((el) => getComputedStyle(el).gridTemplateColumns);
        expect(cols.split(' ').length).toBeGreaterThanOrEqual(2);
      }
      const menuItems = await page.evaluate(revealAll, '#ui2Pop button');
      expect(menuItems.total).toBeGreaterThan(8);
      expect(menuItems.fails, JSON.stringify(menuItems.fails.slice(0, 4))).toEqual([]);
      const restartClear = await page.evaluate(() => {
        const item = [...document.querySelectorAll('#ui2Pop button')].find((b) => (b.textContent || '').trim() === 'Restart') as HTMLElement;
        const r = item.getBoundingClientRect();
        const puck = document.querySelector('#ui2Phone [data-a="run"]')!.getBoundingClientRect();
        const vv = window.visualViewport;
        const oy = vv ? vv.offsetTop : 0;
        const vh = vv ? vv.height : window.innerHeight;
        return { above: r.bottom <= puck.top + 0.5, inView: r.top - oy >= -0.5 && r.bottom - oy <= vh + 0.5, h: r.height };
      });
      expect(restartClear.above, JSON.stringify(restartClear)).toBe(true);
      expect(restartClear.inView).toBe(true);
      expect(restartClear.h).toBeGreaterThan(20);
      await page.keyboard.press('Escape');
      await expect(page.locator('#ui2Pop')).toHaveCount(0);

      await page.locator('#ui2Phone [data-a="parts"]').tap();
      await expect(page.locator('#palette')).toBeVisible();
      await expectInside(page, '#palette');
      const starter = await page.evaluate(revealAll, '#mTrack .pitem:not([hidden])');
      expect(starter.total).toBeGreaterThan(8);
      expect(starter.fails, 'starter ' + JSON.stringify(starter.fails.slice(0, 3)) + ' / ' + starter.total).toEqual([]);
      if (size.name === '844x390') {
        await page.locator('#ui2PalTools [data-set="all"]').click();
        await expect.poll(() => page.locator('#mTrack .pitem:not([hidden])').count()).toBeGreaterThan(40);
        const all = await page.evaluate(revealAll, '#mTrack .pitem:not([hidden])');
        expect(all.fails, 'all ' + all.fails.length + '/' + all.total + ' ' + JSON.stringify(all.fails.slice(0, 3))).toEqual([]);
      }
      await page.evaluate(() => { const M = (window as unknown as { Mobile?: { setSheet?: (s: string | null) => void } }).Mobile; if (M && M.setSheet) M.setSheet(null); });

      if (size.width === 360) {
        await expect(page.locator('#ui2Name')).toHaveText('Blink');
      }
      await page.locator('#ui2Phone [data-a="code"]').tap();
      await expect(page.locator('#dock')).toBeVisible();
      await expectInside(page, '#dock');
      await expect(page.locator('#ui2PhoneDock [data-tab="serial"]')).toBeVisible();
      await expect(page.locator('#ui2PhoneDock [data-tab="scope"]')).toBeVisible();
      await expect(page.locator('#ui2SymBar')).toBeHidden();
      const symH = await page.locator('#ui2Sym').evaluate((el) => el.getBoundingClientRect().height);
      expect(symH).toBeGreaterThan(20);
      expect(symH).toBeLessThanOrEqual(45);
      await page.locator('#ui2Sym').click();
      const rowH = await page.locator('#ui2SymBar').evaluate((el) => el.getBoundingClientRect().height);
      expect(rowH).toBeLessThanOrEqual(56);
      await page.locator('#ui2PhoneDock [data-tab="serial"]').click();
      await expect(page.locator('#tab-serial')).toHaveClass(/on/);
      await page.locator('#ui2PhoneDock [data-tab="scope"]').click();
      await expect(page.locator('#tab-scope')).toHaveClass(/on/);
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
      const examples = await page.evaluate(() => {
        const card = document.querySelector('#ui2Ex .ui2-card') as HTMLElement;
        const title = document.getElementById('ui2ExTitle')!;
        card.scrollTop = card.scrollHeight;
        const t = title.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const note = document.querySelector('.ui2-ex-notes') as HTMLElement | null;
        const cs = note ? getComputedStyle(note) : null;
        return {
          sticky: t.top >= c.top - 2 && t.bottom <= c.bottom + 2,
          clamp: !!cs && (cs as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp === '2' && cs.wordBreak === 'normal',
        };
      });
      expect(examples.sticky).toBe(true);
      expect(examples.clamp).toBe(true);
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

      await page.goto('/?ui=2&resume=0');
      await ready(page);
      await expect(page.locator('#ui2Start .ui2-card')).toBeVisible();
      await expectInside(page, '#ui2Start .ui2-card');
      const close = await page.evaluate(revealAll, '#ui2Start [data-go="close"]');
      expect(close.fails, JSON.stringify(close.fails)).toEqual([]);
      if (size.name === '390x664') {
        await page.goto('/?ui=2&ex=blink&resume=0');
        await ready(page);
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
