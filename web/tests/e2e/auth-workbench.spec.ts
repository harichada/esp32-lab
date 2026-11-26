import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Project = {
  id: string; name: string; code: string; mode: string; defines: string[];
  files: Record<string, string>; parts: { id: string; type: string; x: number; y: number; rot: number; props: { power: string } }[];
  wires: unknown[];
};
type Saved = { id: string; name: string; updated: number; from: string; proj: Project };
type Upload = { csrf: string; projects: Saved[] };
type Model = {
  signedIn: boolean; emailEnabled: boolean; sessionFailure: boolean;
  importFailure: '' | 'http' | 'network' | 'partial'; sendFailure: boolean;
  sessionRequests: number; sendRequests: number; uploads: { body: Upload; bytes: number }[];
  next: string; rows: { id: string; name: string; updated: number }[]; errors: string[];
};
type AuthWindow = Window & {
  app: { proj: Project; store: { get(id: string): Project; list(): { id: string }[] }; saveState: string };
};
const csrf = 'test-session-csrf-value-never-a-real-token';
const project = (index = 0, code = 'void setup() {}\nvoid loop() { delay(1000); }\n'): Saved => {
  const id = 'auth-project-' + index;
  return { id, name: 'Local project ' + index, updated: 1700000000000, from: '', proj: {
    id, name: 'Local project ' + index, code, mode: 'qemu', defines: [], files: {}, wires: [],
    parts: [{ id: 'esp', type: 'esp32', x: 200, y: 180, rot: 0, props: { power: 'usb' } }],
  } };
};

async function install(page: Page, options: { signedIn?: boolean; seeds?: Saved[]; email?: boolean; sessionFailure?: boolean } = {}) {
  const model: Model = {
    signedIn: !!options.signedIn, emailEnabled: options.email !== false, sessionFailure: !!options.sessionFailure,
    importFailure: '', sendFailure: false, sessionRequests: 0, sendRequests: 0, uploads: [],
    next: '/', rows: [], errors: [],
  };
  page.on('pageerror', error => model.errors.push(error.message));
  if (options.seeds) await page.addInitScript(seeds => {
    if (!localStorage.getItem('esp32lab.projects.v1')) {
      localStorage.setItem('esp32lab.projects.v1', JSON.stringify(Object.fromEntries(seeds.map(saved => [saved.id, saved]))));
      localStorage.setItem('esp32lab.current.v1', seeds[0].id);
      localStorage.setItem('esp32lab.serverSync', '0');
    }
  }, options.seeds);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (request.resourceType() === 'document' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const response = await route.fetch();
      const body = (await response.text()).replace('<head>', '<head><meta name="cl-auth" content="1">');
      return route.fulfill({ response, body });
    }
    if (url.pathname === '/auth/session') {
      model.sessionRequests++;
      if (model.sessionFailure) return route.fulfill({ status: 503, json: { error: 'store', message: 'Account service is unavailable.' } });
      return route.fulfill({ json: {
        signed_in: model.signedIn, csrf: model.signedIn ? csrf : '', provider: model.signedIn ? 'email' : '',
        display_name: model.signedIn ? 'learner@example.test' : '',
        providers: { google: true, github: true, email: model.emailEnabled },
        limits: { import_batch: 40, import_bytes: 1000000, project_bytes: 100000 },
      } });
    }
    if (url.pathname === '/auth/email/start') {
      model.sendRequests++;
      const body = request.postDataJSON() as { email: string; next: string };
      expect(body.email).toContain('@');
      model.next = body.next;
      if (model.sendFailure) return route.fulfill({ status: 503, json: { error: 'delivery', message: 'The code could not be emailed. Try again.' } });
      return route.fulfill({ json: {
        ok: true, challenge: 'test-email-challenge-value-not-a-real-token', csrf,
        expires_in: 600, resend_after: 60,
      } });
    }
    if (url.pathname === '/auth/email/verify') {
      const body = request.postDataJSON() as { challenge: string; csrf: string; code: string };
      expect(body.challenge).toBe('test-email-challenge-value-not-a-real-token');
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      if (body.code !== '123456') return route.fulfill({ status: 422, json: { error: 'code_invalid', message: 'That code did not match. Check the email and try again.', attempts_left: 4 } });
      model.signedIn = true;
      const next = new URL(model.next, url.origin); next.searchParams.set('auth_error', 'ok');
      return route.fulfill({ json: { ok: true, redirect: next.pathname + next.search } });
    }
    if (url.pathname === '/auth/projects/import') {
      const text = request.postData();
      if (text == null) throw new Error('Account upload must have a body');
      const body = JSON.parse(text) as Upload;
      model.uploads.push({ body, bytes: Buffer.byteLength(text, 'utf8') });
      if (model.importFailure === 'network') return route.abort('connectionfailed');
      if (model.importFailure === 'http') return route.fulfill({ status: 503, json: { message: 'The account service is unavailable. Try again.' } });
      if (model.importFailure === 'partial') return route.fulfill({ status: 422, json: {
        ok: false, imported: 0, unchanged: 0, last_saved: 0,
        rejected: body.projects.map(saved => ({ id: saved.id, name: saved.name, reason: 'project_too_large' })),
      } });
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      body.projects.forEach(saved => model.rows.push({ id: saved.id, name: saved.name, updated: 1700000000 }));
      return route.fulfill({ json: { ok: true, imported: body.projects.length, unchanged: 0, rejected: [], last_saved: 1700000000 } });
    }
    if (url.pathname === '/auth/projects') return route.fulfill({ json: { projects: model.rows } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
    return route.fallback();
  });
  return model;
}

