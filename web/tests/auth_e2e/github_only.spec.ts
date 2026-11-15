import { expect, test } from '@playwright/test';

const port = process.env.AUTH_E2E_PORT || '18942';
const origin = `http://127.0.0.1:${port}`;

async function assertNoGoogle(page: import('@playwright/test').Page) {
  const labels = (await page.locator('button, [role="menuitem"]').allTextContents()).join('\n');
  expect(labels.toLowerCase()).not.toContain('google');
  await expect(page.locator('[data-provider="google"]')).toHaveCount(0);
}

for (const width of [390, 1280]) {
  test(`GitHub stays and Google is absent at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(origin + '/?view=schematic');
    await assertNoGoogle(page);
    if (width === 390) {
      await page.getByRole('button', { name: 'More options' }).click();
      const github = page.getByRole('button', { name: 'Sign in with GitHub' });
      await expect(github).toBeVisible();
      const box = await github.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await assertNoGoogle(page);
      await github.click();
    } else {
      const header = page.locator('#bSignIn');
      await expect(header).toBeVisible();
      await expect(header).toHaveText('Sign in');
      await header.click();
    }
    await expect(page.locator('#authName')).toHaveText('Ada Lovelace');
    await expect(page.locator('body')).toHaveClass(/viewsch/);
    expect(page.url()).not.toContain('view=');
    await assertNoGoogle(page);
    if (width === 390) {
      await page.getByRole('button', { name: 'More options' }).click();
      await expect(page.locator('#mAuthName')).toHaveText('Ada Lovelace');
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await assertNoGoogle(page);
    } else {
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    }
    for (const path of ['/auth/google', '/auth/google/callback', '/auth/google/extra']) {
      const res = await page.request.get(origin + path);
      expect(res.status(), path).toBe(404);
      expect(await res.text()).toBe('not found');
    }
    const post = await page.request.post(origin + '/auth/google');
    expect(post.status()).toBe(404);
  });
}
