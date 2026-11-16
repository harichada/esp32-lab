// Desktop (and phone) panels must sit fully inside the viewport, and every
// control in the scope probe view must scroll fully into view.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

const DESK = [
  { width: 1280, height: 720, name: '1280x720' },
  { width: 1366, height: 768, name: '1366x768' },
  { width: 1440, height: 900, name: '1440x900' },
  { width: 1920, height: 1080, name: '1920x1080' },
  { width: 1280, height: 600, name: '1280x600' },
];

async function install(page: Page) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    const pathName = new URL(req.url()).pathname;
    if (req.resourceType() === 'document' && (pathName === '/' || pathName.endsWith('/index.html'))) {
      const res = await route.fetch();
      let body = await res.text();
      if (!body.includes('name="cl-auth"')) body = body.replace('<head>', '<head>\n<meta name="cl-auth" content="1">');
      return route.fulfill({ response: res, body });
    }
    return route.fallback();
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
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

function insideOf(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const oy = vv ? vv.offsetTop : 0;
  const ox = vv ? vv.offsetLeft : 0;
  const vh = vv ? vv.height : window.innerHeight;
  const vw = vv ? vv.width : window.innerWidth;
  const top = r.top - oy, left = r.left - ox, bottom = r.bottom - oy, right = r.right - ox;
  const slack = 0.5;
  return {
    top, left, bottom, right, vh, vw, w: r.width, h: r.height,
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
  const items = [...document.querySelectorAll(selector)].filter((el) => {
    const node = el as HTMLElement;
    return !node.hidden && node.getClientRects().length > 0;
  }) as HTMLElement[];
  const fails: { text: string; top: number; bottom: number; left: number; right: number; vh: number; vw: number }[] = [];
  for (const el of items) {
    const scrollers: HTMLElement[] = [];
    let node: HTMLElement | null = el.parentElement;
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
    const r = el.getBoundingClientRect();
    const top = r.top - oy, left = r.left - ox, bottom = r.bottom - oy, right = r.right - ox;
    if (!(top >= -slack && left >= -slack && bottom <= vh + slack && right <= vw + slack && r.width > 2 && r.height > 2)) {
      fails.push({ text: (el.textContent || '').trim().slice(0, 40), top, bottom, left, right, vh, vw });
    }
  }
  return { total: items.length, fails };
}

async function expectInside(page: Page, selector: string) {
  const box = await page.evaluate(insideOf, selector);
  expect(box, selector).toBeTruthy();
  expect(box && box.inside, selector + ' ' + JSON.stringify(box)).toBe(true);
}

test.describe('desktop panels stay in the viewport', () => {
  for (const size of DESK) {
    test(size.name, async ({ page }) => {
      await install(page);
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('/?ui=2&ex=blink&resume=0');
      await expect.poll(() => page.evaluate(() => document.body.dataset.ui2 === '1')).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const parts = (window as unknown as { app?: { proj?: { parts?: unknown[] } } }).app?.proj?.parts || [];
        return parts.length > 2;
      })).toBe(true);

      await expectInside(page, '#dock');
      await expectInside(page, '#palette');
      await page.locator('#ui2DockBar [data-tab="scope"]').click();
      await expect.poll(() => page.locator('#scopeInst').count()).toBe(1);
      await expectInside(page, '#dock');
      const probe = await page.evaluate(revealAll, '#scopeInst .ich, #scopeInst .isec, #scopeInst [data-a="probe"]');
      expect(probe.total).toBeGreaterThan(6);
      expect(probe.fails, JSON.stringify(probe.fails.slice(0, 4))).toEqual([]);
      if (size.name === '1280x720' || size.name === '1280x600') {
        await page.screenshot({ path: '/opt/cursor/artifacts/ui2-after-probe-' + size.height + '.png' });
      }

      await page.evaluate(() => {
        const top = document.getElementById('ui2top')!.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--ui2dock', (window.innerHeight - top + 400) + 'px');
      });
      await expectInside(page, '#dock');

      await page.locator('#ui2SideTabs [data-side="props"]').click();
      await page.evaluate(() => {
        const w = window as unknown as { app: { editor: { select: (s: { part: string }) => void }; proj: { parts: { id: string; type: string }[] } } };
        const esp = w.app.proj.parts.find((p) => p.type === 'esp32');
        if (esp) w.app.editor.select({ part: esp.id });
      });
      await expectInside(page, '#side');
      const props = await page.evaluate(revealAll, '#insp button, #insp label');
      expect(props.fails, JSON.stringify(props.fails.slice(0, 3))).toEqual([]);

      await page.locator('#ui2SideTabs [data-side="parts"]').click();
      await expectInside(page, '#palette');
      const tiles = await page.evaluate(revealAll, '#mTrack .pitem:not([hidden]), #palList .pitem:not([hidden]), #ui2Chips button');
      expect(tiles.total).toBeGreaterThan(4);
      expect(tiles.fails, JSON.stringify(tiles.fails.slice(0, 3))).toEqual([]);

      await page.locator('#ui2Examples').click();
      await expect(page.locator('#ui2Ex .ui2-card')).toBeVisible();
      await expectInside(page, '#ui2Ex .ui2-card');
      await page.keyboard.press('Escape');

      await page.evaluate(() => (window as unknown as { app: { cmd: { projects: () => void } } }).app.cmd.projects());
      await expect(page.locator('#projDlg .modal-box')).toBeVisible();
      await expectInside(page, '#projDlg .modal-box');
      await page.locator('#projDlg [data-a="close"]').click();

      await page.evaluate(() => (document.getElementById('bSignIn') as HTMLButtonElement).click());
      await expect(page.locator('#authDlg .modal-box')).toBeVisible();
      await expectInside(page, '#authDlg .modal-box');
      await page.locator('#authDlgClose').click();

      await page.evaluate(() => (document.getElementById('bKeys') as HTMLButtonElement).click());
      await expect(page.locator('#keysDlg .modal-box')).toBeVisible();
      await expectInside(page, '#keysDlg .modal-box');
      await page.keyboard.press('Escape');

      await page.evaluate(() => (document.getElementById('bCmdk') as HTMLButtonElement).click());
      await expect(page.locator('#cmdk .cmdk-box')).toBeVisible();
      await expectInside(page, '#cmdk .cmdk-box');
      await page.keyboard.press('Escape');

      await page.evaluate(() => (window as unknown as { app: { cmd: { toast: (m: string) => void } } }).app.cmd.toast('Saved locally'));
      await expect(page.locator('.toast').last()).toBeVisible();
      await expectInside(page, '.toast');

      const menu = await page.evaluate(() => {
        const wire = document.querySelector('#stage .wire') as SVGElement | null;
        if (!wire) return false;
        const r = wire.getBoundingClientRect();
        wire.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 2 }));
        return true;
      });
      expect(menu).toBe(true);
      await expect(page.locator('.ctxmenu')).toBeVisible();
      await expectInside(page, '.ctxmenu');
      await page.keyboard.press('Escape');

      if (size.name === '1280x720') {
        const axe = await new AxeBuilder({ page }).include('#tab-scope').withRules(['select-name', 'scrollable-region-focusable']).analyze();
        const bad = axe.violations.map((v) => v.id + ' ' + v.nodes.map((n) => n.target.join(' ')).join(' | '));
        expect(bad, bad.join('\n')).toEqual([]);
      }
    });
  }
});

test.describe('phone probe view stays in the viewport', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const size of [{ width: 390, height: 844, name: '390x844' }, { width: 844, height: 390, name: '844x390' }]) {
    test(size.name, async ({ page }) => {
      await install(page);
      await page.setViewportSize(size);
      const client = await page.context().newCDPSession(page);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await page.goto('/?ui=2&ex=blink&resume=0');
      await expect.poll(() => page.evaluate(() => document.body.classList.contains('m') && document.body.dataset.ui2 === '1')).toBe(true);
      await page.locator('#ui2Phone [data-a="code"]').tap();
      await page.locator('#ui2PhoneDock [data-tab="scope"]').click();
      await expect.poll(() => page.locator('#scopeInst').count()).toBe(1);
      await expectInside(page, '#dock');
      const probe = await page.evaluate(revealAll, '#scopeInst .ich, #scopeInst .isec, #scopeInst [data-a="probe"]');
      expect(probe.total).toBeGreaterThan(4);
      expect(probe.fails, JSON.stringify(probe.fails.slice(0, 4))).toEqual([]);
    });
  }
});
