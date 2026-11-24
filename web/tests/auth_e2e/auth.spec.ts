import fs from 'fs';
import { expect, test, type Page } from '@playwright/test';

const port = process.env.AUTH_E2E_PORT || '18941';
const origin = `http://localhost:${port}`;
const CANCELLED = 'Sign-in cancelled — your work is still here';

function info() {
  return JSON.parse(fs.readFileSync('/tmp/esp32lab-auth-e2e.json', 'utf8')) as { mock: string };
}

function savedProjects() {
  const entry = (id: string, name: string) => ({
    id, name, updated: 10, from: '', proj: { id, name, parts: [{ id: 'r1' }], wires: [] },
  });
  return JSON.stringify({
    lamp1: entry('lamp1', 'Desk lamp'),
    lamp2: entry('lamp2', 'Porch'),
    lamp3: entry('lamp3', 'Hall'),
  });
}

async function setMode(page: Page, mode: string) {
  const res = await page.request.post(info().mock + '/control', { data: { mode } });
  expect(res.ok()).toBeTruthy();
}

async function signIn(page: Page, provider: 'Google' | 'GitHub', width: number) {
  if (width <= 820) {
    await page.getByRole('button', { name: 'More options' }).click();
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } else {
    await page.locator('#bSignIn').click();
  }
  const dlg = page.locator('#authDlg');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Continue with ' + provider }).click();
}

test.afterEach(async ({ page }) => {
  await setMode(page, 'ok').catch(() => undefined);
});

test('Google sign-in at 1280 keeps the project and view and saves local projects', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((saved) => {
    localStorage.setItem('esp32lab.projects.v1', saved);
    localStorage.setItem('esp32lab.current.v1', 'lamp1');
  }, savedProjects());
  await page.goto(origin + '/?view=schematic&p=lamp1');
  await expect(page.locator('body')).toHaveClass(/viewsch/);
  const imports: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/auth/projects/import')) imports.push(req.method());
  });
  await page.locator('#bSignIn').click();
  const sign = page.locator('#authDlg');
  await expect(sign).toBeVisible();
  await expect(sign.getByRole('button', { name: 'Continue with Google' })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Save your 3 projects to your account?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused();
  expect(imports).toEqual([]);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: '3 projects saved to your account' })).toBeVisible();
  expect(imports).toEqual(['POST']);
  await expect(page.locator('#authName')).toHaveText('Ada Lovelace');
  await expect(page.locator('body')).toHaveClass(/viewsch/);
  expect(page.url()).toContain('p=lamp1');
  expect(page.url()).not.toContain('view=');
  expect(page.url()).not.toContain('auth_error');
  const fresh = await page.context().newPage();
  const later: string[] = [];
  fresh.on('request', (req) => {
    if (req.url().includes('/auth/projects/import')) later.push(req.method());
  });
  await fresh.goto(origin + '/');
  await expect(fresh.locator('#authName')).toHaveText('Ada Lovelace');
  await expect(fresh.getByRole('dialog')).toHaveCount(0);
  expect(later).toEqual([]);
  await fresh.close();
});

test('Not now leaves the guest projects on this device', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((saved) => {
    localStorage.setItem('esp32lab.projects.v1', saved);
    localStorage.setItem('esp32lab.current.v1', 'lamp1');
  }, savedProjects());
  const imports: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/auth/projects/import')) imports.push(req.method());
  });
  await page.goto(origin + '/?p=lamp1');
  await signIn(page, 'Google', 1280);
  const dialog = page.getByRole('dialog', { name: 'Save your 3 projects to your account?' });
  await expect(dialog).toBeVisible();
  const notNow = dialog.getByRole('button', { name: 'Not now' });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(notNow).toBeFocused();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(notNow).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('3 projects saved to your account')).toHaveCount(0);
  expect(imports).toEqual([]);
  const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
  expect(kept).toContain('Desk lamp');
  expect(kept).toContain('Porch');
  expect(kept).toContain('Hall');
  await expect(page.locator('#authName')).toHaveText('Ada Lovelace');
});

test('390 reaches a provider in two taps and shows Account', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/');
  await expect(page.locator('#mAuthTitle')).toBeAttached();
  await expect(page.locator('#mMore')).toBeHidden();
  const heading = page.getByRole('heading', { name: 'Account' });
  await expect(heading).toBeHidden();
  let taps = 0;
  await page.getByRole('button', { name: 'More options' }).click();
  taps += 1;
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute('id', 'mAuthTitle');
  expect(await heading.evaluate((el) => el.tagName)).toBe('H2');
  await expect(page.locator('#mAuth')).toHaveAttribute('role', 'group');
  await expect(page.locator('#mAuth')).toHaveAttribute('aria-labelledby', 'mAuthTitle');
  const open = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(open).toBeVisible();
  await open.click();
  taps += 1;
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeVisible();
  const hit = page.waitForRequest((req) => {
    try { return new URL(req.url()).pathname === '/auth/google' && req.method() === 'GET'; }
    catch (e) { return false; }
  });
  await google.click();
  taps += 1;
  const req = await hit;
  expect(taps).toBe(3);
  expect(new URL(req.url()).pathname).toBe('/auth/google');
});

