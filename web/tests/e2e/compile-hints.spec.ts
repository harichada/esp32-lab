// Plain-language compile errors. Static files only: /api/compile is mocked
// with a gcc fixture captured from g++. Nothing here reaches a real lab server.
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const fix = path.resolve(__dirname, '../fixtures/compile');
const log = fs.readFileSync(path.join(fix, 'e2e.txt'), 'utf8');
const source = fs.readFileSync(path.join(fix, 'e2e-sketch.ino'), 'utf8');

const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desk', width: 1280, height: 800 },
] as const;

async function install(page: Page, hints: boolean, compileLog = log) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
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
    if (url.includes('/api/compile/progress')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' });
    }
    if (url.includes('/api/compile') && route.request().method() === 'POST') {
      const body = JSON.stringify({ ok: false, log: compileLog, netShim: false, net: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\//, (ws) => {
    ws.onMessage(() => {});
  });
  await page.goto('/?ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await page.evaluate((on) => {
    const prev = document.querySelector('meta[name="compilehints"]');
    if (prev) prev.remove();
    if (!on) return;
    const meta = document.createElement('meta');
    meta.name = 'compilehints';
    meta.content = '1';
    document.head.appendChild(meta);
  }, hints);
  await page.locator('#code').evaluate((el, src) => {
    const ta = el as HTMLTextAreaElement;
    ta.value = src;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, source);
  return errors;
}