async function ready(page: Page) {
  await page.waitForFunction(() => !!(window as AuthWindow).app?.proj && !!document.querySelector('#ui2top'));
}
async function menu(page: Page, name: string) {
  const phone = await page.locator('body').evaluate(body => body.classList.contains('m'));
  await page.locator(phone ? '#ui2Phone [data-a="more"]' : '#ui2More').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function openSignIn(page: Page, width: number) {
  if (width < 821) {
    await page.locator('#ui2Phone [data-a="more"]').click();
    await expect(page.locator('#ui2Pop [role="menuitem"]').first()).toHaveText('Try new UI (Studio Dark)');
    await page.getByRole('menuitem', { name: 'Sign in', exact: true }).click();
  } else await page.locator('#ui2Sign').click();
  await expect(page.locator('#authDlg')).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`email code signup keeps the project and exposes the account at ${viewport.width}px`, async ({ page }) => {
    const seed = project();
    const model = await install(page, { seeds: [seed] });
    await page.setViewportSize(viewport);
    await page.goto('/?ui=2&resume=0&p=' + seed.id);
    await ready(page);
    await openSignIn(page, viewport.width);
    await page.locator('#authEmailAddress').fill('learner@example.test');
    const formA11y = await new AxeBuilder({ page }).include('#authDlg').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(formA11y.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('email-signup-' + viewport.width + '.png'), animations: 'disabled' });
    if (viewport.width === 1280) {
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      const lightA11y = await new AxeBuilder({ page }).include('#authDlg').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(lightA11y.violations).toEqual([]);
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    }
    await page.locator('#authEmailSend').click();
    await expect(page.locator('#authEmailCodeForm')).toBeVisible();
    await expect(page.locator('#authEmailCode')).toBeFocused();
    await expect(page.locator('#authEmailResend')).toBeDisabled();
    await expect(page.locator('#authEmailCode')).toHaveAttribute('autocomplete', 'one-time-code');
    await page.locator('#authEmailCode').fill('111111');
    await page.locator('#authEmailVerify').click();
    await expect(page.locator('#authEmailMessage')).toContainText('did not match');
    await expect(page.locator('#authEmailVerify')).toBeEnabled();
    const a11y = await new AxeBuilder({ page }).include('#authDlg').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(a11y.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('email-code-' + viewport.width + '.png'), animations: 'disabled' });
    await page.locator('#authEmailCode').fill('123 456');
    await page.locator('#authEmailVerify').click();
    await expect(page.locator('#authSaveDlg')).toBeVisible();
    await page.locator('#authSaveNo').click();
    await expect(page.locator(viewport.width < 821 ? '#ui2Phone [data-a="more"]' : '#ui2Sign')).toBeFocused();
    await expect(page).toHaveURL(new RegExp('p=' + seed.id));
    expect(await page.evaluate(id => (window as AuthWindow).app.store.get(id).code, seed.id)).toBe(seed.proj.code);
    expect(model.uploads).toEqual([]);
    if (viewport.width >= 821) {
      await expect(page.locator('#ui2Sign')).toHaveText('learner@example.test');
      await page.locator('#ui2Sign').click();
    } else await page.locator('#ui2Phone [data-a="more"]').click();
    await expect(page.locator('.ui2-account-summary')).toContainText('learner@example.test');
    await expect(page.locator('.ui2-account-summary')).toContainText('email');
    await expect(page.locator('#ui2Pop [role="menuitem"]').first()).toHaveText('Try new UI (Studio Dark)');
    await expect(page.getByRole('menuitem', { name: 'Save current project to account' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('account-menu-' + viewport.width + '.png'), animations: 'disabled' });
    expect(model.errors).toEqual([]);
  });
}

