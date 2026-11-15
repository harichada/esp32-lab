// Dropping maximum-scale (?a11y=1) must leave the board's own zoom, pinch, and
// a swipe after a selection working at 390, in 2D and on the schematic.
import { test, expect } from '@playwright/test';

test('board zoom, pinch, and swipe still work at 390 without maximum-scale', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return route.abort();
    if (route.request().url().includes('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fallback();
  });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/?a11y=1&lazy3d=1&idlepal=1&ex=blink');
  await expect(page.locator('body')).toHaveClass(/m/);
  await expect(page.locator('#stText')).toHaveText('Idle');
  // Phone layout fits the board once, 200ms after the document is ready. Wait
  // that out so the zoom click is not undone by the fit.
  await page.waitForTimeout(700);
  const vp = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(vp || '').not.toMatch(/maximum-scale\s*=/);

  const scale = () => page.evaluate(() => (window as unknown as { app: { editor: { view: { s: number, x: number, y: number }, sel: { part?: string } | null } } }).app.editor.view.s);
  const before = await scale();
  await page.locator('#bZoomIn').click({ force: true });
  await expect.poll(scale).toBeGreaterThan(before + 0.05);
  const zoomed = await scale();
  await page.locator('#bZoomOut').click({ force: true });
  await expect.poll(scale).toBeLessThan(zoomed - 0.05);

  await page.evaluate(() => (window as unknown as { app: { cmd: { viewSch: () => void } } }).app.cmd.viewSch());
  await expect(page.locator('body')).toHaveClass(/viewsch/);
  const sch = () => page.evaluate(() => {
    const view = (window as unknown as { app: { schematic: { view: { s: number } } } }).app.schematic.view;
    return view.s;
  });
  const sch0 = await sch();
  await page.locator('#bZoomIn').click({ force: true });
  await expect.poll(sch).toBeGreaterThan(sch0 + 0.02);
  await page.locator('#bForce2d').click({ force: true });
  await expect(page.locator('body')).not.toHaveClass(/viewsch/);

  const gestures = await page.evaluate(() => {
    const ed = (window as unknown as { app: { editor: { view: { s: number, x: number, y: number }, sel: { part?: string } | null, part: (id: string) => { type?: string } | null } } }).app.editor;
    const parts = [...document.querySelectorAll('#lParts .part')] as HTMLElement[];
    const part = parts.find((el) => {
      const id = el.dataset.id || '';
      const p = id && ed.part(id);
      return !!(p && p.type && p.type !== 'breadboard');
    });
    if (!part) return { ok: false, why: 'no part' };
    const box = part.getBoundingClientRect();
    const tap = (type: string) => part.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
      clientX: box.x + box.width / 2, clientY: box.y + box.height / 2,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    tap('pointerdown');
    tap('pointerup');
    const selected = ed.sel && ed.sel.part;
    const stage = document.getElementById('stage') as HTMLElement;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const x0 = ed.view.x;
    const y0 = ed.view.y;
    const s0 = ed.view.s;
    const finger = (type: string, id: number, x: number, y: number, primary: boolean) => {
      stage.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: primary,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
    };
    // Two fingers down, then a sideways swipe. The second finger keeps the selection.
    finger('pointerdown', 11, cx - 30, cy, true);
    finger('pointerdown', 12, cx + 30, cy, false);
    finger('pointermove', 11, cx + 20, cy, true);
    finger('pointermove', 12, cx + 80, cy, false);
    const moved = Math.abs(ed.view.x - x0) + Math.abs(ed.view.y - y0);
    const still = ed.sel && ed.sel.part;
    // Spread the same two fingers. The page viewport must stay put.
    finger('pointermove', 11, cx - 40, cy, true);
    finger('pointermove', 12, cx + 140, cy, false);
    const pageScale = window.visualViewport ? window.visualViewport.scale : 1;
    return { ok: true, selected, still, moved, before: s0, after: ed.view.s, pageScale };
  });
  expect(gestures.ok, JSON.stringify(gestures)).toBe(true);
  expect(gestures.selected).toBeTruthy();
  expect(gestures.still).toBe(gestures.selected);
  expect(gestures.moved).toBeGreaterThan(1);
  expect(gestures.after).toBeGreaterThan(gestures.before + 0.05);
  expect(gestures.pageScale).toBeLessThan(1.05);
  expect(errors, errors.join('\n')).toEqual([]);
});
