import fs from 'fs';
import { expect, test, type Page } from '@playwright/test';

const port = process.env.AUTH_E2E_PORT || '18941';
const origin = `http://localhost:${port}`;
const ipOrigin = 'http://127.0.0.1:18943';
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
    await page.getByRole('button', { name: 'Sign in with ' + provider }).click();
    return;
  }
  await page.locator('#bSignIn').click();
  await page.locator('#authMenu [data-provider="' + provider.toLowerCase() + '"]').click();
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
  await page.locator('#bSignIn').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#authMenu')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('3 projects saved to your account')).toBeVisible();
  await expect(page.locator('#authName')).toHaveText('Ada Lovelace');
  await expect(page.locator('body')).toHaveClass(/viewsch/);
  expect(page.url()).toContain('p=lamp1');
  expect(page.url()).not.toContain('view=');
  expect(page.url()).not.toContain('auth_error');
  const fresh = await page.context().newPage();
  const again = fresh.waitForResponse((res) => res.url().includes('/auth/projects/import'));
  await fresh.goto(origin + '/');
  expect((await (await again).json()).imported).toBe(0);
  await fresh.close();
});

test('GitHub sign-in at 390 uses the More sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(origin + '/');
  await page.getByRole('button', { name: 'More options' }).click();
  const github = page.getByRole('button', { name: 'Sign in with GitHub' });
  await expect(github).toBeVisible();
  const box = await github.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
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
  await expect(page.getByText(CANCELLED)).toBeVisible();
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
  expect(session?.secure).toBeTruthy();
  expect(session?.sameSite).toBe('Lax');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#bSignIn')).toBeVisible();
  const res = await request.get(origin + '/auth/session', {
    headers: { cookie: 'cl_session=' + session!.value },
  });
  expect((await res.json()).signed_in).toBe(false);
});

test('sign-in on the IP origin moves projects before the provider', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (let i = 0; i < 50; i++) {
    const health = await page.request.get(ipOrigin + '/api/health').catch(() => null);
    if (health && health.ok()) break;
    await page.waitForTimeout(200);
  }
  const moved = savedProjects().replace(/lamp(\d)/g, 'move$1');
  await page.addInitScript((saved) => {
    if (location.hostname === '127.0.0.1') {
      localStorage.setItem('esp32lab.projects.v1', saved);
      localStorage.setItem('esp32lab.current.v1', 'move1');
    }
  }, moved);
  await page.goto(ipOrigin + '/?p=move1&view=schematic');
  await page.locator('#bSignIn').click();
  await page.locator('#authMenu [data-provider="google"]').click();
  await expect(page.locator('#authName')).toHaveText('Ada Lovelace', { timeout: 30_000 });
  await expect(page.getByText('3 projects saved to your account')).toBeVisible();
  expect(page.url()).toContain('localhost');
  expect(new URL(page.url()).hostname).not.toBe('127.0.0.1');
  const kept = await page.evaluate(() => localStorage.getItem('esp32lab.projects.v1'));
  expect(kept).toContain('Desk lamp');
});