test('session service recovery keeps sign-in available and restores the real trigger focus', async ({ page }) => {
  const model = await install(page, { seeds: [project()], sessionFailure: true });
  await page.goto('/?ui=2&resume=0&p=auth-project-0');
  await ready(page);
  await expect(page.locator('#ui2Sign')).toHaveText('Sign in (retry)');
  await page.locator('#ui2Sign').click();
  await expect(page.locator('#authSessionRetry')).toBeVisible();
  model.sessionFailure = false;
  await page.locator('#authSessionRetry').click();
  await expect(page.locator('#authEmailAddress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#authDlg')).toBeHidden();
  await expect(page.locator('#ui2Sign')).toBeFocused();
  await expect(page.locator('#ui2Sign')).toHaveAttribute('aria-expanded', 'false');
  expect(model.sessionRequests).toBe(2);
  expect(model.errors).toEqual([]);
});

test('failed account imports retain the prompt and retry without losing local projects', async ({ page }) => {
  const seed = project();
  const model = await install(page, { signedIn: true, seeds: [seed] });
  model.importFailure = 'http';
  await page.goto('/?ui=2&resume=0&p=' + seed.id + '&auth_error=ok');
  await ready(page);
  await expect(page.locator('#authSaveNo')).toBeFocused();
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveStatus')).toContainText('unavailable');
  await expect(page.locator('#authSaveDlg')).toBeVisible();
  await expect(page.locator('#authSaveYes')).toHaveText('Try again');
  model.importFailure = 'network';
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveStatus')).toContainText("Couldn't reach");
  model.importFailure = '';
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveDlg')).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: '1 project saved to your account' })).toBeVisible();
  expect(model.uploads).toHaveLength(3);
  expect(await page.evaluate(id => (window as AuthWindow).app.store.get(id).code, seed.id)).toBe(seed.proj.code);
  expect(model.errors).toEqual([]);
});

test('Not now does not upload and a later explicit account save includes the newest edits', async ({ page }) => {
  const seed = project();
  const model = await install(page, { signedIn: true, seeds: [seed] });
  await page.goto('/?ui=2&resume=0&p=' + seed.id + '&auth_error=ok');
  await ready(page);
  await page.locator('#authSaveNo').click();
  const code = 'void setup() {}\nvoid loop() { delay(500); }\n';
  await page.locator('#code').fill(code);
  await page.keyboard.press('Control+s');
  await expect(page.locator('#ui2Save')).toHaveText('Saved locally');
  expect(model.uploads).toHaveLength(0);
  await menu(page, 'Projects');
  await page.locator('#authAccountSave').click();
  await expect(page.locator('#authAccountSaveStatus')).toContainText('Last saved');
  expect(model.uploads).toHaveLength(1);
  expect(model.uploads[0].body.projects[0].proj.code).toBe(code);
  await page.locator('#projDlg [data-a="close"]').click();
  await page.locator('#code').fill(code + '// A later local edit\n');
  await page.keyboard.press('Control+s');
  await expect(page.locator('#ui2Save')).toHaveText('Saved locally');
  expect(model.uploads).toHaveLength(1);
  expect(model.errors).toEqual([]);
});

