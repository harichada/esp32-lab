// A wire starts only from a pin or a breadboard hole, and every cancel
// path clears it. Covers the workbench and the live (ui2 off) canvas.
import { test, expect, type Page } from '@playwright/test';

type Pt = { x: number; y: number };
type Spots = {
  hole: Pt;
  gap: Pt;
  pin: Pt;
  body: Pt;
  empty: Pt;
  espId: string;
};

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
    const body = await res.text();
    await route.fulfill({ response: res, body });
  });
  await page.route('**/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ signed_in: false, providers: { google: true, github: true }, csrf: '', display_name: '' }),
  }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

async function spots(page: Page): Promise<Spots> {
  const found = await page.evaluate(() => {
    const wapp = window as unknown as {
      app: { editor: { svg: SVGSVGElement; part: (id: string) => { id: string; type: string; x: number; y: number } }; proj: { parts: { id: string; type: string; x: number; y: number }[] } };
      Parts: { T: Record<string, { pins: (p: unknown) => { name: string; x: number; y: number }[] }>; pinWorld: (p: unknown, pin: unknown) => { x: number; y: number } };
    };
    const svg = wapp.app.editor.svg;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const screen = (x: number, y: number) => {
      const sp = svg.createSVGPoint();
      sp.x = x; sp.y = y;
      const s = sp.matrixTransform(ctm);
      return { x: s.x, y: s.y };
    };
    const esp = wapp.app.proj.parts.find((p) => p.type === 'esp32');
    if (!esp) return null;
    const pin = wapp.Parts.T.esp32.pins(esp).find((q) => q.name === 'D2');
    if (!pin) return null;
    const pw = wapp.Parts.pinWorld(esp, pin);
    const ed = wapp.app.editor as unknown as {
      part: (id: string) => { type: string };
      toWorld: (e: { clientX: number; clientY: number }) => { x: number; y: number };
      pinNear: (w: { x: number; y: number }, ev: { pointerType: string }) => { bb?: boolean } | null;
      pinAtEvent: (ev: { clientX: number; clientY: number; pointerType: string; button: number; target: Element | null }) => { bb?: boolean } | null;
    };
    const kind = document.body.classList.contains('m') ? 'touch' : 'mouse';
    const bb = wapp.app.proj.parts.find((p) => p.type === 'breadboard');
    let gap: { x: number; y: number } | null = null;
    if (bb) {
      for (let x = 40; x <= 480 && !gap; x += 20) {
        const world = wapp.Parts.pinWorld(bb, { name: 'gap', x, y: 96 });
        const pt = screen(world.x, world.y);
        const hit = document.elementFromPoint(pt.x, pt.y);
        const host = hit && hit.closest('.part');
        const id = host && (host as HTMLElement).dataset.id;
        const part = id ? ed.part(id) : null;
        if (!hit || hit.closest('[data-pin]') || hit.closest('.wire') || !part || part.type !== 'breadboard') continue;
        if (ed.pinAtEvent({ clientX: pt.x, clientY: pt.y, pointerType: kind, button: 0, target: hit })) continue;
        gap = pt;
      }
    }
    let hole: { x: number; y: number } | null = null;
    for (const el of Array.from(document.querySelectorAll('#stage .hole[data-pin]'))) {
      const r = el.getBoundingClientRect();
      if (r.width < 2) continue;
      const pt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const hit = document.elementFromPoint(pt.x, pt.y);
      if (!hit || !hit.closest('[data-pin]')) continue;
      const got = ed.pinAtEvent({ clientX: pt.x, clientY: pt.y, pointerType: kind, button: 0, target: hit });
      if (!got) continue;
      hole = pt;
      break;
    }
    const r = svg.getBoundingClientRect();
    let empty: { x: number; y: number } | null = null;
    for (let y = r.top + 8; y < r.bottom - 8 && !empty; y += 14) {
      for (let x = r.left + 8; x < r.right - 8; x += 14) {
        const el = document.elementFromPoint(x, y);
        if (!el || !svg.contains(el)) continue;
        if (el.closest('.part') || el.closest('.wire') || el.closest('[data-pin]') || el.closest('.w-bend')) continue;
        const near = ed.pinNear(ed.toWorld({ clientX: x, clientY: y }), { pointerType: kind });
        if (near && !near.bb) continue;
        empty = { x, y };
        break;
      }
    }
    if (!gap || !hole || !empty) return null;
    return {
      hole, gap, empty,
      pin: screen(pw.x, pw.y),
      body: screen(esp.x + 70, esp.y + 45),
      espId: esp.id,
    };
  });
  expect(found, 'pin, hole, gap and empty canvas').toBeTruthy();
  return found as Spots;
}

async function mode(page: Page) {
  return page.evaluate(() => {
    const ed = (window as unknown as { app: { editor: { mode: { k?: string } | null } } }).app.editor;
    return (ed.mode && ed.mode.k) || '';
  });
}

async function wires(page: Page) {
  return page.evaluate(() => (window as unknown as { app: { proj: { wires: unknown[] } } }).app.proj.wires.length);
}