test('GitHub sign-in at 390 uses the More sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(origin + '/');
  await expect(page.locator('#mMore')).toBeHidden();
  await page.getByRole('button', { name: 'More options' }).click();
  const heading = page.getByRole('heading', { name: 'Account' });
  await expect(heading).toBeVisible();
  const account = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(account).toBeVisible();
  await expect(page.locator('#mMore .m-more-b button').first()).toHaveText('Sign in');
  await account.click();
  const github = page.getByRole('button', { name: 'Continue with GitHub' });
  await expect(github).toBeVisible();
  const gitBox = await github.boundingBox();
  expect(gitBox).not.toBeNull();
  expect(gitBox!.width).toBeGreaterThanOrEqual(44);
  expect(gitBox!.height).toBeGreaterThanOrEqual(44);
  await github.click();
  await expect(page.locator('#authName')).toHaveText('Ada Lovelace');
  await page.getByRole('button', { name: 'More options' }).click();
  const out = page.locator('#mSignOut');
  const outBox = await out.boundingBox();
  expect(outBox).not.toBeNull();
  expect(outBox!.height).toBeGreaterThanOrEqual(44);
});

test('cancel shows the exact sentence and leaves the project', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((saved) => {
    localStorage.setItem('esp32lab.projects.v1', saved);
  }, savedProjects());
  await setMode(page, 'cancel');
  await page.goto(origin + '/?p=lamp1');
  await signIn(page, 'Google', 1280);
  await expect(page.locator('.toast').filter({ hasText: CANCELLED })).toBeVisible();
  expect(page.url()).toContain('p=lamp1');
  const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
  expect(kept).toContain('Desk lamp');
});

test('an outage is a sentence with Try again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setMode(page, 'outage');
  await page.goto(origin + '/');
  await signIn(page, 'Google', 1280);
  await expect(page.getByText('Sign-in could not be completed. Your work is still on this device.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
});

test('a rejected return address is not a redirect', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const response = await page.goto(origin + '/auth/google?next=' + encodeURIComponent('//evil.example'));
  expect(response?.status()).toBe(400);
  await expect(page.getByText('That return address was rejected.')).toBeVisible();
  expect(new URL(page.url()).hostname).toBe('localhost');
  expect(await page.locator('a[href*="evil"]').count()).toBe(0);
});

test('logout invalidates the session on the server', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin + '/');
  await signIn(page, 'GitHub', 1280);
  await expect(page.locator('#authName')).toHaveText('Ada Lovelace');
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === 'cl_session');
  expect(session?.httpOnly).toBeTruthy();
  expect(session?.secure).toBe(false);
  expect(session?.sameSite).toBe('Lax');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#bSignIn')).toBeVisible();
  const res = await request.get(origin + '/auth/session', {
    headers: { cookie: 'cl_session=' + session!.value },
  });
  expect((await res.json()).signed_in).toBe(false);
});

test('account projects list, open, signed-out 401, and another user', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((saved) => {
    localStorage.setItem('esp32lab.projects.v1', saved);
    localStorage.setItem('esp32lab.current.v1', 'lamp1');
  }, savedProjects());
  await page.goto(origin + '/?p=lamp1');
  await signIn(page, 'GitHub', 1280);
  const dialog = page.getByRole('dialog', { name: 'Save your 3 projects to your account?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('3 projects saved to your account')).toBeVisible();
  await page.locator('#bProjects').click();
  const account = page.locator('#authAccount');
  await expect(account.getByRole('heading', { name: 'In your account' })).toBeVisible();
  await expect(account.getByText('Desk lamp')).toBeVisible();
  await expect(account.getByText('Porch')).toBeVisible();
  const open = account.getByRole('button', { name: 'Open Desk lamp' });
  const openBox = await open.boundingBox();
  expect(openBox).not.toBeNull();
  expect(openBox!.width).toBeGreaterThanOrEqual(44);
  expect(openBox!.height).toBeGreaterThanOrEqual(44);
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#projBanner')).toContainText('Desk lamp');
  const signedOut = await request.get(origin + '/auth/projects');
  expect(signedOut.status()).toBe(401);
  await page.request.post(info().mock + '/control', { data: { sub: 'other-person-9', mode: 'ok' } });
  const other = await page.context().browser()!.newContext();
  const otherPage = await other.newPage();
  await otherPage.setViewportSize({ width: 390, height: 800 });
  await otherPage.goto(origin + '/');
  await signIn(otherPage, 'Google', 390);
  await otherPage.getByRole('button', { name: 'More options' }).click();
  await otherPage.locator('#mMore button[data-a="projects"]').click();
  await expect(otherPage.locator('#authAccount')).toBeVisible();
  await expect(otherPage.locator('#authAccountStatus')).toHaveText('No projects saved to your account yet.');
  await expect(otherPage.locator('#authAccount')).not.toContainText('Desk lamp');
  const outBox = await otherPage.locator('#mSignOut').boundingBox();
  expect(outBox).not.toBeNull();
  expect(outBox!.height).toBeGreaterThanOrEqual(44);
  await other.close();
  await page.request.post(info().mock + '/control', { data: { sub: 'google-sub-1001', mode: 'ok' } });
});

async function paletteReady(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { app?: { editor?: unknown }; Parts?: { T?: object } };
    return !!(w.app && w.app.editor && w.Parts && w.Parts.T && document.getElementById('bSignIn'));
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.pitem-locked').length)).toBeGreaterThan(0);
}

async function paletteCounts(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { Parts: { T: object }; app: { proj: { parts: { type: string }[] } } };
    const of = (type: string) => w.app.proj.parts.filter((p) => p.type === type).length;
    return {
      catalog: Object.keys(w.Parts.T).length,
      items: document.querySelectorAll('.pitem').length,
      total: w.app.proj.parts.length,
      led: of('led'),
      ground: of('ground'),
    };
  });
}

