import { expect, test } from '@playwright/test';

const port = process.env.MIGRATE_E2E_PORT || '18931';
const httpOrigin = `http://127.0.0.1:${port}`;
const movedOrigin = `http://localhost:${port}`;

function project(id: string, name: string, updated: number) {
  return JSON.stringify({
    [id]: { id, name, updated, proj: { id, name, parts: [], wires: [] } },
  });
}

test('the fragment is cleared before later scripts and is not in history', async ({ page }) => {
  const marker = 'HISTORYpayloadMARKER991';
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  await page.goto(`${httpOrigin}/api/health`);
  const before = await page.evaluate(() => history.length);
  const response = await page.goto(`${movedOrigin}/migrate#${marker}`);
  const csp = response?.headers()['content-security-policy'] || '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'nonce-");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('upgrade-insecure-requests');
  await page.waitForFunction((token) => !location.href.includes(token), marker);
  const after = await page.evaluate(() => history.length);
  expect(after).toBe(before + 1);
  expect(await page.evaluate(() => location.href)).not.toContain(marker);
  const html = await page.content();
  expect(html).not.toContain(marker);
  expect(html).not.toMatch(/<script[^>]+src=/i);
  expect(html).not.toMatch(/<link[\s>]/i);
  expect(html).not.toMatch(/<img[\s>]/i);
  const firstEnd = html.indexOf('</script>');
  expect(html.slice(0, firstEnd)).toContain('history.replaceState');
  expect(html.slice(0, firstEnd)).not.toContain('clMigrate');
  await page.goBack();
  expect(page.url()).not.toContain(marker);
  expect(await page.content()).not.toContain(marker);
  await page.goForward();
  expect(page.url()).not.toContain(marker);
  expect(await page.content()).not.toContain(marker);
  expect(await page.evaluate(() => history.length)).toBe(after);
  const hosts = urls.map((url) => new URL(url).hostname);
  expect(hosts.every((host) => host === '127.0.0.1' || host === 'localhost')).toBeTruthy();
});

for (const width of [390, 1280]) {
  test(`a saved project arrives at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const hosts: string[] = [];
    page.on('request', (req) => hosts.push(new URL(req.url()).hostname));
    await page.addInitScript((saved) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', saved);
        localStorage.setItem('esp32lab.current.v1', 'lamp1');
      }
    }, project('lamp1', 'Desk lamp', 10));
    await page.goto(`${httpOrigin}/`);
    await page.waitForURL((url) => url.hostname === 'localhost' && url.searchParams.has('moved'));
    expect(page.url()).not.toContain('Desk');
    expect(await page.evaluate(() => location.href)).not.toContain('esp32lab.projects');
    await expect(page.getByText('Your projects moved with you (1)')).toBeVisible();
    const saved = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
    expect(saved).toContain('Desk lamp');
    await page.goto(`${httpOrigin}/api/health`);
    const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
    const flag = await page.evaluate(() => localStorage.getItem('cl_migrated_to_https'));
    expect(kept).toContain('Desk lamp');
    expect(flag).toMatch(/^[0-9]+$/);
    expect(hosts.every((host) => host === '127.0.0.1' || host === 'localhost')).toBeTruthy();
  });

  test(`a colliding project stays and the import is a moved copy at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(({ incoming, existing }) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', incoming);
        localStorage.setItem('esp32lab.current.v1', 'lamp1');
      }
      if (location.hostname === 'localhost' && sessionStorage.getItem('cl-seeded') !== '1') {
        localStorage.setItem('esp32lab.projects.v1', existing);
        sessionStorage.setItem('cl-seeded', '1');
      }
    }, {
      incoming: project('lamp1', 'From HTTP', 10),
      existing: project('lamp1', 'Already here', 3),
    });
    await page.goto(`${httpOrigin}/`);
    await page.waitForURL((url) => url.hostname === 'localhost' && url.searchParams.has('moved'));
    await expect(page.getByText(/Your projects moved with you \(1\)/)).toBeVisible();
    const saved = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1') || '');
    expect(saved).toContain('Already here');
    expect(saved).toContain('From HTTP (moved copy)');
    const parsed = JSON.parse(saved);
    expect(parsed.lamp1.name).toBe('Already here');
    await page.goto(`${httpOrigin}/api/health`);
    const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1') || '');
    expect(kept).toContain('From HTTP');
    expect(kept).not.toContain('moved copy');
  });
}