async function tap(page: Page, pt: Pt, touch: boolean) {
  // Dispatch on the element under the point. A phone touch hit-test can retarget
  // a plastic tap onto a 4px hole when the board is zoomed out; the handler
  // must ignore that plastic, and this event is the plastic.
  await page.evaluate(({ pt, touch }) => {
    const el = document.elementFromPoint(pt.x, pt.y) || document.getElementById('stage');
    const common = { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 0, pointerId: 1, pointerType: touch ? 'touch' : 'mouse', isPrimary: true };
    el!.dispatchEvent(new PointerEvent('pointerdown', common));
    window.dispatchEvent(new PointerEvent('pointerup', common));
  }, { pt, touch });
}

async function arm(page: Page, touch: boolean, pt: Pt) {
  const before = await wires(page);
  await tap(page, pt, touch);
  await expect.poll(() => mode(page)).toBe('wire');
  expect(await wires(page)).toBe(before);
}

async function cancelPaths(page: Page, ui2: boolean, touch: boolean) {
  await expect.poll(() => page.evaluate(() => {
    const parts = (window as unknown as { app: { proj?: { parts?: unknown[] } } }).app.proj?.parts || [];
    return parts.length > 2;
  })).toBe(true);
  const s = await spots(page);
  const before = await wires(page);

  await tap(page, s.gap, touch);
  expect(await mode(page)).not.toBe('wire');
  expect(await wires(page)).toBe(before);

  await tap(page, s.body, touch);
  expect(await mode(page)).not.toBe('wire');
  await expect.poll(() => page.evaluate(() => {
    const ed = (window as unknown as { app: { editor: { sel: { part?: string } | null } } }).app.editor;
    return (ed.sel && ed.sel.part) || '';
  })).toBe(s.espId);

  await arm(page, touch, s.pin);
  await page.keyboard.press('Escape');
  await expect.poll(() => mode(page)).toBe('');

  await arm(page, touch, s.pin);
  await page.evaluate((pt) => {
    const el = document.elementFromPoint(pt.x, pt.y) || document.getElementById('stage');
    el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 2 }));
  }, s.pin);
  await expect.poll(() => mode(page)).toBe('');

  await arm(page, touch, s.pin);
  await tap(page, s.pin, touch);
  await expect.poll(() => mode(page)).toBe('');

  await arm(page, touch, s.pin);
  await tap(page, s.empty, touch);
  await expect.poll(() => mode(page)).toBe('');

  await arm(page, touch, s.hole);
  if (ui2 && touch) {
    const banner = page.locator('#ui2WireBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Wiring — tap a pin');
    const cancel = banner.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();
    const box = await cancel.boundingBox();
    expect(box && box.height >= 40 && box.width >= 44).toBeTruthy();
    await expect(page.locator('#ui2Phone [data-a="wire"]')).toHaveAttribute('aria-pressed', 'true');
    await cancel.click();
    await expect.poll(() => mode(page)).toBe('');
    await expect(banner).toBeHidden();
    await expect(page.locator('#ui2Phone [data-a="wire"]')).toHaveAttribute('aria-pressed', 'false');
  } else if (!ui2 && touch) {
    const bar = page.locator('#mWireBar');
    await expect(bar).toBeVisible();
    await bar.locator('#mWireX').click();
    await expect.poll(() => mode(page)).toBe('');
    await expect(bar).toBeHidden();
  } else {
    await page.keyboard.press('Escape');
    await expect.poll(() => mode(page)).toBe('');
  }
  expect(await wires(page)).toBe(before);
}

test.describe('desktop wire start and cancel', () => {
  test('ui2', async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?ui=2&ex=blink&resume=0');
    await expect.poll(() => page.evaluate(() => document.body.dataset.ui2 === '1')).toBe(true);
    await cancelPaths(page, true, false);
  });

  test('ui2 off', async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?ui=0&ex=blink&resume=0');
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as { app?: { proj?: { parts?: unknown[] } } }).app;
      return !!(app && app.proj && app.proj.parts && app.proj.parts.length > 2 && document.documentElement.dataset.ui !== '2');
    })).toBe(true);
    await cancelPaths(page, false, false);
  });
});

test.describe('phone wire start and cancel', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('ui2 wire mode banner', async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.goto('/?ui=2&ex=blink&resume=0');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('m') && document.body.dataset.ui2 === '1')).toBe(true);
    const wire = page.locator('#ui2Phone [data-a="wire"]');
    await wire.click();
    const banner = page.locator('#ui2WireBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Wiring — tap a pin');
    await expect(banner.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await page.screenshot({ path: '/opt/cursor/artifacts/ui2-wire-banner.png' });
    await expect(wire).toHaveAttribute('aria-pressed', 'true');
    const s = await spots(page);
    await tap(page, s.gap, true);
    expect(await mode(page)).not.toBe('wire');
    await expect(banner).toBeHidden();
    await expect(wire).toHaveAttribute('aria-pressed', 'false');
    await wire.click();
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Cancel' }).click();
    await expect(banner).toBeHidden();
    await expect(wire).toHaveAttribute('aria-pressed', 'false');
    await cancelPaths(page, true, true);
  });

  test('ui2 off', async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.goto('/?ui=0&ex=blink&resume=0');
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as { app?: { proj?: { parts?: unknown[] } } }).app;
      return document.body.classList.contains('m') && !!(app && app.proj && app.proj.parts && app.proj.parts.length > 2) && document.documentElement.dataset.ui !== '2';
    })).toBe(true);
    await cancelPaths(page, false, true);
  });
});