async function onePart(page: Page, type: 'led' | 'ground', act: () => Promise<void>) {
  const before = await paletteCounts(page);
  await act();
  await expect.poll(async () => (await paletteCounts(page))[type]).toBe(before[type] + 1);
  await page.waitForTimeout(300);
  const after = await paletteCounts(page);
  expect(after[type]).toBe(before[type] + 1);
  expect(after.total).toBe(before.total + 1);
  expect(after.items).toBe(after.catalog);
}

test('desktop palette matches the catalog and one click adds one part', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin + '/?ex=blink&resume=0');
  await paletteReady(page);
  const counts = await paletteCounts(page);
  expect(counts.catalog).toBeGreaterThan(50);
  expect(counts.items).toBe(counts.catalog);
  const led = page.locator('.pitem[data-type="led"]');
  const ground = page.locator('.pitem[data-type="ground"]');
  await expect(led).toHaveCount(1);
  await expect(ground).toHaveCount(1);
  await onePart(page, 'led', () => led.click());
  await onePart(page, 'ground', () => ground.click());
  const locked = page.locator('.pitem[data-type="capacitor"]');
  const before = await paletteCounts(page);
  await locked.click({ force: true });
  const dlg = page.locator('#authDlg');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText(/Sign in free to use the /)).toBeVisible();
  await page.waitForTimeout(300);
  expect(await paletteCounts(page)).toMatchObject({ total: before.total, items: before.catalog });
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const w = window as unknown as { GuestParts?: { noteSession?: (s: { signed_in: boolean }) => void } };
    w.GuestParts && w.GuestParts.noteSession && w.GuestParts.noteSession({ signed_in: true });
  });
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.pitem-locked').length)).toBe(0);
  expect((await paletteCounts(page)).items).toBe(counts.catalog);
  await onePart(page, 'led', () => led.click());
  await page.evaluate(() => {
    const w = window as unknown as { GuestParts?: { noteSession?: (s: { signed_in: boolean }) => void } };
    w.GuestParts && w.GuestParts.noteSession && w.GuestParts.noteSession({ signed_in: false });
  });
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.pitem-locked').length)).toBeGreaterThan(0);
  expect((await paletteCounts(page)).items).toBe(counts.catalog);
});

test.describe('phone palette', () => {
  test.use({ hasTouch: true });
  test('a phone palette matches the catalog and one tap adds one part', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/?ex=blink&resume=0');
    await paletteReady(page);
    const counts = await paletteCounts(page);
    expect(counts.catalog).toBeGreaterThan(50);
    expect(counts.items).toBe(counts.catalog);
    const open = async () => {
      const showing = await page.evaluate(() => document.body.dataset.msheet === 'parts');
      if (!showing) await page.locator('#mParts').click();
    };
    await open();
    const led = page.locator('#mTrack .pitem[data-type="led"]');
    const ground = page.locator('#mTrack .pitem[data-type="ground"]');
    await expect(led).toHaveCount(1);
    await expect(ground).toHaveCount(1);
    await onePart(page, 'led', async () => { await led.scrollIntoViewIfNeeded(); await led.tap(); });
    await open();
    await onePart(page, 'ground', async () => { await ground.scrollIntoViewIfNeeded(); await ground.tap(); });
    await open();
    const locked = page.locator('#mTrack .pitem[data-type="capacitor"]');
    const before = await paletteCounts(page);
    await locked.scrollIntoViewIfNeeded();
    await locked.tap({ force: true });
    const dlg = page.locator('#authDlg');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText(/Sign in free to use the /)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await paletteCounts(page)).toMatchObject({ total: before.total, items: before.catalog });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const w = window as unknown as { GuestParts?: { noteSession?: (s: { signed_in: boolean }) => void } };
      w.GuestParts && w.GuestParts.noteSession && w.GuestParts.noteSession({ signed_in: true });
    });
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('.pitem-locked').length)).toBe(0);
    expect((await paletteCounts(page)).items).toBe(counts.catalog);
    await open();
    await onePart(page, 'led', async () => { await led.scrollIntoViewIfNeeded(); await led.tap(); });
  });
});
