// Enforcing CSP: script-src has no unsafe-inline and the policy has no unsafe-eval.
// Styles still allow unsafe-inline because the UI sets style properties from script.
// JS sketches opt into the worker with ?jssketchworker=1. The flag defaults off.
import { test, expect, type Page } from '@playwright/test';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

async function install(page: Page) {
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = list;
    document.addEventListener('securitypolicyviolation', (ev) => {
      list.push(ev.violatedDirective + ' ' + ev.blockedURI);
    });
  });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const host = new URL(req.url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return route.abort();
    if (req.url().includes('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (req.resourceType() === 'document') {
      const res = await route.fetch();
      const headers = { ...res.headers(), 'content-security-policy': CSP };
      return route.fulfill({ response: res, headers });
    }
    return route.fallback();
  });
}

async function violations(page: Page) {
  return page.evaluate(() => (window as unknown as { __csp: string[] }).__csp || []);
}

test('View · 2D works under an enforcing CSP with no unsafe-eval', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  expect(CSP).not.toContain('unsafe-eval');
  expect(CSP.split('style-src')[0]).not.toContain('unsafe-inline');
  await page.goto('/?lazy3d=1&idlepal=1&ex=blink');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { cmd?: { viewSch?: () => void } } }).app;
    return !!(app && app.cmd && app.cmd.viewSch);
  });
  await page.evaluate(() => (window as unknown as { app: { cmd: { viewSch: () => void } } }).app.cmd.viewSch());
  await expect(page.locator('body')).toHaveClass(/viewsch/);
  await page.locator('#bForce2d').click();
  await expect(page.locator('body')).not.toHaveClass(/viewsch/);
  await expect(page.locator('#bView2d')).toHaveClass(/on/);
  expect(await violations(page), (await violations(page)).join('\n')).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('potjs Run works under an enforcing CSP without unsafe-eval', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/favicon/i.test(msg.text())) errors.push(msg.text());
  });
  await page.goto('/?jssketchworker=1&lazy3d=1&idlepal=1&ex=potjs');
  await expect(page.locator('#projTitle')).toContainText('Pot');
  await expect(page.locator('#stText')).toHaveText('Idle');
  await page.locator('#bRun').click();
  await page.waitForFunction(() => (document.getElementById('serial')?.textContent || '').includes('pot='), null, { timeout: 15000 });
  const serial = await page.locator('#serial').innerText();
  expect(serial).toMatch(/pot=\s*\d+/);
  const usedEval = await page.evaluate(() => {
    const run = (window as unknown as { app: { run: { sketch?: { usedEval?: boolean } } | null } }).app.run;
    return !!(run && run.sketch && run.sketch.usedEval);
  });
  expect(usedEval).toBe(false);
  expect(await violations(page), (await violations(page)).join('\n')).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});