test('bulk account saving obeys both the count and exact request-byte limits', async ({ page }) => {
  const seeds = Array.from({ length: 41 }, (_, index) => project(index));
  const model = await install(page, { signedIn: true, seeds });
  await page.goto('/?ui=2&resume=0&p=auth-project-0&auth_error=ok');
  await ready(page);
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveDlg')).toHaveCount(0);
  expect(model.uploads.map(upload => upload.body.projects.length)).toEqual([40, 1]);
  expect(model.uploads.every(upload => upload.bytes <= 1000000)).toBe(true);
  expect(await page.evaluate(() => (window as AuthWindow).app.store.list().length)).toBe(41);
  expect(model.errors).toEqual([]);
});

test('large account batches are split before crossing the body-byte limit', async ({ page }) => {
  const seeds = Array.from({ length: 20 }, (_, index) => project(index, '/*' + 'x'.repeat(60000) + '*/\nvoid setup() {}\nvoid loop() {}\n'));
  const model = await install(page, { signedIn: true, seeds });
  await page.goto('/?ui=2&resume=0&p=auth-project-0&auth_error=ok');
  await ready(page);
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveDlg')).toHaveCount(0);
  expect(model.uploads.length).toBeGreaterThan(1);
  expect(model.uploads.every(upload => upload.bytes <= 1000000 && upload.body.projects.length <= 40)).toBe(true);
  expect(model.uploads.reduce((sum, upload) => sum + upload.body.projects.length, 0)).toBe(20);
  expect(model.errors).toEqual([]);
});

test('rejected account snapshots are not reported as successfully saved', async ({ page }) => {
  const model = await install(page, { signedIn: true, seeds: [project()] });
  model.importFailure = 'partial';
  await page.goto('/?ui=2&resume=0&p=auth-project-0&auth_error=ok');
  await ready(page);
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveStatus')).toContainText('Download');
  await expect(page.locator('#authSaveStatus')).toContainText('All originals remain');
  await expect(page.locator('#authSaveDlg')).toBeVisible();
  await expect(page.locator('#authSaveYes')).toHaveText('Try again');
  await page.locator('#authSaveNo').click();
  expect(await page.evaluate(() => (window as AuthWindow).app.store.list().length)).toBe(1);
  expect(model.errors).toEqual([]);
});

test('email can be disabled without removing Google and GitHub sign-in', async ({ page }) => {
  const model = await install(page, { seeds: [project()], email: false });
  await page.goto('/?ui=2&resume=0&p=auth-project-0');
  await ready(page);
  await openSignIn(page, 1280);
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with GitHub', exact: true })).toBeVisible();
  await expect(page.locator('#authEmailForm')).toHaveCount(0);
  expect(model.sendRequests).toBe(0);
  expect(model.errors).toEqual([]);
});

test('email delivery errors retain the address and a pending code survives a page reload', async ({ page }) => {
  const model = await install(page, { seeds: [project()] });
  model.sendFailure = true;
  await page.goto('/?ui=2&resume=0&p=auth-project-0');
  await ready(page);
  await openSignIn(page, 1280);
  await page.locator('#authEmailAddress').fill('learner@example.test');
  await page.locator('#authEmailSend').click();
  await expect(page.locator('#authEmailMessage')).toContainText('could not be emailed');
  await expect(page.locator('#authEmailAddress')).toHaveValue('learner@example.test');
  model.sendFailure = false;
  await page.locator('#authEmailSend').click();
  await expect(page.locator('#authEmailCodeForm')).toBeVisible();
  await page.reload();
  await ready(page);
  await openSignIn(page, 1280);
  await expect(page.locator('#authEmailCodeForm')).toBeVisible();
  await expect(page.locator('#authEmailCode')).toBeFocused();
  expect(model.sendRequests).toBe(2);
  await page.locator('#authEmailChange').click();
  await expect(page.locator('#authEmailForm')).toBeVisible();
  await expect(page.locator('#authEmailAddress')).toHaveValue('learner@example.test');
  expect(model.errors).toEqual([]);
});
