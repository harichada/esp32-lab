import { expect, test, type Page } from '@playwright/test';

const port = process.env.MIGRATE_E2E_PORT || '18931';
const httpOrigin = `http://127.0.0.1:${port}`;
const movedOrigin = `http://localhost:${port}`;

function watchMoved(page: Page) {
  const seen: string[] = [];
  const onNav = (frame: { url(): string; parentFrame(): null | object }) => {
    if (!frame.parentFrame()) seen.push(frame.url());
  };
  page.on('framenavigated', onNav);
  return expect.poll(() => seen.some((item) => {
    const url = new URL(item);
    return url.hostname === 'localhost' && url.searchParams.has('moved');
  }), { timeout: 20000 }).toBe(true).then(() => {
    page.off('framenavigated', onNav);
    const moved = seen.find((item) => {
      const url = new URL(item);
      return url.hostname === 'localhost' && url.searchParams.has('moved');
    }) || '';
    expect(moved).not.toContain('Desk');
    expect(moved).not.toContain('esp32lab.projects');
    expect(moved).not.toContain('#');
  });
}

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
  expect(csp).toContain("style-src 'unsafe-inline'");
  expect(csp).not.toContain("script-src 'unsafe-inline'");
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
  expect(html).not.toContain('__clMove');
  expect(html).not.toContain('location.hash');
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
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    await page.addInitScript((saved) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', saved);
        localStorage.setItem('esp32lab.current.v1', 'lamp1');
      }
    }, project('lamp1', 'Desk lamp', 10));
    const arrived = watchMoved(page);
    await page.goto(`${httpOrigin}/`, { waitUntil: 'commit' });
    await arrived;
    expect(page.url()).not.toContain('Desk');
    expect(await page.evaluate(() => location.href)).not.toContain('esp32lab.projects');
    await expect(page.getByText('Your projects moved with you (1)')).toBeVisible();
    if (width === 1280) {
      const laid = await page.evaluate(() => {
        const toast = document.querySelector('.toast');
        const foot = document.getElementById('legalFoot');
        if (!toast || !foot) return { ok: false, reason: 'missing' };
        const a = toast.getBoundingClientRect();
        const b = foot.getBoundingClientRect();
        const overlap = a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
        return {
          ok: !overlap && b.height > 0 && b.width > 0 && b.top < window.innerHeight,
          overlap, footH: b.height, footTop: b.top, toastBottom: a.bottom,
        };
      });
      expect(laid.ok).toBe(true);
    }
    const saved = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
    expect(saved).toContain('Desk lamp');
    await page.goto(`${httpOrigin}/api/health`);
    const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
    const flag = await page.evaluate(() => localStorage.getItem('cl_migrated_to_https'));
    expect(kept).toContain('Desk lamp');
    expect(flag).toMatch(/^[0-9]+$/);
    const joined = urls.join('\n');
    expect(joined).not.toContain('Desk');
    expect(joined).not.toContain('esp32lab.projects');
    expect(urls.every((url) => !url.includes('#'))).toBeTruthy();
    expect(urls.every((url) => new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost')).toBeTruthy();
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
    const arrived = watchMoved(page);
    await page.goto(`${httpOrigin}/`, { waitUntil: 'commit' });
    await arrived;
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

  test(`an interrupted move can be retried from the same tab at ${width}`, async ({ page }) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width, height: 800 });
    let posts = 0;
    await page.route('**/migrate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts === 1) return route.abort();
      return route.continue();
    });
    await page.addInitScript((saved) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', saved);
      }
    }, project('lamp1', 'Desk lamp', 10));
    await page.goto(`${httpOrigin}/`);
    await expect(page.getByText('still safe at the original address')).toBeVisible({ timeout: 15000 });
    expect(page.url()).toContain('127.0.0.1');
    const mid = await page.evaluate(() => ({
      attempt: sessionStorage.getItem('cl_migrate_attempt'),
      migrated: localStorage.getItem('cl_migrated_to_https'),
      projects: localStorage.getItem('esp32lab.projects.v1'),
    }));
    expect(mid.attempt).toBeNull();
    expect(mid.migrated).toBeNull();
    expect(mid.projects).toContain('Desk lamp');
    const arrived = watchMoved(page);
    await page.getByRole('link', { name: 'Back to the original address' }).click();
    await arrived;
    expect(page.url()).not.toContain('Desk');
    const saved = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
    expect(saved).toContain('Desk lamp');
    await page.goto(`${httpOrigin}/api/health`);
    const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
    expect(kept).toContain('Desk lamp');
  });

  test(`a checksum mismatch stays on the failure page at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/migrate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'ab'.repeat(32)}"`);
      await route.fulfill({ status: response.status(), headers: response.headers(), body });
    });
    await page.addInitScript((saved) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', saved);
      }
    }, project('lamp1', 'Desk lamp', 10));
    await page.goto(`${httpOrigin}/`);
    await expect(page.getByRole('heading', { name: 'Projects were not moved' })).toBeVisible();
    expect(page.url()).toContain('127.0.0.1');
    expect(page.url()).not.toContain('Desk');
    const state = await page.evaluate(() => ({
      attempt: sessionStorage.getItem('cl_migrate_attempt'),
      migrated: localStorage.getItem('cl_migrated_to_https'),
      projects: localStorage.getItem('esp32lab.projects.v1'),
    }));
    expect(state.attempt).toBeNull();
    expect(state.migrated).toBeNull();
    expect(state.projects).toContain('Desk lamp');
  });

  test(`a payload over the cap stays on the failure page at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    let posts = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST') posts += 1;
    });
    await page.addInitScript(() => {
      if (location.hostname !== '127.0.0.1') return;
      const chunk = 'x'.repeat(1100000);
      localStorage.setItem('esp32lab.theme', chunk);
      localStorage.setItem('esp32lab.flow', chunk);
      localStorage.setItem('esp32lab.projects.v1', JSON.stringify({
        lamp1: { id: 'lamp1', name: 'Desk lamp', updated: 10, proj: { id: 'lamp1', name: 'Desk lamp', parts: [], wires: [] } },
      }));
    });
    await page.goto(`${httpOrigin}/`);
    await expect(page.getByText('still safe at the original address')).toBeVisible();
    expect(posts).toBe(0);
    expect(page.url()).not.toContain('Desk');
    const state = await page.evaluate(() => ({
      attempt: sessionStorage.getItem('cl_migrate_attempt'),
      projects: localStorage.getItem('esp32lab.projects.v1'),
    }));
    expect(state.attempt).toBeNull();
    expect(state.projects).toContain('Desk lamp');
  });

  test(`a second submit does not duplicate the project at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript((saved) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', saved);
      }
    }, project('lamp1', 'Desk lamp', 10));
    const arrived = watchMoved(page);
    await page.goto(`${httpOrigin}/`, { waitUntil: 'commit' });
    await arrived;
    await page.goto(`${httpOrigin}/api/health`);
    await page.evaluate(() => {
      localStorage.removeItem('cl_migrated_to_https');
      sessionStorage.removeItem('cl_migrate_attempt');
    });
    const again = watchMoved(page);
    await page.goto(`${httpOrigin}/`, { waitUntil: 'commit' });
    await again;
    const saved = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1') || '');
    const parsed = JSON.parse(saved);
    expect(Object.keys(parsed)).toEqual(['lamp1']);
    expect(parsed.lamp1.name).toBe('Desk lamp');
    await page.goto(`${httpOrigin}/api/health`);
    const kept = JSON.parse(await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1') || '{}'));
    expect(Object.keys(kept)).toEqual(['lamp1']);
  });

  test(`cancel leaves the projects on the original address at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/migrate', (route) => route.abort());
    await page.addInitScript((saved) => {
      if (location.hostname === '127.0.0.1' && !localStorage.getItem('esp32lab.projects.v1')) {
        localStorage.setItem('esp32lab.projects.v1', saved);
      }
    }, project('lamp1', 'Desk lamp', 10));
    await page.goto(`${httpOrigin}/`);
    await page.getByRole('link', { name: 'Cancel' }).click();
    await page.waitForURL((url) => url.searchParams.get('clstay') === '1');
    expect(page.url()).toContain('127.0.0.1');
    await expect(page.locator('#top')).toBeVisible();
    const state = await page.evaluate(() => ({
      attempt: sessionStorage.getItem('cl_migrate_attempt'),
      migrated: localStorage.getItem('cl_migrated_to_https'),
      projects: localStorage.getItem('esp32lab.projects.v1'),
    }));
    expect(state.attempt).toBeNull();
    expect(state.migrated).toBeNull();
    expect(state.projects).toContain('Desk lamp');
  });
}
