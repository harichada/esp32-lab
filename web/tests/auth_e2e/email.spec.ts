import { expect, test } from '@playwright/test';

test('real email API signs in, saves new snapshots, isolates accounts, and logs out', async ({ page, browser, baseURL }) => {
  if (!baseURL) throw new Error('The loopback email test server URL is required');
  const project = {
    id: 'email-e2e-project', name: 'Email training project', mode: 'qemu',
    code: 'void setup() {}\nvoid loop() { delay(1000); }\n', wires: [], defines: [], files: {},
    parts: [{ id: 'esp', type: 'esp32', x: 200, y: 180, rot: 0, props: { power: 'usb' } }],
  };
  await page.addInitScript(project => {
    if (!localStorage.getItem('esp32lab.projects.v1')) {
      localStorage.setItem('esp32lab.projects.v1', JSON.stringify({
        [project.id]: { id: project.id, name: project.name, updated: Date.now(), from: '', proj: project },
      }));
      localStorage.setItem('esp32lab.current.v1', project.id);
      localStorage.setItem('esp32lab.serverSync', '0');
    }
  }, project);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?ui=2&resume=0&p=' + project.id);
  await page.locator('#ui2Sign').click();
  await page.locator('#authEmailAddress').fill('learner-e2e@example.test');
  await page.locator('#authEmailSend').click();
  await expect(page.locator('#authEmailCodeForm')).toBeVisible();
  const oldCookie = (await page.context().cookies()).find(cookie => cookie.name === 'cl_session');
  expect(oldCookie?.httpOnly).toBe(true);
  const mailed = await page.request.get('/__test__/email-code?email=learner-e2e%40example.test');
  expect(mailed.ok()).toBe(true);
  const mail = await mailed.json() as { code: string };
  expect(mail.code).toMatch(/^[0-9]{6}$/);
  await page.reload();
  await page.locator('#ui2Sign').click();
  await expect(page.locator('#authEmailCodeForm')).toBeVisible();
  await page.locator('#authEmailCode').fill(mail.code);
  await page.locator('#authEmailVerify').click();
  await expect(page.locator('#authSaveDlg')).toBeVisible();
  await page.locator('#authSaveYes').click();
  await expect(page.locator('#authSaveDlg')).toHaveCount(0);
  await expect(page.locator('#ui2Sign')).toHaveText('learner-e2e@example.test');
  const signedInCookie = (await page.context().cookies()).find(cookie => cookie.name === 'cl_session');
  expect(signedInCookie?.value).not.toBe(oldCookie?.value);
  expect(signedInCookie?.httpOnly).toBe(true);
  const account = await page.request.get('/auth/projects');
  const initial = await account.json() as { projects: { id: string; name: string }[] };
  expect(initial.projects).toHaveLength(1);
  const changedCode = 'void setup() {}\nvoid loop() { delay(500); }\n';
  await page.locator('#code').fill(changedCode);
  await page.keyboard.press('Control+s');
  expect((await (await page.request.get('/auth/projects')).json()).projects).toHaveLength(1);
  await page.locator('#ui2Sign').click();
  await page.getByRole('menuitem', { name: 'Save current project to account', exact: true }).click();
  await expect(page.locator('#authAccountSaveStatus')).toContainText('Last saved');
  const later = await (await page.request.get('/auth/projects')).json() as { projects: { id: string }[] };
  expect(later.projects).toHaveLength(2);
  expect(later.projects[0].id).not.toBe(initial.projects[0].id);
  const newest = await page.request.get('/auth/projects/' + later.projects[0].id);
  expect((await newest.json()).proj.code).toBe(changedCode);
  const original = await page.request.get('/auth/projects/' + initial.projects[0].id);
  expect((await original.json()).proj.code).toBe(project.code);
  const other = await browser.newContext();
  try {
    const request = other.request;
    const start = await request.post(baseURL + '/auth/email/start', {
      headers: { Origin: baseURL }, data: { email: 'another-e2e@example.test', next: '/' },
    });
    expect(start.ok()).toBe(true);
    const pending = await start.json() as { challenge: string; csrf: string };
    const secondMail = await (await request.get(baseURL + '/__test__/email-code?email=another-e2e%40example.test')).json() as { code: string };
    const verified = await request.post(baseURL + '/auth/email/verify', {
      headers: { Origin: baseURL, 'X-CSRF-Token': pending.csrf },
      data: { ...pending, code: secondMail.code },
    });
    expect(verified.ok()).toBe(true);
    expect((await request.get(baseURL + '/auth/projects/' + initial.projects[0].id)).status()).toBe(404);
  } finally { await other.close(); }
  await page.locator('#projDlg [data-a="close"]').click();
  await page.locator('#ui2Sign').click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#ui2Sign')).toHaveText('Sign in');
  expect((await (await page.request.get('/auth/session')).json()).signed_in).toBe(false);
  expect(errors).toEqual([]);
});