async function run(page: Page, phone: boolean) {
  if (phone) {
    await page.evaluate(() => {
      const mobile = (window as unknown as { Mobile?: { setSheet?: (n: string) => void } }).Mobile;
      if (mobile && mobile.setSheet) mobile.setSheet('code');
    });
    await expect(page.locator('#mIgnite')).toBeVisible();
    await expect.poll(() => page.locator('#dock').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  }
  const before = await page.locator('#codeWrap').boundingBox();
  if (phone) await page.locator('#mIgnite').click();
  else await page.locator('#bRun').click();
  return before;
}

function phoneOf(width: number) {
  return width < 800;
}

for (const view of WIDTHS) {
  test(`hint on at ${view.width}: sentence, highlight, scroll, raw output`, async ({ page }) => {
    await page.setViewportSize({ width: view.width, height: view.height });
    const errors = await install(page, true);
    const phone = phoneOf(view.width);
    const before = await run(page, phone);
    const jump = page.locator('#compileHintJump');
    await expect(jump).toBeVisible();
    await expect(page.locator('#compileHints')).toHaveAttribute('role', 'status');
    await expect(page.locator('#compileHints')).toHaveAttribute('aria-live', 'polite');
    await expect(jump).toContainText('Line 53 is missing a semicolon');
    await expect(jump).toContainText(/digitalWrite\(LED, HIGH/);
    await expect(page.locator('#compileHintCount')).toHaveText('Error 1 of 2');
    await expect(page.locator('#codeGutter div.e', { hasText: /^53$/ })).toBeVisible();
    await expect(page.locator('#codeHl .lerr').first()).toBeAttached();
    await expect.poll(() => page.locator('#code').evaluate((el) => (el as HTMLTextAreaElement).scrollTop)).toBeGreaterThan(10);
    await expect.poll(() => page.locator('#code').evaluate((el) => (el as HTMLTextAreaElement).scrollLeft)).toBeGreaterThan(10);
    const after = await page.locator('#codeWrap').boundingBox();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(Math.abs((before?.y || 0) - (after?.y || 0))).toBeLessThan(1);
    expect(Math.abs((before?.height || 0) - (after?.height || 0))).toBeLessThan(1);

    await page.locator('#code').evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    });
    await jump.click();
    await expect.poll(() => page.locator('#code').evaluate((el) => (el as HTMLTextAreaElement).scrollTop)).toBeGreaterThan(10);

    const next = page.locator('#compileHintNext');
    const nextBox = await next.boundingBox();
    expect(nextBox && nextBox.height).toBeGreaterThanOrEqual(44);
    expect(nextBox && nextBox.width).toBeGreaterThanOrEqual(44);
    await next.click();
    await expect(jump).toContainText('pinMod');
    await expect(jump).toContainText('pinMode');
    await expect(page.locator('#compileHintCount')).toHaveText('Error 2 of 2');

    const rawBtn = page.locator('#compileHintRawBtn');
    await expect(rawBtn).toHaveText('Show full compiler output');
    const rawBox = await rawBtn.boundingBox();
    const jumpBox = await jump.boundingBox();
    expect(rawBox && rawBox.height).toBeGreaterThanOrEqual(44);
    expect(jumpBox && jumpBox.height).toBeGreaterThanOrEqual(44);
    await rawBtn.click();
    const raw = page.locator('#compileHintRaw');
    await expect(raw).toBeVisible();
    await expect(raw).toContainText(/expected .+ before/);
    await expect(raw.locator('img, script')).toHaveCount(0);
    await expect(rawBtn).toHaveText('Hide full compiler output');

    const fit = await jump.evaluate((el) => ({
      sw: el.scrollWidth,
      cw: el.clientWidth,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      overflow: getComputedStyle(el).textOverflow,
      white: getComputedStyle(el).whiteSpace,
    }));
    expect(fit.white).not.toBe('nowrap');
    expect(fit.overflow).not.toBe('ellipsis');
    expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1);
    expect(fit.sh).toBeLessThanOrEqual(fit.ch + 1);

    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(1);

    const runId = phone ? '#mIgnite' : '#bRun';
    const runBox = await page.locator(runId).boundingBox();
    expect(runBox).toBeTruthy();
    expect(runBox!.y).toBeGreaterThanOrEqual(-1);
    expect(runBox!.y + runBox!.height).toBeLessThanOrEqual(view.height + 1);
    const covered = await page.evaluate((id) => {
      const b = document.querySelector(id);
      if (!b) return true;
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !el || !b.contains(el);
    }, runId);
    expect(covered).toBe(false);

    await jump.focus();
    const outline = await jump.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test(`hint off at ${view.width} matches today's failure markup`, async ({ page }) => {
    await page.setViewportSize({ width: view.width, height: view.height });
    const errors = await install(page, false);
    const phone = phoneOf(view.width);
    const idsBefore = await page.evaluate(() => [...document.querySelectorAll('#tab-code *')].map((el) => el.id).filter(Boolean).sort());
    await run(page, phone);
    await expect(page.locator('#compileHints')).toHaveCount(0);
    await expect(page.locator('[data-tab=build]')).toHaveClass(/on/);
    await expect(page.locator('#tab-build')).toHaveClass(/on/);
    await expect(page.locator('#buildDet')).toHaveJSProperty('open', true);
    await expect(page.locator('#buildLog')).toContainText('sketch.ino:53:146:');
    await expect(page.locator('#serial')).toContainText('compile failed — see build log in Code tab');
    const idsAfter = await page.evaluate(() => [...document.querySelectorAll('#tab-code *')].map((el) => el.id).filter(Boolean).sort());
    expect(idsAfter).toEqual(idsBefore);
    await expect(page.locator('meta[name="compilehints"]')).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('compiler output stays text when the log contains markup', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    (window as unknown as { __xss?: number }).__xss = 0;
    window.alert = () => { (window as unknown as { __xss: number }).__xss++; };
  });
  const evil = 'sketch.ino:4:2: error: <img src=x onerror=alert(1)> </script>\n';
  const errors = await install(page, true, evil);
  let dialog = '';
  page.on('dialog', (d) => { dialog = d.message(); d.dismiss(); });
  await page.locator('#bRun').click();
  const jump = page.locator('#compileHintJump');
  await expect(jump).toContainText('<img src=x onerror=alert(1)>');
  await expect(jump).toContainText('</script>');
  await expect(jump.locator('img, script')).toHaveCount(0);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.locator('#compileHintRawBtn').click();
  const raw = page.locator('#compileHintRaw');
  await expect(raw).toContainText('<img src=x onerror=alert(1)>');
  await expect(raw).toContainText('</script>');
  await expect(raw.locator('img, script')).toHaveCount(0);
  const build = page.locator('#buildLog');
  await expect(build).toContainText('<img src=x onerror=alert(1)>');
  await expect(build).toContainText('</script>');
  await expect(build.locator('img, script')).toHaveCount(0);
  const leaked = await page.evaluate(() => ({
    img: document.querySelectorAll('img[src="x"]').length,
    script: [...document.scripts].filter((s) => /alert\(1\)/.test(s.text || '')).length,
    ran: (window as unknown as { __xss?: number }).__xss || 0,
  }));
  expect(leaked).toEqual({ img: 0, script: 0, ran: 0 });
  expect(dialog).toBe('');
  expect(errors, errors.join('\n')).toEqual([]);
});
